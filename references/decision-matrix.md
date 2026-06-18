# LP decision matrix (IVL × LVR)

The liquidity-provision action is decided by combining the primary scale's `IVL_raw` with the
estimated LVR level. The decision is **emitted** by the skill as part of the spec; the conceptual
execution is the **Trust Wallet Agent Kit** (no transactions are signed or sent here).

```
        [ Real-time computation of the pool's IVL and LVR ]
                            |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
   [ High IVL ]      [ Moderate IVL ]    [ Low IVL or High LVR ]
   IVL_raw ≥ 0.18     0.10 ≤ IVL < 0.18    IVL_raw < 0.10  or  LVR high
   and low LVR             |                   |
        |                  |                   |
        v                  v                   v
 [ CONCENTRATE ]      [ HOLD ]      [ WIDEN / WITHDRAW ]
```

## CONCENTRATE: `IVL_raw ≥ 0.18` and low LVR
Price oscillates harmonically inside the channel. Concentrate capital in a narrow, high-density band
to maximize fee generation:

```
P_lower = μ_vwap − 2·σ_lateral
P_upper = μ_vwap + 2·σ_lateral
```

## HOLD: `0.10 ≤ IVL_raw < 0.18`
Acceptable lateralization with no clear signal to concentrate or to exit. Keep the current range and
re-evaluate on the next block.

## WIDEN / WITHDRAW: `IVL_raw < 0.10` or LVR `high`
Unstable consolidation preceding an aggressive breakout, or an order imbalance that favors external
arbitrage against the LP. The agent:
- **widens** the tick range preemptively to `2.5 × ATR14`, or
- **withdraws 100%** of the liquidity, reallocating to safe stable reserves in the
  Trust Wallet Agent Kit vault.

## CMC signal filter (context layer)
Regardless of the matrix cell, **downgrade the decision** (do not concentrate) if the CoinMarketCap
signal indicates expansion pressure:
- Extreme funding rate or abrupt change in Open Interest (`get_global_crypto_derivatives_metrics`).
- RSI in extreme overbought/oversold or a confirmed S/R breakout (`get_crypto_technical_analysis`).
- Fear & Greed at extremes (`get_global_metrics_latest`).

## LP philosophy: set-and-hold, do NOT chase the price

An LP does not intraday-trade the pool: it deploys capital and **holds it as long as possible**
while maximizing capital, with **infrequent** rebalances. Therefore:

- **When the position breaks, do NOT follow the price.** Repositioning the band to chase a trend
  realizes impermanent loss and buys the asset expensive. Instead, **wait** for the breakout to
  **exhaust** and for price to start **lateralizing again**.
- **Exhaustion is symmetric** (`scripts/ivl-signal.mjs`, detects both directions):
  - **Bullish exhaustion** (rally topping out): RSI overbought >70 turning over, MACD losing bullish
    momentum, bearish divergence → forward range with **ceiling ≈ exhaustion, floor ≈ prior support**.
  - **Bearish exhaustion** (selloff bottoming): RSI oversold <30 turning up, MACD losing
    bearish momentum, bullish divergence → forward range with **floor ≈ exhaustion, ceiling ≈ prior resistance**.
  - Width ≈ the pair's typical historical amplitude (8–16% in variable/variable). It is a band that
    price will lateralize *into*, not one that chases where price is right now.
- **Hold and collect fees** while it lateralizes; rebalance only on a real regime change
  (weeks), not on every exit.

The realistic backtest (`scripts/compare.mjs`, set-and-hold model with patience) shows that this
approach cuts IL by ~60–96% and beats naive/random range selection, with ~5× fewer rebalances.

## Note on score vs. action
The **IVL Score (0–100)** is the range's *quality grade* (integrating dispersion + persistence +
fractality). The **action** threshold uses `IVL_raw` directly. A range can qualify as
`excellent` (high score, consistent multiscale) and still land in **HOLD** if its `IVL_raw`
does not reach 0.18 (there is not yet a full edge-to-edge oscillation). Concentrate is the premium signal.
