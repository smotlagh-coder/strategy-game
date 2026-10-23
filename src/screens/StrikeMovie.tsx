import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import './StrikeMovie.css';
import StrikeGlobe from './StrikeGlobe';
import { PLATE_FLAGS } from '../data/plateFlags';
import { ART, SFX } from '../data/art';
import { nationDef } from '../data/nations';
import {
  arsenalOf,
  buildShots,
  cinemaCaption,
  isBallisticWeapon,
  MOVIE_PACE,
  movieCraft,
  movieTitle,
  outcomeLine,
  targetOutcome,
  targetTimeline,
  type MovieShot,
  type StrikeShow,
  type StrikeTarget,
} from '../game/movie';
import type { NationId, StrikeWeapon } from '../types';

type Sfx = (src: string, volume?: number, rate?: number) => void;

interface MovieProps {
  strike: StrikeShow;
  leaderSrc: (id: NationId) => string;
  sfx: Sfx;
  onComplete: () => void;
  /** Present when more films wait behind this one: drop them all and go to the summary */
  onSkipAll?: () => void;
}

const WEAPON_LABEL: Record<StrikeWeapon, string> = {
  nuke: 'Nuclear',
  hydrogen: 'Hydrogen',
  magnetic: 'Magnetic',
  cluster: 'Cluster',
  biological: 'Biological',
  chemical: 'Chemical',
  drone: 'Drone swarm',
  commando: 'Heliborne',
};

const UNITLESS = new Set(['--n', '--i', '--p', '--shake']);

/** CSS custom properties are not in CSSProperties; one cast keeps the call sites tidy. */
function vars(values: Record<string, string | number>): CSSProperties {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, typeof v === 'number' && !UNITLESS.has(k) ? `${v}ms` : v]),
  ) as CSSProperties;
}

/** How many times slower than storyboard speed the current shot plays */
const PaceContext = createContext(MOVIE_PACE);

