// Substrate world: 25 independent arenas (5x5) of 10x10 hidden maps = a 50x50
// overview, 4 seats each = 100 seats. All arenas share one clock: they tick
// together, reveal together at maxTicks, then roll into a new round with new seeds.
// Pure TypeScript, no DOM, so it can run on a server later.
import {
  CONFIG, Game, YOU, YOU_COLOR, RIVAL_DEFS, verifyCommit,
  type ActionKind, type ActionResult, type Config, type Seat, type SeatDef,
} from './game';
import { makeRng, type Rng } from './rng';

export const ARENA_SIDE = 5;
export const ARENA_COUNT = ARENA_SIDE * ARENA_SIDE; // 25
export const SEATS_PER_ARENA = 4;
export const TOTAL_SEATS = ARENA_COUNT * SEATS_PER_ARENA; // 100
export const GLOBAL_SIZE = ARENA_SIDE * CONFIG.size; // 50
const ROW_LETTERS = 'ABCDE';

/** Arena ids read like a chess board: rows A..E, columns 1..5 (A1 top-left, E5 bottom-right). */
export const arenaId = (index: number) => `${ROW_LETTERS[Math.floor(index / ARENA_SIDE)]}${(index % ARENA_SIDE) + 1}`;
export const arenaRowCol = (index: number) => ({ row: Math.floor(index / ARENA_SIDE), col: index % ARENA_SIDE });

/** Accepts 'C3', 'c3', 12 (0-based index) or '13' (1-based number). Returns -1 if invalid. */
export function arenaIndex(id: string | number): number {
  if (typeof id === 'number') return Number.isInteger(id) && id >= 0 && id < ARENA_COUNT ? id : -1;
  const s = String(id).trim().toUpperCase();
  const m = /^([A-E])([1-5])$/.exec(s);
  if (m) return ROW_LETTERS.indexOf(m[1]) * ARENA_SIDE + Number(m[2]) - 1;
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 1 && n <= ARENA_COUNT ? n - 1 : -1; }
  return -1;
}

/** Arena (row, col) + local cell (x, y) -> coordinate on the 50x50 overview. */
export function globalCell(arenaRow: number, arenaCol: number, x: number, y: number, size = CONFIG.size) {
  const gx = arenaCol * size + x;
  const gy = arenaRow * size + y;
  return { gx, gy, gi: gy * size * ARENA_SIDE + gx };
}

/** 50x50 coordinate -> arena index/row/col + local cell. */
export function localCell(gx: number, gy: number, size = CONFIG.size) {
  const row = Math.floor(gy / size);
  const col = Math.floor(gx / size);
  return { arena: row * ARENA_SIDE + col, row, col, x: gx % size, y: gy % size };
}

/** Each arena's seed for a round, derived from the master seed. */
export const arenaSeed = (master: string, round: number, index: number) => `${master}-r${round}-${arenaId(index)}`;

/** Centre-out order: C3 first (the original Vex-7 / Orin / Null.Kid table), then outward. */
export const CENTER_OUT: number[] = Array.from({ length: ARENA_COUNT }, (_, i) => i).sort((a, b) => {
  const d = (i: number) => { const { row, col } = arenaRowCol(i); return Math.max(Math.abs(row - 2), Math.abs(col - 2)) * 100 + Math.abs(row - 2) + Math.abs(col - 2); };
  return d(a) - d(b) || a - b;
});
export const HOME_ARENA = CENTER_OUT[0]; // 12 = C3

// ---- House bot roster ----
// Personalities stay inside the v1 tuning band (act 75-85%, greed 32-40, width 22-36).
export const FAMILIES = [
  { family: 'vex', label: 'aggressive', actChance: 0.8, greed: 32, maxWidth: 36 },
  { family: 'orin', label: 'careful', actChance: 0.8, greed: 40, maxWidth: 22 },
  { family: 'null', label: 'balanced', actChance: 0.8, greed: 36, maxWidth: 28 },
  { family: 'kite', label: 'restless', actChance: 0.85, greed: 34, maxWidth: 32 },
  { family: 'mote', label: 'patient', actChance: 0.75, greed: 38, maxWidth: 24 },
] as const;
export type Family = (typeof FAMILIES)[number]['family'];

export const HOUSE_COLORS = [
  '#ff4fd8', '#ffb23f', '#a6ff4d', '#ff6b4a', '#b18cff', '#ffe14d', '#ff8fb1',
  '#7dff9e', '#ff9d2e', '#e86bff', '#c6ff3d', '#ff5f8f', '#f2a8ff', '#ffd27a',
];

const WORDS = ['Kid', 'Ash', 'Moth', 'Byte', 'Rue', 'Hex', 'Vane', 'Echo', 'Lux', 'Sol', 'Fen', 'Arc', 'Quill', 'Wisp', 'Grit', 'Nox',
  'Jinx', 'Rook', 'Cass', 'Zed', 'Pike', 'Dusk', 'Flux', 'Mica', 'Onyx', 'Pip', 'Rune', 'Skye', 'Tock', 'Vale'];
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Sigma', 'Tau', 'Rho', 'Zeta', 'Kappa', 'Omega'];

