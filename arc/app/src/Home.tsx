import { useEffect, useState } from "react";
import { FEATURED as FEATURED_POOLS } from "../../worker/src/featured.mjs";
import { fetchPool, type PoolAnalysis, type Screener as ScreenerData } from "./api";
import { EstimateBox, ScreenerSkeleton, ScreenerTable } from "./Screener";
import { useScrollReveal } from "./motion";
import { Hero } from "./sections/Hero";
import { RangeLab } from "./sections/RangeLab";
import { Measure } from "./sections/Timeframes";
import { Signals } from "./sections/Signals";
import { Proof } from "./sections/Proof";
import { Trust } from "./sections/Trust";
import { SectionHead } from "./sections/SectionHead";

// Pools with a deep reference market, so the comparison runs over a full year of history.
const LABELS = ["EURC", "cirBTC", "XAUM"];
const FEATURED = FEATURED_POOLS.map((address, i) => ({ address, label: LABELS[i] }));

export function Home({ screener, err }: { screener: ScreenerData | null; err: string | null }) {
  const [featured, setFeatured] = useState(FEATURED[1].address);
  const [cmp, setCmp] = useState<Record<string, PoolAnalysis | "failed">>({});

  useEffect(() => {
    if (cmp[featured]) return;
    fetchPool(featured)
      .then((p) => setCmp((m) => ({ ...m, [featured]: p })))
      .catch(() => setCmp((m) => ({ ...m, [featured]: "failed" })));
  }, [featured, cmp]);

  useScrollReveal([screener?.updatedAt, cmp[featured]]);

  const scored = screener?.pools.filter((p) => p.ok) ?? [];

  return (
    <>
      <Hero scored={scored} total={screener?.pools.length ?? 0} replay={cmp[FEATURED[1].address]} />

      <section className="wrap section screener-sec" id="screener">
        <SectionHead title="Every Uniswap v3 pool on Arc, scored.">
          Arc's markets are young and many are still finding their range, so plenty say <em>widen or stay out</em> today. That
          is the point: IVL tells you when a range isn't worth it yet.
        </SectionHead>
        {err && <p className="error">Could not load the screener: {err}</p>}
        {screener?.warming && <p className="note">Scoring Arc pools for the first time. This takes about a minute.</p>}
        {screener && screener.pools.some((p) => p.ok) ? (
          <ScreenerTable data={screener} />
        ) : (
          !err && (
            <>
              {screener && screener.pools.length > 0 && <p className="note">Scoring {screener.pools.length} pools on Arc right now. Scores appear here as they land.</p>}
              <ScreenerSkeleton />
            </>
          )
        )}
      </section>

      <section className="wrap estimate-strip" id="estimate">
        <div className="estimate-grid" data-reveal>
          <div>
            <h2 className="h-sm">Got a pool in mind?</h2>
            <p className="muted">
              Paste its contract. IVL reads it on Arc: the score, the band it would deploy, and what that band would have done
              over the past year.
            </p>
          </div>
          <EstimateBox />
        </div>
      </section>

      <RangeLab />
      <Measure />
      <Signals />
      <Proof featured={featured} options={FEATURED} onFeatured={setFeatured} pool={cmp[featured]} />

      <Trust />

      <section className="wrap section final">
        <div className="final-block" data-reveal>
          <h2>Put your liquidity where price actually lives.</h2>
          <p className="muted">Score a pool, take the band, sign it yourself. No custody, no contracts of ours.</p>
          <div className="cta">
            <a href="#screener" className="btn primary lg">
              Open the screener <span aria-hidden>→</span>
            </a>
            <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer" className="btn ghost lg">
              Read the research ↗
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
