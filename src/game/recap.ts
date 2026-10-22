/**
 * The round's "what happened", read one nation at a time: what each country won
 * and what it lost. Pure, so the table on screen and the tests share one answer.
 */
import type { CityAsset, NationId, RoundWorldEvent } from '../types';

/** A gain: a city taken or razed, a swarm that hit, or a defence that held. */
export type RecapWinKind = 'taken' | 'razed' | 'drone' | 'laser' | 'shield' | 'bunker' | 'rebuilt';

export interface RecapWin {
  kind: RecapWinKind;
  city: string;
}

/** A loss: a city razed or taken, the repair bill, or the whole nation. */
export type RecapLossKind = 'razed' | 'taken' | 'out';

export interface RecapLoss {
  kind: RecapLossKind;
  city?: string;
}

export interface RecapRow {
  nationId: NationId;
  won: RecapWin[];
  lost: RecapLoss[];
  /** Shields, lasers, labs and bunkers that went with the cities and defences above */
  assets: Partial<Record<CityAsset, number>>;
  /** Drone repair bills, in millions */
  repairs: number;
}

export const ASSET_ORDER: CityAsset[] = ['shield', 'bunker', 'laser', 'research'];

export function recapIsEmpty(row: RecapRow): boolean {
  return row.won.length === 0 && row.lost.length === 0 && row.repairs === 0;
}

/** One row per nation in the order given, filled from the round's events. */
export function buildRecapTable(events: RoundWorldEvent[], order: NationId[]): RecapRow[] {
  const rows = new Map<NationId, RecapRow>(
    order.map((nationId) => [nationId, { nationId, won: [], lost: [], assets: {}, repairs: 0 }]),
  );
  const win = (id: NationId | undefined, kind: RecapWinKind, city?: string) => {
    const row = id ? rows.get(id) : undefined;
    if (!row || !city) return;
    if (row.won.some((w) => w.kind === kind && w.city === city)) return;
    row.won.push({ kind, city });
  };

  for (const e of events) {
    const victim = rows.get(e.nationId);
    // Everyone who aimed at a razed city shares the credit
    const credited = [e.attackerId, ...(e.sharedWith ?? [])].filter(
      (id): id is NationId => Boolean(id),
    );

    if (victim && e.lost) {
      for (const asset of e.lost) victim.assets[asset] = (victim.assets[asset] ?? 0) + 1;
    }

    switch (e.kind) {
      case 'cityDestroyed':
        for (const id of credited) win(id, 'razed', e.cityName);
        victim?.lost.push({ kind: 'razed', city: e.cityName });
        break;
      case 'cityCaptured':
        win(e.attackerId, 'taken', e.cityName);
        victim?.lost.push({ kind: 'taken', city: e.cityName });
        break;
      case 'droneDamage':
        win(e.attackerId, 'drone', e.cityName);
        if (victim) victim.repairs += e.amount ?? 0;
        break;
      case 'dronesIntercepted':
        win(e.coveredBy ?? e.nationId, 'laser', e.cityName);
        break;
      case 'raidRepelled':
        win(e.nationId, e.cover === 'laser' ? 'laser' : e.cover === 'bunker' ? 'bunker' : 'shield', e.cityName);
        break;
      case 'strikeAbsorbed':
        win(e.nationId, 'bunker', e.cityName);
        break;
      case 'cityRebuilt':
        win(e.nationId, 'rebuilt', e.cityName);
        break;
      case 'nationEliminated':
        victim?.lost.push({ kind: 'out' });
        break;
      default:
        break;
    }
  }
  return [...rows.values()];
}
