#!/bin/sh
# Materialize the signing keystore from a runtime secret (NEVER from the repo),
# then start the A2A server on the platform-provided port.
#
# Required env at deploy (set as Render secrets — see DEPLOY.md):
#   WALLET_PASSWORD          unlocks the keystore (get_wallet reads this)
#   AGENT_KEYSTORE_JSON      the encrypted keystore file's JSON content
#   AGENT_KEYSTORE_ADDRESS   the wallet address (0x…) — the keystore filename
# Optional:
#   ANTHROPIC_API_KEY        LLM key for the general chat path (rebalance work is deterministic)
#   PORT                     platform-assigned port (Render sets it); falls back to 9000
set -e

KS_DIR=/app/ivlrebalancer/.studio/wallets

if [ -n "$AGENT_KEYSTORE_JSON" ] && [ -n "$AGENT_KEYSTORE_ADDRESS" ]; then
    mkdir -p "$KS_DIR"
    # Write with restrictive perms; content comes from the platform secret store.
    umask 077
    printf '%s' "$AGENT_KEYSTORE_JSON" > "$KS_DIR/$AGENT_KEYSTORE_ADDRESS.json"
    echo "entrypoint: keystore for $AGENT_KEYSTORE_ADDRESS written to $KS_DIR"
else
    echo "entrypoint: WARNING — no AGENT_KEYSTORE_JSON/ADDRESS; signing ops will fail until provided"
fi

export AGENT_PORT="${PORT:-9000}"

# The agent card advertises AGENTCORE_RUNTIME_URL as its public `url`. On Render,
# RENDER_EXTERNAL_URL is the service's public https URL — use it so the card
# self-describes correctly (otherwise it would announce localhost). Respect an
# explicit AGENTCORE_RUNTIME_URL if one is already set.
if [ -z "$AGENTCORE_RUNTIME_URL" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
    export AGENTCORE_RUNTIME_URL="$RENDER_EXTERNAL_URL"
fi
echo "entrypoint: starting A2A server on 0.0.0.0:$AGENT_PORT (card url: ${AGENTCORE_RUNTIME_URL:-http://localhost:$AGENT_PORT/})"

exec python main.py
