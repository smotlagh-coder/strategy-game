import { useEffect, useMemo, useRef } from 'react';
import { ART } from '../data/art';
import { cityGeo, launchSite } from '../data/geo';
import { nationDef } from '../data/nations';
import type { StrikeShow } from '../game/movie';
import type { StrikeWeapon } from '../types';
import type { CountryShape } from '../data/worldCountries';

const D2R = Math.PI / 180;

export const TRACK_COLOUR: Record<StrikeWeapon, string> = {
  nuke: '#ff8a4c',
  hydrogen: '#cfeaff',
  magnetic: '#b58cff',
  drone: '#5fe3ff',
  commando: '#7dff9a',
};

type V3 = [number, number, number];

const toVec = (lat: number, lon: number): V3 => [
  Math.cos(lat * D2R) * Math.cos(lon * D2R),
  Math.cos(lat * D2R) * Math.sin(lon * D2R),
  Math.sin(lat * D2R),
];
const fromVec = (v: V3): [number, number] => [
  Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R,
  Math.atan2(v[1], v[0]) / D2R,
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (v: number) => {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
};
const easeInOut = (v: number) => {
  const x = clamp(v, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

function slerp(a: V3, b: V3, t: number): V3 {
  const om = angle(a, b);
  if (om < 1e-5) return a;
  const s = Math.sin(om);
  const ka = Math.sin((1 - t) * om) / s;
  const kb = Math.sin(t * om) / s;
  return [ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]];
}

interface Cam {
  lat: number;
  lon: number;
  /** Angular radius of the view, in radians: how much of the globe fits the screen */
  view: number;
}

interface Projected {
  x: number;
  y: number;
  /** In front of the globe, or above its edge */
  seen: boolean;
}

/** Orthographic projection, unit sphere, camera looking at (lat, lon). `r` lifts a point above the surface. */
function project(lat: number, lon: number, cam: Cam, r = 1): Projected & { z: number } {
  const p = lat * D2R;
  const p0 = cam.lat * D2R;
  const dl = (lon - cam.lon) * D2R;
  const x = Math.cos(p) * Math.sin(dl) * r;
  const y = (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl)) * r;
  const z = (Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl)) * r;
  return { x, y, z, seen: z >= 0 || x * x + y * y >= 1 };
}


/**
 * A land outline as seen from the camera: the part on the near side only, with the
 * cut closed along the globe's edge so nothing smears across the disc.
 */
function clipRing(ring: number[], cam: Cam, stride = 1): [number, number][] {
  const pts: { x: number; y: number; z: number }[] = [];
  const last = ring.length - 2;
  for (let i = 0; i < ring.length; i += 2 * stride) {
    const p = project(ring[i + 1], ring[i], cam);
    pts.push({ x: p.x, y: p.y, z: p.z });
  }
  if (stride > 1 && (ring.length - 2) % (2 * stride) !== 0) {
    const p = project(ring[last + 1], ring[last], cam);
    pts.push({ x: p.x, y: p.y, z: p.z });
  }
  const out: [number, number][] = [];
  let exitAngle: number | null = null;
  let firstEntry: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a.z >= 0) out.push([a.x, a.y]);
    if (a.z >= 0 !== b.z >= 0) {
      const t = a.z / (a.z - b.z);
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      const l = Math.hypot(x, y) || 1;
      const edge: [number, number] = [x / l, y / l];
      const ang = Math.atan2(edge[1], edge[0]);
      if (a.z >= 0) {
        // Leaving the near side
        out.push(edge);
        exitAngle = ang;
      } else {
        // Coming back: run along the edge from where we left
        if (exitAngle == null && firstEntry == null) firstEntry = ang;
        if (exitAngle != null) {
          let d = ang - exitAngle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const n = Math.max(2, Math.ceil(Math.abs(d) / 0.15));
          for (let k = 1; k < n; k++) {
            const q = exitAngle + (d * k) / n;
            out.push([Math.cos(q), Math.sin(q)]);
          }
        }
        out.push(edge);
      }
    }
  }
  // The outline began on the far side: close the cut from the last exit to the first entry
  if (firstEntry != null && exitAngle != null) {
    let d = firstEntry - exitAngle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const n = Math.max(2, Math.ceil(Math.abs(d) / 0.15));
    for (let k = 1; k < n; k++) {
      const q = exitAngle + (d * k) / n;
      out.push([Math.cos(q), Math.sin(q)]);
    }
  }
  return out;
}

