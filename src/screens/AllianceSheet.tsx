import { useEffect, useRef, useState } from 'react';
import { ART } from '../data/art';
import { nationDef } from '../data/nations';
import {
  ALLIANCE_TRIBUTE,
  PACT_INCOME_SHARE,
  TALK_MAX_MS,
  type AllianceTalk,
  acceptAlliance,
  alliancePairs,
  allianceCandidates,
  allianceTalks,
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
  pactTerms,
  talksDone,
  tributeFrom,
} from '../game/alliance';
import { proposeAllianceWithReply } from '../game/allianceAi';
import { ALLIANCE_PHASE_MS } from '../lib/onlineConstants';
import { allScores, laserNetwork, totalWarheads } from '../game/engine';
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

/** The money side of an invitation or pact. `toMe` is $M a round flowing to the viewer. */
function TermsLine({ toMe, partner }: { toMe: number; partner: string }) {
  if (toMe === 0) return <p className="ally-money is-even">Even pact · no payments</p>;
  return (
    <p className={`ally-money ${toMe > 0 ? 'is-in' : 'is-out'}`}>
      <b>
        {toMe > 0 ? '+' : '−'}${Math.abs(toMe)}M
      </b>
      {toMe > 0 ? ` a round · ${partner} pays you` : ` a round · you pay ${partner}`}
      <i className="ally-cap"> · never over {Math.round(PACT_INCOME_SHARE * 100)}% of the payer’s income</i>
    </p>
  );
}

