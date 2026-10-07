// Canvas renderer for the 50x50 "Substrate map": all 25 arenas, top-down.
// Pure drawing: takes the world + options, never mutates game state.
//
// Layout is integer-pixel: every cell is the same whole number of device pixels,
// cells inside an arena touch edge to edge, and only a thin break separates arenas.
import { CONFIG, YOU, type Game, type Seat } from './game';
import { ARENA_SIDE, type World } from './world';

// ---------- palette ----------
export interface Palette {
  /** Probe-heat glow colour; null = the default spectrum (teal -> green -> gold). */
  heat: string | null;
  /** Your squares. */
  you: string;
  /** Per seat slot 1-4 override for everyone else; null = each bot keeps its own colour. */
  seats: [string | null, string | null, string | null, string | null];
  /** Unexplored / empty cell colour. */
  base: string;
  /** Dud / collapsed marker colour. */
  dud: string;
  /** Hazard marker colour. */
  hazard: string;
  /** Break between arenas; null = same as the background. */
  divider: string | null;
}

export const DEFAULT_PALETTE: Palette = {
  heat: null,
  you: '#3ee6ff',
  seats: [null, null, null, null],
  base: '#0b1b17',
  dud: '#5f7f77',
  hazard: '#ff5d73',
  divider: null,
};

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = <T,>(v: unknown, d: T): string | T => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);

/** Validate anything (e.g. parsed localStorage) into a full palette. */
export function sanitizePalette(x: unknown): Palette {
  const p = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const seats = Array.isArray(p.seats) ? p.seats : [];
  return {
    heat: hexOr(p.heat, null),
    you: hexOr(p.you, DEFAULT_PALETTE.you),
    seats: [0, 1, 2, 3].map((k) => hexOr(seats[k], null)) as Palette['seats'],
    base: hexOr(p.base, DEFAULT_PALETTE.base),
    dud: hexOr(p.dud, DEFAULT_PALETTE.dud),
    hazard: hexOr(p.hazard, DEFAULT_PALETTE.hazard),
    divider: hexOr(p.divider, null),
  };
}

/** Colour a seat is drawn in: your colour for you, else the slot override, else the bot's own. */
export function seatColor(seat: Pick<Seat, 'id' | 'color'>, slot: number, pal: Palette = DEFAULT_PALETTE): string {
  if (seat.id === YOU) return pal.you;
  return pal.seats[slot] ?? seat.color;
}

/** Colour for a seat id at a table (handles departed owners). */
export function seatColorIn(g: Game, id: string | null, pal: Palette = DEFAULT_PALETTE): string {
  const slot = g.seats.findIndex((s) => s.id === id);
  return slot < 0 ? '#888888' : seatColor(g.seats[slot], slot, pal);
}

// ---------- layout ----------
export interface Layout {
  px: number; // canvas size in device pixels
  ox: number; // left/top offset of the 50x50 block
  cell: number; // integer device px per cell
  gap: number; // integer device px break between arenas
  arena: number; // = 10 * cell
  pitch: number; // = arena + gap
  span: number; // = 5 * arena + 4 * gap
}

const N = CONFIG.size * ARENA_SIDE; // 50
const marginFor = (px: number) => Math.round(px * 0.015);
export const gapFor = (px: number) => Math.max(1, Math.round(px * 0.0035)); // ~4 px at 1029 (1.5 css px on a phone), 7 px at 2048

export function computeLayout(px: number): Layout {
  const gap = gapFor(px);
  const cell = Math.max(1, Math.floor((px - 2 * marginFor(px) - (ARENA_SIDE - 1) * gap) / N));
  const arena = cell * CONFIG.size;
  const span = ARENA_SIDE * arena + (ARENA_SIDE - 1) * gap;
  return { px, ox: Math.floor((px - span) / 2), cell, gap, arena, pitch: arena + gap, span };
}

/** Largest canvas size <= avail whose layout has no leftover slack (so no stretching/blur). */
export function fitPx(avail: number): number {
  const l = computeLayout(Math.max(60, Math.floor(avail)));
  return l.span + 2 * marginFor(l.px);
}

/** Device-pixel rect of one cell: arena (row, col) + local cell (x, y). */
export function cellRect(l: Layout, row: number, col: number, x: number, y: number) {
  return { x: l.ox + col * l.pitch + x * l.cell, y: l.ox + row * l.pitch + y * l.cell, w: l.cell, h: l.cell };
}

/** Which arena (0..24) a point in device pixels falls in; breaks snap to the nearest. */
export function hitArena(l: Layout, x: number, y: number): number | null {
  const col = Math.floor((x - l.ox + l.gap / 2) / l.pitch);
  const row = Math.floor((y - l.ox + l.gap / 2) / l.pitch);
  if (col < 0 || row < 0 || col >= ARENA_SIDE || row >= ARENA_SIDE) return null;
  return row * ARENA_SIDE + col;
}

