import { describe, expect, it } from 'vitest';
import { COSTS } from '../data/nations';
import { runAiNationTurn, pickRaidTarget } from './ai';
import { createInitialState, seatTable, startGame, cinemaDurationMs } from './engine';
import type { City, GameState, NationId, NationState } from '../types';

type Patch = Partial<NationState>;

function table(ai: Patch = {}, foe: Patch = {}, round = 3): GameState {
  const base = createInitialState();
  // Only the two seats play; every other nation sits out
  const others = Object.fromEntries(
    Object.entries(base.nations)
      .filter(([id]) => id !== 'us' && id !== 'uk')
      .map(([id, n]) => [id, { ...n, eliminated: true }]),
  );
  return startGame({
    ...base,
    mode: 'two',
    round,
    turnOrder: seatTable(['us', 'uk']),
    humanNations: ['uk'],
    nations: {
      ...base.nations,
      ...others,
      us: {
        ...base.nations.us,
        isHuman: false,
        money: 0,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        hasSpyNetwork: true,
        commandos: 1,
        ...ai,
      },
      uk: { ...base.nations.uk, isHuman: true, money: 0, ...foe },
    },
  });
}

function patchCity(state: GameState, nation: NationId, index: number, patch: Partial<City>): GameState {
  const n = state.nations[nation];
  return {
    ...state,
    nations: {
      ...state.nations,
      [nation]: { ...n, cities: n.cities.map((c, i) => (i === index ? { ...c, ...patch } : c)) },
    },
  };
}

/** Every UK city covered, so only the one we leave open is a legal pick. */
function coverAllBut(state: GameState, open: number): GameState {
  let s = state;
  s.nations.uk.cities.forEach((_, i) => {
    if (i !== open) s = patchCity(s, 'uk', i, { hasShield: true });
  });
  return s;
}

describe('AI Heliborne', () => {
  it('walks into the one open city it can see', () => {
    const s = coverAllBut(table(), 1);
    const target = pickRaidTarget(s, 'us');
    expect(target).toEqual({ nationId: 'uk', cityId: s.nations.uk.cities[1].id });
  });

  it('does not send a squad at a bunker or a shield it can see', () => {
    let s = table();
    s.nations.uk.cities.forEach((_, i) => {
      s = patchCity(s, 'uk', i, i % 2 ? { isUnderground: true } : { hasShield: true });
    });
    expect(pickRaidTarget(s, 'us')).toBeNull();
  });

  it('queues the squad in its turn and the city is lined up for takeover', () => {
    const s = runAiNationTurn(coverAllBut(table(), 2), 'us');
    const raids = s.pendingStrikes.filter((p) => p.weapon === 'commando');
    expect(raids).toHaveLength(1);
    expect(raids[0].cityId).toBe(s.nations.uk.cities[2].id);
  });

  it('gambles on a city that was taken from it, even blind', () => {
    let s = table({ hasSpyNetwork: false, commandos: 1 });
    // UK holds a city that began as ours; everything else of UK's is shielded
    s = coverAllBut(s, 0);
    s = patchCity(s, 'uk', 0, { originId: 'us', capturedRound: 2 });
    const target = pickRaidTarget(s, 'us');
    expect(target?.cityId).toBe(s.nations.uk.cities[0].id);
  });

  it('buys a squad out of spare cash when a city is open', () => {
    const rich = coverAllBut(table({ commandos: 0, money: COSTS.commando + 400 }), 1);
    const s = runAiNationTurn(rich, 'us');
    const bought =
      (s.nations.us.commandosUsed ?? 0) + (s.nations.us.commandos ?? 0) > 0 ||
      s.pendingStrikes.some((p) => p.weapon === 'commando');
    expect(bought).toBe(true);
  });

  it('keeps its money when nothing is open', () => {
    let rich = table({ commandos: 0, money: COSTS.commando + 400 });
    rich.nations.uk.cities.forEach((_, i) => {
      rich = patchCity(rich, 'uk', i, { hasShield: true });
    });
    const s = runAiNationTurn(rich, 'us');
    expect(s.pendingStrikes.some((p) => p.weapon === 'commando')).toBe(false);
    expect(s.nations.us.commandosUsed ?? 0).toBe(0);
  });

  it('a raid adds time to the cinema', () => {
    const s = runAiNationTurn(coverAllBut(table(), 2), 'us');
    const withRaid = cinemaDurationMs({ ...s, resolvedStrikes: s.pendingStrikes });
    const without = cinemaDurationMs({
      ...s,
      resolvedStrikes: s.pendingStrikes.map((p) => ({ ...p, weapon: 'nuke' as const })),
    });
    expect(withRaid).toBeGreaterThan(without);
    expect(withRaid).toBeGreaterThan(without);
  });
});
