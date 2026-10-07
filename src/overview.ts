// Canvas renderer for the 50x50 "Substrate map": all 25 arenas, top-down.
// Pure drawing: takes the world + options, never mutates game state.
import { CONFIG } from './game';
import { ARENA_SIDE, type World } from './world';

export interface OverviewOptions {
  bg: string;
  /** Labels + your-arena highlight (off in clean / text-off mode). */
  text: boolean;
  /** Arena index to outline as yours. */
  highlight: number | null;
  /** Bottom caption, used for exports. */
  caption?: string;
}

export interface Layout {
  px: number; // canvas size in device pixels
  margin: number;
  gutter: number;
  arena: number; // arena size in device pixels
  cell: number;
  gap: number;
}

export function computeLayout(px: number): Layout {
  const margin = Math.round(px * 0.022);
  const gutter = Math.max(2, Math.round(px * 0.011));
  const arena = (px - 2 * margin - (ARENA_SIDE - 1) * gutter) / ARENA_SIDE;
  const cell = arena / CONFIG.size;
  const gap = cell >= 5 ? Math.max(1, cell * 0.12) : 0;
  return { px, margin, gutter, arena, cell, gap };
}

/** Which arena (0..24) a point in device pixels falls in; gutters snap to the nearest. */
export function hitArena(l: Layout, x: number, y: number): number | null {
  const pitch = l.arena + l.gutter;
  const col = Math.floor((x - l.margin + l.gutter / 2) / pitch);
  const row = Math.floor((y - l.margin + l.gutter / 2) / pitch);
  if (col < 0 || row < 0 || col >= ARENA_SIDE || row >= ARENA_SIDE) return null;
  return row * ARENA_SIDE + col;
}

export const heatHue = (mid: number) => Math.round(mid < 60 ? 190 - mid * 1.7 : 88 - (mid - 60) * 1.4);

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const BASE = '#0b1b17';
const BASE_RGB: [number, number, number] = [11, 27, 23];

// Pre-blended opaque colours (alpha quantised to 1/50) so each cell is a single
// opaque fillRect with no globalAlpha switching. Keeps redraws cheap on phones.
const fillCache = new Map<string, string>();
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function blendOnto(base: [number, number, number], top: [number, number, number], a: number) {
  const m = (i: number) => Math.round(base[i] + (top[i] - base[i]) * a);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}
/** Heat glow of `hue` at alpha `a` over the dark cell base. */
export function heatFill(hue: number, a: number, base: [number, number, number] = BASE_RGB): string {
  const q = Math.max(0, Math.min(50, Math.round(a * 50)));
  const key = `h${hue}|${q}|${base[0]}`;
  let v = fillCache.get(key);
  if (!v) { v = blendOnto(base, hslRgb(hue, 0.95, 0.55), q / 50); fillCache.set(key, v); }
  return v;
}
/** Seat colour at alpha `a` over the dark cell base. */
export function seatFill(hex: string, a: number): string {
  const q = Math.max(0, Math.min(50, Math.round(a * 50)));
  const key = `s${hex}|${q}`;
  let v = fillCache.get(key);
  if (!v) { v = blendOnto(BASE_RGB, hexRgb(hex), q / 50); fillCache.set(key, v); }
  return v;
}
const DEPLETED_RGB: [number, number, number] = [18, 25, 23];
const DUD = '#17221f';
const DEPLETED = '#121917';
const HAZARD = '#22111a';

