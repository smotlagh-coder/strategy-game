import { useState } from 'react';
import { ART } from '../data/art';

export function NameGate({
  initialName,
  onSubmit,
  error,
  loading,
}: {
  initialName: string;
  onSubmit: (name: string) => void;
  error?: string | null;
  loading?: boolean;
}) {
  const [name, setName] = useState(initialName);

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
          {error && <p className="session-error">{error}</p>}
          <button className="btn btn--xl btn--primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Connecting…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
