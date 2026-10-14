/**
 * Shared position form: band (min/max price), amounts, fee, and the signed execution.
 * Prices are token1 per token0, the pool's own orientation.
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, type Hex } from "viem";
import { arc, explorerTx, TREASURY, FEE_BPS, MIN_FEE_USDC, USDC } from "./chain";
import { bandToTicks, pairAmounts, serviceFee } from "./math";
import { erc20Abi, executePlan, type PositionPlan, type Step, type TokenInfo } from "./tx";
import { fmtPrice, fmtUsd } from "./ui";
import { Dimension } from "./diagram/Dimension";

const SLIPPAGE_BPS = 50;

type Props = {
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  /** Current pool price (token1 per token0). */
  price: number;
  defaultBand: { lower: number; upper: number };
  /** USD price per token address (lowercase), when known. */
  usd: Record<string, number | undefined>;
  /** Show prices as token0 per token1 (the screener's base/quote when base is token1). */
  invert?: boolean;
};

export function PositionForm({ token0, token1, fee, price, defaultBand, usd, invert = false }: Props) {
  // Inputs are in display orientation; everything below the inputs works in token1 per token0.
  const show = (x: number) => (invert ? 1 / x : x);
  const shownBand = invert
    ? { lower: 1 / defaultBand.upper, upper: 1 / defaultBand.lower }
    : defaultBand;
  const { address, chainId, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const { data: wallet } = useWalletClient({ chainId: arc.id });
  const client = usePublicClient({ chainId: arc.id })!;

  const [lower, setLower] = useState(String(sig(shownBand.lower)));
  const [upper, setUpper] = useState(String(sig(shownBand.upper)));
  const [input, setInput] = useState<{ side: 0 | 1; value: string }>({ side: 1, value: "" });
  const [balances, setBalances] = useState<[bigint, bigint] | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hashes: Hex[]; tokenId?: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLower(String(sig(shownBand.lower)));
    setUpper(String(sig(shownBand.upper)));
  }, [shownBand.lower, shownBand.upper]);

  useEffect(() => {
    if (!address) return setBalances(null);
    Promise.all(
      [token0, token1].map((t) => client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }))
    )
      .then(([b0, b1]) => setBalances([b0, b1]))
      .catch(() => setBalances(null));
  }, [address, client, token0, token1, result]);

  const ticks = useMemo(() => {
    try {
      const [lo, hi] = invert ? [1 / +upper, 1 / +lower] : [+lower, +upper];
      return bandToTicks(lo, hi, fee, token0.decimals, token1.decimals);
    } catch {
      return null;
    }
  }, [lower, upper, invert, fee, token0.decimals, token1.decimals]);

  const amounts = useMemo(() => {
    const v = parseFloat(input.value);
    if (!ticks || !(v > 0)) return { amount0: 0, amount1: 0 };
    return pairAmounts({ price, tickLower: ticks.tickLower, tickUpper: ticks.tickUpper, dec0: token0.decimals, dec1: token1.decimals }, { side: input.side, amount: v });
  }, [input, ticks, price, token0.decimals, token1.decimals]);

  // Deposit value in USD: known USD prices first, else derive one side from the other through the pool price.
  const valueUsd = useMemo(() => {
    let u0 = usd[token0.address.toLowerCase()];
    let u1 = usd[token1.address.toLowerCase()];
    if (token0.address.toLowerCase() === USDC.toLowerCase()) u0 = 1;
    if (token1.address.toLowerCase() === USDC.toLowerCase()) u1 = 1;
    if (u0 == null && u1 != null) u0 = u1 * price;
    if (u1 == null && u0 != null) u1 = u0 / price;
    if (u0 == null || u1 == null) return null;
    return amounts.amount0 * u0 + amounts.amount1 * u1;
  }, [amounts, usd, token0.address, token1.address, price]);

  const feeUsdc = TREASURY ? serviceFee(valueUsd ?? 0) : 0;
  const side0Only = ticks && price <= ticks.priceLower;
  const side1Only = ticks && price >= ticks.priceUpper;
  const lacks0 = balances && amounts.amount0 > +formatUnits(balances[0], token0.decimals);
  const lacks1 = balances && amounts.amount1 > +formatUnits(balances[1], token1.decimals);
  const canSubmit = ticks && (amounts.amount0 > 0 || amounts.amount1 > 0) && !lacks0 && !lacks1 && !busy;

  async function submit() {
    setError(null);
    setResult(null);
    if (!isConnected) return openConnectModal?.();
    try {
      if (chainId !== arc.id) await switchChainAsync({ chainId: arc.id });
      if (!wallet || !ticks) throw new Error("Wallet not ready, try again.");
      const plan: PositionPlan = {
        token0,
        token1,
        fee,
        tickLower: ticks.tickLower,
        tickUpper: ticks.tickUpper,
        amount0: amounts.amount0,
        amount1: amounts.amount1,
        slippageBps: SLIPPAGE_BPS,
        feeUsdc,
      };
      setBusy(true);
      setResult(await executePlan(wallet, client, plan, setSteps));
    } catch (e) {
      setError(shortError(e));
    } finally {
      setBusy(false);
    }
  }

  const sym = invert ? `${token0.symbol} per ${token1.symbol}` : `${token1.symbol} per ${token0.symbol}`;
  const [dLo, dHi] = ticks ? (invert ? [1 / ticks.priceUpper, 1 / ticks.priceLower] : [ticks.priceLower, ticks.priceUpper]) : [0, 0];

  return (
    <div className="form">
      <div className="row2">
        <label>
          Min price <span className="muted">({sym})</span>
          <input inputMode="decimal" value={lower} onChange={(e) => setLower(e.target.value)} />
        </label>
        <label>
          Max price <span className="muted">({sym})</span>
          <input inputMode="decimal" value={upper} onChange={(e) => setUpper(e.target.value)} />
        </label>
      </div>
      {ticks && <BandStrip lo={dLo} hi={dHi} now={show(price)} label={`ticks ${ticks.tickLower} → ${ticks.tickUpper}`} />}
      {ticks && (
        <p className="muted small mono">
          Ticks {ticks.tickLower} → {ticks.tickUpper} (spacing {ticks.spacing}), deployed band {fmtPrice(dLo)} – {fmtPrice(dHi)}.{" "}
          Current price {fmtPrice(show(price))}.
          {side0Only && " Price is below the band: the position is all " + token0.symbol + "."}
          {side1Only && " Price is above the band: the position is all " + token1.symbol + "."}
        </p>
      )}

      <div className="row2">
        {([0, 1] as const).map((side) => {
          const tok = side === 0 ? token0 : token1;
          const shown = input.side === side ? input.value : sig((side === 0 ? amounts.amount0 : amounts.amount1) || 0, 8) || "";
          const disabled = (side === 0 && !!side1Only) || (side === 1 && !!side0Only);
          return (
            <label key={side}>
              {tok.symbol}
              <input
                inputMode="decimal"
                placeholder="0.0"
                disabled={disabled}
                value={disabled ? "0" : String(shown)}
                onChange={(e) => setInput({ side, value: e.target.value })}
              />
              {balances && (
                <span className="muted small">
                  Balance {fmtPrice(+formatUnits(balances[side], tok.decimals))}
                  {((side === 0 && lacks0) || (side === 1 && lacks1)) && <strong className="error"> · not enough</strong>}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <dl className="summary">
        <dt>Deposit value</dt>
        <dd>{valueUsd == null ? "–" : fmtUsd(valueUsd)}</dd>
        <dt>Service fee</dt>
        <dd>
          {TREASURY ? (
            <>
              {feeUsdc.toFixed(2)} USDC <span className="muted">({FEE_BPS / 100}%, min {MIN_FEE_USDC})</span>
            </>
          ) : (
            <span className="muted">free during launch</span>
          )}
        </dd>
        <dt>Slippage</dt>
        <dd>{SLIPPAGE_BPS / 100}%</dd>
      </dl>

      <button className="btn primary block" disabled={isConnected && !canSubmit} onClick={submit}>
        {!isConnected ? "Connect wallet" : busy ? "Waiting for wallet…" : "Add liquidity"}
      </button>

      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={s.status}>
              <span>{s.label}</span>
              {s.hash && (
                <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              )}
              {s.error && <span className="error small"> {s.error}</span>}
            </li>
          ))}
        </ol>
      )}
      {result && (
        <p className="ok">
          Position minted{result.tokenId != null && <> · NFT #{result.tokenId.toString()}</>}. It is in your wallet and
          shows up in any Uniswap v3 interface on Arc.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        Approvals are for the exact amount and go to Uniswap's position manager. Gas is paid in USDC.
      </p>
    </div>
  );
}

const sig = (x: number, d = 6) => (Number.isFinite(x) && x !== 0 ? +x.toPrecision(d) : 0);

function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/user rejected|denied/i.test(m)) return "Cancelled in the wallet.";
  return m.split("\n")[0];
}

/** The deployed band on a price rule, with the current price, so the ticks read as a measured interval. */
function BandStrip({ lo, hi, now, label }: { lo: number; hi: number; now: number; label: string }) {
  if (!(hi > lo) || !Number.isFinite(now)) return null;
  const W = 340;
  const a = Math.min(lo, now);
  const b = Math.max(hi, now);
  const pad = (b - a) * 0.18 || b * 0.01;
  const x = (v: number) => 10 + ((v - (a - pad)) / (b - a + 2 * pad)) * (W - 20);
  return (
    <svg viewBox={`0 0 ${W} 74`} className="band-strip" aria-hidden>
      <defs>
        <pattern id="bs-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="hatch-ivl" />
        </pattern>
      </defs>
      <line x1="10" x2={W - 10} y1="44" y2="44" className="bs-axis" />
      {Array.from({ length: 21 }, (_, i) => (
        <line key={i} x1={10 + (i * (W - 20)) / 20} x2={10 + (i * (W - 20)) / 20} y1="44" y2={i % 5 ? 48 : 52} className="bs-tick" />
      ))}
      <rect x={x(lo)} y="30" width={Math.max(1, x(hi) - x(lo))} height="14" fill="url(#bs-hatch)" className="bs-band" />
      <line x1={x(lo)} x2={x(lo)} y1="26" y2="44" className="bs-edge" />
      <line x1={x(hi)} x2={x(hi)} y1="26" y2="44" className="bs-edge" />
      <Dimension a={[x(lo), 26]} b={[x(hi), 26]} off={-12} label={label} size={10} tone="ivl" />
      <line x1={x(now)} x2={x(now)} y1="34" y2="60" className="bs-now" />
      <text x={x(now)} y="70" textAnchor="middle" className="bs-t">
        now {fmtPrice(now)}
      </text>
    </svg>
  );
}
