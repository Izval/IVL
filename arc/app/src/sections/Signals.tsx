import { useRef } from "react";
import { animate, createTimeline, stagger } from "animejs";
import { DUR, EASE, reducedMotion, useOnce } from "../motion";

const CARDS = [
  {
    k: "concentrate",
    tone: "good",
    name: "Concentrate",
    when: "IVL raw ≥ 0.18 and LVR low",
    band: "μ_vwap ± 2σ",
    text: "Price oscillates harmonically inside the channel. A narrow band right where it lives earns the most fees per dollar.",
    bandY: [46, 74],
  },
  {
    k: "hold",
    tone: "warn",
    name: "Hold",
    when: "0.10 ≤ IVL raw < 0.18",
    band: "observed channel [S, R]",
    text: "An acceptable range with no clear edge. Keep the observed channel, don't chase price, and re-read on the next block.",
    bandY: [34, 86],
  },
  {
    k: "withdraw_or_widen",
    tone: "risk",
    name: "Widen / stay out",
    when: "IVL raw < 0.10 or LVR high",
    band: "VWAP ± 2.5·ATR14, or exit",
    text: "Compression against an edge, or arbitrage eating the fees. Widen far enough to survive the break, or wait in stables.",
    bandY: [14, 106],
  },
];

export function Signals() {
  const grid = useRef<HTMLDivElement>(null);
  useOnce(grid, () => {
    if (reducedMotion()) return;
    const root = grid.current!;
    const tl = createTimeline({ defaults: { ease: EASE.out } });
    tl.add(root.querySelectorAll(".sig-band"), { scaleY: [0, 1], duration: DUR.l, delay: stagger(140), ease: EASE.pop }, 200).add(
      root.querySelectorAll(".sig-price"),
      { strokeDashoffset: [400, 0], duration: DUR.xl, delay: stagger(140), ease: EASE.inOut },
      0
    );
  });
  const pulse = (el: Element | null) => el && !reducedMotion() && animate(el, { scaleY: [1, 1.18, 1], duration: 900, ease: EASE.settle });

  return (
    <section className="wrap sub-section" id="signals">
      <div className="sub-head" data-reveal="stagger">
        <h3>A score is only useful if it tells you what to do.</h3>
        <p className="muted">
          The decision is taken on the primary scale's raw IVL and the pool's LVR, then turned into a band of ticks for the
          pool's fee tier. You can always adjust it.
        </p>
      </div>
      <div className="sig-grid" ref={grid} data-reveal="stagger">
        {CARDS.map((c) => (
          <article key={c.k} className={`sig tone-${c.tone}`} onPointerEnter={(e) => pulse(e.currentTarget.querySelector(".sig-band"))}>
            <svg viewBox="0 0 240 120" className="sig-svg" aria-hidden>
              <defs>
                <pattern id={`sig-h-${c.k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" className={`hatch-${c.tone}`} />
                </pattern>
              </defs>
              <rect className="sig-band" x="0" width="240" y={c.bandY[0]} height={c.bandY[1] - c.bandY[0]} fill={`url(#sig-h-${c.k})`} style={{ transformOrigin: "center", transformBox: "fill-box" }} />
              <line x1="0" x2="240" y1={c.bandY[0]} y2={c.bandY[0]} className="sig-edge" />
              <line x1="0" x2="240" y1={c.bandY[1]} y2={c.bandY[1]} className="sig-edge" />
              <line x1="0" x2="240" y1="34" y2="34" className="sig-rail" />
              <line x1="0" x2="240" y1="86" y2="86" className="sig-rail" />
              <path
                className="sig-price"
                strokeDasharray="400"
                d={
                  c.k === "concentrate"
                    ? "M0,60 C15,40 25,40 35,58 S55,80 70,62 S95,40 110,58 S135,82 150,62 S175,40 190,58 S215,80 240,60"
                    : c.k === "hold"
                      ? "M0,70 C20,40 35,44 50,56 S80,84 100,72 S130,40 150,50 S185,82 205,64 S228,46 240,52"
                      : "M0,62 C20,52 40,44 60,40 S95,38 120,37 S150,38 170,36 S200,22 240,6"
                }
              />
            </svg>
            <div className="sig-body">
              <span className={`tag ${c.tone}`}>
                <i className="tag-dot" />
                {c.name}
              </span>
              <dl className="sig-spec mono">
                <dt>when</dt>
                <dd>{c.when}</dd>
                <dt>band</dt>
                <dd>{c.band}</dd>
              </dl>
              <p className="sig-text">{c.text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