export function drawOverview(ctx: CanvasRenderingContext2D, world: World, l: Layout, o: OverviewOptions) {
  const { px, margin, gutter, arena: A, cell, gap } = l;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = o.bg;
  ctx.fillRect(0, 0, px, px);

  const light = luminance(o.bg) > 0.55;
  // Thin lines through the gutters so the 5x5 structure reads cleanly.
  ctx.fillStyle = light ? 'rgba(0,0,0,0.14)' : 'rgba(150,255,220,0.10)';
  const line = Math.max(1, Math.round(gutter * 0.3));
  for (let k = 1; k < ARENA_SIDE; k++) {
    const p = Math.round(margin + k * (A + gutter) - gutter / 2 - line / 2);
    ctx.fillRect(p, margin, line, px - 2 * margin);
    ctx.fillRect(margin, p, px - 2 * margin, line);
  }

  const reveal = world.phase === 'reveal';
  const size = CONFIG.size;
  const inner = cell - gap;
  const dot = Math.max(1, cell * 0.36);
  // Bucket rects by colour, then fill each colour as one path: one colour parse per
  // colour instead of per cell. ~2500 cells become a few hundred fill calls.
  const cells = new Map<string, number[]>();
  const dots = new Map<string, number[]>();
  const add = (m: Map<string, number[]>, k: string, x: number, y: number, w: number, h: number) => {
    let a = m.get(k);
    if (!a) { a = []; m.set(k, a); }
    a.push(x, y, w, h);
  };
  const hazDot = blendOnto(hexRgb(HAZARD), hexRgb('#ff5d73'), 0.35);
  const hazDotLive = blendOnto(hexRgb(HAZARD), hexRgb('#ffcf4a'), 0.5);
  const dudDot = blendOnto(hexRgb(DUD), hexRgb('#5f7f77'), 0.5);

  for (const a of world.arenas) {
    const g = a.game;
    const ax = margin + a.col * (A + gutter);
    const ay = margin + a.row * (A + gutter);
    // Your own arena shows only your readings while the round is live (no peeking at rivals).
    const own = !reveal && a.index === world.humanArena ? g.you : undefined;
    const seats = own ? [own] : g.seats;
    const colorOf = new Map(g.seats.map((s) => [s.id, s.color]));
    for (let i = 0; i < g.cells.length; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      const cx = Math.round(ax + x * cell + gap / 2);
      const cy = Math.round(ay + y * cell + gap / 2);
      const w = Math.max(1, Math.round(ax + x * cell + gap / 2 + inner) - cx);
      const h = Math.max(1, Math.round(ay + y * cell + gap / 2 + inner) - cy);
      const c = g.cells[i];
      const z = g.map[i];

      if (c.status === 'owned' && c.owner) {
        add(cells, seatFill(colorOf.get(c.owner) ?? '#ffffff', (0.42 + 0.58 * (z.value / 100)) * (0.3 + 0.7 * (c.integrity / 100))), cx, cy, w, h);
        continue;
      }
      if (reveal) {
        if (z.hazard || c.status === 'hazard') {
          add(cells, HAZARD, cx, cy, w, h);
          const d = dot / 1.5;
          add(dots, hazDot, cx + (w - d) / 2, cy + (h - d) / 2, d, d);
          continue;
        }
        const dim = c.status === 'dud' || c.status === 'depleted';
        add(cells, z.value > 0
          ? heatFill(heatHue(z.value), 0.1 + (z.value / 100) * 0.8 * (dim ? 0.5 : 1), c.status === 'depleted' ? DEPLETED_RGB : BASE_RGB)
          : (c.status === 'depleted' ? DEPLETED : BASE), cx, cy, w, h);
        continue;
      }
      if (c.status === 'dud' || c.status === 'hazard') {
        add(cells, c.status === 'dud' ? DUD : HAZARD, cx, cy, w, h);
        const d = dot / 2;
        add(dots, c.status === 'dud' ? dudDot : hazDotLive, cx + (w - d) / 2, cy + (h - d) / 2, d, d);
        continue;
      }
      if (c.status === 'depleted') { add(cells, DEPLETED, cx, cy, w, h); continue; }

      // Open zone: tightest reading among the visible seats (every reading contains the true value).
      let lo = 0;
      let hi = 100;
      for (let k = 0; k < seats.length; k++) {
        const r = seats[k].known[i];
        if (r[0] > lo) lo = r[0];
        if (r[1] < hi) hi = r[1];
      }
      let fill = BASE;
      const span = hi - lo;
      if (span < 100) {
        const mid = (lo + hi) / 2;
        // Only confident, rich readings glow; faint neighbour hints stay near-dark so the piece has contrast.
        const al = Math.pow(1 - span / 100, 1.5) * Math.pow(mid / 100, 1.15) * 1.3;
        if (al >= 0.03) fill = heatFill(heatHue(mid), Math.min(0.9, al));
      }
      add(cells, fill, cx, cy, w, h);
      // House probe pings this tick: a small dot in the prober's colour.
      if (c.ping) add(dots, colorOf.get(c.ping) ?? '#ffffff', cx + (w - dot) / 2, cy + (h - dot) / 2, dot, dot);
    }
  }
  for (const m of [cells, dots]) {
    for (const [color, r] of m) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < r.length; k += 4) ctx.rect(r[k], r[k + 1], r[k + 2], r[k + 3]);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  if (o.text) {
    if (o.highlight !== null && o.highlight >= 0) {
      const a = world.arenas[o.highlight];
      const ax = margin + a.col * (A + gutter);
      const ay = margin + a.row * (A + gutter);
      const lw = Math.max(1.5, gutter * 0.55);
      ctx.strokeStyle = '#3ee6ff';
      ctx.lineWidth = lw;
      ctx.strokeRect(ax - gutter / 2, ay - gutter / 2, A + gutter, A + gutter);
    }
    const fs = Math.max(9, Math.round(cell * 0.95));
    ctx.font = `700 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (const a of world.arenas) {
      const ax = margin + a.col * (A + gutter);
      const ay = margin + a.row * (A + gutter);
      const label = a.id;
      const tw = ctx.measureText(label).width;
      const pad = Math.max(2, fs * 0.25);
      ctx.fillStyle = 'rgba(2,8,7,0.62)';
      ctx.fillRect(ax, ay, tw + pad * 2, fs + pad * 1.4);
      ctx.fillStyle = a.index === o.highlight ? '#3ee6ff' : 'rgba(217,255,242,0.85)';
      ctx.fillText(label, ax + pad, ay + pad * 0.8);
    }
  }
  if (o.caption) {
    const fs = Math.max(10, Math.round(margin * 0.42));
    ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = light ? 'rgba(0,0,0,0.6)' : 'rgba(217,255,242,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(o.caption, margin, px - margin / 2);
    ctx.textAlign = 'right';
    ctx.fillText('substrate.gearup.wtf', px - margin, px - margin / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/** Render the piece off-screen at high resolution and return a PNG blob. */
export function renderPng(world: World, o: OverviewOptions, px = 2048): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  drawOverview(ctx, world, computeLayout(px), o);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });
}
