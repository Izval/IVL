# ivlrebalancer — A2A seller agent (managed-platform trial)

The valuable Agent and the **SOLE key-holder/signer** for the ivlrebalancer seller,
configured for the **BNB Chain managed platform** (`[deploy].destination =
"platform"`) — a 48h **testnet-only** trial sandbox. It serves the SAME
A2A surface as a self-deploy (`serve_a2a`: the agent card at `/.well-known/agent-card.json` + JSON-RPC `message/send` on `0.0.0.0:9000`); the LLM + read-only chain
tools run inside `notify_funded`, and every signing op (quote-clamp-sign /
submit / settle) is fixed entrypoint code in [`signing.py`](signing.py) — never
an LLM-callable tool.

## What's here

- `main.py` — the A2A entrypoint on `0.0.0.0:9000` (same as self-deploy).
- `signing.py` — protocol-neutral signing entrypoints. ALL on-chain writes
  go through these functions.
- `managed_model.py` — provider × framework adapter (e.g. PieverseManagedModel
  for Pieverse-on-ADK).
- `tools.py` — framework-flavored read-only chain tools (ADK `FunctionTool`s).
- `Dockerfile` — the arm64 container the platform builds + pushes (the platform
  runtime is Graviton).
- `studio.toml` — Agent's own config (wallet, LLM, price bounds, budget) +
  `[deploy].destination = "platform"`.
- `.env.local` — Agent secrets; on deploy they are sent to the **operator's**
  Secrets Manager (the scoped, consented commitment-#2 exception). Use a
  THROWAWAY testnet wallet — `(cd app/agent && bag wallet new)`.

## Run locally

`bag dev` from the workspace root runs the A2A server in-process (`python
main.py`, no Docker) on its contract port:

```bash
bag dev                                    # A2A on http://localhost:9000
```

It auto-loads `.studio/.env.local` (via python-dotenv; no need to `source` it).

## Deploy (managed platform — 48h testnet trial)

```bash
bag platform login                         # GitHub device flow (~/.bag/session.json)
# From the workspace root:
bag deploy agent                           # build+push the arm64 image, then deploy (reads [deploy].destination = platform)
```

The platform brokers a private registry, injects your secrets into the
**operator's** Secrets Manager, and routes to the agent's native A2A
surface. The trial is testnet-forced and auto-reclaimed at 48h. Account/session
ops live under `bag platform {login,logout,whoami,agents,credit}`. See
`docs/guides/platform-deploy.md`.
