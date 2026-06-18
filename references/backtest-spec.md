# Backtestable IVL-LP spec (`ivl.backtest-spec/v1`)

The deliverable for the *Strategy Skills* track is a **deterministic, backtestable spec**, not a live
agent. The skill generates it with `buildBacktestSpec()` (`scripts/ivl-strategy.mjs`) from the result
of `computeIVL()`. All rules are reproducible and verifiable with `scripts/backtest.mjs`.

## Schema

| Field                | Description |
|----------------------|-------------|
| `schema`             | `"ivl.backtest-spec/v1"` |
| `strategy`           | `"IVL-LP-ConcentratedRange"` |
| `venue`              | `"PancakeSwap v3 (BNB Chain)"` |
| `execution_target`   | `"Trust Wallet Agent Kit"` (conceptual target; the skill does not sign tx) |
| `data`               | sources (candles = public Binance, signal = CMC MCP), pair, primary timeframe, fractal scales |
| `metrics`            | `ivl_raw_primary`, `ivl_score`, `classification`, `breakout_risk`, `lvr_estimate`, `lvr_level`, `scales_confirming`, `components{dispersion,persistence,fractal}` |
| `entry_rules`        | deterministic entry conditions (lateral block, score ≥ 60, confirmation ≥ 3 scales, LP action) |
| `exit_rules`         | exit on range exit (2 candles out), score < 40, confirmation < 2 scales |
| `stop_loss`          | `range_break`: `[level_lower, level_upper]` (μ ± 2σ) |
| `take_profit`        | `fee_target_or_regime_change` |
| `position_sizing`    | `ivl_score_proportional`: `alloc_fraction = max_alloc · score/100`, `position_usd` |
| `risk_limits`        | `max_lvr_level`, `withdraw_if`, `widen_range_if`, `max_positions` |
| `decision`           | action (`concentrate`/`hold`/`withdraw_or_widen`), `rationale`, `breakoutRisk`, `lpRange` |

## How to backtest

```bash
node scripts/backtest.mjs --pair BNB-USDT --lookback 96 --hold 48 --step 16 --history 1000
```

Walk-forward: at each point it computes IVL over the prior window, deploys the IVL range (`μ ± 2σ`) and
holds it for `hold` candles, measuring **time-in-range**, **breakout rate**, and **fee efficiency
(fees / range width)**. It compares against a naive wide-range baseline `[S, R]`. The IVL range
captures more fees per unit of capital when IVL justifies concentrating.

## Example output (BNB-USDT, 15m, lookback 120)

```json
{
  "schema": "ivl.backtest-spec/v1",
  "strategy": "IVL-LP-ConcentratedRange",
  "venue": "PancakeSwap v3 (BNB Chain)",
  "execution_target": "Trust Wallet Agent Kit",
  "data": {
    "candles_source": "Binance public klines",
    "signal_source": "CoinMarketCap MCP (S/R, derivatives, fear&greed)",
    "pair": "BNB-USDT", "primary_timeframe": "15m",
    "fractal_scales": ["15m", "1h", "4h", "1d"]
  },
  "metrics": {
    "ivl_raw_primary": 0.06781, "ivl_score": 34, "classification": "weak",
    "breakout_risk": "high", "lvr_estimate": 0.414249, "lvr_level": "low",
    "scales_confirming": ["15m"],
    "components": { "dispersion": 0.2957, "persistence": 0.9975, "fractal": 0.2163 }
  },
  "entry_rules": [
    "Classify lateral block: normalized width W/S <= 0.05",
    "Require IVL Score >= 60 (classification >= 'good')",
    "Require fractal confirmation in >= 3 of 4 scales",
    "LP action: withdraw_or_widen"
  ],
  "exit_rules": [
    "Exit if the price closes outside the LP range for 2 consecutive candles (range break).",
    "Exit if the IVL Score falls below 40 (deteriorated lateralization).",
    "Exit if fractal confirmation falls below 2 scales."
  ],
  "lp_range": {
    "price_convention": "USDT per 1 BNB",
    "price_lower": 601.16, "price_upper": 620.08,
    "tick_lower": 63940, "tick_upper": 64170, "tick_spacing": 10, "fee_tier": 0.0005
  },
  "stop_loss": { "type": "range_break", "level_lower": 601.16, "level_upper": 620.08 },
  "take_profit": { "type": "fee_target_or_regime_change" },
  "position_sizing": {
    "method": "ivl_score_proportional", "equity_reference": 10000,
    "alloc_fraction": 0.17, "position_usd": 1700, "max_alloc_fraction": 0.5
  },
  "risk_limits": {
    "max_lvr_level": "moderate", "withdraw_if": "IVL_raw < 0.1 OR lvr_level == 'high'",
    "widen_range_if": "breakout_risk == 'moderate' -> widen to 2.5xATR14", "max_positions": 1
  },
  "decision": { "action": "withdraw_or_widen", "breakoutRisk": "high" }
}
```

> In this example (recent trending market) IVL does **not** enter: the tight 15m range is not
> confirmed by 1h/4h/1d (low fractal), so the skill protects the LP by recommending not to deploy.
> That is the correct behavior: IVL only deploys when all scales confirm.
