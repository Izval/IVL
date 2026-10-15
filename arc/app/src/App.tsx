import { useEffect, useState, type ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { fetchScreener, type Screener } from "./api";
import { Home } from "./Home";
import { PoolPage } from "./PoolPage";
import { Logo } from "./ui";

/** Minimal history router: / and /pool/:address. */
export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (!to.includes("#")) window.scrollTo(0, 0);
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

/** Anchor links from any page land on the home section. */
const homeAnchor = (id: string) => (e: React.MouseEvent) => {
  if (location.pathname === "/") return;
  e.preventDefault();
  navigate("/");
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 50);
};

export function App() {
  const path = usePath();
  const pool = path.match(/^\/pool\/(0x[0-9a-fA-F]{40})$/)?.[1];
  const [scrolled, setScrolled] = useState(false);
  const [screener, setScreener] = useState<Screener | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      fetchScreener()
        .then((d) => {
          setScreener(d);
          if (d.warming || d.pools.some((p) => !p.ok)) timer = setTimeout(load, 20000);
        })
        .catch((e) => setErr(e.message));
    load();
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <header className={`top ${scrolled ? "scrolled" : ""}`}>
        <div className="top-inner">
          <Link to="/" className="brand">
            <Logo size={36} />
            <b>IVL</b>
            <span className="brand-sub hide-md">Internal Variance of Lateralization</span>
          </Link>
          <nav className="nav-links">
            <a href="/#screener" onClick={homeAnchor("screener")}>
              Screener
            </a>
            <a href="/#problem" onClick={homeAnchor("problem")} className="hide-sm">
              Method
            </a>
            <a href="/#proof" onClick={homeAnchor("proof")} className="hide-sm">
              With / without
            </a>
            <a href="/#how" onClick={homeAnchor("how")} className="hide-md">
              Security
            </a>
          </nav>
          <div className="top-right">
            <span
              className="chain mono hide-sm"
              title={
                screener?.indexedBlock
                  ? `Arc mainnet (chain 5042). Pool data indexed from Arc up to block #${screener.indexedBlock.toLocaleString("en-US")}${
                      screener.updatedAt ? `, ${new Date(screener.updatedAt).toLocaleString("en-US", { timeStyle: "short", dateStyle: "medium" })}` : ""
                    }; refreshed every 30 minutes.`
                  : "Arc mainnet, chain 5042"
              }
            >
              <span className="live" />
              Arc{screener?.indexedBlock ? ` #${screener.indexedBlock.toLocaleString("en-US")}` : " · 5042"}
            </span>
            <Connect />
          </div>
        </div>
      </header>
      <main>{pool ? <PoolPage key={pool} address={pool.toLowerCase()} /> : <Home screener={screener} err={err} />}</main>
      <footer className="foot">
        <div className="wrap foot-inner">
          <div className="foot-brand">
            <span className="brand">
              <Logo size={34} light />
              <b>IVL</b>
              <span className="brand-sub">Internal Variance of Lateralization</span>
            </span>
            <p className="mono small muted">
              Zevlat Intelligence · Apache-2.0 · IVL is a signal, not financial advice. Providing liquidity can lose money.
            </p>
          </div>
          <div className="foot-links mono">
            <a href="https://zvlint.com/ventures/ivl" target="_blank" rel="noreferrer">
              research note ↗
            </a>
            <a href="https://github.com/Izval/IVL" target="_blank" rel="noreferrer">
              source ↗
            </a>
            <a href="https://explorer.arc.io" target="_blank" rel="noreferrer">
              arc explorer ↗
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

/** RainbowKit's button, drawn as part of the nav pill. */
function Connect() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openConnectModal, openAccountModal, openChainModal }) => {
        if (!mounted) return <button className="connect" aria-hidden style={{ opacity: 0 }} />;
        if (!account)
          return (
            <button className="connect" onClick={openConnectModal}>
              connect
            </button>
          );
        if (chain?.unsupported)
          return (
            <button className="connect wrong" onClick={openChainModal}>
              switch to Arc
            </button>
          );
        return (
          <button className="connect" onClick={openAccountModal}>
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
