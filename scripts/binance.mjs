// binance.mjs - Public Binance OHLCV candles (BNB ecosystem, free, no API key).
// Source of the price+volume series that IVL needs for variance and backtesting.

const BASE = "https://api.binance.com";

// Maps "human" timeframes to Binance's interval format.
const INTERVAL_MAP = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "8h",
  "12h": "12h",
  "1d": "1d",
  "3d": "3d",
  "1w": "1w",
};

// Aliases of wrapped tokens / variants to their spot symbol on Binance.
const TOKEN_ALIAS = { WBNB: "BNB", WETH: "ETH", WBTC: "BTC" };
const unwrap = (t) => TOKEN_ALIAS[t] ?? t;

/**
 * Converts a pair like "BNB-USDT" / "BNB/USDT" to the Binance symbol "BNBUSDT".
 */
export function toBinanceSymbol(pair) {
  return pair.replace(/[-/]/g, "").toUpperCase();
}

/**
 * Downloads klines and normalizes them to the Candle type { ts,o,h,l,c,vol }.
 * @param {string} pair      e.g. "BNB-USDT" or "BNBUSDT"
 * @param {string} interval  e.g. "15m"
 * @param {number} limit     number of candles (max 1000 per request on Binance)
 */
export async function getKlines(pair, interval = "15m", limit = 120) {
  const symbol = toBinanceSymbol(pair);
  const bnInterval = INTERVAL_MAP[interval] ?? interval;
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${bnInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance klines ${symbol} ${bnInterval} -> HTTP ${res.status} ${body}`);
  }
  const rows = await res.json();
  // Binance format: [ openTime, open, high, low, close, volume, closeTime, ... ]
  return rows.map((r) => ({
    ts: r[0],
    o: parseFloat(r[1]),
    h: parseFloat(r[2]),
    l: parseFloat(r[3]),
    c: parseFloat(r[4]),
    vol: parseFloat(r[5]),
  }));
}

// Quote coins that exist as a direct pair on Binance spot.
const DIRECT_QUOTES = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD"];

/**
 * Synthesizes a BASE/QUOTE cross (e.g. BNB/AAVE) from two pairs against USDT:
 * price = BASEUSDT / QUOTEUSDT, aligned by timestamp. Replicates the price a
 * BASE/QUOTE pool would have on PancakeSwap v3 when there is no direct pair on the CEX.
 */
export async function getKlinesCross(base, quote, interval = "15m", limit = 120) {
  const [baseK, quoteK] = await Promise.all([
    getKlines(`${base}USDT`, interval, limit),
    getKlines(`${quote}USDT`, interval, limit),
  ]);
  const qByTs = new Map(quoteK.map((c) => [c.ts, c]));
  const out = [];
  for (const b of baseK) {
    const q = qByTs.get(b.ts);
    if (!q || q.c <= 0 || q.o <= 0 || q.h <= 0) continue;
    out.push({
      ts: b.ts,
      o: b.o / q.o,
      h: b.h / q.l, // cross high ~ high(base)/low(quote)
      l: b.l / q.h,
      c: b.c / q.c,
      vol: b.vol, // base asset volume as a proxy for pool volume
    });
  }
  return out;
}

/**
 * Resolves a pair to candles: tries a direct pair; if the quote is not direct
 * (e.g. BNB-AAVE) synthesizes the cross via USDT.
 */
export async function getKlinesSmart(pair, interval = "15m", limit = 120) {
  let [base, quote] = pair.replace("/", "-").toUpperCase().split("-");
  base = unwrap(base);
  quote = unwrap(quote);
  if (quote && !DIRECT_QUOTES.includes(quote)) {
    return getKlinesCross(base, quote, interval, limit);
  }
  return getKlines(`${base}${quote}`, interval, limit);
}

/**
 * Returns the two legs (vs USDT) of a variable/variable cross pair, to measure their correlation.
 * null if the pair is against a stable (there is no two-asset correlation to measure).
 */
export async function getCrossLegs(pair, interval = "1d", limit = 120) {
  let [base, quote] = pair.replace("/", "-").toUpperCase().split("-");
  base = unwrap(base);
  quote = unwrap(quote);
  if (!quote || DIRECT_QUOTES.includes(quote)) return null;
  const [baseLeg, quoteLeg] = await Promise.all([
    getKlines(`${base}USDT`, interval, limit),
    getKlines(`${quote}USDT`, interval, limit),
  ]);
  return { base, quote, baseLeg, quoteLeg };
}

/**
 * Downloads the candles for several scales at once (with synthetic cross resolution).
 * `limit` can be a number (same for all) or a map { scale: number of candles }
 * to align the time horizon across scales (see horizonLookbacks).
 */
export async function getKlinesMultiScale(pair, scales, limit = 120) {
  const out = {};
  const limitFor = (s) => (typeof limit === "number" ? limit : limit[s]);
  await Promise.all(
    scales
      .filter((s) => limitFor(s) > 0)
      .map(async (s) => {
        out[s] = await getKlinesSmart(pair, s, limitFor(s));
      })
  );
  return out;
}
