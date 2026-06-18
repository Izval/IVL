// ivl-strategy.mjs - LP decision matrix and backtestable spec generator.
//
// The "Strategy Skills" track requires a DETERMINISTIC SPEC (entry/exit rules,
// stop-loss, take-profit, sizing and risk limits), NOT a live agent. This module
// converts the output of computeIVL() into that spec, along with the recommended LP action
// (concentrate / hold / withdraw) that is IVL- and LVR-aware.

import { atr } from "./ivl-core.mjs";
import { rangeToTicks } from "./ivl-ticks.mjs";

// Decision matrix thresholds (over IVL_raw of the primary scale).
export const IVL_CONCENTRATE = 0.18; // high IVL: healthy end-to-end oscillation
export const IVL_WITHDRAW = 0.1; // low IVL: compression/asymmetry -> breakout risk

/**
 * LP decision from the computeIVL result.
 * @param {ReturnType<import('./ivl-core.mjs').computeIVL>} ivl
 * @param {{ candlesPrimary?: import('./ivl-core.mjs').Candle[] }} [ctx]
 */
export function decideLP(ivl, ctx = {}) {
  const raw = ivl.ivl.raw_primary;
  const lvrLevel = ivl.lvr.level;
  const primary = ivl.metricsByScale[ivl.primaryScale];

  // Breakout risk: combines low IVL, high LVR and weak fractal confirmation.
  let breakoutRisk = "low";
  if (raw < IVL_WITHDRAW || lvrLevel === "high") breakoutRisk = "high";
  else if (raw < IVL_CONCENTRATE || lvrLevel === "moderate" || ivl.ivl.fractal < 0.4)
    breakoutRisk = "moderate";

  let action, rationale, lpRange;
  if (raw >= IVL_CONCENTRATE && lvrLevel === "low") {
    // CONCENTRATE: narrow band μ ± 2σ to maximize fee capture.
    action = "concentrate";
    rationale =
      "High IVL and low LVR: the price oscillates harmonically within the channel. " +
      "Concentrating capital in a narrow band (μ_vwap ± 2σ) maximizes fee generation.";
    lpRange = { lower: ivl.lpRange.lower, upper: ivl.lpRange.upper, basis: "vwap_2sigma" };
  } else if (raw < IVL_WITHDRAW || lvrLevel === "high") {
    // WITHDRAW / WIDEN: unstable consolidation or adverse selection from arbitrage.
    const atr14 = primary?.atr14 ?? (ctx.candlesPrimary ? atr(ctx.candlesPrimary, 14) : 0);
    action = "withdraw_or_widen";
    rationale =
      "Low IVL or high LVR: unstable consolidation that precedes a breakout, or imbalance " +
      "that favors arbitrage. Widen to 2.5×ATR14 or withdraw 100% of the liquidity to stable reserves.";
    lpRange = {
      lower: ivl.lpRange.vwap - 2.5 * atr14,
      upper: ivl.lpRange.vwap + 2.5 * atr14,
      basis: "vwap_2_5_atr14",
      atr14,
    };
  } else {
    // HOLD: intermediate zone, without reallocating capital.
    action = "hold";
    rationale =
      "Moderate IVL: acceptable lateralization with no clear signal to concentrate or exit. " +
      "Hold the current range and reassess on the next block.";
    lpRange = { lower: ivl.range.low, high: ivl.range.high, basis: "observed_range" };
  }

  return { action, rationale, breakoutRisk, lpRange };
}

/**
 * Builds the deterministic BACKTESTABLE SPEC (entry/exit/SL/TP/sizing/risk).
 * It is the central deliverable of the skill: reproducible rules, not live execution.
 *
 * @param {object} params
 * @param {string} params.pair                  e.g. "BNB-USDT"
 * @param {string} params.primaryTimeframe      e.g. "15m"
 * @param {string[]} params.scales              fractal scales used
 * @param {ReturnType<import('./ivl-core.mjs').computeIVL>} params.ivl
 * @param {ReturnType<typeof decideLP>} params.decision
 * @param {number} [params.equity]              reference capital for sizing
 */
