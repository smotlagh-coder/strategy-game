import { nationDef } from '../data/nations';
import type {
  AllianceState,
  GameState,
  LogEntry,
  NationId,
  NationState,
} from '../types';

/**
 * Alliances: two human nations that fight side by side.
 *
 * The pact is stored as one pointer per nation (`alliance.with`), written only
 * by the nation's own client. Two nations are allies exactly when each one
 * points at the other — so there is never a shared record to fight over online,
 * and everything an alliance does (shared spy service, shared tech, shared
 * laser cover, shared sanctions) is worked out from the pair when it is read.
 *
 * This file never imports the engine; the engine imports it.
 */

/** Alliances open once the first round is done. */
export const ALLIANCE_FIRST_ROUND = 2;

/** An alliance runs from round 2 to the round before the last. */
export function allianceWindowOpen(state: GameState): boolean {
  return state.round >= ALLIANCE_FIRST_ROUND && state.round <= state.maxRounds - 1;
}

const blankAlliance = (): AllianceState => ({
  with: null,
  proposalId: 0,
  declined: {},
  version: 0,
});

export function allianceOf(nation: NationState | undefined): AllianceState {
  return nation?.alliance ?? blankAlliance();
}

/** Any live commander can make a pact — human or AI. */
const canAlly = (n: NationState | undefined): n is NationState => Boolean(n && !n.eliminated);

/** What a pact's money terms move each round, in $M. */
export const ALLIANCE_TRIBUTE = 10;

/**
 * A payment never takes more than this share of what the payer earned this round,
 * so a nation down to a city or two is not bled dry by a pact signed when it was big.
 */
export const PACT_INCOME_SHARE = 0.2;

/** What actually changes hands: the agreed amount, held to the payer's share of income. */
export function pactPayment(owed: number, payerRevenue: number): number {
  return Math.max(0, Math.min(Math.abs(owed), Math.floor(payerRevenue * PACT_INCOME_SHARE)));
}

/** The three offers an invitation can carry: even, "I pay", or "you pay". */
export type TributeTerms = -10 | 0 | 10;

let allySeq = 0;
const note = (text: string): LogEntry => ({ id: `log-ally-${Date.now()}-${++allySeq}`, text, tone: 'neutral' });

/** The nation `id` is allied with right now, or null. */
export function allyOf(state: GameState, id: NationId): NationId | null {
  if (!allianceWindowOpen(state)) return null;
  const me = state.nations[id];
  if (!canAlly(me)) return null;
  const to = allianceOf(me).with;
  if (!to || to === id) return null;
  const other = state.nations[to];
  if (!canAlly(other)) return null;
  return allianceOf(other).with === id ? to : null;
}

export function areAllies(state: GameState, a: NationId, b: NationId): boolean {
  return a !== b && allyOf(state, a) === b;
}

/** Nations that have invited `id` and are still waiting for an answer. */
export function incomingInvites(state: GameState, id: NationId): NationId[] {
  if (!allianceWindowOpen(state)) return [];
  const me = state.nations[id];
  if (!canAlly(me)) return [];
  const mine = allianceOf(me);
  // An ally's own invitation is the pact itself, not an offer; anyone else may still ask
  const current = allyOf(state, id);
  return state.turnOrder.filter((from) => {
    if (from === id || from === current) return false;
    const n = state.nations[from];
    if (!canAlly(n)) return false;
    const a = allianceOf(n);
    return a.with === id && a.proposalId > 0 && mine.declined[from] !== a.proposalId;
  });
}

/** The invitation `id` has out, and whether it was turned down. */
export function outgoingInvite(
  state: GameState,
  id: NationId,
): { to: NationId; declined: boolean } | null {
  if (!allianceWindowOpen(state) || allyOf(state, id)) return null;
  const me = state.nations[id];
  if (!canAlly(me)) return null;
  const a = allianceOf(me);
  if (!a.with) return null;
  const target = state.nations[a.with];
  if (!canAlly(target)) return null;
  return { to: a.with, declined: allianceOf(target).declined[id] === a.proposalId };
}

