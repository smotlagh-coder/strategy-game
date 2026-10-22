import { describe, expect, it } from 'vitest';
import type { PendingStrike, RoundWorldEvent } from '../types';
import {
  arsenalOf,
  buildShots,
  orderVolleysForFilm,
  targetOutcome,
  targetShotMs,
  targetTimeline,
  volleyMovieMs,
  volleyWeapons,
  type StrikeShow,
  type StrikeTarget,
} from './movie';

const target = (over: Partial<StrikeTarget> = {}): StrikeTarget => ({
  to: 'russia',
  cityId: 'moscow',
  cityName: 'Moscow',
  weapons: ['nuke'],
  ...over,
});

describe('strike movie', () => {
  it('runs about a quarter minute for a single warhead', () => {
    const ms = volleyMovieMs([{ weapons: ['nuke'] }]);
    expect(ms).toBeGreaterThanOrEqual(17_000);
    expect(ms).toBeLessThanOrEqual(20_000);
  });

  it('keeps a long target list brisk', () => {
    const ms = volleyMovieMs(Array.from({ length: 4 }, () => ({ weapons: ['nuke'] })));
    expect(ms).toBeLessThan(29_000);
  });

  it('gives a squad room to land, hoist the flag and leave', () => {
    const squad = targetShotMs(['commando'], 1);
    const nuke = targetShotMs(['nuke'], 1);
    expect(squad).toBeGreaterThan(nuke);
    expect(squad).toBeGreaterThanOrEqual(5_700);
  });

  it('orders the beats like the engine resolves them: swarm, warhead, squad', () => {
    const line = targetTimeline(['drone', 'nuke', 'commando']);
    expect(line.warheadAt).toBeGreaterThan(line.droneAt);
    expect(line.raidAt).toBeGreaterThanOrEqual(line.droneAt);
    expect(targetShotMs(['drone', 'nuke', 'commando'], 1)).toBeGreaterThanOrEqual(line.needs);
  });

  it('never cuts a shot short of its own beats', () => {
    for (const weapons of [['nuke'], ['drone'], ['drone', 'hydrogen'], ['hydrogen', 'commando'], ['drone', 'commando']]) {
      for (const n of [1, 2, 5]) {
        expect(targetShotMs(weapons, n)).toBeGreaterThanOrEqual(targetTimeline(weapons).needs * 1.2);
      }
    }
  });

  it('builds title, launch, radar, one shot per city and the toll card', () => {
    const strike: StrikeShow = { from: 'us', targets: [target(), target({ cityId: 'a' }), target({ cityId: 'b' })] };
    const shots = buildShots(strike);
    expect(shots.map((s) => s.kind)).toEqual(['title', 'launch', 'track', 'target', 'target', 'target', 'toll']);
    expect(shots.reduce((sum, s) => sum + s.ms, 0)).toBe(volleyMovieMs(strike.targets));
  });

  it('classifies what happened to each city', () => {
    expect(targetOutcome(target({ leveled: true }))).toBe('razed');
    expect(targetOutcome(target({ absorbed: true }))).toBe('bunker');
    expect(targetOutcome(target({ hadShield: true }))).toBe('shield');
    expect(targetOutcome(target({ weapons: ['commando'], raid: 'captured' }))).toBe('captured');
    expect(targetOutcome(target({ weapons: ['commando'], raid: 'repelled' }))).toBe('repelled');
    expect(targetOutcome(target({ weapons: ['commando'], raid: 'empty' }))).toBe('empty');
    expect(targetOutcome(target({ weapons: ['drone'], lasered: true }))).toBe('swarmShot');
    expect(targetOutcome(target({ weapons: ['drone'] }))).toBe('swarmed');
  });

  it('groups a volley by city and lists the arsenal once per weapon', () => {
    const stops = volleyWeapons([
      { targetNationId: 'russia', cityId: 'moscow', weapon: 'drone' },
      { targetNationId: 'russia', cityId: 'moscow', weapon: 'nuke' },
      { targetNationId: 'china', cityId: 'wuhan', weapon: 'commando' },
    ]);
    expect(stops).toEqual([['drone', 'nuke'], ['commando']]);
    const arsenal = arsenalOf({ from: 'us', targets: [target(), target({ cityId: 'b' }), target({ cityId: 'c', weapons: ['drone'] })] });
    expect(arsenal).toEqual([
      { weapon: 'nuke', count: 2 },
      { weapon: 'drone', count: 1 },
    ]);
  });
});

describe('volley order', () => {
  const strike = (attackerId: string, weapon: string): PendingStrike =>
    ({ attackerId, targetNationId: 'russia', cityId: 'ru-1', weapon }) as unknown as PendingStrike;
  const ev = (kind: string, attackerId: string): RoundWorldEvent =>
    ({ id: kind + attackerId, kind, nationId: 'russia', cityId: 'ru-1', attackerId }) as unknown as RoundWorldEvent;

  it('plays the volley that razed a city before the squad that found it empty', () => {
    const squad = { attackerId: 'us', strikes: [strike('us', 'commando')] } as any;
    const bomber = { attackerId: 'china', strikes: [strike('china', 'nuke')] } as any;
    const out = orderVolleysForFilm([squad, bomber], [ev('cityDestroyed', 'china')]);
    expect(out.map((v) => v.attackerId)).toEqual(['china', 'us']);
  });

  it('leaves a squad that took the city in its place', () => {
    const squad = { attackerId: 'us', strikes: [strike('us', 'commando')] } as any;
    const bomber = { attackerId: 'china', strikes: [strike('china', 'nuke')] } as any;
    const out = orderVolleysForFilm([bomber, squad], [ev('cityCaptured', 'us')]);
    expect(out).toHaveLength(2);
  });
});
