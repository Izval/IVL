// IVL on Arc - read-only Cloudflare Worker.
//
// Serves the screener data for Uniswap v3 pools on Arc mainnet and the static app (../app/dist).
// It holds no keys, signs nothing and has no write endpoints: every transaction is built and signed
// in the user's own wallet by the app.
//
//   GET /v1/health
//   GET /v1/arc/pools          screener, precomputed by the cron into KV
//   GET /v1/ref?id&scale&limit reference-market candles (MEXC has no CORS; cached 15 min)
//   GET /v1/arc/pool/:address  cached IVL detail (band, source, price series, with/without-IVL
//                              comparison); the app computes uncached pools in the browser.

import { listV3Pools, V3_DEX } from "./gecko.mjs";
import { analyzePool } from "./analyze.mjs";
import { advanceIndex, ARC_RPCS, INDEX_KEY, indexedCandles } from "./arc-index.mjs";
import { getReferenceCandles, MARKETS } from "./reference.mjs";
import { FEATURED } from "./featured.mjs";

export { FEATURED };

const SCREENER_KEY = "screener:latest";
const LOCK_KEY = "screener:lock";
const POOLS_KEY = "pools:list";
const MAX_POOLS = 60;
const POOL_PAGES = 3; // GeckoTerminal lists 20 pools per page; Arc has ~60 v3 pools
const MIN_TVL_USD = 2000;
const DETAIL_TTL_SEC = 6 * 3600;
const RL_LIMIT = 60;
const RL_WINDOW_SEC = 60;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
      ...CORS,
    },
  });
}

// Per-IP limit through the Cache API (same pattern as api.zvlint.com).
async function underRateLimit(request, limit = RL_LIMIT, bucket = "rl") {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const origin = new URL(request.url).origin;
  const window = Math.floor(Date.now() / 1000 / RL_WINDOW_SEC);
  const key = new Request(`${origin}/__${bucket}/${encodeURIComponent(ip)}/${window}`);
  const hit = await caches.default.match(key);
  const count = (hit ? parseInt(await hit.text(), 10) || 0 : 0) + 1;
  if (count > limit) return false;
  await caches.default.put(key, new Response(String(count), { headers: { "Cache-Control": `max-age=${RL_WINDOW_SEC}` } }));
  return true;
}

/** Recompute the screener: top v3 pools by volume, one GeckoTerminal call per pool. */
export async function buildScreener(env, opts) {
  // One build at a time: overlapping builds would share GeckoTerminal's rate limit and both fail.
  if (await env.IVL_ARC_KV.get(LOCK_KEY)) return null;
  await env.IVL_ARC_KV.put(LOCK_KEY, "1", { expirationTtl: 300 });
  try {
    return await build(env, opts);
  } finally {
    await env.IVL_ARC_KV.delete(LOCK_KEY);
  }
}

