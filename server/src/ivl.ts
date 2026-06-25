// ivl.ts — Motor IVL (Internal Variance of Lateralization).
//
// VENDORED SNAPSHOT para el server (Apache-2.0). El motor canónico es el de referencia en
// `../../scripts/ivl-core.mjs` (+ la copia TS de la app); esta es una copia autocontenida para
// que el Worker bundle sin dependencias externas. Si cambia el motor, re-sincronizar esta copia.
//
// Port TypeScript del motor de referencia en `scripts/ivl-core.mjs` +
// `ivl-strategy.mjs`. IVL cuantifica la calidad/estabilidad de una lateralización para
// provisión de liquidez concentrada (PancakeSwap v3 / BNB Chain). La fractalidad es
// INTRÍNSECA: un solo score integra dispersión interna, persistencia temporal y
// consistencia multiescala (15m/1h/4h/1d). Polaridad canónica: IVL ALTO = BUENO.

export interface IvlCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

/**
 * Fuente de velas para IVL. El motor es agnóstico a la procedencia de los datos: solo
 * necesita OHLCV (`IvlCandle`) por escala. La implementación de Fase 1 es Binance público
 * (`binanceSource` en binance.ts). Añadir un venue nuevo (ej. Uniswap v3/v4 vía subgraph) =
 * escribir otro `PriceSource`, sin tocar la matemática de este archivo.
 */
export interface PriceSource {
  getKlinesMultiScale(
    pair: string,
    scales: readonly string[],
    limit: number | Record<string, number>
  ): Promise<Record<string, IvlCandle[]>>;
}

export const IVL_RAW_MAX = 0.25;
export const IVL_EXCELLENT = 0.18; // referencia "excelente" = umbral de concentración
export const DEFAULT_DELTA = 0.05;
export const DEFAULT_SCALES = ["15m", "1h", "4h", "1d"] as const;
export const SCALE_WEIGHTS: Record<string, number> = { "15m": 0.2, "1h": 0.35, "4h": 0.3, "1d": 0.15 };
export const IVL_CONCENTRATE = 0.18;
export const IVL_WITHDRAW = 0.1;

// Minutos por timeframe — para igualar el horizonte temporal (wall-clock) entre escalas.
export const TF_MINUTES: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240,
  "6h": 360, "8h": 480, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080,
};
export const MIN_SCALE_CANDLES = 6;

/**
 * Velas por escala para cubrir el MISMO horizonte temporal que `primaryLookback` velas de la
 * escala primaria (evita comparar 30h vs 120 días). Escalas con < MIN_SCALE_CANDLES se descartan.
 */
export function horizonLookbacks(
  primaryScale: string,
  primaryLookback: number,
  scales: readonly string[]
): Record<string, number> {
  const pMin = TF_MINUTES[primaryScale] ?? 15;
  const horizonMin = primaryLookback * pMin;
  const out: Record<string, number> = {};
  for (const s of scales) {
    const m = TF_MINUTES[s] ?? 15;
    const n = Math.round(horizonMin / m);
    if (n >= MIN_SCALE_CANDLES) out[s] = n;
  }
  out[primaryScale] = primaryLookback;
  return out;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export function computeVWAP(candles: IvlCandle[]): number {
  const vSum = sum(candles.map((c) => c.vol));
  if (vSum <= 0) return sum(candles.map((c) => c.c)) / candles.length;
  return sum(candles.map((c) => c.c * c.vol)) / vSum;
}

export function weightedVariance(candles: IvlCandle[], mu: number): number {
  const vSum = sum(candles.map((c) => c.vol));
  if (vSum <= 0) return sum(candles.map((c) => (c.c - mu) ** 2)) / candles.length;
  return sum(candles.map((c) => c.vol * (c.c - mu) ** 2)) / vSum;
}

export function atr(candles: IvlCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return sum(slice) / slice.length;
}

export function intrablockVol(candles: IvlCandle[]): number {
  if (candles.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].c > 0) rets.push(Math.log(candles[i].c / candles[i - 1].c));
  }
  if (rets.length === 0) return 0;
  const m = sum(rets) / rets.length;
  return Math.sqrt(sum(rets.map((r) => (r - m) ** 2)) / rets.length);
}

export interface ScaleMetrics {
  valid: boolean;
  reason?: string;
  n: number;
  S: number;
  R: number;
  W: number;
  widthPct: number;
  mu: number;
  variance: number;
  sigma: number;
  ivlRaw: number;
  dispersionScore: number;
  persistence: number;
  isLateral: boolean;
  sigmaB: number;
  atr14: number;
}

