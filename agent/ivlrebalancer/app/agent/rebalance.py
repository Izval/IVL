"""Orquestador del rebalanceo IVL → LP v3. Poll IVL → decide → (dry-run) ejecuta.

Une :mod:`ivl_client` (lee el rango) con :mod:`pancake_v3` (arma/encodea el mint).
Expone tres superficies:

1. :func:`plan_rebalance` — **solo lectura**: rango IVL + tx que se ENVIARÍA + dry-run
   (``eth_call``) contra el pool real, SIN firmar ni broadcastear. Es lo que consume el
   tool LLM-callable de ``tools.py`` y el CLI de verificación local (``python rebalance.py``).
2. :func:`execute_rebalance` — **firma y broadcastea** (código fijo, gated por credenciales):
   approve + mint vía ``EVMWalletProvider.sign_transaction`` del SDK. NO es un tool LLM.
3. :func:`render_deliverable` — texto del manifiesto para el hook ``run_work`` del seller.

Milestone Fase 1 (roadmap §4b): el dry-run prueba que los ticks de IVL encodean y
orientan bien contra el pool en vivo, sin gastar tBNB. El broadcast real se desbloquea
cuando el usuario fondea la wallet (ver README → handoff).
"""
from __future__ import annotations

import argparse
import json
import time
from typing import Any

from web3 import Web3

import pancake_v3 as pv3
from ivl_client import IvlTicksResponse, fetch_ticks

# Acción IVL → intención de gestión del rango.
ACTION_INTENT = {
    "open_or_hold": "mint",           # abrir/mantener en el rango vigente
    "withdraw_or_widen": "rewiden",   # retirar y re-mintear más ancho (2.5×ATR)
    "reset": "reset",                 # collect + burn + re-mint centrado
}

# Cantidades nominales para el dry-run (no se gasta nada; el eth_call revierte por
# saldo/allowance, lo que igualmente prueba que el encoding decodifica).
DRY_RUN_BASE_HUMAN = 0.01  # 0.01 WBNB


def _erc20(w3: Web3, token: str):
    return w3.eth.contract(address=Web3.to_checksum_address(token), abi=pv3.ERC20_ABI)


