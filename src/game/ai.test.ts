import { describe, expect, it } from 'vitest';
import { COSTS, MAX_SANCTIONS } from '../data/nations';
import { createInitialState, seatTable, startGame } from './engine';
import {
  pickBombTarget,
  rankedRivals,
  runAiBuyPhase,
  runAiDiplomacy,
  runAiNationTurn,
  threatScore,
} from './ai';
import type { GameState, NationId, NationState } from '../types';

/** A five seat table where only 'us' is human, with per-nation tweaks. */
function table(tweaks: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
  const base = createInitialState();
  const order = seatTable(['us', 'uk', 'russia', 'china', 'france']);
  const nations = { ...base.nations };
  for (const id of order) {
    nations[id] = { ...nations[id], isHuman: id === 'us', ...(tweaks[id] ?? {}) };
  }
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: order,
    humanNations: ['us'],
    nations,
  });
}

/**
 * Give a nation the arsenal — and the intel — to strike without going through
 * the buy phase. Targeting only reasons about defences it can actually see.
 */
function armed(extra: Partial<NationState> = {}): Partial<NationState> {
  return {
    money: 0,
    hasNuclearTech: true,
    nuclearTechUnlockedRound: 0,
    bombs: 1,
    hasSpyNetwork: true,
    ...extra,
  };
}

/** Bury every city so nothing the AI owns can be taken off the board. */
function buried(state: GameState, id: NationId): Partial<NationState> {
  return { cities: state.nations[id].cities.map((c) => ({ ...c, isUnderground: true })) };
}