/** The game's twelve nations, by the country they are drawn as */
const GAME_COUNTRY: Record<string, string> = {
  'United States': 'us',
  'United Kingdom': 'uk',
  France: 'france',
  Russia: 'russia',
  China: 'china',
  India: 'india',
  Pakistan: 'pakistan',
  'North Korea': 'northkorea',
  Iran: 'iran',
  Canada: 'canada',
  Australia: 'australia',
  Brazil: 'brazil',
};

const LABEL_SHORT: Record<string, string> = { 'United Kingdom': 'UK', 'United States': 'USA', 'North Korea': 'N. KOREA' };

const TONES = ['#2b4a63', '#33536b', '#2a4f5c', '#3a4f68', '#2f4b5f', '#35506a'];

interface Prepared {
  shape: CountryShape;
  tone: string;
  nation: string | null;
  /** Unit vector to the middle of each outline and how far its edge reaches, for culling */
  bounds: { c: V3; r: number }[];
  at: V3;
}

function prepare(shapes: CountryShape[]): Prepared[] {
  return shapes
    .map((shape, i) => {
      const bounds = shape.rings.map((ring) => {
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let k = 0; k < ring.length; k += 2) {
          const v = toVec(ring[k + 1], ring[k]);
          sx += v[0];
          sy += v[1];
          sz += v[2];
        }
        const c = norm([sx, sy, sz]);
        let r = 0;
        for (let k = 0; k < ring.length; k += 2) r = Math.max(r, angle(c, toVec(ring[k + 1], ring[k])));
        return { c, r };
      });
      return {
        shape,
        tone: TONES[(i * 7 + shape.name.length) % TONES.length],
        nation: GAME_COUNTRY[shape.name] ?? null,
        bounds,
        at: toVec(shape.lat, shape.lon),
      };
    })
    .sort((a, b) => b.shape.span - a.shape.span);
}

interface Leg {
  cityId: string;
  weapon: StrikeWeapon;
  lat: number;
  lon: number;
  /** The route, lifted off the globe in the middle like a real ballistic arc */
  path: { lat: number; lon: number; r: number }[];
}

const STEPS = 120;

function route(from: V3, to: V3): Leg['path'] {
  const span = angle(from, to);
  const lift = 0.05 + 0.2 * (span / Math.PI);
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS;
    const [lat, lon] = fromVec(slerp(from, to, t));
    return { lat, lon, r: 1 + lift * Math.sin(Math.PI * t) };
  });
}

function lerpCam(a: Cam, b: Cam, k: number): Cam {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const [lat, lon] = fromVec(norm(slerp(va, vb, k)));
  return { lat, lon, view: Math.exp(Math.log(a.view) * (1 - k) + Math.log(b.view) * k) };
}

const IMAGE_CACHE = new Map<string, HTMLImageElement>();
function loadImage(src: string) {
  let img = IMAGE_CACHE.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    IMAGE_CACHE.set(src, img);
  }
  return img;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The tracking shot: a real globe, real city positions and real great-circle
 * routes. The camera starts wide on the launch site and pushes in on the targets.
 */
