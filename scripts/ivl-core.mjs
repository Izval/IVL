// ivl-core.mjs - Core of the IVL metric (Internal Variance of Lateralization)
//
// IVL quantifies the QUALITY and STABILITY of a price lateralization for
// concentrated liquidity provision (PancakeSwap v3 / BNB Chain).
//
// Fractality is INTRINSIC to IVL: the score integrates three inseparable
// components into a single number:
//   1. Internal dispersion   - volume-weighted variance relative to the VWAP.
//   2. Temporal persistence  - fraction of the period the price stays in range.
//   3. Fractal consistency   - how many scales (15m/1h/4h/1d) confirm the same range.
//
// Polarity convention (canonical): HIGH IVL = GOOD.
//   - End-to-end oscillation within the channel -> IVL_raw -> ~0.25 (healthy, generates fees).
//   - Asymmetric compression against an edge     -> IVL_raw -> ~0.01 (breakout risk).
//
// No external dependencies: runnable with `node`.

// Maximum theoretical variance of a distribution bounded in [S,R] (bimodal at the extremes):
// Var_max = ((R-S)/2)^2  =>  IVL_raw_max = Var_max / (R-S)^2 = 0.25
export const IVL_RAW_MAX = 0.25;

// "Excellent" reference for normalizing dispersion to [0,1]. Anchored to the threshold
// of the decision matrix (IVL_raw >= 0.18 => concentrate) so that score and decision
// stay coherent. A distribution that uses the whole channel well reaches ~0.18-0.25.
export const IVL_EXCELLENT = 0.18;

// Normalized width threshold for classifying a block as lateral: W/S <= DELTA
export const DEFAULT_DELTA = 0.05;

// Default fractal scales and their weights (sum to 1). More weight on the intermediate
// scales, which are the most relevant for LP ranges.
export const DEFAULT_SCALES = ["15m", "1h", "4h", "1d"];
export const SCALE_WEIGHTS = { "15m": 0.2, "1h": 0.35, "4h": 0.3, "1d": 0.15 };

// Minutes per timeframe, to align the time horizon (wall-clock) across scales.
export const TF_MINUTES = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240,
  "6h": 360, "8h": 480, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080,
};

// Minimum number of candles for a scale to participate in the fractal calculation.
export const MIN_SCALE_CANDLES = 6;

/**
 * Computes how many candles to take at each scale to cover the SAME time horizon as
 * `primaryLookback` candles of the primary scale. Avoids comparing 30h (15m) against 120 days (1d):
 * each scale looks at the same clock window. Scales with < MIN_SCALE_CANDLES are discarded.
 *
 * @returns {Record<string, number>} e.g. {15m:120, 1h:30, 4h:8}  (1d is discarded for 30h)
 */
export function horizonLookbacks(primaryScale, primaryLookback, scales) {
  const pMin = TF_MINUTES[primaryScale] ?? 15;
  const horizonMin = primaryLookback * pMin;
  const out = {};
  for (const s of scales) {
    const m = TF_MINUTES[s] ?? 15;
    const n = Math.round(horizonMin / m);
    if (n >= MIN_SCALE_CANDLES) out[s] = n;
  }
  // The primary scale always participates with its exact lookback.
  out[primaryScale] = primaryLookback;
  return out;
}

/**
 * @typedef {{ ts:number, o:number, h:number, l:number, c:number, vol:number }} Candle
 */

/** Simple sum. */
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

/** Clamp to [lo, hi]. */
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/**
 * Block VWAP: volume-weighted closing price.
 * μ_vwap = Σ(c_i · v_i) / Σ(v_i)
 */
export function computeVWAP(candles) {
  const vSum = sum(candles.map((c) => c.vol));
  if (vSum <= 0) {
    // With no volume, fall back to the arithmetic mean of closes.
    return sum(candles.map((c) => c.c)) / candles.length;
  }
  return sum(candles.map((c) => c.c * c.vol)) / vSum;
}

/**
 * Lateral variance, volume-weighted relative to the VWAP.
 * σ²_lateral = Σ v_i (c_i - μ_vwap)² / Σ v_i
 */
export function weightedVariance(candles, mu) {
  const vSum = sum(candles.map((c) => c.vol));
  if (vSum <= 0) {
    const n = candles.length;
    return sum(candles.map((c) => (c.c - mu) ** 2)) / n;
  }
  return sum(candles.map((c) => c.vol * (c.c - mu) ** 2)) / vSum;
}

/** Average True Range (simplified Wilder) over the last `period` candles. */
export function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(
      Math.max(
        c.h - c.l,
        Math.abs(c.h - prev.c),
        Math.abs(c.l - prev.c)
      )
    );
  }
  const slice = trs.slice(-period);
  return sum(slice) / slice.length;
}

