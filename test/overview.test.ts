import { describe, it, expect } from 'vitest';
import { YOU, xyOf } from '../src/game';
import { World } from '../src/world';
import {
  computeLayout, fitPx, cellRect, hitArena, cellVisual, seatColor, seatColorIn, sanitizePalette,
  DEFAULT_PALETTE, gapFor, type Palette,
} from '../src/overview';

describe('tight integer layout', () => {
  it('uses whole-pixel cells and breaks, and fits the canvas', () => {
    for (const px of [300, 412, 1029, 1081, 817, 1400, 2048]) {
      const l = computeLayout(px);
      for (const v of [l.ox, l.cell, l.gap, l.arena, l.pitch, l.span]) expect(Number.isInteger(v)).toBe(true);
      expect(l.span).toBe(50 * l.cell + 4 * l.gap);
      expect(l.ox).toBeGreaterThanOrEqual(0);
      expect(l.ox * 2 + l.span).toBeLessThanOrEqual(px);
      expect(l.gap).toBe(gapFor(px));
    }
  });
  it('break is ~1-2 css px on a phone and scales up in the 2048 export', () => {
    const phone = computeLayout(fitPx(392 * 2.625));
    expect(phone.gap / 2.625).toBeGreaterThanOrEqual(1);
    expect(phone.gap / 2.625).toBeLessThanOrEqual(2);
    const big = computeLayout(fitPx(2048));
    expect(big.gap).toBeGreaterThan(phone.gap);
    expect(big.cell).toBeGreaterThanOrEqual(38);
  });
  it('fitPx leaves no slack, so the canvas is never stretched', () => {
    for (const avail of [500, 1029, 1500, 2048]) {
      const px = fitPx(avail);
      expect(px).toBeLessThanOrEqual(avail);
      const l = computeLayout(px);
      expect(px - l.span).toBe(2 * l.ox);
      expect(computeLayout(px).cell).toBe(computeLayout(avail).cell);
    }
  });
  it('cells touch edge to edge inside an arena; only arenas have a break', () => {
    const l = computeLayout(1029);
    const a = cellRect(l, 1, 2, 3, 4);
    expect(cellRect(l, 1, 2, 4, 4).x).toBe(a.x + l.cell);
    expect(cellRect(l, 1, 2, 3, 5).y).toBe(a.y + l.cell);
    expect(cellRect(l, 1, 3, 0, 0).x - (cellRect(l, 1, 2, 9, 0).x + l.cell)).toBe(l.gap);
    expect(cellRect(l, 4, 4, 9, 9).x + l.cell).toBe(l.ox + l.span);
  });
  it('hit-tests arena centres and corners', () => {
    const l = computeLayout(1029);
    for (let i = 0; i < 25; i++) {
      const r = cellRect(l, Math.floor(i / 5), i % 5, 5, 5);
      expect(hitArena(l, r.x, r.y)).toBe(i);
    }
    expect(hitArena(l, 0, 0)).toBeNull();
  });
});

describe('palette', () => {
  it('sanitizes junk to defaults and keeps valid colours', () => {
    expect(sanitizePalette(null)).toEqual(DEFAULT_PALETTE);
    const p = sanitizePalette({ heat: '#FFFFFF', you: 'red', seats: ['#112233', 5], divider: '#000000' });
    expect(p.heat).toBe('#ffffff');
    expect(p.you).toBe(DEFAULT_PALETTE.you);
    expect(p.seats).toEqual(['#112233', null, null, null]);
    expect(p.divider).toBe('#000000');
  });
  it('resolves seat colours: you, slot override, else the bot colour', () => {
    const pal: Palette = { ...DEFAULT_PALETTE, you: '#ffe14d', seats: [null, '#123456', null, null] };
    expect(seatColor({ id: YOU, color: '#3ee6ff' }, 3, pal)).toBe('#ffe14d');
    expect(seatColor({ id: 'h1', color: '#ff4fd8' }, 1, pal)).toBe('#123456');
    expect(seatColor({ id: 'h2', color: '#ff4fd8' }, 0, pal)).toBe('#ff4fd8');
    const w = new World('pal');
    const g = w.arenas[0].game;
    expect(seatColorIn(g, g.seats[1].id, pal)).toBe('#123456');
  });
});

