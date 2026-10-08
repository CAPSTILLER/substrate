import { describe, it, expect } from 'vitest';
import {
  makeRoom, stepRoom, claimZone, zoneAt, zoneCenter, ROOM, ZONE, type EyeDef, type Room,
} from '../src/room/sim';
import { CONFIG, verifyCommit } from '../src/game';

const DT = 1 / 60;
const still = { mx: 0, my: 0, claim: false };
const run = (r: Room, secs: number, input = still) => { for (let t = 0; t < secs - 1e-9; t += DT) stepRoom(r, input, DT); };
const width = (r: Room, i: number) => r.cells[i].known[1] - r.cells[i].known[0];
// An eye on the top edge looking straight down, permanently open (closed = 0, trans tiny).
const openEye: EyeDef = { x: 200, y: -10, facing: Math.PI / 2, cone: 1.2, range: 500, closed: 0, trans: 0.001, open: 1000, offset: 0.5, panAmp: 0, panSpeed: 0 };
const closedEye: EyeDef = { ...openEye, closed: 1000, open: 0.001, offset: 0 };

describe('room: seeded map + commit', () => {
  it('uses the Substrate map and a verifiable commit', () => {
    const r = makeRoom('room-seed', { rivals: false, eyes: [] });
    expect(r.map).toHaveLength(100);
    expect(verifyCommit('room-seed', r.commit)).toBe(true);
  });
});

describe('room: scan = stillness', () => {
  it('narrows the reading the longer you stand still', () => {
    const r = makeRoom('scan', { rivals: false, eyes: [] });
    const i = zoneAt(r.you.x, r.you.y);
    run(r, 0.9);
    expect(r.cells[i].scans).toBe(0);
    run(r, 0.2); // 1.1 s still
    expect(r.cells[i].scans).toBe(1);
    const w1 = width(r, i);
    expect(w1).toBeLessThanOrEqual(CONFIG.probeBaseWidth + 1);
    run(r, 3); // ~4.1 s still
    expect(r.cells[i].scans).toBe(4);
    expect(width(r, i)).toBeLessThan(w1);
    expect(width(r, i)).toBeLessThanOrEqual(10);
    const v = r.map[i].value;
    expect(r.cells[i].known[0]).toBeLessThanOrEqual(v);
    expect(r.cells[i].known[1]).toBeGreaterThanOrEqual(v);
    // neighbours got a faint hint, but no direct scans
    const n = i - 1;
    expect(r.cells[n].scans).toBe(0);
    expect(width(r, n)).toBeLessThan(100);
  });

  it('moving cancels the scan charge', () => {
    const r = makeRoom('move', { rivals: false, eyes: [] });
    run(r, 0.8);
    expect(r.you.still).toBeGreaterThan(0.7);
    run(r, 0.1, { mx: -1, my: 0, claim: false });
    expect(r.you.still).toBe(0);
    run(r, 0.5);
    expect(r.cells.every((c) => c.scans === 0)).toBe(true);
  });
});

describe('room: watcher eyes', () => {
  const place = (r: Room) => { r.you.x = 200; r.you.y = 200; r.grace = 0; };

  it('standing still inside an open cone is safe', () => {
    const r = makeRoom('eye', { rivals: false, eyes: [openEye] });
    place(r);
    run(r, 3);
    expect(r.watched).toBe(true);
    expect(r.spotted).toBe(0);
    expect(r.credits).toBe(ROOM.startCredits);
  });

  it('moving inside an open cone gets you spotted, costs credits and pushes you back', () => {
    const r = makeRoom('eye', { rivals: false, eyes: [openEye] });
    place(r);
    run(r, 0.1); // let the eye open
    const before = r.you.y;
    stepRoom(r, { mx: 1, my: 0, claim: false }, DT);
    expect(r.spotted).toBe(1);
    expect(r.credits).toBe(ROOM.startCredits - ROOM.spotCost);
    expect(r.you.y).toBeGreaterThan(before + ROOM.spotPush * 0.8); // pushed away from the eye (down)
  });

  it('moving while the eye is closed is fine', () => {
    const r = makeRoom('eye', { rivals: false, eyes: [closedEye] });
    place(r);
    run(r, 1, { mx: 1, my: 0, claim: false });
    expect(r.spotted).toBe(0);
  });

  it('moving outside the cone is fine even when open', () => {
    const r = makeRoom('eye', { rivals: false, eyes: [{ ...openEye, cone: 0.3 }] });
    place(r); r.you.x = 30; r.you.y = 380;
    run(r, 0.5, { mx: 0, my: -1, claim: false });
    expect(r.spotted).toBe(0);
  });
});

describe('room: claim, payout, decay', () => {
  const richest = (r: Room) => r.map.reduce((b, z, i) => (z.value > r.map[b].value ? i : b), 0);

  it('hold Claim while still to claim; rich zones pay out', () => {
    const r = makeRoom('claim', { rivals: false, eyes: [] });
    const i = richest(r);
    const c = zoneCenter(i); r.you.x = c.x; r.you.y = c.y;
    run(r, 0.5, { mx: 0, my: 0, claim: true });
    expect(r.cells[i].status).toBe('open'); // not held long enough
    run(r, ROOM.claimHold, { mx: 0, my: 0, claim: true });
    expect(r.cells[i].status).toBe('owned');
    const h = Math.round(r.map[i].value * CONFIG.claimHarvestRate);
    expect(r.you.score).toBeGreaterThanOrEqual(h);
  });

  it('duds and hazards cost credits', () => {
    const r = makeRoom('claim', { rivals: false, eyes: [] });
    const dud = r.map.findIndex((z) => !z.hazard && z.value < CONFIG.claimThreshold);
    const haz = r.map.findIndex((z) => z.hazard);
    expect(claimZone(r, dud, r.you)).toBe('dud');
    expect(r.credits).toBe(ROOM.startCredits - ROOM.claimCost);
    expect(claimZone(r, haz, r.you)).toBe('hazard');
    expect(r.credits).toBe(ROOM.startCredits - 2 * ROOM.claimCost - ROOM.hazardPenalty);
  });

  it('owned zones decay when you are away and recover when you stand on them', () => {
    const r = makeRoom('decay', { rivals: false, eyes: [] });
    const i = richest(r);
    expect(claimZone(r, i, r.you)).toBe('good');
    const c = zoneCenter(i);
    r.you.x = c.x < 200 ? 380 : 20; r.you.y = c.y < 200 ? 380 : 20; // far away
    run(r, 10);
    expect(r.cells[i].integrity).toBeCloseTo(100 - ROOM.decayPerSec * 10, 0);
    const scoreBefore = r.you.score;
    run(r, ROOM.yieldEvery);
    expect(r.you.score).toBeGreaterThan(scoreBefore); // still paying, just less
    r.you.x = c.x; r.you.y = c.y;
    run(r, 2);
    expect(r.cells[i].integrity).toBe(100);
  });

  it('the run ends at the timer and verifies the commit', () => {
    const r = makeRoom('end', { eyes: [] });
    run(r, ROOM.duration + 0.1);
    expect(r.ended).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.rivals.length).toBe(3);
  });

  it('zone helpers line up', () => {
    expect(zoneAt(ZONE * 2.5, ZONE * 3.5)).toBe(32);
  });
});
