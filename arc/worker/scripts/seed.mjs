// Seed the production KV: backfill the Arc Swap-log index over the pools' whole life, then score.
// Usage (from arc/worker):
//   node scripts/seed.mjs [days=31] > /tmp/seed.json
//   npx wrangler kv bulk put /tmp/seed.json --binding IVL_ARC_KV --remote
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildScreener } from "../src/index.mjs";
import { INDEX_KEY, rpc } from "../src/arc-index.mjs";

// The backfill is the slow part: keep it on disk so a rerun only catches up.
const CHECKPOINT = process.env.IVL_INDEX_CHECKPOINT ?? "/tmp/ivl-arc-index.json";

const days = Number(process.argv[2] ?? 31);
const head = Number(BigInt(await rpc("eth_blockNumber", [])));
const [now, past] = await Promise.all(
  [head, head - 100_000].map(async (b) => Number(BigInt((await rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, false])).timestamp)))
);
const blockTime = (now - past) / 100_000;
const fromBlock = Math.max(0, head - Math.round((days * 86400) / blockTime));
console.error(`head ${head}, ~${blockTime.toFixed(3)} s/block, backfilling from ${fromBlock} (${days} days)`);

const store = new Map();
if (existsSync(CHECKPOINT)) {
  store.set(INDEX_KEY, readFileSync(CHECKPOINT, "utf8"));
  console.error(`resuming from ${CHECKPOINT}`);
}
const env = {
  IVL_ARC_KV: {
    get: async (k, type) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null),
    put: async (k, v) => {
      store.set(k, v);
      if (k === INDEX_KEY) writeFileSync(CHECKPOINT, v);
    },
    delete: async (k) => void store.delete(k),
  },
};
let n = 0;
await buildScreener(env, { maxCalls: 100_000, fromBlock, pauseMs: 300, log: (m) => ++n % 25 === 0 && console.error(m) });
const entries = [...store].map(([key, value]) => ({ key, value, ...(key.startsWith("detail:") ? { expiration_ttl: 6 * 3600 } : {}) }));
process.stdout.write(JSON.stringify(entries));
console.error(`seeded ${entries.length} keys: ${entries.map((e) => `${e.key} (${(e.value.length / 1024).toFixed(0)} KB)`).join(", ")}`);
