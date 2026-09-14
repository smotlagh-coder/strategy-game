import { useEffect, useMemo, useRef, useState } from 'react';
import { ART } from '../data/art';
import {
  createLobby,
  fetchGame,
  isPlayerOnline,
  joinLobby,
  leaveLobby,
  listenInvitesFor,
  listenLobby,
  listenPlayers,
  respondInvite,
  sendInvite,
  startOnlineGameFromLobby,
} from '../lib/multiplayer';
import { heartbeat, setPlayerStatus } from '../lib/session';
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

  useEffect(() => {
    const tick = () => {
      void heartbeat(uid, 'available');
    };
    tick();
    const t = window.setInterval(tick, 25_000);
    return () => window.clearInterval(t);
  }, [uid]);

  // Host + guests: when lobby gets a gameId, mark self in-game and enter
  useEffect(() => {
    const gameId = lobby?.gameId;
    if (!gameId || lobby?.status !== 'starting') return;
    if (joinedGameRef.current === gameId) return;

    let cancelled = false;
    void (async () => {
      try {
        await setPlayerStatus(uid, 'in_game', gameId);
        const game = await fetchGame(gameId);
        if (cancelled || !game?.state) return;
        joinedGameRef.current = gameId;
        onGameReady(gameId, game.state);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not join game');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // onGameReady is stable enough via parent; omit to avoid cancel/retry loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.gameId, lobby?.status, uid]);

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
      const id = await createLobby(uid, displayName);
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
      await sendInvite(uid, displayName, toUid, lobbyId);
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
        await joinLobby(data.lobbyId, uid, displayName);
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
      // Members (including host) enter via lobby.gameId listener
      await startOnlineGameFromLobby(lobby);
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
          Signed in as <strong>{displayName}</strong> · invite 1–4 others (2–5 total)
        </p>

        {error && <p className="session-error">{error}</p>}

        <div className="lobby-grid">
          <section className="lobby-panel">
            <h2>Players</h2>
            <ul className="lobby-list">
              {others.map((p) => (
                <li key={p.uid} className="lobby-row">
                  <span>
                    <strong>{p.data.displayName}</strong>
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
                        {lobby?.memberNames[id] ?? id}
                        {id === lobby?.hostUid ? ' (host)' : ''}
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
