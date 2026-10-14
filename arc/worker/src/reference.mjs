// reference.mjs - Longer, cleaner history for young Arc pools, adjusted for the pool's liquidity.
//
// Arc mainnet launched in September 2026, so its pools have weeks of thin, gappy trade history.
// When the pool's asset has a deep reference market (EURC -> EUR/USDC, cirBTC -> BTC/USDC, ...),
// IVL reads the reference market's candles instead, re-anchored to the pool's own price and with
// their deviations scaled by a liquidity factor k >= 1: a thin pool swings more than the deep
// market it tracks, so its band must be wider. k is measured, then shrunk toward 1 and capped, so
// the adjustment stays realistic rather than dramatic.
//
// IVL_raw = σ² / (R − S)² is scale-invariant, so k does not move the score itself: it widens the
// band (μ ± 2σ) and raises the intrablock volatility the LVR estimate sees, which is the honest
// effect of thinner liquidity.

// MEXC public klines: no key, and reachable from Cloudflare Workers (Binance and GeckoTerminal block
// or rate-limit cloud egress). Same source as api.zvlint.com.
const MEXC = "https://api.mexc.com";
const PAGE = 500; // MEXC returns at most 500 klines per call

const USD_QUOTES = new Set([
  "0x3600000000000000000000000000000000000000", // USDC (Arc native)
  "0x9696b5e894afe749b3d4683b230e549f39678932", // USDB
]);

// Arc token -> reference id. The id is stable for the app; MARKETS says where it is read from.
const REFERENCE = {
  "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1": "EURUSDC", // EURC
  "0x171a4217b86a807a64eb94757db6849fb4bdbaa0": "BTCUSDC", // cirBTC
  "0x30ed6a37665c50f799125923185b0fc171d36f0c": "BTCUSDC", // BTC
  "0x128cc466b61f542da60c70e3aa11c10e19b84edb": "ETHUSDC", // WETH
  "0x178b01f61cbea1d2a5581fe1621be607835ec349": "PAXGUSDT", // XAUM (tokenized gold)
};

export const MARKETS = {
  EURUSDC: { venue: "MEXC", symbol: "EURUSDT", label: "EUR/USDT on MEXC" },
  BTCUSDC: { venue: "MEXC", symbol: "BTCUSDC", label: "BTC/USDC on MEXC" },
  ETHUSDC: { venue: "MEXC", symbol: "ETHUSDC", label: "ETH/USDC on MEXC" },
  PAXGUSDT: { venue: "MEXC", symbol: "GOLD(PAXG)USDT", label: "PAXG/USDT (gold) on MEXC" },
};

// Max lateral-block width δ by asset class (README §2: 0.01–0.05 for stables, up to ~0.20 for volatile).
const DELTA_BY_REF = { EURUSDC: 0.03, PAXGUSDT: 0.08, BTCUSDC: 0.16, ETHUSDC: 0.16 };
export const deltaFor = (symbol) => DELTA_BY_REF[symbol] ?? 0.16;

export const SHRINK = 0.5; // keep half of the measured excess volatility
export const K_MAX = 1.75;

/** Binance symbol that tracks this pool, or null when the pool has no deep reference. */
export function referenceFor(pool) {
  if (!USD_QUOTES.has(pool.quoteToken)) return null;
  return REFERENCE[pool.baseToken] ?? null;
}

