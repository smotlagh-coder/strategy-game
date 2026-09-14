import { useState } from 'react';
import { ART } from '../data/art';
import { formatPlayerLabel, shortPlayerId } from '../lib/session';

export function NameGate({
  initialName,
  playerUid,
  onSubmit,
  onResetIdentity,
  error,
  loading,
}: {
  initialName: string;
  /** Firebase auth uid — shown so two browsers aren't confused */
  playerUid?: string | null;
  onSubmit: (name: string) => void;
  onResetIdentity?: () => void;
  error?: string | null;
  loading?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const preview =
    playerUid && name.trim()
      ? formatPlayerLabel(name.trim(), playerUid)
      : playerUid
        ? `Commander · ${shortPlayerId(playerUid)}`
        : null;

  return (
    <div className="screen screen--splash">
      <div
        className="map-backdrop"
        style={{ backgroundImage: `url(${ART.map})` }}
        aria-hidden
      />
      <div className="splash-veil" />
      <div className="splash-content">
        <h1 className="stencil-title title-glow">NUCLEAR WAR</h1>
        <p className="tagline">Enter your commander name to begin</p>
        <form
          className="session-form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed) onSubmit(trimmed);
          }}
        >
          <label className="names-field">
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              placeholder="Commander"
              autoFocus
              disabled={loading}
            />
          </label>
          {preview && (
            <p className="session-id-hint">
              Player ID: <code>{shortPlayerId(playerUid!)}</code>
              <br />
              Others see you as <strong>{preview}</strong>
            </p>
          )}
          {error && <p className="session-error">{error}</p>}
          <button className="btn btn--xl btn--primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Connecting…' : 'Continue'}
          </button>
          {onResetIdentity && (
            <button
              className="btn btn--xl"
              type="button"
              disabled={loading}
              onClick={onResetIdentity}
            >
              New player ID
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
