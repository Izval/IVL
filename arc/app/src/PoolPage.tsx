import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { arc } from "./chain";
import { fetchPool, type PoolAnalysis } from "./api";
import { sqrtPriceX96ToPrice } from "./math";
import { poolAbi, readToken, type TokenInfo } from "./tx";
import { PositionForm } from "./PositionForm";
import { PriceBandChart } from "./charts";
import { CompareFigure } from "./Compare";
import { EstimateBox } from "./Screener";
import { Link } from "./App";
import { useScrollReveal } from "./motion";
import { ActionTag, fmtPct, fmtPrice, fmtUsd } from "./ui";
import { Ruler } from "./diagram/Ruler";

const BASIS: Record<string, string> = {
  vwap_2sigma: "VWAP ± 2σ",
  vwap_2_5_atr14: "VWAP ± 2.5 ATR (widened)",
  observed_range: "observed channel",
};
const CLASS: Record<string, string> = {
  excellent: "Excellent",
  good: "Good",
  neutral: "Neutral",
  weak: "Weak",
  breakout_risk: "Breakout risk",
};

type OnChain = { token0: TokenInfo; token1: TokenInfo; fee: number; price: number };

export function PoolPage({ address }: { address: string }) {
  const client = usePublicClient({ chainId: arc.id })!;
  const [a, setA] = useState<PoolAnalysis | null>(null);
  const [chain, setChain] = useState<OnChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  useEffect(() => {
    fetchPool(address)
      .then(setA)
      .catch((e) => setError(e.message.includes("404") ? "No pool with this address on Arc." : e.message));
    const pool = address as Address;
    (async () => {
      const [t0, t1, fee, slot0] = await Promise.all([
        client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "fee" }),
        client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
      ]);
      const [token0, token1] = await Promise.all([readToken(client, t0), readToken(client, t1)]);
      setChain({ token0, token1, fee, price: sqrtPriceX96ToPrice(slot0[0], token0.decimals, token1.decimals) });
    })().catch((e) =>
      setChainError(
        // A revert or empty return means the contract isn't a v3 pool; anything else is the network.
        /revert|returned no data|does not have the function/i.test(String(e?.message ?? e))
          ? "This address is not a Uniswap v3 pool on Arc."
          : "Couldn't reach Arc to read this pool. Check your connection and reload."
      )
    );
  }, [address, client]);

  useScrollReveal([a?.updatedAt, !!chain]);

  // Arriving from the screener's "Deploy": go straight to the form once it is on the page.
  const ready = !!(a?.ok && chain);
  useEffect(() => {
    if (ready && location.hash === "#add") document.getElementById("add")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [ready]);

  // The analysis is in base/quote (GeckoTerminal); the form works in token1/token0 (the pool).
  const baseIsToken0 = chain && a ? chain.token0.address.toLowerCase() === a.baseToken : true;
  const band =
    a?.ok && a.band && chain
      ? baseIsToken0
        ? { lower: a.band.lower, upper: a.band.upper }
        : { lower: 1 / a.band.upper, upper: 1 / a.band.lower }
      : chain
        ? { lower: chain.price * 0.9, upper: chain.price * 1.1 }
        : null;
  const usd: Record<string, number | undefined> = a ? { [a.baseToken]: a.baseUsd, [a.quoteToken]: a.quoteUsd } : {};
  const [baseSym, quoteSym] = (a?.name ?? " / ").split(" / ");
  const inBand = a?.ok && a.band ? a.price >= a.band.lower && a.price <= a.band.upper : null;

  const market = a?.source?.market ?? a?.source?.symbol;
  const nativeLabel = a?.source?.nativeData === "geckoterminal" ? "GeckoTerminal" : "Arc RPC (Uniswap Swap events)";

  return (
    <div className="pool-page">
      <section className="wrap pool-head">
        <p className="crumbs mono">
          <Link to="/">IVL on Arc</Link> <span>/</span> <Link to="/#screener">Screener</Link> <span>/</span> <span>Pool</span>
        </p>
        <div className="pool-title-row">
          <h1 className="pool-title">
            {a?.name ?? (chain ? `${chain.token0.symbol} / ${chain.token1.symbol}` : <span className="skeleton title-skel" />)}
          </h1>
          {a?.feeTier != null && <span className="tier big">{fmtPct(a.feeTier, 2)}</span>}
          <span className="pool-chain mono">Uniswap v3 · Arc mainnet</span>
        </div>
        <a className="pool-addr mono" href={`${arc.blockExplorers.default.url}/address/${address}`} target="_blank" rel="noreferrer">
          {address} ↗
        </a>
        {error && <p className="error">{error}</p>}
        {(chainError || a?.reason === "not_uniswap_v3") && (
          <div className="callout risk">
            <p>{chainError ?? "This pool is not a Uniswap v3 pool. IVL on Arc reads v3 pools today; v4 is next."}</p>
            <EstimateBox compact />
          </div>
        )}
        {!a && !error && (
          <div className="reading mono">
            <span className="spinner" />
            <span>IVL is reading this pool and a year of its market's history…</span>
          </div>
        )}
      </section>

      {a?.ok && (
        <>
          <section className="wrap">
          <div className="verdict" data-reveal>
            <div className="verdict-score">
              <span className="fig-n mono">IVL score · {CLASS[a.classification!] ?? a.classification}</span>
              <Ruler value={a.ivlScore!} size="lg" scale />
              <div className="verdict-act">
                <ActionTag action={a.action!} />
              </div>
              <p className="verdict-text">{a.rationale}</p>
            </div>
            <dl className="verdict-spec mono">
              {(
                [
                  ["D", "dispersion", a.components!.dispersion, "0.5"],
                  ["P", "persistence", a.components!.persistence, "0.2"],
                  ["F", "fractality", a.components!.fractal, "0.3"],
                ] as const
              ).map(([k, name, v, w]) => (
                <div key={k} className={`dpf ${v < 0.5 ? "weak" : ""}`}>
                  <dt>
                    <b>{k}</b> {name} <sup>^{w}</sup>
                  </dt>
                  <dd>
                    <span className="dpf-v">{v.toFixed(2)}</span>
                    <Ruler value={v * 100} size="sm" showValue={false} />
                  </dd>
                </div>
              ))}
              <div>
                <dt>IVL raw · σ²/(R−S)²</dt>
                <dd>{a.ivlRaw?.toFixed(3) ?? "–"}</dd>
              </div>
              <div>
                <dt>LVR</dt>
                <dd className={`lvr lvr-${a.lvr!.level}`}>{a.lvr!.level}</dd>
              </div>
              <div>
                <dt>TVL</dt>
                <dd>{fmtUsd(a.tvlUsd)}</dd>
              </div>
              <div>
                <dt>fee APR</dt>
                <dd>{a.feeApr == null ? "–" : fmtPct(a.feeApr, 1)}</dd>
              </div>
              <div>
                <dt>scales confirming</dt>
                <dd>{a.scalesConfirming?.length ? a.scalesConfirming.join(" · ") : "none"}</dd>
              </div>
            </dl>
          </div>
          </section>

          <section className="wrap pool-grid">
            <div className="pool-main">
              {a.series && a.series.length > 2 && (
                <figure className="fig pool-fig" data-reveal>
                  <div className="fig-head">
                    <figcaption className="fig-n mono">
                      {baseSym} in {quoteSym} · last 7 days, hourly
                    </figcaption>
                    <span className={`tag ${inBand ? "good" : "risk"}`}>
                      <i className="tag-dot" />
                      {inBand ? "price inside the band" : "price outside the band"}
                    </span>
                  </div>
                  <PriceBandChart series={a.series} band={a.band!} channel={a.channel} />
                  <p className="fig-note mono">
                    IVL band {fmtPrice(a.band!.lower)} – {fmtPrice(a.band!.upper)} (
                    {BASIS[a.band!.basis] ?? a.band!.basis}) · dashed: observed channel · price now{" "}
                    <strong className="mono">{fmtPrice(a.price)}</strong>. Prices are the pool's own trades on Arc.
                  </p>
                </figure>
              )}

              <div className="source-note" data-reveal>
                {a.source?.kind === "reference" ? (
                  <p>
                    The pool is weeks old, so IVL reads <strong>{market}</strong>, re-anchored to this pool's price, with its swings
                    scaled by the pool's <strong>liquidity factor ×{a.source.liquidityFactor?.toFixed(2)}</strong>.
                    {a.source.method === "measured" ? (
                      <>
                        {" "}
                        Over the last {a.source.overlapHours} hours this pool moved ×{a.source.measuredFactor?.toFixed(2)} as much as its
                        reference; IVL keeps half of that excess (capped at ×1.75), so the band is wider without being dramatic.
                      </>
                    ) : (
                      <> Not enough overlapping trades yet, so the factor comes from the pool's TVL.</>
                    )}{" "}
                    Pool trades come from {nativeLabel}.
                  </p>
                ) : (
                  <p>
                    This pool's asset has no deep reference market, so IVL reads the pool's own trades on Arc (
                    {a.source?.candles15m} fifteen-minute candles from {nativeLabel}), using candle bodies so a single tiny swap
                    can't set the channel.
                  </p>
                )}
              </div>

              {a.compare && (
                <section className="pool-compare" data-reveal>
                  <h2 className="h-sm">
                    {a.source?.kind === "reference" ? `${a.historyDays} days of history, replayed for this pool` : `This pool's whole life on Arc, replayed`}
                  </h2>
                  <CompareFigure c={a.compare} />
                </section>
              )}
            </div>

            <aside className="pool-side" id="add">
              <div className="side-sticky">
                <h3 className="side-title">Place it in the IVL band</h3>
                {a.action === "withdraw_or_widen" && (
                  <p className="callout warn small">IVL reads this range as unstable right now. The band is the widened one; waiting is a valid choice.</p>
                )}
                {chain && band ? (
                  <PositionForm
                    token0={chain.token0}
                    token1={chain.token1}
                    fee={chain.fee}
                    price={chain.price}
                    defaultBand={band}
                    usd={usd}
                    invert={!baseIsToken0}
                  />
                ) : (
                  !chainError && (
                    <div className="reading">
                      <span className="spinner" /> Reading the pool on Arc…
                    </div>
                  )
                )}
              </div>
            </aside>
          </section>
        </>
      )}

      {a && !a.ok && a.reason !== "not_uniswap_v3" && chain && band && (
        <section className="wrap pool-grid">
          <div className="pool-main">
            <div className="source-note">
              <p>IVL can't score this pool yet (too little history). You can still add liquidity with your own range.</p>
            </div>
          </div>
          <aside className="pool-side">
            <div className="side-sticky">
              <PositionForm token0={chain.token0} token1={chain.token1} fee={chain.fee} price={chain.price} defaultBand={band} usd={usd} />
            </div>
          </aside>
        </section>
      )}
    </div>
  );
}
