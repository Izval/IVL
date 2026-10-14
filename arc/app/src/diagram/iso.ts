// iso.ts - isometric projection for the exploded diagrams.
//
// A card is a vertical sheet: u runs along time (right and up), v along price (straight up), and cards
// stack along w (right and down, toward the viewer). Vertical stays vertical, so candles and price
// levels read exactly as on a flat chart, only sheared.

export type Pt = [number, number];

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

export const U: Pt = [C30, -S30];
export const V: Pt = [0, -1];
export const W: Pt = [C30, S30];

/** Screen point of (u, v, w) relative to `o`. */
export const iso = (o: Pt, u: number, v: number, w = 0): Pt => [o[0] + u * U[0] + v * V[0] + w * W[0], o[1] + u * U[1] + v * V[1] + w * W[1]];

export const fx = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** Closed outline of a u×v sheet. */
export const sheet = (o: Pt, uw: number, vh: number) =>
  `M${fx(iso(o, 0, 0))}L${fx(iso(o, uw, 0))}L${fx(iso(o, uw, vh))}L${fx(iso(o, 0, vh))}Z`;

/** A band [v0, v1] across the whole sheet, as a closed path. */
export const strip = (o: Pt, uw: number, v0: number, v1: number, u0 = 0) =>
  `M${fx(iso(o, u0, v0))}L${fx(iso(o, uw, v0))}L${fx(iso(o, uw, v1))}L${fx(iso(o, u0, v1))}Z`;

/** Polyline through (u, v) points on a sheet. */
export const onSheet = (o: Pt, pts: [number, number][]) => pts.map(([u, v], i) => `${i ? "L" : "M"}${fx(iso(o, u, v))}`).join("");

/** Screen offset of moving `w` units along the stack axis. */
export const along = (w: number): Pt => [w * W[0], w * W[1]];
