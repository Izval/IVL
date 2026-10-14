// ExplodedReading.tsx - one IVL reading taken apart, like an exploded engineering drawing.
//
// Four sheets, one per timeframe (1d at the back, 15m at the front), share a single price axis; each
// shows its own candles and the [S, R] it sees. A fifth sheet in front is the result: the 15m path,
// its VWAP, the occupancy histogram and the μ ± 2σ band IVL would deploy. The timeline `t` runs from
// "exploded" to "assembled": as the sheets close up, ranges that agree land on top of each other, and
// the score composes from D, P and F. Every number comes from the real engine (sim.timeframes).

import { useMemo } from "react";
import { histogram, SCALES, timeframes, WEIGHTS, type Candle, type Scenario } from "../sim";
import { along, fx, iso, onSheet, sheet, strip, type Pt } from "./iso";
import { Callout } from "./Callout";

export const VB = { w: 1400, h: 860 };
const UW = 410;
const VH = 200;
const GAP_OPEN = 98;
const GAP_SHUT = 15;
// Origin of the middle sheet: the stack opens and closes around it, so the assembled drawing lands
// where the exploded one was centered.
const O: Pt = [670, 672];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export type ReadingData = ReturnType<typeof buildReading>;

export function buildReading(kind: Scenario) {
  const t = timeframes(kind);
  const order = [...SCALES].reverse(); // 1d, 4h, 1h, 15m: back to front
  const c15 = t.byScale["15m"];
  const vol = c15.reduce((a, c) => a + c.vol, 0);
  const vwap = c15.reduce((a, c) => a + c.c * c.vol, 0) / vol;
  const sd = Math.sqrt(c15.reduce((a, c) => a + c.vol * (c.c - vwap) ** 2, 0) / vol);
  const band = { lower: vwap - 2 * sd, upper: vwap + 2 * sd };
  const all = SCALES.flatMap((s) => t.byScale[s]);
  const lo = Math.min(...all.map((c) => c.l), band.lower);
  const hi = Math.max(...all.map((c) => c.h), band.upper);
  const pad = (hi - lo) * 0.06;
  const v = (p: number) => 6 + ((p - (lo - pad)) / (hi - lo + 2 * pad)) * (VH - 12);
  const r15 = t.ranges.find((r) => r.s === "15m")!;
  const layers = order.map((s) => {
    const r = t.ranges.find((x) => x.s === s)!;
    return { s, weight: WEIGHTS[s], candles: t.byScale[s], S: r.S, R: r.R };
  });
  return {
    kind,
    layers,
    v,
    vwap,
    band,
    S15: r15.S,
    R15: r15.R,
    hist: histogram(c15, r15.S, r15.R, 12),
    close: c15.map((c, i) => [((i + 0.5) / c15.length) * UW, v(c.c)] as [number, number]),
    score: t.score,
    d: t.d,
    p: t.p,
    f: t.f,
    action: t.action,
    overlap: { S: Math.max(...t.ranges.map((r) => r.S)), R: Math.min(...t.ranges.map((r) => r.R)) },
  };
}

/** Where along the timeline each part is (0..1), shared with the readout next to the figure. */
export function phases(t: number) {
  return {
    build: clamp01(t / 0.3),
    labels: clamp01((t - 0.18) / 0.14),
    close: ease(clamp01((t - 0.42) / 0.36)),
    d: clamp01((t - 0.5) / 0.08),
    p: clamp01((t - 0.6) / 0.08),
    f: clamp01((t - 0.7) / 0.08),
    result: clamp01((t - 0.8) / 0.12),
  };
}

