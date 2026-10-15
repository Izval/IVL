/**
 * Transactions, built for and signed by the user's wallet. Every call goes either to the user's own
 * tokens (approve to Uniswap's NonfungiblePositionManager, the fee transfer) or to Uniswap v3 itself.
 * There is no contract of ours and nothing is approved to an address we control.
 */
import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arc, TREASURY, UNISWAP_V3, USDC, USDC_DECIMALS } from "./chain";
import { mintMinimums, toUnits, withSlippage } from "./math";

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
export const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);
export const npmAbi = parseAbi([
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

export type Call = { to: Address; data: Hex; label: string };

export type TokenInfo = { address: Address; symbol: string; decimals: number };

export async function readToken(client: PublicClient, address: Address): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals };
}

/** Uniswap requires token0 < token1 by address. */
export const sortTokens = (a: TokenInfo, b: TokenInfo): [TokenInfo, TokenInfo] =>
  a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

export async function findPool(client: PublicClient, t0: Address, t1: Address, fee: number) {
  const pool = await client.readContract({
    address: UNISWAP_V3.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [t0, t1, fee],
  });
  if (pool === "0x0000000000000000000000000000000000000000") return null;
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
  ]);
  return { address: pool, sqrtPriceX96: slot0[0], tick: slot0[1], liquidity, initialized: slot0[0] > 0n };
}

export type PositionPlan = {
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0: number;
  amount1: number;
  /** Set when the pool does not exist yet: it is created and initialized at this price. */
  initSqrtPriceX96?: bigint;
  /** The pool's price read right before the mint; the slippage minimums are taken around it. */
  sqrtPriceX96?: bigint;
  slippageBps: number;
  feeUsdc: number;
};

/** The NPM multicall: [createAndInitializePoolIfNecessary?] + mint, with the user as recipient. */
export function buildMintCall(plan: PositionPlan, recipient: Address): Call {
  const a0 = toUnits(plan.amount0, plan.token0.decimals);
  const a1 = toUnits(plan.amount1, plan.token1.decimals);
  const sqrtPriceX96 = plan.initSqrtPriceX96 ?? plan.sqrtPriceX96;
  const mins = sqrtPriceX96
    ? mintMinimums({ sqrtPriceX96, tickLower: plan.tickLower, tickUpper: plan.tickUpper }, { amount0: a0, amount1: a1 }, plan.slippageBps)
    : { amount0Min: withSlippage(a0, plan.slippageBps), amount1Min: withSlippage(a1, plan.slippageBps) };
  const inner: Hex[] = [];
  if (plan.initSqrtPriceX96) {
    inner.push(
      encodeFunctionData({
        abi: npmAbi,
        functionName: "createAndInitializePoolIfNecessary",
        args: [plan.token0.address, plan.token1.address, plan.fee, plan.initSqrtPriceX96],
      })
    );
  }
  inner.push(
    encodeFunctionData({
      abi: npmAbi,
      functionName: "mint",
      args: [
        {
          token0: plan.token0.address,
          token1: plan.token1.address,
          fee: plan.fee,
          tickLower: plan.tickLower,
          tickUpper: plan.tickUpper,
          amount0Desired: a0,
          amount1Desired: a1,
          amount0Min: mins.amount0Min,
          amount1Min: mins.amount1Min,
          recipient,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
        },
      ],
    })
  );
  return {
    to: UNISWAP_V3.positionManager,
    data: encodeFunctionData({ abi: npmAbi, functionName: "multicall", args: [inner] }),
    label: plan.initSqrtPriceX96 ? "Create pool + add liquidity (Uniswap v3)" : "Add liquidity (Uniswap v3)",
  };
}

/** Approvals to the NPM only where the current allowance is short. */
export async function buildApprovals(client: PublicClient, plan: PositionPlan, owner: Address): Promise<Call[]> {
  const out: Call[] = [];
  for (const [tok, amt] of [
    [plan.token0, plan.amount0],
    [plan.token1, plan.amount1],
  ] as const) {
    const need = toUnits(amt, tok.decimals);
    if (need === 0n) continue;
    const allowance = await client.readContract({
      address: tok.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, UNISWAP_V3.positionManager],
    });
    if (allowance >= need) continue;
    out.push({
      to: tok.address,
      // Exact amount, not unlimited: nothing is left approved after the mint.
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [UNISWAP_V3.positionManager, need] }),
      label: `Approve ${tok.symbol} to Uniswap`,
    });
  }
  return out;
}

