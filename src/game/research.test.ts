import { describe, expect, it } from 'vitest';
import { COSTS, MAX_RESEARCH_PER_ROUND } from '../data/nations';
import {
  buyResearch,
  canBuyResearch,
  createInitialState,
  nextRound,
  researchCount,
  seatTable,
  startGame,
} from './engine';
import { runAiNationTurn } from './ai';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationId, NationState } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia', 'china', 'france'];

function table(tweaks: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
  const base = createInitialState();
  const order = seatTable(SEATS, { size: SEATS.length });
  const nations = { ...base.nations };
  for (const id of order) {
    nations[id] = { ...nations[id], isHuman: id === 'us', ...(tweaks[id] ?? {}) };
  }
  return startGame({ ...base, mode: 'single', turnOrder: order, humanNations: ['us'], nations });
}

describe('research centres', () => {
  it('breaks ground on one site a round, however much cash is on hand', () => {
    expect(MAX_RESEARCH_PER_ROUND).toBe(1);

    let s = table({ us: { money: 30 } });
    const cities = s.nations.us.cities;

    s = buyResearch(s, cities[0].id, 'us');
    expect(researchCount(s, 'us')).toBe(1);
    expect(canBuyResearch(s, 'us')).toBe(false);

    const second = buyResearch(s, cities[1].id, 'us');
    expect(second).toBe(s);
    expect(researchCount(second, 'us')).toBe(1);
  });

  it('frees the site again next round', () => {
    let s = table({ us: { money: 30 } });
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    s = nextRound(s);

    expect(s.nations.us.researchBoughtThisRound).toBe(0);
    expect(canBuyResearch(s, 'us')).toBe(true);
    s = buyResearch(s, s.nations.us.cities[1].id, 'us');
    expect(researchCount(s, 'us')).toBe(2);
  });

  it('refuses when the cash is short or every city already has one', () => {
    const broke = table({ us: { money: COSTS.research - 0.5 } });
    expect(canBuyResearch(broke, 'us')).toBe(false);

    const full = table({
      us: {
        money: 30,
        cities: createInitialState().nations.us.cities.map((c) => ({ ...c, hasResearch: true })),
      },
    });
    expect(canBuyResearch(full, 'us')).toBe(false);
  });

  it('holds the AI to a single centre per round too', () => {
    let s = table({ uk: { money: 30 } });
    s = runAiNationTurn(s, 'uk');
    expect(researchCount(s, 'uk')).toBe(1);

    s = runAiNationTurn(nextRound(s), 'uk');
    expect(researchCount(s, 'uk')).toBe(2);
  });

  it('keeps the cap when two online clients report the same round', () => {
    let s = table({ us: { money: 30 } });
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    const merged = mergeNationPlanning(s.nations.us, {
      ...s.nations.us,
      researchBoughtThisRound: 0,
    });
    expect(merged.researchBoughtThisRound).toBe(1);
  });
});
