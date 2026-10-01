import { ART } from '../data/art';
import { nationDef } from '../data/nations';
import {
  acceptAlliance,
  allianceCandidates,
  allianceOf,
  allyOf,
  declineAlliance,
  hasAerospaceAccess,
  hasBallisticTech,
  hasSpyService,
  incomingInvites,
  inviteBlockedReason,
  leaveAlliance,
  outgoingInvite,
  proposeAlliance,
  setTechSharing,
} from '../game/alliance';
import { laserNetwork, totalWarheads } from '../game/engine';
import type { GameState, NationId } from '../types';

/** One thing a nation puts on the table. */
export interface Asset {
  key: string;
  art: string;
  label: string;
  /** How many, for stocks and buildings. */
  count?: number;
  /** The viewer has nothing like it — what makes this partner worth having. */
  fresh?: boolean;
  /** The viewer already owns this one. */
  have?: boolean;
}

/**
 * What `nationId` would bring to a pact with `viewerId`, each item marked when
 * it fills a gap the viewer has (or repeats something they already own).
 */
export function allianceAssets(state: GameState, nationId: NationId, viewerId: NationId): Asset[] {
  const n = state.nations[nationId];
  const alive = n.cities.filter((c) => !c.destroyed);
  const items: Asset[] = [];
  const flag = (key: string, art: string, label: string, theirs: boolean, mine: boolean) => {
    if (theirs) items.push({ key, art, label, fresh: !mine, have: mine });
  };
  const stock = (key: string, art: string, label: string, count: number) => {
    if (count > 0) items.push({ key, art, label, count });
  };

  flag('spy', ART.cop.spy, 'Spy services', Boolean(n.hasSpyNetwork), hasSpyService(state, viewerId));
  flag(
    'laser',
    ART.cop.laser,
    'Laser defence',
    laserNetwork(state, nationId),
    laserNetwork(state, viewerId),
  );
  flag(
    'aerospace',
    ART.cop.aerospaceTech,
    'Aerospace tech',
    n.hasAerospaceTech,
    hasAerospaceAccess(state, viewerId),
  );
  flag(
    'ballistic',
    ART.cop.ballisticTech,
    'Ballistic tech',
    n.hasNuclearTech,
    hasBallisticTech(state, viewerId),
  );
  stock('drones', ART.cop.drone, 'Drone packs', n.drones);
  stock('warheads', ART.missile, 'Warheads', totalWarheads(n));
  stock('shields', ART.cop.shield, 'Shields', alive.filter((c) => c.hasShield).length);
  stock('bunkers', ART.cop.bunker, 'Bunkers', alive.filter((c) => c.isUnderground).length);
  stock('labs', ART.cop.research, 'Research', alive.filter((c) => c.hasResearch).length);
  return items;
}

function AssetRow({ assets }: { assets: Asset[] }) {
  if (assets.length === 0) {
    return <p className="ally-empty">Fresh from the start line: cities and an open treasury.</p>;
  }
  return (
    <ul className="ally-assets">
      {assets.map((a) => (
        <li key={a.key} className={`ally-asset${a.fresh ? ' is-fresh' : ''}${a.have ? ' is-have' : ''}`}>
          <span className="ally-asset__art">
            <img src={a.art} alt="" draggable={false} />
            {a.count != null && <em>{a.count}</em>}
          </span>
          <b>{a.label}</b>
          {a.fresh && <small className="ally-asset__tag">New for you</small>}
          {a.have && <small className="ally-asset__tag is-dim">You have it</small>}
        </li>
      ))}
    </ul>
  );
}

const PACT_TERMS = [
  'Allies never strike each other',
  'Laser cover for both nations',
  'Spy service shared free',
  'One sanction each, enforced by both',
  'Pair drones with an ally’s bombs; the kill is shared',
  'Leave any round',
];

