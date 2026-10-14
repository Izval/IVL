// Ruler.tsx - the IVL score read off a 0–100 rule: minor ticks every 5, major every 10, and the
// red marker that eases to the value. Replaces rings and meters: a metric should look measured.

import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { DUR, EASE, reducedMotion } from "../motion";

const BANDS = [
  { at: 0, k: "breakout risk" },
  { at: 20, k: "weak" },
  { at: 40, k: "neutral" },
  { at: 60, k: "good" },
  { at: 80, k: "excellent" },
];

export function Ruler({
  value,
  max = 100,
  size = "md",
  showValue = true,
  scale = false,
  dp = 0,
  instant = false,
  marks,
}: {
  value: number;
  max?: number;
  size?: "sm" | "md" | "lg";
  showValue?: boolean;
  /** Print the classification bands under the rule. */
  scale?: boolean;
  dp?: number;
  /** The caller drives the value every frame (a scrubbed timeline): follow it without easing. */
  instant?: boolean;
  /** Custom labelled marks under the rule (in value units), instead of the score bands. */
  marks?: { at: number; label: string }[];
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const num = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  const pct = Math.max(0, Math.min(1, value / max)) * 100;

  useEffect(() => {
    const m = mark.current;
    const n = num.current;
    if (!m) return;
    const from = last.current;
    last.current = value;
    if (instant || reducedMotion()) {
      m.style.left = `${pct}%`;
      if (n) n.textContent = value.toFixed(dp);
      return;
    }
    const v = { x: from };
    const a = animate(v, {
      x: value,
      duration: DUR.xl,
      ease: EASE.expo,
      onUpdate: () => {
        m.style.left = `${Math.max(0, Math.min(1, v.x / max)) * 100}%`;
        if (n) n.textContent = v.x.toFixed(dp);
      },
    });
    return () => void a.pause();
  }, [value, max, pct, dp, instant]);

  const ticks = Array.from({ length: 21 }, (_, i) => i * 5);
  return (
    <span className={`ruler ruler-${size}`}>
      {showValue && (
        <span className="ruler-n mono" ref={num}>
          0
        </span>
      )}
      <span className="ruler-body">
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
          <line x1="0" x2="100" y1="10" y2="10" className="ruler-base" />
          {ticks.map((t) => (
            <line key={t} x1={t} x2={t} y1={t % 10 === 0 ? (t % 50 === 0 ? 0 : 3) : 6} y2="10" className="ruler-tick" />
          ))}
        </svg>
        <span className="ruler-mark" ref={mark} style={{ left: "0%" }} />
        {marks && (
          <span className="ruler-scale mono">
            {marks.map((m) => (
              <span key={m.at} style={{ left: `${(m.at / max) * 100}%` }} className={m.at >= max ? "end" : m.at > 0 ? "mid" : ""}>
                <b>{m.label}</b>
              </span>
            ))}
          </span>
        )}
        {scale && (
          <span className="ruler-scale mono">
            {BANDS.map((b) => (
              <span key={b.at} style={{ left: `${b.at}%` }}>
                <b>{b.at}</b> {b.k}
              </span>
            ))}
            <span style={{ left: "100%" }} className="end">
              <b>100</b>
            </span>
          </span>
        )}
      </span>
    </span>
  );
}
