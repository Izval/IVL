#!/usr/bin/env node
// compare.mjs - Profitability demo: IVL range management vs random ranges vs naive.
//
// Walk-forward simulation over a pool's history, comparing three ways to choose the
// concentrated-liquidity range with the SAME capital:
//   1. IVL      - μ±2σ band of the detected lateral block; on a breakout, a wide defensive band.
//   2. Naive    - fixed-width band (typical width) centered on price, rebalance on exit.
//   3. Random   - random center/width (average of N seeds), rebalance on exit.
//
// Model (relative units, identical for all three → fair comparison). Per day IN range:
//   fee_day = (day_volume / mean_vol) · (W_ref / W_pos)            (fee income)
//   il_day  = ilCoef · (day_return² / mean_ret²) · (W_ref / W_pos) (impermanent loss / LVR)
//   net = Σ(fee_day − il_day) − rebalances · rebalance_cost
//
// IL is the cost that IVL exists to avoid: a narrow band during a TREND collects fees but
// bleeds IL; IVL only concentrates in an oscillation regime (high IVL) and widens in a
// trend (low IVL), maximizing fees/IL.
//
// Usage: node compare.mjs --pair AAVE-WBNB --scale 1d --history 365 --delta 0.16 --json

import { getKlinesSmart } from "./binance.mjs";
import { computeVWAP, weightedVariance } from "./ivl-core.mjs";
import { detectLateralBlock, rangeProfile } from "./ivl-lp.mjs";

const GAMMA = 0.0005;

function parseArgs(argv) {
  // costPerRebalance in "fee units": a rebalance costs ~1.5 days of base in-range fees.
  // hoardYield 0 by default: out of range the LP HOLDS the asset (no rebalance, no chasing).
  // patience: candles the price must spend out of range before considering a redeploy (no chasing).
  const a = { pair: "AAVE-WBNB", scale: "1d", history: 365, delta: 0.16, lookback: 45,
    costPerRebalance: 1.5, ilCoef: 1.0, hoardYield: 0, patience: 5, seeds: 20, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pair") a.pair = argv[++i];
    else if (k === "--scale") a.scale = argv[++i];
    else if (k === "--history") a.history = parseInt(argv[++i], 10);
    else if (k === "--delta") a.delta = parseFloat(argv[++i]);
    else if (k === "--lookback") a.lookback = parseInt(argv[++i], 10);
    else if (k === "--cost") a.costPerRebalance = parseFloat(argv[++i]);
    else if (k === "--il") a.ilCoef = parseFloat(argv[++i]);
    else if (k === "--hoard") a.hoardYield = parseFloat(argv[++i]);
    else if (k === "--patience") a.patience = parseInt(argv[++i], 10);
    else if (k === "--seeds") a.seeds = parseInt(argv[++i], 10);
    else if (k === "--json") a.json = true;
  }
  return a;
}

// Deterministic PRNG (mulberry32) for reproducibility of the random case.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulates a strategy that, on each deployment, chooses a band [lower,upper] via `chooseBand(i)`.
 * Walks the history; if price exits, it rebalances (cost) and redeploys.
 * fee_day = (vol/meanVol)·(W_ref/W_pos) if in range. net = Σ fee − rebalances·costPerRebalance.
 */
// DAILY decision: target(i, currentBand) returns the desired band or null (withdraw to hoard).
// A band change (deploy/withdraw/redeploy) counts as a rebalance. In range: fees − IL.
// Withdrawn (null): 0 fees, 0 IL, + hoard yield (capital in stablecoins).
function simulate(candles, env, target) {
  const { start, wRef, meanVol, meanRetSq, costPerRebalance, ilCoef, hoardYield } = env;
  let band = null;
  let fees = 0;
  let il = 0;
  let hoard = 0;
  let rebalances = 0;
  let inRangeDays = 0;
  let deployedDays = 0;
  const days = candles.length - start;
  const sameBand = (a, b) =>
    (!a && !b) || (a && b && Math.abs(a.lower - b.lower) < 1e-12 && Math.abs(a.upper - b.upper) < 1e-12);

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const want = target(i, band);
    if (!sameBand(want, band)) {
      rebalances++;
      band = want;
    }
    if (band) {
      deployedDays++;
      if (c.c >= band.lower && c.c <= band.upper) {
        const conc = wRef / (band.upper - band.lower);
        const ret = candles[i - 1]?.c > 0 ? Math.log(c.c / candles[i - 1].c) : 0;
        fees += (c.vol / meanVol) * conc;
        il += ilCoef * ((ret * ret) / meanRetSq) * conc;
        inRangeDays++;
      }
    } else {
      hoard += hoardYield;
    }
  }
  return {
    gross_fees: +fees.toFixed(2),
    il: +il.toFixed(2),
    hoard: +hoard.toFixed(2),
    rebalances,
    time_deployed: +(deployedDays / days).toFixed(3),
    time_in_range: +(inRangeDays / days).toFixed(3),
    net: +(fees - il + hoard - rebalances * costPerRebalance).toFixed(2),
  };
}

