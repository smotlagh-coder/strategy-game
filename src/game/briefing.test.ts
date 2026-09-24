import { describe, expect, it } from 'vitest';
import { MAX_ROUNDS } from '../data/nations';
import {
  applyQueuedStrike,
  createInitialState,
  finishStrikeResolution,
  nextRound,
  seatTable,
  startGame,
  toggleSanction,
} from './engine';
import { buildRoundBriefing } from './briefing';
import type { GameState, NationId } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia'];

function table(): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(SEATS, { size: SEATS.length }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, money: 20 },
      uk: { ...base.nations.uk, money: 20 },
      russia: { ...base.nations.russia, money: 20 },
    },
  });
}

/** Resolve the queued volley and roll the table into the next round. */
function playRound(state: GameState): GameState {
  let s = state;
  while (s.pendingStrikes.length > 0) {
    const strike = s.pendingStrikes[0];
    s = applyQueuedStrike({ ...s, pendingStrikes: s.pendingStrikes.slice(1) }, strike);
  }
  return nextRound(finishStrikeResolution(s));
}

function nuke(state: GameState, attacker: NationId, target: NationId, cityIndex: number) {
  return {
    ...state,
    pendingStrikes: [
      ...state.pendingStrikes,
      {
        attackerId: attacker,
        targetNationId: target,
        cityId: state.nations[target].cities[cityIndex].id,
        weapon: 'nuke' as const,
      },
    ],
  };
}

/** Patch the player's nation after the round rolled, to set up one weakness. */
function setUs(state: GameState, patch: Partial<GameState['nations']['us']>): GameState {
  return { ...state, nations: { ...state.nations, us: { ...state.nations.us, ...patch } } };
}

/** A nation with nothing wrong with it, as a base for the weakness rules. */
function healthy(state: GameState): GameState {
  return setUs(state, {
    money: 20,
    bombs: 2,
    hasNuclearTech: true,
    nuclearTechUnlockedRound: 1,
    cities: state.nations.us.cities.map((c, i) => ({ ...c, hasShield: i === 0 })),
  });
}