async function build(env, opts = {}) {
  const previous = (await env.IVL_ARC_KV.get(SCREENER_KEY, "json"))?.pools ?? [];

  // Pool list (TVL, 24h volume, tokens) from GeckoTerminal; it rate-limits cloud egress, so keep the
  // last good list in KV and fall back to it.
  let pools;
  try {
    pools = (await listV3Pools(POOL_PAGES)).filter((p) => p.tvlUsd >= MIN_TVL_USD).slice(0, MAX_POOLS);
    await env.IVL_ARC_KV.put(POOLS_KEY, JSON.stringify(pools));
  } catch (e) {
    pools = (await env.IVL_ARC_KV.get(POOLS_KEY, "json")) ?? [];
    console.warn(`pool list: ${e.message ?? e}, using ${pools.length} cached`);
  }

  // Candles from Arc itself: advance the Swap-log index to the chain head.
  // A failing RPC must not sink the whole build: score on the index we already have.
  let index = await env.IVL_ARC_KV.get(INDEX_KEY, "json");
  try {
    index = await advanceIndex(index, pools, { maxCalls: opts.maxCalls ?? 3, fromBlock: opts.fromBlock, pauseMs: opts.pauseMs, log: opts.log });
    await env.IVL_ARC_KV.put(INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    console.warn(`index: ${e.message ?? e}, scoring on block ${index?.block}`);
  }
  if (!index) throw new Error("no Arc index yet");

  const rows = [];
  for (const p of pools) {
    try {
      const indexed = indexedCandles(index, p.address);
      if (!indexed) throw new Error("not enough indexed swaps yet");
      rows.push(await analyzePool(withIndexedVolume(p, indexed), { indexed }));
    } catch (e) {
      // Keep the last good score for this pool rather than dropping it from the list.
      const last = previous.find((r) => r.pool === p.address && r.ok);
      rows.push(last ?? { pool: p.address, name: p.name, feeTier: p.feeTier, ok: false, reason: "pending" });
      console.warn(`screener: ${p.name} ${e.message ?? e}`);
    }
  }
  rows.sort((a, b) => (b.ivlScore ?? -1) - (a.ivlScore ?? -1));
  const out = { chainId: 5042, dex: V3_DEX, updatedAt: new Date().toISOString(), indexedBlock: index.block, pools: rows };
  await env.IVL_ARC_KV.put(SCREENER_KEY, JSON.stringify(out));

  for (const address of FEATURED) await refreshDetail(env, address, pools, index);
  return out;
}

/** Full detail (price series + one-year replay) for a featured pool, from the stored Arc index. */
async function refreshDetail(env, address, pools, index) {
  pools ??= (await env.IVL_ARC_KV.get(POOLS_KEY, "json")) ?? [];
  index ??= await env.IVL_ARC_KV.get(INDEX_KEY, "json");
  const meta = pools.find((p) => p.address === address);
  const indexed = index && indexedCandles(index, address);
  if (!meta || !indexed) return;
  try {
    await storeDetail(env, address, await analyzePool(withIndexedVolume(meta, indexed), { detail: true, indexed }));
  } catch (e) {
    console.warn(`detail: ${meta.name} ${e.message ?? e}`);
  }
}

/** 24h volume measured on Arc (sum of the last 96 fifteen-minute candles, priced in USD). */
function withIndexedVolume(pool, indexed) {
  const quoteVol = indexed.c15.slice(-96).reduce((a, c) => a + c.vol, 0);
  const usd = Number.isFinite(pool.quoteUsd) ? pool.quoteUsd : 1;
  return { ...pool, volume24hUsd: quoteVol * usd };
}

const storeDetail = (env, address, r) =>
  env.IVL_ARC_KV.put(`detail:${address}`, JSON.stringify({ ...r, updatedAt: new Date().toISOString() }), {
    expirationTtl: DETAIL_TTL_SEC,
  });

/**
 * Cached detail only. Public data APIs rate-limit shared cloud egress, so pools that are not
 * precomputed are analyzed by the app in the visitor's browser (same engine, same modules).
 */
async function poolDetail(env, address) {
  const cached = await env.IVL_ARC_KV.get(`detail:${address}`, "json");
  if (cached) return cached;
  const row = (await env.IVL_ARC_KV.get(SCREENER_KEY, "json"))?.pools?.find((p) => p.pool === address);
  if (row?.ok) return { ...row, partial: true };
  return { pool: address, ok: false, reason: "not_cached" };
}

/**
 * Hashed build files. Right after a deploy the new index.html can ask for a file this edge doesn't
 * have yet; the SPA fallback would answer with index.html, and a browser could cache that HTML under
 * an immutable script URL (a blank page until the cache is cleared). A real, uncached 404 instead.
 */
async function assetOr404(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (res.ok && !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

// Read-only JSON-RPC relay to Arc for the app. Some visitors' browsers cannot reach Arc's public
// RPCs directly (network filters, extensions); same-origin through the Worker always works. Only
// read methods pass: transactions are sent by the user's wallet through its own RPC.
const RPC_READ = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getBlockByNumber",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "net_version",
]);
const RPC_CACHEABLE = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "net_version"]);
const RPC_CACHE_SEC = 10;
const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const RPC_LIMIT = 600; // requests per IP per minute; viem batches a page's reads into a few requests
const RPC_MAX_BODY = 64 * 1024;
const RPC_MAX_BATCH = 50;

