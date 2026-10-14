// Multi-timeframe: four scales on one price axis. Each lane draws its own candles and the [S, R] it
// sees; the strip on the right stacks those ranges so agreement (or the lack of it) is visible at a
// glance. Switching scenario re-flows every candle into its new place, and the score is re-composed
// from D, P and F underneath.

import { useEffect, useMemo, useRef, useState } from "react";
import { animate, createTimeline, stagger, type JSAnimation } from "animejs";
import { SCALES, WEIGHTS, timeframes, type Scenario } from "../sim";
import { ActionTag, Segmented } from "../ui";
import { Ruler } from "../diagram/Ruler";
import { SectionHead } from "./SectionHead";
import { DUR, EASE, reducedMotion, useInView, useOnce } from "../motion";

const W = 760;
const LANE = 66;
const GAP = 20;
const TOP = 10;
const H = TOP + SCALES.length * (LANE + GAP) - GAP + 26;
const CX0 = 92;
const CX1 = 590;
const SX0 = 630;
const SW = 18;

const SCN: Record<Scenario, { label: string; note: string }> = {
  aligned: {
    label: "Scales agree",
    note: "Fifteen-minute, hourly, 4-hour and daily candles all see the same channel. The range is real at every zoom, so IVL trusts it.",
  },
  nested: {
    label: "The nested trap",
    note: "The short scales look calm, but they sit inside a range the daily candles see trending. One timeframe alone would have said “concentrate”.",
  },
};

