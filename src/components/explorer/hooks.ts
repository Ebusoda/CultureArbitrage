"use client";

import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

// Size of an element. Starts at a fixed default so the server render and the
// first client paint agree.
export function useElementSize(ref: RefObject<HTMLElement | null>, fallback = { w: 1000, h: 560 }) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// Whether a line-clamped element cuts its text off, measured rather than guessed from its length.
// Re-measured when the element resizes and when its content changes. False on the server and first paint.
export function useOverflows(ref: RefObject<HTMLElement | null>, content: unknown) {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    // An observer reports once as soon as it starts observing, so this also measures on mount.
    const ro = new ResizeObserver(() => setCut(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, content]);
  return cut;
}

// Whether a media query matches. The server render and first paint assume it does not.
function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

// Tailwind's lg breakpoint, where the story caption floats over the bottom of the map.
export function useCaptionOverMap() {
  return useMediaQuery("(min-width: 1024px)");
}