describe('AI target selection', () => {
  it('shoots at the rival most likely to win, not the nearest one', () => {
    const s = table({
      uk: armed(),
      // ru is coasting to the win: full board, cash, warheads
      russia: { money: 30, bombs: 2, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
      china: { money: 1 },
      france: { money: 1 },
    });
    expect(threatScore(s, 'russia')).toBeGreaterThan(threatScore(s, 'china'));
    expect(pickBombTarget(s, 'uk')?.nationId).toBe('russia');
  });

  /**
   * Two rivals down to their last city: one holds a research centre (so it
   * scores higher), one is too broke to pay for the automatic rebuild.
   */
  function lastStand(richer: NationId, broke: NationId): GameState {
    const base = table({ uk: armed() });
    const lastCity = (id: NationId) => ({
      ...base.nations[id],
      money: id === broke ? COSTS.rebuild - 1 : COSTS.rebuild + 10,
      cities: base.nations[id].cities.map((c, i) => ({
        ...c,
        destroyed: i > 0,
        hasResearch: i === 0 && id === richer,
      })),
    });
    return {
      ...base,
      nations: {
        ...base.nations,
        // The big players are out of reach, so the choice is china vs russia
        us: { ...base.nations.us, ...buried(base, 'us') },
        france: { ...base.nations.france, ...buried(base, 'france') },
        china: lastCity('china'),
        russia: lastCity('russia'),
      },
    };
  }

  it('takes the finishing shot on the rival who cannot afford a rebuild', () => {
    const s = lastStand('russia', 'china');
    // Russia scores higher, but china is the one that stays dead
    expect(threatScore(s, 'russia')).toBeGreaterThan(threatScore(s, 'china'));
    expect(pickBombTarget(s, 'uk')?.nationId).toBe('china');
  });

  it('picks the broke rival whichever seat it is in', () => {
    const s = lastStand('china', 'russia');
    expect(pickBombTarget(s, 'uk')?.nationId).toBe('russia');
  });

  it('spends the warhead on a city that actually falls', () => {
    const base = table({ uk: armed() });
    const ru = base.nations.russia;
    const s = {
      ...base,
      nations: {
        ...base.nations,
        // The leader's cities are all shielded and uk has no swarm to suppress them
        russia: { ...ru, money: 30, cities: ru.cities.map((c) => ({ ...c, hasShield: true })) },
      },
    };
    const target = pickBombTarget(s, 'uk');
    expect(target).not.toBeNull();
    expect(target!.nationId).not.toBe('russia');
  });

  it('sends a swarm in with the warhead when the target is shielded', () => {
    const base = table({ uk: armed({ drones: 1, hasAerospaceTech: true }) });
    const s = {
      ...base,
      nations: Object.fromEntries(
        base.turnOrder.map((id) => [
          id,
          id === 'uk'
            ? base.nations[id]
            : { ...base.nations[id], cities: base.nations[id].cities.map((c) => ({ ...c, hasShield: true })) },
        ]),
      ) as GameState['nations'],
    };
    const after = runAiNationTurn(s, 'uk');
    const strikes = after.pendingStrikes.filter((p) => p.attackerId === 'uk');
    const nuke = strikes.find((p) => p.weapon !== 'drone');
    expect(nuke).toBeDefined();
    expect(strikes.some((p) => p.weapon === 'drone' && p.cityId === nuke!.cityId)).toBe(true);
  });
});

describe('AI purchasing', () => {
  it('covers a city and builds research before stockpiling warheads', () => {
    let s = table({ uk: { money: 20, hasNuclearTech: true, nuclearTechUnlockedRound: 0 } });
    s = { ...s, currentTurnIndex: s.turnOrder.indexOf('uk') };
    const after = runAiBuyPhase(s);
    const uk = after.nations.uk;
    // The rules allow one shield and one research centre a round; the economy
    // is funded before the arsenal, which is built from whatever is left
    expect(uk.cities.filter((c) => c.hasShield).length).toBe(1);
    expect(uk.cities.filter((c) => c.hasResearch).length).toBe(1);
    expect(uk.hasAerospaceTech).toBe(true);
  });

  it('installs only one shield per round', () => {
    let s = table({ uk: { money: 30 } });
    s = { ...s, currentTurnIndex: s.turnOrder.indexOf('uk') };
    const round1 = runAiBuyPhase(s);
    expect(round1.nations.uk.cities.filter((c) => c.hasShield).length).toBe(1);
  });

  it('arms the same round it unlocks the tech, from round two on', () => {
    let s = table({ uk: { money: 20 } });
    s = { ...s, round: 2, currentTurnIndex: s.turnOrder.indexOf('uk') };
    const after = runAiBuyPhase(s);
    expect(after.nations.uk.hasNuclearTech).toBe(true);
    expect(after.nations.uk.bombs).toBeGreaterThan(0);
  });

  it('buys no warheads when nothing on the board can be levelled', () => {
    let s = table({
      uk: { money: 30, hasNuclearTech: true, nuclearTechUnlockedRound: 0, hasSpyNetwork: true },
    });
    s = {
      ...s,
      currentTurnIndex: s.turnOrder.indexOf('uk'),
      nations: {
        ...s.nations,
        us: { ...s.nations.us, ...buried(s, 'us') },
        russia: { ...s.nations.russia, ...buried(s, 'russia') },
        china: { ...s.nations.china, ...buried(s, 'china') },
        france: { ...s.nations.france, ...buried(s, 'france') },
      },
    };
    expect(runAiBuyPhase(s).nations.uk.bombs).toBe(0);
  });

  it('keeps the rebuild fund intact when down to a single city', () => {
    const base = table({ uk: { money: COSTS.rebuild + COSTS.bomb, hasNuclearTech: true, nuclearTechUnlockedRound: 0 } });
    const s = {
      ...base,
      currentTurnIndex: base.turnOrder.indexOf('uk'),
      nations: {
        ...base.nations,
        uk: {
          ...base.nations.uk,
          money: COSTS.rebuild + COSTS.bomb,
          cities: base.nations.uk.cities.map((c, i) => ({ ...c, destroyed: i > 0 })),
        },
      },
    };
    expect(runAiBuyPhase(s).nations.uk.money).toBeGreaterThanOrEqual(COSTS.rebuild);
  });
});

describe('AI diplomacy', () => {
  it('spends both slots on the rivals it considers most dangerous', () => {
    let s = table({
      russia: { money: 30, bombs: 2, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
      china: { money: 20, bombs: 1, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
      france: { money: 1 },
    });
    s = { ...s, currentTurnIndex: s.turnOrder.indexOf('uk') };
    const after = runAiDiplomacy(s);
    expect(after.nations.uk.sanctions).toHaveLength(MAX_SANCTIONS);
    expect([...after.nations.uk.sanctions].sort()).toEqual(['china', 'russia']);
  });

  it('answers a sanction by aiming at whoever imposed it', () => {
    const base = table();
    // France is the weakest rival on the board, but it is squeezing us
    const s = {
      ...base,
      currentTurnIndex: base.turnOrder.indexOf('uk'),
      nations: {
        ...base.nations,
        france: { ...base.nations.france, money: 1, sanctions: ['uk' as NationId] },
      },
    };
    const before = rankedRivals(s, 'uk').indexOf('france');
    const without = rankedRivals(
      { ...s, nations: { ...s.nations, france: { ...s.nations.france, sanctions: [] } } },
      'uk',
    ).indexOf('france');
    expect(before).toBeLessThan(without);
    expect(runAiDiplomacy(s).nations.uk.sanctions).toContain('france');
  });

  it('does not swap a sanction for a rival that is barely ahead', () => {
    let s = table({ russia: { money: 30 }, china: { money: 28 } });
    s = { ...s, currentTurnIndex: s.turnOrder.indexOf('uk') };
    const first = runAiDiplomacy(s);
    const held = [...first.nations.uk.sanctions].sort();
    // Nothing material changed, so the same two names should stay named
    const again = runAiDiplomacy(first);
    expect([...again.nations.uk.sanctions].sort()).toEqual(held);
  });
});