export function Measure() {
  const geo = useMemo(() => ({ aligned: geometry("aligned"), nested: geometry("nested") }), []);
  const [k, setK] = useState<Scenario>("aligned");
  const g = geo[k];
  const base = geo.aligned;
  const svgRef = useRef<SVGSVGElement>(null);
  const sec = useRef<HTMLElement>(null);
  const fNum = useRef<HTMLSpanElement>(null);
  const first = useRef(true);

  // Entrance: lanes slide in one after another, then their candles grow out of the midline.
  useOnce(svgRef, () => {
    const root = svgRef.current!;
    if (reducedMotion()) return;
    const tl = createTimeline({ defaults: { ease: EASE.out } });
    tl.add(root.querySelectorAll(".tf-lane-bg"), { opacity: [0, 1], translateX: [-24, 0], duration: DUR.m, delay: stagger(110) }, 0)
      .add(root.querySelectorAll(".tf-label"), { opacity: [0, 1], translateX: [-10, 0], duration: DUR.m, delay: stagger(110) }, 80)
      .add(root.querySelectorAll(".tf-c"), { scaleY: [0, 1], opacity: [0, 1], duration: DUR.m, delay: stagger(9, { grid: [SCALES.length, g.lanes[0].candles.length], from: "first" }) }, 200)
      .add(root.querySelectorAll(".tf-sr"), { opacity: [0, 1], duration: DUR.m, delay: stagger(110) }, 700)
      .add(root.querySelectorAll(".tf-bar"), { scaleY: [0, 1], duration: DUR.l, delay: stagger(120), ease: EASE.pop }, 900)
      .add(root.querySelector(".tf-agree")!, { opacity: [0, 1], scaleX: [0.3, 1], duration: DUR.l }, 1400);
  });

  // While the figure is on screen it keeps reading: the scan sweeps the four scales and, at the end of
  // each sweep, the scenario flips (agree ↔ nested trap) so the ranges, the strip and F re-compose.
  // It pauses off screen, and stops flipping once the visitor picks a scenario.
  const visible = useInView(svgRef);
  const manual = useRef(false);
  const sweep = useRef<JSAnimation | null>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    sweep.current = animate(svgRef.current!.querySelector(".tf-scan")!, {
      translateX: [0, CX1 - CX0],
      duration: 5200,
      ease: "inOut(2)",
      loop: true,
      alternate: true,
      autoplay: false,
      onLoop: () => {
        if (!manual.current) setK((x) => (x === "aligned" ? "nested" : "aligned"));
      },
    });
    return () => void sweep.current?.revert();
  }, []);
  useEffect(() => {
    if (!sweep.current) return;
    if (visible) sweep.current.play();
    else sweep.current.pause();
  }, [visible]);

  // Scenario switch: every candle, range and bar moves to its new place.
  useEffect(() => {
    const root = svgRef.current!;
    if (first.current) {
      first.current = false;
      return;
    }
    // Attributes in the JSX stay at the first scenario; anime owns them from here on.
    const set = (sel: string, list: Record<string, number>[], o: { stagger?: number; ease?: unknown; duration?: number } = {}) =>
      root.querySelectorAll(sel).forEach((el, i) => {
        if (reducedMotion()) return Object.entries(list[i]).forEach(([a, v]) => el.setAttribute(a, String(v)));
        animate(el, { ...list[i], duration: o.duration ?? 900, ease: (o.ease as string) ?? EASE.inOut, delay: ((i % N) + Math.floor(i / N) * 3) * (o.stagger ?? 0) });
      });
    const N = g.lanes[0].candles.length;
    set(".tf-c rect", g.lanes.flatMap((l) => l.candles.map((c) => ({ y: c.y, height: c.h }))), { stagger: 9 });
    set(".tf-c line", g.lanes.flatMap((l) => l.candles.map((c) => ({ y1: c.wy1, y2: c.wy2 }))), { stagger: 9 });
    set(".tf-sr", g.lanes.map((l) => ({ y: l.srY, height: l.srH })));
    set(".tf-bar", g.bars.map((b) => ({ y: b.y, height: b.h })), { ease: EASE.settle, duration: 1100, stagger: 0 });
    set(".tf-agree", [{ y: g.agree.y, height: g.agree.h }]);
    if (fNum.current && !reducedMotion()) {
      const v = { f: Number(fNum.current.textContent) };
      animate(v, { f: g.f, duration: 1100, ease: EASE.expo, onUpdate: () => (fNum.current!.textContent = v.f.toFixed(2)) });
    }
  }, [g]);

  return (
    <section className="wrap section" id="method" ref={sec}>
      <SectionHead title="One score, three inseparable parts." />

      <div className="formula" data-reveal>
        <p className="formula-eq mono" aria-label="IVL equals 100 times D to the 0.5 times P to the 0.2 times F to the 0.3">
          IVL <i>=</i> 100 <i>×</i> D<sup>0.5</sup> <i>×</i> P<sup>0.2</sup> <i>×</i> F<sup>0.3</sup>
        </p>
        <div className="formula-terms">
          {TERMS.map((t) => (
            <div key={t.k} className="term">
              <span className="term-k mono">
                <b>{t.k}</b> · {t.name}
              </span>
              <p>{t.text}</p>
              <code className="mono">{t.code}</code>
            </div>
          ))}
        </div>
        <p className="formula-foot">
          A weighted <strong>geometric</strong> mean: any weak part drags the whole score down. High dispersion can't rescue a
          range the other timeframes don't confirm.{" "}
          <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer" className="link">
            Full method ↗
          </a>
        </p>
      </div>

      <div className="tf" data-reveal>
        <div className="lab-top">
          <h3 className="fig-h">One timeframe alone can lie.</h3>
          <Segmented small value={k} onChange={(v) => ((manual.current = true), setK(v))} options={(Object.keys(SCN) as Scenario[]).map((s) => ({ value: s, label: SCN[s].label }))} />
        </div>
        <p className="tf-note" key={k}>
          {SCN[k].note}
        </p>

        <div className="hscroll">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="tf-svg" role="img" aria-label="Four timeframes and the price range each one sees">
            <defs>
              <pattern id="tf-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" className="hatch-ivl" />
              </pattern>
            </defs>
            {base.lanes.map((l, i) => (
              <g key={l.s}>
                <rect className="tf-lane-bg" x={CX0 - 8} y={l.top} width={CX1 - CX0 + 16} height={LANE} />
                <rect className="tf-sr" x={CX0 - 8} width={CX1 - CX0 + 16} y={l.srY} height={l.srH} />
                <g className="tf-label">
                  <text x={0} y={l.top + 28} className="tf-scale">
                    {l.s}
                  </text>
                  <text x={0} y={l.top + 46} className="tf-w">
                    w {WEIGHTS[l.s].toFixed(2)}
                  </text>
                </g>
                {l.candles.map((c, j) => (
                  <g key={j} className={`tf-c ${g.lanes[i].candles[j].up ? "up" : "dn"}`} style={{ transformOrigin: `${c.x}px ${l.top + LANE / 2}px` }}>
                    <line x1={c.x} x2={c.x} y1={c.wy1} y2={c.wy2} />
                    <rect x={c.x - c.w / 2} y={c.y} width={c.w} height={c.h} />
                  </g>
                ))}
                <line className="tf-bar-link" x1={CX1 + 8} x2={SX0 + i * (SW + 8)} y1={l.top + LANE / 2} y2={l.top + LANE / 2} />
              </g>
            ))}
            <rect className="tf-scan" x={CX0} y={TOP - 4} width="1" height={H - TOP - 22} />
            <rect className="tf-agree" x={SX0 - 8} width={SCALES.length * (SW + 8) + 8} y={base.agree.y} height={base.agree.h} fill="url(#tf-hatch)" style={{ transformOrigin: "left", transformBox: "fill-box" }} />
            {base.bars.map((b, i) => (
              <rect key={i} className="tf-bar" x={SX0 + i * (SW + 8)} width={SW} y={b.y} height={b.h} style={{ transformOrigin: "bottom", transformBox: "fill-box" }} />
            ))}
            {SCALES.map((s, i) => (
              <text key={s} x={SX0 + i * (SW + 8) + SW / 2} y={H - 6} className="tf-w" textAnchor="middle">
                {s}
              </text>
            ))}
          </svg>
        </div>

        <div className="anat mono">
          <span className="anat-term">
            D <b>{g.d.toFixed(2)}</b>
            <sup>.5</sup>
          </span>
          <i>×</i>
          <span className="anat-term">
            P <b>{g.p.toFixed(2)}</b>
            <sup>.2</sup>
          </span>
          <i>×</i>
          <span className={`anat-term ${g.f < 0.5 ? "weak" : ""}`}>
            F <b ref={fNum}>{geo.aligned.f.toFixed(2)}</b>
            <sup>.3</sup>
          </span>
          <i>=</i>
          <span className="anat-ruler">
            <Ruler value={g.score} size="md" />
          </span>
          <ActionTag action={g.action} short />
        </div>
      </div>
    </section>
  );
}