function Candles({ o, cs, v }: { o: Pt; cs: Candle[]; v: (p: number) => number }) {
  const step = UW / cs.length;
  let wicks = "";
  let up = "";
  let dn = "";
  cs.forEach((c, j) => {
    const u = step * (j + 0.5);
    wicks += `M${fx(iso(o, u, v(c.l)))}L${fx(iso(o, u, v(c.h)))}`;
    const body = `M${fx(iso(o, u, v(Math.min(c.o, c.c))))}L${fx(iso(o, u, v(Math.max(c.o, c.c)) + 0.6))}`;
    if (c.c >= c.o) up += body;
    else dn += body;
  });
  return (
    <g>
      <path d={wicks} className="xr-wick" />
      <path d={up} className="xr-body up" style={{ strokeWidth: Math.max(2, Math.min(7, step * 0.45)) }} />
      <path d={dn} className="xr-body dn" style={{ strokeWidth: Math.max(2, Math.min(7, step * 0.45)) }} />
    </g>
  );
}

/** Sheet label printed along the top edge, sheared with the sheet. */
function SheetTag({ o, text, cls = "" }: { o: Pt; text: string; cls?: string }) {
  const p = iso(o, 8, VH + 8);
  return (
    <text className={`xr-tag ${cls}`} transform={`translate(${fx(p)}) rotate(-30)`}>
      {text}
    </text>
  );
}

