// Data charts for real pools: hand-built SVG in the drafting style, drawn in with anime.js, with a
// pointer crosshair. Labels hang off leader lines; the with/without gap is written as a dimension.

import { useEffect, useMemo, useRef, useState } from "react";
import { animate, stagger } from "animejs";
import { fmtPrice } from "./ui";
import { DUR, EASE, drawIn, pathOf, reducedMotion } from "./motion";
import { Callout } from "./diagram/Callout";
import { Dimension } from "./diagram/Dimension";

/** Pointer → nearest index along the x axis, in viewBox units. */
function useScrub(ref: React.RefObject<SVGSVGElement | null>, W: number, x0: number, x1: number, n: number) {
  const [i, setI] = useState<number | null>(null);
  const on = {
    onPointerMove: (e: React.PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      setI(Math.max(0, Math.min(n - 1, Math.round(((x - x0) / (x1 - x0)) * (n - 1)))));
    },
    onPointerLeave: () => setI(null),
  };
  return [i, on] as const;
}

/** Push label rows apart so none sit closer than `gap`, keeping their order. */
function spread(ys: number[], gap: number, lo: number, hi: number) {
  const idx = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array(ys.length);
  let prev = -Infinity;
  for (const [y, i] of idx) {
    const v = Math.max(y, prev + gap);
    out[i] = v;
    prev = v;
  }
  const over = prev - hi;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(lo, out[i] - over);
  return out as number[];
}

const Hatch = ({ id }: { id: string }) => (
  <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="6" className="hatch-ivl" />
  </pattern>
);

/* ------------------------------------------------------------------------------------------------
 * Pool price (hourly, 7 days) with the IVL band and the observed channel.
 * ---------------------------------------------------------------------------------------------- */
