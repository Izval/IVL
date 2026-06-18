# IVL: Full mathematical formulation

IVL (Internal Variance of Lateralization) quantifies the quality of a lateralization for
concentrated liquidity provision. **Fractality is an intrinsic part of IVL**, not a separate metric:
a single score integrates internal dispersion, temporal persistence, and multiscale consistency.

## 1. Lateral block

Given a set of candles (closes `P_i`, volumes `v_i`) over an observation window `T_w`
(e.g. 120 candles of 15m):

- **Support / Resistance:** `S = min(low_i)`, `R = max(high_i)`
- **Width:** `W = R − S`
- **Normalized width:** `W / S`

It is classified as a **stable lateral block** if the normalized width does not exceed a threshold `δ`:

```
W / S ≤ δ          δ ∈ [0.01, 0.05]  (depending on the pair's volatility; default 0.05)
```

## 2. VWAP and volume-weighted variance

Equilibrium center (volume-weighted average price):

```
μ_vwap = Σ(P_i · v_i) / Σ(v_i)
```

Volume-weighted lateral variance about the VWAP:

```
σ²_lateral = Σ v_i (P_i − μ_vwap)² / Σ v_i
σ_lateral  = √σ²_lateral
```

## 3. IVL_raw (per scale)

```
IVL_raw = σ²_lateral / (R − S)²
```

Theoretical range `IVL_raw ∈ [0, 0.25]`:
- **`IVL_raw → 0.25`** (maximum, bimodal distribution at the extremes): price travels the whole
  channel from edge to edge → **healthy** lateralization, lots of volume crossing the range → fees for the LP.
- **`IVL_raw → 0.01`** (compression around the mean or asymmetric pressure against one edge): **risk of
  imminent breakout**.

> **Canonical polarity: HIGH IVL = GOOD.**

`dispersionScore` per scale = `clamp(IVL_raw / 0.18, 0, 1)`, anchored to the concentration threshold.

## 4. Intrinsic components of the integrated IVL

Over the scales `{15m, 1h, 4h, 1d}` (weights `{0.20, 0.35, 0.30, 0.15}`):

1. **Dispersion** `D` = weighted geometric mean of `dispersionScore` per scale.
2. **Persistence** `Pt` = weighted mean of the fraction of closes inside the core channel
   `μ ± W/2` per scale.
3. **Fractality** `F` = mean overlap (IoU) of the ranges `[S,R]` between pairs of scales,
   scaled by the fraction of scales that lateralize: `F = overlap · (0.5 + 0.5·lateralFrac)`.

   `IoU([a0,a1],[b0,b1]) = |intersection| / |union|`. F = 1 when all scales see the same
   range; F → 0 when a tight range lives inside a much wider one (fractal discrepancy).

## 5. IVL Score

Weighted geometric integration (any weak component drags the score down: it demands confirmation):

```
combined = D^0.5 · Pt^0.2 · F^0.3
IVL Score = round(clamp(combined, 0, 1) · 100)
```

Classification bands:

| Score   | Classification  |
|---------|-----------------|
| 80–100  | excellent       |
| 60–80   | good            |
| 40–60   | neutral         |
| 20–40   | weak            |
| 0–20    | breakout_risk   |

## 6. LVR (Loss-Versus-Rebalancing)

Intrablock volatility `σ_b` = standard deviation of the log returns per candle.
Expected discretized arbitrage per block (γ = pool fee, e.g. 0.0005 = 0.05%):

```
ARB ≈ σ_b²/2 + 1.7164 · γ / σ_b
```

The **risk level** of LVR grows with `σ_b` (higher volatility → more adverse selection from
arbitrage against the LP): `low` if `σ_b ≤ 0.004`, `moderate` if `≤ 0.008`, `high` if `> 0.008`.

## 7. Suggested LP range (ticks)

```
P_lower = μ_vwap − 2·σ_lateral
P_upper = μ_vwap + 2·σ_lateral
```

A narrow band around the VWAP that maximizes liquidity density (and therefore fee capture)
when IVL justifies concentrating. See `decision-matrix.md`.

## 8. Differentiation from traditional indicators

| Indicator  | Measures                      |
|------------|-------------------------------|
| RSI        | Momentum                      |
| MACD       | Trend                         |
| ATR        | Volatility                    |
| Bollinger  | Expansion / contraction       |
| **IVL**    | **Lateralization quality · internal stability · LP suitability (multiscale)** |

## 9. Matched multiscale horizon

Each fractal scale looks at the **same time horizon (wall-clock)**, not the same number of candles:
comparing 120 candles of 15m (30h) against 120 of 1d (120 days) makes the higher scales always
show huge ranges and the fractal component collapse. A number of candles per scale is computed
proportional to its timeframe:

```
horizon = primaryLookback · TF_min(primary)
candles(scale) = round(horizon / TF_min(scale))      (discarded if < 6 candles)
```

This is why intraday LP uses scales `15m,1h,4h,1d` and multi-week LP uses `1d,3d,1w`.

## 10. Timeframe-aware LVR

The σ_b thresholds are calibrated for 15m; on larger scales σ_b is naturally higher. Before
classifying the LVR level it is normalized to a "15m equivalent" with diffusion scaling:

```
σ_b_norm = σ_b / √(TF_min / 15)
low: σ_b_norm ≤ 0.004 · moderate: ≤ 0.008 · high: > 0.008
```

## 11. Lateral block detection

The real "8–16%" range is isolated by searching for the longest window (anchored on the last candle) with
normalized width `(max−min)/min ≤ δ`. `δ` is adjusted to the pair's typical width (0.08–0.20).
`findBestLateralBlock` does the same but at any historical position (to study the shape).

## 12. Variable/variable pairs: ratio and correlation

The analyzed price is the **ratio** between the two assets (what a pool of both quotes), not their
value in USD. `BASE/QUOTE = BASEUSDT / QUOTEUSDT` is synthesized and the **correlation
factor** (Pearson of the log returns of both legs) is reported. High positive correlation ⇒ stable
ratio ⇒ lower range-exit risk for the LP.

## 13. LP projection (duration and yield)

Over a block and a band `[lower, upper]` (center `c`, half-width `h`):

- **Concentration factor:** `(R − S) / (upper − lower)`, the fee-capture multiplier vs the
  full range of the block.
- **Expected time in range** (diffusion first-passage): `E[t] ≈ (h / (σ_b·c))²` candles →
  converted to hours/days with `TF_min`.
- **Yield (fee APR):** with TVL supplied in the band,
  `APR ≈ (block_gross_fees / block_days) · 365 / TVL`, where
  `gross_fees = Σ(volume in band) · γ`. Without TVL, the in-band volume and the concentration are reported.

## 14. Historical profile and suggested range

`rangeProfile` partitions the history into all lateral blocks and reports **typical (median)** width
and duration and the **recurring levels** (clusters of S/R with ≥2 touches). `suggestRange`
anchors the typical width to the current price (or to the nearest recurring level) to propose a range
and LP band going forward, with expected duration and APR. `volatilityContraction` (short/long ATR
< 0.85) signals that the pair is **starting to enter a range** after an expansion.
