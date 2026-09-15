export type InviteButtonLabel = 'Invite' | 'Invited' | 'Joined';

/** Short unique public code derived from the Firestore lobby id. */
export function lobbyCodeFromId(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return (compact.slice(0, 8) || 'LOBBY').padEnd(6, 'X');
}

/** Open, unused lobbies only — never join a started, closed, or leftover match. */
export function canJoinLobby(lobby: {
  status?: string | null;
  gameId?: string | null;
}): boolean {
  return lobby.status === 'open' && !lobby.gameId;
}

/** Only enter the game the host started for this lobby — never an older leftover match. */
export function pickLobbyMatchGame<T extends { id: string }>(
  games: T[],
  lobbyGameId: string | null | undefined,
): T | null {
  if (!lobbyGameId) return null;
  return games.find((g) => g.id === lobbyGameId) ?? null;
}

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
