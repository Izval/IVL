// index.ts — IVL public API (Cloudflare Worker, api.zvlint.com).
//
// Reusa el motor IVL (./ivl + ./binance, snapshot del motor de referencia) vía el mismo
// `computeIvlResponse`. Endpoints:
//   GET /v1/health
//   GET /v1/ivl?pair=BNB-USDT&lookback=120&scales=15m,1h,4h,1d&equity=10000
//   GET /v1/ivl/ticks?pair=...        -> tickLower/tickUpper desplegables en Pancake v3
//   GET /v1/screener?minScore=60&class=good&action=concentrate&limit=50
//   GET /v1/screener/rebuild          -> recomputa el screener (también corre por cron cada 4h)

import { computeIvlResponse, DEFAULT_SCALES } from "./ivl";
import { binanceSource } from "./binance";
import { rangeToTicks } from "./ticks";
import { SCREENER_PAIRS } from "./pairs";

export interface Env {
  IVL_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
  // Secret que protege /v1/screener/rebuild (endpoint pesado). Si está vacío, rebuild HTTP queda
  // deshabilitado (el cron sigue refrescando cada 4h). Set: `wrangler secret put REBUILD_SECRET`.
  REBUILD_SECRET?: string;
}

// Rate limit por IP (ventana fija) vía Cache API: gratis, por-colo, sin coste de KV. Best-effort
// (puede dejar pasar ráfagas concurrentes), suficiente para frenar abuso sostenido de una IP.
const RL_LIMIT = 100;
const RL_WINDOW_SEC = 60;

async function underRateLimit(request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const origin = new URL(request.url).origin; // mismo origen (requisito del Cache API)
  const window = Math.floor(Date.now() / 1000 / RL_WINDOW_SEC);
  const key = new Request(`${origin}/__rl/${encodeURIComponent(ip)}/${window}`);
  const cache = caches.default;
  let count = 0;
  const hit = await cache.match(key);
  if (hit) count = parseInt(await hit.text(), 10) || 0;
  count++;
  if (count > RL_LIMIT) return false;
  await cache.put(
    key,
    new Response(String(count), { headers: { "Cache-Control": `max-age=${RL_WINDOW_SEC}` } })
  );
  return true;
}

const SCREENER_KEY = "screener:latest";

interface LpRange {
  lower: number;
  upper: number;
  vwap: number;
  sigma: number;
  pool_fee_tier: number;
}

interface ScreenerRow {
  pair: string;
  ivl_score: number;
  classification: string;
  action: string;
  breakout_risk: string;
  lp_lower: number;
  lp_upper: number;
}

interface ScreenerSnapshot {
  generated_at: string;
  count: number;
  rows: ScreenerRow[];
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data: unknown, env: Env, status = 200, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(env),
  };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(data), { status, headers });
}

function parseScales(raw: string | null): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_SCALES];
}

/** Recalcula el screener sobre el universo curado y lo guarda en KV. */
async function rebuildScreener(env: Env): Promise<ScreenerSnapshot> {
  const rows: ScreenerRow[] = [];
  const concurrency = 5;
  for (let i = 0; i < SCREENER_PAIRS.length; i += concurrency) {
    const chunk = SCREENER_PAIRS.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map((pair) => computeIvlResponse(binanceSource, { pair }))
    );
    settled.forEach((s, j) => {
      if (s.status !== "fulfilled" || !s.value.ok) return;
      const d = s.value.data as Record<string, unknown>;
      const lp = d.lp_range as LpRange;
      const decision = d.decision as { action: string; breakoutRisk: string };
      rows.push({
        pair: chunk[j],
        ivl_score: d.ivl_score as number,
        classification: d.classification as string,
        action: decision.action,
        breakout_risk: decision.breakoutRisk,
        lp_lower: lp.lower,
        lp_upper: lp.upper,
      });
    });
  }
  rows.sort((a, b) => b.ivl_score - a.ivl_score);
  const snapshot: ScreenerSnapshot = {
    generated_at: new Date().toISOString(),
    count: rows.length,
    rows,
  };
  await env.IVL_KV.put(SCREENER_KEY, JSON.stringify(snapshot));
  return snapshot;
}

