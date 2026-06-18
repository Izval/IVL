#!/usr/bin/env node
// scan.mjs - Walks a pair's history and reports the windows with the highest IVL Score.
// Useful for (a) finding real high-IVL periods in history, (b) exporting a window
// to CSV as a reproducible demo fixture.
//
// Usage:
//   node scan.mjs --pair BNB-USDT --lookback 120 --top 5
//   node scan.mjs --pair BNB-USDT --export ../data/bnbusdt_range.csv   # exports the best window (15m)

import { computeIVL, DEFAULT_SCALES, horizonLookbacks } from "./ivl-core.mjs";
import { decideLP } from "./ivl-strategy.mjs";
import { getKlinesSmart } from "./binance.mjs";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const a = { pair: "BNB-USDT", lookback: 120, top: 5, history: 1000, step: 4, export: null,
    scales: [...DEFAULT_SCALES] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pair") a.pair = argv[++i];
    else if (k === "--lookback") a.lookback = parseInt(argv[++i], 10);
    else if (k === "--top") a.top = parseInt(argv[++i], 10);
    else if (k === "--history") a.history = parseInt(argv[++i], 10);
    else if (k === "--step") a.step = parseInt(argv[++i], 10);
    else if (k === "--export") a.export = argv[++i];
  }
  return a;
}

const sliceUpTo = (candles, ts, n) => candles.filter((c) => c.ts <= ts).slice(-n);
const iso = (ts) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

async function main() {
  const args = parseArgs(process.argv);
  const series = {};
  for (const s of args.scales) series[s] = await getKlinesSmart(args.pair, s, Math.min(args.history, 1000));
  const base = series[args.scales[0]];

  const lookbacks = horizonLookbacks(args.scales[0], args.lookback, args.scales);
  const usableScales = args.scales.filter((s) => lookbacks[s] > 0);

  const windows = [];
  for (let i = args.lookback; i < base.length; i += args.step) {
    const ts = base[i].ts;
    const cbs = {};
    for (const s of usableScales) cbs[s] = sliceUpTo(series[s], ts, lookbacks[s]);
    if (cbs[args.scales[0]].length < args.lookback) continue;
    const ivl = computeIVL(cbs, { primaryScale: args.scales[0] });
    if (!ivl.ok) continue;
    const dec = decideLP(ivl, cbs[args.scales[0]]);
    windows.push({ i, ts, score: ivl.ivlScore, cls: ivl.classification, action: dec.action,
      raw: ivl.ivl.raw_primary, fractal: ivl.ivl.fractal });
  }
  windows.sort((a, b) => b.score - a.score);

  console.log(`\n=== IVL scan - ${args.pair} (${windows.length} windows) ===`);
  console.log(`Top ${args.top} by IVL Score:`);
  for (const w of windows.slice(0, args.top)) {
    console.log(`  ${iso(w.ts)}  score=${w.score} (${w.cls})  raw=${w.raw.toFixed(4)} fractal=${w.fractal.toFixed(3)} action=${w.action}`);
  }
  const best = windows[0];
  console.log(`\nBest: ${iso(best.ts)}  score=${best.score} (${best.cls})`);

  if (args.export) {
    // Exports the best-scoring 15m window as CSV (ts,o,h,l,c,vol).
    const w = sliceUpTo(base, best.ts, args.lookback);
    const csv = "ts,o,h,l,c,vol\n" + w.map((c) => `${c.ts},${c.o},${c.h},${c.l},${c.c},${c.vol}`).join("\n");
    writeFileSync(args.export, csv);
    console.log(`Exported: ${args.export} (${w.length} 15m candles, score=${best.score})`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