export function buildBacktestSpec({
  pair,
  primaryTimeframe,
  scales,
  ivl,
  decision,
  equity = 10000,
}) {
  const raw = ivl.ivl.raw_primary;
  const { lower, upper } = ivl.lpRange;

  // Sizing proportional to range quality: higher IVL Score -> larger allocation,
  // bounded by risk limits. Score 0..100 -> fraction 0..maxAlloc of equity.
  const maxAlloc = 0.5; // never more than 50% of equity in a single LP position
  const allocFraction = +(maxAlloc * (ivl.ivlScore / 100)).toFixed(4);
  const positionUsd = +(equity * allocFraction).toFixed(2);
  // Estimated v3 ticks for the LP band (snapped to the fee tier's spacing).
  const ticks = rangeToTicks(lower, upper, ivl.lpRange.pool_fee_tier ?? 0.0005);

  return {
    schema: "ivl.backtest-spec/v1",
    strategy: "IVL-LP-ConcentratedRange",
    venue: "PancakeSwap v3 (BNB Chain)",
    execution_target: "Trust Wallet Agent Kit",
    data: {
      candles_source: "Binance public klines",
      signal_source: "CoinMarketCap MCP (S/R, derivatives, fear&greed)",
      pair,
      primary_timeframe: primaryTimeframe,
      fractal_scales: scales,
    },
    metrics: {
      ivl_raw_primary: +raw.toFixed(5),
      ivl_score: ivl.ivlScore,
      classification: ivl.classification,
      breakout_risk: decision.breakoutRisk,
      lvr_estimate: +ivl.lvr.arb.toFixed(6),
      lvr_level: ivl.lvr.level,
      scales_confirming: ivl.scalesConfirming,
      components: {
        dispersion: +ivl.ivl.dispersion.toFixed(4),
        persistence: +ivl.ivl.persistence.toFixed(4),
        fractal: +ivl.ivl.fractal.toFixed(4),
      },
    },
    // --- Deterministic backtestable rules ---
    entry_rules: [
      `Classify lateral block: normalized width W/S <= ${ivl.range.widthPct <= 0.05 ? "0.05" : "(not met)"}`,
      `Require IVL Score >= 60 (classification >= 'good')`,
      `Require fractal confirmation in >= 3 of ${scales.length} scales`,
      `LP action: ${decision.action}`,
      decision.action === "concentrate"
        ? `Deploy concentrated liquidity in [${decision.lpRange.lower?.toFixed(4)}, ${decision.lpRange.upper?.toFixed(4)}] (μ_vwap ± 2σ)`
        : `Do not deploy concentrated liquidity (action: ${decision.action})`,
    ],
    exit_rules: [
      "Exit if the price closes outside the LP range for 2 consecutive candles (range break).",
      "Exit if the IVL Score falls below 40 (deteriorated lateralization).",
      "Exit if fractal confirmation falls below 2 scales.",
    ],
    lp_range: {
      // What the LP sees/enters on screen: prices. Convention: {quote} per 1 {base}.
      price_convention: (() => {
        const [b, q] = String(pair).replace("/", "-").toUpperCase().split("-");
        return q ? `${q} per 1 ${b}` : "price";
      })(),
      price_lower: +lower.toFixed(6),
      price_upper: +upper.toFixed(6),
      // Deployable v3 ticks (integer indices snapped to the fee tier's tickSpacing), on-chain only.
      tick_lower: ticks?.tickLower ?? null,
      tick_upper: ticks?.tickUpper ?? null,
      tick_spacing: ticks?.tickSpacing ?? null,
      fee_tier: ticks?.feeTier ?? null,
    },
    stop_loss: {
      type: "range_break",
      level_lower: +lower.toFixed(6),
      level_upper: +upper.toFixed(6),
      note: "Close outside [lower, upper] = position 100% in the lower-value asset; withdraw.",
    },
    take_profit: {
      type: "fee_target_or_regime_change",
      note:
        "Collect accrued fees and rebalance when the IVL Score drops from 'excellent' to 'neutral' " +
        "or when the estimated LVR exceeds the 'moderate' level.",
    },
    position_sizing: {
      method: "ivl_score_proportional",
      equity_reference: equity,
      alloc_fraction: allocFraction,
      position_usd: positionUsd,
      max_alloc_fraction: maxAlloc,
    },
    risk_limits: {
      max_lvr_level: "moderate",
      withdraw_if: `IVL_raw < ${IVL_WITHDRAW} OR lvr_level == 'high'`,
      widen_range_if: "breakout_risk == 'moderate' -> widen to 2.5×ATR14",
      max_positions: 1,
    },
    decision,
  };
}
