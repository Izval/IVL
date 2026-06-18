#!/usr/bin/env node
// ivl.mjs - CLI for the IVL skill.
//
// Computes the integrated (intrinsically multi-scale) IVL of a pair, its classification,
// the suggested LP range, and emits the backtestable SPEC as JSON.
//
// Usage:
//   node ivl.mjs --pair BNB-USDT --lookback 120
//   node ivl.mjs --pair BNB-AAVE --scales 15m,1h,4h,1d --equity 5000 --json
//
// No API key required (public Binance candles). CMC is the optional signal layer documented
// in SKILL.md; this CLI uses candles only to stay self-contained and reproducible.

import { computeIVL, DEFAULT_SCALES, horizonLookbacks, computeVWAP, weightedVariance } from "./ivl-core.mjs";
import { decideLP, buildBacktestSpec } from "./ivl-strategy.mjs";
import { detectLateralBlock, findBestLateralBlock, projectLP, correlationFactor } from "./ivl-lp.mjs";
import { exhaustionSignal } from "./ivl-signal.mjs";
import { rangeToTicks } from "./ivl-ticks.mjs";
import { getKlinesMultiScale, getCrossLegs } from "./binance.mjs";

function parseArgs(argv) {
  const args = { pair: "BNB-USDT", lookback: 120, scales: DEFAULT_SCALES, equity: 10000,
    delta: 0.16, tvl: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pair") args.pair = argv[++i];
    else if (a === "--lookback") args.lookback = parseInt(argv[++i], 10);
    else if (a === "--scales") args.scales = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--equity") args.equity = parseFloat(argv[++i]);
    else if (a === "--delta") args.delta = parseFloat(argv[++i]);
    else if (a === "--tvl") args.tvl = parseFloat(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node ivl.mjs --pair BNB-USDT [--lookback 120] [--scales 15m,1h,4h,1d] [--delta 0.16] [--tvl 100000] [--equity 10000] [--json]"
      );
      process.exit(0);
    }
  }
  return args;
}

function fmt(n, d = 4) {
  return typeof n === "number" ? n.toFixed(d) : String(n);
}

