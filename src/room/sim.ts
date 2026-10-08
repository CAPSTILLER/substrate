// Substrate Room test: an "I Still"-style real-time take on Substrate.
// Pure TypeScript, no DOM. The room floor is the same hidden 10x10 Substrate map
// (seeded generateMap + commit hash). Hold to walk, stand still to scan, don't
// move while an eye is open, stand still and hold Claim to take a zone.
import {
  CONFIG, RIVAL_DEFS, YOU_COLOR, generateMap, commitHash, verifyCommit, narrow, probeWidth,
  claimHarvest, idx, xyOf, type Range, type Zone,
} from '../game';
import { makeRng, type Rng } from '../rng';

export const N = CONFIG.size; // 10
export const ZONE = 40; // world px per zone
export const ROOM_W = N * ZONE;
export const ROOM_H = N * ZONE;

export const ROOM = {
  duration: 120, // seconds per run
  startCredits: 60,
  playerSpeed: 92, // px/s (I Still uses 92 with 40px tiles)
  rivalSpeed: 48,
  radius: 9,
  moveThreshold: 16, // px/s: slower than this counts as standing still
  scanStep: 1.0, // seconds of stillness per completed scan
  rivalScanStep: 1.5,
  maxScans: 6,
  hintWidths: [0, 70, 90], // neighbour hint widths by ring (first scan of a still period only)
  claimHold: 0.8, // seconds of holding Claim while still
  claimCost: 10,
  hazardPenalty: 10,
  yieldEvery: 3, // seconds between payouts (120 s = 40 Substrate ticks)
  yieldRate: CONFIG.yieldRate, // per payout: value * rate * integrity%
  decayPerSec: 4, // integrity lost per second on your zones
  presenceRestore: 40, // integrity regained per second while standing on your zone
  spotCost: 8,
  spotPush: 30,
  spotCooldown: 1.1,
  stun: 0.35,
  startGrace: 1.5,
} as const;

export interface EyeDef {
  x: number; y: number; // world position (on the room edge)
  facing: number; // radians
  cone: number; // full cone angle
  range: number;
  closed: number; trans: number; open: number; offset: number;
  panAmp: number; panSpeed: number;
}

export interface Eye extends EyeDef {
  openAmt: number;
  facingNow: number;
  seesYou: boolean;
  canCatch: boolean;
}

export const DEFAULT_EYES: EyeDef[] = [
  { x: ROOM_W / 2, y: -10, facing: Math.PI / 2, cone: 0.95, range: 300, closed: 2.8, trans: 0.55, open: 2.2, offset: 0, panAmp: 0.6, panSpeed: 0.55 },
  { x: ROOM_W + 10, y: ROOM_H * 0.62, facing: Math.PI, cone: 0.9, range: 280, closed: 3.2, trans: 0.55, open: 2.0, offset: 2.9, panAmp: 0.55, panSpeed: 0.7 },
  { x: -10, y: ROOM_H * 0.86, facing: -0.55, cone: 0.85, range: 260, closed: 3.6, trans: 0.6, open: 1.8, offset: 5.1, panAmp: 0.45, panSpeed: 0.5 },
];

export type CellStatus = 'open' | 'owned' | 'dud' | 'hazard';

export interface RoomCell {
  known: Range; // what you know about the value
  scans: number; // completed direct scans by you
  status: CellStatus;
  owner: string | null;
  integrity: number;
}

export interface Actor {
  id: string; name: string; color: string;
  x: number; y: number; vx: number; vy: number;
  dir: number; anim: number;
  still: number; // seconds standing still
  scansThisStill: number;
  score: number; zones: number;
}

export interface Rival extends Actor {
  greed: number;
  known: Range[];
  scans: number[];
  target: number;
  think: number;
  wantScans: number;
}

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string }

export interface FloatText { x: number; y: number; text: string; color: string; life: number }

