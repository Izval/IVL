# IVL on Arc

**Find out which Uniswap pools on Arc are worth your liquidity, then open a position in the IVL band from your own wallet.**

IVL (Internal Variance of Lateralization) scores how well price occupies a range, from 0 to 100, across 15m / 1h / 4h / 1d
candles. High IVL means price sweeps the whole channel and keeps paying fees. Low IVL means it is pressed against one edge,
which tends to precede a breakout. The method, the math and the backtests are in this repo (`../README.md`,
`../references/`) and at [zvlint.com/ventures/ivl](https://zvlint.com/ventures/ivl).

This folder is IVL's first product on a live chain: a pool screener and an LP launcher for **Arc mainnet (chain 5042)**.

## What it uses Arc for

- **Screener of Arc's own markets.** Every Uniswap v3 pool on Arc mainnet with real liquidity is scored from its own trade
  history: IVL score, signal (concentrate / hold / widen), band, LVR and pool-wide fee APR.
- **Add liquidity in the IVL band.** The app reads the pool on Arc (`slot0`, tokens, fee tier), turns the IVL band into
  ticks for that fee tier, and the user's wallet signs `NonfungiblePositionManager.mint` on Arc. The position NFT goes to
  the user.
- **Estimate any pool.** Paste any Uniswap v3 pool contract on Arc and get its score, band and the with/without-IVL
  replay.
- **Candles from Arc itself.** The screener's pool candles are built from Uniswap v3 `Swap` events read from Arc
  mainnet's public RPC (exact execution price and volume per swap), indexed incrementally by the cron.
- **USDC everywhere.** Gas is paid in USDC (Arc's native gas token) and the service fee is a USDC transfer on Arc.

## Security model: nothing to audit

- **No contracts of ours.** Every call goes to Uniswap v3 on Arc (Factory `0xf0db…4918`, NonfungiblePositionManager
  `0x3965…1377`) or to the user's own tokens.
- **Approvals only to Uniswap, for the exact amount.** Nothing stays approved after the mint, and nothing is ever approved
  to an address we control.
- **The fee is a plain transfer.** 0.15% of the deposit value (minimum 0.25 USDC), `USDC.transfer(treasury, fee)`, visible
  in the wallet. With EIP-5792 wallets it is batched atomically with the mint. Otherwise the app first simulates the mint
  (`eth_call`) and only then asks for the fee, so nobody pays for a mint that would revert. Treasury:
  `0x6D19d43fC2cd226B135ED5f9F82b366AC864b703` (`app/src/chain.ts`).
- **Read-only backend.** The Worker serves public data and the static app. It holds no keys and has no write endpoints.

## Layout

```
arc/
  worker/   Cloudflare Worker (read-only): /v1/arc/pools, /v1/arc/pool/:address, static app, 30-min cron
    src/arc-index.mjs  candles from Uniswap v3 Swap logs on Arc mainnet (one eth_getLogs per cron for all pools)
    src/reference.mjs  deep reference markets (MEXC) re-anchored to the pool and scaled by its liquidity factor
    src/compare.mjs    with/without IVL, the published comparison model (../scripts/compare.mjs) made callable
    src/gecko.mjs      pool list and TVL from GeckoTerminal; candles for pools pasted by visitors (in their browser)
    src/analyze.mjs    runs the IVL engine (../scripts/ivl-core.mjs, ivl-strategy.mjs) unchanged
    scripts/seed.mjs   one-time backfill of the Arc index over the pools' whole life
  app/      Vite + React + wagmi/viem + RainbowKit, Arc only
    src/chain.ts     Arc chain, Uniswap v3 addresses, fee constants
    src/math.ts      v3 math with decimals: price <-> tick <-> sqrtPriceX96, amounts, fee
    src/tx.ts        calldata and execution (approve, fee transfer, multicall[create?, mint])
```

**Data notes.**

- *Arc candles.* 15-minute and 4-hour candles per pool, from Swap events on Arc; 1h / 4h / 1d scales for the score are
  aggregated from the 15-minute series, so all scales cover the same 7-day window.
- *More history, adjusted for liquidity.* Arc's pools are weeks old. When a pool's asset has a deep market (EURC → EUR,
  cirBTC/BTC → BTC, WETH → ETH, XAUM → gold), IVL reads that market's candles (MEXC), re-anchored to the pool's price,
  with their deviations scaled by a liquidity factor k: the pool's measured volatility relative to the market over the
  same hours, shrunk halfway toward 1 and capped at ×1.75, so the adjustment stays realistic. IVL_raw is scale-invariant,
  so k widens the band and raises the LVR estimate without moving the score. The with/without replay uses a year of the
  market's daily candles, adjusted the same way.
- *Young-pool wicks.* Pools without a reference market are scored on their own candles' bodies (`bodyOnly`), so a single
  tiny swap can't set the channel.
- *Rate limits.* GeckoTerminal and Binance rate-limit or block cloud egress. The Worker uses Arc's RPC and MEXC; pools
  that are not precomputed are analyzed by the app in the visitor's browser with the same modules.

## Run it

```bash
cd arc/app && npm install && npm test          # math unit tests
npm run test:arc                               # eth_call checks against Arc mainnet (read-only)
cd ../worker && npm install
npx wrangler kv namespace create IVL_ARC_KV    # paste the id into wrangler.toml
node scripts/seed.mjs 31 > /tmp/seed.json      # backfill the Arc index (~500 getLogs calls)
npx wrangler kv bulk put /tmp/seed.json --binding IVL_ARC_KV --remote
npm run deploy                                 # builds the app and deploys Worker + assets
```

For local development, run `npx wrangler dev --port 8787` in `worker/` (it serves the API and `app/dist`), or
`npm run dev` in `app/` with the Worker running.

## Next

- Uniswap v4 pools (the EURC/USDC v4 pools hold most of Arc's stable liquidity).
- Position monitor: alert when price leaves the IVL band or the score drops, with one-click rebalance (still signed by
  the user).
- Historical IVL per pool and a backtest of the band against the fees it would have earned.

IVL is a signal, not financial advice. Providing liquidity can lose money.