function PactTerms() {
  return (
    <ul className="ally-terms">
      {PACT_TERMS.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

/** The pop-up shown when another nation asks to become your ally. */
export function AllianceInvite({
  state,
  actorId,
  fromId,
  leaderArt,
  moreCount,
  onAccept,
  onDecline,
  onLater,
}: {
  state: GameState;
  actorId: NationId;
  fromId: NationId;
  leaderArt: (id: NationId) => string;
  moreCount: number;
  onAccept: () => void;
  onDecline: () => void;
  onLater: () => void;
}) {
  const from = nationDef(fromId);
  const assets = allianceAssets(state, fromId, actorId);
  return (
    <div className="ally-veil" role="dialog" aria-modal="true" aria-label={`${from.name} proposes an alliance`}>
      <div className="ally-card ally-card--invite enter-pop">
        <div className="ally-card__head">
          <span className="ally-portrait">
            <img src={leaderArt(fromId)} alt="" draggable={false} />
          </span>
          <div>
            <small className="ally-kicker">Alliance offer</small>
            <h3>
              {from.name} wants to become your ally
            </h3>
          </div>
        </div>

        <p className="ally-sub">They bring</p>
        <AssetRow assets={assets} />

        <PactTerms />

        <div className="ally-actions">
          <button type="button" className="ally-btn ally-btn--yes" onClick={onAccept}>
            Accept
          </button>
          <button type="button" className="ally-btn ally-btn--no" onClick={onDecline}>
            Decline
          </button>
        </div>
        <button type="button" className="cop-link ally-later" onClick={onLater}>
          Decide later{moreCount > 0 ? ` · ${moreCount} more offer${moreCount === 1 ? '' : 's'}` : ''}
        </button>
      </div>
    </div>
  );
}

/** The alliance desk: invite a partner, or run the pact you have. */
export function AllianceSheet({
  state,
  actorId,
  leaderArt,
  onOrder,
  onClose,
}: {
  state: GameState;
  actorId: NationId;
  leaderArt: (id: NationId) => string;
  onOrder: (fn: (s: GameState) => GameState, label?: string) => void;
  onClose: () => void;
}) {
  const me = state.nations[actorId];
  const ally = allyOf(state, actorId);
  const invites = incomingInvites(state, actorId);
  const out = outgoingInvite(state, actorId);
  const candidates = allianceCandidates(state, actorId);

  return (
    <div className="ally-veil" role="dialog" aria-modal="true" aria-label="Alliance">
      <div className="ally-card ally-card--sheet enter-pop">
        <button type="button" className="ally-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="ally-card__head">
          <img className="ally-card__icon" src={ART.cop.alliance} alt="" draggable={false} />
          <div>
            <small className="ally-kicker">Finance &amp; Intel</small>
            <h3>{ally ? `Allied with ${nationDef(ally).name}` : 'Alliance'}</h3>
          </div>
        </div>

        {ally ? (
          <AllyPanel
            state={state}
            actorId={actorId}
            allyId={ally}
            leaderArt={leaderArt}
            onOrder={onOrder}
            onLeave={() => {
              onOrder((s) => leaveAlliance(s, actorId));
            }}
          />
        ) : (
          <>
            {!state.nations[actorId] || candidates.length === 0 ? (
              <p className="ally-empty">
                Alliances are made between players — invite a friend into a match to team up.
              </p>
            ) : (
              <p className="ally-sub">
                Pick the partner who completes you — their assets, at a glance
              </p>
            )}

            {invites.map((from) => (
              <article key={`in-${from}`} className="ally-row is-invite">
                <span className="ally-portrait ally-portrait--sm">
                  <img src={leaderArt(from)} alt="" draggable={false} />
                </span>
                <div className="ally-row__body">
                  <b>{nationDef(from).name} invited you</b>
                  <AssetRow assets={allianceAssets(state, from, actorId)} />
                </div>
                <div className="ally-row__acts">
                  <button
                    type="button"
                    className="ally-btn ally-btn--yes"
                    onClick={() => onOrder((s) => acceptAlliance(s, from, actorId))}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="ally-btn ally-btn--no"
                    onClick={() => onOrder((s) => declineAlliance(s, from, actorId))}
                  >
                    Decline
                  </button>
                </div>
              </article>
            ))}

            {candidates
              .filter((id) => !invites.includes(id))
              .map((id) => {
                const blocked = inviteBlockedReason(state, actorId, id);
                const mine = out?.to === id ? out : null;
                const pending = mine && !mine.declined;
                return (
                  <article key={id} className="ally-row">
                    <span className="ally-portrait ally-portrait--sm">
                      <img src={leaderArt(id)} alt="" draggable={false} />
                    </span>
                    <div className="ally-row__body">
                      <b>{nationDef(id).name}</b>
                      <AssetRow assets={allianceAssets(state, id, actorId)} />
                    </div>
                    <div className="ally-row__acts">
                      {pending ? (
                        <>
                          <span className="ally-state">Invitation sent</span>
                          <button
                            type="button"
                            className="ally-btn ally-btn--no"
                            onClick={() => onOrder((s) => leaveAlliance(s, actorId))}
                          >
                            Withdraw
                          </button>
                        </>
                      ) : (
                        <>
                          {mine?.declined && <span className="ally-state is-no">Declined</span>}
                          <button
                            type="button"
                            className="ally-btn ally-btn--yes"
                            disabled={Boolean(blocked)}
                            title={blocked ?? undefined}
                            onClick={() =>
                              onOrder((s) => proposeAlliance(s, id, actorId), 'Alliance invitation sent')
                            }
                          >
                            {mine?.declined ? 'Invite again' : 'Invite'}
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            <PactTerms />
          </>
        )}
        {me.eliminated && <p className="ally-empty">Your nation has fallen.</p>}
      </div>
    </div>
  );
}

function AllyPanel({
  state,
  actorId,
  allyId,
  leaderArt,
  onOrder,
  onLeave,
}: {
  state: GameState;
  actorId: NationId;
  allyId: NationId;
  leaderArt: (id: NationId) => string;
  onOrder: (fn: (s: GameState) => GameState, label?: string) => void;
  onLeave: () => void;
}) {
  const me = state.nations[actorId];
  const mine = allianceOf(me);
  const theirs = allianceOf(state.nations[allyId]);
  const ally = state.nations[allyId];
  const allyName = nationDef(allyId).name;

  const shareRow = (
    kind: 'ballistic' | 'aerospace',
    art: string,
    label: string,
    owned: boolean,
    on: boolean,
    theyShare: boolean,
  ) => (
    <div className="ally-share" key={kind}>
      <img src={art} alt="" draggable={false} />
      <div>
        <b>{label}</b>
        <small>
          {theyShare
            ? `${allyName} shares it with you`
            : owned
              ? on
                ? `You share it with ${allyName}`
                : `Hand it to ${allyName}`
              : 'Not unlocked yet'}
        </small>
      </div>
      {owned && (
        <button
          type="button"
          className={`ally-switch${on ? ' is-on' : ''}`}
          role="switch"
          aria-checked={on}
          aria-label={`Share ${label} with ${allyName}`}
          onClick={() => onOrder((s) => setTechSharing(s, actorId, kind, !on))}
        >
          <i />
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="ally-pair">
        <span className="ally-portrait">
          <img src={leaderArt(actorId)} alt="" draggable={false} />
        </span>
        <img className="ally-pair__knot" src={ART.cop.alliance} alt="" draggable={false} />
        <span className="ally-portrait">
          <img src={leaderArt(allyId)} alt="" draggable={false} />
        </span>
      </div>

      <p className="ally-sub">{allyName} brings</p>
      <AssetRow assets={allianceAssets(state, allyId, actorId)} />

      <div className="ally-shares">
        {shareRow(
          'ballistic',
          ART.cop.ballisticTech,
          'Ballistic tech',
          me.hasNuclearTech,
          mine.shareBallistic,
          theirs.shareBallistic && ally.hasNuclearTech,
        )}
        {shareRow(
          'aerospace',
          ART.cop.aerospaceTech,
          'Aerospace tech',
          me.hasAerospaceTech,
          mine.shareAerospace,
          theirs.shareAerospace && ally.hasAerospaceTech,
        )}
      </div>

      <PactTerms />
      <div className="ally-actions">
        <button type="button" className="ally-btn ally-btn--no" onClick={onLeave}>
          Leave alliance
        </button>
      </div>
    </>
  );
}