/** Schedule sound cues for a shot; every timer dies with the shot. */
function useCues(cues: { at: number; run: () => void }[]) {
  const pace = useContext(PaceContext);
  const ref = useRef(cues);
  ref.current = cues;
  useEffect(() => {
    const timers = ref.current.map((cue) => window.setTimeout(cue.run, cue.at * pace));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
}

/* ───────────────────────── Shot 1: the title card ───────────────────────── */

function TitleShot({
  strike,
  ms,
  leaderSrc,
}: {
  strike: StrikeShow;
  ms: number;
  leaderSrc: (id: NationId) => string;
}) {
  const from = nationDef(strike.from);
  const arsenal = arsenalOf(strike);
  return (
    <section className="mv-shot mv-title" style={vars({ '--ms': ms })}>
      <div className="mv-flagbg" style={{ backgroundImage: `url(${ART.flags[strike.from]})` }} />
      <div className="mv-title__body">
        <p className="mv-title__kicker">Strike order</p>
        <div className="mv-portrait">
          <img src={leaderSrc(strike.from)} alt="" draggable={false} />
        </div>
        <h2 className="mv-title__nation">{from.name}</h2>
        <p className="mv-title__leader">{from.leader}</p>
        <ul className="mv-arsenal" aria-label="Weapons">
          {arsenal.map((a, i) => (
            <li key={a.weapon} style={vars({ '--d': 500 + i * 140 })}>
              <img src={movieCraft(a.weapon)} alt="" draggable={false} />
              <b>×{a.count}</b>
              <span>{WEAPON_LABEL[a.weapon]}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ───────────────────────── Shot 2: the launch ───────────────────────── */

function HeliSprite({ className }: { className?: string }) {
  return (
    <span className={`mv-heli-art${className ? ` ${className}` : ''}`}>
      <img src={ART.mv.heli} alt="" draggable={false} />
      <i className="mv-rotor" aria-hidden />
    </span>
  );
}

/** Where a cluster's bomblets come down over the skyline, left to right */
const CLUSTER_SPOTS: [number, number][] = [
  [30, 50],
  [48, 36],
  [62, 58],
  [74, 42],
  [40, 66],
];

function LaunchShot({ strike, ms, sfx }: { strike: StrikeShow; ms: number; sfx: Sfx }) {
  const arsenal = arsenalOf(strike);
  const rockets = arsenal
    .filter((a) => isBallisticWeapon(a.weapon))
    .flatMap((a) => Array.from({ length: Math.min(a.count, 3) }, () => a.weapon))
    .slice(0, 5);
  const squad = arsenal.some((a) => a.weapon === 'commando');
  const swarm = arsenal.some((a) => a.weapon === 'drone');
  const airfield = rockets.length === 0;
  // A swarm and nothing else: the drones go up from truck launchers, not a runway
  const dronesOnly = airfield && swarm && !squad;
  const ignite = dronesOnly ? 500 : airfield ? 900 : 1000;
  // Each launcher fires its drone a beat after the one before. The shot is short, so the
  // last launchers get a shorter climb and every drone is away before the cut.
  const PAD_GAP = 200;
  const padStart = Math.min(ignite, 750);
  const PAD_END = 1750;

  useCues([
    { at: ignite - 50, run: () => sfx(SFX.launch, 0.95) },
    ...(airfield ? [] : [{ at: ignite + 250, run: () => sfx(SFX.launch, 0.5, 1.25) }]),
    ...(swarm
      ? [0, 1, 2].map((n) => ({ at: padStart + n * PAD_GAP + 150, run: () => sfx(SFX.launch, 0.4, 1.6 + n * 0.1) }))
      : []),
  ]);

  return (
    <section className="mv-shot mv-launch" style={vars({ '--ms': ms, '--ignite': ignite })}>
      <div className="mv-cam">
        <div className="mv-shake">
          <div
            className="mv-backdrop"
            style={{
              backgroundImage: `url(${airfield ? ART.moviePlate.airfield(strike.from) : ART.moviePlate.launch(strike.from)})`,
            }}
          />
          {!airfield && <div className="mv-ignite" />}
          {!airfield && (
            <div className="mv-smoke" aria-hidden>
              {[0, 1, 2, 3, 4].map((n) => (
                <i key={n} style={vars({ '--n': n })} />
              ))}
            </div>
          )}
          {rockets.map((weapon, i) => {
            const offset = (i - (rockets.length - 1) / 2) * 11;
            return (
              <div
                key={`${weapon}-${i}`}
                className="mv-rocket"
                style={vars({ '--x': `${offset}vmin`, '--delay': ignite + i * 130 })}
              >
                <img className="mv-rocket__flame" src={ART.mv.fx.fireball} alt="" draggable={false} />
                <img className="mv-rocket__body" src={movieCraft(weapon)} alt="" draggable={false} />
              </div>
            );
          })}
          {squad && (
            <div className={`mv-liftoff${airfield ? ' is-solo' : ''}`} style={vars({ '--delay': ignite - 150 })}>
              <HeliSprite />
            </div>
          )}
          {swarm && (
            <div
              className={`mv-pads${rockets.length > 0 ? ' has-rockets' : ''}${squad ? ' has-squad' : ''}`}
              aria-hidden
            >
              {[0, 1, 2].map((n) => (
                <div
                  key={n}
                  className="mv-pad"
                  style={vars({
                    '--i': n,
                    '--at': padStart + n * PAD_GAP,
                    '--dur': Math.max(700, PAD_END - (padStart + n * PAD_GAP)),
                    '--truck': `url(${ART.mv.launcher})`,
                  })}
                >
                  <img className="mv-pad__truck" src={ART.mv.launcher} alt="" draggable={false} />
                  <i className="mv-pad__tint" />
                  <i className="mv-pad__glow" />
                  <span className="mv-pad__blast">
                    {[0, 1, 2].map((p) => (
                      <img key={p} src={ART.mv.fx.plume} alt="" draggable={false} style={vars({ '--p': p })} />
                    ))}
                  </span>
                  <span className="mv-pad__drone">
                    <img className="mv-pad__flame" src={ART.mv.fx.booster} alt="" draggable={false} />
                    <i className="mv-pad__flash" />
                    <img className="mv-pad__body" src={ART.mv.droneSide} alt="" draggable={false} />
                  </span>
                  <span className="mv-pad__trail">
                    {[0, 1, 2, 3, 4].map((p) => (
                      <img key={p} src={ART.mv.fx.plume} alt="" draggable={false} style={vars({ '--p': p })} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mv-countdown" aria-hidden>
        {airfield ? (
          <span className="mv-countdown__text">{dronesOnly ? 'Launchers armed' : 'Rotors spinning up'}</span>
        ) : (
          <>
            <span style={vars({ '--d': 0 })}>3</span>
            <span style={vars({ '--d': 300 })}>2</span>
            <span style={vars({ '--d': 600 })}>1</span>
          </>
        )}
      </div>
      <p className="mv-launch__word" style={vars({ '--d': ignite })}>
        {airfield && !dronesOnly ? 'Wheels up' : 'Launch'}
      </p>
    </section>
  );
}

/* ───────────────────────── Shot 3: the tracking radar ───────────────────────── */

function TrackShot({ strike, ms }: { strike: StrikeShow; ms: number }) {
  const n = strike.targets.length;
  return (
    <section className="mv-shot mv-track" style={vars({ '--ms': ms })}>
      <StrikeGlobe strike={strike} ms={ms} />
      <p className="mv-track__hud">
        {n === 1 ? '1 target locked' : `${n} targets locked`}
        <i aria-hidden />
      </p>
    </section>
  );
}

/* ───────────────────────── Shot 4: one city ───────────────────────── */

/** A beam from a point on the city (x0, y0) to a point in the sky (x1, y1), all in % of the city box. */
function beamTo(x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0;
  const dy = y0 - y1;
  return { left: x0, bottom: 100 - y0, len: Math.hypot(dx, dy), ang: (Math.atan2(dx, dy) * 180) / Math.PI };
}

function Beam({ x0, y0, x1, y1, at, n }: { x0: number; y0: number; x1: number; y1: number; at: number; n: number }) {
  const g = beamTo(x0, y0, x1, y1);
  return (
    <span
      className="mv-beam"
      aria-hidden
      style={{
        left: `${g.left}%`,
        bottom: `${g.bottom}%`,
        height: `${g.len}%`,
        ...vars({ '--ang': `${g.ang}deg`, '--at': at, '--n': n }),
      }}
    />
  );
}

// Where the five drones hover, in % of the city box (matches the CSS)
const droneX = (n: number) => 50 + (n - 2) * 17;
const droneY = (n: number) => 3.2 + (n - 2) * (n - 2) * 0.96;

/**
 * One defence drone climbing out of the city to meet an attack in the sky. It
 * leaves the rooftops at `launch`, reaches (x1, y1) at `meet`, then breaks off.
 * Positions are percentages of the city shot, measured from the top left.
 */
function DefenceDrone({
  n,
  x1,
  y1,
  launch,
  meet,
}: {
  n: number;
  x1: number;
  y1: number;
  launch: number;
  meet: number;
}) {
  const x0 = 50 + (n - 2) * 13;
  const y0 = 88;
  // The sprite's nose points right; turn it toward where it is going
  const rot = (Math.atan2((y1 - y0) * 0.56, x1 - x0) * 180) / Math.PI;
  return (
    <span
      className="mv-defdrone"
      aria-hidden
      style={vars({
        '--x0': `${x0}%`,
        '--y0': `${y0}%`,
        '--x1': `${x1}%`,
        '--y1': `${y1}%`,
        '--rot': `${rot}deg`,
        '--n': n,
        '--launch': Math.max(0, launch),
        '--fly': Math.max(300, meet - Math.max(0, launch)),
        '--meet': meet,
      })}
    >
      <img src={ART.mv.drone} alt="" draggable={false} />
    </span>
  );
}

/** The flash, ring and falling debris where defence drones (or a beam) kill an attack in the sky. */
function SkyKill({ x, y, at }: { x: number; y: number; at: number }) {
  const pos = { left: `${x}%`, top: `${y}%` };
  return (
    <>
      <img
        className="mv-airburst is-intercept"
        style={{ ...pos, ...vars({ '--at': at }) }}
        src={ART.mv.fx.airburst}
        alt=""
        draggable={false}
      />
      <span className="mv-intercept-ring" style={{ ...pos, ...vars({ '--at': at }) }} aria-hidden />
      <span className="mv-debris" style={{ ...pos, ...vars({ '--at': at }) }} aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <i key={n} style={vars({ '--n': n })} />
        ))}
      </span>
    </>
  );
}

function TargetShot({
  strike,
  target,
  ms,
  leaderSrc,
  sfx,
}: {
  strike: StrikeShow;
  target: StrikeTarget;
  ms: number;
  leaderSrc: (id: NationId) => string;
  sfx: Sfx;
}) {
  const outcome = targetOutcome(target);
  const line = useMemo(() => targetTimeline(target.weapons), [target.weapons]);
  const squad = target.weapons.includes('commando');
  const swarm = target.weapons.includes('drone');
  const warhead: StrikeWeapon | null = target.weapons.includes('hydrogen')
    ? 'hydrogen'
    : target.weapons.includes('magnetic')
      ? 'magnetic'
      : target.weapons.includes('nuke')
        ? 'nuke'
        : (target.weapons.find(isBallisticWeapon) ?? null);
  const defender = nationDef(target.to);
  const attacker = nationDef(strike.from);

  // Defence drones (or a laser network) kill the attack in the sky before it arrives
  const defended = outcome === 'defended';
  const shotDown = outcome === 'shotDown';
  const stopped = defended || shotDown;
  const meetAt = line.warheadAt + 450;
  const WARHEAD_AIM: [number, number] = [50, 3];
  // The swarm's own moments
  const droneHitAt = line.droneAt + 700;
  // The squad's moments: arrive, ropes, team down, flag, leave
  const arrive = line.raidAt + 900;
  const flagAt = arrive + 1500;
  const leaveAt = outcome === 'captured' ? arrive + 3100 : arrive + 1250;
  const hitAt = arrive + 420;
  const crashAt = hitAt + 900;
  const laserSquad = outcome === 'repelled' && target.raidCover === 'laser';
  const downedSquad = laserSquad || (defended && squad);
  const shieldSquad = outcome === 'repelled' && target.raidCover === 'shield';
  const bunkerSquad = outcome === 'repelled' && target.raidCover === 'bunker';

  // Which moment breaks the dome, if any does
  const domeBreaksAt = !target.hadShield || stopped
    ? null
    : warhead && outcome !== 'repelled'
      ? line.warheadAt
      : squad && outcome === 'captured'
        ? swarm
          ? droneHitAt
          : arrive
        : null;
  const domeFlashAt = shieldSquad
    ? arrive + 350
    : swarm && target.hadShield && !warhead && !squad && !stopped
      ? droneHitAt
      : null;

  const razed = outcome === 'razed';
  // A city someone else already razed is shown as rubble from the first frame
  const preRuined = outcome === 'empty' && (squad || Boolean(target.rubble));
  const rubbleHit = Boolean(warhead) && Boolean(target.rubble) && outcome === 'empty';
  const razedAt = line.warheadAt + 160;
  const boomAt = line.warheadAt;
  const captionAt = stopped
    ? warhead
      ? meetAt + 600
      : squad
        ? hitAt + 700
        : droneHitAt + 600
    : squad
      ? outcome === 'captured'
        ? flagAt + 100
        : arrive + 700
      : warhead
        ? line.warheadAt + 650
        : droneHitAt + 500;
  const caption = cinemaCaption(target, true) ?? outcomeLine(target);

  const shakeAt = stopped && warhead ? meetAt : warhead ? line.warheadAt : null;
  const shakeStrong = !stopped && (warhead === 'hydrogen' || (warhead != null && (razed || rubbleHit)));
  const takenFlag = outcome === 'captured';
  const fireWarhead = warhead === 'nuke' || warhead === 'hydrogen';
  // Plague and gas raze the city without a flame: a cloud rolls over the dead streets
  const toxic = warhead === 'biological';
  const gas = warhead === 'chemical';

  useCues([
    ...(stopped
      ? [
          ...(warhead
            ? [
                ...(defended ? [{ at: meetAt - 900, run: () => sfx(SFX.launch, 0.3, 1.9) }] : []),
                { at: meetAt, run: () => sfx(SFX.explosion, 0.6, 1.7) },
              ]
            : []),
          ...(defended && swarm ? [{ at: droneHitAt, run: () => sfx(SFX.explosion, 0.4, 2.1) }] : []),
          ...(defended && squad
            ? [
                { at: line.raidAt + 150, run: () => sfx(SFX.launch, 0.4, 0.55) },
                { at: hitAt, run: () => sfx(SFX.explosion, 0.55, 1.7) },
                { at: crashAt, run: () => sfx(SFX.explosion, 0.7, 0.9) },
              ]
            : []),
        ]
      : []),
    ...(warhead && !stopped
      ? [
          {
            at: line.warheadAt,
            run: () =>
              outcome === 'bunker'
                ? sfx(SFX.explosion, 0.5, 0.6)
                : outcome === 'shield'
                  ? sfx(SFX.explosion, 0.65, 1.35)
                  : warhead === 'hydrogen'
                    ? sfx(SFX.explosion, 1, 0.78)
                    : warhead === 'cluster'
                      ? sfx(SFX.explosion, 0.6, 1.8)
                      : warhead === 'chemical' || warhead === 'biological'
                        ? sfx(SFX.explosion, 0.5, 0.7)
                    : warhead === 'magnetic'
                      ? sfx(SFX.explosion, 0.85, 1.55)
                      : sfx(SFX.explosion, 0.95),
          },
          ...(razed ? [{ at: razedAt + 250, run: () => sfx(SFX.explosion, 0.55, 0.55) }] : []),
        ]
      : []),
    ...(swarm && !squad && !defended
      ? [{ at: droneHitAt, run: () => sfx(SFX.explosion, target.lasered ? 0.35 : 0.3, 2.1) }]
      : []),
    ...(squad && !defended
      ? [
          { at: line.raidAt + 150, run: () => sfx(SFX.launch, 0.4, 0.55) },
          ...(laserSquad
            ? [
                { at: hitAt, run: () => sfx(SFX.explosion, 0.55, 1.7) },
                { at: crashAt, run: () => sfx(SFX.explosion, 0.75, 0.9) },
              ]
            : []),
        ]
      : []),
  ]);

  return (
    <section className={`mv-shot mv-target is-${outcome}`} style={vars({ '--ms': ms })}>
      <div className="mv-cam">
        <div
          className="mv-shake"
          style={shakeAt != null ? vars({ '--shake-at': shakeAt }) : undefined}
          data-shake={shakeAt != null ? (shakeStrong ? 'hard' : 'soft') : undefined}
        >
          {/* The city is a photographic plate with its flag painted in. Other plates, same camera, show it razed or with the flag taken down. */}
          <div className="mv-plate">
            <img
              className="mv-plate__img"
              src={preRuined ? ART.moviePlate.cityRuin(target.cityId) : ART.moviePlate.city(target.cityId)}
              alt=""
              draggable={false}
            />
            {razed && (
              <img
                className="mv-plate__img mv-plate__img--ruin"
                src={ART.moviePlate.cityRuin(target.cityId)}
                alt=""
                draggable={false}
                style={vars({ '--razed-at': razedAt })}
              />
            )}
            {takenFlag && (
              <img
                className="mv-plate__img mv-plate__img--pole"
                src={ART.moviePlate.cityTaken(target.cityId)}
                alt=""
                draggable={false}
                style={vars({ '--at': flagAt - 350 })}
              />
            )}
            {takenFlag && PLATE_FLAGS[target.cityId] && (
              <span
                className={`mv-plate__cloth is-${PLATE_FLAGS[target.cityId].side}`}
                style={{
                  left: `${PLATE_FLAGS[target.cityId].box[0]}%`,
                  top: `${PLATE_FLAGS[target.cityId].box[1]}%`,
                  width: `${PLATE_FLAGS[target.cityId].box[2] - PLATE_FLAGS[target.cityId].box[0]}%`,
                  height: `${PLATE_FLAGS[target.cityId].box[3] - PLATE_FLAGS[target.cityId].box[1]}%`,
                  backgroundImage: `url(${ART.flags[strike.from]})`,
                  ...vars({ '--at': flagAt - 100, '--rise': PLATE_FLAGS[target.cityId].rise }),
                }}
                aria-hidden
              />
            )}
          </div>
          {outcome === 'swarmed' && <div className="mv-hurt" style={vars({ '--hurt-at': droneHitAt })} aria-hidden />}
          {outcome === 'damaged' && (
            <div
              className="mv-hurt"
              style={vars({ '--hurt-at': line.warheadAt + 150 })}
              aria-hidden
            />
          )}
          <div className="mv-citybox">

            {target.hadBunker && <span className="mv-bunker-tag">Bunker</span>}
            {defended && <span className="mv-bunker-tag mv-cover-tag">Drone cover</span>}

            {/* Shield */}
            {target.hadShield && (
              <img
                className={`mv-dome${domeBreaksAt != null ? ' is-break' : ''}${domeFlashAt != null ? ' is-flash' : ''}`}
                style={vars({ '--at': domeBreaksAt ?? domeFlashAt ?? 0 })}
                src={ART.mv.fx.shield}
                alt=""
                draggable={false}
              />
            )}
            {domeBreaksAt != null && (
              <>
                <img className="mv-shield-break" style={vars({ '--at': domeBreaksAt })} src={ART.mv.fx.shieldBreak} alt="" draggable={false} />
                <span className="mv-shards" style={vars({ '--at': domeBreaksAt })} aria-hidden>
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                    <i key={n} />
                  ))}
                </span>
              </>
            )}
            {domeFlashAt != null && (
              <img
                className="mv-shield-break is-small"
                style={vars({ '--at': domeFlashAt })}
                src={ART.mv.fx.shieldBreak}
                alt=""
                draggable={false}
              />
            )}

            {/* Warhead falling */}
            {warhead && (
              <div
                className={`mv-missile is-${warhead}${stopped ? ' is-shot' : ''}`}
                style={vars({ '--lead': (stopped ? meetAt : line.warheadAt) - 750 })}
              >
                <span className="mv-missile__trail" aria-hidden />
                <span className="mv-missile__body">
                  <img className="mv-missile__flame" src={ART.mv.fx.fireball} alt="" draggable={false} />
                  <img src={movieCraft(warhead)} alt="" draggable={false} />
                </span>
              </div>
            )}

            {/* Impact: the ground burst, the cloud, the dust */}
            {warhead && (razed || rubbleHit) && (
              <>
                <span className={`mv-flash${toxic || gas ? ' is-toxic' : ''}`} style={vars({ '--at': boomAt })} aria-hidden />
                <span className={`mv-shock is-${warhead}`} style={vars({ '--at': boomAt })} aria-hidden />
                {fireWarhead && (
                  <>
                    <img className={`mv-mushroom is-${warhead}`} style={vars({ '--at': boomAt + 150 })} src={ART.mv.fx.mushroom} alt="" draggable={false} />
                    <img className={`mv-fireball is-${warhead}`} style={vars({ '--at': boomAt })} src={ART.mv.fx.fireball} alt="" draggable={false} />
                  </>
                )}
                {warhead === 'magnetic' && (
                  <>
                    <img className="mv-emp" style={vars({ '--at': boomAt })} src={ART.mv.fx.emp} alt="" draggable={false} />
                    <img className="mv-fireball is-small" style={vars({ '--at': boomAt + 120 })} src={ART.mv.fx.fireball} alt="" draggable={false} />
                  </>
                )}
                <img className={`mv-dustcloud${toxic ? ' is-toxic' : gas ? ' is-gas' : ''}`} style={vars({ '--at': razedAt })} src={ART.mv.fx.dust} alt="" draggable={false} />
                <img className={`mv-dustcloud is-late${toxic ? ' is-toxic' : gas ? ' is-gas' : ''}`} style={vars({ '--at': razedAt + 350 })} src={ART.mv.fx.dust} alt="" draggable={false} />
                {(toxic || gas) && (
                  <img className={`mv-dustcloud is-low ${toxic ? 'is-toxic' : 'is-gas'}`} style={vars({ '--at': razedAt + 700 })} src={ART.mv.fx.dust} alt="" draggable={false} />
                )}
                {!toxic && !gas && <span className="mv-fire" style={vars({ '--at': razedAt + 300 })} aria-hidden />}
                <span className={`mv-embers${toxic || gas ? ' is-spores' : ''}`} style={vars({ '--at': razedAt + 150 })} aria-hidden>
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <i key={n} style={vars({ '--n': n })} />
                  ))}
                </span>
              </>
            )}
            {warhead && outcome === 'bunker' && (
              <>
                <img className="mv-dustcloud is-low" style={vars({ '--at': boomAt })} src={ART.mv.fx.dust} alt="" draggable={false} />
                <span className="mv-shock is-rock" style={vars({ '--at': boomAt })} aria-hidden />
              </>
            )}
            {warhead && (outcome === 'shield' || outcome === 'captured') && !target.hadShield && (
              <span className="mv-flash" style={vars({ '--at': boomAt })} aria-hidden />
            )}
            {/* Cluster bomblets pepper the skyline */}
            {warhead && outcome === 'damaged' && (
              <>
                <span className="mv-flash is-soft" style={vars({ '--at': boomAt })} aria-hidden />
                {warhead === 'cluster' && (
                  <>
                    <span className="mv-split" style={vars({ '--at': boomAt - 120 })} aria-hidden />
                    {CLUSTER_SPOTS.map(([x, y], n) => (
                      <i
                        key={n}
                        className="mv-bomblet"
                        style={vars({
                          '--x': `${x}%`,
                          '--y': `${y}%`,
                          '--spin': `${(n - 2) * 38}deg`,
                          '--at': boomAt - 80 + n * 170,
                        })}
                        aria-hidden
                      />
                    ))}
                  </>
                )}
                {CLUSTER_SPOTS.map(([x, y], n) => (
                  <img
                    key={n}
                    className="mv-hit"
                    style={{ left: `${x}%`, top: `${y}%`, ...vars({ '--at': boomAt + 240 + n * 170 }) }}
                    src={ART.mv.fx.airburst}
                    alt=""
                    draggable={false}
                  />
                ))}
              </>
            )}

            {/* The kill in the sky: the missile meets defence drones or a laser beam */}
            {stopped && warhead && (
              <>
                <SkyKill x={WARHEAD_AIM[0]} y={WARHEAD_AIM[1]} at={meetAt} />
                {defended
                  ? [0, 1, 2, 3, 4].map((n) => (
                      <DefenceDrone
                        key={n}
                        n={n}
                        x1={WARHEAD_AIM[0] + (n - 2) * 3.4}
                        y1={WARHEAD_AIM[1] + Math.abs(n - 2) * 1.5}
                        launch={meetAt - 900 + n * 40}
                        meet={meetAt - 60 + n * 25}
                      />
                    ))
                  : [38, 50, 62].map((x, n) => (
                      <Beam key={x} n={n} x0={x} y0={70} x1={50 + (x - 50) * 0.2} y1={WARHEAD_AIM[1]} at={meetAt - 520 + n * 70} />
                    ))}
              </>
            )}
            {defended && swarm && (
              <>
                {[0, 1, 2, 3, 4].map((n) => (
                  <DefenceDrone
                    key={n}
                    n={n}
                    x1={droneX(n)}
                    y1={droneY(n) + 5}
                    launch={droneHitAt + n * 90 - 650}
                    meet={droneHitAt + n * 90 - 100}
                  />
                ))}
                <SkyKill x={50} y={9} at={droneHitAt + 120} />
              </>
            )}
            {defended && squad && (
              <>
                {[0, 1, 2, 3, 4].map((n) => (
                  <DefenceDrone
                    key={n}
                    n={n}
                    x1={40 + n * 4}
                    y1={9 + Math.abs(n - 2) * 1.5}
                    launch={hitAt - 780 + n * 40}
                    meet={hitAt - 60 + n * 25}
                  />
                ))}
              </>
            )}

            {/* Drone swarm */}
            {swarm && (
              <div className="mv-swarm" style={vars({ '--at': line.droneAt })}>
                {[0, 1, 2, 3, 4].map((n) => (
                  <span
                    key={n}
                    className={`mv-drone${target.lasered || defended ? ' is-shot' : ''}`}
                    style={vars({ '--n': n, '--shot-at': droneHitAt + n * 90 })}
                  >
                    <img className="mv-drone__body" src={ART.mv.drone} alt="" draggable={false} />
                    {(target.lasered || defended) && (
                      <img className="mv-drone__burst" src={ART.mv.fx.airburst} alt="" draggable={false} />
                    )}
                  </span>
                ))}
              </div>
            )}
            {swarm && target.lasered && !defended &&
              [0, 1, 2, 3, 4].map((n) => (
                <Beam key={n} n={n} x0={50 + (n - 2) * 7} y0={70} x1={droneX(n)} y1={droneY(n)} at={droneHitAt - 120 + n * 90} />
              ))}
            {swarm && !target.lasered && !defended && !warhead && !squad && !target.rubble &&
              [
                [32, 46],
                [58, 34],
                [70, 56],
              ].map(([x, y], n) => (
                <img
                  key={n}
                  className="mv-hit"
                  style={{ left: `${x}%`, top: `${y}%`, ...vars({ '--at': droneHitAt + n * 220 }) }}
                  src={ART.mv.fx.airburst}
                  alt=""
                  draggable={false}
                />
              ))}

            {/* The squad */}
            {squad && (
              <div
                className={`mv-heli${downedSquad ? ' is-hit' : ''}${outcome === 'captured' || outcome === 'empty' || outcome === 'razed' ? '' : ' is-turned'}`}
                style={vars({ '--arrive': line.raidAt, '--leave': leaveAt, '--hit': hitAt })}
              >
                <HeliSprite />
                {(outcome === 'captured' || outcome === 'empty' || outcome === 'razed') && (
                  <span className="mv-spot" style={vars({ '--at': arrive })} aria-hidden />
                )}
                {downedSquad && (
                  <img className="mv-heli__burn" style={vars({ '--at': hitAt })} src={ART.mv.fx.airburst} alt="" draggable={false} />
                )}
              </div>
            )}
            {squad && outcome === 'captured' && (
              <div className="mv-raid" style={vars({ '--arrive': arrive, '--out': leaveAt - 250 })} aria-hidden>
                {['a', 'b', 'c'].map((r) => (
                  <i key={r} className={`mv-rope mv-rope--${r}`} />
                ))}
                {[0, 1, 2].map((n) => (
                  <span key={n} className={`mv-operator mv-operator--${n}`}>
                    <img src={ART.mv.commando[n]} alt="" draggable={false} />
                  </span>
                ))}
                <span className="mv-wash" />
              </div>
            )}
            {squad && downedSquad && (
              <>
                {laserSquad &&
                  [36, 50, 64].map((x, n) => (
                    <Beam key={x} n={n} x0={x} y0={70} x1={50 + (x - 50) * 0.25} y1={9} at={arrive + 60 + n * 70} />
                  ))}
                <img className="mv-airburst" style={vars({ '--at': hitAt })} src={ART.mv.fx.airburst} alt="" draggable={false} />
                <img className="mv-crash" style={vars({ '--at': crashAt })} src={ART.mv.fx.fireball} alt="" draggable={false} />
                <img className="mv-dustcloud is-low is-crash" style={vars({ '--at': crashAt })} src={ART.mv.fx.dust} alt="" draggable={false} />
              </>
            )}
            {squad && (shieldSquad || bunkerSquad) && (
              <span className="mv-blocked" style={vars({ '--at': arrive + 300 })} aria-hidden>
                ✕
              </span>
            )}
          </div>
          {squad && outcome === 'captured' && <div className="mv-taken-glow" style={vars({ '--at': flagAt })} aria-hidden />}
          {warhead && (razed || rubbleHit) && (
            <span className={`mv-flash mv-flash--screen${toxic || gas ? ' is-toxic' : ''}`} style={vars({ '--at': boomAt })} aria-hidden />
          )}
        </div>
        <span className="mv-haze" aria-hidden />
      </div>

      <div className="mv-lower">
        <b className="mv-lower__city">{target.cityName}</b>
        <div className="mv-lower__duel">
          <span className="mv-lower__side">
            <span className="mv-lower__who">
              <img src={leaderSrc(strike.from)} alt="" draggable={false} />
              <i className="mv-lower__badge" style={{ backgroundImage: `url(${ART.flags[strike.from]})` }} />
            </span>
            <span className="mv-lower__name">
              <small>Attacker</small>
              <em>{attacker.name}</em>
            </span>
          </span>
          <span className="mv-lower__arrow" aria-hidden>
            {[...new Set(target.weapons)].map((w) => (
              <img key={w} src={movieCraft(w)} alt="" draggable={false} className={`is-${w}`} />
            ))}
            <i />
          </span>
          <span className={`mv-lower__side is-defender${takenFlag ? ' is-lost' : ''}`} style={vars({ '--at': flagAt })}>
            <span className="mv-lower__who">
              <img src={leaderSrc(target.to)} alt="" draggable={false} />
              <i className="mv-lower__badge" style={{ backgroundImage: `url(${ART.flags[target.to]})` }} />
            </span>
            <span className="mv-lower__name">
              <small className="mv-lower__role">Defender</small>
              {takenFlag && <small className="mv-lower__role is-lost">City taken</small>}
              <em>{defender.name}</em>
            </span>
          </span>
        </div>
      </div>
      <p className={`mv-caption is-${outcome}`} style={vars({ '--at': captionAt })}>
        {caption}
        {target.points ? (
          <em className="mv-caption__pts" style={vars({ '--at': captionAt + 350 })}>
            +{target.points}
            {target.clean ? <small>clean</small> : null}
          </em>
        ) : null}
      </p>
    </section>
  );
}

/* ───────────────────────── Shot 5: the toll card ───────────────────────── */

function TollShot({ strike, ms }: { strike: StrikeShow; ms: number }) {
  const from = nationDef(strike.from);
  const points = strike.targets.reduce((sum, t) => sum + (t.points ?? 0), 0);
  return (
    <section className="mv-shot mv-toll" style={vars({ '--ms': ms })}>
      <div className="mv-flagbg" style={{ backgroundImage: `url(${ART.flags[strike.from]})` }} />
      <div className="mv-toll__card">
        <p className="mv-title__kicker">Strike report</p>
        <h2 className="mv-toll__nation">{from.name}</h2>
        <ul className="mv-toll__rows">
          {strike.targets.map((t, i) => {
            const o = targetOutcome(t);
            const good = o === 'captured' || o === 'razed' || o === 'shield' || o === 'swarmed' || o === 'damaged';
            return (
              <li
                key={`${t.cityId}-${i}`}
                className={`is-${good ? 'good' : 'bad'}`}
                style={vars({ '--d': 250 + i * 160 })}
              >
                <img src={ART.flags[t.to]} alt="" draggable={false} />
                <span>{outcomeLine(t)}</span>
                {t.points ? <b>+{t.points}</b> : null}
              </li>
            );
          })}
        </ul>
        {points > 0 && (
          <p className="mv-toll__total" style={vars({ '--d': 250 + strike.targets.length * 160 + 100 })}>
            Points banked <b>+{points}</b>
          </p>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── The projector ───────────────────────── */

export default function StrikeMovie({ strike, leaderSrc, sfx, onComplete, onSkipAll }: MovieProps) {
  const shots = useMemo(() => buildShots(strike), [strike]);
  const total = useMemo(() => shots.reduce((sum, s) => sum + s.ms, 0), [shots]);
  const [index, setIndex] = useState(0);
  const finished = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const shotPace = shots[Math.min(index, shots.length - 1)].pace;
  const doneRef = useRef(onComplete);
  doneRef.current = onComplete;

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    doneRef.current();
  };

  // Escape skips the film too
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // finish only touches refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (index + 1 < shots.length) setIndex(index + 1);
      else finish();
    }, shots[index].ms);
    return () => window.clearTimeout(id);
    // finish only touches refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, shots]);

  // Every effect is written at storyboard speed; slow them to the film's pace
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    for (const a of stage.getAnimations({ subtree: true })) {
      const name = (a as CSSAnimation).animationName;
      if (name === 'mvCut' || name === 'mvPush') continue;
      a.playbackRate = 1 / shotPace;
    }
  }, [index]);

  // Absolute failsafe so a round can never hang on a stalled shot
  useEffect(() => {
    const id = window.setTimeout(finish, total + 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const shot: MovieShot = shots[Math.min(index, shots.length - 1)];
  const title = movieTitle(strike);

  return (
    <div className="movie" role="dialog" aria-modal="true" aria-label="Strike">
      <PaceContext.Provider value={shotPace}>
      <div className="movie__stage" key={`${index}-${shot.kind}`} ref={stageRef}>
        {shot.kind === 'title' && <TitleShot strike={strike} ms={shot.ms} leaderSrc={leaderSrc} />}
        {shot.kind === 'launch' && <LaunchShot strike={strike} ms={shot.ms} sfx={sfx} />}
        {shot.kind === 'track' && <TrackShot strike={strike} ms={shot.ms} />}
        {shot.kind === 'target' && (
          <TargetShot
            strike={strike}
            target={strike.targets[shot.index]}
            ms={shot.ms}
            leaderSrc={leaderSrc}
            sfx={sfx}
          />
        )}
        {shot.kind === 'toll' && <TollShot strike={strike} ms={shot.ms} />}
      </div>
      </PaceContext.Provider>
      <div className="movie__grain" aria-hidden />
      <div className="movie__vignette" aria-hidden />
      <div className="movie__bar movie__bar--top">
        <span className="movie__slate">{title}</span>
        <span className="movie__reel" aria-hidden>
          {shots.map((_, i) => (
            <i key={i} className={i < index ? 'is-done' : i === index ? 'is-now' : ''} />
          ))}
        </span>
      </div>
      <div className="movie__bar movie__bar--bottom">
        {onSkipAll && (
          <button type="button" className="movie__skip movie__skip--all" onClick={onSkipAll}>
            Skip all films
          </button>
        )}
        <button type="button" className="movie__skip" onClick={finish}>
          Skip
          <span aria-hidden>▸▸</span>
        </button>
      </div>
    </div>
  );
}