export function scaleMetrics(candles: IvlCandle[], delta = DEFAULT_DELTA): ScaleMetrics {
  if (!candles || candles.length < 5) {
    return { valid: false, reason: "insufficient_candles", n: candles?.length ?? 0 } as ScaleMetrics;
  }
  const S = Math.min(...candles.map((c) => c.l));
  const R = Math.max(...candles.map((c) => c.h));
  const W = R - S;
  const widthPct = S > 0 ? W / S : Infinity;
  const mu = computeVWAP(candles);
  const variance = weightedVariance(candles, mu);
  const sigma = Math.sqrt(variance);
  const ivlRaw = W > 0 ? variance / (W * W) : 0;
  const coreLow = mu - W / 2;
  const coreHigh = mu + W / 2;
  const inside = candles.filter((c) => c.c >= coreLow && c.c <= coreHigh).length;
  return {
    valid: true,
    n: candles.length,
    S,
    R,
    W,
    widthPct,
    mu,
    variance,
    sigma,
    ivlRaw,
    dispersionScore: clamp(ivlRaw / IVL_EXCELLENT),
    persistence: inside / candles.length,
    isLateral: widthPct <= delta,
    sigmaB: intrablockVol(candles),
    atr14: atr(candles, 14),
  };
}

export function rangeOverlap(a: [number, number], b: [number, number]): number {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
  return union > 0 ? inter / union : 0;
}

export function fractalConsistency(metrics: ScaleMetrics[]): number {
  const ranges = metrics.filter((m) => m && m.valid).map((m) => [m.S, m.R] as [number, number]);
  if (ranges.length < 2) return ranges.length === 1 ? 1 : 0;
  const pairs: number[] = [];
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++) pairs.push(rangeOverlap(ranges[i], ranges[j]));
  return sum(pairs) / pairs.length;
}

export interface LvrEstimate {
  arb: number;
  level: "low" | "moderate" | "high";
  sigmaB: number;
  gamma: number;
}

export function estimateLVR(sigmaB: number, gamma = 0.0005, tfMinutes = 15): LvrEstimate {
  if (sigmaB <= 0) return { arb: 0, level: "low", sigmaB, gamma };
  const arb = (sigmaB * sigmaB) / 2 + (1.7164 * gamma) / sigmaB;
  // Normaliza σ_b a "equivalente 15m" (escalado de difusión) antes de clasificar el riesgo.
  const sigmaBNorm = sigmaB / Math.sqrt(Math.max(tfMinutes, 1) / 15);
  let level: LvrEstimate["level"] = "low";
  if (sigmaBNorm > 0.008) level = "high";
  else if (sigmaBNorm > 0.004) level = "moderate";
  return { arb, level, sigmaB, gamma };
}

export type Classification = "excellent" | "good" | "neutral" | "weak" | "breakout_risk";

export function classifyScore(score: number): Classification {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "neutral";
  if (score >= 20) return "weak";
  return "breakout_risk";
}

