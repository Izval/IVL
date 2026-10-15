/**
 * Uniswap v3 math for the app, in human units. Prices are token1 per token0 (the pool's
 * orientation) unless a function says otherwise; decimals are applied explicitly.
 */
import { FEE_BPS, MIN_FEE_USDC, TICK_SPACING } from "./chain";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const Q96 = 2n ** 96n;

/** Human price (token1 per token0) -> raw pool price (token1 base units per token0 base unit). */
export const toRawPrice = (price: number, dec0: number, dec1: number) => price * 10 ** (dec1 - dec0);
export const fromRawPrice = (raw: number, dec0: number, dec1: number) => raw / 10 ** (dec1 - dec0);

export const priceToTick = (price: number, dec0: number, dec1: number) =>
  Math.log(toRawPrice(price, dec0, dec1)) / Math.log(1.0001);
export const tickToPrice = (tick: number, dec0: number, dec1: number) =>
  fromRawPrice(1.0001 ** tick, dec0, dec1);

/** Human price -> sqrtPriceX96 for pool initialization. */
export function priceToSqrtPriceX96(price: number, dec0: number, dec1: number): bigint {
  const sqrt = Math.sqrt(toRawPrice(price, dec0, dec1));
  if (!(sqrt > 0) || !Number.isFinite(sqrt)) throw new Error("invalid price");
  // Split 2^96 so the float keeps its 53 bits of precision whatever the magnitude.
  return BigInt(Math.round(sqrt * 2 ** 48)) * 2n ** 48n;
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return fromRawPrice(s * s, dec0, dec1);
}

/** Price band -> ticks snapped outward to the fee tier's spacing, clamped to the valid range. */
export function bandToTicks(lower: number, upper: number, fee: number, dec0: number, dec1: number) {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`unknown fee tier ${fee}`);
  if (!(lower > 0) || !(upper > lower)) throw new Error("invalid band");
  const minT = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxT = Math.floor(MAX_TICK / spacing) * spacing;
  let tickLower = Math.floor(priceToTick(lower, dec0, dec1) / spacing) * spacing;
  let tickUpper = Math.ceil(priceToTick(upper, dec0, dec1) / spacing) * spacing;
  tickLower = Math.max(minT, Math.min(tickLower, maxT - spacing));
  tickUpper = Math.min(maxT, Math.max(tickUpper, tickLower + spacing));
  return {
    tickLower,
    tickUpper,
    spacing,
    priceLower: tickToPrice(tickLower, dec0, dec1),
    priceUpper: tickToPrice(tickUpper, dec0, dec1),
  };
}

/**
 * Amounts for a position (human units) given one side's amount. Returns the other side so the
 * deposit matches the pool's current price inside [tickLower, tickUpper].
 */
export function pairAmounts(
  opts: { price: number; tickLower: number; tickUpper: number; dec0: number; dec1: number },
  given: { side: 0 | 1; amount: number }
): { amount0: number; amount1: number } {
  const { price, tickLower, tickUpper, dec0, dec1 } = opts;
  const sp = Math.sqrt(toRawPrice(price, dec0, dec1));
  const sa = Math.sqrt(1.0001 ** tickLower);
  const sb = Math.sqrt(1.0001 ** tickUpper);
  const raw = given.amount * 10 ** (given.side === 0 ? dec0 : dec1);

  if (sp <= sa) {
    // Below range: the position is all token0.
    return given.side === 0 ? { amount0: given.amount, amount1: 0 } : { amount0: 0, amount1: 0 };
  }
  if (sp >= sb) {
    // Above range: the position is all token1.
    return given.side === 1 ? { amount0: 0, amount1: given.amount } : { amount0: 0, amount1: 0 };
  }
  if (given.side === 0) {
    const L = (raw * sp * sb) / (sb - sp);
    return { amount0: given.amount, amount1: (L * (sp - sa)) / 10 ** dec1 };
  }
  const L = raw / (sp - sa);
  return { amount0: (L * (sb - sp)) / (sp * sb) / 10 ** dec0, amount1: given.amount };
}

/** Human amount -> base units, rounded down (never ask the wallet for more than was typed). */
export function toUnits(amount: number, decimals: number): bigint {
  if (!(amount > 0)) return 0n;
  // Extra digits then truncate: toFixed(decimals) alone would round up.
  const [i, f = ""] = amount.toFixed(Math.min(decimals + 4, 100)).split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
}

export const withSlippage = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n;

/**
 * amount0Min / amount1Min for NonfungiblePositionManager.mint, the way Uniswap's SDK does it:
 * slippage applies to the price, not to the amounts. In a narrow band a tiny price move changes
 * the token ratio a lot, so "amount − 0.5%" reverts with "Price slippage check". Here the
 * liquidity the pool will actually take at the current price is fixed, and each minimum is that
 * liquidity's amount at the price slipped against it (token0 at price·(1+s), token1 at price·(1−s)).
 */
export function mintMinimums(
  pos: { sqrtPriceX96: bigint; tickLower: number; tickUpper: number },
  desired: { amount0: bigint; amount1: bigint },
  slippageBps: number
): { amount0Min: bigint; amount1Min: bigint } {
  const sp = Number(pos.sqrtPriceX96) / 2 ** 96;
  const sa = Math.sqrt(1.0001 ** pos.tickLower);
  const sb = Math.sqrt(1.0001 ** pos.tickUpper);
  const a0 = Number(desired.amount0);
  const a1 = Number(desired.amount1);
  // Liquidity the NPM computes from the desired amounts (LiquidityAmounts.getLiquidityForAmounts).
  let L: number;
  if (sp <= sa) L = (a0 * sa * sb) / (sb - sa);
  else if (sp >= sb) L = a1 / (sb - sa);
  else L = Math.min((a0 * sp * sb) / (sb - sp), a1 / (sp - sa));
  const clamp = (x: number) => Math.min(Math.max(x, sa), sb);
  const amount0At = (x: number) => (L * (sb - clamp(x))) / (clamp(x) * sb);
  const amount1At = (x: number) => L * (clamp(x) - sa);
  const s = slippageBps / 10_000;
  // A hair under, so float rounding never asks for more than the pool's integer math gives.
  const floor = (x: number, cap: bigint) => {
    const v = BigInt(Math.max(0, Math.floor(x * 0.9999)));
    return v < cap ? v : cap;
  };
  return {
    amount0Min: floor(amount0At(sp * Math.sqrt(1 + s)), desired.amount0),
    amount1Min: floor(amount1At(sp * Math.sqrt(1 - s)), desired.amount1),
  };
}

/** Service fee in USDC for a deposit worth `valueUsd`. */
export function serviceFee(valueUsd: number): number {
  if (!(valueUsd > 0)) return MIN_FEE_USDC;
  return Math.max(MIN_FEE_USDC, (valueUsd * FEE_BPS) / 10_000);
}
