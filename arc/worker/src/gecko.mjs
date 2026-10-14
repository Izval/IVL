// gecko.mjs - Arc mainnet candle source for IVL, backed by the public GeckoTerminal API.
//
// Arc (chainId 5042) has no official Uniswap subgraph and the public RPC caps eth_getLogs at 10k
// blocks, so pool history comes from GeckoTerminal, which indexes the Uniswap v3 pools on Arc.
// Output matches the IVL engine's candle format: {ts (ms), o, h, l, c, vol}, oldest first.

const BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "arc";
export const V3_DEX = "uniswap-v3-arc";

// IVL scale -> GeckoTerminal OHLCV path.
const TF_PATH = {
  "15m": "minute?aggregate=15",
  "1h": "hour?aggregate=1",
  "4h": "hour?aggregate=4",
  "1d": "day?aggregate=1",
};

// The free API allows ~30 calls/min: back off and retry on 429.
async function gecko(path, retries = 3) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.json();
    if (res.status !== 429 || i >= retries) throw new Error(`GeckoTerminal ${path} -> HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2500 * 2 ** i));
  }
}

const tokenAddr = (rel) => rel?.data?.id?.split("_")[1]?.toLowerCase() ?? null;

function toPool(p) {
  const a = p.attributes;
  const feeMatch = a.name.match(/([\d.]+)%\s*$/);
  return {
    address: a.address.toLowerCase(),
    name: a.name.replace(/\s+[\d.]+%\s*$/, ""),
    feeTier: feeMatch ? parseFloat(feeMatch[1]) / 100 : null, // fraction, e.g. 0.0005
    baseToken: tokenAddr(p.relationships?.base_token),
    quoteToken: tokenAddr(p.relationships?.quote_token),
    priceQuote: parseFloat(a.base_token_price_quote_token),
    baseUsd: parseFloat(a.base_token_price_usd),
    quoteUsd: parseFloat(a.quote_token_price_usd),
    tvlUsd: parseFloat(a.reserve_in_usd),
    volume24hUsd: parseFloat(a.volume_usd?.h24 ?? 0),
    createdAt: a.pool_created_at,
    dex: p.relationships?.dex?.data?.id ?? null,
  };
}

/**
 * Top Uniswap v3 pools on Arc, sorted by 24h volume. GeckoTerminal returns 20 per page; a later
 * page that fails (rate limit) keeps the pages already read rather than losing the whole list.
 */
export async function listV3Pools(pages = 1) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    let d;
    try {
      d = await gecko(`/networks/${NETWORK}/dexes/${V3_DEX}/pools?page=${page}&sort=h24_volume_usd_desc`);
    } catch (e) {
      if (page === 1) throw e;
      console.warn(`pool list page ${page}: ${e.message ?? e}`);
      break;
    }
    const rows = (d.data ?? []).map(toPool);
    out.push(...rows);
    if (rows.length < 20) break;
  }
  return out;
}

/** Metadata for one pool (any DEX on Arc). */
export async function getPool(address) {
  const d = await gecko(`/networks/${NETWORK}/pools/${address}`);
  return d.data ? toPool(d.data) : null;
}

/** Candles for one pool and scale, price of base in quote token, oldest first. */
export async function getPoolCandles(pool, scale, limit) {
  const path = TF_PATH[scale];
  if (!path) throw new Error(`unsupported scale ${scale}`);
  const d = await gecko(
    `/networks/${NETWORK}/pools/${pool}/ohlcv/${path}&limit=${Math.min(limit, 1000)}&currency=token`
  );
  const rows = d.data?.attributes?.ohlcv_list ?? [];
  return rows
    .map(([t, o, h, l, c, v]) => ({ ts: t * 1000, o, h, l, c, vol: v }))
    .sort((a, b) => a.ts - b.ts);
}

const TF_MS = { "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };

/** Aggregate oldest-first candles into a coarser timeframe (buckets aligned to UTC). */
export function aggregate(candles, scale) {
  const ms = TF_MS[scale];
  const out = [];
  for (const c of candles) {
    const t = Math.floor(c.ts / ms) * ms;
    const b = out[out.length - 1];
    if (b && b.ts === t) {
      b.h = Math.max(b.h, c.h);
      b.l = Math.min(b.l, c.l);
      b.c = c.c;
      b.vol += c.vol;
    } else out.push({ ts: t, o: c.o, h: c.h, l: c.l, c: c.c, vol: c.vol });
  }
  return out;
}

/**
 * Candles for several scales; `limits` maps scale -> candle count. One API call: the finest scale
 * is fetched and the coarser ones are aggregated from it, which keeps the screener under the
 * GeckoTerminal rate limit and guarantees every scale covers the same window.
 */
export async function getPoolMultiScale(pool, limits) {
  const scales = Object.keys(limits).sort((a, b) => TF_MS[a] - TF_MS[b]);
  const fine = scales[0];
  const fineCandles = await getPoolCandles(pool, fine, limits[fine]);
  const out = { [fine]: fineCandles };
  for (const s of scales.slice(1)) out[s] = aggregate(fineCandles, s).slice(-limits[s]);
  return out;
}
