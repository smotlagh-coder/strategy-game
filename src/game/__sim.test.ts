import { describe, it } from 'vitest';
import { COSTS, NATIONS } from '../data/nations';
import {
  allScores,
  applyQueuedStrike,
  buySpyNetwork,
  createInitialState,
  finishStrikeResolution,
  nextRound,
  orderStrikesForResolution,
  seatTable,
  startGame,
} from './engine';
import { runAllAiUntilHumanOrSummary } from './ai';
import type { GameState, NationId } from '../types';

/** An all-AI table of `size` nations, in a fixed order. */
function aiTable(size: number, offset = 0): GameState {
  const base = createInitialState();
  const ids = NATIONS.map((n) => n.id).slice(offset, offset + size);
  const nations = { ...base.nations };
  for (const id of ids) nations[id] = { ...nations[id], isHuman: false };
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(ids, { size }),
    humanNations: [],
    nations,
  });
}

type Tally = {
  nukes: number;
  kills: number;
  intoRock: number;
  intoShield: number;
  ontoResearch: number;
  swarms: number;
  swarmsShotDown: number;
  spyRound: number | null;
};

function blank(): Tally {
  return {
    nukes: 0,
    kills: 0,
    intoRock: 0,
    intoShield: 0,
    ontoResearch: 0,
    swarms: 0,
    swarmsShotDown: 0,
    spyRound: null,
  };
}

function playMatch(
  size: number,
  opts: { offset?: number; beforeRound?: (s: GameState) => GameState } = {},
): { state: GameState; tally: Record<string, Tally> } {
  let s = aiTable(size, opts.offset ?? 0);
  const tally: Record<string, Tally> = {};
  for (const id of s.turnOrder) tally[id] = blank();

  let guard = 0;
  while (s.phase !== 'gameOver' && guard++ < 40) {
    if (opts.beforeRound) s = opts.beforeRound(s);
    s = runAllAiUntilHumanOrSummary(s);
    for (const id of s.turnOrder) {
      if (s.nations[id].hasSpyNetwork && tally[id].spyRound == null) tally[id].spyRound = s.round;
    }

    if (s.phase === 'resolveStrikes') {
      for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
        const before = s.nations[strike.targetNationId].cities.find((c) => c.id === strike.cityId)!;
        const t = tally[strike.attackerId];
        if (strike.weapon === 'drone') {
          t.swarms += 1;
        } else {
          t.nukes += 1;
          if (before.isUnderground) t.intoRock += 1;
          if (before.hasResearch) t.ontoResearch += 1;
        }
        s = applyQueuedStrike(s, strike);
        const after = s.nations[strike.targetNationId].cities.find((c) => c.id === strike.cityId)!;
        if (strike.weapon === 'drone') {
          // A swarm that never reached the city was shot out of the sky
          if (before.hasShield && after.hasShield && !after.shieldBusy) t.swarmsShotDown += 1;
        } else {
          if (!before.destroyed && after.destroyed) t.kills += 1;
          else if (before.hasShield && !after.hasShield) t.intoShield += 1;
        }
      }
      s = finishStrikeResolution(s);
    }
    if (s.phase === 'gameOver') break;
    s = nextRound({ ...s, phase: 'roundSummary' });
  }
  return { state: s, tally };
}

function report(label: string, runs: { state: GameState; tally: Record<string, Tally> }[]) {
  const sum = blank();
  let nations = 0;
  let spies = 0;
  for (const run of runs) {
    for (const id of Object.keys(run.tally)) {
      const t = run.tally[id];
      nations += 1;
      if (t.spyRound != null) spies += 1;
      sum.nukes += t.nukes;
      sum.kills += t.kills;
      sum.intoRock += t.intoRock;
      sum.intoShield += t.intoShield;
      sum.ontoResearch += t.ontoResearch;
      sum.swarms += t.swarms;
      sum.swarmsShotDown += t.swarmsShotDown;
    }
  }
  const pct = (n: number) => (sum.nukes ? `${Math.round((n / sum.nukes) * 100)}%` : '-');
  console.log(
    `${label}\n  nations=${nations} bought spy=${spies}\n` +
      `  nukes=${sum.nukes} kills=${sum.kills} (${pct(sum.kills)}) ` +
      `intoRock=${sum.intoRock} (${pct(sum.intoRock)}) ` +
      `intoShield=${sum.intoShield} (${pct(sum.intoShield)}) ` +
      `ontoResearch=${sum.ontoResearch} (${pct(sum.ontoResearch)})\n` +
      `  swarms=${sum.swarms} shotDown=${sum.swarmsShotDown} ` +
      `wastedNukeSpend=$${(sum.intoRock * COSTS.bomb).toFixed(1)}M`,
  );
}

describe('sim', () => {
  it('measures warhead efficiency with and without intel', () => {
    const sizes = [2, 3, 4, 5];
    report(
      'AS SHIPPED',
      sizes.map((n) => playMatch(n)),
    );
    report(
      'EVERY NATION SPIES FROM ROUND 1',
      sizes.map((n) =>
        playMatch(n, {
          beforeRound: (s) => {
            let next = s;
            for (const id of s.turnOrder) {
              if (!next.nations[id].hasSpyNetwork) next = buySpyNetwork(next, id as NationId);
            }
            return next;
          },
        }),
      ),
    );
    report(
      'NOBODY SPIES',
      sizes.map((n) =>
        playMatch(n, {
          beforeRound: (s) => ({
            ...s,
            nations: Object.fromEntries(
              Object.entries(s.nations).map(([id, n]) => [id, { ...n, hasSpyNetwork: false }]),
            ) as GameState['nations'],
          }),
        }),
      ),
    );
  });

  it('shows how a single spy fares against blind rivals', () => {
    for (const size of [3, 5]) {
      const lines: string[] = [`size=${size}`];
      for (const id of aiTable(size).turnOrder) {
        for (const from of [1, 2]) {
          const run = playMatch(size, {
            beforeRound: (s) =>
              s.round >= from && !s.nations[id].hasSpyNetwork ? buySpyNetwork(s, id as NationId) : s,
          });
          const t = run.tally[id];
          const score = allScores(run.state).find((sc) => sc.nationId === id)!;
          lines.push(
            `  ${id} spyFrom=r${from} score=${score.total} won=${run.state.winner === id ? 'Y' : 'n'} ` +
              `nukes=${t.nukes} kills=${t.kills} rock=${t.intoRock} shield=${t.intoShield} research=${t.ontoResearch}`,
          );
        }
        const base = playMatch(size);
        const t = base.tally[id];
        const score = allScores(base.state).find((sc) => sc.nationId === id)!;
        lines.push(
          `  ${id} spyFrom=--  score=${score.total} won=${base.state.winner === id ? 'Y' : 'n'} ` +
            `nukes=${t.nukes} kills=${t.kills} rock=${t.intoRock} shield=${t.intoShield} research=${t.ontoResearch}`,
        );
      }
      console.log(lines.join('\n'));
    }
  });
});