const PACT_TERMS = [
  'Allies never strike each other',
  'Laser cover for both nations',
  'Ballistic tech, aerospace tech and the spy service are shared automatically',
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

/** One offer on the table: what they bring, what it costs, and the two answers. */
function OfferBody({
  state,
  actorId,
  fromId,
  leaderArt,
  moreCount,
  onAccept,
  onDecline,
}: {
  state: GameState;
  actorId: NationId;
  fromId: NationId;
  leaderArt: (id: NationId) => string;
  moreCount: number;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const from = nationDef(fromId);
  const assets = allianceAssets(state, fromId, actorId);
  // The inviter's offer: positive means they pay the invitee
  const tributeOffered = allianceOf(state.nations[fromId]).tribute ?? 0;
  const current = allyOf(state, actorId);
  return (
    <>
      <div className="ally-card__head">
        <span className="ally-portrait">
          <img src={leaderArt(fromId)} alt="" draggable={false} />
        </span>
        <div>
          <small className="ally-kicker">Alliance offer</small>
          <h3>{from.name} wants to become your ally</h3>
        </div>
      </div>

      <p className="ally-sub">They bring</p>
      <AssetRow assets={assets} />

      <TermsLine toMe={tributeOffered} partner={from.shortName} />

      {current && (
        <p className="ally-money is-out">
          Accepting ends your alliance with {nationDef(current).name}
          {pactTerms(state, actorId, current)?.tribute ? ' and its payments' : ''}
        </p>
      )}

      <PactTerms />

      <div className="ally-actions">
        <button type="button" className="ally-btn ally-btn--yes" onClick={onAccept}>
          Accept
        </button>
        <button type="button" className="ally-btn ally-btn--no" onClick={onDecline}>
          Decline
        </button>
      </div>
      {moreCount > 0 && (
        <p className="ally-more">
          {moreCount} more offer{moreCount === 1 ? '' : 's'} waiting
        </p>
      )}
    </>
  );
}

const TALK_WORDS: Record<AllianceTalk['status'], string> = {
  pending: 'negotiating…',
  allied: 'now allies',
  declined: 'declined',
};

/**
 * The talks window: every invitation gets ten seconds. Offers to you come first;
 * when none of the talks are yours, it shows the rest of the table making pacts.
 * Closes early once everything is settled, but never before three seconds.
 */
export function AllianceTalks({
  state,
  actorId,
  keys,
  since,
  deadline,
  leaderArt,
  onAccept,
  onDecline,
  onClose,
  onExpire,
}: {
  state: GameState;
  actorId: NationId;
  /** The invitations that opened this window. */
  keys: string[];
  since: number;
  deadline: number;
  leaderArt: (id: NationId) => string;
  onAccept: (from: NationId) => void;
  onDecline: (from: NationId) => void;
  onClose: () => void;
  /** The clock ran out with something still open. */
  onExpire: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const talks = allianceTalks(state).filter((t) => keys.includes(t.key));
  const mine = talks.filter((t) => t.from === actorId || t.to === actorId);
  const waiting = incomingInvites(state, actorId);
  const anyPending = waiting.length > 0 || talks.some((t) => t.status === 'pending');
  const offer = waiting[0] ?? null;

  const done = talksDone(now, since, deadline, anyPending);
  useEffect(() => {
    if (!done) return;
    if (anyPending) onExpire();
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const left = Math.max(0, deadline - now);
  const share = Math.min(1, left / TALK_MAX_MS);
  const seconds = Math.ceil(left / 1000);
  const shown = (mine.length > 0 ? mine : talks).filter((t) => t.from !== offer || t.to !== actorId);
  const word = (t: AllianceTalk) => {
    if (t.to === actorId) {
      return t.status === 'allied'
        ? `You and ${nationDef(t.from).shortName} are allies`
        : t.status === 'declined'
          ? `You declined ${nationDef(t.from).shortName}`
          : `${nationDef(t.from).shortName} awaits your answer`;
    }
    if (t.from === actorId) {
      const them = nationDef(t.to).shortName;
      return t.status === 'allied'
        ? `${them} accepted — you are allies`
        : t.status === 'declined'
          ? `${them} declined`
          : `Waiting for ${them}…`;
    }
    return `${nationDef(t.from).shortName} + ${nationDef(t.to).shortName} · ${TALK_WORDS[t.status]}`;
  };

  return (
    <div className="ally-veil" role="dialog" aria-modal="true" aria-label="Alliance talks">
      <div className="ally-card ally-card--talks enter-pop">
        <div className="talk-clock" aria-label={`${seconds} seconds left`}>
          <span className="talk-clock__bar">
            <i style={{ width: `${share * 100}%` }} />
          </span>
          <b>{seconds}s</b>
        </div>

        {offer ? (
          <OfferBody
            state={state}
            actorId={actorId}
            fromId={offer}
            leaderArt={leaderArt}
            moreCount={waiting.length - 1}
            onAccept={() => onAccept(offer)}
            onDecline={() => onDecline(offer)}
          />
        ) : (
          <div className="ally-card__head">
            <img className="ally-card__icon" src={ART.cop.alliance} alt="" draggable={false} />
            <div>
              <small className="ally-kicker">Alliance talks</small>
              <h3>
                {mine.length > 0
                  ? 'Your alliance talks'
                  : 'Other nations are making alliances'}
              </h3>
            </div>
          </div>
        )}

        {shown.length > 0 && (
          <ul className="talk-list">
            {shown.map((t) => (
              <li key={t.key} className={`talk-row is-${t.status}`}>
                <span className="talk-faces">
                  <img src={leaderArt(t.from)} alt="" draggable={false} />
                  <img src={leaderArt(t.to)} alt="" draggable={false} />
                </span>
                <span>{word(t)}</span>
              </li>
            ))}
          </ul>
        )}
        {mine.length === 0 && (
          <p className="ally-sub">Pacts are public — know who stands together</p>
        )}
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
  phase,
}: {
  state: GameState;
  actorId: NationId;
  leaderArt: (id: NationId) => string;
  onOrder: (fn: (s: GameState) => GameState, label?: string) => void;
  onClose: () => void;
  /**
   * Set when this is the timed alliance desk that opens after the round briefing:
   * a clock runs down, and the desk closes itself when it hits zero.
   */
  phase?: { deadline: number };
}) {
  const [now, setNow] = useState(() => Date.now());
  const closedRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!phase) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= phase.deadline && !closedRef.current) {
        closedRef.current = true;
        closeRef.current();
      }
    };
    tick();
    const id = window.setInterval(tick, 200);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [phase?.deadline]);
  const left = phase ? Math.max(0, phase.deadline - now) : 0;
  const me = state.nations[actorId];
  const ally = allyOf(state, actorId);
  const invites = incomingInvites(state, actorId);
  const out = outgoingInvite(state, actorId);
  const candidates = allianceCandidates(state, actorId);
  const [terms, setTerms] = useState<Record<string, number>>({});
  // Weak, offer to pay for the help; strong, ask to be paid for yours
  const rows = allScores(state).filter((r) => !r.eliminated);
  const place = rows.findIndex((r) => r.nationId === actorId);
  const suggested =
    rows.length < 2 || place < 0
      ? 0
      : place / (rows.length - 1) >= 0.6
        ? ALLIANCE_TRIBUTE
        : place / (rows.length - 1) <= 0.34
          ? -ALLIANCE_TRIBUTE
          : 0;

  const inviteRows = (
    <>
      {invites.map((from) => (
              <article key={`in-${from}`} className="ally-row is-invite">
                <span className="ally-portrait ally-portrait--sm">
                  <img src={leaderArt(from)} alt="" draggable={false} />
                </span>
                <div className="ally-row__body">
                  <b>{nationDef(from).name} invited you</b>
                  <AssetRow assets={allianceAssets(state, from, actorId)} />
                  <TermsLine
                    toMe={allianceOf(state.nations[from]).tribute ?? 0}
                    partner={nationDef(from).shortName}
                  />
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
    </>
  );

  // The rest of the table, in the open: who stands together, and who is still talking
  const others = alliancePairs(state).filter(([a, b]) => a !== actorId && b !== actorId);
  const openTalks = allianceTalks(state).filter(
    (t) => t.status === 'pending' && t.from !== actorId && t.to !== actorId,
  );

  return (
    <div className="ally-veil" role="dialog" aria-modal="true" aria-label="Alliance">
      <div className={`ally-card ally-card--sheet enter-pop${phase ? ' ally-card--phase' : ''}`}>
        {phase ? (
          <div className="talk-clock" aria-label={`${Math.ceil(left / 1000)} seconds left`}>
            <span className="talk-clock__bar">
              <i style={{ width: `${Math.min(100, (left / ALLIANCE_PHASE_MS) * 100)}%` }} />
            </span>
            <b>{Math.ceil(left / 1000)}s</b>
          </div>
        ) : (
          <button type="button" className="ally-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
        <div className="ally-card__head">
          <img className="ally-card__icon" src={ART.cop.alliance} alt="" draggable={false} />
          <div>
            <small className="ally-kicker">
              {phase ? `Round ${state.round} · alliance talks` : 'Finance & Intel'}
            </small>
            <h3>{ally ? `Allied with ${nationDef(ally).name}` : 'Alliance'}</h3>
          </div>
        </div>

        {ally && invites.length > 0 && (
          <>
            <p className="ally-sub">Offers to switch</p>
            {inviteRows}
          </>
        )}

        {ally ? (
          <AllyPanel
            state={state}
            actorId={actorId}
            allyId={ally}
            leaderArt={leaderArt}
            onLeave={() => {
              onOrder((s) => leaveAlliance(s, actorId));
            }}
          />
        ) : (
          <>
            {candidates.length === 0 ? (
              <p className="ally-empty">Nobody else is left standing to ally with.</p>
            ) : (
              <p className="ally-sub">
                Pick the partner who completes you — players and AI nations alike
              </p>
            )}

            {inviteRows}


            {candidates
              .filter((id) => !invites.includes(id))
              .map((id) => {
                const blocked = inviteBlockedReason(state, actorId, id);
                const mine = out?.to === id ? out : null;
                const pending = mine && !mine.declined;
                const chosen = terms[id] ?? 0;
                const taken = allyOf(state, id);
                const takenName = taken ? nationDef(taken).shortName : null;
                return (
                  <article key={id} className="ally-row">
                    <span className="ally-portrait ally-portrait--sm">
                      <img src={leaderArt(id)} alt="" draggable={false} />
                    </span>
                    <div className="ally-row__body">
                      <b>
                        {nationDef(id).name}
                        {!state.nations[id].isHuman && <i className="ally-ai">AI</i>}
                      </b>
                      <AssetRow assets={allianceAssets(state, id, actorId)} />
                      {takenName && (
                        <p className="ally-money is-even">
                          Allied with {takenName} · saying yes ends that alliance
                        </p>
                      )}
                      {!pending && (
                        <div className="ally-terms-pick" role="radiogroup" aria-label="Money terms">
                          {(
                            [
                              [0, 'Even'],
                              [ALLIANCE_TRIBUTE, `I pay $${ALLIANCE_TRIBUTE}M a round`],
                              [-ALLIANCE_TRIBUTE, `I ask $${ALLIANCE_TRIBUTE}M a round`],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={chosen === value}
                              className={`ally-chip${chosen === value ? ' is-on' : ''}${
                                suggested === value && value !== 0 ? ' is-suggested' : ''
                              }`}
                              onClick={() => setTerms((t) => ({ ...t, [id]: value }))}
                            >
                              {label}
                              {suggested === value && value !== 0 && <small>suggested</small>}
                            </button>
                          ))}
                        </div>
                      )}
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
                              onOrder(
                                (s) => proposeAllianceWithReply(s, id, actorId, chosen),
                                'Alliance invitation sent',
                              )
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
        {phase && (others.length > 0 || openTalks.length > 0) && (
          <>
            <p className="ally-sub">Across the table</p>
            <ul className="talk-list">
              {others.map(([a, b]) => (
                <li key={`pair-${a}-${b}`} className="talk-row is-allied">
                  <span className="talk-faces">
                    <img src={leaderArt(a)} alt="" draggable={false} />
                    <img src={leaderArt(b)} alt="" draggable={false} />
                  </span>
                  <span>
                    {nationDef(a).shortName} + {nationDef(b).shortName} · allies
                  </span>
                </li>
              ))}
              {openTalks.map((t) => (
                <li key={t.key} className="talk-row is-pending">
                  <span className="talk-faces">
                    <img src={leaderArt(t.from)} alt="" draggable={false} />
                    <img src={leaderArt(t.to)} alt="" draggable={false} />
                  </span>
                  <span>
                    {nationDef(t.from).shortName} + {nationDef(t.to).shortName} · negotiating…
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {phase && (
          <div className="ally-actions">
            <button type="button" className="ally-btn ally-btn--yes ally-done" onClick={onClose}>
              Done · start ordering
            </button>
          </div>
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
  onLeave,
}: {
  state: GameState;
  actorId: NationId;
  allyId: NationId;
  leaderArt: (id: NationId) => string;
  onLeave: () => void;
}) {
  const me = state.nations[actorId];
  const ally = state.nations[allyId];
  const allyName = nationDef(allyId).name;

  /** Tech and the spy service pass between allies on their own; this only shows who brings what. */
  const shareRow = (
    key: string,
    art: string,
    label: string,
    mine: boolean,
    theirs: boolean,
  ) => (
    <div className={`ally-share${mine || theirs ? ' is-live' : ''}`} key={key}>
      <img src={art} alt="" draggable={false} />
      <div>
        <b>{label}</b>
        <small>
          {mine && theirs
            ? `You both have it`
            : theirs
              ? `${allyName} shares it with you`
              : mine
                ? `Shared with ${allyName}`
                : 'Shared as soon as either of you unlocks it'}
        </small>
      </div>
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
      <TermsLine
        toMe={pactTerms(state, actorId, allyId) ? -tributeFrom(state, actorId) : 0}
        partner={nationDef(allyId).shortName}
      />

      <div className="ally-shares">
        {shareRow('ballistic', ART.cop.ballisticTech, 'Ballistic tech', me.hasNuclearTech, ally.hasNuclearTech)}
        {shareRow('aerospace', ART.cop.aerospaceTech, 'Aerospace tech', me.hasAerospaceTech, ally.hasAerospaceTech)}
        {shareRow('spy', ART.cop.spy, 'Spy service', me.hasSpyNetwork, ally.hasSpyNetwork)}
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
