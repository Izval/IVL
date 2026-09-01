# Deploying the IVL Rebalancer agent (A2A seller) on Render

Self-deploy the agent as a Docker web service. The container serves the **A2A
surface** — agent card at `/.well-known/agent-card.json`, JSON-RPC `message/send`,
and `GET /ping` — so buyers/orchestrators can discover, negotiate, pay
(ERC-8183 / x402) and receive the IVL rebalance deliverable. Payment settles to
**the agent's own wallet, which you custody** (self-deploy keeps the signing key
under your control, unlike the managed 48h trial).

> **Secrets are never in this repo.** The encrypted keystore, its unlock
> password, and the LLM key are injected at deploy time as Render secrets. The
> image is safe to build from the public repo.

## 1. Create the service
Render dashboard → **New → Web Service** → connect the `Izval/IVL` GitHub repo.
- **Root Directory:** `agent`
- **Runtime:** Docker (Render auto-detects the `Dockerfile`)
- **Health Check Path:** `/ping`
- **Instance type:** the free tier works for a demo (sleeps after ~15 min idle;
  keep it warm with an external ping to `/ping` if it must stay hot during judging).

## 2. Set the secrets (Environment → Environment Variables, all "secret")
| Key | Value |
|---|---|
| `WALLET_PASSWORD` | the password that unlocks the keystore (the one set in `.studio/.env.local` locally) |
| `AGENT_KEYSTORE_JSON` | the **full JSON** of the keystore file `.studio/wallets/<address>.json` (paste its contents) |
| `AGENT_KEYSTORE_ADDRESS` | the wallet address, e.g. `0xa1Fe55DCf41c1D3805Aad41D4aD1C9E1E06F06f1` |
| `ANTHROPIC_API_KEY` | *(optional)* LLM key for the general-chat path; the rebalance deliverable itself is deterministic (IVL API + on-chain reads) and works without it |

The entrypoint writes `AGENT_KEYSTORE_JSON` to `/app/ivlrebalancer/.studio/wallets/<address>.json`
at boot and `get_wallet()` unlocks it with `WALLET_PASSWORD`. The keystore never
touches the repo or the image layers.

> Get the keystore JSON locally with:
> `cat agent/ivlrebalancer/.studio/wallets/<address>.json` (this file is gitignored).

## 3. Deploy, then point the on-chain identity at it
After the first deploy Render gives a URL like `https://ivl-rebalancer.onrender.com`.
Register/refresh the ERC-8004 endpoint to that URL so the identity resolves to the
live agent card:

```bash
# from agent/ivlrebalancer/app/agent, with the local venv + .studio/.env.local
python -m bag erc8004 update-endpoint \
  --endpoint "https://ivl-rebalancer.onrender.com" --network bsc-testnet
# (or: bag erc8004 update-endpoint … ; the SDK appends /.well-known/agent-card.json)
```

Verify: `curl https://ivl-rebalancer.onrender.com/.well-known/agent-card.json`.

## Local smoke test (optional, before Render)
```bash
docker build -t ivl-agent agent/
docker run --rm -p 9000:9000 \
  -e WALLET_PASSWORD='…' \
  -e AGENT_KEYSTORE_ADDRESS='0xa1Fe55DCf41c1D3805Aad41D4aD1C9E1E06F06f1' \
  -e AGENT_KEYSTORE_JSON="$(cat agent/ivlrebalancer/.studio/wallets/0xa1Fe55DCf41c1D3805Aad41D4aD1C9E1E06F06f1.json)" \
  ivl-agent
# then: curl localhost:9000/.well-known/agent-card.json
```

## Pricing (what you earn)
The seller price is `[payments.erc8183].price` in `app/agent/studio.toml`
(default `0.1 $U`, testnet). Set `max_price` before going live, and for real
revenue move to mainnet with a real payment token. Settled payments land in the
agent wallet you custody.