def plan_rebalance(
    pair: str = "BNB-USDT",
    *,
    recipient: str | None = None,
    config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG,
    ivl_base_url: str | None = None,
    do_dry_run: bool = True,
    anchor_live: bool | None = None,
) -> dict[str, Any]:
    """Lee IVL, arma el mint contra el pool real y (opcional) hace dry-run. Solo lectura.

    ``recipient`` por defecto es un placeholder de solo-encoding cuando aún no hay
    wallet (para ``eth_call`` el ``from`` puede ser cualquier address). No firma nada.
    """
    config = config.checksummed()
    recipient = Web3.to_checksum_address(recipient) if recipient else "0x000000000000000000000000000000000000dEaD"

    ticks_resp: IvlTicksResponse = fetch_ticks(
        pair, base_url=(ivl_base_url or "https://api.zvlint.com")
    )
    ivl = ticks_resp.ticks
    action = ticks_resp.decision.action
    intent = ACTION_INTENT.get(action, "mint")

    report: dict[str, Any] = {
        "pair": pair,
        "ivl_score": ticks_resp.ivl_score,
        "classification": ticks_resp.classification,
        "decision": {
            "action": action,
            "intent": intent,
            "breakout_risk": ticks_resp.decision.breakout_risk,
            "rationale": ticks_resp.decision.rationale,
        },
        "ivl_ticks": {
            "tickLower": ivl.tick_lower, "tickUpper": ivl.tick_upper,
            "tickSpacing": ivl.tick_spacing, "feeUnits": ivl.fee_units,
            "priceLower": ivl.price_lower, "priceUpper": ivl.price_upper,
        },
    }

    w3 = pv3.connect(config)
    report["network"] = {"chainId": w3.eth.chain_id, "rpc_connected": True}

    # Decimales reales para dimensionar las cantidades nominales del dry-run.
    quote_dec = _erc20(w3, config.quote_token).functions.decimals().call()
    base_dec = _erc20(w3, config.base_token).functions.decimals().call()
    amount_base = int(DRY_RUN_BASE_HUMAN * (10 ** base_dec))
    amount_quote = int(DRY_RUN_BASE_HUMAN * ivl.price_upper * (10 ** quote_dec))

    plan = pv3.build_mint_plan(
        w3, ivl, recipient=recipient,
        amount_base_wei=amount_base, amount_quote_wei=amount_quote,
        config=config, deadline=int(time.time()) + 1200, anchor_live=anchor_live,
    )
    report["pool"] = {
        "address": plan.pool, "token0": plan.token0, "token1": plan.token1,
        "fee": plan.fee, "tickSpacing": plan.extra.get("tick_spacing"),
        "currentTick": plan.pool_tick,
        "livePrice": plan.live_price,
    }
    report["oriented_ticks"] = {
        "tickLower": plan.tick_lower, "tickUpper": plan.tick_upper,
        "inverted_vs_ivl": plan.inverted,
        "anchored_to_live": plan.anchored,
        "in_range": plan.in_range,
    }

    mint_calldata = pv3.encode_mint_calldata(w3, plan)
    decoded = pv3.decode_mint_calldata(w3, mint_calldata)
    dp = decoded["params"]
    roundtrip_ok = (
        int(dp["tickLower"]) == plan.tick_lower and int(dp["tickUpper"]) == plan.tick_upper
    )
    report["mint_tx"] = {
        "to": plan.config.position_manager,
        "calldata_len": len(mint_calldata),
        "calldata_head": mint_calldata[:74],
        "decoded_roundtrip_ok": roundtrip_ok,
    }

    # Approvals que harían falta (lectura de allowance real).
    npm = plan.config.position_manager
    approvals = []
    for token, amount, sym in (
        (plan.token0, plan.amount0_desired, "token0"),
        (plan.token1, plan.amount1_desired, "token1"),
    ):
        allowance = _erc20(w3, token).functions.allowance(
            Web3.to_checksum_address(recipient), Web3.to_checksum_address(npm)
        ).call()
        approvals.append({
            "which": sym, "token": token, "needs_approve": allowance < amount,
            "current_allowance": str(allowance),
            "approve_calldata_head": pv3.encode_approve_calldata(w3, token, npm, amount)[:74],
        })
    report["approvals"] = approvals

    if do_dry_run:
        report["dry_run"] = _dry_run_mint(w3, plan, recipient)

    return report


def _dry_run_mint(w3: Web3, plan: pv3.MintPlan, recipient: str) -> dict[str, Any]:
    """``eth_call`` del mint sin broadcast. Un revert por saldo/allowance es ESPERADO
    y prueba que el calldata decodifica en el contrato (encoding válido)."""
    calldata = pv3.encode_mint_calldata(w3, plan)
    tx = {"to": plan.config.position_manager, "from": Web3.to_checksum_address(recipient), "data": calldata}
    out: dict[str, Any] = {"broadcast": False, "method": "eth_call"}
    try:
        w3.eth.call(tx)
        out["result"] = "call_succeeded"  # improbable sin saldo, pero válido
        out["encoding_valid"] = True
    except Exception as exc:  # noqa: BLE001 — el revert es la vía normal aquí
        msg = str(exc)
        out["revert"] = msg[:300]
        # Un revert de ejecución (STF/allowance/balance) ⇒ el contrato ACEPTÓ y decodificó
        # el calldata. Solo un error de ABI/selector significaría encoding roto.
        out["encoding_valid"] = "execution reverted" in msg or "revert" in msg.lower()
    return out


def _ensure_approvals(sender: pv3.SequentialSender, plan: pv3.MintPlan) -> list[dict[str, Any]]:
    """Aprueba token0/token1 al NPM si el allowance no cubre el depósito. Devuelve las txs."""
    w3, owner, npm = sender.w3, sender.owner, plan.config.position_manager
    out: list[dict[str, Any]] = []
    for token, amount, sym in (
        (plan.token0, plan.amount0_desired, "token0"),
        (plan.token1, plan.amount1_desired, "token1"),
    ):
        if amount <= 0:
            continue
        allowance = _erc20(w3, token).functions.allowance(
            owner, Web3.to_checksum_address(npm)
        ).call()
        if allowance >= amount:
            continue
        data = pv3.encode_approve_calldata(w3, token, npm, amount)
        tx_hash = sender.send(token, data, gas_hint="approve")
        out.append({"which": sym, "token": token, "tx_hash": tx_hash})
    return out


