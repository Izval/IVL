// ivl-ticks.mjs - Conversion of a price range into estimated PancakeSwap v3 / Uniswap v3 ticks.
//
// A v3 position is defined by integer tick indices, not raw prices: price = 1.0001^tick, and
// tickLower / tickUpper must be multiples of the pool's tickSpacing (set by the fee tier). This
// module turns the IVL price band [lower, upper] into the actual tickLower / tickUpper an LP would
// submit, so the skill outputs deployable ticks, not just a price range.

// PancakeSwap v3 fee tiers (as fractions) -> tickSpacing.
export const TICK_SPACING_BY_FEE = {
  0.0001: 1, // 0.01%
  0.0005: 10, // 0.05%
  0.0025: 50, // 0.25%
  0.01: 200, // 1%
};

/** price -> raw tick index (price expressed as token1/token0). */
export function priceToTick(price) {
  if (!(price > 0)) return null;
  return Math.log(price) / Math.log(1.0001);
}

/** tick index -> price. */
export function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

/**
 * Convert a price band into deployable ticks, snapped outward to the fee tier's spacing.
 * @param {number} lower  lower price bound
 * @param {number} upper  upper price bound
 * @param {number} fee    pool fee tier as a fraction (default 0.0005 = 0.05%)
 * @returns {{tickLower, tickUpper, tickSpacing, feeTier, priceLower, priceUpper}|null}
 */
export function rangeToTicks(lower, upper, fee = 0.0005) {
  if (!(lower > 0) || !(upper > 0) || upper <= lower) return null;
  const spacing = TICK_SPACING_BY_FEE[fee] ?? 10;
  const tLowerRaw = priceToTick(lower);
  const tUpperRaw = priceToTick(upper);
  // Snap outward so the deployed band fully covers [lower, upper].
  const tickLower = Math.floor(tLowerRaw / spacing) * spacing;
  const tickUpper = Math.ceil(tUpperRaw / spacing) * spacing;
  return {
    tickLower,
    tickUpper,
    tickSpacing: spacing,
    feeTier: fee,
    // Prices implied by the snapped ticks (what the pool would actually use).
    priceLower: +tickToPrice(tickLower).toFixed(8),
    priceUpper: +tickToPrice(tickUpper).toFixed(8),
  };
}
