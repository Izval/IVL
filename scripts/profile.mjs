#!/usr/bin/env node
// profile.mjs - Historical lateralization profile of a pair + suggested forward range.
//
// Use case: the pair is coming off a breakout and starting to enter a range; we want to know,
// by observing how it has lateralized historically (historical IVL), what a good range is now.
//
// Usage:
//   node profile.mjs --pair AAVE-WBNB --scale 1d --history 365 --delta 0.16
//   node profile.mjs --pair BNB-USDT --tvl 100000 --json

import { getKlinesSmart, getCrossLegs } from "./binance.mjs";
import {
  rangeProfile,
  volatilityContraction,
  suggestRange,
  correlationFactor,
} from "./ivl-lp.mjs";

function parseArgs(argv) {
  const a = { pair: "AAVE-WBNB", scale: "1d", history: 365, delta: 0.16, minLen: 8, tvl: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pair") a.pair = argv[++i];
    else if (k === "--scale") a.scale = argv[++i];
    else if (k === "--history") a.history = parseInt(argv[++i], 10);
    else if (k === "--delta") a.delta = parseFloat(argv[++i]);
    else if (k === "--minlen") a.minLen = parseInt(argv[++i], 10);
    else if (k === "--tvl") a.tvl = parseFloat(argv[++i]);
    else if (k === "--json") a.json = true;
  }
  return a;
}

const f = (n, d = 4) => (typeof n === "number" ? n.toFixed(d) : String(n));

async function main() {
  const args = parseArgs(process.argv);
  const candles = await getKlinesSmart(args.pair, args.scale, Math.min(args.history, 1000));
  if (candles.length < args.minLen + 5) {
    console.error("Insufficient history.");
    process.exit(1);
  }
  const price = candles[candles.length - 1].c;

  const profile = rangeProfile(candles, args.delta, args.minLen, args.scale);
  const contraction = volatilityContraction(candles);
  const suggestion = suggestRange(price, profile, args.scale, 0.0005, args.tvl);

  const legs = await getCrossLegs(args.pair, args.scale, Math.min(args.history, 1000));
  const corr = legs ? correlationFactor(legs.baseLeg, legs.quoteLeg) : null;

  if (args.json) {
    console.log(JSON.stringify({ pair: args.pair, price, profile, contraction, suggestion, correlation: corr }, null, 2));
    return;
  }

  console.log(`\n=== Historical lateralization profile - ${args.pair} (${args.scale}) ===`);
  console.log(`Current price: ${f(price)}`);
  if (corr !== null) console.log(`Correlation ${legs.base}/${legs.quote}: ${f(corr, 3)}`);
  console.log(
    `Volatility contraction: ${contraction.contracting ? "YES (entering a range)" : "no"} (ATR7/ATR30=${contraction.ratio})`
  );

  if (!profile.found) {
    console.log("\nNo historical lateral blocks found with these parameters.");
    return;
  }
  console.log(`\nHistorical lateral blocks: ${profile.count}`);
  console.log(`  Typical width:    ${profile.median_width_pct}%`);
  console.log(`  Typical duration: ${profile.median_duration_candles} candles (${profile.median_duration_days} days)`);
  console.log(`  Recurring levels (S/R the pair respects):`);
  for (const l of profile.recurring_levels.slice(0, 6)) {
    console.log(`    ${f(l.level)}  (${l.touches} touches)`);
  }

  console.log(`\n--- Suggested forward range (anchored to ${suggestion.anchored_to}) ---`);
  console.log(`  Expected range:   [${f(suggestion.suggested_range.lower)} , ${f(suggestion.suggested_range.upper)}]  (~${suggestion.typical_width_pct}%)`);
  console.log(`  LP band (ticks):  [${f(suggestion.suggested_lp_band.lower)} , ${f(suggestion.suggested_lp_band.upper)}]`);
  console.log(`  Expected duration: ~${suggestion.expected_duration_days} days`);
  console.log(`  Yield:            ${suggestion.est_fee_apr != null ? "~" + suggestion.est_fee_apr + "% APR (approx)" : "pass --tvl to estimate"}`);
  console.log(`\n  Note: ${suggestion.note}\n`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
