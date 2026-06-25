# IVL Hosted API — Cloudflare Worker

Public low-latency API that serves the IVL score, deployable PancakeSwap v3 ticks, and a pool screener.
Reference deployment: **https://api.zvlint.com** · live demo: **https://zvlint.com/ventures/ivl**.

Apache-2.0. Self-contained: bundles a vendored snapshot of the IVL engine (`src/ivl.ts`, `src/binance.ts`)
so it deploys with no external dependencies.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /v1/health` | Liveness. |
| `GET /v1/ivl?pair=BNB-USDT&lookback=120&scales=15m,1h,4h,1d&equity=10000` | Full IVL compute (+ `lp_ticks`). |
| `GET /v1/ivl/ticks?pair=BNB-USDT` | Score + deployable Pancake v3 `tickLower`/`tickUpper`. |
| `GET /v1/screener?minScore=60&class=good&action=concentrate&limit=50` | Pre-computed pools, sorted by score. |
| `GET /v1/screener/rebuild` | Recompute the screener (also runs on a 4h cron). |

CORS is open (`ALLOWED_ORIGIN="*"`) — read-only public market data, embeddable.

## Data source

Candles come from **MEXC** (`api.mexc.com`), whose REST klines API is Binance-compatible (same params and
shape). MEXC is used because Binance geoblocks datacenter/cloud IPs (HTTP 451/403) from Cloudflare's edge;
MEXC responds from the edge and covers the BNB pairs. The skill's CLI (`../scripts/`) uses Binance directly.

## Local dev

```bash
npm install
npm run dev            # wrangler dev on :8787 (KV simulated by Miniflare)
curl localhost:8787/v1/health
curl "localhost:8787/v1/ivl?pair=BNB-USDT"
curl localhost:8787/v1/screener/rebuild
npm run typecheck
```

## Deploy your own

```bash
npx wrangler kv namespace create IVL_KV            # paste id into wrangler.toml
npx wrangler kv namespace create IVL_KV --preview  # paste preview_id into wrangler.toml
# (optional) set your own custom domain in wrangler.toml, or use the *.workers.dev URL
npx wrangler deploy
```
Auth via `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) — never commit them.

## Abuse / cost protection (built in)
- **Per-IP rate limit** — 100 req / 60s (Cache API, no KV cost; `/v1/health` exempt). Tune `RL_LIMIT` in `src/index.ts`.
- **`/v1/screener/rebuild` requires a secret** — set it before going live:
  ```bash
  echo "$(openssl rand -hex 16)" | npx wrangler secret put REBUILD_SECRET
  # then call: /v1/screener/rebuild?key=<secret>
  ```
  If unset, the HTTP rebuild is disabled; the 4h cron still refreshes the screener.
- For a hard backstop, add a Cloudflare WAF **Rate Limiting Rule** on `/v1/*` in the dashboard.

## Notes
- The vendored engine (`src/ivl.ts`, `src/binance.ts`) mirrors the reference engine in `../scripts/*.mjs`.
- Roadmap: a `GeckoTerminalSource` `PriceSource` to read the real on-chain Pancake v3 pool OHLCV.
