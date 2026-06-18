#!/usr/bin/env node
// backtest.mjs - Walk-forward backtest of the IVL spec for concentrated liquidity provision.
//
// For each evaluation point: computes the integrated multi-scale IVL over the prior window,
// derives the LP range (μ_vwap ± 2σ) and simulates holding that position over a future
// horizon, measuring time-in-range, breakout events and fee efficiency. Compares the
// IVL range against a naive baseline (full observed range [S,R]).
//
// Usage:
//   node backtest.mjs --pair BNB-USDT --lookback 96 --hold 48 --step 16 --history 1000
//   node backtest.mjs --pair BNB-AAVE --json
//
// Demonstrates that concentrating per IVL captures more fees per capital than a naive wide range.

import { computeIVL, horizonLookbacks } from "./ivl-core.mjs";
import { decideLP } from "./ivl-strategy.mjs";
import { getKlinesSmart } from "./binance.mjs";

const GAMMA = 0.0005; // fee tier 0.05% (PancakeSwap v3)

function parseArgs(argv) {
  const a = { pair: "BNB-USDT", lookback: 96, hold: 48, step: 16, history: 1000, json: false,
    scales: ["15m", "1h", "4h", "1d"] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pair") a.pair = argv[++i];
    else if (k === "--lookback") a.lookback = parseInt(argv[++i], 10);
    else if (k === "--hold") a.hold = parseInt(argv[++i], 10);
    else if (k === "--step") a.step = parseInt(argv[++i], 10);
    else if (k === "--history") a.history = parseInt(argv[++i], 10);
    else if (k === "--json") a.json = true;
  }
  return a;
}

/** Simulates holding an LP range [lo,hi] over the future candles. */
function simulateRange(future, lo, hi) {
  let inRange = 0;
  let breakoutAt = -1;
  let consecutiveOut = 0;
  let feeNotional = 0; // Σ volume traded while price is in range
  for (let i = 0; i < future.length; i++) {
    const c = future[i];
    const within = c.c >= lo && c.c <= hi;
    if (within) {
      inRange++;
      feeNotional += c.vol;
      consecutiveOut = 0;
    } else {
      consecutiveOut++;
      if (consecutiveOut >= 2 && breakoutAt < 0) breakoutAt = i;
    }
  }
  const width = hi - lo;
  const fees = feeNotional * GAMMA;
  // Capital efficiency: fees per unit of range width (concentrating = more efficient).
  const feeEfficiency = width > 0 ? fees / width : 0;
  return {
    timeInRange: inRange / future.length,
    breakout: breakoutAt >= 0,
    breakoutAt,
    fees,
    feeEfficiency,
    width,
  };
}

function sliceUpTo(candles, ts, n) {
  const upTo = candles.filter((c) => c.ts <= ts);
  return upTo.slice(-n);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

async function main() {
  const args = parseArgs(process.argv);

  // Series per scale (each with its own history).
  const series = {};
  for (const s of args.scales) {
    series[s] = await getKlinesSmart(args.pair, s, Math.min(args.history, 1000));
  }
  const base = series[args.scales[0]]; // primary timeline (15m)

  // Per-scale lookback to match the time horizon (same wall-clock across all).
  const lookbacks = horizonLookbacks(args.scales[0], args.lookback, args.scales);
  const usableScales = args.scales.filter((s) => lookbacks[s] > 0);

  const evals = [];
  for (let i = args.lookback; i + args.hold < base.length; i += args.step) {
    const ts = base[i].ts;
    const candlesByScale = {};
    for (const s of usableScales) candlesByScale[s] = sliceUpTo(series[s], ts, lookbacks[s]);
    if (candlesByScale[args.scales[0]].length < args.lookback) continue;

    const ivl = computeIVL(candlesByScale, { primaryScale: args.scales[0], gamma: GAMMA });
    if (!ivl.ok) continue;
    const decision = decideLP(ivl, { candlesPrimary: candlesByScale[args.scales[0]] });

    const future = base.slice(i, i + args.hold);

    // IVL range (μ±2σ) vs wide-range baseline (observed S..R).
    const ivlSim = simulateRange(future, ivl.lpRange.lower, ivl.lpRange.upper);
    const naiveSim = simulateRange(future, ivl.range.low, ivl.range.high);

    evals.push({
      ts,
      ivlScore: ivl.ivlScore,
      classification: ivl.classification,
      action: decision.action,
      breakoutRisk: decision.breakoutRisk,
      ivlSim,
      naiveSim,
    });
  }

  if (evals.length === 0) {
    console.error("No evaluations (insufficient history?).");
    process.exit(1);
  }

  // Global aggregates.
  const agg = (sel) => ({
    timeInRange: mean(evals.map((e) => sel(e).timeInRange)),
    breakoutRate: mean(evals.map((e) => (sel(e).breakout ? 1 : 0))),
    feeEfficiency: mean(evals.map((e) => sel(e).feeEfficiency)),
  });
  const ivlAgg = agg((e) => e.ivlSim);
  const naiveAgg = agg((e) => e.naiveSim);

  // Subset where the skill WOULD deploy (entry rules: score>=60 / concentrate).
  const entered = evals.filter((e) => e.ivlScore >= 60 || e.action === "concentrate");
  const enteredAgg = entered.length
    ? {
        n: entered.length,
        timeInRange: mean(entered.map((e) => e.ivlSim.timeInRange)),
        breakoutRate: mean(entered.map((e) => (e.ivlSim.breakout ? 1 : 0))),
        feeEfficiency: mean(entered.map((e) => e.ivlSim.feeEfficiency)),
      }
    : { n: 0 };

  const result = {
    pair: args.pair,
    params: { lookback: args.lookback, hold: args.hold, step: args.step, scales: args.scales },
    evaluations: evals.length,
    ivl_range: ivlAgg,
    naive_wide_range: naiveAgg,
    fee_efficiency_gain: naiveAgg.feeEfficiency > 0
      ? +(ivlAgg.feeEfficiency / naiveAgg.feeEfficiency).toFixed(3)
      : null,
    when_skill_enters: enteredAgg,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n=== IVL-LP backtest - ${args.pair} ===`);
  console.log(`Evaluations: ${result.evaluations}  (lookback=${args.lookback}, hold=${args.hold} candles, step=${args.step})`);
  console.log(`\n                     time-in-range   breakout-rate   fee-efficiency(fees/width)`);
  console.log(`  IVL range (μ±2σ):     ${(ivlAgg.timeInRange * 100).toFixed(1)}%            ${(ivlAgg.breakoutRate * 100).toFixed(1)}%          ${ivlAgg.feeEfficiency.toFixed(2)}`);
  console.log(`  Naive wide range:     ${(naiveAgg.timeInRange * 100).toFixed(1)}%            ${(naiveAgg.breakoutRate * 100).toFixed(1)}%          ${naiveAgg.feeEfficiency.toFixed(2)}`);
  console.log(`\n  Fee-efficiency gain (IVL vs naive): ${result.fee_efficiency_gain ?? "n/a"}x`);
  if (enteredAgg.n) {
    console.log(`\n  When the skill ENTERS (score>=60 or concentrate) [${enteredAgg.n} cases]:`);
    console.log(`    time-in-range=${(enteredAgg.timeInRange * 100).toFixed(1)}%  breakout=${(enteredAgg.breakoutRate * 100).toFixed(1)}%  fee-efficiency=${enteredAgg.feeEfficiency.toFixed(2)}`);
  } else {
    console.log(`\n  The skill did not enter any window (market not suitable per IVL).`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
