import { describe, expect, it } from "vitest";
import {
  bandToTicks,
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
