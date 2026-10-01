import {
  ALLIANCE_TRIBUTE,
  acceptAlliance,
  allianceOf,
  allianceWindowOpen,
  allyOf,
  declineAlliance,
  hasAerospaceAccess,
  hasBallisticTech,
  hasSpyService,
  incomingInvites,
  inviteBlockedReason,
  outgoingInvite,
  proposeAlliance,
  tributeFrom,
} from './alliance';
import { allScores, laserNetwork, totalWarheads } from './engine';
import type { GameState, NationId } from '../types';

/**
 * How AI nations take part in alliances. Everything here is a plain function
 * of the game state — no dice — so every client that runs the AI reaches the
 * same answer. An AI weighs what a partner would add to its own position, how
 * much it needs help, and what the money terms cost or earn it.
 */

/** Minimum score for an AI to say yes or to go asking. */
const ACCEPT_AT = 2.5;
/** What a $10M-a-round term swings the verdict by. */
const MONEY_WEIGHT = 1.5;
/** How much better a new partner must be before an allied AI walks away from its ally. */
const SWITCH_MARGIN = 1.5;
/** A bid for a nation that already has an ally has to clear a higher bar. */
const POACH_EXTRA = 2;
/** The most a runaway leader can add to how much two chasers want each other. */
const GANG_MAX = 2.5;
/** Points of lead that add one point of appeal between two nations chasing the leader. */
const GANG_PER_POINT = 30;
/** Points of clear lead over second place that add one point of coolness towards the leader. */
const LEAD_PER_COOL = 10;
/** A nation does not befriend the one it is trying to catch. */
const LEADER_COOL = 2;
/** Humans are the table's real opponents; an AI weighs a human partner slightly higher. */
const HUMAN_LIKING = 1;

/** How far apart two standings must be (0 = same, 1 = top to bottom) before an AI puts money on the table. */
const TERMS_GAP = 0.5;
/** How far the top two must stand above third place before their pact counts as a lock. */
const LOCK_MARGIN = 15;

/** Two front-runners do not team up to lock the table: the rest would never catch them. */
function lockout(state: GameState, a: NationId, b: NationId): boolean {
  const rows = allScores(state).filter((r) => !r.eliminated);
  if (rows.length < 4) return false;
  // Only a front pair that has pulled clear of the field can lock it
  if (rows[1].total - rows[2].total < LOCK_MARGIN) return false;
  const front = new Set(rows.slice(0, 2).map((r) => r.nationId));
  return front.has(a) && front.has(b);
}

/** 0 = leading … 1 = last, among the nations still in the game. */
function standing(state: GameState, id: NationId): number {
  const rows = allScores(state).filter((r) => !r.eliminated);
  const i = rows.findIndex((r) => r.nationId === id);
  if (i < 0 || rows.length < 2) return 1;
  return i / (rows.length - 1);
}

/** What `partner` would add to `viewer`'s position, in rough points. */
export function allianceAppeal(state: GameState, viewer: NationId, partner: NationId): number {
  const p = state.nations[partner];
  let appeal = 0;
  if (p.hasSpyNetwork && !hasSpyService(state, viewer)) appeal += 2;
  if (laserNetwork(state, partner) && !laserNetwork(state, viewer)) appeal += 2;
  if (p.hasAerospaceTech && !hasAerospaceAccess(state, viewer)) appeal += 1.5;
  if (p.hasNuclearTech && !hasBallisticTech(state, viewer)) appeal += 1.5;
  appeal += Math.min(2, (totalWarheads(p) + p.drones) * 0.4);
  const standingCities = p.cities.filter((c) => !c.destroyed);
  const defences = standingCities.filter((c) => c.hasShield || c.isUnderground || c.hasResearch).length;
  appeal += Math.min(1.5, defences * 0.4);
  // A strong partner is a better shield than a weak one
  appeal += (1 - standing(state, partner)) * 1.5;
  if (p.isHuman) appeal += HUMAN_LIKING;
  // The table leader is everyone's problem: the nations behind band together against
  // them, and nobody chasing the leader takes the leader as a partner
  const rows = allScores(state).filter((r) => !r.eliminated);
  const top = rows[0];
  if (top && rows.length >= 3) {
    if (partner === top.nationId && viewer !== top.nationId) {
      // Only a leader who has actually pulled clear is shunned; a tie at the top is nobody's target
      appeal -= Math.min(LEADER_COOL, Math.max(0, top.total - rows[1].total) / LEAD_PER_COOL);
    } else if (viewer !== top.nationId) {
      const mine = rows.find((r) => r.nationId === viewer)?.total ?? top.total;
      appeal += Math.min(GANG_MAX, Math.max(0, top.total - mine) / GANG_PER_POINT);
    }
  }
  return appeal;
}

/**
 * Would `ai` take this pact? Money terms are from the inviter's side:
 * positive means the inviter pays, so the AI earns it.
 */
