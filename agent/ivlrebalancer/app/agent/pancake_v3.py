"""Ejecución LP en PancakeSwap v3 con los ticks de IVL — el núcleo del rebalanceo.

Roadmap §3.2 (camino elegido): encodear y enviar
``NonfungiblePositionManager.mint(MintParams{…})`` DIRECTO con los ticks de
``/v1/ivl/ticks``, firmando con el ``EVMWalletProvider`` del SDK
(``bnbagent_studio_core.wallet.get_wallet``) — el agente es el ÚNICO firmante.
Python-nativo (web3.py), NO el tool Node de bsc-mcp: el stack de este agente es Python.

Este módulo es CÓDIGO FIJO de firma, del mismo lado que ``signing.py`` — **nunca** un
tool invocable por el LLM (CLAUDE.md/scaffold: dinero y mutaciones jamás en el LLM).
El único helper LLM-callable es el *plan de solo-lectura* (ver ``rebalance.py`` →
``tools.py``), que hace dry-run y no firma nada.

Direcciones BSC testnet (chainId 97) verificadas en vivo 18-ago-2026:
- V3Factory  0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865  (deploy determinista multichain)
- NPM        0x427bF5b37357632377eCbEC9de3626C71A5396c1  (Pancake V3 Positions NFT-V1)
- WBNB       0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
- USDT       0x337610d27c682E347C9cD60BD4b3b107C9d34dDd  (pools WBNB/USDT vivos en 100/500/2500/10000)

⚠ Orientación de ticks: IVL cotiza base-quote (BNB-USDT ⇒ ticks +). Como
``USDT < WBNB`` por address, el pool tiene ``token0=USDT`` y sus ticks van NEGADOS e
invertidos. :func:`orient_ticks` lo reconcilia leyendo ``pool.token0()``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from web3 import Web3

from ivl_client import IvlTicks


def load_agent_env() -> bool:
    """Carga ``.studio/.env.local`` en el entorno (como hace el CLI ``bag``).

    Los scripts de firma standalone (``rebalance.py --execute``, ``capital.py``) no
    pasan por ``bag``, así que ``get_wallet()`` no vería ``WALLET_PASSWORD``. Buscamos
    ``.studio/.env.local`` subiendo desde este módulo y lo cargamos SIN pisar variables
    ya presentes en el entorno. Devuelve True si encontró y cargó el archivo.
    """
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        env_path = parent / ".studio" / ".env.local"
        if env_path.is_file():
            try:
                from dotenv import load_dotenv
                load_dotenv(env_path, override=False)
            except Exception:  # noqa: BLE001 — fallback: parser mínimo KEY=VALUE
                for line in env_path.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())
            return True
    return False

# --- Constantes de tick de Uniswap/Pancake v3 --------------------------------
MIN_TICK = -887272
MAX_TICK = 887272

# --- Config de red (BSC testnet por defecto; el par flagship es BNB-USDT) -----
DEFAULT_RPCS = (
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet.publicnode.com",
    "https://bsc-testnet-rpc.publicnode.com",
)


@dataclass(frozen=True)
class RebalancerConfig:
    """Direcciones + red para ejecutar el LP. Defaults = BSC testnet BNB-USDT."""

    factory: str = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"
    position_manager: str = "0x427bF5b37357632377eCbEC9de3626C71A5396c1"
    base_token: str = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"  # WBNB
    quote_token: str = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd"  # USDT
    base_symbol: str = "WBNB"
    quote_symbol: str = "USDT"
    chain_id: int = 97
    rpcs: tuple[str, ...] = DEFAULT_RPCS

    def checksummed(self) -> "RebalancerConfig":
        c = Web3.to_checksum_address
        return RebalancerConfig(
            factory=c(self.factory),
            position_manager=c(self.position_manager),
            base_token=c(self.base_token),
            quote_token=c(self.quote_token),
            base_symbol=self.base_symbol,
            quote_symbol=self.quote_symbol,
            chain_id=self.chain_id,
            rpcs=self.rpcs,
        )


DEFAULT_TESTNET_CONFIG = RebalancerConfig()

# --- ABIs mínimas ------------------------------------------------------------
FACTORY_ABI = [
    {"inputs": [{"type": "address"}, {"type": "address"}, {"type": "uint24"}],
     "name": "getPool", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
]
POOL_ABI = [
    {"inputs": [], "name": "token0", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "token1", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "fee", "outputs": [{"type": "uint24"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "tickSpacing", "outputs": [{"type": "int24"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "slot0",
     "outputs": [{"type": "uint160", "name": "sqrtPriceX96"}, {"type": "int24", "name": "tick"},
                 {"type": "uint16"}, {"type": "uint16"}, {"type": "uint16"}, {"type": "uint32"}, {"type": "bool"}],
     "stateMutability": "view", "type": "function"},
]
ERC20_ABI = [
    {"inputs": [{"type": "address"}], "name": "balanceOf", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "decimals", "outputs": [{"type": "uint8"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "symbol", "outputs": [{"type": "string"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}, {"type": "address"}], "name": "allowance", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}, {"type": "uint256"}], "name": "approve", "outputs": [{"type": "bool"}], "stateMutability": "nonpayable", "type": "function"},
]
# NonfungiblePositionManager — idéntico a Uniswap v3 (mint + ciclo de vida completo:
# positions / decreaseLiquidity / collect / burn) + ERC721Enumerable (balanceOf /
# tokenOfOwnerByIndex) para localizar la posición existente al rewiden/reset.
NPM_ABI = [
    {"inputs": [{"components": [
        {"type": "address", "name": "token0"},
        {"type": "address", "name": "token1"},
        {"type": "uint24", "name": "fee"},
        {"type": "int24", "name": "tickLower"},
        {"type": "int24", "name": "tickUpper"},
        {"type": "uint256", "name": "amount0Desired"},
        {"type": "uint256", "name": "amount1Desired"},
        {"type": "uint256", "name": "amount0Min"},
        {"type": "uint256", "name": "amount1Min"},
        {"type": "address", "name": "recipient"},
        {"type": "uint256", "name": "deadline"},
    ], "internalType": "struct INonfungiblePositionManager.MintParams", "name": "params", "type": "tuple"}],
     "name": "mint",
     "outputs": [{"type": "uint256", "name": "tokenId"}, {"type": "uint128", "name": "liquidity"},
                 {"type": "uint256", "name": "amount0"}, {"type": "uint256", "name": "amount1"}],
     "stateMutability": "payable", "type": "function"},
    {"inputs": [{"type": "uint256", "name": "tokenId"}], "name": "positions",
     "outputs": [
        {"type": "uint96", "name": "nonce"}, {"type": "address", "name": "operator"},
        {"type": "address", "name": "token0"}, {"type": "address", "name": "token1"},
        {"type": "uint24", "name": "fee"}, {"type": "int24", "name": "tickLower"},
        {"type": "int24", "name": "tickUpper"}, {"type": "uint128", "name": "liquidity"},
        {"type": "uint256", "name": "feeGrowthInside0LastX128"},
        {"type": "uint256", "name": "feeGrowthInside1LastX128"},
        {"type": "uint128", "name": "tokensOwed0"}, {"type": "uint128", "name": "tokensOwed1"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [{"components": [
        {"type": "uint256", "name": "tokenId"}, {"type": "uint128", "name": "liquidity"},
        {"type": "uint256", "name": "amount0Min"}, {"type": "uint256", "name": "amount1Min"},
        {"type": "uint256", "name": "deadline"},
     ], "internalType": "struct INonfungiblePositionManager.DecreaseLiquidityParams",
        "name": "params", "type": "tuple"}],
     "name": "decreaseLiquidity",
     "outputs": [{"type": "uint256", "name": "amount0"}, {"type": "uint256", "name": "amount1"}],
     "stateMutability": "payable", "type": "function"},
    {"inputs": [{"components": [
        {"type": "uint256", "name": "tokenId"}, {"type": "address", "name": "recipient"},
        {"type": "uint128", "name": "amount0Max"}, {"type": "uint128", "name": "amount1Max"},
     ], "internalType": "struct INonfungiblePositionManager.CollectParams",
        "name": "params", "type": "tuple"}],
     "name": "collect",
     "outputs": [{"type": "uint256", "name": "amount0"}, {"type": "uint256", "name": "amount1"}],
     "stateMutability": "payable", "type": "function"},
    {"inputs": [{"type": "uint256", "name": "tokenId"}], "name": "burn",
     "outputs": [], "stateMutability": "payable", "type": "function"},
    {"inputs": [{"type": "address", "name": "owner"}], "name": "balanceOf",
     "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address", "name": "owner"}, {"type": "uint256", "name": "index"}],
     "name": "tokenOfOwnerByIndex", "outputs": [{"type": "uint256"}],
     "stateMutability": "view", "type": "function"},
]

# Topic0 del evento ERC721 Transfer(address,address,uint256) — para leer el tokenId
# minteado del recibo (el NPM emite el Transfer del NFT al recipient).
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


# --- Web3 --------------------------------------------------------------------
def connect(config: RebalancerConfig = DEFAULT_TESTNET_CONFIG, *, timeout: float = 10.0) -> Web3:
    """Devuelve un Web3 conectado al primer RPC vivo de ``config.rpcs``."""
    last: Exception | None = None
    for rpc in config.rpcs:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": timeout}))
            if w3.is_connected():
                return w3
        except Exception as exc:  # noqa: BLE001 — probamos el siguiente RPC
            last = exc
    raise ConnectionError(f"no live BSC-testnet RPC in {config.rpcs} ({last})")


# --- Reconciliación de orientación de ticks ----------------------------------
def _snap(tick: int, spacing: int, *, up: bool) -> int:
    """Redondea ``tick`` al múltiplo de ``spacing`` (hacia abajo/arriba) y lo acota."""
    q = tick / spacing
    snapped = (int(q) + (1 if up and q > int(q) else 0)) * spacing if up else (
        (int(q) - (1 if q < 0 and q != int(q) else 0)) * spacing
    )
    return max(MIN_TICK, min(MAX_TICK, snapped))


@dataclass(frozen=True)
class OrientedTicks:
    """Ticks ya orientados al pool on-chain y snappeados al ``tickSpacing`` real."""

    tick_lower: int
    tick_upper: int
    inverted: bool  # True si se negó/invirtió respecto a la convención de IVL


def orient_ticks(ivl: IvlTicks, pool_token0: str, config: RebalancerConfig, spacing: int) -> OrientedTicks:
    """Reorienta los ticks de IVL (base-quote) a la convención token0/token1 del pool.

    IVL cotiza precio = quote por base (USDT por BNB) ⇒ ticks respecto a token0=BASE.
    Si el pool tiene ``token0 == quote`` (caso BSC testnet: USDT<WBNB), el signo del
    tick se invierte: ``[lo, hi] → [-hi, -lo]``. Luego se snapea al spacing real.
    """
    inverted = Web3.to_checksum_address(pool_token0) == Web3.to_checksum_address(config.quote_token)
    lo, hi = (-ivl.tick_upper, -ivl.tick_lower) if inverted else (ivl.tick_lower, ivl.tick_upper)
    lo_s = _snap(lo, spacing, up=False)
    hi_s = _snap(hi, spacing, up=True)
    if lo_s >= hi_s:  # degenerado tras snap → asegura al menos un spacing de ancho
        hi_s = lo_s + spacing
    return OrientedTicks(tick_lower=lo_s, tick_upper=hi_s, inverted=inverted)


def anchor_ticks_to_live(
    ivl: IvlTicks, pool_token0: str, config: RebalancerConfig, spacing: int, pool_tick: int
) -> OrientedTicks:
    """Ancla el ANCHO del rango IVL alrededor del tick VIVO del pool (modo testnet).

    Motivo (roadmap §Frente 2 · CLAUDE.md §6.2): los pools BNB-USDT de BSC testnet
    están mal-priceados (cotizan BNB≈$11 vs ~$688 de mercado real) porque nadie los
    arbitra. Mintear los ticks ABSOLUTOS de IVL ahí caería 100% fuera de rango →
    posición single-sided sin fees, inútil para el bounty de PancakeSwap.

    IVL sigue siendo el cerebro: aporta el ANCHO ``W = tickUpper - tickLower`` (su
    geometría 2.5×ATR) y la decisión de rebalanceo. Aquí preservamos ese ancho y lo
    centramos sobre el precio VIVO del pool ⇒ posición real, dentro de rango, dos
    lados, que gana fees en testnet. En mainnet ``pool ≡ mercado``, así que se usa
    :func:`orient_ticks` (ticks absolutos de IVL) — ver ``build_mint_plan(anchor_live)``.

    El ancho es invariante a la orientación (una diferencia de ticks), así que se
    trabaja directamente en el espacio de ticks del pool alrededor de ``pool_tick``,
    sin negar/invertir. ``inverted`` se reporta solo para trazabilidad.
    """
    inverted = Web3.to_checksum_address(pool_token0) == Web3.to_checksum_address(config.quote_token)
    width = abs(int(ivl.tick_upper) - int(ivl.tick_lower)) or spacing
    half = width // 2
    lo_s = _snap(pool_tick - half, spacing, up=False)
    hi_s = _snap(pool_tick + (width - half), spacing, up=True)
    if lo_s >= hi_s:
        hi_s = lo_s + spacing
    # Garantía dura de in-range: el tick vivo debe quedar ESTRICTAMENTE dentro.
    if pool_tick <= lo_s:
        lo_s = _snap(pool_tick - spacing, spacing, up=False)
    if pool_tick >= hi_s:
        hi_s = _snap(pool_tick + spacing, spacing, up=True)
    return OrientedTicks(tick_lower=lo_s, tick_upper=hi_s, inverted=inverted)


def base_price_in_quote(pool_tick: int, token0: str, config: RebalancerConfig) -> float:
    """Precio VIVO de BASE en QUOTE (p.ej. USDT por BNB) derivado del tick del pool.

    Raw price v3 = token1/token0 = ``1.0001**tick``. Si ``token0==base`` eso ya es
    quote/base; si ``token0==quote`` se invierte. Usado para dimensionar el depósito
    en modo anchor con el precio real del pool (no el de mercado de IVL).
    """
    token0 = Web3.to_checksum_address(token0)
    if token0 == Web3.to_checksum_address(config.base_token):
        return 1.0001 ** pool_tick
    return 1.0001 ** (-pool_tick)


# --- Construcción de la tx de mint -------------------------------------------
@dataclass
class MintPlan:
    """Todo lo necesario para (dry-run o) enviar el mint. Amounts en wei."""

    config: RebalancerConfig
    pool: str
    token0: str
    token1: str
    fee: int
    tick_lower: int
    tick_upper: int
    amount0_desired: int
    amount1_desired: int
    amount0_min: int = 0
    amount1_min: int = 0
    recipient: str = ""
    deadline: int = 0
    pool_tick: int | None = None
    inverted: bool = False
    anchored: bool = False  # True ⇒ ancho IVL anclado al tick vivo (testnet mal-priceado)
    live_price: float | None = None  # precio vivo de BASE en QUOTE (derivado del pool)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def in_range(self) -> bool:
        """¿El tick vivo del pool cae dentro del rango a mintear? (dos lados/gana fees)."""
        return self.pool_tick is not None and self.tick_lower <= self.pool_tick <= self.tick_upper

    def mint_params(self) -> tuple:
        return (
            self.token0, self.token1, self.fee,
            self.tick_lower, self.tick_upper,
            self.amount0_desired, self.amount1_desired,
            self.amount0_min, self.amount1_min,
            self.recipient, self.deadline,
        )


def build_mint_plan(
    w3: Web3,
    ivl: IvlTicks,
    *,
    recipient: str,
    amount_base_wei: int,
    amount_quote_wei: int,
    config: RebalancerConfig = DEFAULT_TESTNET_CONFIG,
    deadline: int | None = None,
    slippage_min: bool = False,
    anchor_live: bool | None = None,
) -> MintPlan:
    """Lee el pool real, orienta los ticks de IVL y arma el :class:`MintPlan`.

    ``amount_base_wei``/``amount_quote_wei`` son las cantidades de BASE (WBNB) y
    QUOTE (USDT); se mapean a amount0/amount1 según el orden del pool. ``deadline``
    por defecto lo pone el llamador (no usamos ``time`` aquí para tests deterministas).

    ``anchor_live`` elige la estrategia de rango: ``True`` ⇒ ancla el ANCHO de IVL al
    tick vivo del pool (:func:`anchor_ticks_to_live`, para el testnet mal-priceado);
    ``False`` ⇒ ticks ABSOLUTOS de IVL (:func:`orient_ticks`, correcto en mainnet donde
    pool≡mercado). ``None`` (default) ⇒ auto: anchor sii ``chain_id == 97`` (BSC testnet).
    """
    config = config.checksummed()
    recipient = Web3.to_checksum_address(recipient)
    factory = w3.eth.contract(address=config.factory, abi=FACTORY_ABI)
    pool_addr = factory.functions.getPool(config.base_token, config.quote_token, ivl.fee_units).call()
    if int(pool_addr, 16) == 0:
        raise ValueError(
            f"no existe pool {config.base_symbol}/{config.quote_symbol} fee={ivl.fee_units} en la factory"
        )
    pool_addr = Web3.to_checksum_address(pool_addr)
    pool = w3.eth.contract(address=pool_addr, abi=POOL_ABI)
    token0 = Web3.to_checksum_address(pool.functions.token0().call())
    token1 = Web3.to_checksum_address(pool.functions.token1().call())
    spacing = pool.functions.tickSpacing().call()
    slot0 = pool.functions.slot0().call()
    pool_tick = int(slot0[1])

    if anchor_live is None:
        anchor_live = config.chain_id == 97  # BSC testnet ⇒ anclar por pools mal-priceados
    if anchor_live:
        oriented = anchor_ticks_to_live(ivl, token0, config, spacing, pool_tick)
    else:
        oriented = orient_ticks(ivl, token0, config, spacing)
    live_price = base_price_in_quote(pool_tick, token0, config)

    # Mapear base/quote → amount0/amount1 según el orden real del pool.
    if token0 == config.base_token:
        amount0, amount1 = amount_base_wei, amount_quote_wei
    else:
        amount0, amount1 = amount_quote_wei, amount_base_wei

    return MintPlan(
        config=config, pool=pool_addr, token0=token0, token1=token1,
        fee=ivl.fee_units, tick_lower=oriented.tick_lower, tick_upper=oriented.tick_upper,
        amount0_desired=amount0, amount1_desired=amount1,
        amount0_min=amount0 if slippage_min else 0,
        amount1_min=amount1 if slippage_min else 0,
        recipient=recipient, deadline=deadline or 0,
        pool_tick=pool_tick, inverted=oriented.inverted,
        anchored=anchor_live, live_price=live_price,
        extra={"tick_spacing": spacing},
    )


def encode_mint_calldata(w3: Web3, plan: MintPlan) -> str:
    """ABI-encode ``NPM.mint(params)`` → calldata hex (sin firmar)."""
    npm = w3.eth.contract(address=plan.config.position_manager, abi=NPM_ABI)
    return npm.encode_abi("mint", args=[plan.mint_params()])


def encode_approve_calldata(w3: Web3, token: str, spender: str, amount: int) -> str:
    """ABI-encode ``ERC20.approve(spender, amount)`` → calldata hex."""
    erc20 = w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
    return erc20.encode_abi("approve", args=[Web3.to_checksum_address(spender), amount])


def decode_mint_calldata(w3: Web3, calldata: str) -> dict[str, Any]:
    """Round-trip inverso: decodifica el calldata y devuelve los MintParams.

    Prueba de que el encoding preserva ``tickLower/tickUpper`` (verificación offline
    determinista, sin red).
    """
    npm = w3.eth.contract(address=DEFAULT_TESTNET_CONFIG.checksummed().position_manager, abi=NPM_ABI)
    fn, params = npm.decode_function_input(calldata)
    p = params["params"]
    # web3 puede devolver tuple o dict según versión; normalizamos por nombre.
    if isinstance(p, (list, tuple)):
        keys = ["token0", "token1", "fee", "tickLower", "tickUpper", "amount0Desired",
                "amount1Desired", "amount0Min", "amount1Min", "recipient", "deadline"]
        p = dict(zip(keys, p))
    return {"function": fn.fn_name, "params": p}


# --- Broadcast: código fijo de firma (mismo lado que signing.py, NUNCA un tool LLM) ---
# El agente es el ÚNICO firmante. `get_wallet().sign_transaction(tx)` → {"rawTransaction",..}
# (bnbagent.wallets.evm_wallet_provider.EVMWalletProvider); broadcasteamos ese raw. Cada tx
# se arma justo antes de enviarse y se espera su recibo, así el nonce (latest) auto-incrementa.

# Gas por defecto cuando `estimate_gas` no aplica todavía (p.ej. mint antes de que el approve
# esté minado, o decrease sobre una posición que aún no leímos). Topes holgados de testnet.
DEFAULT_GAS = {"approve": 80_000, "mint": 700_000, "decrease": 350_000, "collect": 300_000, "burn": 150_000}


def build_tx(
    w3: Web3,
    config: RebalancerConfig,
    owner: str,
    to: str,
    data: str,
    *,
    value: int = 0,
    gas_hint: str | None = None,
    nonce: int | None = None,
) -> dict[str, Any]:
    """Arma una tx legacy lista para firmar (nonce/gas/gasPrice/chainId).

    Intenta ``estimate_gas``; si revierte (allowance/estado aún no listo) cae al tope
    de :data:`DEFAULT_GAS` para ``gas_hint``. ``value`` en wei (0 para ERC20; >0 solo si
    algún día se usa el path nativo BNB). ``nonce`` explícito para secuencias multi-tx
    (evita la carrera de nonce con RPCs públicos tras balanceador); si es ``None`` se lee
    el nonce ``pending`` del nodo.
    """
    owner = Web3.to_checksum_address(owner)
    tx: dict[str, Any] = {
        "from": owner,
        "to": Web3.to_checksum_address(to),
        "data": data,
        "value": value,
        "chainId": config.chain_id,
        "nonce": nonce if nonce is not None else w3.eth.get_transaction_count(owner, "pending"),
        "gasPrice": w3.eth.gas_price,
    }
    try:
        tx["gas"] = int(w3.eth.estimate_gas({"from": owner, "to": tx["to"], "data": data, "value": value}) * 1.2)
    except Exception:  # noqa: BLE001 — estado no listo (p.ej. approve sin minar) → tope fijo
        tx["gas"] = DEFAULT_GAS.get(gas_hint or "", 500_000)
    return tx


def send_tx(w3: Web3, wallet: Any, tx: dict[str, Any], *, timeout: float = 180.0) -> str:
    """Firma con el wallet del SDK y broadcastea; espera recibo. Devuelve el tx hash 0x."""
    signed = wallet.sign_transaction(tx)
    raw = signed["rawTransaction"] if isinstance(signed, dict) else signed.raw_transaction
    h = w3.eth.send_raw_transaction(raw)
    w3.eth.wait_for_transaction_receipt(h, timeout=timeout)
    return h.hex() if isinstance(h, bytes) else str(h)


class SequentialSender:
    """Envía txs en secuencia con nonce gestionado LOCALMENTE.

    Los RPC públicos de BSC testnet están tras un balanceador: dos requests seguidos
    pueden pegarle a nodos distintos con vistas de nonce desfasadas ⇒ ``nonce too low``.
    Leemos el nonce ``pending`` UNA vez y lo incrementamos localmente tras cada envío,
    así toda una secuencia (approve→approve→mint, o wrap→mint-usdt) es determinista.
    Cada ``send`` espera el recibo antes de devolver (el estado queda minado para el
    siguiente paso). El agente sigue siendo el ÚNICO firmante.
    """

    def __init__(self, w3: Web3, wallet: Any, config: RebalancerConfig, owner: str) -> None:
        self.w3 = w3
        self.wallet = wallet
        self.config = config
        self.owner = Web3.to_checksum_address(owner)
        self._nonce = w3.eth.get_transaction_count(self.owner, "pending")
        self.last_receipt: Any = None  # recibo del último send (p.ej. para leer el tokenId minteado)

    def send(self, to: str, data: str, *, value: int = 0, gas_hint: str | None = None,
             gas: int | None = None, timeout: float = 180.0) -> str:
        tx = build_tx(self.w3, self.config, self.owner, to, data,
                      value=value, gas_hint=gas_hint, nonce=self._nonce)
        if gas is not None:
            tx["gas"] = gas
        signed = self.wallet.sign_transaction(tx)
        raw = signed["rawTransaction"] if isinstance(signed, dict) else signed.raw_transaction
        h = self.w3.eth.send_raw_transaction(raw)
        self.last_receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=timeout)
        self._nonce += 1
        return h.hex() if isinstance(h, bytes) else str(h)


def _npm(w3: Web3, config: RebalancerConfig):
    return w3.eth.contract(address=config.position_manager, abi=NPM_ABI)


def encode_decrease_calldata(w3, config, token_id, liquidity, deadline, *, amount0_min=0, amount1_min=0) -> str:
    return _npm(w3, config).encode_abi(
        "decreaseLiquidity", args=[(token_id, int(liquidity), amount0_min, amount1_min, deadline)]
    )


def encode_collect_calldata(w3, config, token_id, recipient) -> str:
    """collect con amountMax = uint128 máx (retira todo lo debido: principal + fees)."""
    u128_max = (1 << 128) - 1
    return _npm(w3, config).encode_abi(
        "collect", args=[(token_id, Web3.to_checksum_address(recipient), u128_max, u128_max)]
    )


def encode_burn_calldata(w3, config, token_id) -> str:
    return _npm(w3, config).encode_abi("burn", args=[int(token_id)])


@dataclass(frozen=True)
class ExistingPosition:
    """Posición LP v3 existente del owner en el pool objetivo."""

    token_id: int
    liquidity: int
    tick_lower: int
    tick_upper: int
    tokens_owed0: int
    tokens_owed1: int


def find_position(
    w3: Web3, config: RebalancerConfig, owner: str, *, fee: int
) -> ExistingPosition | None:
    """Localiza la posición LP viva del ``owner`` para (base,quote,fee) del pool.

    Recorre los NFTs del owner (ERC721Enumerable) y devuelve la primera con
    ``liquidity > 0`` cuyos token0/token1/fee coinciden con el pool objetivo. None si
    no hay ninguna (⇒ rewiden/reset degradan a abrir/mint).
    """
    config = config.checksummed()
    npm = _npm(w3, config)
    owner = Web3.to_checksum_address(owner)
    want = {Web3.to_checksum_address(config.base_token), Web3.to_checksum_address(config.quote_token)}
    try:
        count = npm.functions.balanceOf(owner).call()
    except Exception:  # noqa: BLE001 — sin NFTs / RPC sin enumerable
        return None
    for i in range(int(count)):
        try:
            tid = npm.functions.tokenOfOwnerByIndex(owner, i).call()
            p = npm.functions.positions(tid).call()
        except Exception:  # noqa: BLE001 — índice movido entre llamadas; sigue
            continue
        # positions(): [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...]
        t0, t1, pfee, tl, tu, liq = p[2], p[3], p[4], p[5], p[6], p[7]
        if int(pfee) != int(fee):
            continue
        if {Web3.to_checksum_address(t0), Web3.to_checksum_address(t1)} != want:
            continue
        if int(liq) <= 0:
            continue
        return ExistingPosition(
            token_id=int(tid), liquidity=int(liq), tick_lower=int(tl), tick_upper=int(tu),
            tokens_owed0=int(p[10]), tokens_owed1=int(p[11]),
        )
    return None


def token_decimals(w3: Web3, token: str) -> int:
    return int(w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI).functions.decimals().call())


def token_balance(w3: Web3, token: str, owner: str) -> int:
    return int(
        w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
        .functions.balanceOf(Web3.to_checksum_address(owner)).call()
    )


def size_amounts(
    w3: Web3,
    config: RebalancerConfig,
    ivl: IvlTicks,
    owner: str,
    *,
    cap_base_human: float = 0.02,
    cap_quote_human: float | None = None,
    quote_price: float | None = None,
) -> tuple[int, int]:
    """Dimensiona el depósito (amount_base_wei, amount_quote_wei) acotado por el saldo real.

    Tope conservador de flagship testnet: ``cap_base_human`` de BASE (WBNB) y su
    equivalente en QUOTE. El precio para convertir se toma de ``quote_price`` (precio
    VIVO del pool en modo anchor) o, si es ``None``, del techo del rango IVL
    (``ivl.price_upper``, correcto en mainnet donde pool≡mercado). Nunca deposita más
    de lo que hay en la wallet.
    """
    config = config.checksummed()
    base_dec = token_decimals(w3, config.base_token)
    quote_dec = token_decimals(w3, config.quote_token)
    if cap_quote_human is None:
        price = quote_price if quote_price is not None else float(ivl.price_upper)
        cap_quote_human = cap_base_human * price
    cap_base_wei = int(cap_base_human * (10 ** base_dec))
    cap_quote_wei = int(cap_quote_human * (10 ** quote_dec))
    base_bal = token_balance(w3, config.base_token, owner)
    quote_bal = token_balance(w3, config.quote_token, owner)
    return min(cap_base_wei, base_bal), min(cap_quote_wei, quote_bal)


def _norm_topic(t: Any) -> str:
    """Normaliza un topic a hex 0x-prefijado en minúsculas.

    web3.py v7 devuelve ``HexBytes.hex()`` SIN prefijo ``0x``; versiones previas lo
    incluían. Normalizamos para comparar sin depender de la versión.
    """
    h = t.hex() if isinstance(t, (bytes, bytearray)) else str(t)
    h = h.lower()
    return h if h.startswith("0x") else "0x" + h


def minted_token_id(receipt: Any, owner: str) -> int | None:
    """Extrae el tokenId minteado del recibo (evento ERC721 Transfer al owner)."""
    owner_topic = "0x" + Web3.to_checksum_address(owner)[2:].lower().rjust(64, "0")
    for log in getattr(receipt, "logs", []) or []:
        topics = [_norm_topic(t) for t in log.get("topics", [])]
        if len(topics) == 4 and topics[0] == TRANSFER_TOPIC.lower() and topics[2] == owner_topic:
            try:
                return int(topics[3], 16)
            except ValueError:
                return None
    return None
