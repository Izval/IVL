"""Update the on-chain agent metadata (agentURI) of an already-registered agent,
KEEPING its agent_id. Gas-only whole-URI replacement via the SDK's update_endpoint.

Use it to fix/extend the name, description, or endpoint after registration without
re-minting (which would create a NEW agent_id). All three are re-sent because the
update replaces the whole URI — pass the current name/endpoint plus the new text.

    python update_description.py --network bsc-mainnet \
        --endpoint "https://ivl-mainnet.onrender.com" \
        --name "IVL Rebalancer" \
        --description "..."

Reads the signer from studio.toml [wallet] + WALLET_PASSWORD (.studio/.env.local),
exactly like register_8004.py — run it on the same branch/wallet that registered.
"""
import argparse
import json

import pancake_v3 as pv3


def update(name: str, endpoint: str, description: str, *, network: str = "bsc-testnet",
           protocol: str = "A2A", version: str = "0.3.0") -> dict:
    pv3.load_agent_env()  # WALLET_PASSWORD from .studio/.env.local
    from bnbagent_studio_core.wallet import get_wallet
    from bnbagent_studio_core.erc8004.helpers import _make_sdk, _build_endpoint, update_endpoint

    wallet = get_wallet()
    sdk = _make_sdk(wallet, network)
    # Whole-URI replacement: re-send name + endpoint so only the description changes.
    new_uri = sdk.generate_agent_uri(
        name=name, description=description,
        endpoints=[_build_endpoint(protocol, endpoint, version)],
    )
    tx_hash = update_endpoint(wallet, new_uri, network=network)  # keeps agent_id
    tx_hash = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)

    is_mainnet = "mainnet" in network.lower()
    explorer_base = "https://bscscan.com" if is_mainnet else "https://testnet.bscscan.com"
    return {
        "success": True,
        "owner": sdk.wallet_address,
        "tx_hash": tx_hash,
        "explorer_tx": f"{explorer_base}/tx/{tx_hash}",
        "agent_uri_head": new_uri[:80],
    }


def _main() -> None:
    ap = argparse.ArgumentParser(description="Update an ERC-8004 agent's on-chain metadata (keeps agent_id).")
    ap.add_argument("--name", required=True)
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--description", required=True)
    ap.add_argument("--network", default="bsc-testnet")
    ap.add_argument("--protocol", default="A2A")
    ap.add_argument("--version", default="0.3.0")
    args = ap.parse_args()
    out = update(args.name, args.endpoint, args.description,
                 network=args.network, protocol=args.protocol, version=args.version)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _main()
