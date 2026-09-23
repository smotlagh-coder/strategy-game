import { describe, expect, it } from 'vitest';
import {
  applyQueuedStrike,
  buyLaser,
  buyShield,
  buyUnderground,
  cityAsSeenBy,
  createInitialState,
  laserShotsKnownTo,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  seesCity,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationState } from '../types';

function table(overrides: { us?: Partial<NationState>; uk?: Partial<NationState> } = {}): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(['us', 'uk'], { size: 2 }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: {
        ...base.nations.us,
        isHuman: true,
        money: 20,
        hasNuclearTech: true,
        nuclearTechUnlockedRound: 0,
        bombs: 2,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        drones: 3,
        ...(overrides.us ?? {}),
      },
      uk: {
        ...base.nations.uk,
        money: 20,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        ...(overrides.uk ?? {}),
      },
    },
  });
}

/** Fly everything that is queued, the way the board does it. */
function resolve(state: GameState): GameState {
  let s = state;
  for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

describe('recon by fire', () => {
  it('opens the city a swarm flew over, and only that city', () => {
    let s = table();
    const [london, edinburgh] = s.nations.uk.cities;
    s = buyShield(s, london.id, 'uk');
    s = buyShield(nextRound(s), edinburgh.id, 'uk');

    expect(cityAsSeenBy(s, 'us', 'uk', s.nations.uk.cities[0]).hasShield).toBe(false);

    s = resolve(queueStrike(s, 'uk', london.id, 'us', 'drone'));

    expect(seesCity(s, 'us', 'uk', london.id)).toBe(true);
    expect(cityAsSeenBy(s, 'us', 'uk', s.nations.uk.cities[0]).hasShield).toBe(true);
    // The swarm saw one city, not the country
    expect(seesCity(s, 'us', 'uk', edinburgh.id)).toBe(false);
    expect(cityAsSeenBy(s, 'us', 'uk', s.nations.uk.cities[1]).hasShield).toBe(false);
  });

  it('keeps the intel for the rest of the war', () => {
    let s = table();
    const london = s.nations.uk.cities[0];
    s = resolve(queueStrike(s, 'uk', london.id, 'us', 'drone'));
    s = nextRound(nextRound(s));

    expect(seesCity(s, 'us', 'uk', london.id)).toBe(true);
  });

  it('gives the attacker nothing when the swarm never gets there', () => {
    let s = table();
    const [london, edinburgh] = s.nations.uk.cities;
    s = buyLaser(s, edinburgh.id, 'uk');

    s = resolve(queueStrike(s, 'uk', london.id, 'us', 'drone'));

    expect(s.nations.uk.dronesInterceptedThisRound).toBe(1);
    expect(seesCity(s, 'us', 'uk', london.id)).toBe(false);
  });

  it('gives away the battery that fired, so the next swarm knows the odds', () => {
    let s = table();
    const [london, edinburgh] = s.nations.uk.cities;
    s = buyLaser(s, edinburgh.id, 'uk');
    expect(laserShotsKnownTo(s, 'us', 'uk')).toBe(0);

    s = resolve(queueStrike(s, 'uk', london.id, 'us', 'drone'));

    expect(seesCity(s, 'us', 'uk', edinburgh.id)).toBe(true);
    expect(laserShotsKnownTo(s, 'us', 'uk')).toBe(1);
  });

  it('warns the attacker off a bunker it has flown over', () => {
    let s = table();
    const london = s.nations.uk.cities[0];
    s = buyUnderground(s, london.id, 'uk');

    // Blind, the warhead flies and breaks against the rock
    const blind = queueStrike(s, 'uk', london.id, 'us');
    expect(blind.pendingStrikes).toHaveLength(1);

    s = resolve(queueStrike(s, 'uk', london.id, 'us', 'drone'));
    expect(seesCity(s, 'us', 'uk', london.id)).toBe(true);

    // Now that the rock is on the map, the warhead stays in the silo
    expect(queueStrike(s, 'uk', london.id, 'us')).toBe(s);
  });

  it('merges intel from both sides of an online round', () => {
    const s = table();
    const local: NationState = { ...s.nations.us, scoutedCities: ['uk-1'] };
    const remote: NationState = { ...s.nations.us, scoutedCities: ['uk-2'] };
    expect(mergeNationPlanning(remote, local).scoutedCities.sort()).toEqual(['uk-1', 'uk-2']);
  });
});
