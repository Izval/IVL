// motion.ts - the app's motion system, on anime.js v4.
//
// One vocabulary everywhere: the same eases and durations (EASE/DUR), entrances that rise in on
// scroll, numbers that count, lines that draw. Markup opts in with data attributes:
//   data-reveal / data-reveal="stagger"            rise in on scroll (children one after another)
//   data-count="67.7" data-dp data-prefix data-suffix count up to the value on scroll
//   data-draw                                      an SVG path draws itself (via drawIn)
// Everything renders in its final state first; visitors who prefer reduced motion get the static page.

import { useEffect, useRef, useState, type RefObject } from "react";
import { animate, onScroll, spring, stagger, svg, utils } from "animejs";

export const EASE = {
  out: "out(4)",
  outSoft: "out(3)",
  inOut: "inOut(3)",
  expo: "outExpo",
  pop: spring({ bounce: 0.35, duration: 700 }),
  settle: spring({ bounce: 0.15, duration: 900 }),
} as const;

export const DUR = { xs: 220, s: 420, m: 720, l: 1100, xl: 1800 } as const;

const ENTER = "bottom-=80 top";
export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const below = (el: Element, pad = 60) => el.getBoundingClientRect().top > window.innerHeight - pad;

const playOnEnter = (el: Element, anim: { play(): unknown }) =>
  onScroll({ target: el, enter: ENTER, repeat: false, onEnter: () => anim.play() });

/**
 * Re-run when `deps` change (e.g. after data loads) so new elements get their entrance too. Entrances
 * that already played stay played; ones still waiting below the fold are handed to the next run.
 */
export function useScrollReveal(deps: unknown[] = []) {
  useEffect(() => {
    if (reducedMotion()) return;
    const waiting: { el: HTMLElement; items: Element[]; anim: { revert(): unknown }; obs: { revert(): unknown }; fired: boolean; key: string; final?: string }[] = [];
    const watch = (el: HTMLElement, items: Element[], anim: { play(): unknown; revert(): unknown }, key: string, final?: string) => {
      const w = { el, items, anim, fired: false, key, final, obs: null as unknown as { revert(): unknown } };
      w.obs = onScroll({ target: el, enter: ENTER, repeat: false, onEnter: () => ((w.fired = true), anim.play()) });
      waiting.push(w);
    };
    for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])")) {
      el.dataset.revealed = "1";
      if (!below(el)) continue;
      const items = el.dataset.reveal === "stagger" ? [...el.children] : [el];
      utils.set(items, { opacity: 0, y: 32, filter: "blur(6px)" });
      const anim = animate(items, { opacity: 1, y: 0, filter: "blur(0px)", duration: DUR.l, delay: stagger(90), ease: EASE.out, autoplay: false });
      watch(el, items, anim, "revealed");
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-count]:not([data-counted])")) {
      el.dataset.counted = "1";
      const final = el.textContent ?? "";
      const anim = countUp(el, Number(el.dataset.count), { dp: Number(el.dataset.dp ?? 0), autoplay: false });
      if (below(el)) watch(el, [], anim, "counted", final);
      else anim.play();
    }
    return () => {
      for (const w of waiting) {
        w.obs.revert();
        if (w.fired) continue;
        w.anim.revert();
        for (const it of w.items) for (const p of ["opacity", "transform", "filter"]) (it as HTMLElement).style.removeProperty(p);
        if (w.final != null) w.el.textContent = w.final;
        delete w.el.dataset[w.key];
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Tween an element's text from its current number (or 0) to `to`. */
export function countUp(el: HTMLElement, to: number, o: { dp?: number; from?: number; duration?: number; autoplay?: boolean } = {}) {
  const dp = o.dp ?? 0;
  const pre = el.dataset.prefix ?? "";
  const suf = el.dataset.suffix ?? "";
  const show = (n: number) => (el.textContent = `${pre}${n.toFixed(dp)}${suf}`);
  const v = { n: o.from ?? 0 };
  show(v.n);
  return animate(v, {
    n: to,
    duration: o.duration ?? DUR.xl,
    ease: EASE.expo,
    autoplay: o.autoplay ?? true,
    onUpdate: () => show(v.n),
    onComplete: () => show(to),
  });
}

/** Draw every [data-draw] path inside `root` (call after the SVG mounts or its data changes). */
export function drawIn(root: Element | null, opts: { duration?: number; delay?: number } = {}) {
  if (!root || reducedMotion()) return;
  const paths = root.querySelectorAll<SVGGeometryElement>("[data-draw]:not([data-drawn])");
  if (!paths.length) return;
  paths.forEach((p) => p.setAttribute("data-drawn", ""));
  const drawables = svg.createDrawable(paths);
  animate(drawables, { draw: ["0 0", "0 1"], duration: opts.duration ?? DUR.xl, delay: stagger(220, { start: opts.delay ?? 0 }), ease: EASE.inOut });
}

/** True while the element is on screen (loops pause when it is not). */
export function useInView<T extends Element>(ref: RefObject<T | null>, margin = "0px") {
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setV(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return v;
}

/** Fires once, the first time the element scrolls into view. */
export function useOnce<T extends Element>(ref: RefObject<T | null>, fn: () => void | (() => void), threshold = 0.25) {
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cleanup: void | (() => void);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !done.current) {
          done.current = true;
          cleanup = fn();
          io.disconnect();
        }
      },
      { threshold }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}

/** Interpolate two equal-length point lists. */
export const lerpPts = (a: number[][], b: number[][], t: number) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
export const pathOf = (pts: number[][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

/** Smooth path (Catmull-Rom to cubic Bézier). */
export function smoothPath(pts: number[][], k = 0.18) {
  if (pts.length < 3) return pathOf(pts);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
