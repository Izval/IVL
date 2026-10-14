// sim.ts - synthetic markets for the landing's live figures. Every number shown is the real IVL engine
// (../../../scripts) run on these candles; only the candles are made up.

import { computeIVL as computeIVLjs, scaleMetrics as scaleMetricsJs } from "../../../scripts/ivl-core.mjs";
import { decideLP as decideLPjs } from "../../../scripts/ivl-strategy.mjs";

// The engine is plain JS; its results are read field by field below.
/* eslint-disable @typescript-eslint/no-explicit-any */
const computeIVL = computeIVLjs as (byScale: Record<string, Candle[]>, opts?: Record<string, unknown>) => any;
const scaleMetrics = scaleMetricsJs as (c: Candle[], opts?: Record<string, unknown>) => any;
const decideLP = decideLPjs as (ivl: any, ctx?: Record<string, unknown>) => any;

export type Candle = { ts: number; o: number; h: number; l: number; c: number; vol: number };
export type Action = "concentrate" | "hold" | "withdraw_or_widen";
export type Regime = "range" | "press" | "breakout" | "settle";

export type Reading = {
  score: number;
  raw: number;
  d: number;
  p: number;
  f: number;
  action: Action;
  lvr: string;
  S: number;
  R: number;
  vwap: number;
  band: { lower: number; upper: number };
  hist: number[];
};

const M15 = 15 * 60_000;

export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Group consecutive candles into a higher timeframe. */
export function group(c: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = c.length % n; i + n <= c.length; i += n) {
    const g = c.slice(i, i + n);
    out.push({
      ts: g[0].ts,
      o: g[0].o,
      c: g[n - 1].c,
      h: Math.max(...g.map((x) => x.h)),
      l: Math.min(...g.map((x) => x.l)),
      vol: g.reduce((a, x) => a + x.vol, 0),
    });
  }
  return out;
}

/** Occupancy histogram of closes inside [S, R]. */
export function histogram(c: Candle[], S: number, R: number, bins = 14) {
  const h = new Array(bins).fill(0);
  for (const x of c) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((x.c - S) / (R - S || 1)) * bins)));
    h[i] += x.vol;
  }
  const max = Math.max(...h, 1e-9);
  return h.map((v) => v / max);
}

/** IVL reading of a 15m window, with 1h and 4h built from it (same horizon, as the engine expects). */
export function read(w: Candle[], gamma = 0.0005): Reading | null {
  const byScale: Record<string, Candle[]> = { "15m": w, "1h": group(w, 4), "4h": group(w, 16) };
  if (byScale["4h"].length < 6) delete byScale["4h"];
  const ivl = computeIVL(byScale, { primaryScale: "15m", gamma, delta: 0.05 });
  if (!ivl.ok) return null;
  const dec = decideLP(ivl, { candlesPrimary: w });
  const S = ivl.range.low;
  const R = ivl.range.high;
  return {
    score: ivl.ivlScore,
    raw: ivl.ivl.raw_primary,
    d: ivl.ivl.dispersion,
    p: ivl.ivl.persistence,
    f: ivl.ivl.fractal,
    action: dec.action,
    lvr: ivl.lvr.level,
    S,
    R,
    vwap: ivl.lpRange.vwap,
    band: { lower: dec.lpRange.lower ?? S, upper: dec.lpRange.upper ?? dec.lpRange.high ?? R },
    hist: histogram(w, S, R),
  };
}

/**
 * A market that keeps living through IVL's story: a healthy range, compression against one edge,
 * a breakout, and a new range forming at the new level.
 */
export class LiveMarket {
  candles: Candle[] = [];
  regime: Regime = "range";
  private rnd: () => number;
  private left = 0;
  private center = 1;
  private phase = 0;
  private period = 28;
  private dir = 1;
  private edge = 1;
  private price = 1;
  private readonly amp = 0.0055;

  constructor(seed = 11, warm = 120) {
    this.rnd = seeded(seed);
    this.enter("range", 150);
    for (let i = 0; i < warm; i++) this.step();
  }

  private noise(k: number) {
    return (this.rnd() - 0.5) * 2 * k;
  }

