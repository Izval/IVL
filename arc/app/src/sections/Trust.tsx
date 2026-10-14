import { useRef } from "react";
import { animate, createTimeline, stagger, svg } from "animejs";
import { DUR, EASE, reducedMotion, useOnce } from "../motion";
import { SectionHead } from "./SectionHead";

const STEPS = [
  { n: "01", t: "Score", d: "IVL reads the pool on Arc and its history, and scores the range." },
  { n: "02", t: "Place", d: "The band becomes ticks for the pool's fee tier. Adjust it if you like." },
  { n: "03", t: "Sign", d: "Your wallet calls Uniswap v3's position manager. The position NFT is yours." },
];

const TRUST = [
  { t: "No contracts of ours", d: "Every call goes to Uniswap v3 on Arc or to your own tokens. Nothing new to audit." },
  { t: "Exact approvals, only to Uniswap", d: "Approved for the exact amount, consumed by the mint. Nothing is ever approved to us." },
  { t: "A visible fee", d: "0.15% of the deposit (min 0.25 USDC), a plain USDC transfer, only after the mint is simulated." },
  { t: "Read-only server", d: "No keys, no signing, no custody. It serves public data and the app. The code is open." },
];

export function Trust() {
  const fig = useRef<SVGSVGElement>(null);
  useOnce(fig, () => {
    const root = fig.current!;
    if (reducedMotion()) return;
    const tl = createTimeline({ defaults: { ease: EASE.out } });
    tl.add(root.querySelectorAll(".fl-node"), { opacity: [0, 1], translateY: [16, 0], duration: DUR.m, delay: stagger(160) }, 0).add(
      svg.createDrawable(root.querySelectorAll(".fl-link")),
      { draw: ["0 0", "0 1"], duration: DUR.l, delay: stagger(200), ease: EASE.inOut },
      300
    );
    // A packet travels the signing path, forever: wallet → position manager → NFT back to the wallet.
    const travel = () => {
      const { translateX, translateY } = svg.createMotionPath(root.querySelector<SVGPathElement>("#fl-path")!);
      return animate(root.querySelector(".fl-packet")!, { translateX, translateY, opacity: [0, 1, 1, 0], duration: 3200, ease: "inOut(2)", loop: true, loopDelay: 600 });
    };
    const a = travel();
    return () => {
      tl.revert();
      a.revert();
    };
  });

  return (
    <section className="wrap section" id="how">
      <SectionHead title="Your wallet signs. Uniswap holds. We hold nothing." />

      <ol className="how-steps" data-reveal="stagger">
        {STEPS.map((s) => (
          <li key={s.n}>
            <span className="step-n mono">{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </li>
        ))}
      </ol>

      <div className="flow" data-reveal>
        <svg ref={fig} viewBox="0 0 900 220" className="flow-svg" role="img" aria-label="Your wallet signs a mint on Uniswap v3; the position NFT returns to your wallet. The IVL server only reads.">
          <path id="fl-path" d="M110,63 L790,63 C850,63 850,150 790,150 L110,150 C50,150 50,63 110,63" fill="none" stroke="none" />
          <path className="fl-link" d="M190,63 L365,63" />
          <path className="fl-link" d="M535,63 L710,63" />
          <path className="fl-link dashed" d="M790,96 C790,140 780,150 740,150 L160,150 C120,150 110,140 110,96" />
          <path className="fl-link faint" d="M450,96 L450,172" />
          <g className="fl-node">
            <rect x="30" y="30" width="160" height="66" />
            <text x="110" y="59" textAnchor="middle" className="fl-t">
              your wallet
            </text>
            <text x="110" y="78" textAnchor="middle" className="fl-s">
              signs every call
            </text>
          </g>
          <g className="fl-node ivl">
            <rect x="365" y="30" width="170" height="66" />
            <text x="450" y="59" textAnchor="middle" className="fl-t">
              Uniswap v3
            </text>
            <text x="450" y="78" textAnchor="middle" className="fl-s">
              position manager
            </text>
          </g>
          <g className="fl-node">
            <rect x="710" y="30" width="160" height="66" />
            <text x="790" y="59" textAnchor="middle" className="fl-t">
              position NFT
            </text>
            <text x="790" y="78" textAnchor="middle" className="fl-s">
              minted to you
            </text>
          </g>
          <g className="fl-node faint">
            <rect x="360" y="172" width="180" height="32" />
            <text x="450" y="193" textAnchor="middle" className="fl-s">
              IVL server · read-only
            </text>
          </g>
          <text x="277" y="52" textAnchor="middle" className="fl-s">
            exact approve · mint
          </text>
          <text x="622" y="52" textAnchor="middle" className="fl-s">
            ticks from the IVL band
          </text>
          <text x="300" y="142" textAnchor="middle" className="fl-s">
            the NFT is yours
          </text>
          <g className="fl-packet">
            <rect x="-4" y="-4" width="8" height="8" />
          </g>
        </svg>
      </div>

      <ul className="trust" data-reveal="stagger">
        {TRUST.map((t, i) => (
          <li key={t.t}>
            <span className="trust-n mono">{String.fromCharCode(97 + i)}</span>
            <strong>{t.t}</strong>
            <p>{t.d}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
