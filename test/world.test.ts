import { describe, it, expect, beforeEach } from 'vitest';
import { CONFIG, YOU, verifyCommit, xyOf } from '../src/game';
import {
  World, ARENA_COUNT, SEATS_PER_ARENA, TOTAL_SEATS, GLOBAL_SIZE, HOME_ARENA,
  arenaId, arenaIndex, globalCell, localCell, arenaSeed,
} from '../src/world';
import { saveScore, loadScores } from '../src/scores';

describe('world setup', () => {
  it('creates 25 arenas with distinct seeds and commits', () => {
    const w = new World('master-1');
    expect(w.arenas).toHaveLength(ARENA_COUNT);
    expect(new Set(w.arenas.map((a) => a.seed)).size).toBe(25);
    expect(new Set(w.arenas.map((a) => a.game.commit)).size).toBe(25);
    expect(w.arenas.map((a) => a.id)).toEqual(
      ['A', 'B', 'C', 'D', 'E'].flatMap((r) => [1, 2, 3, 4, 5].map((c) => `${r}${c}`)),
    );
    w.arenas.forEach((a) => expect(a.seed).toBe(arenaSeed('master-1', 1, a.index)));
  });

  it('is deterministic from the master seed', () => {
    const a = new World('same');
    const b = new World('same');
    const c = new World('other');
    expect(a.arenas.map((x) => x.game.commit)).toEqual(b.arenas.map((x) => x.game.commit));
    expect(a.listArenas().map((x) => x.seats.map((s) => s.name))).toEqual(b.listArenas().map((x) => x.seats.map((s) => s.name)));
    expect(a.arenas[0].game.commit).not.toBe(c.arenas[0].game.commit);
    for (let t = 0; t < 15; t++) { a.step(); b.step(); }
    expect(JSON.stringify(a.leaderboard())).toBe(JSON.stringify(b.leaderboard()));
  });

  it('has 4 seats per arena = 100 seats, all house at start, unique names', () => {
    const w = new World('seats');
    w.arenas.forEach((a) => expect(a.game.seats).toHaveLength(SEATS_PER_ARENA));
    const all = w.allSeats();
    expect(all).toHaveLength(TOTAL_SEATS);
    expect(all.every((s) => s.seat.kind === 'house')).toBe(true);
    expect(new Set(all.map((s) => s.seat.name)).size).toBe(100);
    expect(new Set(all.map((s) => s.seat.id)).size).toBe(100);
    w.arenas.forEach((a) => expect(new Set(a.game.seats.map((s) => s.color)).size).toBe(4));
  });

  it('C3 keeps the original Vex-7 / Orin / Null.Kid table', () => {
    const w = new World('home');
    expect(arenaId(HOME_ARENA)).toBe('C3');
    expect(w.arena('C3')!.game.seats.slice(0, 3).map((s) => s.name)).toEqual(['Vex-7', 'Orin', 'Null.Kid']);
  });

  it('parses arena ids', () => {
    expect(arenaIndex('A1')).toBe(0);
    expect(arenaIndex('c3')).toBe(12);
    expect(arenaIndex('E5')).toBe(24);
    expect(arenaIndex('25')).toBe(24);
    expect(arenaIndex(7)).toBe(7);
    expect(arenaIndex('F1')).toBe(-1);
    expect(arenaIndex(25)).toBe(-1);
  });
});

describe('shared clock and rounds', () => {
  it('all arenas tick together', () => {
    const w = new World('clock');
    w.step();
    w.step();
    expect(w.arenas.every((a) => a.game.tick === 2)).toBe(true);
  });

  it('reveals every arena at tick 40, verifies commits, then rolls into a new round with new seeds', () => {
    const w = new World('rollover');
    const seeds1 = w.arenas.map((a) => a.seed);
    let ev = '';
    for (let t = 0; t < CONFIG.maxTicks; t++) ev = w.step();
    expect(ev).toBe('reveal');
    expect(w.phase).toBe('reveal');
    expect(w.arenas.every((a) => a.game.over && a.verified === true)).toBe(true);
    expect(w.arenas.every((a) => verifyCommit(a.seed, a.game.commit))).toBe(true);
    expect(w.summary().verified).toBe(25);
    const names1 = w.allSeats().map((s) => s.seat.name);
    expect(w.step()).toBe('round');
    expect(w.round).toBe(2);
    expect(w.phase).toBe('play');
    expect(w.tick).toBe(0);
    expect(w.arenas.every((a) => a.round === 2)).toBe(true);
    const seeds2 = w.arenas.map((a) => a.seed);
    expect(seeds2.some((s, i) => s === seeds1[i])).toBe(false);
    expect(new Set(seeds2).size).toBe(25);
    expect(w.allSeats().map((s) => s.seat.name)).toEqual(names1); // line-ups carry over
    expect(w.allSeats().every((s) => s.seat.score === 0)).toBe(true);
  });

  it('house bots claim zones across the board', () => {
    const w = new World('busy');
    w.runToReveal();
    const claimed = w.arenas.reduce((n, a) => n + a.game.cells.filter((c) => c.status === 'owned').length, 0);
    expect(claimed).toBeGreaterThan(50);
    expect(w.leaderboard()[0].score).toBeGreaterThan(0);
  });
});

