import { useLayoutEffect, useRef } from "react";
import { animate } from "animejs";
import { EASE, reducedMotion } from "./motion";

export const fmtUsd = (x?: number | null) =>
  x == null || !Number.isFinite(x)
    ? "–"
    : x >= 1e6
      ? `$${(x / 1e6).toFixed(2)}M`
      : x >= 1e3
        ? `$${(x / 1e3).toFixed(1)}k`
        : `$${x.toFixed(2)}`;

export const fmtPct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Significant-digit price formatting for anything from 1e-8 to 1e8. */
export const fmtPrice = (x?: number | null) =>
  x == null || !Number.isFinite(x)
    ? "–"
    : x >= 1000
      ? x.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : x.toPrecision(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

export const ACTION: Record<string, { label: string; short: string; tone: string }> = {
  concentrate: { label: "Concentrate", short: "Concentrate", tone: "good" },
  hold: { label: "Hold", short: "Hold", tone: "warn" },
  withdraw_or_widen: { label: "Widen / stay out", short: "Widen", tone: "risk" },
};

export function ActionTag({ action, short = false }: { action: string; short?: boolean }) {
  const a = ACTION[action] ?? { label: action, short: action, tone: "warn" };
  return (
    <span className={`tag ${a.tone}`}>
      <i className="tag-dot" />
      {short ? a.short : a.label}
    </span>
  );
}

/** The IVL mark (zvlint.com/ventures), background removed so it sits on the paper. */
export function Logo({ size = 28, light = false }: { size?: number; light?: boolean }) {
  return <img src={light ? "/ivl-mark-light.png" : "/ivl-mark.png"} alt="" width={Math.round(size * 0.9)} height={size} className="logo" />;
}

/** Segmented control whose highlight springs between options. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  small = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  const pill = useRef<HTMLSpanElement>(null);
  const btns = useRef<Record<string, HTMLButtonElement | null>>({});
  const placed = useRef(false);
  useLayoutEffect(() => {
    const b = btns.current[value];
    const el = pill.current;
    if (!b || !el) return;
    const to = { x: b.offsetLeft, width: b.offsetWidth };
    if (!placed.current || reducedMotion()) {
      placed.current = true;
      el.style.transform = `translateX(${to.x}px)`;
      el.style.width = `${to.width}px`;
      return;
    }
    animate(el, { ...to, duration: 650, ease: EASE.pop });
  }, [value, options.length]);
  return (
    <div className={`seg ${small ? "small" : ""}`} role="tablist">
      <span className="seg-pill" ref={pill} />
      {options.map((o) => (
        <button
          key={o.value}
          ref={(el) => void (btns.current[o.value] = el)}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
