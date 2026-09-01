"""Preparación de capital para el mint LP — envuelve tBNB→WBNB y mintea USDT de testnet.

El mint v3 gasta **WBNB** y **USDT** (tokens ERC20), no BNB nativo. Este módulo deja
la wallet lista con ambos, partiendo solo de tBNB del faucet:

- **WBNB** es WETH9 estándar: ``deposit(){value}`` envuelve tBNB→WBNB 1:1.
- **USDT** de BSC testnet (``0x3376…``) es el mock de PancakeSwap con ``mint(uint256)``
  PÚBLICO — cualquiera se auto-mintea (verificado por selector ``a0712d68`` en el
  bytecode). No hace falta swap ni faucet externo.

CÓDIGO FIJO de firma, del mismo lado que ``pancake_v3.py`` / ``signing.py``: **nunca**
un tool invocable por el LLM. El agente es el ÚNICO firmante
(``EVMWalletProvider.sign_transaction`` del SDK). Gated por credenciales
(``WALLET_PASSWORD`` + keystore de ``bag wallet new``).

Uso (con el venv activo, desde ``app/agent`` y ``.studio/.env.local`` cargado por bag):

    python capital.py balances                 # tBNB / WBNB / USDT de la wallet
    python capital.py prepare --wrap 0.05 --usdt 5   # envuelve 0.05 tBNB + mintea 5 USDT
    python capital.py wrap 0.05                 # solo envolver
    python capital.py mint-usdt 5               # solo mintear USDT
"""
from __future__ import annotations

import argparse
import json
import time
from typing import Any

from web3 import Web3

import pancake_v3 as pv3

