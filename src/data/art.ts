import type { NationId } from '../types';

export const ART = {
  map: '/art/map-bg.png',
  missile: '/art/missile.png',
  explosion: '/art/explosion.png',
  nukeTech: '/art/nuke-tech.png',
  shield: '/art/shield-icon.png',
  leaders: {
    russia: '/art/leader-russia.png',
    france: '/art/leader-france.png',
    china: '/art/leader-china.png',
    us: '/art/leader-usa.png',
    uk: '/art/leader-uk.png',
  } as Record<NationId, string>,
  cities: {
    'ru-1': '/art/cities/city-ru-cathedral.png',
    'ru-2': '/art/cities/city-ru-basil.png',
    'ru-3': '/art/cities/city-ru-sochi.png',
    'fr-1': '/art/cities/city-fr-eiffel.png',
    'fr-2': '/art/cities/city-fr-sacre.png',
    'fr-3': '/art/cities/city-fr-statue.png',
    'cn-1': '/art/cities/city-cn-palace.png',
    'cn-2': '/art/cities/city-cn-pearl.png',
    'cn-3': '/art/cities/city-cn-lantern.png',
    'us-1': '/art/cities/city-us-liberty.png',
    'us-2': '/art/cities/city-us-desert.png',
    'us-3': '/art/cities/city-us-beach.png',
    'uk-1': '/art/cities/city-uk-bigben.png',
    'uk-2': '/art/cities/city-uk-castle.png',
    'uk-3': '/art/cities/city-uk-mill.png',
  } as Record<string, string>,
};

export const SFX = {
  launch: '/sounds/launch.wav',
  explosion: '/sounds/explosion.wav',
} as const;
