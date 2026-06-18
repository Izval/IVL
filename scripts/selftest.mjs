#!/usr/bin/env node
// selftest.mjs - Deterministic validation of IVL over synthetic scenarios.
//
// Does not depend on the live market: generates controlled series and verifies the
// fundamental properties of the metric:
//   1. Polarity:   healthy oscillation (uses the whole channel) -> high IVL/high score.
//                  asymmetric compression                       -> low IVL/low score.
//   2. Fractality: when scales disagree (tight range inside a wide one),
//                  fractal consistency penalizes the score.
//
// Run: node selftest.mjs   (exit 0 = all assertions pass)

import { computeIVL, scaleMetrics } from "./ivl-core.mjs";
import { decideLP } from "./ivl-strategy.mjs";

const SCALES = ["15m", "1h", "4h", "1d"];

/** Generates N candles whose close follows closeFn(k), with consistent OHLC and volume. */
function gen(n, closeFn, vol = 1000, tsStep = 900_000) {
  const out = [];
  let prev = closeFn(0);
  for (let k = 0; k < n; k++) {
    const c = closeFn(k);
    const o = prev;
    const h = Math.max(o, c) * 1.0005;
    const l = Math.min(o, c) * 0.9995;
    out.push({ ts: k * tsStep, o, h, l, c, vol });
    prev = c;
  }
  return out;
}

const mid = 100;
const amp = 1.5; // channel of ±1.5% approx

// Scenario A - healthy oscillation: price traverses the whole channel smoothly on each
// scale with the SAME range (fractally consistent). Many slow cycles.
function healthy(cycles) {
  return (k, n) => mid + amp * Math.sin((2 * Math.PI * cycles * k) / n);
}

// Scenario B - asymmetric compression: amplitude decays and price drifts to one edge.
function compressed(k, n) {
  const decay = 1 - k / n; // narrowing over time
  return mid + amp * 0.9 + amp * 0.3 * decay * Math.sin((2 * Math.PI * 6 * k) / n);
}

function buildScales(fn, n = 120) {
  const out = {};
  for (const s of SCALES) out[s] = gen(n, (k) => fn(k, n));
  return out;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

console.log("\n=== IVL self-test (synthetic scenarios) ===\n");

// --- Scenario A: healthy oscillation, fractally consistent ---
const A = buildScales((k, n) => healthy(3)(k, n));
const ivlA = computeIVL(A, { primaryScale: "15m" });
const decA = decideLP(ivlA, { candlesPrimary: A["15m"] });
console.log(`A) Healthy oscillation:  score=${ivlA.ivlScore} (${ivlA.classification}) IVL_raw=${ivlA.ivl.raw_primary.toFixed(4)} fractal=${ivlA.ivl.fractal.toFixed(3)} action=${decA.action}`);

// --- Scenario B: asymmetric compression ---
const B = buildScales((k, n) => compressed(k, n));
const ivlB = computeIVL(B, { primaryScale: "15m" });
const decB = decideLP(ivlB, { candlesPrimary: B["15m"] });
console.log(`B) Asymmetric compress:  score=${ivlB.ivlScore} (${ivlB.classification}) IVL_raw=${ivlB.ivl.raw_primary.toFixed(4)} fractal=${ivlB.ivl.fractal.toFixed(3)} action=${decB.action}`);

// --- Scenario C: fractal discrepancy (tight 15m inside a wide channel on 4h/1d) ---
const C = buildScales((k, n) => healthy(3)(k, n));
// Replace 4h and 1d with a much wider channel (trend/large range) at the same center.
C["4h"] = gen(120, (k) => mid + 8 * Math.sin((2 * Math.PI * 1 * k) / 120));
C["1d"] = gen(120, (k) => mid + 12 * Math.sin((2 * Math.PI * 0.5 * k) / 120));
const ivlC = computeIVL(C, { primaryScale: "15m" });
console.log(`C) Fractal discrepancy:  score=${ivlC.ivlScore} (${ivlC.classification}) fractal=${ivlC.ivl.fractal.toFixed(3)}`);

console.log("\n--- Assertions ---");

// Polarity: healthy > compression, in both IVL_raw and score.
assert(ivlA.ivl.raw_primary > ivlB.ivl.raw_primary, "IVL_raw(healthy) > IVL_raw(compression)  [polarity: high=good]");
assert(ivlA.ivlScore > ivlB.ivlScore, "score(healthy) > score(compression)");

// Compression must never recommend concentrating liquidity.
assert(decB.action !== "concentrate", "compression does NOT recommend 'concentrate'");

// Single-scale sanity: full oscillation yields high IVL_raw.
const single = scaleMetrics(A["15m"]);
assert(single.ivlRaw > 0.1, `healthy single scale has high IVL_raw (=${single.ivlRaw.toFixed(3)})`);

// Fractality: discrepancy between scales penalizes the score vs the consistent case.
assert(ivlC.ivl.fractal < ivlA.ivl.fractal, "fractal(discrepant) < fractal(consistent)");
assert(ivlC.ivlScore < ivlA.ivlScore, "score(discrepant) < score(consistent)  [intrinsic fractality]");

console.log(
  process.exitCode ? "\n✗ There are failed assertions.\n" : "\n✓ All assertions passed.\n"
);