# WBNB (WETH9) deposit/withdraw + USDT mock mint(uint256).
WBNB_ABI = [
    {"inputs": [], "name": "deposit", "outputs": [], "stateMutability": "payable", "type": "function"},
    {"inputs": [{"type": "uint256"}], "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]
USDT_MINT_ABI = [
    {"inputs": [{"type": "uint256", "name": "amount"}], "name": "mint",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]

# PancakeSwap v3 SwapRouter (BSC testnet) — verificado on-chain: factory() y WETH9()
# coinciden con nuestra config. Usa ``exactInputSingle`` CON ``deadline`` (struct Uniswap).
SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14"
SWAP_ROUTER_ABI = [
    {"inputs": [{"components": [
        {"type": "address", "name": "tokenIn"},
        {"type": "address", "name": "tokenOut"},
        {"type": "uint24", "name": "fee"},
        {"type": "address", "name": "recipient"},
        {"type": "uint256", "name": "deadline"},
        {"type": "uint256", "name": "amountIn"},
        {"type": "uint256", "name": "amountOutMinimum"},
        {"type": "uint160", "name": "sqrtPriceLimitX96"},
    ], "internalType": "struct ISwapRouter.ExactInputSingleParams", "name": "params", "type": "tuple"}],
     "name": "exactInputSingle", "outputs": [{"type": "uint256", "name": "amountOut"}],
     "stateMutability": "payable", "type": "function"},
]

GAS = {"deposit": 60_000, "mint": 120_000, "approve": 80_000, "swap": 300_000}


def _wallet_and_w3(config: pv3.RebalancerConfig):
    """Carga el wallet del SDK (import perezoso: exige entorno de keystore) + Web3."""
    pv3.load_agent_env()  # WALLET_PASSWORD desde .studio/.env.local (como hace bag)
    from bnbagent_studio_core.wallet import get_wallet

    config = config.checksummed()
    wallet = get_wallet()
    owner = Web3.to_checksum_address(wallet.address)
    return wallet, owner, pv3.connect(config), config


def _human(wei: int, decimals: int) -> float:
    return wei / (10 ** decimals)


def balances(config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG) -> dict[str, Any]:
    """tBNB nativo + WBNB + USDT de la wallet (humano y wei)."""
    _wallet, owner, w3, config = _wallet_and_w3(config)
    native = w3.eth.get_balance(owner)
    wbnb = pv3.token_balance(w3, config.base_token, owner)
    usdt = pv3.token_balance(w3, config.quote_token, owner)
    wbnb_dec = pv3.token_decimals(w3, config.base_token)
    usdt_dec = pv3.token_decimals(w3, config.quote_token)
    return {
        "owner": owner,
        "tBNB": _human(native, 18), "tBNB_wei": str(native),
        "WBNB": _human(wbnb, wbnb_dec), "WBNB_wei": str(wbnb),
        "USDT": _human(usdt, usdt_dec), "USDT_wei": str(usdt),
    }


def _wrap_step(sender: pv3.SequentialSender, amount_human: float) -> dict[str, Any]:
    """Envuelve ``amount_human`` tBNB → WBNB vía ``WBNB.deposit(){value}`` (usa el sender)."""
    value = int(amount_human * (10 ** 18))
    if value <= 0:
        raise ValueError("amount must be > 0")
    if sender.w3.eth.get_balance(sender.owner) < value:
        raise RuntimeError("saldo tBNB insuficiente para envolver — fondea con el faucet primero")
    data = sender.w3.eth.contract(address=sender.config.base_token, abi=WBNB_ABI).encode_abi("deposit", args=[])
    tx_hash = sender.send(sender.config.base_token, data, value=value, gas=GAS["deposit"])
    return {"action": "wrap", "amount_WBNB": amount_human, "tx_hash": tx_hash,
            "explorer": f"https://testnet.bscscan.com/tx/{tx_hash}"}


def _mint_usdt_step(sender: pv3.SequentialSender, amount_human: float) -> dict[str, Any]:
    """Auto-mintea ``amount_human`` USDT (mock testnet ``mint(uint256)`` público; usa el sender)."""
    dec = pv3.token_decimals(sender.w3, sender.config.quote_token)
    amount = int(amount_human * (10 ** dec))
    if amount <= 0:
        raise ValueError("amount must be > 0")
    data = sender.w3.eth.contract(address=sender.config.quote_token, abi=USDT_MINT_ABI).encode_abi("mint", args=[amount])
    tx_hash = sender.send(sender.config.quote_token, data, gas=GAS["mint"])
    return {"action": "mint-usdt", "amount_USDT": amount_human, "tx_hash": tx_hash,
            "explorer": f"https://testnet.bscscan.com/tx/{tx_hash}"}


def _swap_wbnb_to_usdt_step(
    sender: pv3.SequentialSender, amount_wbnb_human: float, *, fee: int = 500, min_out_human: float = 0.0
) -> dict[str, Any]:
    """Swap WBNB→USDT vía ``SwapRouter.exactInputSingle`` (approve WBNB→router si falta).

    Fuente de USDT de testnet: el mint del mock es ``onlyOwner``, así que compramos USDT
    en el propio pool v3 (que tiene liquidez). ``min_out_human=0`` en testnet (sin MEV).
    """
    w3, owner, cfg = sender.w3, sender.owner, sender.config
    amount_in = int(amount_wbnb_human * (10 ** pv3.token_decimals(w3, cfg.base_token)))
    if amount_in <= 0:
        raise ValueError("amount must be > 0")
    if pv3.token_balance(w3, cfg.base_token, owner) < amount_in:
        raise RuntimeError("WBNB insuficiente para el swap — envuelve más tBNB primero")
    router = Web3.to_checksum_address(SWAP_ROUTER)
    steps: dict[str, Any] = {"action": "swap-wbnb->usdt", "amount_WBNB_in": amount_wbnb_human}
    # approve WBNB → router si el allowance no cubre
    allowance = w3.eth.contract(address=cfg.base_token, abi=pv3.ERC20_ABI).functions.allowance(owner, router).call()
    if allowance < amount_in:
        approve_data = pv3.encode_approve_calldata(w3, cfg.base_token, router, amount_in)
        steps["approve_tx"] = sender.send(cfg.base_token, approve_data, gas=GAS["approve"])
    out_dec = pv3.token_decimals(w3, cfg.quote_token)
    params = (
        cfg.base_token, cfg.quote_token, fee, owner,
        int(time.time()) + 1200, amount_in, int(min_out_human * (10 ** out_dec)), 0,
    )
    swap_data = w3.eth.contract(address=router, abi=SWAP_ROUTER_ABI).encode_abi("exactInputSingle", args=[params])
    steps["swap_tx"] = sender.send(router, swap_data, gas=GAS["swap"])
    steps["explorer"] = f"https://testnet.bscscan.com/tx/{steps['swap_tx']}"
    return steps


def wrap_bnb(amount_human: float, config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG) -> dict[str, Any]:
    """Envuelve ``amount_human`` tBNB → WBNB (standalone; una tx)."""
    wallet, owner, w3, config = _wallet_and_w3(config)
    return _wrap_step(pv3.SequentialSender(w3, wallet, config, owner), amount_human)


def swap_wbnb_usdt(amount_wbnb_human: float, config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG) -> dict[str, Any]:
    """Swap standalone WBNB→USDT (approve + exactInputSingle)."""
    wallet, owner, w3, config = _wallet_and_w3(config)
    return _swap_wbnb_to_usdt_step(pv3.SequentialSender(w3, wallet, config, owner), amount_wbnb_human)


def mint_usdt(amount_human: float, config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG) -> dict[str, Any]:
    """Auto-mintea ``amount_human`` USDT de testnet (standalone; una tx)."""
    wallet, owner, w3, config = _wallet_and_w3(config)
    return _mint_usdt_step(pv3.SequentialSender(w3, wallet, config, owner), amount_human)


def prepare(
    wrap_human: float = 0.08,
    swap_human: float = 0.03,
    config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG,
) -> dict[str, Any]:
    """Deja la wallet lista para el mint: envuelve WBNB + swapea una parte a USDT.

    El USDT de testnet no tiene faucet público (``mint`` es onlyOwner), así que se compra
    en el pool v3. Se envuelve ``wrap_human`` tBNB→WBNB y se swapea ``swap_human`` WBNB→USDT;
    el resto de WBNB queda para el depósito LP. Todas las txs comparten UN
    ``SequentialSender`` (nonce local) ⇒ sin carrera de nonce aunque el RPC reparta nodos.
    """
    wallet, owner, w3, config = _wallet_and_w3(config)
    sender = pv3.SequentialSender(w3, wallet, config, owner)
    out: dict[str, Any] = {"steps": []}
    if wrap_human > 0:
        out["steps"].append(_wrap_step(sender, wrap_human))
    if swap_human > 0:
        out["steps"].append(_swap_wbnb_to_usdt_step(sender, swap_human))
    out["balances"] = balances(config)
    return out


def _main() -> None:
    ap = argparse.ArgumentParser(description="Prep de capital para el mint LP (WBNB + USDT de testnet).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("balances", help="muestra tBNB / WBNB / USDT")
    p_wrap = sub.add_parser("wrap", help="envuelve tBNB→WBNB")
    p_wrap.add_argument("amount", type=float)
    p_swap = sub.add_parser("swap-usdt", help="swap WBNB→USDT en el pool v3")
    p_swap.add_argument("amount", type=float, help="WBNB de entrada")
    p_mint = sub.add_parser("mint-usdt", help="(onlyOwner en este mock — normalmente revierte)")
    p_mint.add_argument("amount", type=float)
    p_prep = sub.add_parser("prepare", help="envuelve WBNB + swapea a USDT + reporta")
    p_prep.add_argument("--wrap", type=float, default=0.08, help="tBNB a envolver (default 0.08)")
    p_prep.add_argument("--swap", type=float, default=0.03, help="WBNB a swapear por USDT (default 0.03)")
    args = ap.parse_args()

    if args.cmd == "balances":
        result = balances()
    elif args.cmd == "wrap":
        result = wrap_bnb(args.amount)
    elif args.cmd == "swap-usdt":
        result = swap_wbnb_usdt(args.amount)
    elif args.cmd == "mint-usdt":
        result = mint_usdt(args.amount)
    else:
        result = prepare(args.wrap, args.swap)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _main()
