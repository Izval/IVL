import { API_BASE } from "./chain";
import { FEATURED } from "../../worker/src/featured.mjs";

export type PoolAnalysis = {
  pool: string;
  name: string;
  feeTier: number;
  baseToken: string;
  quoteToken: string;
  baseUsd?: number;
  quoteUsd?: number;
  tvlUsd: number;
  volume24hUsd: number;
  feeApr: number | null;
  price: number;
  ok: boolean;
  reason?: string;
  ivlScore?: number;
  classification?: string;
  ivlRaw?: number;
  components?: { dispersion: number; persistence: number; fractal: number };
  scalesConfirming?: string[];
  lvr?: { level: string; sigmaB: number; sigmaBNorm?: number; arb?: number; gamma?: number };
  channel?: { low: number; high: number; widthPct: number };
  action?: "concentrate" | "hold" | "withdraw_or_widen";
  rationale?: string;
  breakoutRisk?: string;
  /** Price of base token in quote token. */
  band?: { lower: number; upper: number; basis: string; vwap: number };
  updatedAt?: string;
  dex?: string;
  source?: {
    kind: "reference" | "native";
    symbol?: string;
    /** Human label of the reference market, e.g. "EUR/USDT on MEXC". */
    market?: string;
    /** Where the pool's own candles come from. */
    nativeData?: "arc-rpc" | "geckoterminal";
    liquidityFactor?: number;
    measuredFactor?: number | null;
    method?: "measured" | "tvl_prior";
    overlapHours?: number;
    candles15m?: number;
  };
  /** Hourly closes of the pool itself, last 7 days. */
  series?: [number, number][];
  historyDays?: number | null;
  compare?: Compare | null;
};

export type StrategyResult = {
  fees: number;
  il: number;
  rebalances: number;
  timeDeployed: number;
  timeInRange: number;
  net: number;
  curve: number[];
};

export type Compare = {
  scale: string;
  candles: number;
  fromTs: number;
  toTs: number;
  typicalWidthPct: number;
  withIvl: StrategyResult;
  fixed: StrategyResult;
  random: StrategyResult;
};

export type Screener = { updatedAt?: string; warming?: boolean; indexedBlock?: number; chainId?: number; dex?: string; pools: PoolAnalysis[] };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export const fetchScreener = () => get<Screener>("/v1/arc/pools");

/**
 * Pool detail: the Worker's cached analysis when it has a full one; otherwise the same engine runs
 * here in the browser (through the Worker's /v1/ref proxy for reference markets), on the visitor's own API quota.
 * Public data APIs rate-limit shared cloud egress hard, so this keeps "paste any pool" working.
 */
const CACHE_MS = 6 * 3600e3;
// Bump when the analysis changes, so visitors don't keep a result computed by older code.
const ANALYSIS_VERSION = 2;
const cacheKey = (a: string) => `ivl:pool:v${ANALYSIS_VERSION}:${a}`;
function cached(address: string): PoolAnalysis | null {
  try {
    const hit = JSON.parse(localStorage.getItem(cacheKey(address)) ?? "null");
    return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
  } catch {
    return null;
  }
}
function remember(address: string, data: PoolAnalysis) {
  try {
    if (data.ok && data.compare) localStorage.setItem(cacheKey(address), JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or blocked: the next visit recomputes */
  }
}

/** Featured pools ship a snapshot of their full analysis with the app (refreshed on every deploy). */
async function snapshot(address: string): Promise<PoolAnalysis | null> {
  if (!FEATURED.includes(address)) return null;
  try {
    const res = await fetch(`/featured/${address}.json`);
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const d = (await res.json()) as PoolAnalysis;
    return d.ok && d.compare ? d : null;
  } catch {
    return null;
  }
}

export async function fetchPool(address: string): Promise<PoolAnalysis> {
  const snap = await snapshot(address);
  if (snap) return snap;
  const hit = cached(address);
  if (hit) return hit;
  const full = await fetchPoolLive(address);
  remember(address, full);
  return full;
}

async function fetchPoolLive(address: string): Promise<PoolAnalysis> {
  let server: (PoolAnalysis & { partial?: boolean }) | null = null;
  try {
    server = await get<PoolAnalysis & { partial?: boolean }>(`/v1/arc/pool/${address}`);
  } catch {
    /* fall through to the browser */
  }
  if (server && ((!server.ok && server.reason !== "not_cached") || (server.ok && !server.partial))) return server;
  try {
    return await analyzeInBrowser(address);
  } catch (e) {
    if (server) return server;
    throw e;
  }
}

async function analyzeInBrowser(address: string): Promise<PoolAnalysis> {
  const [{ getPool, V3_DEX }, { analyzePool }, { setReferenceProxy }] = await Promise.all([
    import("../../worker/src/gecko.mjs"),
    import("../../worker/src/analyze.mjs"),
    import("../../worker/src/reference.mjs"),
  ]);
  setReferenceProxy(`${API_BASE || location.origin}/v1/ref`);
  const meta = await getPool(address);
  if (!meta) throw new Error("HTTP 404");
  if (meta.dex !== V3_DEX) return { pool: address, name: meta.name, ok: false, reason: "not_uniswap_v3", dex: meta.dex } as PoolAnalysis;
  return { ...(await analyzePool(meta, { detail: true })), updatedAt: new Date().toISOString() } as PoolAnalysis;
}
