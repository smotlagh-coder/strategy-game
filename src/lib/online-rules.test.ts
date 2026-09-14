import { describe, expect, it } from 'vitest';
import { SELECTION_IDLE_MS, selectionIdleSeconds } from './onlineConstants';
import {
  aftermathMyCityIds,
  aftermathWorldIds,
  inviteButtonState,
  isAlreadyInvited,
} from './lobbyInvite';
import { phaseRank, pickFurtherState } from './onlineSync';
import { assignNations, buildOnlineGameState } from './multiplayer';
import type { GameState } from '../types';

describe('online idle timer', () => {
  it('is 60 seconds', () => {
    expect(SELECTION_IDLE_MS).toBe(60_000);
    expect(selectionIdleSeconds()).toBe(60);
  });
});

describe('lobby invite guards', () => {
  it('blocks re-invite when pending or already in lobby', () => {
    expect(isAlreadyInvited('u1', new Set(['u1']), new Set())).toBe(true);
    expect(isAlreadyInvited('u1', new Set(), new Set(['u1']))).toBe(true);
    expect(isAlreadyInvited('u1', new Set(), new Set())).toBe(false);
  });

  it('disables Invite and labels Invited/Joined correctly', () => {
    const base = {
      toUid: 'guest',
      lobbyId: 'lobby-1',
      online: true,
      inGame: false,
      busy: false,
      pendingInviteUids: new Set<string>(),
      lobbyMemberUids: new Set<string>(),
    };
    expect(inviteButtonState(base)).toEqual({ disabled: false, label: 'Invite' });
    expect(
      inviteButtonState({ ...base, pendingInviteUids: new Set(['guest']) }),
    ).toEqual({ disabled: true, label: 'Invited' });
    expect(
      inviteButtonState({ ...base, lobbyMemberUids: new Set(['guest']) }),
    ).toEqual({ disabled: true, label: 'Joined' });
    expect(inviteButtonState({ ...base, lobbyId: null }).disabled).toBe(true);
    expect(inviteButtonState({ ...base, online: false }).disabled).toBe(true);
    expect(inviteButtonState({ ...base, inGame: true }).disabled).toBe(true);
  });
});

describe('aftermath city sections', () => {
  it('shows only my nation as Your cities online', () => {
    const turnOrder = ['russia', 'china', 'us', 'france', 'uk'];
    const mine = aftermathMyCityIds(turnOrder, () => true, 'russia');
    expect(mine).toEqual(['russia']);
    expect(aftermathWorldIds(turnOrder, mine)).toEqual([
      'china',
      'us',
      'france',
      'uk',
    ]);
  });

  it('falls back to all humans when myNationId unknown', () => {
    const turnOrder = ['russia', 'china', 'us'];
    const humans = new Set(['russia', 'china']);
    const mine = aftermathMyCityIds(turnOrder, (id) => humans.has(id), null);
    expect(mine).toEqual(['russia', 'china']);
    expect(aftermathWorldIds(turnOrder, mine)).toEqual(['us']);
  });
});

describe('phaseRank / pickFurtherState', () => {
  it('ranks later phases higher', () => {
    expect(phaseRank('roundSummary')).toBeGreaterThan(phaseRank('resolveStrikes'));
    expect(phaseRank('resolveStrikes')).toBeGreaterThan(phaseRank('buy'));
    expect(phaseRank('gameOver')).toBeGreaterThan(phaseRank('roundSummary'));
  });

  it('prefers higher round then further phase then AI progress', () => {
    const base = buildOnlineGameState(
      assignNations(['a', 'b']),
      { a: 'A', b: 'B' },
      'g-phase',
    );
    const r1Summary: GameState = {
      ...base,
      round: 1,
      phase: 'roundSummary',
      planningComplete: true,
      aiPlanningComplete: true,
    };
    const r1Resolve: GameState = {
      ...base,
      round: 1,
      phase: 'resolveStrikes',
      planningComplete: true,
      aiPlanningComplete: true,
    };
    const r2Buy: GameState = {
      ...base,
      round: 2,
      phase: 'buy',
      planningComplete: false,
      aiPlanningComplete: false,
    };
    const r2BuyAi: GameState = {
      ...r2Buy,
      aiPlanningComplete: true,
    };

    expect(pickFurtherState(r1Resolve, r1Summary).phase).toBe('roundSummary');
    expect(pickFurtherState(r1Summary, r2Buy).round).toBe(2);
    expect(pickFurtherState(r2Buy, r2BuyAi).aiPlanningComplete).toBe(true);
  });
});