/** Why `from` cannot invite `to` right now, or null when they can. */
export function inviteBlockedReason(
  state: GameState,
  from: NationId,
  to: NationId,
): string | null {
  if (!allianceWindowOpen(state)) {
    return state.round < ALLIANCE_FIRST_ROUND
      ? 'Alliances open after round 1'
      : 'Alliances close for the final round';
  }
  const a = state.nations[from];
  const b = state.nations[to];
  if (!canAlly(a) || !canAlly(b) || from === to) return 'Only live players can ally';
  if (allyOf(state, from)) return 'You already have an ally';
  // A declined invitation can be sent again; a pending one is already out
  if (allianceOf(a).with === to && !outgoingInvite(state, from)?.declined) return 'Invitation sent';
  return null;
}

/** Everyone `from` could invite: other live human players. */
export function allianceCandidates(state: GameState, from: NationId): NationId[] {
  return state.turnOrder.filter((id) => id !== from && canAlly(state.nations[id]));
}

function withAlliance(
  state: GameState,
  id: NationId,
  patch: (a: AllianceState) => Partial<AllianceState>,
  entry?: string,
): GameState {
  const n = state.nations[id];
  const a = allianceOf(n);
  const next: AllianceState = { ...a, ...patch(a), version: a.version + 1 };
  return {
    ...state,
    nations: { ...state.nations, [id]: { ...n, alliance: next } },
    log: entry ? [...state.log, note(entry)] : state.log,
  };
}

export function proposeAlliance(
  state: GameState,
  to: NationId,
  actor: NationId,
  tribute: number = 0,
): GameState {
  if (inviteBlockedReason(state, actor, to)) return state;
  const terms = tribute > 0 ? ALLIANCE_TRIBUTE : tribute < 0 ? -ALLIANCE_TRIBUTE : 0;
  // Inviting someone who already invited you is the same as saying yes
  if (incomingInvites(state, actor).includes(to)) return acceptAlliance(state, to, actor);
  // Whatever was offered before is withdrawn; the new offer is a fresh proposal
  return withAlliance(
    state,
    actor,
    (a) => ({
      with: to,
      proposalId: a.version + 1,
      tribute: terms,
      terms: null,
    }),
    `${nationDef(actor).name} invited ${nationDef(to).name} to an alliance${
      terms > 0
        ? `, offering $${ALLIANCE_TRIBUTE}M a round`
        : terms < 0
          ? `, asking $${ALLIANCE_TRIBUTE}M a round`
          : ''
    }.`,
  );
}

const clearedPointer = () => ({
  with: null,
  tribute: 0,
  terms: null,
});

/**
 * Take back an invitation, or walk away from an alliance — allowed in any round.
 * Leaving ends the pact for both sides at once (so the partner is not left with
 * a dangling invitation), and with it the per-round money.
 */
export function leaveAlliance(state: GameState, actor: NationId): GameState {
  const a = allianceOf(state.nations[actor]);
  if (!a.with) return state;
  const ally = allyOf(state, actor);
  if (!ally) {
    return withAlliance(
      state,
      actor,
      clearedPointer,
      `${nationDef(actor).name} withdrew the alliance invitation to ${nationDef(a.with).name}.`,
    );
  }
  const left = withAlliance(
    state,
    actor,
    clearedPointer,
    `${nationDef(actor).name} left the alliance with ${nationDef(ally).name}. The alliance is over and its payments have stopped.`,
  );
  return withAlliance(left, ally, clearedPointer);
}

export function acceptAlliance(state: GameState, from: NationId, actor: NationId): GameState {
  const waiting = incomingInvites(state, actor);
  if (!waiting.includes(from)) return state;
  // Saying yes while allied means leaving that alliance
  const previous = allyOf(state, actor);
  let next = withAlliance(
    state,
    actor,
    (a) => {
      // The other offers on the table are answered by this one
      const declined = { ...a.declined };
      for (const other of waiting) {
        if (other !== from) declined[other] = allianceOf(state.nations[other]).proposalId;
      }
      delete declined[from];
      return {
        with: from,
        declined,
        // The terms the inviter offered are the terms of the pact
        terms: { proposer: from, tribute: allianceOf(state.nations[from]).tribute ?? 0 },
      };
    },
    `${nationDef(actor).name} and ${nationDef(from).name} are now allies.`,
  );
  if (previous && previous !== from) {
    next = withAlliance(
      next,
      previous,
      clearedPointer,
      `${nationDef(actor).name} left the alliance with ${nationDef(previous).name} for one with ${nationDef(from).name}. The old alliance is over and its payments have stopped.`,
    );
  }
  return next;
}

