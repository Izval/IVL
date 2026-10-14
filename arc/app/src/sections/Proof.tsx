import type { PoolAnalysis } from "../api";
import { CompareFigure } from "../Compare";
import { Link } from "../App";
import { Segmented } from "../ui";
import { SectionHead } from "./SectionHead";

// One-year replay of Arc's featured pools, read from the snapshots that ship with this build
// (public/featured, refreshed on every deploy), so the figures always match the live charts.
const SNAPSHOTS = import.meta.glob<PoolAnalysis>("../../public/featured/*.json", { eager: true, import: "default" });
const RESEARCH = Object.values(SNAPSHOTS)
  .filter((p) => p.compare)
  .map((p) => {
    const { withIvl: w, fixed: f } = p.compare!;
    return { pair: p.name, ivl: w.net, naive: f.net, il: Math.round((100 * (w.il - f.il)) / f.il), reb: [w.rebalances, f.rebalances] };
  })
  .sort((a, b) => b.ivl - a.ivl);
const IL_CUT = RESEARCH.map((r) => -r.il);
const REB_RATIO = RESEARCH.reduce((a, r) => a + r.reb[1] / Math.max(1, r.reb[0]), 0) / Math.max(1, RESEARCH.length);
const BEAT = RESEARCH.filter((r) => r.ivl > r.naive).length;
const TURNED = RESEARCH.filter((r) => r.ivl > 0 && r.naive < 0).length;

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
            <span data-count={Math.min(...IL_CUT)}>{Math.min(...IL_CUT)}</span>–
            <span data-count={Math.max(...IL_CUT)} data-suffix="%">
              {Math.max(...IL_CUT)}%
            </span>
          </span>
          <span className="kpi-s">less impermanent-loss exposure than a naive band</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count={REB_RATIO.toFixed(1)} data-dp="1" data-suffix="×">
              {REB_RATIO.toFixed(1)}×
            </span>
          </span>
          <span className="kpi-s">fewer rebalances on average: IVL waits for a new range instead of chasing price</span>
        </div>
        <div className="kpi">
          <span className="kpi-big mono">
            <span data-count={BEAT}>{BEAT}</span>/{RESEARCH.length}
          </span>
          <span className="kpi-s">
            featured Arc pools beat the naive band over 365 days{TURNED > 0 && <>, {TURNED} turning a loss into a gain</>}
          </span>
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
