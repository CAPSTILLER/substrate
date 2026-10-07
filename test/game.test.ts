import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CONFIG, Game, generateMap, serializeMap, commitHash, verifyCommit, narrow, probeWidth,
  claimHarvest, tickYield, decay, idx, xyOf, type Range,
} from '../src/game';
import { mulberry32 } from '../src/rng';
import { sha256Hex } from '../src/sha256';

describe('map generation', () => {
  it('is deterministic for a seed', () => {
    expect(serializeMap(generateMap('abc123'))).toBe(serializeMap(generateMap('abc123')));
  });
  it('differs between seeds', () => {
    expect(serializeMap(generateMap('abc123'))).not.toBe(serializeMap(generateMap('abc124')));
  });
  it('has 100 zones in range with veins, empties and hazards', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const m = generateMap(seed);
      expect(m).toHaveLength(100);
      expect(m.every((z) => z.value >= 0 && z.value <= 100)).toBe(true);
      expect(m.filter((z) => z.hazard)).toHaveLength(CONFIG.hazards);
      expect(m.some((z) => z.value >= 50)).toBe(true); // at least one rich vein
      const low = m.filter((z) => z.value < CONFIG.claimThreshold).length;
      expect(low).toBeGreaterThan(50); // most zones are poor
    }
  });
});

describe('commit / reveal', () => {
  it('sha256 matches node crypto', () => {
    for (const s of ['', 'abc', 'substrate ✓ ünïcode', 'x'.repeat(200)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
  it('commit verifies with the real seed and fails with another', () => {
    const seed = 'deadbeef01';
    const c = commitHash(seed, generateMap(seed));
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCommit(seed, c)).toBe(true);
    expect(verifyCommit('deadbeef02', c)).toBe(false);
  });
  it('hides the seed and values until the run ends', () => {
    const g = new Game('hidden');
    expect(g.state().seed).toBeNull();
    expect(g.state().zones[0].value).toBeUndefined();
    while (!g.over) g.endTurn();
    expect(g.state().seed).toBe('hidden');
    expect(typeof g.state().zones[0].value).toBe('number');
  });
});

describe('probing', () => {
  it('widths shrink with repeat probes', () => {
    expect(probeWidth(1)).toBe(40);
    expect(probeWidth(2)).toBeLessThan(probeWidth(1));
    expect(probeWidth(20)).toBe(CONFIG.minWidth);
  });
  it('narrow always contains the true value and never widens', () => {
    const rng = mulberry32(7);
    for (let v = 0; v <= 100; v += 5) {
      let known: Range = [0, 100];
      for (let n = 1; n <= 6; n++) {
        const next = narrow(known, v, probeWidth(n), rng);
        expect(next[0]).toBeLessThanOrEqual(v);
        expect(next[1]).toBeGreaterThanOrEqual(v);
        expect(next[1] - next[0]).toBeLessThanOrEqual(known[1] - known[0]);
        known = next;
      }
      expect(known[1] - known[0]).toBeLessThanOrEqual(probeWidth(6) + 1);
    }
  });
  it('repeat probes on the same zone narrow it; neighbours get fainter hints', () => {
    const g = new Game('probe-test');
    const i = idx(5, 5);
    g.probe(5, 5);
    const w1 = g.cells[i].known[1] - g.cells[i].known[0];
    g.probe(5, 5);
    g.probe(5, 5);
    const w3 = g.cells[i].known[1] - g.cells[i].known[0];
    expect(w3).toBeLessThan(w1);
    expect(w1).toBeLessThanOrEqual(41);
    const near = g.cells[idx(6, 5)].known;
    const far = g.cells[idx(9, 9)].known;
    expect(near[1] - near[0]).toBeLessThan(100);
    expect(far).toEqual([0, 100]);
    expect(g.credits).toBe(CONFIG.startCredits - 3 * CONFIG.probeCost + (g.score)); // no claims => score 0
    expect(g.tick).toBe(3);
  });
});

describe('claims, yield and decay', () => {
  it('math helpers', () => {
    expect(claimHarvest(80)).toBe(40);
    expect(tickYield(80, 100)).toBe(4);
    expect(tickYield(80, 50)).toBe(2);
    expect(decay(100)).toBe(100 - CONFIG.decayPerTick);
    expect(decay(5)).toBe(0);
  });

  const findZone = (g: Game, pred: (v: number, h: boolean) => boolean) => {
    const i = g.map.findIndex((z) => pred(z.value, z.hazard));
    return { i, ...xyOf(i) };
  };

  it('a good claim harvests, yields each tick and decays; maintain restores', () => {
    const g = new Game('claim-test');
    g.rivals.forEach((r) => { r.actChance = 0; }); // keep rivals out of this test
    const { i, x, y } = findZone(g, (v) => v >= 40);
    const v = g.map[i].value;
    g.claim(x, y);
    const c = g.cells[i];
    expect(c.owner).toBe('you');
    // claim harvest + first tick yield at 100% integrity
    expect(g.score).toBeCloseTo(claimHarvest(v) + tickYield(v, 100), 5);
    expect(c.integrity).toBe(100 - CONFIG.decayPerTick);
    g.endTurn();
    expect(c.integrity).toBe(100 - 2 * CONFIG.decayPerTick);
    const before = g.credits;
    expect(g.maintain(x, y).ok).toBe(true);
    expect(c.integrity).toBe(100);
    expect(g.credits).toBeCloseTo(before - CONFIG.maintainCost, 5);
    expect(g.tick).toBe(2); // maintain does not use a tick
  });

  it('unmaintained zones collapse', () => {
    const g = new Game('collapse-test');
    g.rivals.forEach((r) => { r.actChance = 0; });
    const { i, x, y } = findZone(g, (v) => v >= 20);
    g.claim(x, y);
    for (let t = 0; t < 10; t++) g.endTurn();
    expect(g.cells[i].status).toBe('depleted');
    expect(g.cells[i].owner).toBeNull();
  });

  it('dud and hazard claims lose the stake', () => {
    const g = new Game('dud-test');
    g.rivals.forEach((r) => { r.actChance = 0; });
    const dud = findZone(g, (v, h) => !h && v < CONFIG.claimThreshold);
    g.claim(dud.x, dud.y);
    expect(g.cells[dud.i].status).toBe('dud');
    expect(g.credits).toBe(CONFIG.startCredits - CONFIG.claimCost);
    const hz = findZone(g, (_v, h) => h);
    g.claim(hz.x, hz.y);
    expect(g.cells[hz.i].status).toBe('hazard');
    expect(g.credits).toBe(CONFIG.startCredits - 2 * CONFIG.claimCost - CONFIG.hazardPenalty);
    expect(g.score).toBe(0);
  });
});

describe('full runs', () => {
  it('a run ends by the tick limit and replays identically from the seed', () => {
    const play = () => {
      const g = new Game('replay');
      let k = 0;
      while (!g.over) {
        const { x, y } = xyOf((k * 37) % 100);
        if (k % 4 === 3) g.claim(x, y); else if (g.probe(x, y).ok === false) g.endTurn();
        k++;
      }
      return g;
    };
    const a = play();
    const b = play();
    expect(a.over).toBe(true);
    expect(a.tick).toBeLessThanOrEqual(CONFIG.maxTicks);
    expect(JSON.stringify(a.state())).toBe(JSON.stringify(b.state()));
  });
  it('rivals claim zones over a run', () => {
    const g = new Game('rivals');
    while (!g.over) g.endTurn();
    expect(g.rivals.reduce((s, r) => s + r.zones, 0)).toBeGreaterThan(0);
  });
});
