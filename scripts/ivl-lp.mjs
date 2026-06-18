// ivl-lp.mjs - Lateral block detection + LP projections (timing and yield).
//
// Addresses the core idea: "find those ranges and shapes in any pair to see their
// IVL and thus know the best tick management, the expected timing and yield estimates".
// In variable/variable pairs the analyzed price is the RATIO (the correlation), not the USD value.

import { computeVWAP, weightedVariance, intrablockVol, atr, TF_MINUTES } from "./ivl-core.mjs";

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Detects the most recent consolidation block: the longest window, anchored at the last
 * candle, whose normalized width (max-min)/min ≤ delta. This isolates the real "8-16%" range
 * instead of taking the min/max of the whole series (which a trending stretch inflates).
 *
 * @param {import('./ivl-core.mjs').Candle[]} candles
 * @param {number} delta    maximum tolerated width (e.g. 0.16 = 16%)
 * @param {number} minLen   minimum number of candles to consider it a block
 * @returns {{found:boolean, block?:Candle[], S:number, R:number, widthPct:number, durationCandles:number, startIdx:number}}
 */
export function detectLateralBlock(candles, delta = 0.16, minLen = 8) {
  if (!candles || candles.length < minLen) return { found: false };
  const end = candles.length - 1;
  let j = end;
  let lo = candles[end].l;
  let hi = candles[end].h;
  // Expand backwards while the normalized width stays below the threshold.
  for (let k = end - 1; k >= 0; k--) {
    const nlo = Math.min(lo, candles[k].l);
    const nhi = Math.max(hi, candles[k].h);
    if (nlo > 0 && (nhi - nlo) / nlo > delta) break;
    lo = nlo;
    hi = nhi;
    j = k;
  }
  const block = candles.slice(j, end + 1);
  const widthPct = lo > 0 ? (hi - lo) / lo : Infinity;
  if (block.length < minLen) return { found: false, S: lo, R: hi, widthPct, durationCandles: block.length };
  return { found: true, block, S: lo, R: hi, widthPct, durationCandles: block.length, startIdx: j };
}

/**
 * Finds the LONGEST lateral block at any position in the series (not just the current one).
 * Useful for studying the historical "ranges and shapes" of a pair and their timings.
 */
export function findBestLateralBlock(candles, delta = 0.16, minLen = 8) {
  if (!candles || candles.length < minLen) return { found: false };
  let best = null;
  for (let end = candles.length - 1; end >= minLen - 1; end--) {
    let lo = candles[end].l;
    let hi = candles[end].h;
    let start = end;
    for (let k = end - 1; k >= 0; k--) {
      const nlo = Math.min(lo, candles[k].l);
      const nhi = Math.max(hi, candles[k].h);
      if (nlo > 0 && (nhi - nlo) / nlo > delta) break;
      lo = nlo;
      hi = nhi;
      start = k;
    }
    const len = end - start + 1;
    if (len >= minLen && (!best || len > best.durationCandles)) {
      best = {
        found: true,
        block: candles.slice(start, end + 1),
        S: lo,
        R: hi,
        widthPct: lo > 0 ? (hi - lo) / lo : Infinity,
        durationCandles: len,
        startIdx: start,
        endIdx: end,
      };
    }
  }
  return best ?? { found: false };
}

/**
 * Partitions the history into ALL lateral blocks (≤ delta, ≥ minLen), greedily
 * from the present backwards, skipping the trending stretches. Basis of the historical profile.
 */
export function historicalBlocks(candles, delta = 0.16, minLen = 8) {
  const blocks = [];
  let end = candles.length - 1;
  while (end >= minLen - 1) {
    let lo = candles[end].l;
    let hi = candles[end].h;
    let start = end;
    for (let k = end - 1; k >= 0; k--) {
      const nlo = Math.min(lo, candles[k].l);
      const nhi = Math.max(hi, candles[k].h);
      if (nlo > 0 && (nhi - nlo) / nlo > delta) break;
      lo = nlo;
      hi = nhi;
      start = k;
    }
    const len = end - start + 1;
    if (len >= minLen) {
      blocks.push({ S: lo, R: hi, mid: (lo + hi) / 2, widthPct: lo > 0 ? (hi - lo) / lo : Infinity,
        durationCandles: len, startIdx: start, endIdx: end });
      end = start - 1;
    } else {
      end -= 1;
    }
  }
  return blocks;
}