export interface Room {
  seed: string;
  map: Zone[];
  commit: string;
  cells: RoomCell[];
  you: Actor;
  credits: number;
  rivals: Rival[];
  eyes: Eye[];
  time: number;
  grace: number;
  stun: number;
  spotCooldown: number;
  spotted: number; // times spotted
  watched: boolean; // an open eye currently has you in its cone
  warning: boolean;
  claimProgress: number; // 0..1
  ended: boolean;
  endReason: string;
  verified: boolean | null;
  particles: Particle[];
  floats: FloatText[];
  trauma: number; flash: number; hitstop: number;
  yieldAcc: number;
  rng: { scan: Rng; rivals: Rng };
}

export interface RoomInput { mx: number; my: number; claim: boolean }

export interface RoomEvents {
  scan?: (zone: number, scans: number) => void;
  spotted?: () => void;
  claim?: (zone: number, kind: 'good' | 'dud' | 'hazard') => void;
  rivalClaim?: (rival: Rival, zone: number) => void;
  eyeOpen?: () => void;
  end?: () => void;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
function wrap(a: number) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

export const zoneAt = (x: number, y: number) => idx(clamp(Math.floor(x / ZONE), 0, N - 1), clamp(Math.floor(y / ZONE), 0, N - 1));
export const zoneCenter = (i: number) => { const { x, y } = xyOf(i); return { x: (x + 0.5) * ZONE, y: (y + 0.5) * ZONE }; };

export function eyeOpenAmount(t: number, e: EyeDef) {
  const period = e.closed + e.trans + e.open + e.trans;
  let u = (((t + e.offset) % period) + period) % period;
  if (u < e.closed) return 0;
  u -= e.closed;
  if (u < e.trans) return u / e.trans;
  u -= e.trans;
  if (u < e.open) return 1;
  u -= e.open;
  return 1 - u / e.trans;
}

export function inCone(e: Eye, x: number, y: number) {
  const dx = x - e.x, dy = y - e.y;
  if (Math.hypot(dx, dy) > e.range) return false;
  return Math.abs(wrap(Math.atan2(dy, dx) - e.facingNow)) <= e.cone / 2;
}

function actor(id: string, name: string, color: string, x: number, y: number): Actor {
  return { id, name, color, x, y, vx: 0, vy: 0, dir: 0, anim: 0, still: 0, scansThisStill: 0, score: 0, zones: 0 };
}

export interface RoomOptions { eyes?: EyeDef[]; rivals?: boolean }

export function makeRoom(seed: string, opts: RoomOptions = {}): Room {
  const map = generateMap(seed);
  const rng = { scan: makeRng(seed, 'room-scan'), rivals: makeRng(seed, 'room-rivals') };
  const corners = [[0.5, 0.5], [N - 0.5, 0.5], [0.5, N - 0.5]];
  const rivals: Rival[] = opts.rivals === false ? [] : RIVAL_DEFS.map((d, k) => ({
    ...actor(d.id, d.name, d.color, corners[k][0] * ZONE, corners[k][1] * ZONE),
    greed: d.greed + 12,
    known: Array.from({ length: N * N }, () => [0, 100] as Range),
    scans: new Array(N * N).fill(0),
    target: -1, think: 2 + k * 1.5, wantScans: 0,
  }));
  return {
    seed, map, commit: commitHash(seed, map),
    cells: Array.from({ length: N * N }, () => ({ known: [0, 100] as Range, scans: 0, status: 'open' as CellStatus, owner: null, integrity: 0 })),
    you: actor('you', 'You', YOU_COLOR, (N - 0.5) * ZONE, (N - 0.5) * ZONE),
    credits: ROOM.startCredits,
    rivals,
    eyes: (opts.eyes ?? DEFAULT_EYES).map((e) => ({ ...e, openAmt: 0, facingNow: e.facing, seesYou: false, canCatch: false })),
    time: 0, grace: ROOM.startGrace, stun: 0, spotCooldown: 0, spotted: 0,
    watched: false, warning: false, claimProgress: 0,
    ended: false, endReason: '', verified: null,
    particles: [], floats: [], trauma: 0, flash: 0, hitstop: 0, yieldAcc: 0, rng,
  };
}

function burst(r: Room, x: number, y: number, color: string, n: number, speed: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random());
    r.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.5, max: 0.9, size: 1.2 + Math.random() * 2.2, color });
  }
}
function float(r: Room, x: number, y: number, text: string, color: string) { r.floats.push({ x, y, text, color, life: 1.4 }); }

