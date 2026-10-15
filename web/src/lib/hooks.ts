import { useEffect, useState, useSyncExternalStore } from "react";

export type Viewport = "mobile" | "tablet" | "desktop";

const mqMobile = window.matchMedia("(max-width: 719px)");
const mqTablet = window.matchMedia("(max-width: 1023px)");

function subscribe(fn: () => void) {
  mqMobile.addEventListener("change", fn);
  mqTablet.addEventListener("change", fn);
  return () => {
    mqMobile.removeEventListener("change", fn);
    mqTablet.removeEventListener("change", fn);
  };
}

export const getViewport = (): Viewport => (mqMobile.matches ? "mobile" : mqTablet.matches ? "tablet" : "desktop");

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, getViewport);
}

/** Re-render on an interval so relative times ("2m ago") stay honest. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Run `fn` when a pointer goes down outside `ref`'s element, or Escape is pressed. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref, active, onDismiss]);
}

const subscribeResize = (fn: () => void) => {
  window.addEventListener("resize", fn);
  return () => window.removeEventListener("resize", fn);
};

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}