export default function StrikeGlobe({ strike, ms }: { strike: StrikeShow; ms: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<Prepared[] | null>(null);

  const plan = useMemo(() => {
    const origin = launchSite(strike.from);
    const o = toVec(origin[0], origin[1]);
    const legs: Leg[] = strike.targets.map((t) => {
      const [lat, lon] = cityGeo(t.cityId);
      const weapon =
        t.weapons.find((w) => w === 'hydrogen') ??
        t.weapons.find((w) => w === 'magnetic') ??
        t.weapons.find((w) => w === 'nuke') ??
        t.weapons[0];
      return { cityId: t.cityId, weapon, lat, lon, path: route(o, toVec(lat, lon)) };
    });
    const all = [o, ...legs.map((l) => toVec(l.lat, l.lon))];
    const tv = legs.map((l) => toVec(l.lat, l.lon));
    const tcen = norm(tv.reduce<V3>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]));
    // Wide: halfway between the pad and the targets, so the whole flight fits
    const mid = norm([o[0] + tcen[0], o[1] + tcen[1], o[2] + tcen[2]]);
    const [mlat, mlon] = fromVec(mid);
    const wideReach = Math.max(...all.map((v) => angle(mid, v)));
    const wide: Cam = { lat: mlat, lon: mlon, view: clamp(wideReach * 1.55 + 0.14, 0.42, 1.5) };

    const tmid = tcen;
    const [tlat, tlon] = fromVec(tmid);
    const tReach = Math.max(...tv.map((v) => angle(tmid, v)));
    const tight: Cam = { lat: tlat + 2, lon: tlon, view: clamp(tReach * 2.6 + 0.1, 0.13, 0.7) };
    return { origin, legs, wide, tight };
  }, [strike]);

  useEffect(() => {
    import('../data/worldCountries').then((m) => {
      worldRef.current = prepare(m.COUNTRIES);
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const n = plan.legs.length;
    const attacker = nationDef(strike.from);
    const flagOf = (id: string) => loadImage(ART.flags[id as keyof typeof ART.flags]);
    const cityImgs = strike.targets.map((t) => loadImage(ART.moviePlate.city(t.cityId)));
    const attackerFlag = flagOf(strike.from);
    strike.targets.forEach((t) => flagOf(t.to));

    // When each route leaves and lands, as fractions of the shot
    const stagger = n > 1 ? Math.min(0.08, 0.3 / (n - 1)) : 0;
    const leave = (i: number) => (0.14 + i * stagger) * ms;
    const flight = 0.4 * ms;
    const land = (i: number) => leave(i) + flight;

    const start = performance.now();
    let raf = 0;

    const draw = (t: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const u = Math.min(W, H) / 100;

      ctx.fillStyle = '#02060c';
      ctx.fillRect(0, 0, W, H);

      const cam = lerpCam(plan.wide, plan.tight, smooth((t / ms - 0.3) / 0.4));
      const cx = W / 2;
      const cy = H * 0.57;
      const half = Math.min(W * 0.5, H * 0.42) * 0.98;
      const R = half / Math.sin(Math.min(cam.view, Math.PI / 2));
      const px = (p: Projected) => [cx + p.x * R, cy - p.y * R] as const;

      // Ocean
      const ocean = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R);
      ocean.addColorStop(0, '#12385a');
      ocean.addColorStop(0.7, '#0a2440');
      ocean.addColorStop(1, '#050f1e');
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = ocean;
      ctx.shadowColor = 'rgba(90, 170, 255, 0.55)';
      ctx.shadowBlur = Math.min(40, R * 0.12);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      // Graticule
      ctx.strokeStyle = 'rgba(140, 190, 255, 0.12)';
      ctx.lineWidth = 1;
      const line = (pts: { lat: number; lon: number }[]) => {
        ctx.beginPath();
        let pen = false;
        for (const q of pts) {
          const p = project(q.lat, q.lon, cam);
          if (p.z < 0) {
            pen = false;
            continue;
          }
          const [x, y] = px(p);
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
        ctx.stroke();
      };
      const gstep = cam.view < 0.4 ? 5 : cam.view < 0.8 ? 10 : 15;
      for (let lat = -80; lat <= 80; lat += gstep) {
        line(Array.from({ length: 73 }, (_, i) => ({ lat, lon: -180 + i * 5 })));
      }
      for (let lon = -180; lon < 180; lon += gstep) {
        line(Array.from({ length: 37 }, (_, i) => ({ lat: -90 + i * 5, lon })));
      }

      // Countries: each one filled, outlined where it meets its neighbours and the sea
      const world = worldRef.current;
      const camV = toVec(cam.lat, cam.lon);
      const stride = clamp(Math.floor(0.7 / (0.0011 * R)), 1, 6);
      const seeing = Math.min(Math.PI / 2, cam.view * 2.2 + 0.2);
      const hot = new Set<string>([strike.from, ...strike.targets.map((x) => x.to)]);
      if (world) {
        ctx.lineJoin = 'round';
        for (const c of world) {
          const fill =
            c.nation === strike.from ? '#2f6b52' : c.nation && hot.has(c.nation) ? '#6b3a3a' : c.tone;
          ctx.fillStyle = fill;
          ctx.strokeStyle = c.nation && hot.has(c.nation) ? 'rgba(255, 235, 215, 0.8)' : 'rgba(190, 225, 255, 0.5)';
          ctx.lineWidth = c.nation && hot.has(c.nation) ? Math.max(1.2, u * 0.18) : Math.max(0.8, u * 0.1);
          c.shape.rings.forEach((ring, ri) => {
            const bd = c.bounds[ri];
            if (angle(camV, bd.c) - bd.r > seeing) return;
            const poly = clipRing(ring, cam, stride);
            if (poly.length < 3) return;
            ctx.beginPath();
            poly.forEach(([x, y], i) => {
              const sx = cx + x * R;
              const sy = cy - y * R;
              if (i === 0) ctx.moveTo(sx, sy);
              else ctx.lineTo(sx, sy);
            });
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          });
        }
      }

      // Shade the limb so it reads as a ball
      const shade = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
      shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      shade.addColorStop(1, 'rgba(0, 4, 12, 0.7)');
      ctx.fillStyle = shade;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      // Country names, the way a printed globe sets them: spaced capitals that
      // only appear when the country is big enough on screen to carry them
      if (world) {
        const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
        for (const c of world) {
          if (!c.shape.name) continue;
          const p = project(c.shape.lat, c.shape.lon, cam);
          if (p.z < 0.28) continue;
          const widthPx = c.shape.span * D2R * R * p.z;
          const size = clamp(widthPx * 0.15, 0, u * 2.6);
          if (size < Math.max(7.5, u * 1.05)) continue;
          let text = c.shape.name.toUpperCase();
          ctx.font = `600 ${size}px "Helvetica Neue", Arial, sans-serif`;
          if ('letterSpacing' in spaced) spaced.letterSpacing = `${(size * 0.14).toFixed(1)}px`;
          let w = ctx.measureText(text).width;
          // Long names fall back to the short form a printed globe would use
          if (w > widthPx * 1.15 && LABEL_SHORT[c.shape.name]) {
            text = LABEL_SHORT[c.shape.name];
            w = ctx.measureText(text).width;
          }
          if (w > widthPx * 1.15) continue;
          const [x, y] = px(p);
          const box = { x0: x - w / 2 - 3, y0: y - size * 0.7, x1: x + w / 2 + 3, y1: y + size * 0.7 };
          if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
          placed.push(box);
          const hotName = c.nation != null && hot.has(c.nation);
          const fade = smooth((p.z - 0.28) / 0.35);
          ctx.globalAlpha = fade * (hotName ? 1 : 0.82);
          ctx.strokeStyle = 'rgba(4, 12, 24, 0.85)';
          ctx.lineWidth = Math.max(2, size * 0.3);
          ctx.strokeText(text, x, y);
          ctx.fillStyle = hotName ? '#fff4e0' : 'rgba(224, 238, 255, 0.92)';
          ctx.fillText(text, x, y);
        }
        ctx.globalAlpha = 1;
        if ('letterSpacing' in spaced) spaced.letterSpacing = '0px';
      }
      ctx.restore();

      // Launch site
      const oP = project(plan.origin[0], plan.origin[1], cam);
      const [ox, oy] = px(oP);
      const originIn = smooth(t / (ms * 0.1));
      if (oP.seen) {
        const ping = (t % 1400) / 1400;
        ctx.strokeStyle = `rgba(125, 255, 154, ${(1 - ping) * 0.8 * originIn})`;
        ctx.lineWidth = Math.max(1.5, u * 0.25);
        ctx.beginPath();
        ctx.arc(ox, oy, u * (0.8 + ping * 3.6), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#7dff9a';
        ctx.shadowColor = '#7dff9a';
        ctx.shadowBlur = u * 1.4;
        ctx.beginPath();
        ctx.arc(ox, oy, u * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Routes
      plan.legs.forEach((leg, i) => {
        const colour = TRACK_COLOUR[leg.weapon];
        const prog = easeInOut((t - leave(i)) / flight);
        const upto = Math.floor(prog * STEPS);
        if (prog <= 0) return;
        const pts = leg.path.slice(0, upto + 1).map((q) => ({ q, p: project(q.lat, q.lon, cam, q.r) }));

        // The whole flown path, dim, then the hot tail behind the head
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const stroke = (from: number, alpha: number, width: number, glow: number) => {
          ctx.beginPath();
          let pen = false;
          for (let k = from; k < pts.length; k++) {
            const { p } = pts[k];
            if (!p.seen) {
              pen = false;
              continue;
            }
            const [x, y] = px(p);
            if (pen) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
            pen = true;
          }
          ctx.strokeStyle = colour;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.shadowColor = colour;
          ctx.shadowBlur = glow;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        };
        stroke(0, 0.45, Math.max(1.2, u * 0.2), 0);
        stroke(Math.max(0, pts.length - 22), 0.95, Math.max(2, u * 0.4), u * 1.6);

        // The warhead itself
        const head = pts[pts.length - 1];
        if (prog < 1 && head.p.seen) {
          const [hx, hy] = px(head.p);
          const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, u * 2.4);
          g.addColorStop(0, '#ffffff');
          g.addColorStop(0.25, colour);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(hx, hy, u * 2.4, 0, Math.PI * 2);
          ctx.fill();
        }

        // The city, once the route lands
        const tp = project(leg.lat, leg.lon, cam);
        if (prog >= 1 && tp.seen) {
          const [tx, ty] = px(tp);
          const since = t - land(i);
          const ping = (since % 1100) / 1100;
          ctx.strokeStyle = colour;
          ctx.globalAlpha = (1 - ping) * 0.9;
          ctx.lineWidth = Math.max(1.5, u * 0.25);
          ctx.beginPath();
          ctx.arc(tx, ty, u * (0.9 + ping * 3.2), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = colour;
          ctx.shadowColor = colour;
          ctx.shadowBlur = u * 1.4;
          ctx.beginPath();
          ctx.arc(tx, ty, u * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });

      // Launch label
      if (oP.seen) {
        ctx.globalAlpha = originIn;
        ctx.font = `600 ${Math.max(11, u * 2.1)}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#7dff9a';
        const label = `${attacker.shortName.toUpperCase()} · LAUNCH`;
        const fw = u * 4.6;
        const fh = u * 3.1;
        const span = fw + u * 0.9 + ctx.measureText(label).width;
        const lx = Math.max(u * 2, Math.min(ox + u * 1.8, W - span - u * 2));
        const ly = oy + u * 3.4;
        if (attackerFlag.complete && attackerFlag.naturalWidth) ctx.drawImage(attackerFlag, lx, ly - fh / 2, fw, fh);
        ctx.fillText(label, lx + fw + u * 0.9, ly);
        ctx.globalAlpha = 1;
      }

      // Target cards, in a row along the top, tied to their cities by a line
      const avail = W - u * 6;
      const minW = u * 26;
      const cols = Math.max(1, Math.min(n, Math.floor(avail / (minW + u * 1.5))));
      const rows = Math.ceil(n / cols);
      const cw = Math.min(u * 44, (avail - (cols - 1) * u * 1.5) / cols);
      const ch = cw * 0.4;
      const gap = u * 1.5;
      // Left-to-right by where the cities sit on screen, so lines never cross
      const order = plan.legs
        .map((l, i) => ({ i, x: project(l.lat, l.lon, plan.tight).x }))
        .sort((a, b) => a.x - b.x)
        .map((o) => o.i);
      const top = Math.max(H * 0.17, u * 20);

      order.forEach((i, slot) => {
        const leg = plan.legs[i];
        const target = strike.targets[i];
        const arrive = land(i);
        const show = smooth((t - arrive) / 520);
        if (show <= 0) return;
        const row = Math.floor(slot / cols);
        const inRow = Math.min(cols, n - row * cols);
        const col = slot % cols;
        const rowW = inRow * cw + (inRow - 1) * gap;
        const x = (W - rowW) / 2 + col * (cw + gap);
        const y = top + row * (ch + gap) - (1 - show) * u * 3;
        const colour = TRACK_COLOUR[leg.weapon];

        // Tie line to the city
        const tp = project(leg.lat, leg.lon, cam);
        if (tp.seen) {
          const [tx, ty] = px(tp);
          ctx.globalAlpha = show * 0.85;
          ctx.strokeStyle = colour;
          ctx.lineWidth = Math.max(1, u * 0.18);
          ctx.setLineDash([u * 0.6, u * 0.5]);
          ctx.beginPath();
          ctx.moveTo(x + cw / 2, y + ch);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.globalAlpha = show;
        roundRect(ctx, x, y, cw, ch, u * 1.2);
        ctx.fillStyle = 'rgba(4, 10, 18, 0.86)';
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = Math.max(1, u * 0.2);
        ctx.stroke();

        // The city's picture
        const img = cityImgs[i];
        ctx.save();
        roundRect(ctx, x + u * 0.35, y + u * 0.35, ch - u * 0.7, ch - u * 0.7, u * 0.9);
        ctx.clip();
        if (img.complete && img.naturalWidth) {
          const side = img.naturalHeight;
          ctx.drawImage(img, (img.naturalWidth - side) / 2, 0, side, side, x + u * 0.35, y + u * 0.35, ch - u * 0.7, ch - u * 0.7);
        } else {
          ctx.fillStyle = '#10243a';
          ctx.fillRect(x, y, ch, ch);
        }
        ctx.restore();

        // Name, nation and flag
        const tx0 = x + ch + u * 0.8;
        const room = cw - ch - u * 1.4;
        let size = Math.max(11, u * 2.6);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${size}px Georgia, serif`;
        while (ctx.measureText(target.cityName).width > room && size > 9) {
          size -= 1;
          ctx.font = `700 ${size}px Georgia, serif`;
        }
        ctx.fillText(target.cityName, tx0, y + ch * 0.46);
        ctx.fillStyle = 'rgba(200, 215, 235, 0.85)';
        const sub = Math.max(9, u * 1.8);
        ctx.font = `500 ${sub}px ui-monospace, Menlo, monospace`;
        const flag = flagOf(target.to);
        const flw = sub * 1.5;
        const flh = sub * 1.0;
        const baseY = y + ch * 0.8;
        if (flag.complete && flag.naturalWidth) ctx.drawImage(flag, tx0, baseY - flh * 0.85, flw, flh);
        let nation = nationDef(target.to).name;
        while (ctx.measureText(nation).width > room - flw - 6 && nation.length > 3) nation = nation.slice(0, -1);
        ctx.fillText(nation, tx0 + flw + 6, baseY);
        ctx.globalAlpha = 1;
      });
      void rows;

      // Fade in from black
      const fade = 1 - smooth(t / (ms * 0.08));
      if (fade > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${fade})`;
        ctx.fillRect(0, 0, W, H);
      }
    };

    const loop = () => {
      draw(Math.min(ms, performance.now() - start));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [plan, strike, ms]);

  return <canvas ref={canvasRef} className="mv-globe" aria-hidden />;
}
