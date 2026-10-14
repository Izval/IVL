// analyze.mjs - Runs the IVL engine (../../scripts) over an Arc Uniswap v3 pool.
//
// The engine is reused untouched: same scales, same horizon matching, same decision rule. What is
// Arc-specific is the data: the pool's own candles (gecko.mjs) or, when the pool's asset has a deep
// reference market, that market's candles adjusted to the pool's price and liquidity (reference.mjs).

import { atr, computeIVL, horizonLookbacks } from "../../../scripts/ivl-core.mjs";
import { decideLP } from "../../../scripts/ivl-strategy.mjs";
import { aggregate, getPoolCandles, getPoolMultiScale } from "./gecko.mjs";
import { adjustCandles, adjustRolling, deltaFor, getReferenceCandles, liquidityFactor, MARKETS, referenceFor, vwap } from "./reference.mjs";
import { compareWithWithout } from "./compare.mjs";

// 7 days on the 15m primary scale -> 1h:168, 4h:42, 1d:7 (same wall-clock horizon per scale).
export const SCALES = ["15m", "1h", "4h", "1d"];
export const PRIMARY_LOOKBACK = 672;

const round = (x, d = 6) => (Number.isFinite(x) ? +x.toPrecision(d) : null);

/** Pool-wide fee APR from the last 24h: volume * fee / TVL, annualized. */
export function poolFeeApr(pool) {
  if (!(pool.tvlUsd > 0) || !(pool.feeTier > 0)) return null;
  return round(((pool.volume24hUsd * pool.feeTier) / pool.tvlUsd) * 365, 4);
}

/**
 * Thin-pool wick filter: on a young DEX pool a single tiny swap prints a wick far from where price
 * actually trades, and IVL's channel (min low .. max high) would be set by that print. Using the
 * candle body keeps the channel on executed flow; volume and closes are untouched.
 */
export const bodyOnly = (candles) =>
  candles.map((c) => ({ ...c, h: Math.max(c.o, c.c), l: Math.min(c.o, c.c) }));

const byScaleFrom15m = (c15, limits) => {
  const out = { "15m": c15.slice(-limits["15m"]) };
  for (const s of SCALES.slice(1)) if (limits[s]) out[s] = aggregate(c15, s).slice(-limits[s]);
  return out;
};

/** Pure: IVL result for a pool given its candles (already cleaned/adjusted). */
export function analyzeCandles(pool, candlesByScale, price) {
  const ivl = computeIVL(candlesByScale, { primaryScale: SCALES[0], gamma: pool.feeTier ?? 0.0005 });
  const primary = candlesByScale[SCALES[0]] ?? [];
  const base = {
    pool: pool.address,
    name: pool.name,
    feeTier: pool.feeTier,
    baseToken: pool.baseToken,
    quoteToken: pool.quoteToken,
    baseUsd: pool.baseUsd,
    quoteUsd: pool.quoteUsd,
    tvlUsd: pool.tvlUsd,
    volume24hUsd: pool.volume24hUsd,
    feeApr: poolFeeApr(pool),
    price: round(price ?? primary.at(-1)?.c ?? pool.priceQuote),
  };
  if (!ivl.ok) return { ...base, ok: false, reason: ivl.reason };

  const decision = decideLP(ivl, { candlesPrimary: primary });
  // decideLP's "hold" band reuses the observed channel; normalize every action to {lower, upper}.
  let lower = decision.lpRange.lower ?? ivl.range.low;
  let upper = decision.lpRange.upper ?? decision.lpRange.high ?? ivl.range.high;
  if (decision.action === "withdraw_or_widen") {
    // The engine widens to VWAP ± 2.5·ATR14 of the primary scale. On Arc that scale is 15m, so the
    // ATR is one quarter-hour's range and the "wide" band came out narrower than the 7-day channel.
    // An LP band has to hold for days: take ATR14 on 4h candles, and never go inside the channel.
    const a4h = atr(candlesByScale["4h"] ?? [], 14);
    const mid = ivl.lpRange.vwap;
    lower = Math.min(ivl.range.low, mid - 2.5 * a4h);
    upper = Math.max(ivl.range.high, mid + 2.5 * a4h);
    decision.lpRange.basis = "vwap_2_5_atr14_4h";
  }

  return {
    ...base,
    ok: true,
    ivlScore: ivl.ivlScore,
    classification: ivl.classification,
    ivlRaw: round(ivl.ivl.raw_primary, 4),
    components: {
      dispersion: round(ivl.ivl.dispersion, 4),
      persistence: round(ivl.ivl.persistence, 4),
      fractal: round(ivl.ivl.fractal, 4),
    },
    scalesConfirming: ivl.scalesConfirming,
    lvr: ivl.lvr,
    channel: { low: round(ivl.range.low), high: round(ivl.range.high), widthPct: round(ivl.range.widthPct, 4) },
    action: decision.action,
    rationale: decision.rationale,
    breakoutRisk: decision.breakoutRisk,
    // Band in price of base token denominated in quote token (GeckoTerminal orientation).
    band: { lower: round(Math.max(lower, 0)), upper: round(upper), basis: decision.lpRange.basis, vwap: round(ivl.lpRange.vwap) },
  };
}

