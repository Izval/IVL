import type { PoolAnalysis } from "../api";
import { CompareFigure } from "../Compare";
import { Link } from "../App";
import { Segmented } from "../ui";
import { SectionHead } from "./SectionHead";

// The published 365-day walk-forward (README, scripts/compare.mjs), normalized units.
const RESEARCH = [
  { pair: "ETH / BNB", ivl: 65.71, naive: -34.36, il: -64, reb: [10, 15] },
  { pair: "BNB / USDT", ivl: 13.99, naive: -61.13, il: -55, reb: [13, 27] },
  { pair: "CAKE / WBNB", ivl: 8.92, naive: -68.09, il: -53, reb: [7, 27] },
  { pair: "AAVE / WBNB", ivl: -7.45, naive: -56.77, il: -62, reb: [7, 35] },
];

export function Proof({
  featured,
  options,
  onFeatured,
  pool,
}: {
  featured: string;
  options: { address: string; label: string }[];
  onFeatured: (a: string) => void;
  pool?: PoolAnalysis | "failed";
}) {
  const live = pool && pool !== "failed" && pool.ok ? pool : null;
  const c = live?.compare;
  const max = Math.max(...RESEARCH.flatMap((r) => [Math.abs(r.ivl), Math.abs(r.naive)]));
  return (
    <section className="wrap section proof" id="proof">
      <SectionHead title="Same pool, same capital, one year of history.">
        Arc is weeks old, so for pools whose asset trades in a deep market we replay that market's past year, re-anchored to the
        pool's price and widened by its liquidity factor: a thin pool swings more than the market it tracks.
      </SectionHead>

      <div className="kpi-row" data-reveal="stagger">
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count="53">53</span>–<span data-count="64" data-suffix="%">64%</span>
          </span>
          <span className="kpi-s">less impermanent-loss exposure than a naive band</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count="2">2</span>–<span data-count="5" data-suffix="×">5×</span>
          </span>
          <span className="kpi-s">fewer rebalances: IVL waits for a new range instead of chasing price</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count="3">3</span>/4
          </span>
          <span className="kpi-s">pairs turn a loss into a gain over 365 days</span>
        </div>
      </div>

      <div className="proof-live" data-reveal>
        <div className="lab-top">
          <h3 className="fig-h">{live?.name ?? options.find((o) => o.address === featured)?.label} · live on Arc</h3>
          <Segmented small value={featured} onChange={onFeatured} options={options.map((o) => ({ value: o.address, label: o.label }))} />
        </div>
        {c ? (
          <CompareFigure key={featured} c={c} />
        ) : pool === "failed" || (pool && !live) ? (
          <div className="chart-skel empty mono">The live replay is unavailable right now. The research results are below.</div>
        ) : (
          <div className="chart-skel mono">replaying a year of history…</div>
        )}
        {live && (
          <Link to={`/pool/${featured}`} className="link-arrow mono">
            open {live.name} →
          </Link>
        )}
      </div>

      <div className="proof-research" data-reveal>
        <div className="lab-top">
          <h3 className="fig-h">365-day walk-forward on BNB Chain</h3>
          <span className="rs-legend mono">
            <span>
              <i className="lgd ivl" /> IVL net
            </span>
            <span>
              <i className="lgd naive" /> naive band net
            </span>
          </span>
        </div>
        <div className="rs">
          {RESEARCH.map((r) => (
            <div key={r.pair} className="rs-row">
              <span className="rs-pair mono">{r.pair}</span>
              <div className="rs-bars">
                <Bar v={r.ivl} max={max} tone="ivl" />
                <Bar v={r.naive} max={max} tone="naive" />
              </div>
              <span className="rs-meta mono">
                IL {r.il}% · reb. {r.reb[0]} vs {r.reb[1]}
              </span>
            </div>
          ))}
        </div>
        <p className="rs-note mono">Normalized units. Thresholds are heuristic: directional evidence, not a guarantee.</p>
      </div>
    </section>
  );
}

function Bar({ v, max, tone }: { v: number; max: number; tone: string }) {
  const w = (Math.abs(v) / max) * 50;
  return (
    <div className="rs-bar">
      <span className={`rs-fill ${tone} ${v < 0 ? "neg" : "pos"}`} style={{ width: `${w}%`, [v < 0 ? "right" : "left"]: "50%" } as React.CSSProperties} />
      <span className={`rs-v mono ${v < 0 ? "neg" : "pos"}`}>{v > 0 ? "+" : ""}{v.toFixed(1)}</span>
    </div>
  );
}