/** Move an actor; returns its speed. */
function move(a: Actor, mx: number, my: number, speed: number, dt: number) {
  a.vx = mx * speed; a.vy = my * speed;
  const sp = Math.hypot(a.vx, a.vy);
  a.x = clamp(a.x + a.vx * dt, ROOM.radius, ROOM_W - ROOM.radius);
  a.y = clamp(a.y + a.vy * dt, ROOM.radius, ROOM_H - ROOM.radius);
  if (sp > 1) { a.dir = Math.atan2(a.vy, a.vx); a.anim += dt * 7.2; } else a.anim += dt * 1.6;
  return sp;
}

/** Ring distance between two zones (Chebyshev). */
const ring = (a: number, b: number) => { const p = xyOf(a), q = xyOf(b); return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)); };

/** One completed scan on zone i: narrows known[i]; first scan of a still period also hints neighbours. */
function scanInto(known: Range[], scans: number[], map: Zone[], i: number, firstOfStill: boolean, rng: Rng) {
  scans[i] += 1;
  known[i] = narrow(known[i], map[i].value, probeWidth(scans[i]), rng);
  if (!firstOfStill) return;
  for (let j = 0; j < N * N; j++) {
    const d = ring(i, j);
    if (d === 0 || d > 2) continue;
    known[j] = narrow(known[j], map[j].value, ROOM.hintWidths[d], rng);
  }
}

/** Claim zone i for a seat. Players pay the stake; house rivals don't. Returns the outcome. */
export function claimZone(r: Room, i: number, who: Actor, ev: RoomEvents = {}): 'good' | 'dud' | 'hazard' | null {
  const c = r.cells[i];
  if (c.status !== 'open') return null;
  const z = r.map[i];
  const isYou = who === r.you;
  const { x, y } = zoneCenter(i);
  if (isYou) r.credits -= ROOM.claimCost;
  let kind: 'good' | 'dud' | 'hazard';
  if (z.hazard) {
    kind = 'hazard'; c.status = 'hazard'; c.owner = who.id;
    if (isYou) { r.credits -= ROOM.hazardPenalty; r.flash = 0.8; r.trauma = 0.7; float(r, x, y, `-${ROOM.claimCost + ROOM.hazardPenalty} hazard`, '#ff5d73'); }
    burst(r, x, y, '#ff5d73', 16, 70);
  } else if (z.value < CONFIG.claimThreshold) {
    kind = 'dud'; c.status = 'dud'; c.owner = who.id;
    if (isYou) float(r, x, y, `-${ROOM.claimCost} dud`, '#86b3a6');
    burst(r, x, y, '#5a6b66', 10, 40);
  } else {
    kind = 'good'; c.status = 'owned'; c.owner = who.id; c.integrity = 100;
    const h = claimHarvest(z.value);
    who.score = r1(who.score + h); who.zones += 1;
    if (isYou) { r.credits = r1(r.credits + h); float(r, x, y, `+${h}`, '#19f5b0'); }
    burst(r, x, y, who.color, 22, 75);
  }
  if (isYou) ev.claim?.(i, kind);
  return kind;
}

function endRun(r: Room, reason: string, ev: RoomEvents) {
  if (r.ended) return;
  r.ended = true; r.endReason = reason; r.claimProgress = 0;
  r.verified = verifyCommit(r.seed, r.commit);
  ev.end?.();
}