/**
 * Fetch candles and analyze one pool.
 * `detail` adds the hourly price series for charts and the with/without-IVL comparison.
 */
export async function analyzePool(pool, { detail = false, indexed = null } = {}) {
  const limits = horizonLookbacks(SCALES[0], PRIMARY_LOOKBACK, SCALES);
  // Native candles: from the Arc Swap-log index when the caller has it, else GeckoTerminal.
  const native = indexed ? byScaleFrom15m(indexed.c15, limits) : await getPoolMultiScale(pool.address, limits);
  const nativeHourly = native["1h"];
  const price = native["15m"].at(-1)?.c;
  const symbol = referenceFor(pool);

  let result;
  let source;
  if (symbol) {
    const [ref15, ref1h, ref1d] = await Promise.all([
      getReferenceCandles(symbol, "15m", limits["15m"]),
      getReferenceCandles(symbol, "1h", 200),
      detail ? getReferenceCandles(symbol, "1d", 365) : null,
    ]);
    const lf = liquidityFactor(nativeHourly, ref1h, pool.tvlUsd);
    const basis = price / ref15.at(-1).c;
    const adjusted = adjustCandles(ref15, lf.k, basis, vwap(ref15));
    result = analyzeCandles(pool, byScaleFrom15m(adjusted, limits), price);
    source = {
      kind: "reference",
      symbol,
      market: MARKETS[symbol]?.label,
      nativeData: indexed ? "arc-rpc" : "geckoterminal",
      liquidityFactor: round(lf.k, 3),
      measuredFactor: round(lf.kObs, 3),
      method: lf.method,
      overlapHours: lf.overlapHours,
      basis: round(basis, 6),
    };
    if (detail) {
      // One year of daily history, adjusted the same way (deviations from a trailing 30-day VWAP).
      result.compare = compareWithWithout(adjustRolling(ref1d, lf.k, basis, 30), { scale: "1d", delta: deltaFor(symbol) });
      result.historyDays = ref1d.length;
    }
  } else {
    result = analyzeCandles(pool, Object.fromEntries(Object.entries(native).map(([s, c]) => [s, bodyOnly(c)])), price);
    source = { kind: "native", candles15m: native["15m"].length, nativeData: indexed ? "arc-rpc" : "geckoterminal" };
    if (detail) {
      // Native history only: the pool's whole life on 4h candles.
      const c4h = indexed ? indexed.c4h : await getPoolCandles(pool.address, "4h", 1000).catch(() => null);
      result.compare = c4h ? compareWithWithout(bodyOnly(c4h), { scale: "4h" }) : null;
      result.historyDays = c4h ? Math.round((c4h.at(-1).ts - c4h[0].ts) / 864e5) : null;
    }
  }
  result.source = source;
  if (detail) {
    result.series = nativeHourly.map((c) => [c.ts, round(c.c)]);
  }
  return result;
}
