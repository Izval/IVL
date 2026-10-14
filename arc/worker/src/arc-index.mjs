// arc-index.mjs - Candles for Arc's Uniswap v3 pools, built from Arc mainnet itself.
//
// Every Uniswap v3 swap emits Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity,
// tick). Reading those logs from Arc's public RPC gives each pool's exact execution price and
// volume, with no third-party indexer in between. One eth_getLogs call covers up to 20 tracked pools
// for up to 10,000 blocks (~85 minutes on Arc), so the 30-minute cron needs one call per 20 pools;
// the initial backfill runs once from scripts/seed.mjs.
//
// State is a single KV value: { block, pools: { [address]: { meta, c15, c4h } } } where c15 keeps
// ~8 days of 15-minute candles and c4h the pool's whole life on 4-hour candles, both as
// [ts, o, h, l, c, vol] with price = base in quote and vol in quote units.

// Public Arc mainnet RPCs that serve full-history eth_getLogs; rotated when one rate-limits.
export const ARC_RPCS = ["https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"];
export const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const INDEX_KEY = "arc:index";
const MAX_RANGE = 9999; // the public RPC rejects ranges of 10,000 blocks or more
const MAX_ADDRESSES = 20; // and filters with more than ~20 addresses ("requested range too large")
const KEEP_15M = 8 * 96;
const KEEP_4H = 6 * 120;
const TF = { c15: 900e3, c4h: 14400e3 };

let rpcId = 0;
let rpcIdx = 0;
export async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const url = ARC_RPCS[rpcIdx % ARC_RPCS.length];
    let body = null;
    let status = 0;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      status = res.status;
      body = res.ok ? await res.json() : null;
    } catch (e) {
      status = String(e.message ?? e);
    }
    if (body && !body.error) return body.result;
    // Deterministic errors (bad range, too many results) are the caller's to handle: no retry.
    const msg = body?.error?.message ?? "";
    if (body?.error && !/rate|limit exceeded|too many requests|429/i.test(msg)) {
      const err = new Error(`Arc RPC ${method}: ${msg}`);
      err.rpcError = body.error;
      throw err;
    }
    if (attempt >= 6) throw new Error(`Arc RPC ${method}: ${body?.error?.message ?? status}`);
    rpcIdx++; // try the next endpoint, backing off
    await new Promise((r) => setTimeout(r, Math.min(15000, 750 * 2 ** attempt)));
  }
}

const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const addrFrom = (word) => `0x${word.slice(-40)}`.toLowerCase();

/** token0/token1 and their decimals, read on Arc. */
export async function readPoolMeta(address, base) {
  const [t0, t1] = (await Promise.all([call(address, "0x0dfe1681"), call(address, "0xd21220a7")])).map(addrFrom);
  const [d0, d1] = (await Promise.all([call(t0, "0x313ce567"), call(t1, "0x313ce567")])).map((x) => Number(BigInt(x)));
  return { token0: t0, token1: t1, dec0: d0, dec1: d1, baseIsToken0: base ? base.toLowerCase() === t0 : true };
}

function toSigned(hex) {
  const v = BigInt(`0x${hex}`);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

/** One Swap log -> { ts, price (base in quote), vol (quote units) }. */
export function parseSwap(log, meta) {
  const d = log.data.slice(2);
  const a0 = toSigned(d.slice(0, 64));
  const a1 = toSigned(d.slice(64, 128));
  const sqrt = Number(BigInt(`0x${d.slice(128, 192)}`)) / 2 ** 96;
  const p01 = sqrt * sqrt * 10 ** (meta.dec0 - meta.dec1); // token1 per token0, human units
  const abs = (x) => Number(x < 0n ? -x : x);
  const price = meta.baseIsToken0 ? p01 : 1 / p01;
  const vol = meta.baseIsToken0 ? abs(a1) / 10 ** meta.dec1 : abs(a0) / 10 ** meta.dec0;
  return { ts: Number(BigInt(log.blockTimestamp)) * 1000, price, vol };
}

/** Merge swaps into a [ts,o,h,l,c,vol] candle array (sorted, oldest first). */
export function mergeSwaps(candles, swaps, ms, keep) {
  const byTs = new Map(candles.map((c) => [c[0], c]));
  for (const s of swaps) {
    if (!(s.price > 0) || !Number.isFinite(s.price)) continue;
    const t = Math.floor(s.ts / ms) * ms;
    const c = byTs.get(t);
    if (!c) byTs.set(t, [t, s.price, s.price, s.price, s.price, s.vol]);
    else {
      c[2] = Math.max(c[2], s.price);
      c[3] = Math.min(c[3], s.price);
      c[4] = s.price;
      c[5] += s.vol;
    }
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]).slice(-keep);
}