function stepRival(r: Room, k: Rival, dt: number, ev: RoomEvents) {
  const rng = r.rng.rivals;
  // Obey the watchers (loosely): freeze while an open eye has you in its cone.
  const watched = r.eyes.some((e) => e.openAmt > 0.5 && inCone(e, k.x, k.y));
  let mx = 0, my = 0;
  if (k.target < 0 || r.cells[k.target].status !== 'open') {
    k.think -= dt;
    if (k.think <= 0) {
      // Pick a target: best estimated value, minus distance, plus noise.
      let best = -1, bestScore = -1e9;
      const here = zoneAt(k.x, k.y);
      for (let i = 0; i < N * N; i++) {
        if (r.cells[i].status !== 'open') continue;
        const [lo, hi] = k.known[i];
        const est = (lo + hi) / 2 - (hi - lo) * 0.15;
        const s = est - ring(here, i) * 5 + rng() * 40;
        if (s > bestScore) { bestScore = s; best = i; }
      }
      k.target = best; k.wantScans = 3 + Math.floor(rng() * 3); k.think = 2.5 + rng() * 3;
    }
  }
  if (k.target >= 0 && !watched) {
    const c = zoneCenter(k.target);
    const dx = c.x - k.x, dy = c.y - k.y, d = Math.hypot(dx, dy);
    if (d > 6) { mx = dx / d; my = dy / d; }
  }
  const sp = move(k, mx, my, ROOM.rivalSpeed, dt);
  if (sp > ROOM.moveThreshold) { k.still = 0; k.scansThisStill = 0; return; }
  if (k.target < 0) return;
  const here = zoneAt(k.x, k.y);
  if (here !== k.target) return;
  k.still += dt;
  if (k.still >= ROOM.rivalScanStep * (k.scansThisStill + 1) && k.scans[here] < ROOM.maxScans) {
    scanInto(k.known, k.scans, r.map, here, k.scansThisStill === 0, rng);
    k.scansThisStill += 1;
  }
  if (k.scansThisStill >= k.wantScans || k.scans[here] >= ROOM.maxScans) {
    const [lo, hi] = k.known[here];
    if (lo >= k.greed - 10 && (lo + hi) / 2 >= k.greed) {
      const kind = claimZone(r, here, k, ev);
      if (kind) ev.rivalClaim?.(k, here);
    }
    k.target = -1; k.still = 0; k.scansThisStill = 0; k.think = 3 + rng() * 3;
  }
}

