import { describe, expect, it } from 'vitest';
import type { RoundWorldEvent } from '../types';
import { buildRecapTable, recapIsEmpty } from './recap';

let n = 0;
const ev = (e: Omit<RoundWorldEvent, 'id'>): RoundWorldEvent => ({ id: `e${++n}`, ...e });

describe('round recap table', () => {
  it('lists what each nation won and lost, with the assets that went with the city', () => {
    const rows = buildRecapTable(
      [
        ev({ kind: 'cityCaptured', nationId: 'france', cityId: 'paris', cityName: 'Paris', attackerId: 'iran' }),
        ev({ kind: 'cityDestroyed', nationId: 'iran', cityId: 'bandar', cityName: 'Bandar Abbas', attackerId: 'us', lost: ['laser', 'research'] }),
        ev({ kind: 'shieldDestroyed', nationId: 'iran', cityId: 'tehran', cityName: 'Tehran', attackerId: 'us', lost: ['shield'] }),
        ev({ kind: 'shieldDestroyed', nationId: 'iran', cityId: 'qom', cityName: 'Qom', attackerId: 'us', lost: ['shield'] }),
      ],
      ['iran', 'france', 'us'],
    );
    const iran = rows.find((r) => r.nationId === 'iran')!;
    expect(iran.won).toEqual([{ kind: 'taken', city: 'Paris' }]);
    expect(iran.lost).toEqual([{ kind: 'razed', city: 'Bandar Abbas' }]);
    expect(iran.assets).toEqual({ laser: 1, research: 1, shield: 2 });
    expect(rows.find((r) => r.nationId === 'france')!.lost).toEqual([{ kind: 'taken', city: 'Paris' }]);
    expect(rows.find((r) => r.nationId === 'us')!.won).toEqual([{ kind: 'razed', city: 'Bandar Abbas' }]);
  });

  it('credits every nation that aimed at a razed city, and keeps rows in the order given', () => {
    const rows = buildRecapTable(
      [ev({ kind: 'cityDestroyed', nationId: 'iran', cityId: 'a', cityName: 'A', attackerId: 'us', sharedWith: ['russia'] })],
      ['russia', 'us', 'iran'],
    );
    expect(rows.map((r) => r.nationId)).toEqual(['russia', 'us', 'iran']);
    expect(rows[0].won).toEqual([{ kind: 'razed', city: 'A' }]);
    expect(rows[1].won).toEqual([{ kind: 'razed', city: 'A' }]);
  });

  it('counts defences that held as wins for the defender and drone bills as repairs', () => {
    const rows = buildRecapTable(
      [
        ev({ kind: 'dronesIntercepted', nationId: 'iran', cityId: 'a', cityName: 'A', attackerId: 'us' }),
        ev({ kind: 'raidRepelled', nationId: 'iran', cityId: 'b', cityName: 'B', attackerId: 'us', cover: 'shield' }),
        ev({ kind: 'droneDamage', nationId: 'us', cityId: 'c', cityName: 'C', attackerId: 'iran', amount: 20 }),
      ],
      ['iran', 'us'],
    );
    expect(rows[0].won.map((w) => w.kind)).toEqual(['laser', 'shield', 'drone']);
    expect(rows[1].repairs).toBe(20);
    expect(recapIsEmpty(buildRecapTable([], ['iran'])[0])).toBe(true);
  });
});
