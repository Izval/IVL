---
name: ivl-lateralization
description: |
  Computes IVL (Internal Variance of Lateralization), a quantitative metric that scores the
  quality and stability of a price's sideways range for CONCENTRATED LIQUIDITY PROVISION on
  PancakeSwap v3 (BNB Chain). IVL is intrinsically fractal: a single score integrates internal
  dispersion (volume-weighted variance vs VWAP), temporal persistence, and multi-scale agreement
  across 15m/1h/4h/1d. Outputs a deterministic, backtestable LP strategy spec (entry/exit/stop/
  take-profit/sizing/risk) plus a concentrate / hold / withdraw decision aware of LVR
  (Loss-Versus-Rebalancing). Uses CoinMarketCap as the signal layer.
  Use when the user asks whether a range is good for LPing, how stable a consolidation is, where
  to place concentrated-liquidity ticks, breakout risk of a sideways market, what range to expect
  for a pair starting to consolidate after a breakout (from its historical IVL profile), the
  expected time-in-range and fee yield, or wants a backtestable strategy spec. Works for stable
  pairs and for variable/variable pairs (e.g. AAVE/WBNB) where it analyzes the price RATIO
  (correlation).
  Trigger: "is this range good for LP", "concentrated liquidity", "PancakeSwap v3 range",
  "IVL", "lateralization quality", "breakout risk", "where to place ticks", "historical range",
  "expected yield", "what range for this pair", "/ivl"
license: Apache-2.0
compatibility: ">=1.0.0"
user-invocable: true
allowed-tools:
  - mcp__cmc-mcp__search_cryptos
  - mcp__cmc-mcp__get_crypto_quotes_latest
  - mcp__cmc-mcp__get_crypto_technical_analysis
  - mcp__cmc-mcp__get_crypto_marketcap_technical_analysis
  - mcp__cmc-mcp__get_global_crypto_derivatives_metrics
  - mcp__cmc-mcp__get_global_metrics_latest
---

# IVL: Internal Variance of Lateralization (LP quality for PancakeSwap v3)

You evaluate whether a sideways price range is a high-quality zone for **concentrated liquidity
provision** and produce a **deterministic, backtestable strategy spec**. The core metric is
**IVL**, which is intrinsically **fractal** (multi-scale), there is no separate "F-IVL".

## What IVL measures

Two ranges can have the exact same width yet completely different LP risk. IVL distinguishes them
by measuring the **internal quality** of the consolidation, not just its width.

A single IVL score integrates three inseparable components:
1. **Internal dispersion**, volume-weighted variance of closes around the VWAP, normalized by the
   squared channel width: `IVL_raw = σ²_lateral / (R − S)²`.
2. **Temporal persistence**, fraction of the window the price stays inside the core channel.
3. **Fractal consistency**, how strongly 15m, 1h, 4h and 1d confirm the *same* range (range overlap).

**Polarity (canonical): HIGH IVL = GOOD.**
- Price sweeping the whole channel extreme-to-extreme → `IVL_raw → ~0.25` → healthy, fee-generating.
- Price compressed/asymmetric against one edge → `IVL_raw → ~0.01` → imminent breakout risk.

`IVL Score` (0–100) maps this to bands: **80–100 excellent / 60–80 good / 40–60 neutral /
20–40 weak / 0–20 breakout risk**. See `references/ivl-math.md` for full formulas.

## Prerequisites (CoinMarketCap signal layer)

IVL's variance is computed from a candle series with volume. CoinMarketCap's free plan does not
serve historical OHLCV, so candles come from Binance public klines (BNB ecosystem, no key), and
**CMC provides the signal/context layer**. Verify the CMC MCP connection; if tools fail, ask the
user to configure it:

```json
{
  "mcpServers": {
    "cmc-mcp": {
      "url": "https://mcp.coinmarketcap.com/mcp",
      "headers": { "X-CMC-MCP-API-KEY": "your-api-key" }
    }
  }
}
```

Get a free API key at https://pro.coinmarketcap.com/login

## Workflow

### Step 1: Resolve the asset and pull CMC signal
- `search_cryptos` to resolve the token, then `get_crypto_quotes_latest` for the current price anchor.
- `get_crypto_technical_analysis` for the token: use the returned **support/resistance, RSI and
  pivot levels** to corroborate the detected range `[S, R]`.
- `get_global_crypto_derivatives_metrics`: **funding rate and open-interest change** are a breakout-
  pressure signal, extreme funding or sharply rising OI raises breakout risk regardless of IVL.
- `get_global_metrics_latest`: **Fear & Greed** as a regime filter (extreme readings precede expansion).

### Step 2: Build the candle set and compute IVL
Fetch OHLCV candles for the pair on the chosen scales, then compute IVL with the reference engine.
**Pick scales by LP horizon:** intraday LP → `15m,1h,4h,1d`; multi-week LP (typical) → `1d,3d,1w`.
The engine **matches the wall-clock horizon across scales** (each scale gets a candle count
proportional to its timeframe) so it never compares 30h vs 120 days, this is what makes the fractal
component meaningful.

```bash
node scripts/ivl.mjs --pair BNB-USDT --lookback 120 --json
node scripts/ivl.mjs --pair AAVE-WBNB --scales 1d,3d,1w --delta 0.16 --tvl 50000   # variable/variable
```

Returns `IVL Score`, the per-scale breakdown, the LP price band and deployable v3 ticks (`tickLower`/`tickUpper`), the LVR estimate
(timeframe-aware), the detected **lateral block** (current and best-historical) with its width %,
duration, expected time-in-range and fee APR (with `--tvl`), the **correlation factor** for
variable/variable pairs, and the full backtestable spec. The math lives in `scripts/ivl-core.mjs` +
`scripts/ivl-lp.mjs` (pure, dependency-free) so an agent can call it programmatically.

