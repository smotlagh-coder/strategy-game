import type { NationId } from '../types';

/** Where each city really is: [latitude, longitude]. The strike movie flies real great-circle routes. */
export const CITY_GEO: Record<string, [number, number]> = {
  'cn-1': [39.9, 116.4],
  'cn-2': [31.23, 121.47],
  'cn-3': [30.59, 114.31],
  'ru-1': [55.76, 37.62],
  'ru-2': [59.93, 30.34],
  'ru-3': [43.6, 39.73],
  'uk-1': [51.51, -0.13],
  'uk-2': [55.95, -3.19],
  'uk-3': [53.48, -2.24],
  'us-1': [40.71, -74.01],
  'us-2': [36.17, -115.14],
  'us-3': [33.45, -112.07],
  'fr-1': [48.86, 2.35],
  'fr-2': [45.76, 4.84],
  'fr-3': [43.3, 5.37],
  'in-1': [28.61, 77.21],
  'in-2': [19.08, 72.88],
  'in-3': [12.97, 77.59],
  'pk-1': [33.68, 73.05],
  'pk-2': [24.86, 67.01],
  'pk-3': [31.55, 74.34],
  'ir-1': [35.69, 51.39],
  'ir-2': [32.65, 51.67],
  'ir-3': [27.18, 56.27],
  'kp-1': [39.04, 125.76],
  'kp-2': [39.92, 127.54],
  'kp-3': [39.15, 127.44],
  'ca-1': [45.42, -75.7],
  'ca-2': [43.65, -79.38],
  'ca-3': [49.28, -123.12],
  'br-1': [-15.79, -47.88],
  'br-2': [-22.91, -43.17],
  'br-3': [-23.55, -46.63],
  'au-1': [-35.28, 149.13],
  'au-2': [-33.87, 151.21],
  'au-3': [-37.81, 144.96],
};

/** A nation's missiles leave from its capital region. */
const CAPITAL: Record<NationId, string> = {
  china: 'cn-1',
  russia: 'ru-1',
  uk: 'uk-1',
  us: 'us-1',
  france: 'fr-1',
  india: 'in-1',
  pakistan: 'pk-1',
  iran: 'ir-1',
  northkorea: 'kp-1',
  canada: 'ca-1',
  brazil: 'br-1',
  australia: 'au-1',
};

export function launchSite(nationId: NationId): [number, number] {
  return CITY_GEO[CAPITAL[nationId]] ?? [0, 0];
}

export function cityGeo(cityId: string): [number, number] {
  return CITY_GEO[cityId] ?? [0, 0];
}