async function main() {
  const args = parseArgs(process.argv);
  // Match the time horizon across scales (15m/1h/4h/1d look at the same wall-clock window).
  const lookbacks = horizonLookbacks(args.scales[0], args.lookback, args.scales);
  const usableScales = args.scales.filter((s) => lookbacks[s] > 0);
  const candlesByScale = await getKlinesMultiScale(args.pair, usableScales, lookbacks);

  const ivl = computeIVL(candlesByScale, { primaryScale: args.scales[0] });
  if (!ivl.ok) {
    console.error("Could not compute IVL:", ivl.reason);
    process.exit(1);
  }

  const decision = decideLP(ivl, { candlesPrimary: candlesByScale[ivl.primaryScale] });
  const spec = buildBacktestSpec({
    pair: args.pair,
    primaryTimeframe: ivl.primaryScale,
    scales: args.scales,
    ivl,
    decision,
    equity: args.equity,
  });

  // Correlation factor (variable/variable pairs): returns of the two legs vs USDT.
  const corrLegs = await getCrossLegs(args.pair, ivl.primaryScale, args.lookback);
  const corr = corrLegs ? correlationFactor(corrLegs.baseLeg, corrLegs.quoteLeg) : null;

  // Breakout exhaustion signal (RSI/MACD/divergence): trigger to place a forward range.
  const primaryCandles = candlesByScale[ivl.primaryScale];
  const exhaustion = exhaustionSignal(primaryCandles);
  const blk = detectLateralBlock(primaryCandles, args.delta);
  let projection = null;
  let blockBand = null;
  if (blk.found) {
    const mu = computeVWAP(blk.block);
    const sigma = Math.sqrt(weightedVariance(blk.block, mu));
    blockBand = { lower: mu - 2 * sigma, upper: mu + 2 * sigma, vwap: mu };
    projection = projectLP(blk.block, blockBand, { S: blk.S, R: blk.R }, ivl.primaryScale, 0.0005, args.tvl);
  }

  if (args.json) {
    const correlation = corr !== null ? { pair: `${corrLegs.base}/${corrLegs.quote}`, value: corr } : null;
    console.log(JSON.stringify({ ivl, decision, spec, correlation, exhaustion, block: blk, blockBand, projection }, null, 2));
    return;
  }

  // Human-readable output. Price convention the LP sees on screen: "{quote} per 1 {base}".
  const [bAsset, qAsset] = args.pair.replace("/", "-").toUpperCase().split("-");
  const pxLabel = qAsset ? `${qAsset} per 1 ${bAsset}` : "price";
  console.log(`\n=== IVL - ${args.pair} (primary scale: ${ivl.primaryScale}) ===`);
  console.log(`Prices in: ${pxLabel}  (v3 ticks are for on-chain execution only)`);
  console.log(`IVL Score:        ${ivl.ivlScore}/100  (${ivl.classification})`);
  console.log(`Primary IVL_raw:  ${fmt(ivl.ivl.raw_primary, 5)}   [high≈0.25 healthy · low≈0.01 risk]`);
  console.log(`Components:        dispersion=${fmt(ivl.ivl.dispersion)} · persistence=${fmt(ivl.ivl.persistence)} · fractal=${fmt(ivl.ivl.fractal)}`);
  console.log(`Observed range:   [${fmt(ivl.range.low)} , ${fmt(ivl.range.high)}]  (W/S=${fmt(ivl.range.widthPct, 4)})`);
  console.log(`LP range (μ±2σ):  [${fmt(ivl.lpRange.lower)} , ${fmt(ivl.lpRange.upper)}]  VWAP=${fmt(ivl.lpRange.vwap)}`);
  console.log(`Estimated LVR:    ${fmt(ivl.lvr.arb, 6)}  (${ivl.lvr.level})`);
  if (corr !== null) {
    const q = corr > 0.6 ? "high (stable ratio)" : corr > 0.2 ? "medium" : corr > -0.2 ? "low (volatile ratio)" : "negative";
    console.log(`Correlation ${corrLegs.base}/${corrLegs.quote}: ${fmt(corr, 3)}  ${q}`);
  }
  console.log(`Scales confirming range:  ${ivl.scalesConfirming.join(", ") || "(no lateral scale)"}`);
  console.log("\n--- Per scale ---");
  for (const s of args.scales) {
    const m = ivl.metricsByScale[s];
    if (!m?.valid) {
      console.log(`  ${s}: (insufficient data)`);
      continue;
    }
    console.log(
      `  ${s.padEnd(4)} IVL_raw=${fmt(m.ivlRaw, 4)} dispScore=${fmt(m.dispersionScore)} persist=${fmt(m.persistence)} lateral=${m.isLateral} range=[${fmt(m.S)},${fmt(m.R)}]`
    );
  }
  console.log(`\n--- Breakout exhaustion (RSI/MACD) ---`);
  console.log(
    `  RSI=${exhaustion.rsi ?? "-"}  exhausted=${exhaustion.exhausted}${exhaustion.strong ? " (strong)" : ""}  direction=${exhaustion.direction ?? "-"}  ${exhaustion.reasons.join(", ") || "no signals"}`
  );
  if (exhaustion.exhausted) {
    const w = (args.delta * 100).toFixed(0);
    const guide =
      exhaustion.direction === "bearish"
        ? `floor≈exhaustion (bottom), ceiling≈prior resistance`
        : exhaustion.direction === "bullish"
        ? `ceiling≈exhaustion (top), floor≈prior support`
        : `ceiling and floor at the exhaustion extremes`;
    console.log(`  → The ${exhaustion.direction === "bearish" ? "bearish" : exhaustion.direction === "bullish" ? "bullish" : ""} breakout is exhausting: do NOT chase price; wait for lateralization and place a forward range (${guide}, width≈${w}%).`);
  }
  console.log(`\n--- LP decision: ${decision.action.toUpperCase()} ---`);
  console.log(`  ${decision.rationale}`);
  console.log(`  Breakout risk: ${decision.breakoutRisk}`);
  console.log(`\n--- Spec (sizing) ---`);
  console.log(
    `  Allocation: ${(spec.position_sizing.alloc_fraction * 100).toFixed(1)}% of equity = $${spec.position_sizing.position_usd}`
  );

  const renderBlock = (label, b, band, proj) => {
    console.log(`\n--- ${label} (δ=${args.delta}) ---`);
    console.log(`  Adjusted range:   [${fmt(b.S)} , ${fmt(b.R)}]  width=${(b.widthPct * 100).toFixed(1)}%`);
    console.log(`  Block duration:   ${b.durationCandles} ${ivl.primaryScale} candles (${proj.block_days} days)`);
    const tk = rangeToTicks(band.lower, band.upper, 0.0005);
    // What the LP enters on screen: prices (min/max). If they snap to ticks, those are the real ones.
    const pMin = tk ? tk.priceLower : band.lower;
    const pMax = tk ? tk.priceUpper : band.upper;
    console.log(`  ► LP range (price, ${pxLabel}):  min ${fmt(pMin)}  ·  max ${fmt(pMax)}  (VWAP ${fmt(band.vwap)})`);
    if (tk) console.log(`     ↳ on-chain v3 (fee 0.05%): tickLower ${tk.tickLower} · tickUpper ${tk.tickUpper} (spacing ${tk.tickSpacing})`);
    console.log(`  Concentration:    ${proj.concentration_factor}× vs full block range`);
    console.log(`  Expected duration: ~${proj.expected_duration_days} days in range (${proj.expected_candles_in_range} candles)`);
    console.log(
      `  Yield:            ${proj.est_fee_apr != null ? proj.est_fee_apr + "% APR (TVL=$" + proj.tvl_assumed + ")" : "pass --tvl <USD> for APR · gross block fees=" + proj.gross_fees_block}`
    );
  };

  if (blk.found) {
    renderBlock("Current lateral block", blk, blockBand, projection);
  } else {
    console.log(`\n--- Current lateral block (δ=${args.delta}) ---`);
    console.log(`  No block ≤ ${(args.delta * 100).toFixed(0)}% anchored to the current price (the pair broke out / is trending).`);
    // Find the best historical block to study the pair's shape/duration.
    const best = findBestLateralBlock(primaryCandles, args.delta);
    if (best.found) {
      const mu = computeVWAP(best.block);
      const sigma = Math.sqrt(weightedVariance(best.block, mu));
      const band = { lower: mu - 2 * sigma, upper: mu + 2 * sigma, vwap: mu };
      const proj = projectLP(best.block, band, { S: best.S, R: best.R }, ivl.primaryScale, 0.0005, args.tvl);
      renderBlock("Best historical block", best, band, proj);
    }
  }
  console.log(`\n(use --json for the full backtestable spec)\n`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
