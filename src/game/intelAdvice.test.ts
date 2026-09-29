import { describe, expect, it } from 'vitest';
import { COSTS } from '../data/nations';
import { createInitialState, seatTable, startGame, toggleSanction } from './engine';
import { findIntelAdvice } from './briefing';
import type { GameState, NationId, NationState } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia'];

function table(me: Partial<NationState> = {}, round = 2): GameState {
  const base = createInitialState();
  const s = startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(SEATS, { size: SEATS.length }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, money: 20, ...me },
      uk: { ...base.nations.uk, money: 20 },
      russia: { ...base.nations.russia, money: 20 },
    },
  });
  return { ...s, round };
}

const kinds = (s: GameState) => findIntelAdvice(s, 'us').map((a) => a.kind);

describe('advisor: spy, research and sanctions', () => {
  it('recommends all three when the treasury and the calendar allow it', () => {
    expect(kinds(table())).toEqual(['spy', 'research', 'sanction']);
  });

  it('holds back the spy service when there is nothing to aim it at', () => {
    // Too poor to arm: no warhead can be bought, so eyes would be wasted
    const poor = table({ money: COSTS.spy });
    expect(kinds(poor)).not.toContain('spy');
  });

  it('never recommends a spy service already owned', () => {
    expect(kinds(table({ hasSpyNetwork: true }))).not.toContain('spy');
  });

  it('does not double-book money the defence orders already claim', () => {
    // Enough for one bunker or shield, nothing left over for a research centre
    const tight = table({ money: COSTS.shield + 0.5 });
    expect(kinds(tight)).not.toContain('research');
  });

  it('skips research when too few rounds are left to repay it', () => {
    const late = table({}, table().maxRounds);
    expect(kinds(late)).not.toContain('research');
    expect(kinds(late)).not.toContain('sanction');
  });

  it('stops advising research at two centres', () => {
    const s = table();
    const cities = s.nations.us.cities.map((c, i) => (i < 2 ? { ...c, hasResearch: true } : c));
    expect(kinds({ ...s, nations: { ...s.nations, us: { ...s.nations.us, cities } } })).not.toContain(
      'research',
    );
  });

  it('names a rival to sanction and moves on once the slots are used', () => {
    const s = table();
    const pick = findIntelAdvice(s, 'us').find((a) => a.kind === 'sanction');
    expect(pick?.nationId).toBeDefined();
    expect(['uk', 'russia']).toContain(pick?.nationId);

    let full = toggleSanction(s, 'uk', 'us');
    full = toggleSanction(full, 'russia', 'us');
    expect(kinds(full)).not.toContain('sanction');
  });

  it('never suggests sanctioning a rival that is already sanctioned', () => {
    const s = toggleSanction(table(), 'uk', 'us');
    const pick = findIntelAdvice(s, 'us').find((a) => a.kind === 'sanction');
    expect(pick?.nationId).toBe('russia');
  });
});