export function declineAlliance(state: GameState, from: NationId, actor: NationId): GameState {
  if (!incomingInvites(state, actor).includes(from)) return state;
  const proposalId = allianceOf(state.nations[from]).proposalId;
  return withAlliance(
    state,
    actor,
    (a) => ({ declined: { ...a.declined, [from]: proposalId } }),
    `${nationDef(actor).name} declined an alliance with ${nationDef(from).name}.`,
  );
}

export type ShareKind = 'ballistic' | 'aerospace';

/* ─────────── what an alliance gives, read off the pair ─────────── */

const techReady = (n: NationState, kind: ShareKind, round: number): boolean => {
  const unlocked = kind === 'ballistic' ? n.nuclearTechUnlockedRound : n.aerospaceTechUnlockedRound;
  return (kind === 'ballistic' ? n.hasNuclearTech : n.hasAerospaceTech) &&
    unlocked != null &&
    unlocked <= round;
};

/** The ally whose tech `id` is using, or null. Allies share it automatically, with no switch to flip. */
export function techLenderOf(state: GameState, id: NationId, kind: ShareKind): NationId | null {
  const ally = allyOf(state, id);
  if (!ally) return null;
  const lender = state.nations[ally];
  return techReady(lender, kind, state.round) ? ally : null;
}

/** Ballistic Missile Tech, owned or lent by an ally. */
export function hasBallisticTech(state: GameState, id: NationId): boolean {
  return Boolean(state.nations[id]?.hasNuclearTech) || techLenderOf(state, id, 'ballistic') != null;
}

/** Aerospace Tech, owned or lent by an ally. */
export function hasAerospaceAccess(state: GameState, id: NationId): boolean {
  return Boolean(state.nations[id]?.hasAerospaceTech) || techLenderOf(state, id, 'aerospace') != null;
}

/** A spy service of one's own, or the ally's — it comes free with the pact. */
export function hasSpyService(state: GameState, id: NationId): boolean {
  if (state.nations[id]?.hasSpyNetwork) return true;
  const ally = allyOf(state, id);
  return Boolean(ally && state.nations[ally]?.hasSpyNetwork);
}

/** Cities `id` has scouted, plus the ones the ally has. */
export function scoutedByAlliance(state: GameState, id: NationId, cityId: string): boolean {
  if (state.nations[id]?.scoutedCities?.includes(cityId)) return true;
  const ally = allyOf(state, id);
  return Boolean(ally && state.nations[ally]?.scoutedCities?.includes(cityId));
}

/**
 * Sanctions `id` runs. An allied nation picks one rival of its own and the
 * pact enforces the ally's pick too: the pair always sanctions the same two.
 */
function ownSanctions(state: GameState, id: NationId, allied: boolean): NationId[] {
  const raw = state.nations[id].sanctions.filter((t) => !state.nations[t]?.eliminated);
  return allied ? raw.slice(0, 1) : state.nations[id].sanctions;
}

export function effectiveSanctions(state: GameState, id: NationId): NationId[] {
  const ally = allyOf(state, id);
  if (!ally) return state.nations[id].sanctions;
  const merged = [...ownSanctions(state, id, true), ...ownSanctions(state, ally, true)];
  return merged.filter((t, i) => t !== id && t !== ally && merged.indexOf(t) === i);
}

/** The sanctions `id` itself chose — one when allied. */
export function ownSanctionPicks(state: GameState, id: NationId): NationId[] {
  return ownSanctions(state, id, allyOf(state, id) != null);
}

