# IVL: Internal Variance of Lateralization

> *Not every range is worth your liquidity. IVL tells you which ones are.*

[![IVL — Internal Variance of Lateralization](https://zvlint.com/ventures/ivl-og.jpg)](https://zvlint.com/ventures/ivl)

📄 **[Read the full research note → zvlint.com/ventures/ivl](https://zvlint.com/ventures/ivl)** — interactive write-up with figures, the method, and real-data results.

▶ **[Try it live → zvlint.com/ventures/ivl](https://zvlint.com/ventures/ivl)** — score any pair from the browser, or call the hosted API: [`api.zvlint.com/v1/ivl?pair=BNB-USDT`](https://api.zvlint.com/v1/ivl?pair=BNB-USDT). The skill isn't just a spec — it runs (see [Hosted API](#hosted-api--open-infrastructure)).

**What if an AI agent could tell you not just *that* a market is ranging — but whether that range is
worth your capital?** When you provide liquidity on PancakeSwap v3 you pick a price range — inside it
you earn fees, outside it you stop and take losses. Today people choose that range by eye. RSI, MACD
and ATR describe momentum, trend and volatility; none tell you whether a sideways range is actually a
good place to put liquidity. **IVL measures exactly that — the internal quality of a range — as one
0–100 score across timeframes.** It's not an app; it's an open Skill an AI agent can call, and it
returns a clear decision (concentrate / hold / withdraw) plus a backtestable spec. *Two ranges can
have the same width and opposite risk — IVL tells an agent which one to trust.*

**A metric designed to quantify the quality of a lateral market structure through the analysis of
internal dispersion, temporal persistence, and multiscale consistency.** It is delivered as an
AI-agent skill that decides where to provide concentrated liquidity and when to withdraw.

Reference implementation for the BNB HACK: AI Trading Agent Edition (Strategy Skills track;
CoinMarketCap, BNB Chain, Trust Wallet).

---

## Abstract

Concentrated liquidity (PancakeSwap v3, Uniswap v3) raises an LP's capital efficiency by 200–300×,
but exposes the provider to range exit, impermanent loss (IL), and loss-versus-rebalancing (LVR).
Range selection is the central decision, yet existing tooling exposes only volatility (ATR,
Bollinger), width, or volume. None measures the *internal quality* of a consolidation, and two ranges
of identical width can carry opposite risk. We introduce IVL (Internal Variance of Lateralization), a
normalized, volume-weighted variance statistic that scores how efficiently and stably price occupies
a channel. IVL is intrinsically multiscale (fractal): a single score integrates internal dispersion,
temporal persistence, and cross-timeframe agreement. From it we derive an LP decision rule
(concentrate, hold, or withdraw) aware of LVR, a deployable tick range, and a deterministic,
backtestable strategy spec. A set-and-hold backtest over real data indicates that IVL-guided range
placement materially reduces IL exposure relative to naive and random range selection.

## 1. Motivation

When price leaves an LP's range, the position stops accruing fees, converts fully into the weaker
asset, and realizes IL and LVR. Practitioners select ranges heuristically. We seek a single,
interpretable quantity that answers: how stable is this consolidation, and is it worth deploying
liquidity into?

## 2. Definition

Let a lateral block be a window of candles with closes `{P_i}` and volumes `{v_i}`, support
`S = min(low_i)`, resistance `R = max(high_i)`, and width `W = R − S`. The window qualifies as a
stable lateral block when its normalized width is bounded:

```
W / S ≤ δ ,   with δ in [0.01, 0.05] for stables, up to ~0.20 for variable/variable ratios.
```

We use the volume-weighted average price as the equilibrium center, and the volume-weighted variance
of closes about it:

```
μ_vwap     = Σ P_i v_i / Σ v_i
σ²_lateral = Σ v_i (P_i − μ_vwap)² / Σ v_i
IVL_raw    = σ²_lateral / (R − S)²
```

`IVL_raw` lies in `[0, 1/4]`. The bound 1/4 is attained by a bimodal distribution at the channel
extremes; uniform occupancy yields `1/12 ≈ 0.083`. Polarity is canonical: **high IVL is good**. Price
that traverses the full channel generates fees with low directional drift, whereas a low value
indicates compression or asymmetric pressure against one edge, that is, elevated breakout risk.

## 3. Multiscale (fractal) formulation

IVL is defined as a single score over scales `T = {15m, 1h, 4h, 1d}` (or `{1d, 3d, 1w}` for
multi-week LP). To compare like with like, each scale covers the same wall-clock horizon (candle count
proportional to its timeframe), which avoids the degenerate comparison of 30 hours against 120 days.
Three components are integrated:

```
Dispersion   D = weighted geomean over scales of  clamp(IVL_raw / 0.18)
Persistence  P = weighted mean of in-core-channel occupancy per scale
Fractality   F = mean pairwise range overlap (IoU) × fraction of scales that lateralize
IVL Score    = round( clamp( D^0.5 · P^0.2 · F^0.3 ) · 100 )
```

The geometric integration is deliberate: a weak component (for example, scales that disagree on the
range) drags the score down, enforcing genuine multiscale confirmation rather than a single-timeframe
artifact.

| Score | Class | Score | Class | Score | Class |
|---|---|---|---|---|---|
| 80–100 | excellent | 60–80 | good | 40–60 | neutral |
| 20–40 | weak | 0–20 | breakout risk | | |

## 4. LP decision and loss-versus-rebalancing

Intrablock volatility `σ_b` (std. of per-candle log returns) drives a discretized arbitrage estimate
(γ is the pool fee, e.g. 0.05%):

```
ARB ≈ σ_b²/2 + 1.7164 · γ / σ_b
```

LVR risk level is assigned from `σ_b` normalized to a 15m equivalent (`σ_b / √(tf/15)`), so thresholds
transfer across timeframes. The decision rule:

```
IVL_raw ≥ 0.18  and LVR low   →  CONCENTRATE    in μ_vwap ± 2σ_lateral
0.10 ≤ IVL_raw < 0.18         →  HOLD           (keep current range)
IVL_raw < 0.10  or  LVR high  →  WIDEN/WITHDRAW (2.5·ATR14, or exit to reserves)
```

## 5. Deployable ticks

A v3 position is defined by integer tick indices, not raw prices: `price = 1.0001^tick`, and the
bounds must be multiples of the pool's `tickSpacing` (set by the fee tier). IVL converts its price
band into the actual `tickLower` / `tickUpper` an LP would submit, snapped outward to the spacing
(0.05% fee → spacing 10), so the output is deployable, not just an indicative price range.

## 6. Exhaustion-aware forward ranges

An LP is not an intraday trader: capital should stay deployed and be repositioned infrequently. On a
breakout the policy is not to chase price, but to wait for the move to exhaust and place a forward
range that price will lateralize into. Exhaustion is detected symmetrically from RSI, MACD, and
price/RSI divergence:

- Bullish exhaustion (rally topping): ceiling near the exhaustion zone, floor near prior support.
- Bearish exhaustion (selloff bottoming): floor near the exhaustion zone, ceiling near prior resistance.

Range width is anchored to the pair's typical historical amplitude (an empirical profile of past
lateral blocks). This signal layer maps directly onto CoinMarketCap's technical-analysis tools.

## 7. Methodology

- **Price series.** Public Binance klines (BNB ecosystem; no key). For variable/variable pairs such as
  AAVE/WBNB, IVL operates on the price *ratio* between the two assets, the quantity a pool of those
  tokens actually quotes, synthesized from each leg's USDT pair. It also reports the Pearson
  correlation of their returns (high correlation implies a stable ratio and lower range-exit risk).
- **Signal layer.** CoinMarketCap MCP: RSI/MACD/support-resistance, funding and open interest, fear
  and greed; used as context and for exhaustion detection.
- **Engine.** Pure, dependency-free JavaScript (`scripts/`), mirrored to TypeScript for application use.

## 8. Empirical evaluation

We evaluate with a realistic set-and-hold LP model (objective: fees − impermanent loss − rebalance
cost) over a 365-day walk-forward, comparing IVL-guided range placement against (i) a naive
fixed-width band that re-centers on exit and (ii) randomized ranges. Real engine output
(`compare.mjs --scale 1d --history 365`, normalized fee/IL units):

| Pair | IVL net | Naive net | IL reduced vs naive | Rebalances (IVL → Naive) |
|---|---:|---:|---:|---:|
| ETH/BNB   | **+65.71** | −34.36 | −64% | 10 → 15 |
| BNB/USDT  | **+13.99** | −61.13 | −55% | 13 → 27 |
| CAKE/WBNB | **+8.92**  | −68.09 | −53% |  7 → 27 |
| AAVE/WBNB | −7.45      | −56.77 | −62% |  7 → 35 |

- Impermanent-loss exposure reduced **~53–64%** relative to naive/random selection.
- **~2–5× fewer rebalances**, consistent with set-and-hold LP behavior.
- IVL turns the naive **loss into a net gain on 3 of 4 pairs**; on the hardest trending pair
  (AAVE/WBNB) all strategies lose, but IVL cuts the bleed **~87%** (−57 → −7.5) by not chasing price.
- A deterministic self-test (`scripts/selftest.mjs`, 6/6) verifies polarity and the fractal penalty.

These are backtest results under explicit assumptions (normalized fee/IL units, not a tick-level pool
simulation), not production-validated returns.

## 9. Related work

Active liquidity management is well established: Gamma, Arrakis, Steer, Charm, Visor, and ICHI provide
automated v3 range management, and LVR is formalized by Milionis et al. (2022). IVL does not duplicate
these execution vaults. It is the measurement and decision layer that precedes them: a *named*
lateralization-quality metric, multiscale and exhaustion-aware, packaged as an agent-callable skill.
That combination was not found replicated (the term "IVL" is absent from the liquidity literature). It
is complementary to ALM and could serve as a signal to one.

## 10. Limitations

Thresholds (0.18, δ, component weights) are heuristic, not empirically optimized. The backtest is a
simplified relative model (fees and IL in normalized units), not a tick-level pool simulation, and
does not yet ingest real pool TVL/volume for absolute APR. The CMC free tier does not serve historical
OHLCV, hence Binance for candles. Results should be read as directional evidence, not guarantees.

## 11. Reproducibility

```bash
cd scripts
node selftest.mjs                                              # verify the metric (6/6)
node ivl.mjs --pair AAVE-WBNB --scales 1d,3d,1w --delta 0.16 --tvl 50000
node profile.mjs --pair AAVE-WBNB --history 365               # historical profile and suggested range
node compare.mjs --pair AAVE-WBNB --scale 1d                  # IVL vs naive vs random (fees − IL)
```

The agent skill (`SKILL.md`) adds the live CMC signal layer when the CMC MCP is registered.

## Hosted API & open infrastructure

The skill is not just a spec on paper — it runs. A small open-source Cloudflare Worker (`server/`,
Apache-2.0) serves IVL as a public, low-latency API, and the research note doubles as an interactive
demo. This is the same engine as the CLI, exposed over HTTP so an agent — or a judge — can call it now.

| Endpoint | Returns |
|---|---|
| [`/v1/ivl?pair=BNB-USDT`](https://api.zvlint.com/v1/ivl?pair=BNB-USDT) | Full IVL score, components, LP band, decision, and deployable ticks |
| [`/v1/ivl/ticks?pair=BNB-USDT`](https://api.zvlint.com/v1/ivl/ticks?pair=BNB-USDT) | PancakeSwap v3 `tickLower` / `tickUpper` ready to mint |
| [`/v1/screener`](https://api.zvlint.com/v1/screener) | BNB-ecosystem pools ranked by IVL (refreshed every 4h) |
| [`/v1/health`](https://api.zvlint.com/v1/health) | Liveness |

Base URL: `https://api.zvlint.com`. CORS is open (read-only public market data). The server code and
self-host instructions live in [`server/`](server/).

> **Note on candles.** The skill and CLI use **Binance** public klines (as documented in §7). The
> *hosted* API runs on Cloudflare's edge, where Binance geoblocks datacenter IPs (HTTP 451), so it
> sources the same klines from **MEXC** (a Binance-compatible API). Same data, deployment detail only.

## Repository layout

```
SKILL.md      agent skill (frontmatter, workflow, allowed-tools mcp__cmc-mcp__*)
references/   ivl-math.md, decision-matrix.md, backtest-spec.md
scripts/      engine and CLIs (ivl, profile, compare, backtest, selftest, ...)
server/       open-source Cloudflare Worker behind the hosted API (api.zvlint.com)
docs/         ivl/ (metric deep-dive)
```

## References

- M. Milionis, C. C. Moallemi, T. Roughgarden, A. L. Zhang. *Automated Market Making and
  Loss-Versus-Rebalancing.* 2022.
- Uniswap v3 and PancakeSwap v3 concentrated-liquidity documentation.
- CoinMarketCap AI Agent Hub: Skills and MCP documentation.

## License

Apache License 2.0. Copyright 2026 Izval. See `LICENSE` and `NOTICE`.
