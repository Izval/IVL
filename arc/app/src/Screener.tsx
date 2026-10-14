import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createLayout } from "animejs";
import type { PoolAnalysis, Screener as ScreenerData } from "./api";
import { Link, navigate } from "./App";
import { ActionTag, fmtPct, fmtUsd, Segmented } from "./ui";
import { Ruler } from "./diagram/Ruler";
import { EASE, reducedMotion } from "./motion";

const REF_LABEL: Record<string, string> = {
  EURUSDC: "EUR/USD",
  BTCUSDC: "BTC/USD",
  ETHUSDC: "ETH/USD",
  PAXGUSDT: "Gold",
};

export function SourceTag({ p }: { p: PoolAnalysis }) {
  if (p.source?.kind === "reference") {
    const label = p.source.market ?? REF_LABEL[p.source.symbol!] ?? p.source.symbol;
    return (
      <span className="src" title={`Scored on ${label} history, re-anchored to this pool, liquidity factor ×${p.source.liquidityFactor}`}>
        {label} <span className="src-x">×{p.source.liquidityFactor?.toFixed(2)}</span>
      </span>
    );
  }
  return <span className="src dim">Arc pool trades</span>;
}

type Filter = "all" | "concentrate" | "hold" | "withdraw_or_widen";
type Sort = "score" | "tvl" | "apr";
const PAGE_SIZE = 15;