/** How many sanctions `id` may still choose: two alone, one each when allied. */
export function sanctionSlots(state: GameState, id: NationId, max: number): number {
  return allyOf(state, id) ? 1 : max;
}

/* ─────────── alliances are public: no spy service needed to see them ─────────── */

/** Every live pact at the table, each pair listed once in seating order. */
export function alliancePairs(state: GameState): [NationId, NationId][] {
  const pairs: [NationId, NationId][] = [];
  for (const id of state.turnOrder) {
    const ally = allyOf(state, id);
    if (ally && state.turnOrder.indexOf(ally) > state.turnOrder.indexOf(id)) pairs.push([id, ally]);
  }
  return pairs;
}

/** Which pact `id` belongs to (0, 1, …), so each pact can wear its own colour. */
export function pactSlot(state: GameState, id: NationId): number | null {
  const i = alliancePairs(state).findIndex((pair) => pair.includes(id));
  return i < 0 ? null : i;
}

/* ─────────── the money terms ─────────── */

/** The terms of the live pact between two allies, or null when they have none. */
export function pactTerms(
  state: GameState,
  a: NationId,
  b: NationId,
): { proposer: NationId; tribute: number } | null {
  if (!areAllies(state, a, b)) return null;
  const mine = allianceOf(state.nations[a]);
  const theirs = allianceOf(state.nations[b]);
  const pick = [mine, theirs]
    .filter((x) => x.terms && (x.terms.proposer === a || x.terms.proposer === b))
    .sort((x, y) => y.version - x.version)[0];
  return pick?.terms ?? null;
}

/** What `id` pays its ally each round, in $M; negative means the ally pays `id`. */
export function tributeFrom(state: GameState, id: NationId): number {
  const ally = allyOf(state, id);
  if (!ally) return 0;
  const terms = pactTerms(state, id, ally);
  if (!terms || terms.tribute === 0) return 0;
  // Positive tribute is paid by the proposer
  return terms.proposer === id ? terms.tribute : -terms.tribute;
}

/**
 * Does `id` get the alliance desk this round? Only inside the alliance window, for a
 * live commander with someone to talk to.
 */
export function allianceDeskOpen(state: GameState, id: NationId): boolean {
  return allianceWindowOpen(state) && canAlly(state.nations[id]) && allianceCandidates(state, id).length > 0;
}

/** An invitation gets this long to be answered. */
export const TALK_MAX_MS = 10_000;
/** The talks window stays up at least this long, even when everything settles at once. */
export const TALK_MIN_MS = 3_000;

export interface AllianceTalk {
  /** Stable for one invitation: who sent it, and which of their proposals it was. */
  key: string;
  from: NationId;
  to: NationId;
  status: 'pending' | 'allied' | 'declined';
}

/** Every invitation on record between live nations, with where it stands. */
export function allianceTalks(state: GameState): AllianceTalk[] {
  if (!allianceWindowOpen(state)) return [];
  const out: AllianceTalk[] = [];
  const paired = new Set<string>();
  for (const from of state.turnOrder) {
    const a = allianceOf(state.nations[from]);
    const to = a.with;
    if (!to || to === from || a.proposalId <= 0) continue;
    const target = state.nations[to];
    if (!canAlly(state.nations[from]) || !canAlly(target)) continue;
    let status: AllianceTalk['status'];
    if (allyOf(state, from) === to) {
      // Both sides of a finished pact may carry an invitation; it is one story
      const pair = [from, to].sort().join('+');
      if (paired.has(pair)) continue;
      paired.add(pair);
      status = 'allied';
    } else if (allianceOf(target).declined[from] === a.proposalId) status = 'declined';
    else status = 'pending';
    out.push({ key: `${from}:${a.proposalId}`, from, to, status });
  }
  return out;
}

/**
 * Does the talks window close now? It ends when the clock runs out, or once
 * every invitation in it is settled and the minimum time has been shown.
 */
export function talksDone(
  now: number,
  since: number,
  deadline: number,
  anyPending: boolean,
): boolean {
  if (now >= deadline) return true;
  return !anyPending && now - since >= TALK_MIN_MS;
}
