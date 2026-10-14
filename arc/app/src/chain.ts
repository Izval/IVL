/**
 * Arc mainnet + Uniswap v3 constants. Addresses come from docs.arc.io/arc/references/contract-addresses
 * and Uniswap's deployments.json (generated 2026-09-22), and were checked on-chain.
 */
import { defineChain, type Address } from "viem";

export const arc = defineChain({
  id: 5042,
  name: "Arc",
  // USDC is Arc's native gas token: 18 decimals natively, 6 through its ERC20 interface (USDC below).
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

export const UNISWAP_V3 = {
  factory: "0xf0db7b58379503491d857dB50AC9ece64c653918",
  positionManager: "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377",
} as const satisfies Record<string, Address>;

/** Uniswap v3 fee tiers (hundredths of a bip) -> tick spacing. */
export const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Well-known Arc tokens, for the create-pool picker. Any ERC20 address also works. */
export const KNOWN_TOKENS: { symbol: string; address: Address }[] = [
  { symbol: "USDC", address: USDC },
  { symbol: "EURC", address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" },
  { symbol: "WETH", address: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB" },
  { symbol: "cirBTC", address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0" },
  { symbol: "USYC", address: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490" },
];

/**
 * Service fee, paid as a plain USDC transfer from the user's wallet in the same flow as the mint.
 * There is no contract of ours: the treasury only ever receives a transfer the user signs.
 * Set TREASURY to "" to turn the fee off.
 */
export const TREASURY: Address | "" = "0x6D19d43fC2cd226B135ED5f9F82b366AC864b703";
export const FEE_BPS = 15; // 0.15% of the deposit value
export const MIN_FEE_USDC = 0.25;

export const API_BASE = import.meta.env.VITE_API_BASE ?? "";
export const explorerTx = (hash: string) => `${arc.blockExplorers.default.url}/tx/${hash}`;
