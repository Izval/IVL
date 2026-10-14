// snapshot.mjs - precompute the featured pools' full analysis (price series + one-year replay) and
// ship it with the app as static files. The landing reads these instead of recomputing a year of
// history on every visit; they refresh on every deploy (`npm run deploy` runs this first).
//
//   node scripts/snapshot.mjs
//
// A pool that fails keeps its previous snapshot, so a flaky API never blanks the landing.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/gecko.mjs";
import { analyzePool } from "../src/analyze.mjs";
import { FEATURED } from "../src/featured.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../app/public/featured");
mkdirSync(out, { recursive: true });

for (const [i, address] of FEATURED.entries()) {
  // GeckoTerminal's free API allows ~30 calls a minute: space the pools out.
  if (i) await new Promise((r) => setTimeout(r, 15000));
  try {
    const meta = await getPool(address);
    if (!meta) throw new Error("pool not found");
    const r = await analyzePool(meta, { detail: true });
    if (!r.ok || !r.compare) throw new Error(r.reason ?? "no comparison");
    writeFileSync(join(out, `${address}.json`), JSON.stringify({ ...r, updatedAt: new Date().toISOString(), snapshot: true }));
    console.log(`snapshot: ${r.name} ok`);
  } catch (e) {
    console.warn(`snapshot: ${address} kept previous (${e.message ?? e})`);
  }
}