export function aiWouldAccept(
  state: GameState,
  ai: NationId,
  from: NationId,
  tribute: number,
): boolean {
  if (lockout(state, ai, from)) return false;
  const need = standing(state, ai) * 1.5;
  const money = tribute > 0 ? MONEY_WEIGHT : tribute < 0 ? -MONEY_WEIGHT : 0;
  return allianceAppeal(state, ai, from) + need + money >= ACCEPT_AT;
}

/** What the AI's current partner is worth to it, money included. */
function partnerValue(state: GameState, ai: NationId, partner: NationId): number {
  const money = tributeFrom(state, ai);
  // Negative means the ally pays the AI
  return allianceAppeal(state, ai, partner) + (money < 0 ? MONEY_WEIGHT : money > 0 ? -MONEY_WEIGHT : 0);
}

/** The terms an AI puts on an invitation: it pays when weak, asks when strong. */
function aiTerms(state: GameState, ai: NationId, partner: NationId): number {
  const mine = standing(state, ai);
  const theirs = standing(state, partner);
  // Money only changes hands when the two are clearly apart: half the table or more
  if (mine >= 0.6 && mine - theirs >= TERMS_GAP) return ALLIANCE_TRIBUTE;
  if (mine <= 0.34 && theirs - mine >= TERMS_GAP) return -ALLIANCE_TRIBUTE;
  return 0;
}

/** Answer every invitation waiting on an AI nation: best offer in, the rest declined. */
export function answerAiInvites(state: GameState, ai: NationId): GameState {
  if (state.nations[ai]?.isHuman) return state;
  let s = state;
  const waiting = incomingInvites(s, ai);
  if (waiting.length === 0) return s;
  const terms = (from: NationId) => allianceOf(s.nations[from]).tribute ?? 0;
  // An AI that already has an ally only switches for a clearly better partner
  const current = allyOf(s, ai);
  const loyalty = current ? partnerValue(s, ai, current) + SWITCH_MARGIN : -Infinity;
  const scored = waiting
    .map((from) => ({ from, score: allianceAppeal(s, ai, from) + (terms(from) > 0 ? MONEY_WEIGHT : terms(from) < 0 ? -MONEY_WEIGHT : 0) }))
    .filter((o) => aiWouldAccept(s, ai, o.from, terms(o.from)) && o.score > loyalty)
    .sort((a, b) => b.score - a.score);
  const chosen = scored[0]?.from ?? null;
  for (const from of waiting) {
    if (from !== chosen) s = declineAlliance(s, from, ai);
  }
  if (chosen) {
    s = acceptAlliance(s, chosen, ai);
  }
  return s;
}

/** Send an invitation, and if it goes to an AI, let it answer at once. */
export function proposeAllianceWithReply(
  state: GameState,
  to: NationId,
  actor: NationId,
  tribute = 0,
): GameState {
  const sent = proposeAlliance(state, to, actor, tribute);
  if (sent === state) return state;
  return state.nations[to].isHuman ? sent : answerAiInvites(sent, to);
}

/**
 * One AI nation's diplomacy for the round: answer what is waiting and — when
 * it has no partner — go and ask the nation that would complete it best, human or AI.
 */
export function runAiAlliances(state: GameState, ai: NationId): GameState {
  const me = state.nations[ai];
  if (!me || me.eliminated || me.isHuman) return state;
  if (!allianceWindowOpen(state)) return state;

  let s = answerAiInvites(state, ai);
  if (allyOf(s, ai)) return s;

  // Already waiting on an answer from a human: do not nag
  const out = outgoingInvite(s, ai);
  if (out && !out.declined) return s;

  const candidates = s.turnOrder
    .filter((id) => id !== ai && !inviteBlockedReason(s, ai, id))
    // A nation that said no once is not asked again
    .filter((id) => allianceOf(s.nations[id]).declined[ai] === undefined)
    .filter((id) => !lockout(s, ai, id))
    .map((id) => ({ id, score: allianceAppeal(s, ai, id) }))
    // Someone already in a pact has to be worth leaving it for
    .filter((c) => c.score >= ACCEPT_AT + (allyOf(s, c.id) ? POACH_EXTRA : 0))
    .sort((a, b) => b.score - a.score || s.turnOrder.indexOf(a.id) - s.turnOrder.indexOf(b.id));
  const pick = candidates[0];
  if (!pick) return s;

  s = proposeAllianceWithReply(s, pick.id, ai, aiTerms(s, ai, pick.id));
  return s;
}

/**
 * Every AI nation takes its turn at the alliance desk. Offline the AI otherwise acts after
 * the player's orders, so this is what gives the player something to answer at the start.
 */
export function runAllAiAlliances(state: GameState): GameState {
  let s = state;
  for (const id of s.turnOrder) s = runAiAlliances(s, id);
  return s;
}