describe('round briefing', () => {
  it('has nothing to report in round 1', () => {
    expect(buildRoundBriefing(table(), 'us')).toBeNull();
  });

  it('needs a nation to report on', () => {
    expect(buildRoundBriefing(table(), null)).toBeNull();
  });

  it('marks the city that was destroyed and names who did it', () => {
    let s = table();
    const hit = s.nations.us.cities[1];
    s = playRound(nuke(s, 'uk', 'us', 1));

    const brief = buildRoundBriefing(s, 'us');
    expect(brief).not.toBeNull();
    expect(brief!.round).toBe(2);

    const city = brief!.cities.find((c) => c.id === hit.id)!;
    expect(city.status).toBe('destroyed');
    expect(city.destroyed).toBe(true);
    expect(city.attackers).toEqual(['uk']);

    // The cities nobody touched still show up, so the page is the whole nation
    expect(brief!.cities).toHaveLength(s.nations.us.cities.length);
    expect(brief!.cities.filter((c) => c.status === 'quiet')).toHaveLength(
      s.nations.us.cities.length - 1,
    );
    expect(brief!.untouched).toBe(false);
  });

  it('collapses a volley into one row per attacker', () => {
    let s = table();
    s = nuke(s, 'uk', 'us', 0);
    s = nuke(s, 'uk', 'us', 1);
    s = nuke(s, 'russia', 'us', 2);
    s = playRound(s);

    const brief = buildRoundBriefing(s, 'us')!;
    expect(brief.raiders).toHaveLength(2);
    const uk = brief.raiders.find((r) => r.id === 'uk')!;
    expect(uk.nukes).toBe(2);
    expect(uk.swarms).toBe(0);
    expect(uk.cities).toHaveLength(2);
  });

  it('reports a shield that took the hit instead of the city', () => {
    let s = table();
    const shielded = s.nations.us.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        us: {
          ...s.nations.us,
          cities: s.nations.us.cities.map((c) =>
            c.id === shielded.id ? { ...c, hasShield: true } : c,
          ),
        },
      },
    };
    s = playRound(nuke(s, 'uk', 'us', 0));

    const city = buildRoundBriefing(s, 'us')!.cities.find((c) => c.id === shielded.id)!;
    expect(city.status).toBe('shieldLost');
    expect(city.destroyed).toBe(false);
  });

  it('reports a quiet round with the standings and treasury only', () => {
    const s = playRound(table());
    const brief = buildRoundBriefing(s, 'us')!;

    expect(brief.untouched).toBe(true);
    expect(brief.raiders).toEqual([]);
    expect(brief.cities.every((c) => c.status === 'quiet')).toBe(true);
    expect(brief.scores).toHaveLength(SEATS.length);
    expect(brief.money).toBe(s.nations.us.money);
    expect(brief.income).toBeGreaterThan(0);
  });

  it('carries the sanctions that taxed this round of income', () => {
    let s = table();
    s = toggleSanction(s, 'us', 'uk');
    s = toggleSanction(s, 'us', 'russia');
    s = playRound(s);

    const brief = buildRoundBriefing(s, 'us')!;
    expect(brief.sanctioners.sort()).toEqual(['russia', 'uk']);
    expect(brief.sanctionPenalty).toBeCloseTo(0.2, 5);
  });

  it('counts what the nation owns going into the round', () => {
    let s = table();
    s = {
      ...s,
      nations: {
        ...s.nations,
        us: {
          ...s.nations.us,
          bombs: 2,
          drones: 1,
          hasNuclearTech: true,
          nuclearTechUnlockedRound: 1,
          hasSpyNetwork: true,
          cities: s.nations.us.cities.map((c, i) => ({
            ...c,
            hasShield: i === 0,
            hasResearch: i < 2,
            hasLaser: i === 1,
            isUnderground: i === 2,
          })),
        },
      },
    };
    s = playRound(s);

    const { assets } = buildRoundBriefing(s, 'us')!;
    expect(assets).toMatchObject({
      standing: 3,
      rubble: 0,
      shields: 1,
      bunkers: 1,
      labs: 2,
      lasers: 1,
      bombs: 2,
      drones: 1,
      spyNetwork: true,
      canArmNukes: true,
      canArmDrones: false,
    });
  });

  it('drops destroyed cities out of the asset count', () => {
    let s = table();
    s = playRound(nuke(s, 'uk', 'us', 0));

    const { assets } = buildRoundBriefing(s, 'us')!;
    expect(assets.standing).toBe(2);
    expect(assets.rubble).toBe(1);
  });

  describe('biggest weakness', () => {
    it('leads with the last city standing above everything else', () => {
      let s = table();
      s = playRound(nuke(nuke(s, 'uk', 'us', 0), 'russia', 'us', 1));
      s = setUs(s, { money: 20, hasNuclearTech: true, nuclearTechUnlockedRound: 1, bombs: 2 });

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('lastStand');
      expect(weakness.severity).toBe('critical');
      expect(weakness.advice).toContain('$6M');
    });

    it('does not panic over a last city that is already dug in', () => {
      let s = table();
      s = setUs(s, {
        cities: s.nations.us.cities.map((c, i) => ({ ...c, isUnderground: i === 2 })),
      });
      s = playRound(nuke(nuke(s, 'uk', 'us', 0), 'russia', 'us', 1));

      expect(buildRoundBriefing(s, 'us')!.weakness.id).not.toBe('lastStand');
    });

    it('flags rubble the treasury cannot raise', () => {
      let s = table();
      s = playRound(nuke(s, 'uk', 'us', 0));
      s = setUs(s, { money: 1 });

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('cannotRebuild');
      expect(weakness.detail).toContain('$1M');
    });

    it('pushes the rebuild when the money is there', () => {
      let s = table();
      s = playRound(nuke(s, 'uk', 'us', 0));
      s = setUs(s, { money: 12 });

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('rubbleIdle');
      expect(weakness.advice).toContain('3');
    });

    it('calls out cities with nothing over them', () => {
      const s = setUs(playRound(table()), { money: 20 });
      expect(buildRoundBriefing(s, 'us')!.weakness.id).toBe('openCities');
    });

    it('calls out a nation that cannot shoot back', () => {
      const s = setUs(playRound(table()), {
        money: 20,
        cities: table().nations.us.cities.map((c, i) => ({ ...c, hasShield: i === 0 })),
      });
      expect(buildRoundBriefing(s, 'us')!.weakness.id).toBe('noWarheads');
    });

    it('calls out an empty rack once the tech is in', () => {
      const s = setUs(healthy(playRound(table())), { bombs: 0, drones: 0 });
      expect(buildRoundBriefing(s, 'us')!.weakness.id).toBe('emptyArsenal');
    });

    it('calls out a treasury that cannot buy anything', () => {
      const s = setUs(healthy(playRound(table())), { money: 1 });
      expect(buildRoundBriefing(s, 'us')!.weakness.id).toBe('brokeTreasury');
    });

    it('reads a double sanction as the target list it is', () => {
      let s = table();
      s = toggleSanction(s, 'us', 'uk');
      s = toggleSanction(s, 'us', 'russia');
      s = healthy(playRound(s));

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('sanctionSqueeze');
      expect(weakness.detail).toContain('20%');
    });

    it('flags a rival running away with the score', () => {
      let s = healthy(playRound(table()));
      s = {
        ...s,
        nations: {
          ...s.nations,
          russia: { ...s.nations.russia, citySurvivalPoints: 200 },
        },
      };

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('losingRace');
      expect(weakness.title).toContain('Russia');
    });

    it('tells a trailing player the final round is not won by defending', () => {
      let s = healthy(playRound(table()));
      // Russia banks two extra cities' worth of score, and the clock runs out
      s = { ...s, round: MAX_ROUNDS, nations: { ...s.nations, us: { ...s.nations.us, citySurvivalPoints: 0 } } };

      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('finalPush');
      expect(weakness.severity).toBe('critical');
      expect(weakness.advice).toContain('warhead');
    });

    it('quotes prices as money, not as "$2MM"', () => {
      // formatMoney already carries the M, so the advice must not add its own
      const states = [
        setUs(playRound(table()), { money: 20 }),
        setUs(healthy(playRound(table())), { money: 1 }),
        setUs(healthy(playRound(table())), { bombs: 0, drones: 0 }),
        healthy(playRound(table())),
      ];
      for (const s of states) {
        const { title, detail, advice } = buildRoundBriefing(s, 'us')!.weakness;
        expect(`${title} ${detail} ${advice}`).not.toMatch(/MM/);
      }
    });

    it('says so when there is nothing to fix', () => {
      const s = healthy(playRound(table()));
      const { weakness } = buildRoundBriefing(s, 'us')!;
      expect(weakness.id).toBe('holding');
      expect(weakness.severity).toBe('none');
    });
  });

  it('ranks the table with the leader first and OUT nations last', () => {
    let s = table();
    // Broke, so losing the last city cannot be answered with an emergency rebuild
    s = { ...s, nations: { ...s.nations, russia: { ...s.nations.russia, money: 0 } } };
    s = nuke(s, 'uk', 'russia', 0);
    s = nuke(s, 'uk', 'russia', 1);
    s = nuke(s, 'uk', 'russia', 2);
    s = playRound(s);

    const brief = buildRoundBriefing(s, 'us')!;
    expect(brief.scores[brief.scores.length - 1].nationId).toBe('russia');
    expect(brief.scores[brief.scores.length - 1].eliminated).toBe(true);
    expect(brief.scores[0].eliminated).toBe(false);
  });
});
