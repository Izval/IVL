// "Same width, opposite risk": one channel, three ways for price to live in it. Switching morphs the
// path, the occupancy histogram, the VWAP and the IVL_raw needle together, so the cause and the
// number move as one.

import { useEffect, useMemo, useRef, useState } from "react";
import { animate } from "animejs";
import { shapeReading, type Shape } from "../sim";
import { ActionTag, Segmented } from "../ui";
import { Dimension } from "../diagram/Dimension";
import { Ruler } from "../diagram/Ruler";
import { SectionHead } from "./SectionHead";
import { DUR, EASE, lerpPts, reducedMotion, smoothPath, useInView } from "../motion";

const W = 720;
const H = 300;
const X0 = 96;
const X1 = 560;
const HX0 = 586;
const HX1 = 690;
const YT = 56;
const YB = 250;

const MODES: { k: Shape; label: string; action: string; title: string; text: string }[] = [
  {
    k: "split",
    label: "Edge to edge",
    action: "concentrate",
    title: "Price lives at both edges",
    text: "Every crossing pays a fee and the channel keeps holding. Variance is near its ceiling, so IVL concentrates liquidity into μ ± 2σ.",
  },
  {
    k: "sweep",
    label: "Smooth sweep",
    action: "hold",
    title: "Price fills the channel evenly",
    text: "A healthy range, but it spends as much time in the middle as near the edges. IVL holds the observed channel and keeps watching.",
  },
  {
    k: "edge",
    label: "Pressed to one edge",
    action: "withdraw_or_widen",
    title: "Same width, coiled against the top",
    text: "Volatility and width look identical. But price is compressing against resistance, and that precedes a breakout. IVL widens or steps out.",
  },
];

export function RangeLab() {
  const data = useMemo(() => Object.fromEntries(MODES.map((m) => [m.k, geometry(m.k)])) as Record<Shape, Geo>, []);
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const mode = MODES[i];
  const g = data[mode.k];

  const box = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const vwap = useRef<SVGGElement>(null);
  const bars = useRef<(SVGRectElement | null)[]>([]);
  const cur = useRef<Geo>(data[MODES[0].k]);
  const inView = useInView(box);

  // Morph the path, the VWAP and the histogram from what is on screen to the selected shape.
  useEffect(() => {
    const from = cur.current;
    const to = g;
    const apply = (t: number) => {
      const pts = lerpPts(from.pts, to.pts, t);
      path.current?.setAttribute("d", smoothPath(pts));
      const vy = from.vwapY + (to.vwapY - from.vwapY) * t;
      vwap.current?.setAttribute("transform", `translate(0 ${vy.toFixed(1)})`);
      to.hist.forEach((h, k) => bars.current[k]?.setAttribute("width", String(Math.max(1, (from.hist[k] + (h - from.hist[k]) * t) * (HX1 - HX0)))));
      cur.current = { ...to, pts, vwapY: vy, hist: from.hist.map((v, k) => v + (to.hist[k] - v) * t) };
    };
    if (reducedMotion()) return apply(1);
    const p = { t: 0 };
    const a = animate(p, { t: 1, duration: DUR.l + 200, ease: EASE.inOut, onUpdate: () => apply(p.t) });
    return () => void a.pause();
  }, [g]);

  // Auto-advance while on screen, until the visitor takes over.
  useEffect(() => {
    if (!auto || !inView || reducedMotion()) return;
    const id = setTimeout(() => setI((x) => (x + 1) % MODES.length), 5200);
    return () => clearTimeout(id);
  }, [i, auto, inView]);

  return (
    <section className="wrap section" id="problem">
      <SectionHead title="Two ranges can have the same width and opposite risk.">
        Inside your range you earn fees; outside it you stop earning and carry the loss. Volatility, width and volume can't tell
        these apart. How price <em>occupies</em> the range can.
      </SectionHead>

      <div className="lab" ref={box} data-reveal>
        <div className="lab-top">
          <Segmented
            small
            value={mode.k}
            onChange={(k) => {
              setAuto(false);
              setI(MODES.findIndex((m) => m.k === k));
            }}
            options={MODES.map((m) => ({ value: m.k, label: m.label }))}
          />
        </div>

        <div className="lab-body">
          <svg viewBox={`0 0 ${W} ${H}`} className="lab-svg" role="img" aria-label={mode.title}>
            <rect x={X0} y={YT} width={X1 - X0} height={YB - YT} className="lab-ch" />
            <line x1={X0 - 8} x2={HX1} y1={YT} y2={YT} className="lab-rail" />
            <line x1={X0 - 8} x2={HX1} y1={YB} y2={YB} className="lab-rail" />
            {Array.from({ length: 11 }, (_, k) => (
              <line key={k} x1={X0 + (k * (X1 - X0)) / 10} x2={X0 + (k * (X1 - X0)) / 10} y1={YB} y2={YB + (k % 5 ? 4 : 8)} className="lab-tick" />
            ))}
            <Dimension a={[X0 - 8, YT]} b={[X0 - 8, YB]} off={46} label="W" size={12} />
            <text x={X0 - 14} y={YT + 4} className="lab-axis" textAnchor="end">
              R
            </text>
            <text x={X0 - 14} y={YB + 4} className="lab-axis" textAnchor="end">
              S
            </text>
            <text x={X0} y={YT - 14} className="lab-axis">
              price · 120 × 15m
            </text>
            <text x={HX0} y={YT - 14} className="lab-axis">
              time at price
            </text>
            <text x={X0} y={YB + 26} className="lab-axis">
              same W in all three cases
            </text>
            <g ref={vwap} transform={`translate(0 ${data[MODES[0].k].vwapY})`}>
              <line x1={X0} x2={X1} y1={0} y2={0} className="lab-vwap" />
              <text x={X1 + 6} y={4} className="lab-axis">
                μ
              </text>
            </g>
            <path ref={path} className="lab-line" />
            <g>
              {g.hist.map((_, k) => (
                <rect
                  key={k}
                  ref={(el) => void (bars.current[k] = el)}
                  x={HX0}
                  y={YB - ((k + 1) * (YB - YT)) / g.hist.length + 1.5}
                  height={(YB - YT) / g.hist.length - 3}
                  className="lab-bar"
                />
              ))}
            </g>
          </svg>

          <div className="lab-side">
            <div className="lab-read">
              <span className="lab-k mono">
                IVL<sub>raw</sub> = σ² / (R − S)²
              </span>
              <Ruler
                value={g.raw}
                max={0.25}
                dp={3}
                size="md"
                marks={[
                  { at: 0, label: "0" },
                  { at: 0.1, label: "0.10 hold" },
                  { at: 0.18, label: "0.18 conc." },
                  { at: 0.25, label: "0.25" },
                ]}
              />
            </div>
            <div className="lab-verdict" key={mode.k}>
              <ActionTag action={mode.action} />
              <h3>{mode.title}</h3>
              <p>{mode.text}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

type Geo = { pts: number[][]; vwapY: number; hist: number[]; raw: number };

function geometry(k: Shape): Geo {
  const r = shapeReading(k);
  const n = r.candles.length;
  const y = (v: number) => YB - ((v - r.S) / (r.R - r.S)) * (YB - YT);
  return {
    pts: r.candles.map((c, i) => [X0 + (i / (n - 1)) * (X1 - X0), y(c.c)]),
    vwapY: y(r.vwap),
    hist: r.hist,
    raw: r.raw,
  };
}