export function ExplodedReading({ data, t, compact = false }: { data: ReadingData; t: number; compact?: boolean }) {
  const ph = phases(t);
  const gap = GAP_OPEN + (GAP_SHUT - GAP_OPEN) * ph.close;
  const { v } = data;
  const n = data.layers.length;

  // Each sheet slides in from further back as it appears, then rides the closing gap.
  const origin = (k: number): Pt => {
    const appear = clamp01(ph.build * (n + 1) - k);
    const [dx, dy] = along((k - n / 2) * gap - (1 - ease(appear)) * 70);
    return [O[0] + dx, O[1] + dy];
  };
  const alpha = (k: number) => clamp01(ph.build * (n + 1) - k);
  const front = origin(n);

  const histPaths = useMemo(() => {
    const step = (v(data.R15) - v(data.S15)) / data.hist.length;
    return data.hist.map((h, i) => ({ v0: v(data.S15) + i * step + 1, v1: v(data.S15) + (i + 1) * step - 1, len: h * 74 }));
  }, [data, v]);

  // Callouts. Right side: rows top to bottom, anchors left to right, so leaders never cross.
  const L = data.layers;
  const o = L.map((_, k) => origin(k));
  const rows = (y0: number, k: number) => y0 + k * 31;
  const fmt = (x: number) => x.toFixed(2);
  const right = [
    { a: iso(o[0], UW * 0.86, v(L[0].R)), label: "F · fractality", value: ph.f > 0 ? fmt(data.f) : undefined, on: ph.f > 0 && ph.f < 1 },
    { a: iso(o[2], UW * 0.62, v((L[2].S + L[2].R) / 2)), label: "P · persistence", value: ph.p > 0 ? fmt(data.p) : undefined, on: ph.p > 0 && ph.p < 1 },
    { a: iso(o[3], UW * 0.36, v(data.R15)), label: "R · resistance", on: false },
    { a: iso(front, UW * 0.56, v(data.vwap)), label: "μ · VWAP", on: false },
    { a: iso(front, UW * 0.78, v(Math.min(data.band.upper, data.R15 + (data.R15 - data.S15) * 0.6))), label: "band  μ ± 2σ", on: ph.result > 0 },
    { a: iso(front, UW - 30, v(data.R15) - 6), label: "D · dispersion σ²/(R−S)²", value: ph.d > 0 ? fmt(data.d) : undefined, on: ph.d > 0 && ph.d < 1 },
  ];
  // Small screens: crop to the drawing and print only callout numbers (a legend follows the figure).
  const box = { x: 480, y: 40, w: VB.w - 480, h: 770 };
  const rowsR = right.map((_, k) => rows(compact ? 50 : 64, k * (compact ? 1.3 : 1)));
  const xR = box.x + box.w - 30;

  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} className="xr" role="img" aria-label={`Exploded IVL reading: four timeframes, IVL score ${data.score}`}>
      <defs>
        <pattern id="xr-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" className="xr-hatch-line" />
        </pattern>
      </defs>

      {/* stack axis: a center line through the sheets, drafting style */}
      <path d={`M${fx(iso([o[0][0] - 60, o[0][1] - 35], 0, VH / 2))}L${fx(iso([front[0] + 60, front[1] + 35], 0, VH / 2))}`} className="xr-axis" />

      {L.map((l, k) => (
        <g key={l.s} style={{ opacity: alpha(k) }}>
          <path d={sheet(o[k], UW, VH)} className="xr-sheet" />
          <path d={strip(o[k], UW, v(l.S), v(l.R))} className="xr-sr" />
          <path d={`${onSheet(o[k], [[0, v(l.R)], [UW, v(l.R)]])}${onSheet(o[k], [[0, v(l.S)], [UW, v(l.S)]])}`} className="xr-srline" />
          <Candles o={o[k]} cs={l.candles} v={v} />
          <g style={{ opacity: 1 - ph.close }}>
            <SheetTag o={o[k]} text={`${l.s} · ${l.candles.length} candles`} />
          </g>
          {/* tick marks along the time edge */}
          <path
            d={Array.from({ length: 9 }, (_, i) => `M${fx(iso(o[k], (i * UW) / 8, 0))}L${fx(iso(o[k], (i * UW) / 8, -5))}`).join("")}
            className="xr-ticks"
          />
        </g>
      ))}

      {/* the result sheet */}
      <g style={{ opacity: alpha(n) }} className="xr-result">
        <path d={sheet(front, UW, VH)} className="xr-sheet front" />
        <path d={strip(front, UW, v(data.band.lower), v(data.band.upper))} className="xr-band" style={{ opacity: 0.25 + 0.75 * ph.result }} />
        <path
          d={`${onSheet(front, [[0, v(data.band.upper)], [UW, v(data.band.upper)]])}${onSheet(front, [[0, v(data.band.lower)], [UW, v(data.band.lower)]])}`}
          className="xr-bandline"
          style={{ opacity: 0.3 + 0.7 * ph.result }}
        />
        <path d={onSheet(front, [[0, v(data.overlap.R)], [UW, v(data.overlap.R)]])} className="xr-overlap" style={{ opacity: ph.close }} />
        <path d={onSheet(front, [[0, v(data.overlap.S)], [UW, v(data.overlap.S)]])} className="xr-overlap" style={{ opacity: ph.close }} />
        <path d={onSheet(front, [[0, v(data.vwap)], [UW, v(data.vwap)]])} className="xr-vwap" />
        {histPaths.map((h, i) => (
          <path key={i} d={`M${fx(iso(front, UW - h.len, h.v0))}L${fx(iso(front, UW, h.v0))}L${fx(iso(front, UW, h.v1))}L${fx(iso(front, UW - h.len, h.v1))}Z`} className="xr-hist" />
        ))}
        <path d={onSheet(front, data.close)} className="xr-close" />
        <SheetTag o={front} text={`IVL ${data.score} · ${data.action === "withdraw_or_widen" ? "widen" : data.action}`} cls="ivl" />
      </g>

      <g style={{ opacity: ph.labels }}>
        {right.map((c, k) => (
          <Callout key={c.label} a={c.a} y={rowsR[k]} x={xR} side="right" label={c.label} value={c.value} active={c.on} n={k + 1} numbered={compact} />
        ))}
      </g>
    </svg>
  );
}

/** Plain-text legend for small screens, where the figure shows only the callout numbers. */
export function legend(data: ReadingData) {
  return [
    `F · fractality ${data.f.toFixed(2)}: do the scales agree on [S, R]`,
    `P · persistence ${data.p.toFixed(2)}: share of closes inside the channel`,
    "R · resistance, the top of the observed channel",
    "μ · VWAP, the volume-weighted center",
    "band μ ± 2σ: where IVL would place liquidity",
    `D · dispersion ${data.d.toFixed(2)}: σ² / (R − S)², how fully price fills the channel`,
  ];
}