**Variable/variable pairs (e.g. AAVE/WBNB):** IVL analyzes the **price ratio** between the two
assets (their correlation), not the USD value, exactly what a PancakeSwap v3 pool of those two
tokens prices. The engine synthesizes the cross via USDT legs and reports the Pearson correlation
(high ⇒ stable ratio ⇒ better for LP).

### Step 2b: (Optional) Historical range profile & forward suggestion
When a pair is **breaking out / starting to consolidate** and you want a good range from how it has
*historically* lateralized, use the profile tool:

```bash
node scripts/profile.mjs --pair AAVE-WBNB --scale 1d --history 365 --delta 0.16 --tvl 50000
```

It partitions history into all lateral blocks and reports the **typical width %**, **typical
duration**, the **recurring S/R levels** the pair respects, a **volatility-contraction** flag
(is it entering a range now?), and a **suggested forward range + LP band + expected duration + APR**
anchored to the current price or nearest recurring level. Validate with `ivl.mjs` once the block
actually confirms.

### Step 3: Apply the LP decision matrix
Combine `IVL_raw` (primary scale) with the LVR level (`references/decision-matrix.md`):
- **IVL_raw ≥ 0.18 and LVR low → CONCENTRATE.** Deploy liquidity in the tight band `μ_vwap ± 2σ`.
- **0.10 ≤ IVL_raw < 0.18 → HOLD.** Keep the current range; re-evaluate next block.
- **IVL_raw < 0.10 or LVR high → WIDEN/WITHDRAW.** Widen to `2.5 × ATR14` or pull 100% of liquidity
  to stable reserves to mitigate impermanent loss and LVR.

Always cross-check with the CMC signal from Step 1: if funding/OI or RSI flag expansion, downgrade
the decision (do not concentrate even on a moderately high IVL).

### Step 4: Emit the backtestable spec (the deliverable)
Return the deterministic spec from `references/backtest-spec.md`: data sources, metrics, entry rules,
exit rules, stop-loss (range break), take-profit (fee target / regime change), position sizing
(IVL-score-proportional), and risk limits. This spec is **reproducible and backtestable**, it is not
a live agent. The conceptual execution target is the **Trust Wallet Agent Kit** (the spec names the
concentrate/hold/withdraw actions it would call; it does not sign or send transactions).

## LP philosophy: set-and-hold, don't chase

An LP is **not** intraday trading the pool. The goal is to keep capital deployed as long as possible,
maximizing it, with **infrequent** rebalances. So when a position breaks out of range, **do not chase
the price** (re-centering into a trend realizes impermanent loss and buys the asset high). Instead:

1. Detect that the breakout is **exhausting**, `node scripts/ivl.mjs ...` reports a **symmetric**
   RSI/MACD/divergence exhaustion signal (`scripts/ivl-signal.mjs`, both directions); this also maps
   to CMC's `get_crypto_technical_analysis` (RSI, MACD, S/R).
2. When exhausted, place a **forward range** the price will lateralize *into*, per direction:
   - **Bullish exhaustion** (rally topping): upper ≈ exhaustion zone, lower ≈ prior support.
   - **Bearish exhaustion** (selloff bottoming): lower ≈ exhaustion zone, upper ≈ prior resistance.
   - Width ≈ the pair's typical historical amplitude (`profile.mjs`).
3. **Hold** and collect fees; rebalance only on a genuine regime change (weeks), not on every exit.

## Backtesting & profitability demo

Validate before trusting, and quantify the uplift:

```bash
node scripts/backtest.mjs --pair BNB-USDT --lookback 96 --hold 48 --history 1000   # walk-forward
node scripts/compare.mjs  --pair AAVE-WBNB --scale 1d --history 365 --delta 0.16    # IVL vs naive vs random
node scripts/selftest.mjs                                                            # polarity + fractality (6/6)
```

`compare.mjs` models realistic **set-and-hold** LPs (fees − impermanent loss − rebalance cost): IVL
patiently holds and places forward ranges, vs naive (fixed band, chases on exit) and random ranges.
IVL cuts impermanent-loss exposure ~60–96% with ~5× fewer rebalances and beats random/naive range
selection on net return, turning losing positions profitable in trending regimes.

## Output format

Present results as:

```
## IVL, <PAIR> (<primary timeframe>)
- IVL Score: XX/100 (excellent/good/neutral/weak/breakout_risk)
- Range: [S, R]  (width X.X%)  | LP band (μ±2σ): [lower, upper]
- Components: dispersion=0.XX · persistence=0.XX · fractal=0.XX
- Scales confirming the range: 15m, 1h, ...
- LVR: <low/moderate/high>  | Breakout risk: <low/moderate/high>
- CMC signal: funding X.XX%, OI ΔX%, F&G XX, RSI XX

## Decision: CONCENTRATE / HOLD / WIDEN-WITHDRAW
<one-line rationale>

## Backtestable spec
<JSON from buildBacktestSpec>
```

## Handling failures
- **CMC tools unavailable**: proceed with the candle-only IVL and clearly note "CMC signal layer
  unavailable, breakout-pressure context skipped."
- **Pair has no direct listing** (e.g. BNB/AAVE): the engine synthesizes the cross via USDT legs,
  mirroring a real PancakeSwap v3 pool price.
- **Insufficient candles on a scale**: that scale is dropped from the fractal calculation and noted;
  IVL still computes from the remaining scales.