/** Standard deviation of log returns per candle (intra-block volatility σ_b). */
export function intrablockVol(candles) {
  if (candles.length < 2) return 0;
  const rets = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].c > 0) rets.push(Math.log(candles[i].c / candles[i - 1].c));
  }
  if (rets.length === 0) return 0;
  const m = sum(rets) / rets.length;
  const v = sum(rets.map((r) => (r - m) ** 2)) / rets.length;
  return Math.sqrt(v);
}

/**
 * Single-scale metric: detects the lateral block and computes IVL_raw,
 * VWAP, support/resistance, persistence and volatility.
 *
 * @param {Candle[]} candles
 * @param {{ delta?:number }} [opts]
 */
export function scaleMetrics(candles, opts = {}) {
  const delta = opts.delta ?? DEFAULT_DELTA;
  if (!candles || candles.length < 5) {
    return { valid: false, reason: "insufficient_candles", n: candles?.length ?? 0 };
  }

  const S = Math.min(...candles.map((c) => c.l)); // support (minimum of lows)
  const R = Math.max(...candles.map((c) => c.h)); // resistance (maximum of highs)
  const W = R - S;
  const widthPct = S > 0 ? W / S : Infinity; // normalized width W/S

  const mu = computeVWAP(candles);
  const variance = weightedVariance(candles, mu);
  const sigma = Math.sqrt(variance);
  const ivlRaw = W > 0 ? variance / (W * W) : 0; // IVL = σ²/(R-S)²

  // Temporal persistence: fraction of closes within [S, R].
  // (By construction almost all are inside; we measure against the "core" channel
  //  μ ± W/2 to penalize prices stuck to an edge / asymmetric tails.)
  const coreLow = mu - W / 2;
  const coreHigh = mu + W / 2;
  const inside = candles.filter((c) => c.c >= coreLow && c.c <= coreHigh).length;
  const persistence = inside / candles.length;

  // Does it qualify as a stable lateral block? Bounded normalized width.
  const isLateral = widthPct <= delta;

  // Scale dispersion score: IVL_raw normalized to [0,1] against the "excellent"
  // reference (concentration threshold). Compression -> ~0 ; channel well used -> ~1.
  const dispersionScore = clamp(ivlRaw / IVL_EXCELLENT);

  return {
    valid: true,
    n: candles.length,
    S,
    R,
    W,
    widthPct,
    mu,
    variance,
    sigma,
    ivlRaw,
    dispersionScore,
    persistence,
    isLateral,
    sigmaB: intrablockVol(candles),
    atr14: atr(candles, 14),
    firstTs: candles[0].ts,
    lastTs: candles[candles.length - 1].ts,
  };
}

/**
 * Overlap between two ranges [a0,a1] and [b0,b1] as a fraction of the union (IoU).
 * 1 = identical, 0 = disjoint. Measures fractal consistency across scales.
 */
export function rangeOverlap(a, b) {
  const interLow = Math.max(a[0], b[0]);
  const interHigh = Math.min(a[1], b[1]);
  const inter = Math.max(0, interHigh - interLow);
  const unionLow = Math.min(a[0], b[0]);
  const unionHigh = Math.max(a[1], b[1]);
  const union = unionHigh - unionLow;
  return union > 0 ? inter / union : 0;
}

/**
 * Fractal consistency: average of overlaps (IoU) across all pairs of scales
 * that have a valid metric. Penalizes when scales "see" different ranges.
 */
export function fractalConsistency(metricsByScale) {
  const ranges = Object.values(metricsByScale)
    .filter((m) => m && m.valid)
    .map((m) => [m.S, m.R]);
  if (ranges.length < 2) return ranges.length === 1 ? 1 : 0;
  const pairs = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      pairs.push(rangeOverlap(ranges[i], ranges[j]));
    }
  }
  return sum(pairs) / pairs.length;
}

/**
 * LVR (Loss-Versus-Rebalancing) estimate per block for a concentrated pool.
 * Discretized arbitrage formula:
 *   ARB ≈ σ_b²/2 + 1.7164 · γ / σ_b
 * where σ_b = intra-block volatility and γ = pool fee (e.g. 0.0005 for 0.05%).
 * Returns the expected arbitrage rate and a risk classification.
 */
