// pairs.ts — Universo curado de pares de BNB Chain para el screener precomputado.
// Todos resolubles vía Binance público (directo o cross sintético, ver binance.ts).
// Mezcla de quote estable (USDT) y cross variable/variable (relevantes para LP en Pancake v3).

export const SCREENER_PAIRS: string[] = [
  // Estables (BNB ecosystem)
  "BNB-USDT",
  "CAKE-USDT",
  "ETH-USDT",
  "BTC-USDT",
  "SOL-USDT",
  "XRP-USDT",
  "ADA-USDT",
  "DOGE-USDT",
  "AVAX-USDT",
  "LINK-USDT",
  "DOT-USDT",
  "MATIC-USDT",
  "UNI-USDT",
  "AAVE-USDT",
  "LTC-USDT",
  "ATOM-USDT",
  "NEAR-USDT",
  "FIL-USDT",
  // Cross variable/variable (replican precio de pool Pancake v3)
  "ETH-BNB",
  "CAKE-WBNB",
  "AAVE-WBNB",
  "LINK-BNB",
  "SOL-BNB",
  "BTC-BNB",
  "UNI-BNB",
  "DOT-BNB",
];