export function stepRoom(r: Room, input: RoomInput, dt: number, ev: RoomEvents = {}) {
  if (r.ended) { stepFx(r, dt); return; }
  if (r.hitstop > 0) { r.hitstop = Math.max(0, r.hitstop - dt); dt *= 0.15; }
  r.time += dt;
  r.grace = Math.max(0, r.grace - dt);
  r.stun = Math.max(0, r.stun - dt);
  r.spotCooldown = Math.max(0, r.spotCooldown - dt);
  r.trauma = Math.max(0, r.trauma - dt * 1.8);
  r.flash = Math.max(0, r.flash - dt * 2.4);

  // Eyes
  for (const e of r.eyes) {
    const was = e.openAmt > 0.55;
    e.openAmt = eyeOpenAmount(r.time, e);
    e.facingNow = e.facing + Math.sin(r.time * e.panSpeed + e.offset) * e.panAmp;
    if (e.openAmt > 0.55 && !was) ev.eyeOpen?.();
  }

  // You
  const p = r.you;
  let mx = input.mx, my = input.my;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  if (r.stun > 0) { mx = 0; my = 0; }
  const speed = move(p, mx, my, ROOM.playerSpeed, dt);
  const moving = speed > ROOM.moveThreshold;

  let watched = false, warning = false;
  for (const e of r.eyes) {
    const vis = inCone(e, p.x, p.y);
    e.seesYou = vis && e.openAmt > 0.32;
    e.canCatch = vis && e.openAmt >= 0.8;
    if (e.seesYou) watched = true;
    if (vis && e.openAmt > 0.05) warning = true;
  }
  r.watched = watched; r.warning = warning;

  if (moving && r.grace <= 0 && r.spotCooldown <= 0) {
    const e = r.eyes.find((q) => q.canCatch);
    if (e) {
      r.spotted += 1;
      r.credits -= ROOM.spotCost;
      const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1;
      p.x = clamp(p.x + (dx / d) * ROOM.spotPush, ROOM.radius, ROOM_W - ROOM.radius);
      p.y = clamp(p.y + (dy / d) * ROOM.spotPush, ROOM.radius, ROOM_H - ROOM.radius);
      p.vx = 0; p.vy = 0;
      r.stun = ROOM.stun; r.spotCooldown = ROOM.spotCooldown;
      r.trauma = 1; r.hitstop = 0.14; r.flash = 1;
      burst(r, p.x, p.y, '#ff5d73', 18, 70);
      float(r, p.x, p.y - 18, `-${ROOM.spotCost} spotted`, '#ff5d73');
      ev.spotted?.();
    }
  }

  const here = zoneAt(p.x, p.y);
  const cell = r.cells[here];
  if (moving) {
    p.still = 0; p.scansThisStill = 0; r.claimProgress = 0;
  } else {
    p.still += dt;
    if (p.still >= ROOM.scanStep * (p.scansThisStill + 1)) {
      p.scansThisStill += 1;
      if (cell.scans < ROOM.maxScans) {
        const known = r.cells.map((c) => c.known);
        const scans = r.cells.map((c) => c.scans);
        scanInto(known, scans, r.map, here, p.scansThisStill === 1, r.rng.scan);
        r.cells.forEach((c, i) => { c.known = known[i]; c.scans = scans[i]; });
        ev.scan?.(here, cell.scans);
      }
    }
    // Maintain by presence
    if (cell.status === 'owned' && cell.owner === p.id) cell.integrity = Math.min(100, cell.integrity + ROOM.presenceRestore * dt);
    // Claim (hold)
    if (input.claim && cell.status === 'open') {
      r.claimProgress += dt / ROOM.claimHold;
      if (r.claimProgress >= 1) { r.claimProgress = 0; claimZone(r, here, p, ev); }
    } else r.claimProgress = 0;
  }

  // Decay your zones
  for (let i = 0; i < r.cells.length; i++) {
    const c = r.cells[i];
    if (c.status === 'owned' && c.owner === p.id && !(i === here && !moving)) c.integrity = Math.max(0, c.integrity - ROOM.decayPerSec * dt);
  }

  for (const k of r.rivals) stepRival(r, k, dt, ev);

  // Payout pulse every few seconds
  r.yieldAcc += dt;
  while (r.yieldAcc >= ROOM.yieldEvery) {
    r.yieldAcc -= ROOM.yieldEvery;
    for (let i = 0; i < r.cells.length; i++) {
      const c = r.cells[i];
      if (c.status !== 'owned') continue;
      const v = r.map[i].value;
      if (c.owner === p.id) {
        const y = r1((v * ROOM.yieldRate * c.integrity) / 100);
        p.score = r1(p.score + y); r.credits = r1(r.credits + y);
      } else {
        const k = r.rivals.find((q) => q.id === c.owner);
        if (k) k.score = r1(k.score + r1(v * ROOM.yieldRate));
      }
    }
  }

  stepFx(r, dt);
  if (r.credits <= 0) { r.credits = Math.max(0, r.credits); endRun(r, 'Out of credits.', ev); }
  else if (r.time >= ROOM.duration) endRun(r, 'Time is up.', ev);
}

function stepFx(r: Room, dt: number) {
  for (let i = r.particles.length - 1; i >= 0; i--) {
    const q = r.particles[i];
    q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.92; q.vy *= 0.92;
    if (q.life <= 0) r.particles.splice(i, 1);
  }
  if (r.particles.length > 120) r.particles.splice(0, r.particles.length - 120);
  for (let i = r.floats.length - 1; i >= 0; i--) {
    const f = r.floats[i]; f.life -= dt; f.y -= 16 * dt;
    if (f.life <= 0) r.floats.splice(i, 1);
  }
}

/** Seconds of stillness left until the next scan completes (0..1 charge). */
export const scanCharge = (r: Room) => r.ended ? 0 : (r.you.still % ROOM.scanStep) / ROOM.scanStep;

export function standings(r: Room) {
  return [r.you, ...r.rivals].map((a) => ({ id: a.id, name: a.name, color: a.color, score: Math.floor(a.score), zones: a.zones, you: a === r.you }))
    .sort((a, b) => b.score - a.score);
}
