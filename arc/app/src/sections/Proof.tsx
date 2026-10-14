import type { PoolAnalysis } from "../api";
import { CompareFigure } from "../Compare";
import { Link } from "../App";
import { Segmented } from "../ui";
import { SectionHead } from "./SectionHead";

// One-year replay of Arc's featured pools (public/featured snapshots, worker/src/compare.mjs), normalized units.
const RESEARCH = [
  { pair: "cirBTC / USDC", ivl: 144.1, naive: -32.3, il: -44, reb: [10, 18] },
  { pair: "EURC / USDC", ivl: 65.0, naive: -31.9, il: -51, reb: [14, 27] },
  { pair: "XAUM / USDC", ivl: -27.7, naive: -86.4, il: -61, reb: [16, 30] },
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
            <span data-count="44">44</span>–<span data-count="61" data-suffix="%">61%</span>
          </span>
          <span className="kpi-s">less impermanent-loss exposure than a naive band</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count="2" data-suffix="×">2×</span>
          </span>
          <span className="kpi-s">fewer rebalances (about half): IVL waits for a new range instead of chasing price</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count="3">3</span>/3
          </span>
          <span className="kpi-s">featured Arc pools beat the naive band over 365 days, two of them turning a loss into a gain</span>
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
          <div className="chart-skel empty mono">The live replay is unavailable right now. The summary for all three pools is below.</div>
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
          <h3 className="fig-h">365-day replay on Arc's featured pools</h3>
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