def _withdraw_position(sender: pv3.SequentialSender, plan: pv3.MintPlan, pos: pv3.ExistingPosition, *, burn: bool) -> dict[str, Any]:
    """decrease(liquidity) → collect(todo) → [burn]. Deja el capital en la wallet para re-mint."""
    w3, owner, npm = sender.w3, sender.owner, plan.config.position_manager
    deadline = int(time.time()) + 1200
    steps: dict[str, Any] = {"token_id": pos.token_id}
    dec_data = pv3.encode_decrease_calldata(w3, plan.config, pos.token_id, pos.liquidity, deadline)
    steps["decrease_tx"] = sender.send(npm, dec_data, gas_hint="decrease")
    col_data = pv3.encode_collect_calldata(w3, plan.config, pos.token_id, owner)
    steps["collect_tx"] = sender.send(npm, col_data, gas_hint="collect")
    if burn:
        burn_data = pv3.encode_burn_calldata(w3, plan.config, pos.token_id)
        steps["burn_tx"] = sender.send(npm, burn_data, gas_hint="burn")
    return steps


def execute_rebalance(
    pair: str = "BNB-USDT",
    *,
    config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG,
    cap_base_human: float = 0.02,
    cap_quote_human: float | None = None,
    anchor_live: bool | None = None,
    allow_out_of_range: bool = False,
) -> dict[str, Any]:
    """FIRMA y broadcastea el rebalanceo. CÓDIGO FIJO, no un tool LLM.

    Despacha según la acción de IVL:
      - ``open_or_hold`` → **mint**: approve(token0/token1 si falta) → mint del rango.
      - ``withdraw_or_widen`` → **rewiden**: si hay posición, decrease+collect; luego mint más ancho.
      - ``reset`` → **reset**: decrease+collect+**burn** de la vieja; luego mint centrado.

    Gated por credenciales: requiere ``WALLET_PASSWORD`` + keystore (``bag wallet new``) y
    saldo de WBNB/USDT (tBNB envuelto) en la wallet. El agente es el ÚNICO firmante
    (``get_wallet().sign_transaction``). Devuelve los tx hashes de cada paso + el tokenId nuevo.
    """
    pv3.load_agent_env()  # WALLET_PASSWORD desde .studio/.env.local (como hace bag)
    from bnbagent_studio_core.wallet import get_wallet  # import perezoso: exige entorno de wallet

    config = config.checksummed()
    wallet = get_wallet()
    owner = Web3.to_checksum_address(wallet.address)
    w3 = pv3.connect(config)
    sender = pv3.SequentialSender(w3, wallet, config, owner)  # nonce local para toda la secuencia

    ticks_resp = fetch_ticks(pair, base_url="https://api.zvlint.com")
    ivl = ticks_resp.ticks
    intent = ACTION_INTENT.get(ticks_resp.decision.action, "mint")

    result: dict[str, Any] = {
        "pair": pair,
        "owner": owner,
        "action": ticks_resp.decision.action,
        "intent": intent,
        "steps": {},
    }

    # 1) rewiden/reset: retirar la posición vigente PRIMERO (libera capital a la wallet).
    if intent in ("rewiden", "reset"):
        pos = pv3.find_position(w3, config, owner, fee=ivl.fee_units)
        if pos is not None:
            # plan temporal solo para tener config/position_manager en los helpers de retiro.
            tmp_plan = pv3.MintPlan(config=config, pool="", token0=config.base_token,
                                    token1=config.quote_token, fee=ivl.fee_units,
                                    tick_lower=0, tick_upper=0, amount0_desired=0, amount1_desired=0)
            result["steps"]["withdraw"] = _withdraw_position(
                sender, tmp_plan, pos, burn=(intent == "reset")
            )
        else:
            result["steps"]["withdraw"] = {"skipped": "sin posición previa → se abre una nueva"}

    # 2) Sondear el pool (tick/orientación/precio vivo) con amounts nominales, para
    #    dimensionar el depósito con el PRECIO VIVO en modo anchor (no el de mercado IVL).
    probe = pv3.build_mint_plan(
        w3, ivl, recipient=owner, amount_base_wei=0, amount_quote_wei=0,
        config=config, deadline=int(time.time()) + 1200, anchor_live=anchor_live,
    )
    quote_price = probe.live_price if probe.anchored else None

    # 3) Dimensionar el depósito con el saldo ACTUAL (ya incluye lo retirado arriba).
    amount_base, amount_quote = pv3.size_amounts(
        w3, config, ivl, owner, cap_base_human=cap_base_human,
        cap_quote_human=cap_quote_human, quote_price=quote_price,
    )
    if amount_base <= 0 and amount_quote <= 0:
        raise RuntimeError(
            "wallet sin saldo de WBNB/USDT para mintear. Fondea con el faucet y envuelve tBNB→WBNB "
            "(ver README → handoff). El agente no simula: no hay capital que desplegar."
        )

    # 4) Construir el mint real con los ticks (anclados o absolutos) de IVL.
    plan = pv3.build_mint_plan(
        w3, ivl, recipient=owner, amount_base_wei=amount_base, amount_quote_wei=amount_quote,
        config=config, deadline=int(time.time()) + 1200, anchor_live=anchor_live,
    )
    # Guarda dura (CLAUDE.md §6.2): no mintear fuera de rango salvo override explícito.
    # En modo anchor siempre es in-range por construcción; el guard protege el modo absoluto.
    if not plan.in_range and not allow_out_of_range:
        raise RuntimeError(
            f"rango [{plan.tick_lower},{plan.tick_upper}] FUERA del tick vivo del pool "
            f"({plan.pool_tick}) → la posición sería single-sided sin fees. Usa modo anchor "
            f"(default testnet) o pasa allow_out_of_range=True si es deliberado."
        )
    result["oriented_ticks"] = {
        "tickLower": plan.tick_lower, "tickUpper": plan.tick_upper,
        "inverted_vs_ivl": plan.inverted, "anchored_to_live": plan.anchored,
        "in_range": plan.in_range, "livePrice": plan.live_price,
    }
    result["amounts"] = {"amount0_desired": str(plan.amount0_desired), "amount1_desired": str(plan.amount1_desired)}

    # 4) Approvals + mint (mismo sender ⇒ nonce secuencial determinista).
    result["steps"]["approvals"] = _ensure_approvals(sender, plan)
    mint_data = pv3.encode_mint_calldata(w3, plan)
    mint_hash = sender.send(plan.config.position_manager, mint_data, gas_hint="mint")
    result["steps"]["mint_tx"] = mint_hash
    result["token_id"] = pv3.minted_token_id(sender.last_receipt, owner)
    result["explorer"] = f"https://testnet.bscscan.com/tx/{mint_hash}"
    return result