// ---------- colour helpers ----------
export const heatHue = (mid: number) => Math.round(mid < 60 ? 190 - mid * 1.7 : 88 - (mid - 60) * 1.4);
type RGB = [number, number, number];

export function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function hexRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hslRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
const toHex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function mix(base: RGB, top: RGB, a: number): RGB {
  return [0, 1, 2].map((i) => Math.round(base[i] + (top[i] - base[i]) * a)) as RGB;
}

// Pre-blended opaque colours (alpha quantised to 1/50), cached. Each cell becomes one
// opaque rect, and rects are batched per colour, so a redraw is a few hundred fills.
const cache = new Map<string, string>();
function blendHex(baseHex: string, topHex: string, a: number): string {
  const q = Math.max(0, Math.min(50, Math.round(a * 50)));
  const key = baseHex + topHex + q;
  let v = cache.get(key);
  if (!v) { v = toHex(mix(hexRgb(baseHex), hexRgb(topHex), q / 50)); cache.set(key, v); }
  return v;
}
const hueHex = new Map<number, string>();
function heatColor(pal: Palette, mid: number): string {
  if (pal.heat) return pal.heat;
  const h = heatHue(mid);
  let v = hueHex.get(h);
  if (!v) { v = toHex(hslRgb(h, 0.95, 0.55)); hueHex.set(h, v); }
  return v;
}

// ---------- per-cell visual (pure, unit tested) ----------
export interface CellVisual {
  fill: string;
  /** Optional centred marker: colour + size as a fraction of the cell. */
  dot?: { color: string; size: number };
}

/**
 * How one cell looks on the map.
 * - Claims, duds, hazards, collapses and this tick's probe pings are public: always shown.
 * - Probe heat: in YOUR arena while you're live, only your own readings glow; other scouts'
 *   probe locations show as a faint neutral "scouted" trail (where, never what).
 *   Everywhere else (other arenas, after you're out, at reveal) all readings combine.
 */
export function cellVisual(world: World, arenaIndex: number, i: number, pal: Palette = DEFAULT_PALETTE): CellVisual {
  return visualAt(arenaContext(world, arenaIndex, pal), i);
}

interface ArenaCtx {
  g: Game;
  pal: Palette;
  reveal: boolean;
  ownLive: boolean;
  seats: Seat[]; // whose readings make the heat
  colorOf: Map<string, string>;
  trail: string; // neutral "scouted" tint target
}

/** Everything per arena that doesn't change cell to cell (computed once per redraw). */
function arenaContext(world: World, arenaIndex: number, pal: Palette): ArenaCtx {
  const g = world.arenas[arenaIndex].game;
  const you = g.you;
  const reveal = world.phase === 'reveal';
  const ownLive = !reveal && arenaIndex === world.humanArena && !!you && !you.out;
  return {
    g, pal, reveal, ownLive,
    seats: ownLive ? [you!] : g.seats,
    colorOf: new Map(g.seats.map((s, k) => [s.id, seatColor(s, k, pal)])),
    trail: luminance(pal.base) > 0.5 ? '#3a4a46' : '#a8c4bc',
  };
}

function visualAt(a: ArenaCtx, i: number): CellVisual {
  const { g, pal } = a;
  const c = g.cells[i];
  const z = g.map[i];
  const base = pal.base;

  if (c.status === 'owned' && c.owner) {
    const al = (0.42 + 0.58 * (z.value / 100)) * (0.3 + 0.7 * (c.integrity / 100));
    return { fill: blendHex(base, a.colorOf.get(c.owner) ?? '#888888', al) };
  }
  if (a.reveal) {
    if (z.hazard || c.status === 'hazard') {
      return { fill: blendHex(base, pal.hazard, 0.14), dot: { color: blendHex(base, pal.hazard, 0.5), size: 0.26 } };
    }
    const cellBase = c.status === 'depleted' ? blendHex(base, pal.dud, 0.08) : base;
    if (z.value <= 0) return { fill: cellBase };
    const dim = c.status === 'dud' || c.status === 'depleted';
    return { fill: blendHex(cellBase, heatColor(pal, z.value), 0.1 + (z.value / 100) * 0.8 * (dim ? 0.5 : 1)) };
  }
  if (c.status === 'dud') {
    const f = blendHex(base, pal.dud, 0.12);
    return { fill: f, dot: { color: blendHex(f, pal.dud, 0.7), size: 0.2 } };
  }
  if (c.status === 'hazard') {
    const f = blendHex(base, pal.hazard, 0.16);
    return { fill: f, dot: { color: blendHex(f, pal.hazard, 0.75), size: 0.2 } };
  }
  if (c.status === 'depleted') return { fill: blendHex(base, pal.dud, 0.08) };

  // Open zone: tightest reading among the seats whose readings are visible here.
  let lo = 0;
  let hi = 100;
  for (let k = 0; k < a.seats.length; k++) {
    const r = a.seats[k].known[i];
    if (r[0] > lo) lo = r[0];
    if (r[1] < hi) hi = r[1];
  }
  let fill = base;
  let glow = 0;
  const span = hi - lo;
  if (span < 100) {
    const mid = (lo + hi) / 2;
    // Only confident, rich readings glow; faint neighbour hints stay near-dark for contrast.
    const al = Math.pow(1 - span / 100, 1.5) * Math.pow(mid / 100, 1.15) * 1.3;
    if (al >= 0.03) { glow = Math.min(0.9, al); fill = blendHex(base, heatColor(pal, mid), glow); }
  }
  if (a.ownLive && glow < 0.25) {
    // Where the other seats have probed is public (you see their pings tick by tick),
    // so show it as a neutral grey trail over anything but a strong reading of yours.
    // What they read stays hidden.
    let n = 0;
    for (const s of g.seats) if (s.id !== YOU) n += s.probes[i];
    if (n > 0) fill = blendHex(fill, a.trail, 0.14 + 0.06 * Math.min(n, 4));
  }
  const dot = c.ping ? { color: a.colorOf.get(c.ping) ?? '#ffffff', size: 0.36 } : undefined;
  return dot ? { fill, dot } : { fill };
}

