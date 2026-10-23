import { useEffect, useRef, useState } from 'react';
import { ART } from '../data/art';
import { LAB_ROUNDS_PER_INVENTION, nationDef } from '../data/nations';
import { INVENTION_INFO, isTechKind } from '../game/inventions';
import { INVENTION_OVERLAY_MS } from '../lib/onlineConstants';
import type { InventionKind, NationId } from '../types';
import './InventionOverlay.css';

/** The sticker that stands for each invention in the arsenal. */
const STICKER: Record<InventionKind, string> = {
  cluster: ART.missileCluster,
  biological: ART.missileBiological,
  chemical: ART.missileChemical,
  defenseDrones: ART.drone,
  ballisticTech: ART.missile,
  aerospaceTech: ART.drone,
};

/**
 * Shown at the start of the round in which a nation's labs finished an invention: the
 * scientists' photograph full-screen, then what they built and what it does.
 */
export default function InventionOverlay({
  nationId,
  kind,
  round,
  onDone,
}: {
  nationId: NationId;
  kind: InventionKind;
  round: number;
  onDone: () => void;
}) {
  const info = INVENTION_INFO[kind];
  const [secondsLeft, setSecondsLeft] = useState(Math.round(INVENTION_OVERLAY_MS / 1000));
  // One fixed deadline, so a throttled tab or a re-render cannot stretch it
  const deadlineRef = useRef(Date.now() + INVENTION_OVERLAY_MS);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let done = false;
    const check = () => {
      const left = deadlineRef.current - Date.now();
      setSecondsLeft(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0 && !done) {
        done = true;
        onDoneRef.current();
      }
    };
    const tick = window.setInterval(check, 250);
    const end = window.setTimeout(check, INVENTION_OVERLAY_MS + 50);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(end);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  return (
    <div
      className="invention"
      role="dialog"
      aria-modal="true"
      aria-label={`Research breakthrough: ${info.name}`}
    >
      <img className="invention__photo" src={ART.invention[kind]} alt="" draggable={false} />
      <div className="invention__shade" aria-hidden />
      <div className="invention__flash" aria-hidden />

      <button type="button" className="btn dash__skip invention__skip" onClick={onDone}>
        <svg className="dash__ring" viewBox="0 0 36 36" aria-hidden>
          <circle className="dash__ring-track" cx="18" cy="18" r="15" />
          <circle
            className="dash__ring-value"
            cx="18"
            cy="18"
            r="15"
            style={{ animationDuration: `${INVENTION_OVERLAY_MS}ms` }}
          />
        </svg>
        <span className="dash__skip-count">{secondsLeft}</span>
        <span className="dash__skip-label">Skip</span>
      </button>

      <div className="invention__card enter-pop">
        <img className="invention__sticker" src={STICKER[kind]} alt="" draggable={false} />
        <div className="invention__copy">
          <p className="invention__eyebrow">
            Research breakthrough · {nationDef(nationId).name} · Round {round}
          </p>
          <h2 className="invention__title">{info.name}</h2>
          <p className="invention__headline">{info.headline}.</p>
          <p className="invention__effect">{info.effect}</p>
          <p className="invention__note">
            {isTechKind(kind)
              ? 'The technology is yours from this round, and the tech fee is waived.'
              : kind === 'defenseDrones'
                ? 'The drones are on standby over your cities.'
                : 'One is now in your arsenal.'}{' '}
            Keep a lab standing and paid, and your scientists deliver another every{' '}
            {LAB_ROUNDS_PER_INVENTION} rounds.
          </p>
        </div>
        <button type="button" className="btn btn--xl btn--primary invention__go" onClick={onDone}>
          To the arsenal
        </button>
      </div>
    </div>
  );
}