const TERMS = [
  {
    k: "D",
    name: "dispersion",
    text: "Volume-weighted variance of price around its VWAP, over the channel's width squared. Price that fills the channel is healthy; price pressed to one edge is not.",
    code: "σ² / (R − S)²",
  },
  {
    k: "P",
    name: "persistence",
    text: "The share of closes that stay inside the core channel, instead of poking out and coming back.",
    code: "closes ∈ μ ± W/2",
  },
  {
    k: "F",
    name: "fractality",
    text: "Whether 15-minute, hourly, 4-hour and daily candles agree on the same [S, R]. A tight range inside a trend fails here.",
    code: "IoU[S, R] over 15m · 1h · 4h · 1d",
  },
];

function geometry(kind: Scenario) {
  const t = timeframes(kind);
  const all = SCALES.flatMap((s) => t.byScale[s]);
  const lo = Math.min(...all.map((c) => c.l));
  const hi = Math.max(...all.map((c) => c.h));
  const pad = (hi - lo) * 0.08;
  const L = lo - pad;
  const Hh = hi + pad;
  const lanes = SCALES.map((s, i) => {
    const top = TOP + i * (LANE + GAP);
    const y = (v: number) => top + 4 + (1 - (v - L) / (Hh - L)) * (LANE - 8);
    const cs = t.byScale[s];
    const step = (CX1 - CX0) / cs.length;
    const r = t.ranges[i];
    return {
      s,
      top,
      srY: y(r.R),
      srH: Math.max(1, y(r.S) - y(r.R)),
      candles: cs.map((c, j) => {
        const a = y(Math.max(c.o, c.c));
        const b = y(Math.min(c.o, c.c));
        return { x: CX0 + step * (j + 0.5), w: Math.max(2, step * 0.56), y: a, h: Math.max(1.2, b - a), wy1: y(c.h), wy2: y(c.l), up: c.c >= c.o };
      }),
    };
  });
  // Strip: every scale's [S, R] on one tall axis, and the band they all share.
  const sy = (v: number) => TOP + (1 - (v - L) / (Hh - L)) * (H - TOP - 30);
  const bars = t.ranges.map((r) => ({ y: sy(r.R), h: Math.max(2, sy(r.S) - sy(r.R)) }));
  const iS = Math.max(...t.ranges.map((r) => r.S));
  const iR = Math.min(...t.ranges.map((r) => r.R));
  const agree = iR > iS ? { y: sy(iR), h: sy(iS) - sy(iR) } : { y: sy((iS + iR) / 2), h: 1 };
  return { lanes, bars, agree, score: t.score, d: t.d, p: t.p, f: t.f, action: t.action };
}

