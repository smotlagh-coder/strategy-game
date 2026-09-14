import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ART } from '../data/art';
import {
  createLobby,
  fetchGame,
  isPlayerOnline,
  joinLobby,
  leaveLobby,
  listenInvitesFor,
  listenLobby,
  listenMyActiveGames,
  listenPlayers,
  respondInvite,
  sendInvite,
  startOnlineGameFromLobby,
} from '../lib/multiplayer';
import { heartbeat, formatPlayerLabel, setPlayerStatus, shortPlayerId } from '../lib/session';
import type { GameState, InviteDoc, OnlineLobby, PlayerDoc } from '../types';

export function LobbyScreen({
  uid,
  displayName,
  onBack,
  onGameReady,
  onOpenLeaderboard,
}: {
  uid: string;
  displayName: string;
  onBack: () => void;
  onGameReady: (gameId: string, state: GameState) => void;
  onOpenLeaderboard: () => void;
}) {
  const [players, setPlayers] = useState<{ uid: string; data: PlayerDoc }[]>([]);
  const [invites, setInvites] = useState<{ id: string; data: InviteDoc }[]>([]);
  const [lobbyId, setLobbyId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<OnlineLobby | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinedGameRef = useRef<string | null>(null);
  const onGameReadyRef = useRef(onGameReady);
  onGameReadyRef.current = onGameReady;

  const enterGame = useCallback(
    async (gameId: string, prefetched?: GameState) => {
      if (joinedGameRef.current === gameId) return;
      joinedGameRef.current = gameId;
      try {
        await setPlayerStatus(uid, 'in_game', gameId);
        const state =
          prefetched ??
          (await fetchGame(gameId).then((g) => g?.state ?? null));
        if (!state) {
          joinedGameRef.current = null;
          setError('Game not found');
          return;
        }
        onGameReadyRef.current(gameId, { ...state, onlineGameId: gameId });
      } catch (e) {
        joinedGameRef.current = null;
        setError(e instanceof Error ? e.message : 'Could not join game');
      }
    },
    [uid],
  );

  useEffect(() => {
    const unsub = listenPlayers(setPlayers);
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = listenInvitesFor(uid, setInvites);
    return unsub;
  }, [uid]);

  useEffect(() => {
    if (!lobbyId) {
      setLobby(null);
      return;
    }
    return listenLobby(lobbyId, setLobby);
  }, [lobbyId]);

  // Primary path for guests: watch games that include this player
  useEffect(() => {
    if (!lobbyId) return;
    return listenMyActiveGames(uid, (games) => {
      const linked = lobby?.gameId
        ? games.find((g) => g.id === lobby.gameId)
        : undefined;
      const fresh = [...games]
        .filter((g) => Date.now() - (g.data.updatedAt ?? 0) < 120_000)
        .sort((a, b) => (b.data.updatedAt ?? 0) - (a.data.updatedAt ?? 0))[0];
      const pick = linked ?? fresh;
      if (!pick) return;
      void enterGame(pick.id, pick.data.state);
    });
  }, [uid, lobbyId, lobby?.gameId, enterGame]);

  // Backup: lobby document got gameId (host start)
  useEffect(() => {
    const gameId = lobby?.gameId;
    if (!gameId) return;
    if (lobby?.status !== 'starting' && lobby?.status !== 'closed') return;
    void enterGame(gameId);
  }, [lobby?.gameId, lobby?.status, enterGame]);

  useEffect(() => {
    // Don't clobber in_game while a match is starting / joining
    if (lobby?.gameId || joinedGameRef.current) return;
    const tick = () => {
      void heartbeat(uid, 'available');
    };
    tick();
    const t = window.setInterval(tick, 25_000);
    return () => window.clearInterval(t);
  }, [uid, lobby?.gameId]);

  const others = useMemo(() => {
    const now = Date.now();
    return players
      .filter((p) => p.uid !== uid)
      .map((p) => ({
        ...p,
        online: isPlayerOnline(p.data, now),
      }))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.data.displayName.localeCompare(b.data.displayName);
      });
  }, [players, uid]);

  const startHostLobby = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await createLobby(uid, formatPlayerLabel(displayName, uid));
      setLobbyId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create lobby');
    } finally {
      setBusy(false);
    }
  };

  const invite = async (toUid: string) => {
    if (!lobbyId) {
      setError('Create a lobby first, then invite players');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendInvite(uid, formatPlayerLabel(displayName, uid), toUid, lobbyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setBusy(false);
    }
  };

  const onAccept = async (inviteId: string, data: InviteDoc) => {
    setBusy(true);
    setError(null);
    try {
      await respondInvite(inviteId, true);
      if (data.lobbyId) {
        await joinLobby(data.lobbyId, uid, formatPlayerLabel(displayName, uid));
        setLobbyId(data.lobbyId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join');
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    if (!lobby) return;
    setBusy(true);
    setError(null);
    try {
      const { gameId, state } = await startOnlineGameFromLobby(lobby);
      await enterGame(gameId, state);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  };

  const onLeave = async () => {
    if (lobbyId) await leaveLobby(lobbyId, uid);
    setLobbyId(null);
  };

  return (
    <div className="screen screen--splash">
      <div className="map-backdrop" style={{ backgroundImage: `url(${ART.map})` }} aria-hidden />
      <div className="splash-veil" />
      <div className="splash-content splash-content--wide lobby-screen">
        <h1 className="stencil-title">ONLINE LOBBY</h1>
        <p className="tagline">
          Signed in as <strong>{formatPlayerLabel(displayName, uid)}</strong> · invite 1–4
          others (2–5 total)
        </p>

        {error && <p className="session-error">{error}</p>}

        <div className="lobby-grid">
          <section className="lobby-panel">
            <h2>Players</h2>
            <ul className="lobby-list">
              {others.map((p) => (
                <li key={p.uid} className="lobby-row">
                  <span>
                    <strong>{formatPlayerLabel(p.data.displayName, p.uid)}</strong>
                    <small className="player-id-tag">{shortPlayerId(p.uid)}</small>
                    <small
                      className={
                        p.data.status === 'in_game'
                          ? 'status-ingame'
                          : p.online
                            ? 'status-available'
                            : 'status-offline'
                      }
                    >
                      {p.data.status === 'in_game'
                        ? 'In game'
                        : p.online
                          ? 'Available'
                          : 'Offline'}
                    </small>
                  </span>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !p.online || p.data.status === 'in_game' || !lobbyId}
                    onClick={() => void invite(p.uid)}
                  >
                    Invite
                  </button>
                </li>
              ))}
              {others.length === 0 && <li className="lobby-empty">No other players yet</li>}
            </ul>
          </section>

          <section className="lobby-panel">
            <h2>Your lobby</h2>
            {!lobbyId ? (
              <button className="btn btn--xl btn--primary" type="button" disabled={busy} onClick={() => void startHostLobby()}>
                Create Lobby
              </button>
            ) : (
              <>
                <ul className="lobby-list">
                  {(lobby?.memberUids ?? []).map((id) => (
                    <li key={id} className="lobby-row">
                      <strong>
                        {lobby?.memberNames[id] ?? formatPlayerLabel('Commander', id)}
                        {id === lobby?.hostUid ? ' (host)' : ''}
                        {id === uid ? ' · you' : ''}
                      </strong>
                    </li>
                  ))}
                </ul>
                <div className="lobby-actions">
                  {lobby?.hostUid === uid && (
                    <button
                      className="btn btn--xl btn--primary"
                      type="button"
                      disabled={busy || (lobby?.memberUids.length ?? 0) < 2 || Boolean(lobby?.gameId)}
                      onClick={() => void onStart()}
                    >
                      Start Game ({lobby?.memberUids.length ?? 0}/5)
                    </button>
                  )}
                  <button className="btn btn--xl" type="button" onClick={() => void onLeave()}>
                    Leave Lobby
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="lobby-panel">
            <h2>Invites</h2>
            <ul className="lobby-list">
              {invites.map((inv) => (
                <li key={inv.id} className="lobby-row">
                  <span>
                    From <strong>{inv.data.fromName}</strong>
                  </span>
                  <span className="lobby-invite-actions">
                    <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void onAccept(inv.id, inv.data)}>
                      Accept
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => void respondInvite(inv.id, false)}>
                      Decline
                    </button>
                  </span>
                </li>
              ))}
              {invites.length === 0 && <li className="lobby-empty">No pending invites</li>}
            </ul>
          </section>
        </div>

        <div className="lobby-footer">
          <button className="btn btn--xl" type="button" onClick={onOpenLeaderboard}>
            Leaderboard
          </button>
          <button className="btn btn--xl" type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
