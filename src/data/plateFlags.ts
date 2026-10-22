/**
 * Where the takeover flag goes in each city plate. The `-taken` plate shows the
 * city with a bare flagpole planted on its ground; the movie fades to it when the
 * squad lands and runs the attacker's cloth up that pole. Positions are read off
 * the finished renders, in % of the plate (origin top-left): the pole's x, the top
 * of the pole and its foot.
 */
export interface PolePlace {
  x: number;
  top: number;
  base: number;
}

export interface ClothSpec {
  /** [left, top, right, bottom] of the flown cloth, in % of the plate */
  box: [number, number, number, number];
  /** The edge of the cloth that sits on the pole */
  side: 'left' | 'right';
  /** How far the cloth starts below its flown position, as % of its own height */
  rise: number;
}

export const PLATE_POLES: Record<string, PolePlace> = {
  'us-1': { x: 39, top: 19, base: 94 },
  'us-2': { x: 40, top: 7, base: 94 },
  'us-3': { x: 38, top: 16, base: 96 },
  'ru-1': { x: 38.4, top: 11, base: 91 },
  'ru-2': { x: 33.4, top: 18.6, base: 91.5 },
  'ru-3': { x: 49.7, top: 21.7, base: 94 },
  'uk-1': { x: 43.6, top: 7.6, base: 94.6 },
  'uk-2': { x: 49.6, top: 11.8, base: 91.5 },
  'uk-3': { x: 44.2, top: 18.2, base: 93.8 },
  'fr-1': { x: 40.4, top: 21.7, base: 92.9 },
  'fr-2': { x: 36.4, top: 13.4, base: 96.7 },
  'fr-3': { x: 34.5, top: 27.8, base: 84 },
  'in-1': { x: 40, top: 18, base: 93 },
  'in-2': { x: 34.5, top: 16, base: 92 },
  'in-3': { x: 38, top: 30, base: 92 },
  'pk-1': { x: 33.4, top: 7.5, base: 92 },
  'pk-2': { x: 38, top: 6, base: 90 },
  'pk-3': { x: 49.8, top: 11, base: 93 },
  'ca-1': { x: 47, top: 9.5, base: 93 },
  'ca-2': { x: 27, top: 18, base: 94 },
  'ca-3': { x: 38, top: 21, base: 94 },
  'au-1': { x: 33.1, top: 4.9, base: 92 },
  'au-2': { x: 33.2, top: 16.8, base: 92.5 },
  'au-3': { x: 31.7, top: 7.6, base: 89.4 },
  'br-1': { x: 39.7, top: 7.3, base: 85.4 },
  'br-2': { x: 37.1, top: 5.6, base: 90.3 },
  'br-3': { x: 35.9, top: 10.4, base: 92 },
  'cn-1': { x: 42, top: 42, base: 93 },
  'cn-2': { x: 37.2, top: 42.5, base: 89 },
  'cn-3': { x: 38.7, top: 9.5, base: 86 },
  'ir-1': { x: 43.1, top: 12.5, base: 87.7 },
  'ir-2': { x: 45.9, top: 32.5, base: 83.5 },
  'ir-3': { x: 45.4, top: 13.9, base: 92 },
  'kp-1': { x: 39.3, top: 8.7, base: 91.5 },
  'kp-2': { x: 37.8, top: 5.9, base: 89.9 },
  'kp-3': { x: 41.4, top: 16.5, base: 90.6 },
};

/** A flag is 3:2 on a 16:9 plate: its height in % of the plate is 1.17 times its width. */
const FLAG_H_PER_W = (1280 * 0.66) / 720;

function clothFor(p: PolePlace): ClothSpec {
  const pole = p.base - p.top;
  // Proportionate to the pole it flies from, never a speck and never a banner
  const w = Math.max(8, Math.min(13, pole * 0.17));
  const h = w * FLAG_H_PER_W;
  const top = p.top + 0.8;
  return {
    box: [p.x + 0.3, top, p.x + 0.3 + w, top + h],
    side: 'left',
    rise: ((p.base - 3 - top - h) / h) * 100,
  };
}

export const PLATE_FLAGS: Record<string, ClothSpec> = Object.fromEntries(
  Object.entries(PLATE_POLES).map(([id, p]) => [id, clothFor(p)]),
);