def live_position(
    owner: str,
    *,
    fee: int = 500,
    config: pv3.RebalancerConfig = pv3.DEFAULT_TESTNET_CONFIG,
    pool_current_tick: int | None = None,
) -> dict[str, Any] | None:
    """Read the agent's CURRENT on-chain v3 position for the pool. Read-only.

    Uses only the public ``owner`` address (no keystore unlock), so it is safe to
    call from the deterministic, no-LLM deliverable hook. Returns None when the
    owner has no live position for (base, quote, fee). ``in_range`` is computed
    against ``pool_current_tick`` when supplied.
    """
    config = config.checksummed()
    w3 = pv3.connect(config)
    pos = pv3.find_position(w3, config, Web3.to_checksum_address(owner), fee=fee)
    if pos is None:
        return None
    in_range = (
        pool_current_tick is not None
        and pos.tick_lower <= int(pool_current_tick) <= pos.tick_upper
    )
    return {
        "token_id": pos.token_id,
        "tick_lower": pos.tick_lower,
        "tick_upper": pos.tick_upper,
        "in_range": in_range,
        "liquidity": str(pos.liquidity),
        "owner": Web3.to_checksum_address(owner),
        "explorer": f"https://testnet.bscscan.com/token/{config.position_manager}?a={pos.token_id}",
    }