describe('seats', () => {
  it('a human replaces a house seat and keeps the 100-seat total', () => {
    const w = new World('join');
    const seat = w.join('C3');
    expect(seat?.id).toBe(YOU);
    expect(w.humanArena).toBe(12);
    const c3 = w.arena('C3')!.game;
    expect(c3.seats.filter((s) => s.kind === 'human')).toHaveLength(1);
    expect(c3.seats.filter((s) => s.kind === 'house')).toHaveLength(3);
    expect(c3.seats.slice(0, 3).map((s) => s.name)).toEqual(['Vex-7', 'Orin', 'Null.Kid']);
    expect(w.allSeats()).toHaveLength(100);
    expect(w.summary()).toMatchObject({ humans: 1, house: 99 });
    expect(c3.credits).toBe(CONFIG.startCredits);
  });

  it('human actions drive the shared clock; maintain does not', () => {
    const w = new World('drive');
    w.join(0);
    const g = w.arenas[0].game;
    const i = g.map.findIndex((z) => z.value >= 30);
    const { x, y } = xyOf(i);
    const r = w.act('claim', x, y);
    expect(r.ok).toBe(true);
    expect(w.arenas.every((a) => a.game.tick === 1)).toBe(true);
    if (g.cells[i].owner === YOU) {
      expect(w.act('maintain', x, y).ok).toBe(true);
      expect(w.tick).toBe(1);
    }
    expect(w.act('wait').ok).toBe(true);
    expect(w.tick).toBe(2);
  });

  it('mid-round replacement collapses the leaving bot\'s zones; leaving hands the seat back to the house', () => {
    const w = new World('swap');
    for (let t = 0; t < 20; t++) w.step();
    const g = w.arenas[3].game;
    const house = g.seats.filter((s) => s.kind === 'house');
    const lowest = [...house].sort((a, b) => a.score - b.score)[0];
    const owned = g.ownedBy(lowest.id);
    w.join(3);
    expect(g.seat(lowest.id)).toBeUndefined();
    owned.forEach((i) => expect(g.cells[i].status).toBe('depleted'));
    expect(g.you!.score).toBe(0);
    w.leave();
    expect(w.humanArena).toBeNull();
    expect(g.seats.every((s) => s.kind === 'house')).toBe(true);
    expect(w.allSeats()).toHaveLength(100);
  });

  it('switching arenas leaves the old one', () => {
    const w = new World('switch');
    w.join('A1');
    w.join('E5');
    expect(w.arena('A1')!.game.you).toBeUndefined();
    expect(w.arena('E5')!.game.you).toBeDefined();
    expect(w.summary().humans).toBe(1);
  });

  it('agent seats play by player rules alongside house bots', () => {
    const w = new World('agent');
    const s = w.seatAt(5, { id: 'agent-1', kind: 'agent', name: 'Probe.ai', color: '#ffffff' })!;
    expect(s.kind).toBe('agent');
    const g = w.arenas[5].game;
    expect(g.act('agent-1', 'probe', 4, 4).ok).toBe(true);
    expect(s.credits).toBe(CONFIG.startCredits - CONFIG.probeCost);
    expect(g.act(g.seats.find((x) => x.kind === 'house')!.id, 'probe', 1, 1).ok).toBe(false);
  });

  it('a busted human is marked out; the round keeps running to tick 40', () => {
    const w = new World('bust');
    w.join(0);
    const g = w.arenas[0].game;
    g.rivals.forEach((r) => { r.actChance = 0; });
    let guard = 0;
    while (!g.you!.out && guard++ < 60) {
      const i = g.map.findIndex((z, k) => g.cells[k].status === 'open' && z.value < CONFIG.claimThreshold);
      const { x, y } = xyOf(i);
      w.act('claim', x, y);
    }
    expect(g.you!.out).toBe(true);
    expect(g.over).toBe(false);
    expect(w.act('wait').ok).toBe(false);
    w.runToReveal();
    expect(g.over).toBe(true);
    expect(g.tick).toBe(CONFIG.maxTicks);
  });
});

describe('overview mapping', () => {
  it('maps arena (row, col) + cell (x, y) to the 50x50 grid', () => {
    expect(GLOBAL_SIZE).toBe(50);
    expect(globalCell(0, 0, 0, 0)).toEqual({ gx: 0, gy: 0, gi: 0 });
    expect(globalCell(4, 4, 9, 9)).toEqual({ gx: 49, gy: 49, gi: 2499 });
    expect(globalCell(2, 3, 4, 5)).toEqual({ gx: 34, gy: 25, gi: 25 * 50 + 34 });
    expect(localCell(34, 25)).toEqual({ arena: 13, row: 2, col: 3, x: 4, y: 5 });
  });
  it('is a bijection over all 2500 cells', () => {
    const seen = new Set<number>();
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const g = globalCell(r, c, x, y);
      seen.add(g.gi);
      expect(localCell(g.gx, g.gy)).toEqual({ arena: r * 5 + c, row: r, col: c, x, y });
    }
    expect(seen.size).toBe(2500);
  });
});

describe('records', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(), key: () => null, length: 0,
    } as Storage;
  });
  it('keeps the top 10 tagged with arena and round', () => {
    for (let i = 0; i < 12; i++) {
      saveScore({ name: `p${i}`, score: i * 10, seed: 's', commit: 'c', date: new Date(2026, 9, 7, 0, i).toISOString(), arena: 'C3', round: i + 1 });
    }
    const list = loadScores();
    expect(list).toHaveLength(10);
    expect(list[0]).toMatchObject({ score: 110, arena: 'C3', round: 12 });
  });
});