export function buildFeeCall(feeUsdc: number): Call | null {
  if (!TREASURY || !(feeUsdc > 0)) return null;
  return {
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [TREASURY, toUnits(feeUsdc, USDC_DECIMALS)],
    }),
    label: `IVL service fee (${feeUsdc.toFixed(2)} USDC)`,
  };
}

/** Does the connected wallet support atomic batching (EIP-5792) on Arc? */
export async function supportsAtomicBatch(wallet: WalletClient): Promise<boolean> {
  try {
    const caps = await wallet.getCapabilities({ account: wallet.account!, chainId: arc.id });
    const status = (caps as { atomic?: { status?: string } })?.atomic?.status;
    return status === "supported" || status === "ready";
  } catch {
    return false;
  }
}

export type Step = { label: string; status: "pending" | "signing" | "done" | "error"; hash?: Hex; error?: string };

/**
 * Execute the plan from the user's wallet.
 * - Atomic batch (EIP-5792) when the wallet supports it: approvals + fee + mint in one call bundle.
 * - Otherwise sequential: approvals, then a dry-run of the mint (eth_call), then fee, then mint.
 *   Simulating before the fee means the user does not pay for a mint that would revert.
 */
export async function executePlan(
  wallet: WalletClient,
  client: PublicClient,
  plan: PositionPlan,
  onStep: (steps: Step[]) => void
): Promise<{ hashes: Hex[]; tokenId?: bigint }> {
  const owner = wallet.account!.address;
  if (!plan.initSqrtPriceX96) {
    // Fresh price for the slippage minimums: the page's price may be minutes old.
    const pool = await findPool(client, plan.token0.address, plan.token1.address, plan.fee);
    if (pool) plan = { ...plan, sqrtPriceX96: pool.sqrtPriceX96 };
  }
  const approvals = await buildApprovals(client, plan, owner);
  const feeCall = buildFeeCall(plan.feeUsdc);
  const mint = buildMintCall(plan, owner);

  if (await supportsAtomicBatch(wallet)) {
    const calls = [...approvals, ...(feeCall ? [feeCall] : []), mint];
    const steps: Step[] = [{ label: `${calls.length} calls in one batch: ${calls.map((c) => c.label).join(" → ")}`, status: "signing" }];
    onStep(steps);
    const { id } = await wallet.sendCalls({
      account: wallet.account!,
      chain: arc,
      calls: calls.map(({ to, data }) => ({ to, data })),
      forceAtomic: true,
    });
    const res = await wallet.waitForCallsStatus({ id });
    const hashes = (res.receipts ?? []).map((r) => r.transactionHash);
    steps[0] = { ...steps[0], status: res.status === "success" ? "done" : "error", hash: hashes.at(-1) };
    onStep([...steps]);
    if (res.status !== "success") throw new Error("batch failed");
    return { hashes, tokenId: await mintedTokenId(client, hashes.at(-1)) };
  }

  const steps: Step[] = [...approvals, ...(feeCall ? [feeCall] : []), mint].map((c) => ({ label: c.label, status: "pending" }));
  onStep([...steps]);
  const hashes: Hex[] = [];
  const send = async (i: number, call: Call) => {
    steps[i] = { ...steps[i], status: "signing" };
    onStep([...steps]);
    try {
      const hash = await wallet.sendTransaction({ account: wallet.account!, chain: arc, to: call.to, data: call.data });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("transaction reverted");
      steps[i] = { ...steps[i], status: "done", hash };
      hashes.push(hash);
      onStep([...steps]);
    } catch (e) {
      steps[i] = { ...steps[i], status: "error", error: (e as Error).message.split("\n")[0] };
      onStep([...steps]);
      throw e;
    }
  };

  let i = 0;
  for (const a of approvals) await send(i++, a);
  // Dry-run the mint now that allowances are in place; revert here costs nothing.
  await client.call({ account: owner, to: mint.to, data: mint.data });
  if (feeCall) await send(i++, feeCall);
  await send(i, mint);
  return { hashes, tokenId: await mintedTokenId(client, hashes.at(-1)) };
}

async function mintedTokenId(client: PublicClient, hash?: Hex): Promise<bigint | undefined> {
  if (!hash) return undefined;
  const receipt = await client.getTransactionReceipt({ hash });
  // ERC721 Transfer(from=0x0) from the NPM carries the new position's tokenId in topic 3.
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === UNISWAP_V3.positionManager.toLowerCase() &&
      l.topics[0] === TRANSFER &&
      l.topics.length === 4
  );
  return log?.topics[3] ? BigInt(log.topics[3]) : undefined;
}