function botName(fam: Family, rng: Rng): string {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rng() * a.length)];
  const n = 2 + Math.floor(rng() * 97);
  switch (fam) {
    case 'vex': return `Vex-${n}`;
    case 'orin': return rng() < 0.5 ? `Orin ${pick(ROMAN)}` : `Orin-${String.fromCharCode(65 + Math.floor(rng() * 26))}${n % 10}`;
    case 'null': return rng() < 0.7 ? `Null.${pick(WORDS)}` : `Null.${pick(WORDS)}${n % 10}`;
    case 'kite': return `Kite${pick(['-', '.', ''])}${n}`;
    case 'mote': return rng() < 0.5 ? `Mote ${pick(GREEK)}` : `Mote.${n}`;
  }
}

export const HUMAN_DEF: SeatDef = { id: YOU, kind: 'human', name: 'You', color: YOU_COLOR };

export interface Arena {
  index: number;
  id: string;
  row: number;
  col: number;
  round: number;
  seed: string;
  game: Game;
  /** Commit-reveal check result, set when the round reveals. */
  verified: boolean | null;
}

export interface LeaderRow {
  rank: number;
  arena: string;
  arenaIndex: number;
  seatId: string;
  kind: Seat['kind'];
  name: string;
  color: string;
  score: number;
  zones: number;
  you: boolean;
}

export type StepEvent = 'tick' | 'reveal' | 'round';

export class World {
  readonly master: string;
  readonly cfg: Config;
  round = 1;
  phase: 'play' | 'reveal' = 'play';
  arenas: Arena[] = [];
  /** Arena the local human sits in, or null when only spectating. */
  humanArena: number | null = null;
  /** Seat line-ups carry over between rounds; only the maps reset. */
  private roster: SeatDef[][];
  private rosterRng: Rng;
  private names = new Set<string>();
  private uid = 0;

  constructor(master: string, cfg: Config = CONFIG) {
    this.master = master;
    this.cfg = cfg;
    this.rosterRng = makeRng(master, 'roster');
    RIVAL_DEFS.forEach((d) => this.names.add(d.name)); // reserve the original trio's names for C3
    this.roster = Array.from({ length: ARENA_COUNT }, (_, i) => this.initialSeats(i));
    this.buildRound();
  }

  get tick() { return this.arenas[0].game.tick; }
  get maxTicks() { return this.cfg.maxTicks; }
  arena(id: string | number): Arena | undefined { return this.arenas[arenaIndex(id)]; }
  get human(): { arena: Arena; seat: Seat } | null {
    if (this.humanArena === null) return null;
    const arena = this.arenas[this.humanArena];
    const seat = arena.game.you;
    return seat ? { arena, seat } : null;
  }
  /** All 100 seats, arena by arena. */
  allSeats(): { arena: Arena; seat: Seat }[] {
    return this.arenas.flatMap((arena) => arena.game.seats.map((seat) => ({ arena, seat })));
  }

  private newHouse(fam?: Family, avoidColors: string[] = []): SeatDef {
    const rng = this.rosterRng;
    const f = fam ? FAMILIES.find((x) => x.family === fam)! : FAMILIES[Math.floor(rng() * FAMILIES.length)];
    let name = botName(f.family, rng);
    for (let g = 0; this.names.has(name) && g < 50; g++) name = botName(f.family, rng);
    if (this.names.has(name)) name = `${name}-${this.uid}`;
    this.names.add(name);
    const free = HOUSE_COLORS.filter((c) => !avoidColors.includes(c));
    const color = free[Math.floor(rng() * free.length)] ?? HOUSE_COLORS[0];
    return {
      id: `h${++this.uid}`, kind: 'house', name, color, family: f.family,
      actChance: f.actChance, greed: f.greed, maxWidth: f.maxWidth,
    };
  }

  private initialSeats(index: number): SeatDef[] {
    if (index === HOME_ARENA) {
      // The original trio keeps its exact names, colours and personalities.
      const trio: SeatDef[] = RIVAL_DEFS.map((d) => ({ ...d, id: `h${++this.uid}`, family: d.id, kind: 'house' as const }));
      return [...trio, this.newHouse(undefined, trio.map((d) => d.color))];
    }
    const out: SeatDef[] = [];
    for (let k = 0; k < SEATS_PER_ARENA; k++) out.push(this.newHouse(undefined, out.map((d) => d.color)));
    return out;
  }

  private buildRound() {
    this.arenas = this.roster.map((seats, index) => {
      const seed = arenaSeed(this.master, this.round, index);
      const { row, col } = arenaRowCol(index);
      return {
        index, id: arenaId(index), row, col, round: this.round, seed, verified: null,
        game: new Game(seed, this.cfg, { seats, roundMode: true, autoAdvance: false }),
      };
    });
    this.phase = 'play';
  }