async function handleScreener(url: URL, env: Env): Promise<Response> {
  const raw = await env.IVL_KV.get(SCREENER_KEY);
  if (!raw) {
    return json(
      { error: "Screener aún no computado. Espera al cron (4h) o llama /v1/screener/rebuild." },
      env,
      503
    );
  }
  const snap = JSON.parse(raw) as ScreenerSnapshot;
  const minScore = parseInt(url.searchParams.get("minScore") || "0");
  const klass = url.searchParams.get("class");
  const action = url.searchParams.get("action");
  const limit = parseInt(url.searchParams.get("limit") || "100");
  let rows = snap.rows.filter((r) => r.ivl_score >= minScore);
  if (klass) rows = rows.filter((r) => r.classification === klass);
  if (action) rows = rows.filter((r) => r.action === action);
  return json(
    { generated_at: snap.generated_at, count: rows.length, rows: rows.slice(0, limit) },
    env,
    200,
    60
  );
}

async function handleIvl(url: URL, env: Env, withTicks: boolean): Promise<Response> {
  const result = await computeIvlResponse(binanceSource, {
    pair: url.searchParams.get("pair") || "BNB-USDT",
    lookback: parseInt(url.searchParams.get("lookback") || "120"),
    equity: parseFloat(url.searchParams.get("equity") || "10000"),
    scales: parseScales(url.searchParams.get("scales")),
  });
  if (!result.ok) return json({ error: result.error }, env, result.status);

  const lp = result.data.lp_range as LpRange;
  const ticks = rangeToTicks(lp.lower, lp.upper, lp.pool_fee_tier);

  // Respuesta completa: mismo payload del motor + ticks desplegables de Pancake v3.
  if (!withTicks) return json({ ...result.data, lp_ticks: ticks }, env, 200, 60);

  // Respuesta recortada centrada en ticks.
  return json(
    {
      pair: result.data.pair,
      ivl_score: result.data.ivl_score,
      classification: result.data.classification,
      decision: result.data.decision,
      lp_range: lp,
      ticks,
    },
    env,
    200,
    60
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "GET") {
      return json({ error: "Solo GET" }, env, 405);
    }

    // Rate limit por IP (excepto health). Protege contra abuso/DoS; sin coste de KV.
    if (url.pathname !== "/v1/health" && !(await underRateLimit(request))) {
      return json({ error: "Rate limit excedido. Reintenta en un momento." }, env, 429);
    }

    try {
      switch (url.pathname) {
        case "/v1/health":
          return json({ ok: true, service: "ivl-api", ts: new Date().toISOString() }, env);

        case "/v1/ivl":
          return await handleIvl(url, env, false);

        case "/v1/ivl/ticks":
          return await handleIvl(url, env, true);

        case "/v1/screener":
          return await handleScreener(url, env);

        case "/v1/screener/rebuild": {
          // Endpoint pesado: requiere el secret. El cron (scheduled) lo llama directo, sin este guard.
          if (!env.REBUILD_SECRET) {
            return json({ error: "rebuild deshabilitado (sin secret configurado)" }, env, 403);
          }
          if (url.searchParams.get("key") !== env.REBUILD_SECRET) {
            return json({ error: "no autorizado" }, env, 401);
          }
          const snap = await rebuildScreener(env);
          return json({ rebuilt: true, count: snap.count, generated_at: snap.generated_at }, env);
        }

        default:
          return json(
            {
              error: "Not found",
              endpoints: ["/v1/health", "/v1/ivl", "/v1/ivl/ticks", "/v1/screener"],
            },
            env,
            404
          );
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Error interno" }, env, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(rebuildScreener(env));
  },
};
