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
  known: Range; // what YOU know about this zone's value
  probes: number; // your direct probes on it
  hazardFlag: boolean; // your probes flagged it as unstable
  status: ZoneStatus;
  owner: string | null; // 'you' or a rival id
  integrity: number; // 0..100 for owned zones
  ping: string | null; // rival id that probed it this tick
}

export interface Rival {
  id: string;
  name: string;
  color: string;
  score: number;
  zones: number;
  actChance: number;
  greed: number; // claim when estimated mid >= greed ...
  maxWidth: number; // ... and their range is at most this wide
  known: Range[];
  probes: number[];
  hazardKnown: boolean[];
}

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

export const RIVAL_DEFS = [
  { id: 'vex', name: 'Vex-7', color: '#ff4fd8', actChance: 0.8, greed: 32, maxWidth: 36 },
  { id: 'orin', name: 'Orin', color: '#ffb23f', actChance: 0.8, greed: 40, maxWidth: 22 },
  { id: 'null', name: 'Null.Kid', color: '#a6ff4d', actChance: 0.8, greed: 36, maxWidth: 28 },
] as const;

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
  readonly rivals: Rival[];
  tick = 0;
  credits: number;
  score = 0;
  over = false;
  endReason = '';
  probesUsed = 0;
  claimsMade = 0;
  log: LogEntry[] = [];
  private probeRng: Rng;
  private rivalRng: Rng;

  constructor(seed: string, cfg: Config = CONFIG) {
    this.cfg = cfg;
    this.seed = seed;
    this.map = generateMap(seed, cfg);
    this.commit = commitHash(seed, this.map);
    this.probeRng = makeRng(seed, 'probe');
    this.rivalRng = makeRng(seed, 'rivals');
    this.credits = cfg.startCredits;
    const n = cfg.size * cfg.size;
    this.cells = Array.from({ length: n }, () => ({
      known: [0, 100] as Range, probes: 0, hazardFlag: false, status: 'open' as ZoneStatus,
      owner: null, integrity: 0, ping: null,
    }));
    this.rivals = RIVAL_DEFS.map((d) => ({
      ...d, score: 0, zones: 0,
      known: Array.from({ length: n }, () => [0, 100] as Range),
      probes: new Array(n).fill(0),
      hazardKnown: new Array(n).fill(false),
    }));
    this.push('info', 'Scouts online. The substrate is sealed; read it before the rivals do.');
  }

  get size() { return this.cfg.size; }

  private push(kind: LogEntry['kind'], text: string) {
    this.log.push({ tick: this.tick, kind, text });
    if (this.log.length > 60) this.log.shift();
  }

  private inBounds(x: number, y: number) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.size && y < this.size;
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

  ownedByYou(): number[] {
    const out: number[] = [];
    this.cells.forEach((c, i) => { if (c.owner === 'you') out.push(i); });
    return out;
  }

  probe(x: number, y: number): ActionResult {
    if (this.over) return { ok: false, message: 'Run is over.' };
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const i = idx(x, y, this.size);
    const c = this.cells[i];
    if (c.status !== 'open') return { ok: false, message: `${zoneLabel(x, y)} is already resolved.` };
    if (this.credits < this.cfg.probeCost) return { ok: false, message: 'Not enough credits to probe.' };
    this.credits -= this.cfg.probeCost;
    this.probesUsed++;
    const known = this.cells.map((cc) => cc.known);
    const probes = this.cells.map((cc) => cc.probes);
    const range = this.scan(known, probes, x, y, this.probeRng);
    this.cells.forEach((cc, j) => { cc.known = known[j]; cc.probes = probes[j]; });
    let msg = `Probed ${zoneLabel(x, y)}: signal ${range[0]}–${range[1]} (${signalWord(range)}).`;
    if (this.map[i].hazard && !c.hazardFlag && this.probeRng() < this.cfg.hazardDetectChance) {
      c.hazardFlag = true;
      msg += ' ⚠ Unstable readings.';
    }
    this.push('you', msg);
    this.advance();
    return { ok: true, message: msg, range };
  }

  claim(x: number, y: number): ActionResult {
    if (this.over) return { ok: false, message: 'Run is over.' };
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const i = idx(x, y, this.size);
    const c = this.cells[i];
    if (c.status !== 'open') return { ok: false, message: `${zoneLabel(x, y)} can't be claimed.` };
    if (this.credits < this.cfg.claimCost) return { ok: false, message: 'Not enough credits to claim.' };
    this.credits -= this.cfg.claimCost;
    this.claimsMade++;
    const z = this.map[i];
    let res: ActionResult;
    if (z.hazard) {
      c.status = 'hazard';
      c.known = [0, 0];
      this.credits = Math.max(0, this.credits - this.cfg.hazardPenalty);
      res = { ok: true, message: `Hazard at ${zoneLabel(x, y)}! Stake lost and −${this.cfg.hazardPenalty} more.`, harvested: 0 };
      this.push('bad', res.message);
    } else if (z.value < this.cfg.claimThreshold) {
      c.status = 'dud';
      c.known = [z.value, z.value];
      res = { ok: true, message: `${zoneLabel(x, y)} was a dud (value ${z.value}). Stake lost.`, harvested: 0 };
      this.push('bad', res.message);
    } else {
      const h = claimHarvest(z.value, this.cfg);
      c.status = 'owned';
      c.owner = 'you';
      c.integrity = 100;
      c.known = [z.value, z.value];
      this.score = round1(this.score + h);
      this.credits = round1(this.credits + h);
      res = { ok: true, message: `Claimed ${zoneLabel(x, y)} (value ${z.value}). Harvested +${h}.`, harvested: h };
      this.push('good', res.message);
    }
    this.advance();
    return res;
  }

  /** Restore one of your zones to 100% integrity. Does not use a tick. */
  maintain(x: number, y: number): ActionResult {
    if (this.over) return { ok: false, message: 'Run is over.' };
    if (!this.inBounds(x, y)) return { ok: false, message: 'Out of bounds.' };
    const c = this.cells[idx(x, y, this.size)];
    if (c.owner !== 'you') return { ok: false, message: 'You can only maintain your own zones.' };
    if (c.integrity >= 100) return { ok: false, message: 'Already at full integrity.' };
    if (this.credits < this.cfg.maintainCost) return { ok: false, message: 'Not enough credits to maintain.' };
    this.credits = round1(this.credits - this.cfg.maintainCost);
    c.integrity = 100;
    const msg = `Maintained ${zoneLabel(x, y)} back to 100%.`;
    this.push('you', msg);
    return { ok: true, message: msg };
  }

  /** Let one tick pass without acting (yields still flow, rivals still move). */
  endTurn(): ActionResult {
    if (this.over) return { ok: false, message: 'Run is over.' };
    this.push('you', 'You hold position.');
    this.advance();
    return { ok: true, message: 'Tick passed.' };
  }

  private advance() {
    this.cells.forEach((c) => { c.ping = null; });
    for (const r of this.rivals) this.rivalTurn(r);

    let yourYield = 0;
    this.cells.forEach((c, i) => {
      if (c.status !== 'owned') return;
      const v = this.map[i].value;
      if (c.owner === 'you') {
        const y = tickYield(v, c.integrity, this.cfg);
        yourYield += y;
        c.integrity = decay(c.integrity, this.cfg);
        if (c.integrity <= 0) {
          c.status = 'depleted';
          c.owner = null;
          const { x, y: yy } = xyOf(i, this.size);
          this.push('bad', `${zoneLabel(x, yy)} collapsed from decay.`);
        }
      } else {
        const r = this.rivals.find((rr) => rr.id === c.owner);
        if (r) r.score = round1(r.score + tickYield(v, 100, this.cfg));
      }
    });
    if (yourYield > 0) {
      this.score = round1(this.score + yourYield);
      this.credits = round1(this.credits + yourYield);
    }
    this.tick++;
    this.checkEnd();
  }

  private checkEnd() {
    if (this.over) return;
    if (this.tick >= this.cfg.maxTicks) return this.finish('Signal window closed.');
    if (this.credits < this.cfg.probeCost && this.ownedByYou().length === 0) return this.finish('Out of credits.');
    if (!this.cells.some((c) => c.status === 'open') && this.ownedByYou().length === 0) return this.finish('Nothing left to scout.');
  }

  private finish(reason: string) {
    this.over = true;
    this.endReason = reason;
    this.push('info', `${reason} Final score ${Math.floor(this.score)}. Seed revealed: ${this.seed}.`);
  }

  private rivalTurn(r: Rival) {
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
      const youScouted = c.probes > 0;
      if (z.hazard) {
        c.status = 'hazard';
        this.push('rival', `${r.name} hit a hazard at ${zoneLabel(x, y)}.`);
      } else if (z.value < this.cfg.claimThreshold) {
        c.status = 'dud';
        c.known = [z.value, z.value];
        this.push('rival', `${r.name} claimed a dud at ${zoneLabel(x, y)}.`);
      } else {
        c.status = 'owned';
        c.owner = r.id;
        c.integrity = 100;
        r.zones++;
        r.score = round1(r.score + claimHarvest(z.value, this.cfg));
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

  /** JSON-friendly snapshot. Hidden values are only included once the run is over. */
  state() {
    return {
      seed: this.over ? this.seed : null,
      commit: this.commit,
      tick: this.tick,
      maxTicks: this.cfg.maxTicks,
      credits: Math.floor(this.credits * 10) / 10,
      score: Math.floor(this.score * 10) / 10,
      over: this.over,
      endReason: this.endReason,
      costs: { probe: this.cfg.probeCost, claim: this.cfg.claimCost, maintain: this.cfg.maintainCost },
      rules: {
        size: this.size,
        claimThreshold: this.cfg.claimThreshold,
        decayPerTick: this.cfg.decayPerTick,
        yieldRate: this.cfg.yieldRate,
        claimHarvestRate: this.cfg.claimHarvestRate,
      },
      rivals: this.rivals.map((r) => ({ id: r.id, name: r.name, score: Math.floor(r.score), zones: r.zones })),
      zones: this.cells.map((c, i) => {
        const { x, y } = xyOf(i, this.size);
        return {
          x, y, label: zoneLabel(x, y), status: c.status, owner: c.owner,
          range: c.known, probes: c.probes, hazardFlag: c.hazardFlag,
          integrity: c.owner === 'you' ? c.integrity : undefined,
          rivalPing: c.ping,
          value: this.over ? this.map[i].value : undefined,
          hazard: this.over ? this.map[i].hazard : undefined,
        };
      }),
      log: this.log.slice(-8),
    };
  }
}
