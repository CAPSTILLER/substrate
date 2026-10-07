// Substrate core game logic. Pure TypeScript, no DOM, so it can be unit tested
// and later run on a server (x402 / agent play).
import { makeRng, type Rng } from './rng';
import { sha256Hex } from './sha256';

export const CONFIG = {
  size: 10,
  startCredits: 100,
  maxTicks: 40,
  probeCost: 3,
  claimCost: 10,
  maintainCost: 4,
  /** Zones worth less than this are duds: a claim loses its stake. */
  claimThreshold: 20,
  /** Extra credits lost when you claim a hazard zone (on top of the stake). */
  hazardPenalty: 10,
  /** A good claim instantly harvests this share of the zone value. */
  claimHarvestRate: 0.5,
  /** Each tick, an owned zone yields value * yieldRate * integrity%. */
  yieldRate: 0.05,
  /** Integrity lost per tick on your zones (Maintain restores to 100). */
  decayPerTick: 10,
  /** Width of the first direct probe reading; each repeat probe shrinks it. */
  probeBaseWidth: 40,
  probeShrink: 0.6,
  minWidth: 4,
  /** Hint widths for neighbours, by ring distance (index 1 = adjacent). */
  neighborWidths: [0, 70, 90],
  /** Chance a direct probe on a hazard flags it as unstable. */
  hazardDetectChance: 0.7,
  veinsMin: 3,
  veinsMax: 4,
  hazards: 6,
  empties: 8,
} as const;

export type Config = typeof CONFIG;
export type Range = [number, number];

export interface Zone {
  value: number; // 0..100
  hazard: boolean;
}

export type ZoneStatus = 'open' | 'owned' | 'dud' | 'hazard' | 'depleted';

export interface Cell {
  known: Range; // what YOU (the local human seat) know about this zone's value
  probes: number; // your direct probes on it
  hazardFlag: boolean; // your probes flagged it as unstable
  status: ZoneStatus;
  owner: string | null; // seat id: 'you', a house bot id, or an agent id
  integrity: number; // 0..100 for owned zones
  ping: string | null; // house seat id that probed it this tick
}

/**
 * A seat at an arena table. 'house' seats are driven by the built-in AI and play
 * by the house rules (no credits, no decay). 'human' and 'agent' seats play by the
 * player rules (credits, decay, maintain) and are driven by the UI or the API.
 * Live players / agents later replace house seats one for one.
 */
export type SeatKind = 'human' | 'house' | 'agent';

export interface SeatDef {
  id: string;
  kind: SeatKind;
  name: string;
  color: string;
  /** House AI personality family (vex, orin, null, ...). */
  family?: string;
  actChance?: number;
  greed?: number;
  maxWidth?: number;
}

export interface Seat {
  id: string;
  kind: SeatKind;
  name: string;
  color: string;
  family: string;
  score: number;
  zones: number;
  credits: number;
  probesUsed: number;
  claimsMade: number;
  actChance: number;
  greed: number; // claim when estimated mid >= greed ...
  maxWidth: number; // ... and their range is at most this wide
  known: Range[];
  probes: number[];
  hazardKnown: boolean[];
  /** Player seats only: busted before the round ended (round keeps going). */
  out: boolean;
  outReason: string;
}

/** Back-compat alias: rivals are just the other seats. */
export type Rival = Seat;

export interface LogEntry {
  tick: number;
  kind: 'you' | 'good' | 'bad' | 'rival' | 'info';
  text: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  range?: Range;
  harvested?: number;
}

export type ActionKind = 'probe' | 'claim' | 'maintain' | 'wait';

export const YOU = 'you';
export const YOU_COLOR = '#3ee6ff';

export const RIVAL_DEFS = [
  { id: 'vex', name: 'Vex-7', color: '#ff4fd8', actChance: 0.8, greed: 32, maxWidth: 36 },
  { id: 'orin', name: 'Orin', color: '#ffb23f', actChance: 0.8, greed: 40, maxWidth: 22 },
  { id: 'null', name: 'Null.Kid', color: '#a6ff4d', actChance: 0.8, greed: 36, maxWidth: 28 },
] as const;

