// Read-only check against Arc mainnet: encodings reach Uniswap and revert only where expected.
// Run: npx vitest run npm run test:arc  (network access required; not part of `npm test`)
import { describe, expect, it } from "vitest";
import { createPublicClient, http, toFunctionSelector, type Address } from "viem";
import { arc, KNOWN_TOKENS, UNISWAP_V3, USDC } from "../src/chain";
import { bandToTicks, priceToSqrtPriceX96, sqrtPriceX96ToPrice } from "../src/math";
import { buildMintCall, findPool, readToken, sortTokens } from "../src/tx";

const client = createPublicClient({ chain: arc, transport: http() });
const EURC = KNOWN_TOKENS.find((t) => t.symbol === "EURC")!.address;
const USYC = KNOWN_TOKENS.find((t) => t.symbol === "USYC")!.address;
const NOBODY: Address = "0x000000000000000000000000000000000000dEaD";

describe("Arc mainnet (eth_call only)", () => {
  it("mint selector is Uniswap v3's", () => {
    expect(
      toFunctionSelector(
        "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))"
      )
    ).toBe("0x88316456");
  });

  it("reads the EURC/USDC 0.05% pool", async () => {
    const [a, b] = sortTokens(await readToken(client, EURC), await readToken(client, USDC));
    const pool = await findPool(client, a.address, b.address, 500);
    expect(pool?.address.toLowerCase()).toBe("0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1");
    const price = sqrtPriceX96ToPrice(pool!.sqrtPriceX96, a.decimals, b.decimals);
    console.log(`${a.symbol}/${b.symbol} price`, price);
    expect(price).toBeGreaterThan(0);
  });

  it("create + mint on a new pool reaches the token transfer (no ABI/tick errors)", async () => {
    const [t0, t1] = sortTokens(await readToken(client, EURC), await readToken(client, USYC));
    expect(await findPool(client, t0.address, t1.address, 10000)).toBeNull();
    const price = 1;
    const ticks = bandToTicks(0.9, 1.1, 10000, t0.decimals, t1.decimals);
    const call = buildMintCall(
      {
        token0: t0, token1: t1, fee: 10000, tickLower: ticks.tickLower, tickUpper: ticks.tickUpper,
        amount0: 1, amount1: 1, initSqrtPriceX96: priceToSqrtPriceX96(price, t0.decimals, t1.decimals),
        slippageBps: 50, feeUsdc: 0,
      },
      NOBODY
    );
    // An empty account cannot pay the tokens: Uniswap's TransferHelper reverts with "STF".
    const err = await client.call({ account: NOBODY, to: call.to, data: call.data }).catch((e) => e);
    console.log("revert:", String(err?.shortMessage ?? err?.message ?? err).split("\n").slice(0, 3).join(" | "));
    expect(String(err?.message ?? err)).toMatch(/STF|transfer/i);
  });
});