/** Candle array -> engine format, forward-filling empty buckets with flat zero-volume candles. */
export function toEngine(candles, ms, until = Date.now()) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const [ts, o, h, l, c, vol] = candles[i];
    if (out.length) {
      const prev = out[out.length - 1];
      for (let t = prev.ts + ms; t < ts; t += ms) out.push({ ts: t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, vol: 0 });
    }
    out.push({ ts, o, h, l, c, vol });
  }
  const last = out[out.length - 1];
  if (last) for (let t = last.ts + ms; t + ms <= until; t += ms) out.push({ ts: t, o: last.c, h: last.c, l: last.c, c: last.c, vol: 0 });
  return out;
}

/**
 * Advance the index: add pools that are new to it, then read Swap logs from the last indexed block
 * to the chain head, at most `maxCalls` getLogs calls per run.
 * @param state  current index state (or null)
 * @param pools  [{ address, baseToken }]
 * @param opts   { maxCalls = 3, fromBlock } fromBlock only for a fresh index (backfill start)
 */
export async function advanceIndex(state, pools, { maxCalls = 3, fromBlock, pauseMs = 0, log = () => {} } = {}) {
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
  state = state ?? { block: fromBlock ?? head - MAX_RANGE, pools: {} };
  for (const p of pools) {
    if (state.pools[p.address]) continue;
    // A rate-limited metadata read must not stall the index for every pool: retry on the next run.
    try {
      state.pools[p.address] = { meta: await readPoolMeta(p.address, p.baseToken), c15: [], c4h: [] };
    } catch (e) {
      console.warn(`meta ${p.address}: ${e.message ?? e}, retrying next run`);
    }
  }
  const addresses = Object.keys(state.pools);
  const groups = [];
  for (let i = 0; i < addresses.length; i += MAX_ADDRESSES) groups.push(addresses.slice(i, i + MAX_ADDRESSES));
  let calls = 0;
  let span = MAX_RANGE;
  while (state.block < head && calls < maxCalls) {
    const from = state.block + 1;
    const to = Math.min(head, from + span - 1);
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [SWAP_TOPIC] };
    let logs;
    try {
      logs = [];
      for (const address of groups) logs.push(...(await rpc("eth_getLogs", [{ ...range, address }])));
    } catch (e) {
      // Busy stretches exceed the RPC's per-response cap: halve the range and retry.
      if (e.rpcError && span > 100) {
        span = Math.floor(span / 2);
        continue;
      }
      throw e;
    }
    const byPool = new Map();
    for (const l of logs) {
      const a = l.address.toLowerCase();
      const entry = state.pools[a];
      if (!entry) continue;
      if (!byPool.has(a)) byPool.set(a, []);
      byPool.get(a).push(parseSwap(l, entry.meta));
    }
    for (const [a, swaps] of byPool) {
      const e = state.pools[a];
      e.c15 = mergeSwaps(e.c15, swaps, TF.c15, KEEP_15M);
      e.c4h = mergeSwaps(e.c4h, swaps, TF.c4h, KEEP_4H);
    }
    state.block = to;
    calls++;
    span = Math.min(MAX_RANGE, span * 2);
    log(`indexed ${from}..${to}: ${logs.length} swaps`);
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  state.head = head;
  state.updatedAt = new Date().toISOString();
  return state;
}

/** Engine-format candles for one pool from the index, or null when it has too little history. */
export function indexedCandles(state, address) {
  const e = state?.pools?.[address];
  if (!e || e.c15.length < 8) return null;
  return { c15: toEngine(e.c15, TF.c15), c4h: toEngine(e.c4h, TF.c4h) };
}