/** The original single-table line-up: you plus Vex-7, Orin and Null.Kid. */
export const DEFAULT_SEATS: SeatDef[] = [
  { id: YOU, kind: 'human', name: 'You', color: YOU_COLOR },
  ...RIVAL_DEFS.map((d) => ({ ...d, family: d.id, kind: 'house' as const })),
];

export interface GameOptions {
  seats?: SeatDef[];
  /**
   * Arena mode: the round always runs to maxTicks. A busted player seat is marked
   * `out` instead of ending the game, and actions don't advance the clock
   * (the World advances every arena together).
   */
  roundMode?: boolean;
  /** Advance one tick after each tick-using action. Default: !roundMode. */
  autoAdvance?: boolean;
}

const COLS = 'ABCDEFGHIJKLMNOP';
export const idx = (x: number, y: number, size: number = CONFIG.size) => y * size + x;
export const xyOf = (i: number, size: number = CONFIG.size) => ({ x: i % size, y: Math.floor(i / size) });
export const zoneLabel = (x: number, y: number) => `${COLS[x]}${y + 1}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Deterministic hidden map: mostly low noise, a few rich veins, some empty and hazard zones. */
export function generateMap(seed: string, cfg: Config = CONFIG): Zone[] {
  const rng = makeRng(seed, 'map');
  const n = cfg.size * cfg.size;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(Math.pow(rng(), 2) * 14); // background: mostly 0-6, up to 14

  const veinCount = cfg.veinsMin + Math.floor(rng() * (cfg.veinsMax - cfg.veinsMin + 1));
  const centers: number[] = [];
  for (let v = 0; v < veinCount; v++) {
    const cx = Math.floor(rng() * cfg.size);
    const cy = Math.floor(rng() * cfg.size);
    const peak = 60 + rng() * 40;
    const sigma = 0.8 + rng() * 0.45;
    centers.push(idx(cx, cy, cfg.size));
    for (let i = 0; i < n; i++) {
      const { x, y } = xyOf(i, cfg.size);
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      raw[i] += peak * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
  const map: Zone[] = raw.map((v) => ({ value: Math.round(clamp(v, 0, 100)), hazard: false }));

  // Empty zones and hazards only land on poor ground, never on a vein centre.
  const pickPoor = (count: number, apply: (z: Zone) => void) => {
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < 1000) {
      const i = Math.floor(rng() * n);
      const z = map[i];
      if (centers.includes(i) || z.hazard || z.value === 0 || z.value >= 30) continue;
      apply(z);
      placed++;
    }
  };
  pickPoor(cfg.empties, (z) => { z.value = 0; });
  pickPoor(cfg.hazards, (z) => { z.value = 0; z.hazard = true; });
  return map;
}

/** Canonical map string used in the commit: values row by row, H for hazards. */
export function serializeMap(map: Zone[]): string {
  return map.map((z) => (z.hazard ? 'H' : String(z.value))).join(',');
}

/** Commit = sha256(seed | map). Shown at start, verifiable at the end. */
export function commitHash(seed: string, map: Zone[]): string {
  return sha256Hex(`substrate-v1|${seed}|${serializeMap(map)}`);
}

export function verifyCommit(seed: string, commit: string, cfg: Config = CONFIG): boolean {
  return commitHash(seed, generateMap(seed, cfg)) === commit;
}

/** Width of the n-th direct probe reading (n starts at 1). */
export function probeWidth(n: number, cfg: Config = CONFIG): number {
  return Math.max(cfg.minWidth, cfg.probeBaseWidth * Math.pow(cfg.probeShrink, n - 1));
}

/**
 * Take a fuzzy reading of width `width` that always contains the true value,
 * then intersect it with what was already known. Ranges only ever shrink.
 */
export function narrow(known: Range, value: number, width: number, rng: Rng): Range {
  let lo = value - rng() * width;
  let hi = lo + width;
  if (lo < 0) { hi -= lo; lo = 0; }
  if (hi > 100) { lo = Math.max(0, lo - (hi - 100)); hi = 100; }
  const rlo = Math.floor(lo);
  const rhi = Math.ceil(hi);
  return [Math.max(known[0], rlo), Math.min(known[1], rhi)];
}

export const claimHarvest = (value: number, cfg: Config = CONFIG) => Math.round(value * cfg.claimHarvestRate);
export const tickYield = (value: number, integrity: number, cfg: Config = CONFIG) =>
  round1((value * cfg.yieldRate * integrity) / 100);
export const decay = (integrity: number, cfg: Config = CONFIG) => Math.max(0, integrity - cfg.decayPerTick);

export function signalWord(range: Range): string {
  const mid = (range[0] + range[1]) / 2;
  if (range[1] - range[0] >= 100) return 'no reading';
  if (mid < 12) return 'faint';
  if (mid < 25) return 'weak';
  if (mid < 45) return 'moderate';
  if (mid < 65) return 'strong';
  return 'intense';
}

export class Game {
  readonly cfg: Config;
  readonly seed: string;
  readonly commit: string;
  readonly map: Zone[];
  readonly cells: Cell[];
  readonly seats: Seat[];
  readonly roundMode: boolean;
  autoAdvance: boolean;
  tick = 0;
  over = false;
  endReason = '';
  log: LogEntry[] = [];
  private seatRngs = new Map<string, Rng>();
  private rivalRng: Rng;

  constructor(seed: string, cfg: Config = CONFIG, opts: GameOptions = {}) {
    this.cfg = cfg;
    this.seed = seed;
    this.roundMode = !!opts.roundMode;
    this.autoAdvance = opts.autoAdvance ?? !this.roundMode;
    this.map = generateMap(seed, cfg);
    this.commit = commitHash(seed, this.map);
    this.rivalRng = makeRng(seed, 'rivals');
    const n = cfg.size * cfg.size;
    this.cells = Array.from({ length: n }, () => ({
      known: [0, 100] as Range, probes: 0, hazardFlag: false, status: 'open' as ZoneStatus,
      owner: null, integrity: 0, ping: null,
    }));
    const defs = opts.seats ?? DEFAULT_SEATS;
    if (new Set(defs.map((d) => d.id)).size !== defs.length) throw new Error('Seat ids must be unique');
    this.seats = defs.map((d) => this.makeSeat(d));
    this.push('info', 'Scouts online. The substrate is sealed; read it before the rivals do.');
  }

  get size() { return this.cfg.size; }

  private makeSeat(d: SeatDef): Seat {
    const n = this.cfg.size * this.cfg.size;
    return {
      id: d.id, kind: d.kind, name: d.name, color: d.color, family: d.family ?? d.id,
      score: 0, zones: 0, credits: this.cfg.startCredits, probesUsed: 0, claimsMade: 0,
      actChance: d.actChance ?? 0.8, greed: d.greed ?? 36, maxWidth: d.maxWidth ?? 28,
      known: Array.from({ length: n }, () => [0, 100] as Range),
      probes: new Array(n).fill(0),
      hazardKnown: new Array(n).fill(false),
      out: false, outReason: '',
    };
  }

  seat(id: string | null | undefined): Seat | undefined {
    return id ? this.seats.find((s) => s.id === id) : undefined;
  }
  /** The local human seat, if one sits at this table. */
  get you(): Seat | undefined { return this.seat(YOU); }
  /** Every seat except the local human (house bots, other players, agents). */
  get rivals(): Seat[] { return this.seats.filter((s) => s.id !== YOU); }

  // Back-compat accessors for the local human seat.
  get credits() { return this.you?.credits ?? 0; }
  set credits(v: number) { if (this.you) this.you.credits = v; }
  get score() { return this.you?.score ?? 0; }
  set score(v: number) { if (this.you) this.you.score = v; }
  get probesUsed() { return this.you?.probesUsed ?? 0; }
  get claimsMade() { return this.you?.claimsMade ?? 0; }

  private push(kind: LogEntry['kind'], text: string) {
    this.log.push({ tick: this.tick, kind, text });
    if (this.log.length > 60) this.log.shift();
  }

  private inBounds(x: number, y: number) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  private rngFor(s: Seat): Rng {
    let r = this.seatRngs.get(s.id);
    if (!r) {
      r = makeRng(this.seed, s.id === YOU ? 'probe' : `probe:${s.id}`);
      this.seatRngs.set(s.id, r);
    }
    return r;
  }

  /** Mirror the local human seat's knowledge into `cells` (what the UI draws). */
  private syncYou() {
    const y = this.you;
    this.cells.forEach((c, i) => {
      c.known = y ? y.known[i] : [0, 100];
      c.probes = y ? y.probes[i] : 0;
      c.hazardFlag = y ? y.hazardKnown[i] : false;
    });
  }

  /** A zone resolved in public (claimed / dud / hazard): everyone now knows it. */
  private resolveKnown(i: number, r: Range) {
    for (const s of this.seats) s.known[i] = r;
    this.cells[i].known = r;
  }

  /** Apply a probe at (x,y) to a knowledge map: sharp reading there, fainter hints around it. */
  private scan(known: Range[], probes: number[], x: number, y: number, rng: Rng) {
    const i = idx(x, y, this.size);
    probes[i]++;
    known[i] = narrow(known[i], this.map[i].value, probeWidth(probes[i], this.cfg), rng);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d === 0 || !this.inBounds(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy, this.size);
        known[j] = narrow(known[j], this.map[j].value, this.cfg.neighborWidths[d], rng);
      }
    }
    return known[i];
  }

  ownedBy(seatId: string): number[] {
    const out: number[] = [];
    this.cells.forEach((c, i) => { if (c.owner === seatId) out.push(i); });
    return out;
  }
  ownedByYou(): number[] { return this.ownedBy(YOU); }

  /**
   * Knowledge to draw for a viewer. With a seat id: that seat's own readings.
   * Without: the intersection of every seat's readings (spectator / art view).
   * Intersections are always valid because every reading contains the true value.
   */
  knowledge(seatId?: string): { known: Range[]; probes: number[]; hazard: boolean[] } {
    const s = this.seat(seatId);
    if (s) return { known: s.known, probes: s.probes, hazard: s.hazardKnown };
    const n = this.cells.length;
    const known: Range[] = new Array(n);
    const probes: number[] = new Array(n).fill(0);
    const hazard: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      let lo = 0;
      let hi = 100;
      for (const st of this.seats) {
        const k = st.known[i];
        if (k[0] > lo) lo = k[0];
        if (k[1] < hi) hi = k[1];
        probes[i] += st.probes[i];
        if (st.hazardKnown[i]) hazard[i] = true;
      }
      known[i] = [lo, Math.max(lo, hi)];
    }
    return { known, probes, hazard };
  }

  /** Generic action entry point for player seats (human or agent). */
  act(seatId: string, kind: ActionKind, x = -1, y = -1): ActionResult {
    if (this.over) return { ok: false, message: 'Run is over.' };
    const s = this.seat(seatId);
    if (!s) return { ok: false, message: 'No such seat at this table.' };
    if (s.kind === 'house') return { ok: false, message: 'House seats are driven by the house AI.' };
    if (s.out) return { ok: false, message: `${s.id === YOU ? "You're" : `${s.name} is`} out for this round (${s.outReason.replace(/\.$/, '')}).` };
    switch (kind) {
      case 'probe': return this.doProbe(s, x, y);
      case 'claim': return this.doClaim(s, x, y);
      case 'maintain': return this.doMaintain(s, x, y);
      case 'wait': return this.doWait(s);
    }
    return { ok: false, message: 'Unknown action.' };
  }

  probe(x: number, y: number): ActionResult { return this.act(YOU, 'probe', x, y); }
  claim(x: number, y: number): ActionResult { return this.act(YOU, 'claim', x, y); }
  /** Restore one of your zones to 100% integrity. Does not use a tick. */
  maintain(x: number, y: number): ActionResult { return this.act(YOU, 'maintain', x, y); }
  /** Let one tick pass without acting (yields still flow, rivals still move). */
  endTurn(): ActionResult { return this.act(YOU, 'wait'); }

  private say(s: Seat, kind: LogEntry['kind'], mine: string, theirs: string) {
    if (s.id === YOU) this.push(kind, mine);
    else this.push('rival', theirs);
  }

  private doProbe(s: Seat, x: number, y: number): ActionResult {
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const i = idx(x, y, this.size);
    if (this.cells[i].status !== 'open') return { ok: false, message: `${zoneLabel(x, y)} is already resolved.` };
    if (s.credits < this.cfg.probeCost) return { ok: false, message: 'Not enough credits to probe.' };
    s.credits -= this.cfg.probeCost;
    s.probesUsed++;
    const rng = this.rngFor(s);
    const range = this.scan(s.known, s.probes, x, y, rng);
    let msg = `Probed ${zoneLabel(x, y)}: signal ${range[0]}–${range[1]} (${signalWord(range)}).`;
    if (this.map[i].hazard && !s.hazardKnown[i] && rng() < this.cfg.hazardDetectChance) {
      s.hazardKnown[i] = true;
      msg += ' ⚠ Unstable readings.';
    }
    if (s.id === YOU) this.syncYou();
    this.say(s, 'you', msg, `${s.name} probed ${zoneLabel(x, y)}.`);
    this.afterTickAction();
    return { ok: true, message: msg, range };
  }

  private doClaim(s: Seat, x: number, y: number): ActionResult {
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const i = idx(x, y, this.size);
    const c = this.cells[i];
    if (c.status !== 'open') return { ok: false, message: `${zoneLabel(x, y)} can't be claimed.` };
    if (s.credits < this.cfg.claimCost) return { ok: false, message: 'Not enough credits to claim.' };
    s.credits -= this.cfg.claimCost;
    s.claimsMade++;
    const z = this.map[i];
    const L = zoneLabel(x, y);
    let res: ActionResult;
    if (z.hazard) {
      c.status = 'hazard';
      this.resolveKnown(i, [0, 0]);
      s.credits = Math.max(0, s.credits - this.cfg.hazardPenalty);
      res = { ok: true, message: `Hazard at ${L}! Stake lost and −${this.cfg.hazardPenalty} more.`, harvested: 0 };
      this.say(s, 'bad', res.message, `${s.name} hit a hazard at ${L}.`);
    } else if (z.value < this.cfg.claimThreshold) {
      c.status = 'dud';
      this.resolveKnown(i, [z.value, z.value]);
      res = { ok: true, message: `${L} was a dud (value ${z.value}). Stake lost.`, harvested: 0 };
      this.say(s, 'bad', res.message, `${s.name} claimed a dud at ${L}.`);
    } else {
      const h = claimHarvest(z.value, this.cfg);
      c.status = 'owned';
      c.owner = s.id;
      c.integrity = 100;
      s.zones++;
      this.resolveKnown(i, [z.value, z.value]);
      s.score = round1(s.score + h);
      s.credits = round1(s.credits + h);
      res = { ok: true, message: `Claimed ${L} (value ${z.value}). Harvested +${h}.`, harvested: h };
      this.say(s, 'good', res.message, `${s.name} claimed ${L}.`);
    }
    this.afterTickAction();
    return res;
  }

  private doMaintain(s: Seat, x: number, y: number): ActionResult {
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const c = this.cells[idx(x, y, this.size)];
    if (c.owner !== s.id) return { ok: false, message: 'You can only maintain your own zones.' };
    if (c.integrity >= 100) return { ok: false, message: 'Already at full integrity.' };
    if (s.credits < this.cfg.maintainCost) return { ok: false, message: 'Not enough credits to maintain.' };
    s.credits = round1(s.credits - this.cfg.maintainCost);
    c.integrity = 100;
    const msg = `Maintained ${zoneLabel(x, y)} back to 100%.`;
    if (s.id === YOU) this.push('you', msg);
    return { ok: true, message: msg };
  }

  private doWait(s: Seat): ActionResult {
    if (s.id === YOU) this.push('you', 'You hold position.');
    this.afterTickAction();
    return { ok: true, message: 'Tick passed.' };
  }

  private afterTickAction() {
    if (this.autoAdvance) this.advance();
  }

  /**
   * One clock tick for this table: house seats move, every owned zone yields,
   * player zones decay, then end conditions are checked. In arena mode the
   * World calls this on all 25 tables together.
   */
  advance() {
    if (this.over) return;
    this.cells.forEach((c) => { c.ping = null; });
    for (const s of this.seats) if (s.kind === 'house') this.houseTurn(s);

    const gained = new Map<Seat, number>();
    this.cells.forEach((c, i) => {
      if (c.status !== 'owned') return;
      const s = this.seat(c.owner);
      if (!s) return;
      const v = this.map[i].value;
      if (s.kind === 'house') {
        s.score = round1(s.score + tickYield(v, 100, this.cfg));
        return;
      }
      gained.set(s, (gained.get(s) ?? 0) + tickYield(v, c.integrity, this.cfg));
      c.integrity = decay(c.integrity, this.cfg);
      if (c.integrity <= 0) {
        c.status = 'depleted';
        c.owner = null;
        s.zones = Math.max(0, s.zones - 1);
        const { x, y } = xyOf(i, this.size);
        this.say(s, 'bad', `${zoneLabel(x, y)} collapsed from decay.`, `${s.name}'s ${zoneLabel(x, y)} collapsed.`);
      }
    });
    for (const [s, y] of gained) {
      if (y > 0) {
        s.score = round1(s.score + y);
        s.credits = round1(s.credits + y);
      }
    }
    this.tick++;
    this.checkEnd();
  }

  private checkEnd() {
    if (this.over) return;
    if (this.tick >= this.cfg.maxTicks) return this.finish('Signal window closed.');
    for (const s of this.seats) {
      if (s.kind === 'house' || s.out) continue;
      if (s.credits < this.cfg.probeCost && this.ownedBy(s.id).length === 0) {
        if (!this.roundMode && s.id === YOU) return this.finish('Out of credits.');
        s.out = true;
        s.outReason = 'Out of credits.';
        this.say(s, 'bad', 'Out of credits. The round keeps going without you.', `${s.name} is out of credits.`);
      }
    }
    if (!this.roundMode && this.you && !this.cells.some((c) => c.status === 'open') && this.ownedByYou().length === 0) {
      return this.finish('Nothing left to scout.');
    }
  }

  private finish(reason: string) {
    this.over = true;
    this.endReason = reason;
    const y = this.you;
    this.push('info', y
      ? `${reason} Final score ${Math.floor(y.score)}. Seed revealed: ${this.seed}.`
      : `${reason} Seed revealed: ${this.seed}.`);
  }

  /**
   * Swap who sits in a seat (house bot -> human / agent, or back). The leaving
   * occupant's zones collapse; the newcomer starts fresh with full credits.
   */
  replaceSeat(oldId: string, def: SeatDef): Seat {
    const k = this.seats.findIndex((s) => s.id === oldId);
    if (k < 0) throw new Error(`No seat ${oldId}`);
    if (def.id !== oldId && this.seat(def.id)) throw new Error(`Seat id ${def.id} already taken`);
    const old = this.seats[k];
    this.cells.forEach((c) => {
      if (c.owner === old.id) { c.owner = null; c.status = 'depleted'; c.integrity = 0; }
    });
    const seat = this.makeSeat(def);
    this.seats[k] = seat;
    this.seatRngs.delete(def.id);
    this.syncYou();
    this.push('info', def.id === YOU ? `You took ${old.name}'s seat.` : `${def.name} took ${old.name}'s seat.`);
    return seat;
  }

  private houseTurn(r: Seat) {
    const rng = this.rivalRng;
    if (rng() > r.actChance) return;
    const n = this.cells.length;

    // 1) Claim the best zone they feel confident about.
    let best = -1;
    let bestMid = -1;
    for (let i = 0; i < n; i++) {
      if (this.cells[i].status !== 'open' || r.hazardKnown[i] || r.probes[i] === 0) continue;
      const [lo, hi] = r.known[i];
      const mid = (lo + hi) / 2;
      if (mid >= r.greed && hi - lo <= r.maxWidth && mid > bestMid) { best = i; bestMid = mid; }
    }
    if (best >= 0) {
      const { x, y } = xyOf(best, this.size);
      const c = this.cells[best];
      const z = this.map[best];
      const youScouted = (this.you?.probes[best] ?? 0) > 0;
      if (z.hazard) {
        c.status = 'hazard';
        this.resolveKnown(best, [0, 0]);
        this.push('rival', `${r.name} hit a hazard at ${zoneLabel(x, y)}.`);
      } else if (z.value < this.cfg.claimThreshold) {
        c.status = 'dud';
        this.resolveKnown(best, [z.value, z.value]);
        this.push('rival', `${r.name} claimed a dud at ${zoneLabel(x, y)}.`);
      } else {
        c.status = 'owned';
        c.owner = r.id;
        c.integrity = 100;
        r.zones++;
        r.score = round1(r.score + claimHarvest(z.value, this.cfg));
        this.resolveKnown(best, [z.value, z.value]);
        this.push('rival', youScouted
          ? `${r.name} sniped ${zoneLabel(x, y)} before you!`
          : `${r.name} claimed ${zoneLabel(x, y)}.`);
      }
      return;
    }

    // 2) Otherwise probe: usually the most promising uncertain open zone, sometimes a random one.
    let target = -1;
    if (rng() < 0.25) {
      for (let tries = 0; tries < 30 && target < 0; tries++) {
        const i = Math.floor(rng() * n);
        if (this.cells[i].status === 'open' && !r.hazardKnown[i]) target = i;
      }
    }
    if (target < 0) {
      let bestScore = -Infinity;
      for (let i = 0; i < n; i++) {
        if (this.cells[i].status !== 'open' || r.hazardKnown[i] || r.probes[i] >= 4) continue;
        const [lo, hi] = r.known[i];
        const s = (lo + hi) / 2 + (hi - lo < 100 ? 10 : 0) + rng() * 10;
        if (s > bestScore) { bestScore = s; target = i; }
      }
    }
    if (target < 0) return;
    const { x, y } = xyOf(target, this.size);
    this.scan(r.known, r.probes, x, y, rng);
    if (this.map[target].hazard && rng() < this.cfg.hazardDetectChance) r.hazardKnown[target] = true;
    this.cells[target].ping = r.id;
  }

  /** JSON-friendly snapshot for the local human seat. Hidden values only once the round is over. */
  state() {
    const y = this.you;
    return {
      seed: this.over ? this.seed : null,
      commit: this.commit,
      tick: this.tick,
      maxTicks: this.cfg.maxTicks,
      credits: Math.floor(this.credits * 10) / 10,
      score: Math.floor(this.score * 10) / 10,
      over: this.over,
      endReason: this.endReason,
      out: y ? y.out : false,
      outReason: y ? y.outReason : '',
      costs: { probe: this.cfg.probeCost, claim: this.cfg.claimCost, maintain: this.cfg.maintainCost },
      rules: {
        size: this.size,
        claimThreshold: this.cfg.claimThreshold,
        decayPerTick: this.cfg.decayPerTick,
        yieldRate: this.cfg.yieldRate,
        claimHarvestRate: this.cfg.claimHarvestRate,
      },
      rivals: this.rivals.map((r) => ({ id: r.id, kind: r.kind, name: r.name, score: Math.floor(r.score), zones: r.zones })),
      zones: this.cells.map((c, i) => {
        const { x, y: yy } = xyOf(i, this.size);
        return {
          x, y: yy, label: zoneLabel(x, yy), status: c.status, owner: c.owner,
          range: c.known, probes: c.probes, hazardFlag: c.hazardFlag,
          integrity: c.owner === YOU ? c.integrity : undefined,
          rivalPing: c.ping,
          value: this.over ? this.map[i].value : undefined,
          hazard: this.over ? this.map[i].hazard : undefined,
        };
      }),
      log: this.log.slice(-8),
    };
  }

  /** Spectator snapshot: only public information (no seat's private readings). */
  publicState() {
    return {
      seed: this.over ? this.seed : null,
      commit: this.commit,
      tick: this.tick,
      maxTicks: this.cfg.maxTicks,
      over: this.over,
      endReason: this.endReason,
      seats: this.seats.map((s) => ({
        id: s.id, kind: s.kind, name: s.name, color: s.color, score: Math.floor(s.score), zones: s.zones,
        out: s.out,
      })),
      zones: this.cells.map((c, i) => {
        const { x, y } = xyOf(i, this.size);
        return {
          x, y, label: zoneLabel(x, y), status: c.status, owner: c.owner,
          integrity: c.status === 'owned' ? c.integrity : undefined,
          rivalPing: c.ping,
          value: this.over || c.status !== 'open' ? this.map[i].value : undefined,
          hazard: this.over ? this.map[i].hazard : undefined,
        };
      }),
      log: this.log.slice(-8),
    };
  }
}