describe('own arena on the map', () => {
  const setup = () => {
    const w = new World('own-arena');
    w.join('C3');
    for (let t = 0; t < 20; t++) w.step();
    return { w, g: w.arena('C3')!.game, ai: 12 };
  };

  it('shows rival claims in their colours while you are live', () => {
    const { w, g, ai } = setup();
    const owned = g.cells.map((c, i) => [c, i] as const).filter(([c]) => c.status === 'owned' && c.owner !== YOU);
    expect(owned.length).toBeGreaterThan(0);
    const pal: Palette = { ...DEFAULT_PALETTE, seats: ['#ff0000', '#ff0000', '#ff0000', '#ff0000'] };
    for (const [, i] of owned) {
      const v = cellVisual(w, ai, i, pal);
      const [r, gg, b] = [1, 3, 5].map((k) => parseInt(v.fill.slice(k, k + 2), 16));
      expect(r).toBeGreaterThan(gg + 40); // tinted toward the rival's (red) colour
      expect(r).toBeGreaterThan(b + 40);
    }
  });

  it('never leaks rival readings: cells only rivals probed show a neutral trail, not heat', () => {
    const { w, g, ai } = setup();
    const you = g.you!;
    const pal: Palette = { ...DEFAULT_PALETTE, heat: '#ff00ff' };
    let checked = 0;
    g.cells.forEach((c, i) => {
      if (c.status !== 'open' || you.known[i][1] - you.known[i][0] < 100) return;
      const rivalProbes = g.seats.filter((s) => s.id !== YOU).reduce((n, s) => n + s.probes[i], 0);
      const v = cellVisual(w, ai, i, pal);
      const [r, gg, b] = [1, 3, 5].map((k) => parseInt(v.fill.slice(k, k + 2), 16));
      expect(Math.abs(r - b)).toBeLessThan(25); // no magenta heat
      expect(gg).toBeGreaterThanOrEqual(Math.min(r, b) - 1);
      if (rivalProbes > 0) { expect(v.fill).not.toBe(DEFAULT_PALETTE.base); checked++; }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('shows your own readings as heat', () => {
    const w = new World('own-heat');
    w.join('C3');
    const g = w.arena('C3')!.game;
    const best = g.map.reduce((b, z, i) => (z.value > g.map[b].value ? i : b), 0);
    const { x, y } = xyOf(best);
    for (let k = 0; k < 3 && g.cells[best].status === 'open'; k++) w.act('probe', x, y);
    if (g.cells[best].status === 'open') {
      const pal: Palette = { ...DEFAULT_PALETTE, heat: '#ff00ff' };
      const v = cellVisual(w, 12, best, pal);
      const [r, gg, b] = [1, 3, 5].map((k) => parseInt(v.fill.slice(k, k + 2), 16));
      expect(r).toBeGreaterThan(gg + 30);
      expect(b).toBeGreaterThan(gg + 30);
    }
  });

  it('shows everything once you are out or the round is revealed', () => {
    const { w, g, ai } = setup();
    const pal: Palette = { ...DEFAULT_PALETTE, heat: '#ff00ff' };
    const glowCount = () => g.cells.filter((_, i) => {
      const f = cellVisual(w, ai, i, pal).fill;
      const [r, gg] = [1, 3].map((k) => parseInt(f.slice(k, k + 2), 16));
      return g.cells[i].status === 'open' && r > gg + 30;
    }).length;
    const live = glowCount();
    g.you!.out = true;
    expect(glowCount()).toBeGreaterThan(live);
  });
});