  /**
   * Advance the shared clock by one tick. During play every arena ticks together;
   * after the last tick all arenas reveal (and verify their commits); the next
   * step starts a new round with fresh seeds.
   */
  step(): StepEvent {
    if (this.phase === 'reveal') {
      this.round++;
      this.buildRound();
      return 'round';
    }
    for (const a of this.arenas) a.game.advance();
    if (this.arenas.every((a) => a.game.over)) {
      this.phase = 'reveal';
      for (const a of this.arenas) a.verified = verifyCommit(a.seed, a.game.commit, this.cfg);
      return 'reveal';
    }
    return 'tick';
  }

  /** Run the clock until the current round reveals. */
  runToReveal(): void {
    while (this.phase === 'play') this.step();
  }

  /**
   * Put a non-house occupant into an arena, replacing a house bot one for one.
   * At tick 0 the newest house seat gives way; mid-round the lowest-scoring house
   * seat does (its zones collapse). Returns the new seat, or null if no house seat is free.
   */
  seatAt(index: number, def: SeatDef): Seat | null {
    const arena = this.arenas[index];
    if (!arena) return null;
    const house = arena.game.seats.filter((s) => s.kind === 'house');
    if (!house.length) return null;
    const out = arena.game.tick === 0
      ? house[house.length - 1]
      : [...house].sort((a, b) => a.score - b.score)[0];
    const slot = arena.game.seats.indexOf(out);
    this.roster[index][slot] = def;
    this.names.delete(out.name);
    return arena.game.replaceSeat(out.id, def);
  }

  /** Hand a seat back to the house (a fresh bot takes it). */
  vacate(index: number, seatId: string): void {
    const arena = this.arenas[index];
    const slot = arena?.game.seats.findIndex((s) => s.id === seatId) ?? -1;
    if (!arena || slot < 0) return;
    const others = arena.game.seats.filter((s) => s.id !== seatId).map((s) => s.color);
    const def = this.newHouse(undefined, others);
    this.roster[index][slot] = def;
    arena.game.replaceSeat(seatId, def);
  }

  openSeats(index: number): number {
    return this.arenas[index]?.game.seats.filter((s) => s.kind === 'house').length ?? 0;
  }

  /** Seat the local human. Leaves the current arena first (that run is forfeited). */
  join(id: string | number): Seat | null {
    const index = arenaIndex(id);
    if (index < 0) return null;
    if (this.humanArena === index) return this.arenas[index].game.you ?? null;
    if (this.openSeats(index) === 0) return null;
    this.leave();
    const seat = this.seatAt(index, HUMAN_DEF);
    if (seat) this.humanArena = index;
    return seat;
  }

  leave(): void {
    if (this.humanArena === null) return;
    this.vacate(this.humanArena, YOU);
    this.humanArena = null;
  }

  /** First arena with a house seat to replace, centre-out. */
  firstOpen(): number {
    return CENTER_OUT.find((i) => this.openSeats(i) > 0) ?? -1;
  }

  /**
   * The local human acts in their arena. Tick-using actions (probe, claim, wait)
   * advance the shared clock for all 25 arenas; maintain is instant.
   */
  act(kind: ActionKind, x?: number, y?: number): ActionResult & { event?: StepEvent } {
    const h = this.human;
    if (!h) return { ok: false, message: 'Join an arena first.' };
    if (this.phase === 'reveal') return { ok: false, message: 'Round over: the map is revealed. The next round starts soon.' };
    const r = h.arena.game.act(YOU, kind, x, y);
    if (r.ok && kind !== 'maintain') return { ...r, event: this.step() };
    return r;
  }

  leaderboard(): LeaderRow[] {
    return this.allSeats()
      .map(({ arena, seat }) => ({
        rank: 0, arena: arena.id, arenaIndex: arena.index, seatId: seat.id, kind: seat.kind,
        name: seat.name, color: seat.color, score: Math.floor(seat.score), zones: seat.zones, you: seat.id === YOU,
      }))
      .sort((a, b) => b.score - a.score || a.arenaIndex - b.arenaIndex)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  listArenas() {
    return this.arenas.map((a) => ({
      id: a.id, index: a.index, row: a.row, col: a.col, round: a.round, tick: a.game.tick,
      commit: a.game.commit, seed: a.game.over ? a.seed : null, over: a.game.over, verified: a.verified,
      you: a.index === this.humanArena, openSeats: this.openSeats(a.index),
      seats: a.game.seats.map((s, slot) => ({
        slot, id: s.id, kind: s.kind, name: s.name, color: s.color, family: s.family,
        score: Math.floor(s.score), zones: s.zones, out: s.out,
      })),
    }));
  }

  summary() {
    const seats = this.allSeats();
    return {
      master: this.master, round: this.round, tick: this.tick, maxTicks: this.maxTicks, phase: this.phase,
      arenas: ARENA_COUNT, seats: seats.length,
      humans: seats.filter((s) => s.seat.kind === 'human').length,
      agents: seats.filter((s) => s.seat.kind === 'agent').length,
      house: seats.filter((s) => s.seat.kind === 'house').length,
      yourArena: this.humanArena === null ? null : arenaId(this.humanArena),
      verified: this.phase === 'reveal' ? this.arenas.filter((a) => a.verified).length : null,
    };
  }
}
