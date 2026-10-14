// Dimension.tsx - a drafting dimension: extension lines off the two points, a rule between them with
// slash terminators, and the measure written on it. Used for widths (R − S, ±2σ) and for deltas.

import type { Pt } from "./iso";
import { textW } from "./Callout";

type Props = {
  a: Pt;
  b: Pt;
  /** Offset of the rule from the measured points, perpendicular to a→b (sign picks the side). */
  off?: number;
  label: string;
  tone?: "ink" | "ivl";
  size?: number;
  /** Where the label sits: on the rule (default) or beside it. */
  labelSide?: "on" | "out";
};

export function Dimension({ a, b, off = 16, label, tone = "ink", size = 12, labelSide = "on" }: Props) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const A: Pt = [a[0] + nx * off, a[1] + ny * off];
  const B: Pt = [b[0] + nx * off, b[1] + ny * off];
  const ext = (p: Pt, q: Pt) => `M${(p[0] + nx * Math.sign(off) * 3).toFixed(1)},${(p[1] + ny * Math.sign(off) * 3).toFixed(1)}L${(q[0] + nx * Math.sign(off) * 5).toFixed(1)},${(q[1] + ny * Math.sign(off) * 5).toFixed(1)}`;
  // 45° slash terminators, drafting style.
  const tick = (p: Pt) => {
    const k = 5;
    const tx = (dx / len + nx) * k * 0.7;
    const ty = (dy / len + ny) * k * 0.7;
    return `M${(p[0] - tx).toFixed(1)},${(p[1] - ty).toFixed(1)}L${(p[0] + tx).toFixed(1)},${(p[1] + ty).toFixed(1)}`;
  };
  const vertical = Math.abs(dx) < Math.abs(dy);
  const mid: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const tw = textW(label, size);
  const lx = vertical ? mid[0] + (labelSide === "out" ? Math.sign(off || 1) * 10 : 0) : mid[0];
  const ly = vertical ? mid[1] + size * 0.36 : mid[1] - (labelSide === "out" ? 8 : -size * 0.36);
  const anchor = vertical ? (labelSide === "out" ? (off >= 0 ? "start" : "end") : "middle") : "middle";
  return (
    <g className={`dim tone-${tone}`}>
      <path d={`${ext(a, A)}${ext(b, B)}`} className="dim-ext" />
      <path d={`M${A[0].toFixed(1)},${A[1].toFixed(1)}L${B[0].toFixed(1)},${B[1].toFixed(1)}`} className="dim-line" />
      <path d={`${tick(A)}${tick(B)}`} className="dim-tick" />
      {labelSide === "on" && (
        <rect
          x={(vertical ? mid[0] : mid[0]) - tw / 2 - 5}
          y={mid[1] - size * 0.75}
          width={tw + 10}
          height={size * 1.5}
          className="dim-knock"
        />
      )}
      <text x={lx} y={ly} textAnchor={anchor} className="dim-text" style={{ fontSize: size }}>
        {label}
      </text>
    </g>
  );
}
