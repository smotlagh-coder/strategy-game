import { describe, expect, it } from 'vitest';
import { MAX_SANCTIONS } from '../data/nations';
import {
  createInitialState,
  sanctionsLeft,
  seatTable,
  startGame,
  toggleSanction,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationId } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia', 'china', 'india'];

function table(): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(SEATS, { size: SEATS.length }),
    humanNations: ['us'],
  });
}

describe('sanction slots', () => {
  it('runs two at a time and ignores the third', () => {
    let s = table();
    expect(sanctionsLeft(s, 'us')).toBe(MAX_SANCTIONS);

    s = toggleSanction(s, 'uk', 'us');
    s = toggleSanction(s, 'russia', 'us');
    expect(s.nations.us.sanctions).toEqual(['uk', 'russia']);
    expect(sanctionsLeft(s, 'us')).toBe(0);

    const full = toggleSanction(s, 'china', 'us');
    expect(full.nations.us.sanctions).toEqual(['uk', 'russia']);
    expect(full.log).toHaveLength(s.log.length);
  });

  it('frees the slot when the sanction is lifted', () => {
    let s = table();
    s = toggleSanction(s, 'uk', 'us');
    s = toggleSanction(s, 'russia', 'us');
    s = toggleSanction(s, 'uk', 'us');
    expect(sanctionsLeft(s, 'us')).toBe(1);

    s = toggleSanction(s, 'china', 'us');
    expect(s.nations.us.sanctions).toEqual(['russia', 'china']);
  });

  it('gives the slot back when the sanctioned nation is knocked out', () => {
    let s = table();
    s = toggleSanction(s, 'uk', 'us');
    s = toggleSanction(s, 'russia', 'us');
    s = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, eliminated: true } } };
    expect(sanctionsLeft(s, 'us')).toBe(1);

    s = toggleSanction(s, 'china', 'us');
    expect(s.nations.us.sanctions).toContain('china');
  });

  it('each nation gets its own slots', () => {
    let s = table();
    s = toggleSanction(s, 'uk', 'us');
    s = toggleSanction(s, 'russia', 'us');
    s = toggleSanction(s, 'us', 'china');
    expect(s.nations.china.sanctions).toEqual(['us']);
    expect(sanctionsLeft(s, 'china')).toBe(MAX_SANCTIONS - 1);
  });

  it('never merges an online peer past the cap', () => {
    const s = table();
    const mine = { ...s.nations.us, sanctions: ['uk', 'russia'] as NationId[] };
    const theirs = { ...s.nations.us, sanctions: ['china', 'india'] as NationId[] };
    expect(mergeNationPlanning(mine, theirs).sanctions).toHaveLength(MAX_SANCTIONS);
    expect(mergeNationPlanning(theirs, mine).sanctions).toHaveLength(MAX_SANCTIONS);
  });

  it('merges a lift online instead of restoring it from the peer snapshot', () => {
    let s = table();
    s = toggleSanction(s, 'uk', 'us');
    s = toggleSanction(s, 'russia', 'us');
    const published = s.nations.us;

    // Both slots are full, so a later round has to start by lifting one
    const lifted = toggleSanction(s, 'uk', 'us').nations.us;
    expect(mergeNationPlanning(published, lifted).sanctions).toEqual(['russia']);
    expect(mergeNationPlanning(lifted, published).sanctions).toEqual(['russia']);

    // ...and the freed slot then goes to somebody else
    const swapped = toggleSanction({ ...s, nations: { ...s.nations, us: lifted } }, 'china', 'us')
      .nations.us;
    expect(mergeNationPlanning(published, swapped).sanctions).toEqual(['russia', 'china']);
  });

  it('keeps a peer snapshot from rolling back a newer sanction list', () => {
    let s = table();
    s = toggleSanction(s, 'uk', 'us');
    const stale = s.nations.us;
    s = toggleSanction(s, 'russia', 'us');
    const fresh = s.nations.us;

    expect(mergeNationPlanning(stale, fresh).sanctions).toEqual(['uk', 'russia']);
    expect(mergeNationPlanning(fresh, stale).sanctions).toEqual(['uk', 'russia']);
  });
});
