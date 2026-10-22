import { describe, expect, it } from 'vitest';
import type { PendingStrike } from '../types';
import {
  arsenalOf,
  buildShots,
  cinemaCaption,
  filterVolleysForViewer,
  outcomeLine,
  reconcileWithFilm,
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

describe('a city already razed this round', () => {
  it('reads as an empty hit on rubble, not a second razing', () => {
    const t = target({ rubble: true });
    expect(targetOutcome(t)).toBe('empty');
    expect(targetOutcome(target({ leveled: true }))).toBe('razed');
  });
});

describe('the film razes a city before anything hits its rubble', () => {
  it('plays the razing in the first volley with a warhead, then hits rubble', () => {
    const razed = new Set<string>();
    const first = [target({ razedBy: 'China' })];
    const second = [target({ razedBy: 'China' })];
    reconcileWithFilm(first, razed);
    expect(first[0].leveled).toBe(true);
    expect(first[0].rubble).toBeFalsy();
    reconcileWithFilm(second, razed);
    expect(second[0].rubble).toBe(true);
    expect(second[0].leveled).toBe(false);
    expect(targetOutcome(second[0])).toBe('empty');
  });

  it('turns a volley that razed it in truth into a rubble hit once the film has razed it', () => {
    const razed = new Set<string>(['ru-1']);
    const own = [target({ cityId: 'ru-1', leveled: true })];
    reconcileWithFilm(own, razed);
    expect(own[0].rubble).toBe(true);
    expect(own[0].leveled).toBe(false);
  });

  it('names the razer when a squad or swarm arrives before the film has razed the city', () => {
    const squad = [target({ weapons: ['commando'], raid: 'empty', razedBy: 'China' })];
    reconcileWithFilm(squad, new Set());
    expect(squad[0].rubble).toBe(true);
    expect(cinemaCaption(squad[0], true)).toBe('China razed it first');
    const swarm = [target({ weapons: ['drone'], razedBy: 'China' })];
    reconcileWithFilm(swarm, new Set());
    expect(cinemaCaption(swarm[0], true)).toBe('China razed it first');
  });

  it('never says nothing is left for a city the film has not razed', () => {
    const t = target({ weapons: ['nuke'], razedBy: 'China' });
    reconcileWithFilm([t], new Set());
    expect(cinemaCaption(t, true)).toBe('City in rubble');
  });

  it('razes through a hydrogen or escorted hit as before', () => {
    const t = target({ weapons: ['hydrogen'] });
    const razed = new Set<string>();
    reconcileWithFilm([t], razed);
    expect(t.leveled).toBe(true);
    expect(razed.has(t.cityId)).toBe(true);
  });

  it('a squad whose own warhead razed the city shows the razing, then rubble', () => {
    const t = target({ weapons: ['nuke', 'commando'], raid: 'empty', leveled: true });
    expect(targetOutcome(t)).toBe('razed');
    expect(cinemaCaption(t, true)).toBe('City in rubble');
  });

  it('never says nothing is left to take', () => {
    const rubble = target({ weapons: ['commando'], raid: 'empty', rubble: true });
    const held = target({ weapons: ['commando'], raid: 'empty', heldBy: 'Brazil' });
    const gone = target({ weapons: ['commando'], raid: 'empty' });
    for (const t of [rubble, held, gone]) {
      expect(cinemaCaption(t, true)).not.toMatch(/nothing left/i);
      expect(outcomeLine(t)).not.toMatch(/nothing left/i);
    }
    expect(cinemaCaption(held, true)).toBe('Brazil took it first');
    expect(cinemaCaption(rubble, true)).toBe('City in rubble');
  });
});

describe('whose battles the cinema films', () => {
  const strike = (attackerId: string, targetNationId: string, cityId: string) =>
    ({ attackerId, targetNationId, cityId, weapon: 'nuke' }) as unknown as PendingStrike;
  const volley = (attackerId: string, strikes: PendingStrike[]) => ({ attackerId, strikes }) as any;
  const volleys = [
    volley('us', [strike('us', 'china', 'cn-1')]),
    volley('russia', [strike('russia', 'uk', 'uk-1'), strike('russia', 'us', 'us-2')]),
    volley('china', [strike('china', 'uk', 'uk-2')]),
  ];

  it('keeps my launches whole and only the strikes that land on my cities from others', () => {
    const out = filterVolleysForViewer(volleys, ['us']);
    expect(out.map((v: any) => v.attackerId)).toEqual(['us', 'russia']);
    expect(out[1].strikes.map((s: PendingStrike) => s.cityId)).toEqual(['us-2']);
  });

  it('shows nothing when the round never touched me', () => {
    expect(filterVolleysForViewer(volleys, ['brazil'])).toEqual([]);
  });

  it('films everything for spectators and the all-battles setting', () => {
    expect(filterVolleysForViewer(volleys, null)).toBe(volleys);
  });
});
