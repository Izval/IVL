// ivl-signal.mjs - Breakout exhaustion signals (RSI + MACD + divergence).
//
// LP philosophy: when a position breaks out you do NOT chase the price; you
// wait for the breakout to EXHAUST and lateralization to begin, then place a forward range
// (ceiling at the exhaustion, floor at the support, width ≈ typical historical width). These signals
// detect that exhaustion. They align with the CMC signal layer (get_crypto_technical_analysis).

const ema = (arr, period) => {
  const k = 2 / (period + 1);
  const out = [];
  let prev = arr[0];
  for (let i = 0; i < arr.length; i++) {
    prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

/** Wilder RSI (period=14) over closes. Returns the RSI series. */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** MACD(12,26,9): { macd, signal, hist } as series. */
export function macdSeries(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const macd = closes.map((_, i) => ef[i] - es[i]);
  const signal = ema(macd, sig);
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
}

/** Indices of local extrema of a series (window ±w). kind: 'max' | 'min'. */
function localExtrema(arr, w = 3, kind = "max") {
  const idx = [];
  for (let i = w; i < arr.length - w; i++) {
    let ok = true;
    for (let k = 1; k <= w; k++) {
      const bad = kind === "max" ? arr[i] < arr[i - k] || arr[i] < arr[i + k] : arr[i] > arr[i - k] || arr[i] > arr[i + k];
      if (bad) { ok = false; break; }
    }
    if (ok) idx.push(i);
  }
  return idx;
}

/** Bearish divergence (ceiling): higher price high but lower RSI high. */
export function bearishDivergence(closes, rsi) {
  const peaks = localExtrema(closes, 3, "max");
  if (peaks.length < 2) return false;
  const [a, b] = peaks.slice(-2);
  if (rsi[a] == null || rsi[b] == null) return false;
  return closes[b] > closes[a] && rsi[b] < rsi[a];
}

/** Bullish divergence (floor): lower price low but higher RSI low. */
export function bullishDivergence(closes, rsi) {
  const troughs = localExtrema(closes, 3, "min");
  if (troughs.length < 2) return false;
  const [a, b] = troughs.slice(-2);
  if (rsi[a] == null || rsi[b] == null) return false;
  return closes[b] < closes[a] && rsi[b] > rsi[a];
}

/**
 * Breakout exhaustion signal, SYMMETRIC (bullish and bearish). Lateralization follows
 * exhaustion in either direction, so the LP places the forward range accordingly:
 *   - BULLISH exhaustion  (rally topping)    → ceiling ≈ exhaustion, floor ≈ prior support.
 *   - BEARISH exhaustion  (selloff bottoming) → floor ≈ exhaustion, ceiling ≈ prior resistance.
 *
 * Bullish breakout exhausting: RSI overbought (>70) rolling over, MACD hist falling from its
 *   positive peak, bearish divergence. Bearish breakdown exhausting: RSI oversold (<30) turning up,
 *   MACD hist rising from its negative trough, bullish divergence.
 *
 * @returns { exhausted, strong, direction: 'bullish'|'bearish'|null, rsi, macdHist, reasons[] }
 */
export function exhaustionSignal(candles, lookback = 60) {
  const closes = candles.slice(-lookback).map((c) => c.c);
  if (closes.length < 30) return { exhausted: false, direction: null, reasons: ["insufficient_data"] };
  const rsi = rsiSeries(closes);
  const { hist } = macdSeries(closes);
  const last = closes.length - 1;
  const rsiNow = rsi[last];
  const valid = rsi.slice(-15).filter((x) => x != null);
  const rsiMax = Math.max(...valid);
  const rsiMin = Math.min(...valid);
  const histRecent = hist.slice(-10);
  const histPeak = Math.max(...histRecent);
  const histTrough = Math.min(...histRecent);

  // Bullish exhaustion (ceiling)
  const bull = [];
  if (rsiMax > 70 && rsiNow != null && rsiNow < rsiMax - 5) bull.push("rsi_overbought_rolling_over");
  if (histPeak > 0 && hist[last] < histPeak * 0.5) bull.push("macd_upside_momentum_fading");
  if (bearishDivergence(closes, rsi)) bull.push("bearish_divergence");

  // Bearish exhaustion (floor)
  const bear = [];
  if (rsiMin < 30 && rsiNow != null && rsiNow > rsiMin + 5) bear.push("rsi_oversold_turning_up");
  if (histTrough < 0 && hist[last] > histTrough * 0.5) bear.push("macd_downside_momentum_fading");
  if (bullishDivergence(closes, rsi)) bear.push("bullish_divergence");

  // Dominant direction: the one that accumulates more signals (tie: none).
  let direction = null;
  let reasons = [];
  if (bull.length > bear.length) { direction = "bullish"; reasons = bull; }
  else if (bear.length > bull.length) { direction = "bearish"; reasons = bear; }
  else if (bull.length > 0) { direction = "mixed"; reasons = [...bull, ...bear]; }

  return {
    exhausted: reasons.length >= 1,
    strong: reasons.length >= 2,
    direction,
    rsi: rsiNow != null ? +rsiNow.toFixed(1) : null,
    macdHist: +hist[last].toFixed(6),
    reasons,
  };
}
