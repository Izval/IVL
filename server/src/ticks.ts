// ticks.ts — Port TS de skills/ivl/scripts/ivl-ticks.mjs.
//
// Una posición v3 se define por índices de tick enteros, no por precios crudos:
// price = 1.0001^tick, y tickLower/tickUpper deben ser múltiplos del tickSpacing del pool
// (fijado por el fee tier). Convierte la banda de precios IVL [lower, upper] en los ticks
// desplegables que un LP enviaría a PancakeSwap v3 / Uniswap v3.

// PancakeSwap v3 fee tiers (como fracción) -> tickSpacing.
export const TICK_SPACING_BY_FEE: Record<number, number> = {
  0.0001: 1, // 0.01%
  0.0005: 10, // 0.05%
  0.0025: 50, // 0.25%
  0.01: 200, // 1%
};

/** price -> índice de tick crudo (precio expresado como token1/token0). */
export function priceToTick(price: number): number | null {
  if (!(price > 0)) return null;
  return Math.log(price) / Math.log(1.0001);
}

/** índice de tick -> price. */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

export interface TickRange {
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  feeTier: number;
  priceLower: number;
  priceUpper: number;
}

/**
 * Convierte una banda de precios en ticks desplegables, snapeados hacia afuera al spacing del
 * fee tier para que la banda desplegada cubra completamente [lower, upper].
 */
export function rangeToTicks(lower: number, upper: number, fee = 0.0005): TickRange | null {
  if (!(lower > 0) || !(upper > 0) || upper <= lower) return null;
  const spacing = TICK_SPACING_BY_FEE[fee] ?? 10;
  const tLowerRaw = priceToTick(lower);
  const tUpperRaw = priceToTick(upper);
  if (tLowerRaw === null || tUpperRaw === null) return null;
  const tickLower = Math.floor(tLowerRaw / spacing) * spacing;
  const tickUpper = Math.ceil(tUpperRaw / spacing) * spacing;
  return {
    tickLower,
    tickUpper,
    tickSpacing: spacing,
    feeTier: fee,
    priceLower: +tickToPrice(tickLower).toFixed(8),
    priceUpper: +tickToPrice(tickUpper).toFixed(8),
  };
}