// ---------- drawing ----------
export interface OverviewOptions {
  bg: string;
  /** Labels + your-arena outline (off in clean / text-off mode). */
  text: boolean;
  /** Arena index to outline as yours. */
  highlight: number | null;
  /** Bottom caption, used for exports. */
  caption?: string;
  palette?: Palette;
}

export function drawOverview(ctx: CanvasRenderingContext2D, world: World, l: Layout, o: OverviewOptions) {
  const pal = o.palette ?? DEFAULT_PALETTE;
  const { px, ox, cell, span } = l;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, px, px);
  // The 50x50 block is first filled with the divider colour; cells cover all of it
  // except the thin breaks between arenas.
  ctx.fillStyle = pal.divider ?? o.bg;
  ctx.fillRect(ox, ox, span, span);

  const size = CONFIG.size;
  const cells = new Map<string, number[]>();
  const dots = new Map<string, number[]>();
  const add = (m: Map<string, number[]>, k: string, x: number, y: number, w: number) => {
    let a = m.get(k);
    if (!a) { a = []; m.set(k, a); }
    a.push(x, y, w);
  };
  for (const a of world.arenas) {
    const actx = arenaContext(world, a.index, pal);
    for (let i = 0; i < a.game.cells.length; i++) {
      const r = cellRect(l, a.row, a.col, i % size, (i / size) | 0);
      const v = visualAt(actx, i);
      add(cells, v.fill, r.x, r.y, cell);
      if (v.dot) {
        const d = Math.max(1, Math.round(cell * v.dot.size));
        const off = Math.floor((cell - d) / 2);
        add(dots, v.dot.color, r.x + off, r.y + off, d);
      }
    }
  }
  for (const m of [cells, dots]) {
    for (const [color, r] of m) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < r.length; k += 3) ctx.rect(r[k], r[k + 1], r[k + 2], r[k + 2]);
      ctx.fill();
    }
  }

  const light = luminance(o.bg) > 0.55;
  if (o.text) {
    if (o.highlight !== null && o.highlight >= 0) {
      const a = world.arenas[o.highlight];
      const lw = Math.max(2, l.gap);
      ctx.strokeStyle = pal.you;
      ctx.lineWidth = lw;
      const x = ox + a.col * l.pitch;
      const y = ox + a.row * l.pitch;
      ctx.strokeRect(x - lw / 2, y - lw / 2, l.arena + lw, l.arena + lw);
    }
    const fs = Math.max(9, Math.round(cell * 0.95));
    ctx.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (const a of world.arenas) {
      const x = ox + a.col * l.pitch;
      const y = ox + a.row * l.pitch;
      const tw = ctx.measureText(a.id).width;
      const pad = Math.max(2, Math.round(fs * 0.25));
      ctx.fillStyle = 'rgba(2,8,7,0.62)';
      ctx.fillRect(x, y, Math.ceil(tw + pad * 2), Math.ceil(fs + pad * 1.4));
      ctx.fillStyle = a.index === o.highlight ? pal.you : 'rgba(217,255,242,0.85)';
      ctx.fillText(a.id, x + pad, y + pad * 0.8);
    }
  }
  if (o.caption) {
    const m = ox;
    const fs = Math.max(10, Math.round(m * 0.45));
    ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = light ? 'rgba(0,0,0,0.6)' : 'rgba(217,255,242,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(o.caption, m, px - m / 2);
    ctx.textAlign = 'right';
    ctx.fillText('substrate.gearup.wtf', px - m, px - m / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/** Render the piece off-screen at high resolution (~2048 px) and return a PNG blob. */
export function renderPng(world: World, o: OverviewOptions, target = 2048): Promise<Blob> {
  const px = o.caption ? target : fitPx(target);
  const l = computeLayout(px);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  drawOverview(ctx, world, l, o);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });
}
