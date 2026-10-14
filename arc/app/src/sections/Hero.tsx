// The hero is one looping film in three scenes: an IVL reading arrives exploded, closes up while the
// score composes from D, P and F, then the same idea pays off on a real pool, a year replayed with
// and without IVL. It loops while the hero is on screen and pauses when it is not.

import { useEffect, useMemo, useRef, useState } from "react";
import { animate, type JSAnimation } from "animejs";
import type { PoolAnalysis } from "../api";
import { ACTION } from "../ui";
import { reducedMotion, useInView } from "../motion";
import { buildReading, ExplodedReading, legend, phases } from "../diagram/ExplodedReading";
import { Ruler } from "../diagram/Ruler";
import { NetCurves } from "../charts";
import { upliftLabel } from "../Compare";
import { Link } from "../App";

// Scene timing (ms): the reading assembles, holds, then the replay draws and holds.
const ASSEMBLE = 8000;
const HOLD = 2800;
const REPLAY = 9000;

type Scene = "reading" | "replay";

export function Hero({ scored, total, replay }: { scored: PoolAnalysis[]; total: number; replay?: PoolAnalysis | "failed" }) {
  const d = useMemo(() => buildReading("aligned"), []);
  const live = replay && replay !== "failed" && replay.ok && replay.compare ? replay : null;
  const [m, setM] = useState(() => (reducedMotion() ? ASSEMBLE : 0));
  const [loop, setLoop] = useState(0);
  const anim = useRef<JSAnimation | null>(null);
  const root = useRef<HTMLElement>(null);
  const visible = useInView(root);
  const compact = useNarrow(760);
  const best = scored[0];

  // One master clock drives every scene. Without a replay to show, the film is just the reading.
  const span = live ? ASSEMBLE + HOLD + REPLAY : ASSEMBLE + HOLD;
  useEffect(() => {
    if (reducedMotion()) return;
    const clock = { m: 0 };
    anim.current = animate(clock, {
      m: span,
      duration: span,
      ease: "linear",
      loop: true,
      autoplay: false,
      onUpdate: () => setM(clock.m),
      onLoop: () => setLoop((n) => n + 1),
    });
    return () => void anim.current?.revert();
  }, [span]);

  // Run only while the hero is on screen.
  useEffect(() => {
    if (!anim.current) return;
    if (visible) anim.current.play();
    else anim.current.pause();
  }, [visible, span]);

  const scene: Scene = live && m >= ASSEMBLE + HOLD ? "replay" : "reading";
  const t = Math.min(1, m / ASSEMBLE);
  const ph = phases(t);
  const shown = (x: number, on: number) => (on > 0 ? x.toFixed(2) : "—");
  const score = Math.round(d.score * ph.close);
  const act = ACTION[d.action];

  return (
    <section className={`hero scene-${scene}`} id="top" ref={root}>
      <div className="hero-copy">
        <h1>Not every range is worth your liquidity.</h1>
        {scene === "reading" ? (
          <p className="lede" key="m">
            IVL is a 0–100 measure of how well price <strong>occupies</strong> a range: how fully it fills the channel, how
            long it stays inside, and whether every timeframe agrees on it.
          </p>
        ) : (
          <p className="lede" key="a">
            Same pool, same capital, a year replayed: a band <strong>placed by IVL</strong> against a fixed band that
            re-centers every time price leaves it. IVL waits out the trends instead of paying for them.
          </p>
        )}
        <div className="cta">
          <a href="#screener" className="btn primary">
            Open the screener <span aria-hidden>→</span>
          </a>
          <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer" className="btn ghost">
            Read the research ↗
          </a>
        </div>

        <dl className="spec mono">
          <div>
            <dt>pools scored</dt>
            <dd>{scored.length ? `${scored.length}${total > scored.length ? ` / ${total}` : ""}` : "—"}</dd>
          </div>
          <div>
            <dt>best IVL now</dt>
            <dd>{best ? `${best.ivlScore} · ${best.name}` : "—"}</dd>
          </div>
          <div>
            <dt>network</dt>
            <dd>Arc mainnet · 5042 · gas in USDC</dd>
          </div>
        </dl>
      </div>

      <div className={`hero-stage measure ${scene === "reading" ? "on" : ""}`} aria-hidden={scene !== "reading"}>
        <div className="hero-fig">
          <ExplodedReading data={d} t={t} compact={compact} />
        </div>
        <ol className="legend-m mono">
          {legend(d).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ol>
        <div className="readout" aria-live="polite">
          <div className="readout-eq mono">
            <span className={ph.d > 0 ? "on" : ""}>
              D <b>{shown(d.d, ph.d)}</b>
              <sup>.5</sup>
            </span>
            <i>×</i>
            <span className={ph.p > 0 ? "on" : ""}>
              P <b>{shown(d.p, ph.p)}</b>
              <sup>.2</sup>
            </span>
            <i>×</i>
            <span className={`${ph.f > 0 ? "on" : ""} ${ph.f > 0 && d.f < 0.5 ? "weak" : ""}`}>
              F <b>{shown(d.f, ph.f)}</b>
              <sup>.3</sup>
            </span>
            <i>=</i>
          </div>
          <Ruler value={score} instant size="lg" />
          <p className={`readout-act mono tone-${act.tone}`} style={{ opacity: ph.result }}>
            → {act.label}
          </p>
        </div>
      </div>

      <div className={`hero-stage advantage ${scene === "replay" ? "on" : ""}`} aria-hidden={scene !== "replay"}>
        {live && scene === "replay" && <Advantage key={loop} pool={live} />}
      </div>
    </section>
  );
}

/** Stage two: the year replayed with and without IVL, the gap written as a dimension. */
function Advantage({ pool }: { pool: PoolAnalysis }) {
  const c = pool.compare!;
  const up = upliftLabel(c);
  const curves = useMemo(
    () => [
      { key: "ivl", label: "With IVL", values: c.withIvl.curve, tone: "ivl" as const },
      { key: "fixed", label: "Fixed band", values: c.fixed.curve, tone: "fixed" as const },
    ],
    [c]
  );
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="adv">
      <dl className="adv-kpis mono">
        <div>
          <dt>{pool.name} · IVL vs a fixed band</dt>
          <dd className="tone-ivl">{up.big}</dd>
          <span>{up.small}</span>
        </div>
        <div>
          <dt>rebalances</dt>
          <dd>
            {c.withIvl.rebalances}
            <small> vs {c.fixed.rebalances}</small>
          </dd>
        </div>
        <div>
          <dt>time in range</dt>
          <dd>
            {pct(c.withIvl.timeInRange)}
            <small> vs {pct(c.fixed.timeInRange)}</small>
          </dd>
        </div>
      </dl>
      <NetCurves key={pool.pool} fromTs={c.fromTs} toTs={c.toTs} curves={curves} delta={up.big} />
      <Link to={`/pool/${pool.pool}`} className="link-arrow mono">
        open {pool.name} →
      </Link>
    </div>
  );
}

function useNarrow(px: number) {
  const q = `(max-width: ${px}px)`;
  const [m, setM] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