async function relayRpc(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await underRateLimit(request, RPC_LIMIT, "rpc"))) return json({ error: "rate_limited" }, 429);
  const body = await request.text();
  if (body.length > RPC_MAX_BODY) return json({ error: "too_large" }, 413);
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const calls = Array.isArray(msg) ? msg : [msg];
  if (!calls.length || calls.length > RPC_MAX_BATCH || !calls.every((c) => RPC_READ.has(c?.method))) {
    return json({ error: "method_not_allowed" }, 403);
  }
  // Arc's RPCs rate-limit items inside a batch (-32005): those items are retried on the next
  // endpoint, so one throttled upstream doesn't break the page.
  const limited = (r) => r?.error && (r.error.code === -32005 || /rate limit/i.test(r.error.message ?? ""));
  const byId = new Map();
  let pending = calls;
  // Same reads from every visitor of a pool page: serve them from the edge for a few seconds. The
  // key drops the JSON-RPC ids (they differ per client), which are mapped back on the way out.
  const cacheable = calls.every((c) => RPC_CACHEABLE.has(c.method));
  const cacheKey = cacheable
    ? new Request(`${new URL(request.url).origin}/__rpc/${await sha256(JSON.stringify(calls.map((c) => [c.method, c.params])))}`)
    : null;
  if (cacheKey) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      const out = calls.map((c, i) => ({ ...cached[i], id: c.id }));
      return json(Array.isArray(msg) ? out : out[0]);
    }
  }
  let last = null;
  for (const rpcUrl of [...ARC_RPCS, ...ARC_RPCS]) {
    if (byId.size) await new Promise((r) => setTimeout(r, 600)); // second round: back off first
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Array.isArray(msg) ? pending : pending[0]),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        continue;
      }
      const out = await res.json();
      for (const r of Array.isArray(out) ? out : [out]) if (!limited(r) || !byId.has(r.id)) byId.set(r.id, r);
      pending = pending.filter((c) => !byId.has(c.id) || limited(byId.get(c.id)));
      if (!pending.length) break;
    } catch (e) {
      last = String(e.message ?? e);
    }
  }
  if (!byId.size) return json({ error: "upstream_error", detail: last }, 502);
  const results = calls.map((c) => byId.get(c.id) ?? { jsonrpc: "2.0", id: c.id, error: { code: -32005, message: "rate limit exceeded" } });
  if (cacheKey && results.every((r) => !r.error)) {
    await caches.default.put(cacheKey, new Response(JSON.stringify(results), { headers: { "Cache-Control": `max-age=${RPC_CACHE_SEC}` } }));
  }
  return json(Array.isArray(msg) ? results : results[0]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname.startsWith("/assets/")) return assetOr404(request, env);
    if (!url.pathname.startsWith("/v1/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/v1/rpc") return relayRpc(request);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!(await underRateLimit(request))) return json({ error: "rate_limited" }, 429);

    try {
      if (url.pathname === "/v1/health") return json({ ok: true, chainId: 5042, service: "ivl-arc" });

      if (url.pathname === "/v1/arc/pools") {
        const data = await env.IVL_ARC_KV.get(SCREENER_KEY, "json");
        if (data) return json(data, 200, 120);
        // First run before the cron fires: build in the background, tell the client to retry.
        ctx.waitUntil(buildScreener(env));
        return json({ chainId: 5042, dex: V3_DEX, warming: true, pools: [] }, 200);
      }

      if (url.pathname === "/v1/ref") {
        const id = url.searchParams.get("id");
        const scale = url.searchParams.get("scale");
        const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
        if (!MARKETS[id] || !["15m", "1h", "4h", "1d"].includes(scale)) return json({ error: "bad_params" }, 400);
        const key = new Request(`${url.origin}/__ref/${id}/${scale}/${limit}`);
        const hit = await caches.default.match(key);
        if (hit) return new Response(hit.body, hit);
        const res = json(await getReferenceCandles(id, scale, limit), 200, 900);
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }

      const m = url.pathname.match(/^\/v1\/arc\/pool\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const address = m[1].toLowerCase();
        if (!ADDR_RE.test(address)) return json({ error: "bad_address" }, 400);
        const r = await poolDetail(env, address);
        return r ? json(r, 200, 60) : json({ error: "pool_not_found" }, 404);
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "upstream_error", detail: String(e.message ?? e) }, 502);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(buildScreener(env));
  },
};
