# IVL Rebalancer — ERC-8004 / A2A seller agent (self-deploy container).
#
# Serves the A2A surface (agent card at /.well-known/agent-card.json + JSON-RPC
# message/send + GET /ping) so buyers/orchestrators can discover, negotiate,
# pay (ERC-8183/x402) and receive the IVL rebalance deliverable.
#
# SECRETS ARE NEVER BAKED IN. The encrypted keystore + unlock password + LLM key
# are injected at runtime as env vars / Render secrets (see DEPLOY.md). The image
# is safe to build from the PUBLIC repo.
FROM python:3.12-slim

# Build toolchain for the few crypto wheels that may compile from source
# (cffi / ckzg / cytoolz). curl is used by the container health probe.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Exact locked dependency tree (reproducible). bnbagent-studio pulls bnbagent,
# bnbagent-studio-core, web3, uvicorn, a2a-sdk, google-adk, bedrock-agentcore, …
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt

# Agent code only (no .studio/, no keystore — enforced by .gitignore + .dockerignore).
COPY ivlrebalancer/ ./ivlrebalancer/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Flat imports (import pancake_v3, …) + studio.toml live here; studio.toml resolves
# the keystore at ../../.studio/wallets, which the entrypoint populates at boot.
WORKDIR /app/ivlrebalancer/app/agent

ENV AGENT_BIND_HOST=0.0.0.0
EXPOSE 9000

# Render provides $PORT; the entrypoint bridges it to AGENT_PORT (A2A default 9000)
# and materializes the keystore from AGENT_KEYSTORE_JSON before serving.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