function main_run(candles, args) {
  // References derived from the history.
  const profile = rangeProfile(candles, args.delta, 8, args.scale);
  const typicalW = profile.found ? profile.median_width_pct / 100 : 0.15;
  const center0 = candles[candles.length - 1].c;
  const wRef = typicalW * center0; // reference width in price (to normalize concentration)
  const meanVol = candles.reduce((a, c) => a + c.vol, 0) / candles.length || 1;
  const rets = candles.slice(1).map((c, i) => (candles[i].c > 0 ? Math.log(c.c / candles[i].c) : 0));
  const meanRetSq = rets.reduce((a, r) => a + r * r, 0) / rets.length || 1e-8;
  const env = {
    start: args.lookback,
    wRef,
    meanVol,
    meanRetSq,
    costPerRebalance: args.costPerRebalance,
    ilCoef: args.ilCoef,
    hoardYield: args.hoardYield,
  };
  const slice = (i) => candles.slice(Math.max(0, i - args.lookback), i + 1);
  const inBand = (price, b) => b && price >= b.lower && price <= b.upper;

  // --- IVL strategy: PATIENT set-and-hold (does not chase price) ---
  // Keeps the range while price is inside. On EXIT it does not redeploy: it WAITS (holds the
  // asset, no cost) until price has spent `patience` candles out AND a NEW lateralization is
  // confirmed (exhaustion → re-lateralization); only then does it place a forward range.
  let ivlOutStreak = 0;
  const ivlStrat = simulate(candles, env, (i, cur) => {
    const price = candles[i].c;
    if (cur && inBand(price, cur)) {
      ivlOutStreak = 0;
      return cur; // hold: the LP does not touch the position while price oscillates inside
    }
    ivlOutStreak++;
    if (ivlOutStreak < args.patience) return cur; // wait, do NOT chase (even if out of range)
    // After patience runs out, redeploy only if a new lateralization is confirmed.
    const blk = detectLateralBlock(slice(i), args.delta);
    if (blk.found && price >= blk.S && price <= blk.R) {
      ivlOutStreak = 0;
      const mu = computeVWAP(blk.block);
      const sigma = Math.sqrt(weightedVariance(blk.block, mu));
      return { lower: mu - 2 * sigma, upper: mu + 2 * sigma }; // forward range, set-and-hold
    }
    return cur; // keeps waiting for re-lateralization (does not chase the trend)
  });

  // --- Naive strategy (fixed typical width, always deployed; rebalances on exit) ---
  const naiveStrat = simulate(candles, env, (i, cur) => {
    const price = candles[i].c;
    if (inBand(price, cur)) return cur;
    return { lower: price * (1 - typicalW / 2), upper: price * (1 + typicalW / 2) };
  });

  // --- Random strategy (average of N seeds, always deployed) ---
  const randResults = [];
  for (let s = 0; s < args.seeds; s++) {
    const rnd = mulberry32(1000 + s * 7);
    const r = simulate(candles, env, (i, cur) => {
      const price = candles[i].c;
      if (inBand(price, cur)) return cur;
      const offset = (rnd() - 0.5) * 0.1;
      const width = 0.05 + rnd() * 0.2;
      const c = price * (1 + offset);
      return { lower: c * (1 - width / 2), upper: c * (1 + width / 2) };
    });
    randResults.push(r);
  }
  const avg = (key) => +(randResults.reduce((a, r) => a + r[key], 0) / randResults.length).toFixed(4);
  const randomStrat = {
    gross_fees: avg("gross_fees"),
    il: avg("il"),
    hoard: avg("hoard"),
    rebalances: Math.round(avg("rebalances")),
    time_deployed: avg("time_deployed"),
    time_in_range: avg("time_in_range"),
    net: avg("net"),
  };

  // % improvement; if the baseline is ≤0 and IVL is positive, it is flagged as a loss→gain turnaround.
  const uplift = (a, b) => {
    if (b > 0) return { pct: +(((a - b) / b) * 100).toFixed(1), turnaround: false };
    if (a > 0) return { pct: null, turnaround: true, delta: +(a - b).toFixed(2) };
    return { pct: null, turnaround: false, delta: +(a - b).toFixed(2) };
  };

  return {
    pair: args.pair,
    scale: args.scale,
    candles: candles.length,
    typical_width_pct: +(typicalW * 100).toFixed(1),
    ivl: ivlStrat,
    naive: naiveStrat,
    random: randomStrat,
    uplift_vs_random: uplift(ivlStrat.net, randomStrat.net),
    uplift_vs_naive: uplift(ivlStrat.net, naiveStrat.net),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const candles = await getKlinesSmart(args.pair, args.scale, Math.min(args.history, 1000));
  if (candles.length < args.lookback + 20) {
    console.error("Insufficient history.");
    process.exit(1);
  }
  const r = main_run(candles, args);

  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const row = (name, s) =>
    `  ${name.padEnd(8)} net=${String(s.net).padStart(8)}  fees=${String(s.gross_fees).padStart(7)}  IL=${String(s.il).padStart(7)}  deployed=${((s.time_deployed ?? 1) * 100).toFixed(0)}%  rebal=${s.rebalances}`;
  console.log(`\n=== LP profitability demo - ${r.pair} (${r.scale}, ${r.candles} candles) ===`);
  console.log(`Typical historical width: ${r.typical_width_pct}%  ·  cost/rebalance=${args.costPerRebalance} fee units\n`);
  console.log(row("IVL", r.ivl));
  console.log(row("Naive", r.naive));
  console.log(row("Random", r.random));
  const upMsg = (u) =>
    u.turnaround ? `loss→gain turnaround (+${u.delta} net)` : u.pct != null ? `${u.pct}%` : `${u.delta} net (both at a loss)`;
  console.log(`\n  📈 IVL vs Random: ${upMsg(r.uplift_vs_random)}`);
  console.log(`  📈 IVL vs Naive:  ${upMsg(r.uplift_vs_naive)}`);
  console.log(`  🛡  IL avoided: IVL ${r.ivl.il} vs Naive ${r.naive.il} (−${(100 * (1 - r.ivl.il / (r.naive.il || 1))).toFixed(0)}%)\n`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
