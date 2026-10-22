/**
 * Where the flag flies in each city plate, measured on the finished render.
 * The plate already carries the defender's flag; when a squad takes the city the
 * movie swaps to the same plate with a bare pole and raises the attacker's cloth
 * inside this box. `box` is [left, top, right, bottom] in % of the plate; `side`
 * is the edge of the cloth that sits on the pole.
 */
export interface ClothSpec {
  box: [number, number, number, number];
  side: 'left' | 'right';
}

export const PLATE_FLAGS: Record<string, ClothSpec> = {
  'uk-1': { box: [50.1, 9.9, 63.8, 28.6], side: 'left' },
  'uk-2': { box: [47.4, 21.2, 56.6, 35.2], side: 'left' },
  'uk-3': { box: [49.5, 10.9, 60.3, 26.0], side: 'left' },
  'cn-1': { box: [50.2, 20.5, 61.9, 36.8], side: 'left' },
  'cn-2': { box: [49.1, 14.2, 60.6, 30.2], side: 'left' },
  'cn-3': { box: [50.2, 26.0, 57.6, 36.5], side: 'left' },
  'us-1': { box: [50.3, 18.2, 58.4, 32.3], side: 'left' },
  'us-2': { box: [50.4, 9.0, 59.1, 21.7], side: 'left' },
  'us-3': { box: [48.5, 40.4, 56.9, 53.1], side: 'left' },
  'pk-1': { box: [49.8, 30.9, 60.7, 47.0], side: 'left' },
  'pk-2': { box: [50.1, 14.9, 61.0, 31.6], side: 'left' },
  'pk-3': { box: [53.1, 28.8, 66.6, 48.6], side: 'left' },
  'fr-1': { box: [50.2, 11.3, 57.7, 23.1], side: 'left' },
  'fr-2': { box: [51.5, 14.8, 58.1, 25.7], side: 'left' },
  'fr-3': { box: [50.4, 10.8, 58.2, 23.4], side: 'left' },
  'ru-1': { box: [50.6, 21.0, 59.3, 32.9], side: 'left' },
  'ru-2': { box: [49.5, 35.8, 57.0, 47.1], side: 'left' },
  'ru-3': { box: [49.8, 32.5, 61.0, 48.1], side: 'left' },
  'in-1': { box: [49.8, 31.0, 57.7, 44.0], side: 'left' },
  'in-2': { box: [50.0, 25.7, 59.6, 40.6], side: 'left' },
  'in-3': { box: [49.9, 31.5, 59.5, 46.8], side: 'left' },
  'ca-1': { box: [50.1, 16.8, 59.8, 28.8], side: 'left' },
  'ca-2': { box: [50.4, 22.7, 59.3, 34.2], side: 'left' },
  'ca-3': { box: [48.6, 21.2, 57.5, 33.2], side: 'left' },
  'kp-1': { box: [50.3, 10.1, 60.4, 23.1], side: 'left' },
  'kp-2': { box: [50.2, 38.5, 60.8, 52.6], side: 'left' },
  'kp-3': { box: [50.2, 10.9, 60.9, 24.7], side: 'left' },
  'au-1': { box: [50.1, 38.2, 58.8, 49.1], side: 'left' },
  'au-2': { box: [50.4, 36.6, 61.3, 51.0], side: 'left' },
  'au-3': { box: [50.1, 7.5, 61.5, 22.0], side: 'left' },
  'br-1': { box: [49.2, 21, 57.8, 34.5], side: 'left' },
  'br-2': { box: [54.6, 15.6, 62.8, 29.7], side: 'left' },
  'br-3': { box: [51.2, 30.6, 61.1, 46.7], side: 'left' },
  'ir-1': { box: [50.2, 28.0, 60.6, 43.9], side: 'left' },
  'ir-2': { box: [49.5, 15.7, 63.0, 37.6], side: 'left' },
  'ir-3': { box: [50.2, 39.3, 60.5, 53.1], side: 'left' },
};