def render_deliverable(report: dict[str, Any], live_pos: dict[str, Any] | None = None) -> str:
    """Manifiesto legible del rebalanceo — lo que el seller entrega (hook ``run_work``).

    Cuando ``live_pos`` viene dado (posición on-chain viva del agente), añade un
    bloque LIVE POSITION con el tokenId, el rango on-chain, in_range y el enlace al
    explorer — para que el comprador vea la posición real que respalda el plan.
    """
    d = report["decision"]
    ot = report.get("oriented_ticks", {})
    lines = [
        f"IVL Rebalancer — {report['pair']}",
        f"  IVL score: {report['ivl_score']} ({report['classification']}) · "
        f"breakout: {d['breakout_risk']}",
        f"  Decision: {d['action']} → intent={d['intent']}",
        f"  Rationale: {d['rationale']}",
    ]
    if "pool" in report:
        p = report["pool"]
        mode = "anchored→live" if ot.get("anchored_to_live") else "absolute (IVL)"
        lines += [
            f"  Pool: {p['address']} fee={p['fee']} spacing={p['tickSpacing']} "
            f"tick={p['currentTick']} livePrice={p.get('livePrice'):.4f}"
            if p.get("livePrice") is not None else
            f"  Pool: {p['address']} fee={p['fee']} spacing={p['tickSpacing']} tick={p['currentTick']}",
            f"  Range (on-chain): [{ot.get('tickLower')}, {ot.get('tickUpper')}] "
            f"mode={mode} inverted={ot.get('inverted_vs_ivl')} in_range={ot.get('in_range')}",
        ]
    if "dry_run" in report:
        lines.append(f"  Dry-run: encoding_valid={report['dry_run'].get('encoding_valid')}")
    if live_pos:
        lines += [
            "  Live position (on-chain):",
            f"    tokenId {live_pos['token_id']} · range "
            f"[{live_pos['tick_lower']}, {live_pos['tick_upper']}] · "
            f"in_range={live_pos['in_range']} · liquidity={live_pos['liquidity']}",
            f"    Explorer: {live_pos['explorer']}",
        ]
    return "\n".join(lines)


# --- Tool de solo-lectura para el LLM (tools.py) -----------------------------
def ivl_rebalance_plan(pair: str = "BNB-USDT") -> dict[str, Any]:
    """Devuelve el plan de rebalanceo IVL para ``pair`` (rango, decisión y dry-run).

    SOLO LECTURA: consulta el motor IVL y simula el mint contra el pool en vivo sin
    firmar ni gastar. Úsalo para explicar/justificar el rango antes de ejecutar.
    """
    return plan_rebalance(pair)


# --- CLI de verificación local -----------------------------------------------
def _main() -> None:
    ap = argparse.ArgumentParser(description="Rebalanceo IVL → LP v3 (dry-run por defecto; --execute broadcastea).")
    ap.add_argument("--pair", default="BNB-USDT")
    ap.add_argument("--recipient", default=None, help="address (default: placeholder de solo-encoding)")
    ap.add_argument("--json", action="store_true", help="volcar el reporte JSON completo")
    ap.add_argument("--execute", action="store_true",
                    help="FIRMA y broadcastea (requiere wallet fondeada + WALLET_PASSWORD). Gated.")
    ap.add_argument("--cap-base", type=float, default=0.02, help="tope de BASE (WBNB) a depositar")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--anchor-live", dest="anchor_live", action="store_true", default=None,
                      help="ancla el ancho IVL al tick vivo del pool (default en testnet)")
    mode.add_argument("--absolute-ticks", dest="anchor_live", action="store_false",
                      help="usa los ticks absolutos de IVL (default/correcto en mainnet)")
    ap.add_argument("--allow-out-of-range", action="store_true",
                    help="permite mintear fuera de rango (single-sided) — deliberado, se salta la guarda")
    args = ap.parse_args()

    if args.execute:
        # Broadcast real: gated por credenciales. Nunca simula.
        result = execute_rebalance(
            args.pair, cap_base_human=args.cap_base,
            anchor_live=args.anchor_live, allow_out_of_range=args.allow_out_of_range,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    report = plan_rebalance(args.pair, recipient=args.recipient, anchor_live=args.anchor_live)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(render_deliverable(report))
        dr = report.get("dry_run", {})
        print(f"\n[dry-run] {dr.get('method')}: encoding_valid={dr.get('encoding_valid')}")
        if dr.get("revert"):
            print(f"[dry-run] revert (esperado sin saldo): {dr['revert'][:160]}")
        print(f"[roundtrip] mint calldata decode ok: {report['mint_tx']['decoded_roundtrip_ok']}")


if __name__ == "__main__":
    _main()
