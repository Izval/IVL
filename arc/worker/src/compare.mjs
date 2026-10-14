// compare.mjs - "With and without IVL" for one pool, using the published IVL comparison model.
//
// This is ../../scripts/compare.mjs (the profitability demo in the research note) made callable:
// same strategies, same relative cost model, plus a cumulative-net curve per strategy for charts.
//
//   With IVL   patient set-and-hold: keeps its μ ± 2σ band while price is inside; on exit it waits
//              `patience` candles and redeploys only into a newly confirmed lateral block.
//   Fixed      fixed typical width centered on price, always deployed, re-centered on every exit.
//   Random     random center/width, re-centered on exit (average of N seeds).
//
// Per candle in range: fee = (vol / mean vol) · (W_ref / W_band), il = (ret² / mean ret²) · (W_ref / W_band);
// every band change costs `cost` candles of reference fee income. Units are relative: what matters
// is the gap between the strategies on the same history.

import { computeVWAP, weightedVariance } from "../../../scripts/ivl-core.mjs";
import { detectLateralBlock, rangeProfile } from "../../../scripts/ivl-lp.mjs";

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(candles, env, target) {
  const { start, wRef, meanVol, meanRetSq, cost, ilCoef } = env;
  let band = null;
  let fees = 0;
  let il = 0;
  let rebalances = 0;
  let inRange = 0;
  let deployed = 0;
  const curve = [];
  const n = candles.length - start;
  const same = (a, b) => (!a && !b) || (a && b && Math.abs(a.lower - b.lower) < 1e-12 && Math.abs(a.upper - b.upper) < 1e-12);

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const want = target(i, band);
    if (!same(want, band)) {
      rebalances++;
      band = want;
    }
    if (band) {
      deployed++;
      if (c.c >= band.lower && c.c <= band.upper) {
        const conc = wRef / (band.upper - band.lower);
        const ret = candles[i - 1]?.c > 0 ? Math.log(c.c / candles[i - 1].c) : 0;
        fees += (c.vol / meanVol) * conc;
        il += ilCoef * ((ret * ret) / meanRetSq) * conc;
        inRange++;
      }
    }
    curve.push(+(fees - il - rebalances * cost).toFixed(2));
  }
  return {
    fees: +fees.toFixed(1),
    il: +il.toFixed(1),
    rebalances,
    timeDeployed: +(deployed / n).toFixed(3),
    timeInRange: +(inRange / n).toFixed(3),
    net: +(fees - il - rebalances * cost).toFixed(1),
    curve,
  };
}

/**
 * @param candles oldest-first {ts,o,h,l,c,vol}
 * @param opts {scale, lookback=45, delta=0.16, patience=5, cost=1.5, ilCoef=1, seeds=20}
 */
export function compareWithWithout(candles, opts = {}) {
  const { scale = "1d", lookback = 45, delta = 0.16, patience = 5, cost = 1.5, ilCoef = 1, seeds = 20 } = opts;
  if (candles.length < lookback + 30) return null;

  const profile = rangeProfile(candles, delta, 8, scale);
  const typicalW = profile.found ? profile.median_width_pct / 100 : 0.15;
  const wRef = typicalW * candles.at(-1).c;
  const meanVol = candles.reduce((a, c) => a + c.vol, 0) / candles.length || 1;
  const rets = candles.slice(1).map((c, i) => (candles[i].c > 0 ? Math.log(c.c / candles[i].c) : 0));
  const meanRetSq = rets.reduce((a, r) => a + r * r, 0) / rets.length || 1e-8;
  const env = { start: lookback, wRef, meanVol, meanRetSq, cost, ilCoef };
  const slice = (i) => candles.slice(Math.max(0, i - lookback), i + 1);
  const inBand = (p, b) => b && p >= b.lower && p <= b.upper;

  let outStreak = 0;
  const withIvl = simulate(candles, env, (i, cur) => {
    const price = candles[i].c;
    if (cur && inBand(price, cur)) {
      outStreak = 0;
      return cur;
    }
    outStreak++;
    if (outStreak < patience) return cur;
    const blk = detectLateralBlock(slice(i), delta);
    if (blk.found && price >= blk.S && price <= blk.R) {
      outStreak = 0;
      const mu = computeVWAP(blk.block);
      const sigma = Math.sqrt(weightedVariance(blk.block, mu));
      return { lower: mu - 2 * sigma, upper: mu + 2 * sigma };
    }
    return cur;
  });

  const fixed = simulate(candles, env, (i, cur) => {
    const price = candles[i].c;
    if (inBand(price, cur)) return cur;
    return { lower: price * (1 - typicalW / 2), upper: price * (1 + typicalW / 2) };
  });

  const runs = [];
  for (let s = 0; s < seeds; s++) {
    const rnd = mulberry32(1000 + s * 7);
    runs.push(
      simulate(candles, env, (i, cur) => {
        const price = candles[i].c;
        if (inBand(price, cur)) return cur;
        const center = price * (1 + (rnd() - 0.5) * 0.1);
        const width = 0.05 + rnd() * 0.2;
        return { lower: center * (1 - width / 2), upper: center * (1 + width / 2) };
      })
    );
  }
  const avg = (k) => +(runs.reduce((a, r) => a + r[k], 0) / runs.length).toFixed(3);
  const random = {
    fees: avg("fees"),
    il: avg("il"),
    rebalances: Math.round(avg("rebalances")),
    timeDeployed: avg("timeDeployed"),
    timeInRange: avg("timeInRange"),
    net: avg("net"),
    curve: runs[0].curve.map((_, i) => +(runs.reduce((a, r) => a + r.curve[i], 0) / runs.length).toFixed(2)),
  };

  return {
    scale,
    candles: candles.length - lookback,
    fromTs: candles[lookback].ts,
    toTs: candles.at(-1).ts,
    typicalWidthPct: +(typicalW * 100).toFixed(2),
    withIvl,
    fixed,
    random,
  };
}
