// Canvas renderer for the Room test. Dark Substrate palette with I Still lighting:
// a darkness layer with light punched around you, relics, rivals and the eye cones.
import { CONFIG, zoneLabel, xyOf } from '../game';
import { N, ZONE, ROOM_W, ROOM_H, ROOM, scanCharge, zoneAt, type Room, type Actor, type Eye } from './sim';

const BG = '#040908';
const FLOOR = '#07120f';
const HEAT = [25, 245, 176]; // Substrate accent
const GOLD = '#ffcf4a';
const BAD = '#ff5d73';
const EYE_AMBER = [255, 186, 74];
const MARGIN = 26;

export interface Camera { scale: number; ox: number; oy: number }

export function fitCamera(w: number, h: number): Camera {
  const ww = ROOM_W + MARGIN * 2, wh = ROOM_H + MARGIN * 2;
  const scale = Math.min(w / ww, h / wh);
  // Tall phone stages: sit a bit above centre so the end card never covers the map.
  const free = h - wh * scale;
  return { scale, ox: (w - ROOM_W * scale) / 2, oy: MARGIN * scale + free * (free > 120 ? 0.22 : 0.5) };
}

const cam = (ctx: CanvasRenderingContext2D, c: Camera, sx: number, sy: number, dpr: number) =>
  ctx.setTransform(c.scale * dpr, 0, 0, c.scale * dpr, (c.ox + sx) * dpr, (c.oy + sy) * dpr);

const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const known = (r: Room, i: number) => r.cells[i].known;
const isRelic = (r: Room, i: number) => r.cells[i].status === 'open' && known(r, i)[0] >= 40;

function figure(ctx: CanvasRenderingContext2D, a: Actor, t: number, bright: number) {
  const moving = Math.hypot(a.vx, a.vy) > 8;
  const bob = moving ? Math.abs(Math.sin(a.anim * 1.6)) * 2.2 : Math.sin(a.anim) * 0.6;
  const x = a.x, y = a.y - bob;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.ellipse(a.x, a.y + 6, 7, 2.6, 0, 0, Math.PI * 2); ctx.fill();
  // cloak
  ctx.fillStyle = '#0d1c19';
  ctx.strokeStyle = a.color; ctx.globalAlpha = bright; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y - 17); ctx.quadraticCurveTo(x + 8, y - 12, x + 7, y + 5);
  ctx.lineTo(x - 7, y + 5); ctx.quadraticCurveTo(x - 8, y - 12, x, y - 17);
  ctx.fill(); ctx.stroke();
  // visor
  const fx = Math.cos(a.dir) * 2.2;
  ctx.fillStyle = a.color;
  ctx.shadowColor = a.color; ctx.shadowBlur = 8;
  ctx.fillRect(x - 3.5 + fx, y - 11, 7, 2.4);
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  void t;
}

