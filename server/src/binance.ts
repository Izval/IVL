// binance.ts — Velas OHLCV públicas (ecosistema BNB, gratis, sin API key).
// VENDORED SNAPSHOT para el server (Apache-2.0); copia autocontenida del fetcher de la app.
// Fuente de la serie de precios+volumen que IVL necesita. Soporta cross sintético
// (ej. BNB/AAVE = BNBUSDT / AAVEUSDT) replicando el precio de un pool en PancakeSwap v3.
//
// Backend: MEXC (`api.mexc.com`), cuya API REST de klines es compatible con Binance
// (mismos params y formato de respuesta). Se usa MEXC porque Binance bloquea las IPs de
// datacenter/cloud (HTTP 451/403), lo que rompería la API en el edge de Cloudflare; MEXC
// responde desde el edge. Fase 2: PriceSource on-chain (GeckoTerminal, pool real de Pancake v3).

import type { IvlCandle, PriceSource } from "./ivl";

const BASE = "https://api.mexc.com";

// Vocabulario de intervalos de MEXC: usa "60m" (no "1h"); horas largas (2h/6h/8h/12h) no
// existen. Las escalas por defecto de IVL (15m/1h/4h/1d) quedan cubiertas mapeando 1h -> 60m.
const INTERVAL_MAP: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m",
  "4h": "4h", "1d": "1d", "1w": "1W", "1M": "1M",
};

const DIRECT_QUOTES = ["USDT", "FDUSD", "USDC", "BUSD", "TUSD"];
const TOKEN_ALIAS: Record<string, string> = { WBNB: "BNB", WETH: "ETH", WBTC: "BTC" };
const unwrap = (t: string) => TOKEN_ALIAS[t] ?? t;

export function toBinanceSymbol(pair: string): string {
  return pair.replace(/[-/]/g, "").toUpperCase();
}

export async function getKlines(pair: string, interval = "15m", limit = 120): Promise<IvlCandle[]> {
  const symbol = toBinanceSymbol(pair);
  const bn = INTERVAL_MAP[interval] ?? interval;
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${bn}&limit=${limit}`;
  // Next 16 ya no cachea fetch por defecto; el Worker (workerd) tampoco cachea subrequests.
  // UA de navegador: el CDN de Binance (nginx) responde 403 al UA por defecto de workerd.
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance klines ${symbol} ${bn} -> HTTP ${res.status} ${body}`);
  }
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    ts: r[0] as number,
    o: parseFloat(r[1] as string),
    h: parseFloat(r[2] as string),
    l: parseFloat(r[3] as string),
    c: parseFloat(r[4] as string),
    vol: parseFloat(r[5] as string),
  }));
}

export async function getKlinesCross(
  base: string,
  quote: string,
  interval = "15m",
  limit = 120
): Promise<IvlCandle[]> {
  const [baseK, quoteK] = await Promise.all([
    getKlines(`${base}USDT`, interval, limit),
    getKlines(`${quote}USDT`, interval, limit),
  ]);
  const qByTs = new Map(quoteK.map((c) => [c.ts, c]));
  const out: IvlCandle[] = [];
  for (const b of baseK) {
    const q = qByTs.get(b.ts);
    if (!q || q.c <= 0 || q.o <= 0 || q.h <= 0) continue;
    out.push({ ts: b.ts, o: b.o / q.o, h: b.h / q.l, l: b.l / q.h, c: b.c / q.c, vol: b.vol });
  }
  return out;
}

export async function getKlinesSmart(pair: string, interval = "15m", limit = 120): Promise<IvlCandle[]> {
  let [base, quote] = pair.replace("/", "-").toUpperCase().split("-");
  base = unwrap(base);
  quote = unwrap(quote);
  if (quote && !DIRECT_QUOTES.includes(quote)) return getKlinesCross(base, quote, interval, limit);
  return getKlines(`${base}${quote}`, interval, limit);
}

export async function getKlinesMultiScale(
  pair: string,
  scales: readonly string[],
  limit: number | Record<string, number> = 120
): Promise<Record<string, IvlCandle[]>> {
  const out: Record<string, IvlCandle[]> = {};
  const limitFor = (s: string) => (typeof limit === "number" ? limit : limit[s]);
  await Promise.all(
    scales
      .filter((s) => limitFor(s) > 0)
      .map(async (s) => {
        out[s] = await getKlinesSmart(pair, s, limitFor(s));
      })
  );
  return out;
}

/** PriceSource de Fase 1: velas OHLCV públicas de Binance (BNB Chain, sin API key). */
export const binanceSource: PriceSource = { getKlinesMultiScale };
