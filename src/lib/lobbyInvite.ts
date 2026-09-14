export type InviteButtonLabel = 'Invite' | 'Invited' | 'Joined';

export function isAlreadyInvited(
  toUid: string,
  pendingInviteUids: ReadonlySet<string>,
  lobbyMemberUids: ReadonlySet<string>,
): boolean {
  return pendingInviteUids.has(toUid) || lobbyMemberUids.has(toUid);
}

/** UI state for the lobby Invite button. */
export function inviteButtonState(opts: {
  toUid: string;
  lobbyId: string | null;
  online: boolean;
  inGame: boolean;
  busy: boolean;
  pendingInviteUids: ReadonlySet<string>;
  lobbyMemberUids: ReadonlySet<string>;
}): { disabled: boolean; label: InviteButtonLabel } {
  const alreadyInLobby = opts.lobbyMemberUids.has(opts.toUid);
  const alreadyInvited = opts.pendingInviteUids.has(opts.toUid);
  const inviteBlocked = alreadyInLobby || alreadyInvited;
  return {
    disabled:
      opts.busy ||
      !opts.online ||
      opts.inGame ||
      !opts.lobbyId ||
      inviteBlocked,
    label: alreadyInLobby ? 'Joined' : alreadyInvited ? 'Invited' : 'Invite',
  };
}

/** Which nation ids to show under "Your cities" on round aftermath. */
export function aftermathMyCityIds(
  turnOrder: string[],
  isHuman: (id: string) => boolean,
  myNationId: string | null,
): string[] {
  if (myNationId) return [myNationId];
  return turnOrder.filter((id) => isHuman(id));
}

/** Everyone else on the aftermath world board. */
export function aftermathWorldIds(
  turnOrder: string[],
  myCityIds: string[],
): string[] {
  const mine = new Set(myCityIds);
  return turnOrder.filter((id) => !mine.has(id));
}