/** Groups nearby price levels (within relative `tol`) into clusters of recurring S/R. */
export function clusterLevels(values, tol = 0.02) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(v - last.mean) / last.mean <= tol) {
      last.values.push(v);
      last.mean = last.values.reduce((a, b) => a + b, 0) / last.values.length;
    } else {
      clusters.push({ mean: v, values: [v] });
    }
  }
  return clusters
    .map((c) => ({ level: +c.mean.toFixed(6), touches: c.values.length }))
    .sort((a, b) => b.touches - a.touches);
}

/**
 * Historical lateralization profile of a pair: how it usually lateralizes (typical width and
 * duration) and which levels it respects over and over. Answers "observing the historical IVL,
 * what would be a good range".
 */
export function rangeProfile(candles, delta = 0.16, minLen = 8, timeframe = "1d") {
  const blocks = historicalBlocks(candles, delta, minLen);
  if (!blocks.length) return { found: false, blocks: [] };
  const tfMin = TF_MINUTES[timeframe] ?? 1440;
  const widths = blocks.map((b) => b.widthPct);
  const durs = blocks.map((b) => b.durationCandles);
  const levels = clusterLevels(blocks.flatMap((b) => [b.S, b.R]), 0.02).filter((l) => l.touches >= 2);
  return {
    found: true,
    count: blocks.length,
    median_width_pct: +(median(widths) * 100).toFixed(1),
    median_duration_candles: median(durs),
    median_duration_days: +((median(durs) * tfMin) / (60 * 24)).toFixed(1),
    recurring_levels: levels,
    blocks,
  };
}

/**
 * Detects volatility CONTRACTION ("starting to enter a range"): compares the recent ATR
 * with the background ATR. ratio < 1 => contracting after an expansion/breakout.
 */
export function volatilityContraction(candles, shortN = 7, longN = 30) {
  if (candles.length < longN + 1) return { contracting: false, ratio: null };
  const atrShort = atr(candles.slice(-shortN - 1), shortN);
  const atrLong = atr(candles.slice(-longN - 1), longN);
  const ratio = atrLong > 0 ? atrShort / atrLong : null;
  return { contracting: ratio != null && ratio < 0.85, ratio: ratio != null ? +ratio.toFixed(3) : null };
}

/**
 * Suggests a good FORWARD range for a new lateralization: anchors the profile's typical width
 * to the current price (or the nearest recurring level) and projects duration/APR.
 * Designed for when the pair comes off a breakout and starts to lateralize.
 */
export function suggestRange(currentPrice, profile, timeframe = "1d", gamma = 0.0005, tvl = null) {
  if (!profile.found) return { ok: false, reason: "no_historical_blocks" };
  const tfMin = TF_MINUTES[timeframe] ?? 1440;
  const widthPct = profile.median_width_pct / 100;

  // Anchor: recurring level nearest to the current price (if any is reasonably close),
  // otherwise the current price itself as the center.
  let anchor = currentPrice;
  let anchoredTo = "current_price";
  for (const l of profile.recurring_levels) {
    if (Math.abs(l.level - currentPrice) / currentPrice <= widthPct) {
      anchor = l.level;
      anchoredTo = `recurring_level(${l.touches} touches)`;
      break;
    }
  }
  const lower = anchor * (1 - widthPct / 2);
  const upper = anchor * (1 + widthPct / 2);
  // Concentrated LP band ~ half the typical width around the anchor.
  const lpLower = anchor * (1 - widthPct / 4);
  const lpUpper = anchor * (1 + widthPct / 4);

  const expectedDays = profile.median_duration_days;
  let estFeeApr = null;
  if (tvl && tvl > 0 && expectedDays > 0) {
    // Approximation: lacking future volume, uses the concentration factor as a multiplier
    // over a nominal base fee APR. Flagged as a coarse estimate.
    const concentration = (upper - lower) / (lpUpper - lpLower); // = 2
    estFeeApr = +(concentration * 20).toFixed(1); // 20% nominal base × concentration (placeholder)
  }

  return {
    ok: true,
    anchored_to: anchoredTo,
    suggested_range: { lower: +lower.toFixed(6), upper: +upper.toFixed(6) },
    suggested_lp_band: { lower: +lpLower.toFixed(6), upper: +lpUpper.toFixed(6) },
    typical_width_pct: profile.median_width_pct,
    expected_duration_days: expectedDays,
    est_fee_apr: estFeeApr,
    note:
      "Suggested range = typical historical width anchored to the price/recurring level. Validate with " +
      "computeIVL once the block is confirmed; est_fee_apr is approximate (requires real volume/TVL).",
  };
}

