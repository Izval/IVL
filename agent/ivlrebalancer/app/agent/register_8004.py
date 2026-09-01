"""Registro ERC-8004 on-chain — self-pay, SIN el pre-check de 8004scan.

``bag erc8004 register`` hace un pre-check de dedup que **pagina toda la lista de
agentes de 8004scan** (``get_all_agents``) y revienta el rate-limit anónimo (10 req/min,
HTTP 429). El registro real on-chain no necesita ese check: es una sola tx contra el
IdentityRegistry y el ``agentURI`` es un data-URI base64 auto-contenido (sin pinning).

Este script replica EXACTAMENTE el camino del SDK que usa ``bag`` (``_make_sdk`` +
``_build_endpoint`` + ``generate_agent_uri`` + ``register_agent``) pero se salta
``_find_owned_agent`` (la única llamada a 8004scan). El agente es el ÚNICO firmante y
paga su propio gas — misma identidad que produciría ``bag``.

Uso (desde app/agent, venv activo, wallet fondeada):
    python register_8004.py \
        --name "IVL Rebalancer" \
        --endpoint "https://.../agent/ivl-rebalancer" \
        --description "..."
"""
from __future__ import annotations

import argparse
import json

import pancake_v3 as pv3


def register(name: str, endpoint: str, description: str, *, network: str = "bsc-testnet",
             protocol: str = "A2A", version: str = "0.3.0") -> dict:
    pv3.load_agent_env()  # WALLET_PASSWORD desde .studio/.env.local
    from bnbagent_studio_core.wallet import get_wallet
    from bnbagent_studio_core.erc8004.helpers import _make_sdk, _build_endpoint

    wallet = get_wallet()
    sdk = _make_sdk(wallet, network)
    agent_uri = sdk.generate_agent_uri(
        name=name, description=description,
        endpoints=[_build_endpoint(protocol, endpoint, version)],
    )
    result = sdk.register_agent(agent_uri=agent_uri)  # tx on-chain; NO toca 8004scan
    agent_id = result.get("agentId")
    tx_hash = result.get("transactionHash")
    tx_hash = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
    return {
        "success": bool(result.get("success", True)),
        "agent_id": agent_id,
        "owner": sdk.wallet_address,
        "tx_hash": tx_hash,
        "explorer_tx": f"https://testnet.bscscan.com/tx/{tx_hash}",
        "scan": f"https://8004scan.io/agent/{agent_id}?chain=97" if agent_id is not None else None,
        "agent_uri_head": agent_uri[:80],
    }


def _main() -> None:
    ap = argparse.ArgumentParser(description="Registro ERC-8004 on-chain sin pre-check 8004scan.")
    ap.add_argument("--name", required=True)
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--network", default="bsc-testnet")
    ap.add_argument("--protocol", default="A2A")
    ap.add_argument("--version", default="0.3.0")
    args = ap.parse_args()
    out = register(args.name, args.endpoint, args.description,
                   network=args.network, protocol=args.protocol, version=args.version)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _main()