const INTERVAL = { "15m": "15m", "1h": "60m", "4h": "4h", "1d": "1d" };
const STEP_MS = { "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 864e5 };

// In the browser MEXC is not reachable (no CORS): the app points this at the Worker's /v1/ref.
let proxy = null;
export const setReferenceProxy = (url) => void (proxy = url);

// Several pools share a reference (EURC and cirBTC trade in more than one fee tier): one cron run
// fetches each market once instead of once per pool, which keeps the run under the subrequest cap.
const MEMO_MS = 10 * 60e3;
const memo = new Map();

/** Oldest-first candles for a reference id, paging back past MEXC's 500-candle limit. */
export function getReferenceCandles(ref, scale, limit) {
  const key = `${ref}/${scale}/${limit}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.p;
  const p = fetchReferenceCandles(ref, scale, limit);
  memo.set(key, { at: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}

async function fetchReferenceCandles(ref, scale, limit) {
  if (proxy) {
    const res = await fetch(`${proxy}?id=${encodeURIComponent(ref)}&scale=${scale}&limit=${limit}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`reference ${ref} ${scale} -> HTTP ${res.status}`);
    return res.json();
  }
  const market = MARKETS[ref]?.symbol ?? ref;
  let end = null;
  let out = [];
  while (out.length < limit) {
    const n = Math.min(PAGE, limit - out.length);
    // MEXC ignores endTime unless startTime is also given (it returns the latest candles instead).
    const win = end ? `&startTime=${end - n * STEP_MS[scale]}&endTime=${end}` : "";
    const url = `${MEXC}/api/v3/klines?symbol=${encodeURIComponent(market)}&interval=${INTERVAL[scale]}&limit=${n}${win}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`MEXC ${market} ${scale} -> HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    const page = rows.map((r) => ({ ts: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], vol: +r[5] }));
    const older = page.filter((c) => !out.length || c.ts < out[0].ts);
    if (!older.length) break; // no progress: never loop on the same page
    out = [...older, ...out];
    if (rows.length < n) break;
    end = page[0].ts - STEP_MS[scale];
  }
  return out.slice(-limit);
}

function logReturnsByTs(candles) {
  const m = new Map();
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > 0 && candles[i - 1].c > 0) m.set(candles[i].ts, Math.log(candles[i].c / candles[i - 1].c));
  }
  return m;
}

const std = (xs) => {
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
};

/**
 * Liquidity factor from the overlap of pool and reference hourly candles.
 * k_obs = σ(pool returns) / σ(reference returns) on the same hours; k = 1 + SHRINK·(k_obs − 1),
 * clamped to [1, K_MAX]. Without enough overlap, falls back to a mild TVL-based prior.
 */
export function liquidityFactor(poolHourly, refHourly, tvlUsd) {
  const p = logReturnsByTs(poolHourly);
  const r = logReturnsByTs(refHourly);
  const pr = [];
  const rr = [];
  for (const [ts, x] of p) {
    if (r.has(ts)) {
      pr.push(x);
      rr.push(r.get(ts));
    }
  }
  if (pr.length >= 48 && std(rr) > 0) {
    const kObs = std(pr) / std(rr);
    return { k: clamp(1 + SHRINK * (kObs - 1), 1, K_MAX), kObs, method: "measured", overlapHours: pr.length };
  }
  const prior = 1 + 0.1 * Math.log10(5e6 / Math.max(tvlUsd || 1, 1));
  return { k: clamp(prior, 1, 1.5), kObs: null, method: "tvl_prior", overlapHours: pr.length };
}

export function vwap(candles) {
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    pv += c.c * (c.vol || 1);
    v += c.vol || 1;
  }
  return pv / v;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Re-anchor reference candles to the pool's price level and scale their log-deviations from the
 * window's VWAP by k: P' = basis · m · exp(k · ln(P / m)).
 */
export function adjustCandles(candles, k, basis, m = vwap(candles)) {
  const f = (x) => basis * m * Math.exp(k * Math.log(x / m));
  return candles.map((c) => ({ ts: c.ts, o: f(c.o), h: f(c.h), l: f(c.l), c: f(c.c), vol: c.vol }));
}

/**
 * Same adjustment for a long series: each candle's deviation is measured from the trailing
 * `win`-candle VWAP, so k scales local swings without amplifying the multi-week trend.
 */
export function adjustRolling(candles, k, basis, win = 168) {
  let pv = 0;
  let v = 0;
  return candles.map((c, i) => {
    const w = c.vol || 1;
    pv += c.c * w;
    v += w;
    if (i >= win) {
      const o = candles[i - win];
      pv -= o.c * (o.vol || 1);
      v -= o.vol || 1;
    }
    const m = pv / v;
    const f = (x) => basis * m * Math.exp(k * Math.log(x / m));
    return { ts: c.ts, o: f(c.o), h: f(c.h), l: f(c.l), c: f(c.c), vol: c.vol };
  });
}
