import { describe, expect, it } from 'vitest';
import {
  bunkersLeft,
  computeScore,
  createInitialState,
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
    // One bunker is worth twice a shield (16 pts) — the dig costs twice as much
    expect(scored.total).toBe(open.total + 16);
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
});
