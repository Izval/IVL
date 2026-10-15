import { describe, expect, it } from "vitest";
import {
  bandToTicks,
  mintMinimums,
  pairAmounts,
  priceToSqrtPriceX96,
  priceToTick,
  serviceFee,
  sqrtPriceX96ToPrice,
  tickToPrice,
  toUnits,
} from "../src/math";

describe("price <-> sqrtPriceX96", () => {
  for (const [label, price, d0, d1] of [
    ["EURC/USDC 6/6", 1.12, 6, 6],
    ["WETH/USDC 18/6", 3500, 18, 6],
    ["USDC/WETH 6/18", 1 / 3500, 6, 18],
    ["cirBTC/USDC 8/6", 83000, 8, 6],
  ] as const) {
    it(`round-trips ${label}`, () => {
      const back = sqrtPriceX96ToPrice(priceToSqrtPriceX96(price, d0, d1), d0, d1);
      expect(back / price).toBeCloseTo(1, 9);
    });
  }
  it("1:1 with equal decimals is exactly 2^96", () => {
    expect(priceToSqrtPriceX96(1, 6, 6)).toBe(2n ** 96n);
  });
});

describe("ticks", () => {
  it("tick <-> price with decimals", () => {
    const t = priceToTick(3500, 18, 6);
    expect(tickToPrice(t, 18, 6)).toBeCloseTo(3500, 6);
  });
  it("snaps outward to the tier spacing", () => {
    for (const [fee, spacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]]) {
      const r = bandToTicks(1.1, 1.14, fee, 6, 6);
      expect(r.tickLower % spacing).toBe(0);
      expect(r.tickUpper % spacing).toBe(0);
      expect(r.priceLower).toBeLessThanOrEqual(1.1 + 1e-12);
      expect(r.priceUpper).toBeGreaterThanOrEqual(1.14 - 1e-12);
    }
  });
});

describe("pairAmounts", () => {
  const opts = { price: 1.12, dec0: 6, dec1: 6, ...bandToTicks(1.1, 1.14, 500, 6, 6) };
  it("is symmetric: amount0 -> amount1 -> amount0", () => {
    const a = pairAmounts(opts, { side: 0, amount: 100 });
    const b = pairAmounts(opts, { side: 1, amount: a.amount1 });
    expect(b.amount0).toBeCloseTo(100, 6);
  });
  it("below range takes only token0", () => {
    expect(pairAmounts({ ...opts, price: 1.0 }, { side: 0, amount: 5 })).toEqual({ amount0: 5, amount1: 0 });
  });
});

describe("fee and units", () => {
  it("0.15% with a 0.25 USDC minimum", () => {
    expect(serviceFee(1000)).toBeCloseTo(1.5);
    expect(serviceFee(50)).toBe(0.25);
  });
  it("toUnits rounds down", () => {
    expect(toUnits(1.23456789, 6)).toBe(1234567n);
    expect(toUnits(0, 6)).toBe(0n);
  });
});

describe("mint minimums (price slippage)", () => {
  // EURC/USDC-like narrow band: USDC token0 (6), EURC token1 (6), ticks -1240..-950, price 0.8944.
  const pos = { tickLower: -1240, tickUpper: -950 };
  const p0 = 1 / 1.11811;
  const amounts = pairAmounts({ price: p0, ...pos, dec0: 6, dec1: 6 }, { side: 0, amount: 0.6 });
  const desired = { amount0: toUnits(amounts.amount0, 6), amount1: toUnits(amounts.amount1, 6) };
  const L = (sp: number) => {
    const sa = Math.sqrt(1.0001 ** pos.tickLower);
    const sb = Math.sqrt(1.0001 ** pos.tickUpper);
    const l = Math.min((Number(desired.amount0) * sp * sb) / (sb - sp), Number(desired.amount1) / (sp - sa));
    return { a0: (l * (sb - sp)) / (sp * sb), a1: l * (sp - sa) };
  };
  for (const move of [-0.004, -0.001, 0, 0.001, 0.004]) {
    it(`a ${move * 100}% price move since the quote still mints`, () => {
      const p = p0 * (1 + move);
      const sqrtPriceX96 = priceToSqrtPriceX96(p, 6, 6);
      const m = mintMinimums({ sqrtPriceX96, ...pos }, desired, 50);
      const used = L(Number(sqrtPriceX96) / 2 ** 96);
      expect(Number(m.amount0Min)).toBeLessThanOrEqual(used.a0);
      expect(Number(m.amount1Min)).toBeLessThanOrEqual(used.a1);
      expect(m.amount0Min + m.amount1Min).toBeGreaterThan(0n);
    });
  }
  it("the old amount-based minimum would have reverted on a 0.1% move", () => {
    const used = L(Number(priceToSqrtPriceX96(p0 * 1.001, 6, 6)) / 2 ** 96);
    const oldMin0 = Number(desired.amount0) * 0.995;
    const oldMin1 = Number(desired.amount1) * 0.995;
    expect(used.a0 < oldMin0 || used.a1 < oldMin1).toBe(true);
  });
});
