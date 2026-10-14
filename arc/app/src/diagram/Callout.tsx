// Callout.tsx - leader lines from a point on a figure to a monospace label at the edge, the way an
// engineering drawing labels its parts: a 45° run off the part, then a level rule out to the label.

import type { Pt } from "./iso";

/** Mono labels make text width predictable: ~0.6em per character. */
export const textW = (s: string, size = 13) => s.length * size * 0.6;

export type CalloutProps = {
  /** Point on the figure. */
  a: Pt;
  /** Label baseline row (y) and the x where the label ends (right side) or starts (left side). */
  y: number;
  x: number;
  side: "left" | "right";
  label: string;
  /** Optional value printed after the label, in ink. */
  value?: string;
  /** Index shown instead of the text on small screens (with a legend below the figure). */
  n?: number;
  active?: boolean;
  dim?: boolean;
  size?: number;
  /** Print only the index (small screens; the figure carries a legend). */
  numbered?: boolean;
};

export function Callout({ a, y, x, side, label, value, n, active, dim, size = 13, numbered }: CalloutProps) {
  const dir = side === "right" ? 1 : -1;
  if (numbered) size = 30;
  const text = numbered ? String(n) : value ? `${label}  ${value}` : label;
  const gap = 10;
  const end = x - dir * (textW(text, size) + gap);
  const dy = Math.abs(a[1] - y);
  // 45° off the part, but never past where the level rule has to start.
  const ex = dir > 0 ? Math.min(a[0] + dy, end) : Math.max(a[0] - dy, end);
  const d = `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${ex.toFixed(1)},${y}L${end.toFixed(1)},${y}`;
  return (
    <g className={`co ${active ? "on" : ""} ${dim ? "dim" : ""}`}>
      <path d={d} className="co-line" />
      <circle cx={a[0]} cy={a[1]} r={2.6} className="co-dot" />
      <text x={x} y={y + size * 0.36} textAnchor={side === "right" ? "end" : "start"} className="co-text" style={{ fontSize: size }}>
        {numbered ? n : label}
        {!numbered && value && <tspan className="co-v">{`  ${value}`}</tspan>}
      </text>
    </g>
  );
}
