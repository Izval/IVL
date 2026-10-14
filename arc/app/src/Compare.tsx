// The "with and without IVL" figure and its numbers, shared by the landing and the pool page.

import { useMemo } from "react";
import type { Compare as CompareData } from "./api";
import { NetCurves } from "./charts";

const SCALE_LABEL: Record<string, string> = { "1d": "daily", "4h": "4-hour" };

/** "+212%" when the fixed band made money; "loss → gain" when it lost and IVL did not. */
export function upliftLabel(c: CompareData) {
  const a = c.withIvl.net;
  const b = c.fixed.net;
  if (b > 0) return { big: `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%`, small: "net vs a fixed band" };
  if (a > 0) return { big: "Loss → gain", small: "the fixed band lost; IVL stayed positive" };
  return { big: `${Math.round((1 - a / b) * 100)}% less`, small: "loss than a fixed band" };
}

export function CompareFigure({ c, title }: { c: CompareData; title?: string }) {
  const up = upliftLabel(c);
  // Stable identity, so the chart draws itself once per pool rather than on every render.
  const curves = useMemo(
    () => [
      { key: "ivl", label: "With IVL", values: c.withIvl.curve, tone: "ivl" as const },
      { key: "fixed", label: "Fixed band", values: c.fixed.curve, tone: "fixed" as const },
      { key: "random", label: "Random", values: c.random.curve, tone: "random" as const },
    ],
    [c]
  );
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="compare">
      <dl className="compare-kpis mono">
        <div>
          <dt>IVL vs fixed band</dt>
          <dd className="tone-ivl">{up.big}</dd>
          <span>{up.small}</span>
        </div>
        <div>
          <dt>rebalances</dt>
          <dd>
            {c.withIvl.rebalances}
            <small> vs {c.fixed.rebalances}</small>
          </dd>
          <span>waits for a new range instead of chasing</span>
        </div>
        <div>
          <dt>time in range</dt>
          <dd>
            {pct(c.withIvl.timeInRange)}
            <small> vs {pct(c.fixed.timeInRange)}</small>
          </dd>
          <span>out of range on purpose while price trends</span>
        </div>
      </dl>
      <figure className="fig">
        {title && <figcaption className="fig-n mono">{title}</figcaption>}
        <NetCurves fromTs={c.fromTs} toTs={c.toTs} curves={curves} delta={up.big} />
        <p className="fig-note mono">
          Walk-forward over {c.candles} {SCALE_LABEL[c.scale] ?? c.scale} candles. Net = fees − impermanent loss − rebalancing,
          in relative units. The fixed band uses the market's typical width ({c.typicalWidthPct}%) and re-centers on every
          exit. Same model as the{" "}
          <a href="https://github.com/Izval/IVL/blob/main/scripts/compare.mjs" target="_blank" rel="noreferrer" className="link">
            published comparison
          </a>
          .
        </p>
      </figure>
    </div>
  );
}
