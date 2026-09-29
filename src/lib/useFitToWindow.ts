import { useLayoutEffect, useRef } from 'react';

/**
 * Scale a centred overlay to the window so all of it shows — these pages never
 * scroll. Small windows shrink it; with `maxScale` above 1, roomy windows grow
 * it so text stays readable. The element gets an explicit width (up to
 * `maxWidth`) and a `--fit` scale; layout height is measured with the
 * transform ignored. `--fit-h` is the window height in the page's own pixels,
 * for pages that stretch (`min-height: var(--fit-h)`) to use spare height.
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
      // Never grow so far that the layout would have to reflow narrower than
      // this: phones have a purpose-built narrow layout (~320px works), so they
      // may grow to use spare height; wider windows keep the roomier floor.
      const minLayoutW = availW < 760 ? 320 : 760;
      const cap = Math.max(1, Math.min(maxScale, availW / minLayoutW));
      // Measure the natural height, not one stretched by a previous pass.
      el.style.setProperty('--fit-h', '0px');
      // Width and height feed each other (a wider page reflows shorter), so
      // there is no closed form: walk down from the largest scale allowed and
      // take the first one whose page, measured at its own width, fits.
      let scale = minScale;
      for (let candidate = cap; candidate >= minScale; candidate -= 0.02) {
        el.style.width = `${Math.min(maxWidth, availW / candidate)}px`;
        if (el.offsetHeight * candidate <= availH) {
          scale = candidate;
          break;
        }
      }
      el.style.width = `${Math.min(maxWidth, availW / scale)}px`;
      el.style.setProperty('--fit', String(scale));
      // Whatever height is left over, in the page's own (unscaled) pixels, so
      // a page can stretch to fill the window instead of floating in it.
      el.style.setProperty('--fit-h', `${Math.floor(availH / scale)}px`);
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