/**
 * Correlation factor between the two assets of a cross (key in variable/variable pairs):
 * Pearson correlation of their log returns. High positive correlation => the ratio is more
 * stable => better for LP. baseLeg/quoteLeg are the vs-USD series of each asset.
 */
export function correlationFactor(baseLeg, quoteLeg) {
  const byTs = new Map(quoteLeg.map((c) => [c.ts, c.c]));
  const rb = [];
  const rq = [];
  for (let i = 1; i < baseLeg.length; i++) {
    const b0 = baseLeg[i - 1].c;
    const b1 = baseLeg[i].c;
    const q0 = byTs.get(baseLeg[i - 1].ts);
    const q1 = byTs.get(baseLeg[i].ts);
    if (b0 > 0 && q0 > 0 && q1 > 0) {
      rb.push(Math.log(b1 / b0));
      rq.push(Math.log(q1 / q0));
    }
  }
  const n = rb.length;
  if (n < 3) return null;
  const mb = rb.reduce((a, b) => a + b, 0) / n;
  const mq = rq.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vb = 0;
  let vq = 0;
  for (let i = 0; i < n; i++) {
    cov += (rb[i] - mb) * (rq[i] - mq);
    vb += (rb[i] - mb) ** 2;
    vq += (rq[i] - mq) ** 2;
  }
  if (vb <= 0 || vq <= 0) return null;
  return cov / Math.sqrt(vb * vq);
}

/**
 * LP projection over a lateral block and a tick band [lower, upper]:
 *  - concentration factor (fee multiplier vs the full range of the block),
 *  - expected time in range (diffusion first-passage),
 *  - yield estimate (fee APR if the pool's TVL in the band is provided).
 *
 * @param {Candle[]} block       candles of the lateral block (primary scale)
 * @param {{lower:number, upper:number}} band
 * @param {{S:number, R:number}} fullRange  full range of the block
 * @param {string} timeframe     primary scale (e.g. "1d")
 * @param {number} gamma         pool fee tier (e.g. 0.0005)
 * @param {number|null} tvl      TVL provided in the band (USD), optional for APR
 */
export function projectLP(block, band, fullRange, timeframe, gamma = 0.0005, tvl = null) {
  const tfMin = TF_MINUTES[timeframe] ?? 15;
  const center = (band.lower + band.upper) / 2;
  const half = (band.upper - band.lower) / 2;
  const sigmaB = intrablockVol(block); // log vol per candle
  const sigmaPrice = sigmaB * center; // absolute vol per candle

  // Expected timing: first-passage time of a random walk to cover 'half'.
  // E[t] ≈ (half / σ_price)² candles (order of magnitude), capped at block size×3.
  let expectedCandles =
    sigmaPrice > 0 ? Math.round((half / sigmaPrice) ** 2) : block.length;
  expectedCandles = Math.min(expectedCandles, block.length * 3);
  const expectedHours = (expectedCandles * tfMin) / 60;

  // Concentration factor: how much narrower the band is vs the full range of the block.
  const fullWidth = fullRange.R - fullRange.S;
  const bandWidth = band.upper - band.lower;
  const concentrationFactor = bandWidth > 0 ? fullWidth / bandWidth : null;

  // Volume traded within the band (gross fee proxy at the pool level).
  let inRangeVol = 0;
  for (const c of block) if (c.c >= band.lower && c.c <= band.upper) inRangeVol += c.vol;
  const grossFees = inRangeVol * gamma; // in units of the base asset (volume × fee)

  // Estimated fee APR (requires TVL provided in the band).
  const blockDays = (block.length * tfMin) / (60 * 24);
  let estFeeApr = null;
  if (tvl && tvl > 0 && blockDays > 0) {
    estFeeApr = ((grossFees / blockDays) * 365) / tvl;
  }

  return {
    concentration_factor: concentrationFactor ? +concentrationFactor.toFixed(2) : null,
    expected_candles_in_range: expectedCandles,
    expected_duration_hours: +expectedHours.toFixed(1),
    expected_duration_days: +(expectedHours / 24).toFixed(2),
    in_range_volume: +inRangeVol.toFixed(2),
    gross_fees_block: +grossFees.toFixed(4),
    block_days: +blockDays.toFixed(1),
    est_fee_apr: estFeeApr != null ? +(estFeeApr * 100).toFixed(1) : null, // %
    tvl_assumed: tvl ?? null,
    note:
      "expected_duration = diffusion first-passage (estimate). gross_fees = in-band volume × fee " +
      "(gross, pool level). est_fee_apr requires --tvl (TVL provided in the band).",
  };
}
