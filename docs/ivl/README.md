# IVL: Internal Variance of Lateralization

> A quantitative metric that measures the **quality and stability** of a price lateralization for
> **concentrated liquidity provision** (PancakeSwap v3 / BNB Chain). Fractality is **intrinsic**
> to IVL: a single score integrates internal dispersion, temporal persistence, and multiscale consistency.

This folder documents the concept. The **executable skill** lives one level up in `SKILL.md`, and the
core math is detailed in the reference below.

---

## The problem

Concentrated liquidity platforms like PancakeSwap v3 let you bound capital within price ranges
(`ticks`), multiplying capital efficiency by 200–300× versus v2 AMMs. But if price exits the range,
the LP stops earning fees, ends up 100% in the lower-value asset, and accumulates impermanent loss
(IL) and **loss-versus-rebalancing (LVR)**.

LPs lack an objective metric to answer: *how stable is this range?*, *is it worth deploying liquidity
here?*. Existing tools show volatility, ATR, volume, or range width: **none measure the internal
quality of the lateralization**.

## The hypothesis

Two ranges can have **the same width** and opposite risk profiles:

| | Range A | Range B |
|---|---|---|
| Distribution | uniform, bounces edge to edge | compressed against one border |
| For an LP | healthy, generates fees | high probability of breakout |

IVL quantifies that difference.

---

## Polarity (important)

> **HIGH IVL = GOOD.**

For a channel `[S, R]`:
- Price that travels the whole channel edge to edge → `IVL_raw → ~0.25` → **healthy** lateralization.
- Price compressed/asymmetric against one border → `IVL_raw → ~0.01` → **breakout risk**.

---

## Formula

Over a window of candles (closes `P_i`, volumes `v_i`):

```
S = min(low),  R = max(high),  W = R − S
Stable lateral block if  W/S ≤ δ   (δ ∈ [0.01, 0.05])

μ_vwap     = Σ(P_i·v_i) / Σ(v_i)                     (VWAP = equilibrium center)
σ²_lateral = Σ v_i (P_i − μ_vwap)² / Σ(v_i)          (volume-weighted variance)
IVL_raw    = σ²_lateral / (R − S)²                   (∈ [0, 0.25])
```

### Intrinsic components of the integrated IVL (multiscale 15m/1h/4h/1d)

1. **Dispersion**: weighted geometric mean of `IVL_raw/0.18` per scale.
2. **Persistence**: fraction of the period that price stays in the core channel.
3. **Fractality**: overlap (IoU) of the ranges `[S,R]` between scales × fraction that lateralizes.

```
IVL Score = round( clamp( D^0.5 · Pt^0.2 · F^0.3 ) · 100 )
```

| Score   | Classification |
|---------|----------------|
| 80–100  | excellent      |
| 60–80   | good           |
| 40–60   | neutral        |
| 20–40   | weak           |
| 0–20    | breakout_risk  |

Detailed formulation (LVR, ATR, ticks): [`../../references/ivl-math.md`](../../references/ivl-math.md).

---

## LVR and LP decision matrix

Intrablock volatility `σ_b` (std of log returns). Expected discretized arbitrage:

```
ARB ≈ σ_b²/2 + 1.7164 · γ / σ_b        (γ = pool fee, e.g. 0.05% = 0.0005)
```

| Condition | Action | Range |
|---|---|---|
| `IVL_raw ≥ 0.18` and low LVR | **CONCENTRATE** | `μ_vwap ± 2σ_lateral` |
| `0.10 ≤ IVL_raw < 0.18` | **HOLD** | current range |
| `IVL_raw < 0.10` or high LVR | **WIDEN/WITHDRAW** | `2.5 × ATR14` or exit to stable |

Details: [`../../references/decision-matrix.md`](../../references/decision-matrix.md).

---

## Input / Output

**Input**
```json
{ "pair": "BNB-USDT", "lookback": 120 }
```

**Output** (summary)
```json
{
  "ivl_score": 34,
  "classification": "weak",
  "range_low": 601.33, "range_high": 619.50,
  "lp_range": { "lower": 601.16, "upper": 620.08, "vwap": 610.63 },
  "breakout_risk": "high",
  "scales_confirming": ["15m"],
  "decision": { "action": "withdraw_or_widen" }
}
```

---

## Variable/variable pairs and correlation

In a pool of two volatile assets (e.g. **AAVE/WBNB**) what lateralizes is the **ratio** between them
(their correlation), not their dollar value: it is exactly the price the pool quotes. IVL synthesizes
the cross `BASE/QUOTE = BASEUSDT / QUOTEUSDT` and reports the **correlation factor** (Pearson of returns):
high correlation ⇒ stable ratio ⇒ lower range-exit risk. The LP horizon is usually
**weeks** (scales `1d,3d,1w`, widths 8–16%).

## Historical profile → suggested forward range

When a pair comes off a **breakout and starts entering a range**, IVL derives from its history:
- **Typical width** and **typical duration** of its lateral blocks (medians).
- **Recurring levels** (S/R the pair repeatedly respects).
- A **volatility-contraction** signal (short/long ATR) = "it is entering a range".
- A **suggested range + LP band (ticks) + duration + APR** anchored to the current price.

Real example (AAVE/WBNB, 1d): 12 historical blocks, typical width 15.4%, duration 10 days,
recurring levels that match the chart's S/R → suggested range and estimated APR.

## Use cases

- **Liquidity Providers**: identify optimal ranges for concentrated liquidity and estimate yield.
- **Trading bots**: detect healthy consolidations before breakouts.
- **Market makers**: adjust quote width based on statistical stability.
- **AI trading agents**: evaluate market structure before executing (skill consumable by agents).

## Differentiation

| Indicator | Measures |
|---|---|
| RSI | Momentum |
| MACD | Trend |
| ATR | Volatility |
| Bollinger | Expansion / contraction |
| **IVL** | **Lateralization quality · internal stability · LP suitability (multiscale)** |

---

## Vision

Turn IVL into an open standard for evaluating the statistical stability of lateral ranges and serve
as an analytical layer for autonomous agents, market makers, and LPs within the BNB Chain ecosystem.