export function PriceBandChart({
  series,
  band,
  channel,
}: {
  series: [number, number][];
  band: { lower: number; upper: number };
  channel?: { low: number; high: number };
}) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 780;
  const H = 330;
  const P = { l: 70, r: 178, t: 24, b: 34 };
  const pts = useMemo(() => series.filter((s) => s[1] > 0), [series]);
  const geo = useMemo(() => {
    const ys = pts.map((s) => s[1]);
    const lo = Math.min(...ys, band.lower, channel?.low ?? Infinity) * 0.998;
    const hi = Math.max(...ys, band.upper, channel?.high ?? -Infinity) * 1.002;
    const t0 = pts[0][0];
    const t1 = pts.at(-1)![0];
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
    const y = (v: number) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const days = [];
    for (let t = Math.ceil(t0 / 864e5) * 864e5; t <= t1; t += 864e5) days.push(t);
    return { x, y, ticks, days, line: pathOf(pts.map(([t, v]) => [x(t), y(v)])) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, band.lower, band.upper, channel?.low, channel?.high]);

  useEffect(() => {
    drawIn(ref.current, { duration: 1800 });
    if (reducedMotion() || !ref.current) return;
    animate(ref.current.querySelectorAll(".pb-band, .pb-channel"), { scaleY: [0, 1], opacity: [0, 1], duration: DUR.l, delay: stagger(150, { start: 500 }), ease: EASE.out });
    animate(ref.current.querySelectorAll(".co"), { opacity: [0, 1], duration: DUR.m, delay: stagger(120, { start: 1400 }) });
  }, [geo]);

  const [hover, on] = useScrub(ref, W, P.l, W - P.r, pts.length);
  const last = pts.at(-1)!;
  const hp = hover != null ? pts[hover] : null;
  const xr = W - P.r;
  const widthPct = ((band.upper - band.lower) / ((band.upper + band.lower) / 2)) * 100;

  const labels = [
    { a: [xr, geo.y(band.upper)] as [number, number], label: "band ↑", value: fmtPrice(band.upper), on: true },
    { a: [geo.x(last[0]), geo.y(last[1])] as [number, number], label: "now", value: fmtPrice(last[1]) },
    { a: [xr, geo.y(band.lower)] as [number, number], label: "band ↓", value: fmtPrice(band.lower), on: true },
    ...(channel
      ? [
          { a: [xr - 60, geo.y(channel.high)] as [number, number], label: "R", value: fmtPrice(channel.high) },
          { a: [xr - 60, geo.y(channel.low)] as [number, number], label: "S", value: fmtPrice(channel.low) },
        ]
      : []),
  ];
  const rows = spread(labels.map((l) => l.a[1]), 20, P.t, H - P.b);

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Pool price over the last 7 days with the IVL band" {...on}>
      <defs>
        <Hatch id="pb-hatch" />
      </defs>
      {geo.ticks.map((v, i) => (
        <g key={i}>
          <line x1={P.l} x2={xr} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
          <line x1={P.l - 6} x2={P.l} y1={geo.y(v)} y2={geo.y(v)} className="axis-tick" />
          <text x={P.l - 10} y={geo.y(v) + 4} className="axis" textAnchor="end">
            {fmtPrice(v)}
          </text>
        </g>
      ))}
      <line x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} className="axis-line" />
      <line x1={P.l} x2={xr} y1={H - P.b} y2={H - P.b} className="axis-line" />
      {geo.days.map((t) => (
        <g key={t}>
          <line x1={geo.x(t)} x2={geo.x(t)} y1={H - P.b} y2={H - P.b + 6} className="axis-tick" />
          <text x={geo.x(t)} y={H - 10} className="axis" textAnchor="middle">
            {new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </text>
        </g>
      ))}
      {channel && (
        <g className="pb-channel" style={{ transformOrigin: "center", transformBox: "fill-box" }}>
          <line x1={P.l} x2={xr} y1={geo.y(channel.high)} y2={geo.y(channel.high)} />
          <line x1={P.l} x2={xr} y1={geo.y(channel.low)} y2={geo.y(channel.low)} />
        </g>
      )}
      <g className="pb-band" style={{ transformOrigin: "center", transformBox: "fill-box" }}>
        <rect x={P.l} width={xr - P.l} y={geo.y(band.upper)} height={Math.max(1, geo.y(band.lower) - geo.y(band.upper))} fill="url(#pb-hatch)" />
        <line x1={P.l} x2={xr} y1={geo.y(band.upper)} y2={geo.y(band.upper)} />
        <line x1={P.l} x2={xr} y1={geo.y(band.lower)} y2={geo.y(band.lower)} />
      </g>
      <Dimension a={[P.l + 14, geo.y(band.upper)]} b={[P.l + 14, geo.y(band.lower)]} off={0} label={`${widthPct.toFixed(widthPct < 1 ? 2 : 1)}%`} size={11} tone="ivl" />
      <path d={geo.line} className="price" data-draw />
      <circle cx={geo.x(last[0])} cy={geo.y(last[1])} r="3.5" className="price-head" />
      {labels.map((l, i) => (
        <Callout key={l.label} a={l.a} y={rows[i]} x={W - 4} side="right" label={l.label} value={l.value} active={l.on} size={11} />
      ))}
      {hp && (
        <g className="xhair">
          <line x1={geo.x(hp[0])} x2={geo.x(hp[0])} y1={P.t} y2={H - P.b} />
          <circle cx={geo.x(hp[0])} cy={geo.y(hp[1])} r="3.5" />
          <g transform={`translate(${Math.min(geo.x(hp[0]) + 10, xr - 150)},${P.t + 4})`}>
            <rect width="146" height="40" />
            <text x="10" y="17" className="xh-k">
              {new Date(hp[0]).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit" })}
            </text>
            <text x="10" y="32" className="xh-v">
              {fmtPrice(hp[1])} {hp[1] >= band.lower && hp[1] <= band.upper ? "· in band" : "· out of band"}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------------
 * With and without IVL: cumulative net (fees − IL − rebalancing) per strategy, same history.
 * ---------------------------------------------------------------------------------------------- */
export function NetCurves({
  curves,
  fromTs,
  toTs,
  delta,
}: {
  curves: { key: string; label: string; values: number[]; tone: "ivl" | "fixed" | "random" }[];
  fromTs: number;
  toTs: number;
  /** The with/without gap, written on a dimension between the two end points. */
  delta?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 780;
  const H = 340;
  const P = { l: 16, r: 200, t: 24, b: 32 };
  const n = Math.max(...curves.map((c) => c.values.length));
  const geo = useMemo(() => {
    const all = curves.flatMap((c) => c.values);
    const lo = Math.min(0, ...all);
    const hi = Math.max(0, ...all);
    const pad = (hi - lo) * 0.08 || 1;
    const x = (i: number) => P.l + (i / (n - 1 || 1)) * (W - P.l - P.r);
    const y = (v: number) => P.t + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - P.t - P.b);
    return { x, y, lines: curves.map((c) => ({ ...c, d: pathOf(c.values.map((v, i) => [x(i), y(v)])) })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curves, n]);

  useEffect(() => {
    drawIn(ref.current, { duration: 2200 });
    if (reducedMotion() || !ref.current) return;
    animate(ref.current.querySelectorAll(".curve-label, .curve-end, .dim"), { opacity: [0, 1], duration: DUR.m, delay: stagger(220, { start: 1800 }), ease: EASE.out });
  }, [geo]);

  const [hover, on] = useScrub(ref, W, P.l, W - P.r, n);
  const fmtD = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const tAt = (i: number) => fromTs + ((toTs - fromTs) * i) / (n - 1 || 1);
  const xEnd = W - P.r;
  const ivl = curves.find((c) => c.key === "ivl");
  const fixed = curves.find((c) => c.key === "fixed");
  const ends = geo.lines.map((l) => geo.y(l.values.at(-1)!));
  const rows = spread(ends, 18, P.t, H - P.b);
  let dim = null;
  if (delta && ivl && fixed) {
    // Measured from just past the curve labels, so the extension lines don't run through them.
    const x0 = xEnd + 122;
    const a: [number, number] = [x0, geo.y(fixed.values.at(-1)!)];
    const b: [number, number] = [x0, geo.y(ivl.values.at(-1)!)];
    const nx = -(b[1] - a[1]) || 1;
    dim = <Dimension a={a} b={b} off={(W - 34 - x0) * Math.sign(nx)} label={delta} tone="ivl" size={12} />;
  }

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Cumulative net with and without IVL" {...on}>
      <defs>
        <Hatch id="nc-hatch" />
      </defs>
      {Array.from({ length: 13 }, (_, i) => (
        <line key={i} x1={P.l + (i * (xEnd - P.l)) / 12} x2={P.l + (i * (xEnd - P.l)) / 12} y1={H - P.b} y2={H - P.b + (i % 3 ? 4 : 8)} className="axis-tick" />
      ))}
      <line x1={P.l} x2={xEnd} y1={H - P.b} y2={H - P.b} className="axis-line" />
      <line x1={P.l} x2={xEnd} y1={geo.y(0)} y2={geo.y(0)} className="zero" />
      {rows.every((r) => Math.abs(r - geo.y(0)) > 14) && (
        <text x={xEnd + 30} y={geo.y(0) + 4} className="axis">
          break-even
        </text>
      )}
      <text x={P.l} y={H - 8} className="axis">
        {fmtD(fromTs)}
      </text>
      <text x={xEnd} y={H - 8} className="axis" textAnchor="end">
        {fmtD(toTs)}
      </text>
      {geo.lines.map((l, i) => (
        <g key={l.key}>
          <path d={l.d} className={`curve ${l.tone}`} data-draw />
          <circle cx={xEnd} cy={ends[i]} r="3" className={`curve-end ${l.tone}`} />
          <path d={`M${xEnd + 4},${ends[i]}L${xEnd + 18},${rows[i]}L${xEnd + 26},${rows[i]}`} className="curve-lead curve-label" />
          <text x={xEnd + 30} y={rows[i] + 4} className={`curve-label ${l.tone}`}>
            {l.label}
          </text>
        </g>
      ))}
      {dim}
      {hover != null && (
        <g className="xhair">
          <line x1={geo.x(hover)} x2={geo.x(hover)} y1={P.t} y2={H - P.b} />
          {geo.lines.map((l) => (l.values[hover] != null ? <circle key={l.key} cx={geo.x(hover)} cy={geo.y(l.values[hover])} r="3" className={`xh-dot ${l.tone}`} /> : null))}
          <g transform={`translate(${Math.min(geo.x(hover) + 10, xEnd - 150)},${P.t + 2})`}>
            <rect width="140" height={22 + geo.lines.length * 16} />
            <text x="10" y="17" className="xh-k">
              {new Date(tAt(hover)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </text>
            {geo.lines.map((l, i) => (
              <text key={l.key} x="10" y={34 + i * 16} className={`xh-v ${l.tone}`}>
                {l.label}: {l.values[hover]?.toFixed(2) ?? "–"}
              </text>
            ))}
          </g>
        </g>
      )}
    </svg>
  );
}