function eyeSprite(ctx: CanvasRenderingContext2D, e: Eye, t: number) {
  ctx.save();
  ctx.translate(e.x, e.y);
  const o = e.openAmt;
  if (o > 0.3) {
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    g.addColorStop(0, rgba(EYE_AMBER, 0.25 + o * 0.35)); g.addColorStop(1, rgba(EYE_AMBER, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
  }
  const w = 15, h = 1 + 8 * o;
  ctx.fillStyle = '#120a06'; ctx.strokeStyle = rgba(EYE_AMBER, 0.55 + o * 0.45); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-w, 0); ctx.quadraticCurveTo(0, -h * 1.6, w, 0); ctx.quadraticCurveTo(0, h * 1.6, -w, 0);
  ctx.fill(); ctx.stroke();
  if (o > 0.15) {
    ctx.save(); ctx.clip();
    const px = Math.cos(e.facingNow) * 4, py = Math.sin(e.facingNow) * 3;
    ctx.fillStyle = rgba(EYE_AMBER, 0.95);
    ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(px, py, 1.6, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  void t;
  ctx.restore();
}

function moths(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, seed: number) {
  ctx.fillStyle = 'rgba(255,230,170,0.75)';
  for (let k = 0; k < 2; k++) {
    const u = t * (1.1 + k * 0.3) + seed * 2.3 + k * 2;
    const mx = x + Math.sin(u) * 11, my = y + Math.cos(u * 1.4) * 8 - 4;
    const flap = Math.abs(Math.sin(t * 18 + k + seed)) * 2.4 + 0.6;
    ctx.beginPath(); ctx.ellipse(mx - 1.4, my, flap, 1.1, 0.5, 0, Math.PI * 2); ctx.ellipse(mx + 1.4, my, flap, 1.1, -0.5, 0, Math.PI * 2); ctx.fill();
  }
}

export function renderRoom(
  ctx: CanvasRenderingContext2D, light: CanvasRenderingContext2D, r: Room,
  w: number, h: number, dpr: number, reduced: boolean,
) {
  const t = r.ended ? performance.now() / 1000 : r.time;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h);
  const c = fitCamera(w, h);
  const shake = reduced ? 0 : r.trauma * r.trauma * 7;
  const sx = (Math.random() * 2 - 1) * shake, sy = (Math.random() * 2 - 1) * shake;
  cam(ctx, c, sx, sy, dpr);

  // Floor + subtle zone grid
  ctx.fillStyle = FLOOR; ctx.fillRect(0, 0, ROOM_W, ROOM_H);
  for (let i = 0; i < N * N; i++) {
    const { x, y } = xyOf(i);
    const [lo, hi] = r.ended ? [r.map[i].value, r.map[i].value] : known(r, i);
    const conf = 1 - (hi - lo) / 100;
    const mid = (lo + hi) / 2 / 100;
    if (conf > 0.05) {
      ctx.fillStyle = rgba(HEAT, Math.min(0.75, mid * mid * (0.25 + conf * 0.9)));
      ctx.fillRect(x * ZONE, y * ZONE, ZONE, ZONE);
    }
  }
  ctx.strokeStyle = 'rgba(25,245,176,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= N; k++) { ctx.moveTo(k * ZONE, 0); ctx.lineTo(k * ZONE, ROOM_H); ctx.moveTo(0, k * ZONE); ctx.lineTo(ROOM_W, k * ZONE); }
  ctx.stroke();
  // walls
  ctx.strokeStyle = '#17332d'; ctx.lineWidth = 6; ctx.strokeRect(-3, -3, ROOM_W + 6, ROOM_H + 6);

  // Relics: zones whose reading says rich
  for (let i = 0; i < N * N; i++) {
    if (r.ended || !isRelic(r, i)) continue;
    const { x, y } = xyOf(i);
    const cx = (x + 0.5) * ZONE, cy = (y + 0.5) * ZONE;
    const pulse = 0.5 + Math.sin(t * 3.2 + i) * 0.5;
    ctx.fillStyle = GOLD; ctx.globalAlpha = 0.65 + pulse * 0.35;
    ctx.beginPath(); ctx.moveTo(cx, cy - 7 - pulse * 2); ctx.lineTo(cx + 4.5, cy); ctx.lineTo(cx, cy + 7 + pulse * 2); ctx.lineTo(cx - 4.5, cy); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Figures
  for (const k of r.rivals) figure(ctx, k, t, 0.9);
  figure(ctx, r.you, t, 1);
  for (const e of r.eyes) eyeSprite(ctx, e, t);

  // Darkness layer (I Still lighting)
  light.setTransform(dpr, 0, 0, dpr, 0, 0);
  light.clearRect(0, 0, w, h);
  if (!r.ended) {
    cam(light, c, sx, sy, dpr);
    light.fillStyle = r.watched ? 'rgba(0,0,0,0.9)' : 'rgba(1,5,4,0.8)';
    light.fillRect(-MARGIN * 2, -MARGIN * 2, ROOM_W + MARGIN * 4, ROOM_H + MARGIN * 4);
    light.globalCompositeOperation = 'destination-out';
    const punch = (x: number, y: number, rad: number, a = 1) => {
      const g = light.createRadialGradient(x, y, 4, x, y, rad);
      g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      light.fillStyle = g; light.beginPath(); light.arc(x, y, rad, 0, Math.PI * 2); light.fill();
    };
    punch(r.you.x, r.you.y - 6, 120);
    for (const k of r.rivals) punch(k.x, k.y - 6, 40, 0.8);
    for (let i = 0; i < N * N; i++) {
      if (!isRelic(r, i) && !(r.cells[i].status === 'owned')) continue;
      const { x, y } = xyOf(i);
      punch((x + 0.5) * ZONE, (y + 0.5) * ZONE, 34, 0.75);
    }
    for (const e of r.eyes) {
      if (e.openAmt < 0.2) continue;
      punch(e.x, e.y, 44 + e.openAmt * 20);
      light.save(); light.translate(e.x, e.y); light.rotate(e.facingNow);
      light.beginPath(); light.moveTo(0, 0); light.arc(0, 0, e.range * 0.95, -e.cone / 2, e.cone / 2); light.closePath();
      light.fillStyle = `rgba(0,0,0,${0.3 + e.openAmt * 0.35})`; light.fill(); light.restore();
    }
    light.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(light.canvas, 0, 0);
  }

  cam(ctx, c, sx, sy, dpr);
  // Eye cones + relic glows (additive)
  ctx.globalCompositeOperation = 'lighter';
  if (!r.ended) for (const e of r.eyes) {
    if (e.openAmt < 0.12) continue;
    ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.facingNow);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, e.range * 0.92, -e.cone / 2, e.cone / 2); ctx.closePath();
    const a = e.canCatch ? 0.2 : e.seesYou ? 0.14 : 0.07;
    ctx.fillStyle = rgba(EYE_AMBER, a * e.openAmt); ctx.fill(); ctx.restore();
  }
  for (let i = 0; i < N * N; i++) {
    if (r.ended || !isRelic(r, i)) continue;
    const { x, y } = xyOf(i);
    const cx = (x + 0.5) * ZONE, cy = (y + 0.5) * ZONE;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 24);
    g.addColorStop(0, 'rgba(255,207,74,0.3)'); g.addColorStop(1, 'rgba(255,207,74,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  if (!r.ended) for (let i = 0; i < N * N; i++) {
    if (!isRelic(r, i)) continue;
    const { x, y } = xyOf(i);
    moths(ctx, (x + 0.5) * ZONE, (y + 0.5) * ZONE, t, i);
  }

  // Holographic floor marks (always readable): readings, claims, duds, hazards
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const owners = new Map([[r.you.id, r.you.color], ...r.rivals.map((k) => [k.id, k.color] as [string, string])]);
  for (let i = 0; i < N * N; i++) {
    const cell = r.cells[i];
    const { x, y } = xyOf(i);
    const x0 = x * ZONE, y0 = y * ZONE;
    if (cell.status === 'owned') {
      const col = owners.get(cell.owner ?? '') ?? '#fff';
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.95;
      ctx.strokeRect(x0 + 2.5, y0 + 2.5, ZONE - 5, ZONE - 5);
      if (cell.owner === r.you.id) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x0 + 5, y0 + ZONE - 8, ZONE - 10, 3);
        ctx.fillStyle = cell.integrity > 40 ? col : BAD; ctx.fillRect(x0 + 5, y0 + ZONE - 8, (ZONE - 10) * cell.integrity / 100, 3);
      }
      ctx.globalAlpha = 1;
    } else if (cell.status === 'dud' || cell.status === 'hazard') {
      ctx.strokeStyle = cell.status === 'hazard' ? BAD : 'rgba(134,179,166,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0 + 12, y0 + 12); ctx.lineTo(x0 + ZONE - 12, y0 + ZONE - 12); ctx.moveTo(x0 + ZONE - 12, y0 + 12); ctx.lineTo(x0 + 12, y0 + ZONE - 12); ctx.stroke();
    }
    if (r.ended) {
      const z = r.map[i];
      ctx.font = '600 11px ui-monospace, Menlo, monospace';
      ctx.fillStyle = z.hazard ? BAD : z.value >= CONFIG.claimThreshold ? '#eafff7' : 'rgba(134,179,166,0.55)';
      ctx.fillText(z.hazard ? '☢' : String(z.value), x0 + ZONE / 2, y0 + ZONE / 2);
    } else if (cell.scans > 0) {
      const [lo, hi] = cell.known;
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.fillStyle = lo >= 40 ? GOLD : lo >= CONFIG.claimThreshold ? '#bfffe9' : 'rgba(170,210,198,0.75)';
      ctx.fillText(lo === hi ? `${lo}` : `${lo}–${hi}`, x0 + ZONE / 2, y0 + ZONE / 2 + (cell.status === 'open' ? 0 : -6));
    }
  }

  // Current zone highlight + scan ring + claim ring
  if (!r.ended) {
    const here = zoneAt(r.you.x, r.you.y);
    const { x, y } = xyOf(here);
    ctx.strokeStyle = 'rgba(62,230,255,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(x * ZONE + 0.5, y * ZONE + 0.5, ZONE - 1, ZONE - 1);
    const p = r.you;
    const moving = Math.hypot(p.vx, p.vy) > ROOM.moveThreshold;
    if (!moving && r.cells[here].scans < ROOM.maxScans) {
      const ch = scanCharge(r);
      ctx.strokeStyle = 'rgba(62,230,255,0.25)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, 18, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#3ee6ff'; ctx.shadowColor = '#3ee6ff'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, 18, -Math.PI / 2, -Math.PI / 2 + ch * Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      // ripple right after a completed scan
      if (p.still > ROOM.scanStep && ch < 0.35) {
        ctx.strokeStyle = `rgba(62,230,255,${0.5 * (1 - ch / 0.35)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y - 4, 18 + ch * 90, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (r.claimProgress > 0) {
      ctx.strokeStyle = GOLD; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, 24, -Math.PI / 2, -Math.PI / 2 + r.claimProgress * Math.PI * 2); ctx.stroke();
    }
    for (const k of r.rivals) {
      if (k.still > 0.2 && k.target >= 0) {
        ctx.strokeStyle = k.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(k.x, k.y - 4, 12 + Math.sin(t * 6) * 1.5, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.font = '600 8px ui-monospace, Menlo, monospace'; ctx.fillStyle = k.color; ctx.globalAlpha = 0.85;
      ctx.fillText(k.name, k.x, k.y - 25); ctx.globalAlpha = 1;
    }
  }

  // Particles + floating text
  for (const q of r.particles) { ctx.globalAlpha = Math.max(0, q.life / q.max); ctx.fillStyle = q.color; ctx.fillRect(q.x, q.y, q.size, q.size); }
  ctx.globalAlpha = 1;
  ctx.font = '700 11px ui-monospace, Menlo, monospace';
  for (const f of r.floats) { ctx.globalAlpha = Math.min(1, f.life); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y); }
  ctx.globalAlpha = 1;

  // Screen-space flash + vignette
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (r.flash > 0) { ctx.fillStyle = `rgba(255,93,115,${r.flash * 0.25})`; ctx.fillRect(0, 0, w, h); }
  const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
}

export const zoneName = (i: number) => { const { x, y } = xyOf(i); return zoneLabel(x, y); };