  private enter(r: Regime, n: number) {
    this.regime = r;
    this.left = n;
    if (r === "press") this.edge = this.rnd() > 0.5 ? 1 : -1;
    if (r === "breakout") this.dir = this.edge;
    if (r === "settle") {
      this.center = this.price * (1 - this.dir * this.amp * 0.6);
      this.phase = this.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  private next(): Regime {
    return ({ range: "press", press: "breakout", breakout: "settle", settle: "range" } as const)[this.regime];
  }

  step(): Candle {
    if (this.left-- <= 0) {
      const r = this.next();
      this.enter(r, { range: 120, press: 64, breakout: 9, settle: 70 }[r]);
    }
    const o = this.price;
    let target: number;
    let vol = 0.8 + this.rnd() * 0.6;
    if (this.regime === "range" || this.regime === "settle") {
      const before = Math.sin(this.phase);
      this.phase += (2 * Math.PI) / this.period;
      const s = Math.sin(this.phase);
      // a new rhythm every half-cycle, so the range breathes instead of ticking like a metronome
      if (Math.sign(s) !== Math.sign(before)) this.period = 22 + this.rnd() * 16;
      target = this.center * (1 + this.amp * Math.sign(s) * Math.abs(s) ** 0.07 * (0.97 + this.rnd() * 0.03));
      this.price += (target - this.price) * 0.62 + this.price * this.noise(0.00022);
    } else if (this.regime === "press") {
      target = this.center * (1 + this.edge * this.amp * 0.86);
      this.price += (target - this.price) * 0.3 + this.price * this.noise(0.00012);
      vol *= 0.6;
    } else {
      this.price *= 1 + this.dir * (0.016 + this.rnd() * 0.01);
      vol *= 2.6;
    }
    const c = this.price;
    const candle: Candle = {
      ts: (this.candles.at(-1)?.ts ?? 0) + M15,
      o,
      c,
      h: Math.max(o, c) * (1 + this.rnd() * 0.00012),
      l: Math.min(o, c) * (1 - this.rnd() * 0.00012),
      vol,
    };
    this.candles.push(candle);
    if (this.candles.length > 400) this.candles.splice(0, 100);
    return candle;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Fixed scenarios for the explainer figures.
 * ---------------------------------------------------------------------------------------------- */

const series = (n: number, f: (i: number, r: () => number) => number, seed: number, wick = 0.0006): Candle[] => {
  const r = seeded(seed);
  const out: Candle[] = [];
  let prev = f(0, r);
  for (let i = 0; i < n; i++) {
    const c = f(i, r);
    out.push({ ts: i * M15, o: prev, c, h: Math.max(prev, c) * (1 + r() * wick), l: Math.min(prev, c) * (1 - r() * wick), vol: 0.8 + r() * 0.6 });
    prev = c;
  }
  return out;
};

export type Shape = "sweep" | "edge" | "split";

/** One channel, three ways to occupy it (the "same width, opposite risk" figure). */
export function shape(kind: Shape, n = 120): Candle[] {
  const A = 0.01;
  if (kind === "sweep")
    return series(n, (i, r) => 1 + A * Math.sin(i / 3.1) * 0.94 + (r() - 0.5) * A * 0.12, 3);
  if (kind === "split")
    return series(n, (i, r) => 1 + A * Math.sign(Math.sin(i / 5)) * (0.9 + r() * 0.1) * Math.min(1, Math.abs(Math.sin(i / 5)) * 4), 5);
  return series(n, (i, r) => {
    const t = i / n;
    // pressed to the top edge, compressing as it goes: a coil
    return 1 + A * (0.72 + 0.18 * Math.sin(i / 2.3) * (1 - t) + (r() - 0.5) * 0.12) - (i < 6 ? A * (1.7 - i * 0.28) : 0);
  }, 9);
}

export function shapeReading(kind: Shape) {
  const c = shape(kind);
  const m = scaleMetrics(c, { delta: 0.05 });
  return { candles: c, raw: m.ivlRaw as number, S: m.S as number, R: m.R as number, vwap: m.mu as number, hist: histogram(c, m.S, m.R, 16) };
}

export type Scenario = "aligned" | "nested";
export const SCALES = ["15m", "1h", "4h", "1d"] as const;
export const WEIGHTS: Record<string, number> = { "15m": 0.2, "1h": 0.35, "4h": 0.3, "1d": 0.15 };

/**
 * Four timeframes over the same horizon. "aligned": every scale sees the same channel.
 * "nested": the short scales look calm inside a range the long scales see trending (the trap).
 */
export function timeframes(kind: Scenario) {
  const N = 28;
  const A = kind === "aligned" ? 0.004 : 0.012;
  const make = (k: number, seed: number) =>
    kind === "aligned"
      ? series(N, (i, r) => {
          // the primary scale moves gently (low LVR); the slower scales sit at the same two edges
          const s = Math.sin(k === 0 ? i / 2.6 : i / (0.9 + k * 0.25) + k);
          return 1 + A * Math.sign(s) * Math.abs(s) ** (k === 0 ? 0.12 : 0.15) * (0.97 + r() * 0.03);
        }, seed, 0.00025)
      : k < 2
        ? series(N, (i, r) => 1 + A * (1.2 + 0.32 * Math.sin(i / (1.2 + k * 0.6)) + (r() - 0.5) * 0.1), seed, 0.0008)
        : series(N, (i, r) => 1 + A * (-2.4 + (4 * i) / N + (k === 3 ? 0.8 : 0.35) * Math.sin(i / 1.4) + (r() - 0.5) * 0.25), seed, 0.002);
  const byScale: Record<string, Candle[]> = {};
  SCALES.forEach((s, k) => (byScale[s] = make(k, 21 + k * 7)));
  const ivl = computeIVL(byScale, { primaryScale: "15m", delta: 0.05 });
  const ranges = SCALES.map((s) => ({ s, S: ivl.metricsByScale[s].S as number, R: ivl.metricsByScale[s].R as number }));
  return {
    byScale,
    ranges,
    score: ivl.ivlScore as number,
    d: ivl.ivl.dispersion as number,
    p: ivl.ivl.persistence as number,
    f: ivl.ivl.fractal as number,
    action: decideLP(ivl).action as Action,
  };
}