export function estimateLVR(sigmaB, gamma = 0.0005, tfMinutes = 15) {
  if (sigmaB <= 0) return { arb: 0, level: "low", sigmaB, gamma };
  // Discretized arbitrage value (formula from the framework): LVR core σ_b²/2
  // plus the width of the no-arbitrage band 1.7164·γ/σ_b.
  const arb = (sigmaB * sigmaB) / 2 + (1.7164 * gamma) / sigmaB;
  // LVR RISK grows with intra-block volatility. The thresholds are calibrated for
  // 15m; at larger scales σ_b is naturally bigger, so it is normalized to the
  // "15m equivalent" by dividing by sqrt(tf/15) (diffusion scaling) before classifying.
  const sigmaBNorm = sigmaB / Math.sqrt(Math.max(tfMinutes, 1) / 15);
  let level = "low";
  if (sigmaBNorm > 0.008) level = "high";
  else if (sigmaBNorm > 0.004) level = "moderate";
  return { arb, level, sigmaB, sigmaBNorm, gamma };
}

/** Classifies an IVL Score [0,100] into a qualitative band. */
export function classifyScore(score) {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "neutral";
  if (score >= 20) return "weak";
  return "breakout_risk";
}

/** Weighted geometric mean (collapses if any component is 0 -> demands confirmation). */
function weightedGeomean(values, weights) {
  const wSum = sum(weights);
  if (wSum <= 0) return 0;
  // Avoids log(0): treats 0 as a very small floor so noise does not fully zero it out.
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(values[i], 1e-6);
    acc += (weights[i] / wSum) * Math.log(v);
  }
  return Math.exp(acc);
}

/**
 * Integrated multiscale IVL: the main computation.
 *
 * @param {Record<string, Candle[]>} candlesByScale  e.g. { "15m":[...], "1h":[...], ... }
 * @param {{ delta?:number, gamma?:number, primaryScale?:string }} [opts]
 * @returns object with ivl (components), ivlScore [0..100], classification, LP range and LVR.
 */
export function computeIVL(candlesByScale, opts = {}) {
  const delta = opts.delta ?? DEFAULT_DELTA;
  const gamma = opts.gamma ?? 0.0005;
  const scales = Object.keys(candlesByScale);

  const metricsByScale = {};
  for (const s of scales) metricsByScale[s] = scaleMetrics(candlesByScale[s], { delta });

  const valid = scales.filter((s) => metricsByScale[s].valid);
  if (valid.length === 0) {
    return { ok: false, reason: "no_valid_scales", metricsByScale };
  }

  // Primary scale: the first available one (typically 15m), basis of the LP range.
  const primaryScale =
    opts.primaryScale && metricsByScale[opts.primaryScale]?.valid
      ? opts.primaryScale
      : valid[0];
  const primary = metricsByScale[primaryScale];

  // --- Intrinsic IVL components ---
  // 1) Dispersion: weighted geometric mean of the dispersionScore per scale.
  const dispVals = valid.map((s) => metricsByScale[s].dispersionScore);
  const dispWeights = valid.map((s) => SCALE_WEIGHTS[s] ?? 1 / valid.length);
  const dispersion = weightedGeomean(dispVals, dispWeights);

  // 2) Persistence: weighted mean of the temporal persistence per scale.
  const persVals = valid.map((s) => metricsByScale[s].persistence);
  const persistence =
    sum(persVals.map((p, i) => p * dispWeights[i])) / sum(dispWeights);

  // 3) Fractality: how many scales confirm the same range (average overlap)
  //    scaled by the fraction of scales that actually lateralize.
  const overlap = fractalConsistency(metricsByScale);
  const lateralFrac = valid.filter((s) => metricsByScale[s].isLateral).length / valid.length;
  const fractal = overlap * (0.5 + 0.5 * lateralFrac);

  // --- Integration: weighted geometric (any weak component drags the score down) ---
  const W_DISP = 0.5,
    W_PERS = 0.2,
    W_FRAC = 0.3;
  const combined = weightedGeomean(
    [dispersion, persistence, fractal],
    [W_DISP, W_PERS, W_FRAC]
  );
  const ivlScore = Math.round(clamp(combined) * 100);

  // --- LVR over the primary scale (timeframe-aware threshold) ---
  const lvr = estimateLVR(primary.sigmaB, gamma, TF_MINUTES[primaryScale] ?? 15);

  // --- Suggested LP range: μ_vwap ± 2σ_lateral (primary scale) ---
  const lpRange = {
    lower: primary.mu - 2 * primary.sigma,
    upper: primary.mu + 2 * primary.sigma,
    vwap: primary.mu,
    sigma: primary.sigma,
    pool_fee_tier: gamma,
  };

  return {
    ok: true,
    primaryScale,
    ivl: {
      raw_primary: primary.ivlRaw, // IVL = σ²/(R-S)² of the primary scale (canonical value)
      dispersion,
      persistence,
      fractal,
      combined,
    },
    ivlScore,
    classification: classifyScore(ivlScore),
    range: { low: primary.S, high: primary.R, width: primary.W, widthPct: primary.widthPct },
    lpRange,
    lvr,
    scalesConfirming: valid.filter((s) => metricsByScale[s].isLateral),
    metricsByScale,
  };
}
