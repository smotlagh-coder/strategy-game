import { useEffect, useState } from 'react';
import { ART } from '../data/art';
import { listenLeaderboard } from '../lib/multiplayer';

export function LeaderboardScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<{ uid: string; displayName: string; superpowerWins: number }[]>([]);

  useEffect(() => listenLeaderboard(setRows), []);

  return (
    <div className="screen screen--splash">
      <div className="map-backdrop" style={{ backgroundImage: `url(${ART.map})` }} aria-hidden />
      <div className="splash-veil" />
      <div className="splash-content">
        <h1 className="stencil-title">SUPERPOWERS</h1>
        <p className="tagline">Most times crowned the superpower</p>
        <ol className="leaderboard-list">
          {rows.map((r, i) => (
            <li key={r.uid}>
              <span>
                #{i + 1} {r.displayName}
              </span>
              <strong>{r.superpowerWins}</strong>
            </li>
          ))}
          {rows.length === 0 && <li className="lobby-empty">No wins recorded yet</li>}
        </ol>
        <button className="btn btn--xl btn--primary" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