export function ScreenerTable({ data }: { data: ScreenerData }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("tvl");
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const layout = useRef<ReturnType<typeof createLayout> | null>(null);

  const scored = data.pools.filter((p) => p.ok);
  const pending = data.pools.length - scored.length;
  const count = (a: Filter) => (a === "all" ? scored.length : scored.filter((p) => p.action === a).length);

  const rows = useMemo(() => {
    const key: Record<Sort, (p: PoolAnalysis) => number> = { score: (p) => p.ivlScore ?? 0, tvl: (p) => p.tvlUsd ?? 0, apr: (p) => p.feeApr ?? -1 };
    const needle = q.trim().toLowerCase();
    return scored
      .filter((p) => filter === "all" || p.action === filter)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.pool.includes(needle))
      .sort((a, b) => key[sort](b) - key[sort](a));
  }, [scored, filter, sort, q]);

  // Any change to the filter, sort or search starts again from the first page.
  useLayoutEffect(() => setPage(0), [filter, sort, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Rows glide to their new places when the filter or sort changes (anime's layout engine).
  const change = (fn: () => void) => {
    if (!reducedMotion() && list.current) {
      layout.current ??= createLayout(list.current, { children: ".row", duration: 650, ease: EASE.out, enterFrom: { opacity: 0, transform: "translateY(12px)" } });
      layout.current.record();
    }
    fn();
  };
  useLayoutEffect(() => {
    layout.current?.animate();
  }, [filter, sort]);

  return (
    <div className="screener" data-reveal>
      <div className="scr-bar">
        <Segmented
          small
          value={filter}
          onChange={(v) => change(() => setFilter(v))}
          options={[
            { value: "all", label: `All ${count("all")}` },
            { value: "concentrate", label: `Concentrate ${count("concentrate")}` },
            { value: "hold", label: `Hold ${count("hold")}` },
            { value: "withdraw_or_widen", label: `Widen ${count("withdraw_or_widen")}` },
          ]}
        />
        <div className="scr-tools">
          <label className="search">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input placeholder="Search pools" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pools" />
          </label>
          <label className="select">
            <span>Sort</span>
            <select value={sort} onChange={(e) => change(() => setSort(e.target.value as Sort))}>
              <option value="tvl">TVL</option>
              <option value="score">IVL score</option>
              <option value="apr">Fee APR</option>
            </select>
          </label>
        </div>
      </div>

      <div className="scr-head row-grid" aria-hidden>
        <span>Pool</span>
        <span>IVL</span>
        <span>Signal</span>
        <span className="hide-md">Scored on</span>
        <span className="num hide-sm">LVR</span>
        <span className="num hide-sm">TVL</span>
        <span className="num">Fee APR</span>
        <span />
      </div>
      <div className="scr-list" ref={list}>
        {shown.map((p) => (
          <div key={p.pool} className="row row-grid" onClick={() => navigate(`/pool/${p.pool}`)}>
            <span className="row-pool">
              <Link to={`/pool/${p.pool}`} className="pool-link">
                {p.name}
              </Link>
              <span className="tier">{fmtPct(p.feeTier, 2)}</span>
            </span>
            <span className="row-score">
              <Ruler value={p.ivlScore!} size="sm" />
            </span>
            <span>
              <ActionTag action={p.action!} short />
            </span>
            <span className="hide-md">
              <SourceTag p={p} />
            </span>
            <span className={`num hide-sm lvr lvr-${p.lvr?.level}`}>{p.lvr?.level ?? "–"}</span>
            <span className="num hide-sm mono">{fmtUsd(p.tvlUsd)}</span>
            <span className="num mono">{p.feeApr == null ? "–" : fmtPct(p.feeApr, 1)}</span>
            <span className="row-act">
              <Link to={`/pool/${p.pool}#add`} className="btn-row">
                Deploy
              </Link>
            </span>
          </div>
        ))}
        {!rows.length && <p className="scr-empty">No pools match.</p>}
      </div>
      {pages > 1 && (
        <nav className="scr-pager" aria-label="Pool list pages">
          <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <span aria-hidden>←</span> Prev
          </button>
          <span className="mono">
            {page * PAGE_SIZE + 1}–{Math.min(rows.length, (page + 1) * PAGE_SIZE)} of {rows.length}
          </span>
          <button className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Next <span aria-hidden>→</span>
          </button>
        </nav>
      )}
      <p className="scr-note">
        {data.updatedAt && <>Updated {new Date(data.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · </>}
        7-day window{pending > 0 && <> · {pending} more pools being scored</>} · Fee APR is pool-wide (24h volume × fee ÷ TVL) ·
        Pools with a deep reference market are scored on its history, re-anchored to the pool and widened by its liquidity
        factor.
      </p>
    </div>
  );
}

export function ScreenerSkeleton() {
  return (
    <div className="screener">
      <div className="scr-list">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="row row-grid skel-row">
            <span className="skeleton" style={{ width: "60%" }} />
            <span className="skeleton" />
            <span className="skeleton" style={{ width: 80 }} />
            <span className="skeleton hide-md" style={{ width: 90 }} />
            <span className="skeleton hide-sm" />
            <span className="skeleton hide-sm" />
            <span className="skeleton" />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Paste a pool contract (or any URL containing it) and jump to its estimate. */
export function EstimateBox({ compact = false }: { compact?: boolean }) {
  const [v, setV] = useState("");
  const addr = v.match(/0x[0-9a-fA-F]{40}/)?.[0];
  return (
    <form
      className={`estimate ${compact ? "compact" : ""} ${addr ? "valid" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (addr) navigate(`/pool/${addr.toLowerCase()}`);
      }}
    >
      <label htmlFor={compact ? "pool-input-c" : "pool-input"} className="sr-only">
        Paste a Uniswap v3 pool contract on Arc
      </label>
      <div className="estimate-row">
        <span className="estimate-icon mono" aria-hidden>
          0x
        </span>
        <input
          id={compact ? "pool-input-c" : "pool-input"}
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste any Uniswap v3 pool on Arc, or an explorer link"
          value={v}
          onChange={(e) => setV(e.target.value.trim())}
        />
        <button className="btn primary" disabled={!addr}>
          Analyze <span aria-hidden>→</span>
        </button>
      </div>
      {v && !addr && <span className="estimate-hint">That doesn't contain a 0x address yet.</span>}
    </form>
  );
}
