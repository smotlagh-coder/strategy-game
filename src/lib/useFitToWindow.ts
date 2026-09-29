import { useLayoutEffect, useRef } from 'react';

/**
 * Scale a centred overlay to the window so all of it shows — these pages never
 * scroll. Small windows shrink it; with `maxScale` above 1, roomy windows grow
 * it so text stays readable. The element gets an explicit width (up to
 * `maxWidth`) and a `--fit` scale; layout height is measured with the
 * transform ignored.
 */
export function useFitToWindow<T extends HTMLElement>(
  maxWidth: number,
  minScale = 0.45,
  enabled = true,
  maxScale = 1,
) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const fit = () => {
      const availW = window.innerWidth * 0.98;
      const availH = window.innerHeight * 0.98;
      // Never grow so far that the layout would have to reflow narrower than this.
      const cap = Math.max(1, Math.min(maxScale, availW / 760));
      let scale = 1;
      for (let i = 0; i < 5; i += 1) {
        el.style.width = `${Math.min(maxWidth, availW / scale)}px`;
        const next = Math.max(minScale, Math.min(cap, availH / el.offsetHeight));
        const settled = Math.abs(next - scale) < 0.01;
        scale = next;
        if (settled) break;
      }
      el.style.width = `${Math.min(maxWidth, availW / scale)}px`;
      el.style.setProperty('--fit', String(scale));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [maxWidth, minScale, enabled, maxScale]);
  return ref;
}