function weightedGeomean(values: number[], weights: number[]): number {
  const wSum = sum(weights);
  if (wSum <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc += (weights[i] / wSum) * Math.log(Math.max(values[i], 1e-6));
  return Math.exp(acc);
}

export interface IvlResult {
  ok: boolean;
  reason?: string;
  primaryScale: string;
  ivl: { raw_primary: number; dispersion: number; persistence: number; fractal: number; combined: number };
  ivlScore: number;
  classification: Classification;
  range: { low: number; high: number; width: number; widthPct: number };
  lpRange: { lower: number; upper: number; vwap: number; sigma: number; pool_fee_tier: number };
  lvr: LvrEstimate;
  scalesConfirming: string[];
  metricsByScale: Record<string, ScaleMetrics>;
}

export function computeIVL(
  candlesByScale: Record<string, IvlCandle[]>,
  opts: { delta?: number; gamma?: number; primaryScale?: string } = {}
): IvlResult {
  const delta = opts.delta ?? DEFAULT_DELTA;
  const gamma = opts.gamma ?? 0.0005;
  const scales = Object.keys(candlesByScale);
  const metricsByScale: Record<string, ScaleMetrics> = {};
  for (const s of scales) metricsByScale[s] = scaleMetrics(candlesByScale[s], delta);

  const valid = scales.filter((s) => metricsByScale[s].valid);
  if (valid.length === 0) {
    return { ok: false, reason: "no_valid_scales", metricsByScale } as unknown as IvlResult;
  }

  const primaryScale =
    opts.primaryScale && metricsByScale[opts.primaryScale]?.valid ? opts.primaryScale : valid[0];
  const primary = metricsByScale[primaryScale];

  const dispWeights = valid.map((s) => SCALE_WEIGHTS[s] ?? 1 / valid.length);
  const dispersion = weightedGeomean(valid.map((s) => metricsByScale[s].dispersionScore), dispWeights);
  const persistence =
    sum(valid.map((s, i) => metricsByScale[s].persistence * dispWeights[i])) / sum(dispWeights);
  const overlap = fractalConsistency(valid.map((s) => metricsByScale[s]));
  const lateralFrac = valid.filter((s) => metricsByScale[s].isLateral).length / valid.length;
  const fractal = overlap * (0.5 + 0.5 * lateralFrac);

  const combined = weightedGeomean([dispersion, persistence, fractal], [0.5, 0.2, 0.3]);
  const ivlScore = Math.round(clamp(combined) * 100);
  const lvr = estimateLVR(primary.sigmaB, gamma, TF_MINUTES[primaryScale] ?? 15);

  return {
    ok: true,
    primaryScale,
    ivl: { raw_primary: primary.ivlRaw, dispersion, persistence, fractal, combined },
    ivlScore,
    classification: classifyScore(ivlScore),
    range: { low: primary.S, high: primary.R, width: primary.W, widthPct: primary.widthPct },
    lpRange: {
      lower: primary.mu - 2 * primary.sigma,
      upper: primary.mu + 2 * primary.sigma,
      vwap: primary.mu,
      sigma: primary.sigma,
      pool_fee_tier: gamma,
    },
    lvr,
    scalesConfirming: valid.filter((s) => metricsByScale[s].isLateral),
    metricsByScale,
  };
}

export interface LpDecision {
  action: "concentrate" | "hold" | "withdraw_or_widen";
  rationale: string;
  breakoutRisk: "low" | "moderate" | "high";
  lpRange: { lower?: number; upper?: number; high?: number; basis: string; atr14?: number };
}

export function decideLP(ivl: IvlResult, candlesPrimary?: IvlCandle[]): LpDecision {
  const raw = ivl.ivl.raw_primary;
  const lvrLevel = ivl.lvr.level;
  const primary = ivl.metricsByScale[ivl.primaryScale];

  let breakoutRisk: LpDecision["breakoutRisk"] = "low";
  if (raw < IVL_WITHDRAW || lvrLevel === "high") breakoutRisk = "high";
  else if (raw < IVL_CONCENTRATE || lvrLevel === "moderate" || ivl.ivl.fractal < 0.4)
    breakoutRisk = "moderate";

  if (raw >= IVL_CONCENTRATE && lvrLevel === "low") {
    return {
      action: "concentrate",
      rationale:
        "IVL alto y LVR baja: el precio oscila armónicamente dentro del canal. Concentrar capital en banda estrecha (μ_vwap ± 2σ) maximiza la generación de comisiones.",
      breakoutRisk,
      lpRange: { lower: ivl.lpRange.lower, upper: ivl.lpRange.upper, basis: "vwap_2sigma" },
    };
  }
  if (raw < IVL_WITHDRAW || lvrLevel === "high") {
    const atr14 = primary?.atr14 ?? (candlesPrimary ? atr(candlesPrimary, 14) : 0);
    return {
      action: "withdraw_or_widen",
      rationale:
        "IVL bajo o LVR alta: consolidación inestable que precede a ruptura o desequilibrio que favorece el arbitraje. Ampliar a 2.5×ATR14 o retirar el 100% de la liquidez a reservas estables.",
      breakoutRisk,
      lpRange: {
        lower: ivl.lpRange.vwap - 2.5 * atr14,
        upper: ivl.lpRange.vwap + 2.5 * atr14,
        basis: "vwap_2_5_atr14",
        atr14,
      },
    };
  }
  return {
    action: "hold",
    rationale:
      "IVL moderado: lateralización aceptable sin señal clara de concentración ni de salida. Mantener el rango actual y reevaluar en el próximo bloque.",
    breakoutRisk,
    lpRange: { lower: ivl.range.low, high: ivl.range.high, basis: "observed_range" },
  };
}

/** Metadata descriptiva del venue/ejecución/fuentes en el spec. Default = stack BNB/Pancake
 *  de Fase 1; parametrizable para que otros venues (Uniswap, etc.) emitan su propio spec sin
 *  tocar la lógica del motor. */
export interface SpecMeta {
  venue?: string;
  executionTarget?: string;
  candlesSource?: string;
  signalSource?: string;
}

export const DEFAULT_SPEC_META: Required<SpecMeta> = {
  venue: "PancakeSwap v3 (BNB Chain)",
  executionTarget: "Trust Wallet Agent Kit",
  candlesSource: "MEXC public klines (Binance-compatible)",
  signalSource: "CoinMarketCap MCP (S/R, derivatives, fear&greed)",
};

export function buildBacktestSpec(params: {
  pair: string;
  primaryTimeframe: string;
  scales: string[];
  ivl: IvlResult;
  decision: LpDecision;
  equity?: number;
  meta?: SpecMeta;
}) {
  const { pair, primaryTimeframe, scales, ivl, decision, equity = 10000 } = params;
  const meta = { ...DEFAULT_SPEC_META, ...params.meta };
  const raw = ivl.ivl.raw_primary;
  const { lower, upper } = ivl.lpRange;
  const maxAlloc = 0.5;
  const allocFraction = +(maxAlloc * (ivl.ivlScore / 100)).toFixed(4);

  return {
    schema: "ivl.backtest-spec/v1",
    strategy: "IVL-LP-ConcentratedRange",
    venue: meta.venue,
    execution_target: meta.executionTarget,
    data: {
      candles_source: meta.candlesSource,
      signal_source: meta.signalSource,
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
    entry_rules: [
      `Catalogar bloque lateral: amplitud normalizada W/S <= ${ivl.range.widthPct <= 0.05 ? "0.05" : "(no cumplido)"}`,
      "Requerir IVL Score >= 60 (clasificación >= 'good')",
      `Requerir confirmación fractal en >= 3 de ${scales.length} escalas`,
      `Acción LP: ${decision.action}`,
    ],
    exit_rules: [
      "Salir si el precio cierra fuera del rango LP durante 2 velas consecutivas (fuga de rango).",
      "Salir si el IVL Score cae por debajo de 40 (lateralización deteriorada).",
      "Salir si la confirmación fractal cae por debajo de 2 escalas.",
    ],
    stop_loss: { type: "range_break", level_lower: +lower.toFixed(6), level_upper: +upper.toFixed(6) },
    take_profit: { type: "fee_target_or_regime_change" },
    position_sizing: {
      method: "ivl_score_proportional",
      equity_reference: equity,
      alloc_fraction: allocFraction,
      position_usd: +(equity * allocFraction).toFixed(2),
      max_alloc_fraction: maxAlloc,
    },
    risk_limits: {
      max_lvr_level: "moderate",
      withdraw_if: `IVL_raw < ${IVL_WITHDRAW} OR lvr_level == 'high'`,
      widen_range_if: "breakout_risk == 'moderate' -> ampliar a 2.5×ATR14",
      max_positions: 1,
    },
    decision,
  };
}

export interface IvlComputeParams {
  pair: string;
  lookback?: number;
  equity?: number;
  scales?: string[];
  meta?: SpecMeta;
}

export type IvlComputeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * Orquestación completa de un cómputo IVL: iguala horizontes entre escalas, trae velas desde
 * el `PriceSource`, computa IVL, decide la acción LP y arma el spec backtesteable. Devuelve el
 * JSON compacto canónico que consumen la UI y la API pública. Único punto que toca la red.
 * Compartido por la route de Next (`/api/ivl`) y el Cloudflare Worker (`api.zvlint.com`) para
 * que ambos emitan exactamente la misma salida.
 */
export async function computeIvlResponse(
  source: PriceSource,
  params: IvlComputeParams
): Promise<IvlComputeResult> {
  const pair = params.pair || "BNB-USDT";
  const lookback = params.lookback ?? 120;
  const equity = params.equity ?? 10000;
  const scales = params.scales && params.scales.length ? params.scales : [...DEFAULT_SCALES];

  // Igualar el horizonte temporal entre escalas (mismo wall-clock en todas).
  const lookbacks = horizonLookbacks(scales[0], lookback, scales);
  const usableScales = scales.filter((s) => lookbacks[s] > 0);
  const candlesByScale = await source.getKlinesMultiScale(pair, usableScales, lookbacks);
  const ivl = computeIVL(candlesByScale, { primaryScale: scales[0] });
  if (!ivl.ok) {
    return { ok: false, status: 422, error: `No se pudo calcular IVL: ${ivl.reason}` };
  }
  const decision = decideLP(ivl, candlesByScale[ivl.primaryScale]);
  const spec = buildBacktestSpec({
    pair,
    primaryTimeframe: ivl.primaryScale,
    scales,
    ivl,
    decision,
    equity,
    meta: params.meta,
  });

  return {
    ok: true,
    data: {
      pair,
      ivl_score: ivl.ivlScore,
      classification: ivl.classification,
      ivl_raw: ivl.ivl.raw_primary,
      components: ivl.ivl,
      range_low: ivl.range.low,
      range_high: ivl.range.high,
      range_width_pct: ivl.range.widthPct,
      lp_range: ivl.lpRange,
      lvr: ivl.lvr,
      breakout_risk: decision.breakoutRisk,
      scales_confirming: ivl.scalesConfirming,
      per_scale: Object.fromEntries(
        scales.map((s) => {
          const m = ivl.metricsByScale[s];
          return [
            s,
            m?.valid
              ? {
                  ivl_raw: m.ivlRaw,
                  dispersion_score: m.dispersionScore,
                  persistence: m.persistence,
                  is_lateral: m.isLateral,
                  range: [m.S, m.R],
                }
              : { valid: false },
          ];
        })
      ),
      decision,
      spec,
    },
  };
}
