import { describe, expect, it } from 'vitest';
import { SCORE_ANGEL, SCORE_BUNKER, SCORE_CITY, SCORE_EVIL, SCORE_KILL } from '../data/nations';
import {
  applyQueuedStrike,
  bunkersLeft,
  computeScore,
  createInitialState,
  finishStrikeResolution,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import type { GameState, NationId, NationState } from '../types';

function table(overrides: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(['us'], { size: 1 }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, ...(overrides.us ?? {}) },
    },
  });
}

describe('computeScore', () => {
  it('pays bunker points on top of the standing city', () => {
    const open = computeScore(table(), 'us');
    expect(open.bunkers).toBe(0);

    const dug = table({
      us: {
        cities: createInitialState().nations.us.cities.map((c, i) =>
          i === 0 ? { ...c, isUnderground: true } : c,
        ),
      },
    });
    expect(bunkersLeft(dug, 'us')).toBe(1);
    const scored = computeScore(dug, 'us');
    expect(scored.bunkers).toBe(1);
    expect(scored.total).toBe(open.total + SCORE_BUNKER);
  });

  it('stops counting a bunker once the city is rubble', () => {
    const s = table({
      us: {
        cities: createInitialState().nations.us.cities.map((c, i) =>
          i === 0 ? { ...c, isUnderground: true, destroyed: true } : c,
        ),
      },
    });
    expect(computeScore(s, 'us').bunkers).toBe(0);
  });

  it('counts a rebuilt city as half a standing city', () => {
    const pristine = computeScore(table(), 'us');
    const rebuilt = table({
      us: {
        cities: createInitialState().nations.us.cities.map((c, i) =>
          i === 0 ? { ...c, rebuiltRound: 1 } : c,
        ),
      },
    });
    const scored = computeScore(rebuilt, 'us');
    const halfCity = Math.round(SCORE_CITY / 2);
    expect(scored.total).toBe(pristine.total - (SCORE_CITY - halfCity));
  });

  it('banks attack points from destroying a city', () => {
    const base = createInitialState();
    let s = startGame({
      ...base,
      mode: 'two',
      turnOrder: seatTable(['us', 'uk']),
      humanNations: ['us'],
      nations: {
        ...base.nations,
        us: {
          ...base.nations.us,
          isHuman: true,
          bombs: 1,
          hasNuclearTech: true,
          nuclearTechUnlockedRound: 0,
          hasSpyNetwork: true,
        },
        uk: { ...base.nations.uk, isHuman: true },
      },
    });
    const before = computeScore(s, 'us').attackPoints;
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(computeScore(s, 'us').attackPoints).toBe(before + SCORE_KILL);
    expect(s.nations.us.attackPoints).toBe(SCORE_KILL);
  });

  it('crowns one angel and one evil each round for prestige / infamy', () => {
    const base = createInitialState();
    let s = startGame({
      ...base,
      mode: 'two',
      turnOrder: seatTable(['us', 'uk']),
      humanNations: ['us', 'uk'],
      nations: {
        ...base.nations,
        us: {
          ...base.nations.us,
          isHuman: true,
          bombs: 1,
          hasNuclearTech: true,
          nuclearTechUnlockedRound: 0,
          hasSpyNetwork: true,
        },
        uk: { ...base.nations.uk, isHuman: true, bombs: 0 },
      },
    });
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    s = finishStrikeResolution(s);

    expect(s.evilNationId).toBe('us');
    expect(s.angelNationId).toBe('uk');
    expect(s.nations.us.infamyPoints).toBe(SCORE_EVIL);
    expect(s.nations.uk.angelPoints).toBe(SCORE_ANGEL);
    expect(computeScore(s, 'uk').total).toBeGreaterThan(computeScore(s, 'uk').citiesLeft * SCORE_CITY - 1);
    // Infamy is subtracted from the aggressor's standing
    const usWithoutInfamy =
      computeScore(s, 'us').total + SCORE_EVIL;
    expect(computeScore(s, 'us').total).toBe(usWithoutInfamy - SCORE_EVIL);
  });
});
