// Substrate Room test page: I Still-style real-time Substrate in one room.
import './room.css';
import { randomSeed } from '../rng';
import { CONFIG } from '../game';
import { makeRoom, stepRoom, standings, zoneAt, ROOM, type Room, type RoomEvents } from './sim';
import { renderRoom, fitCamera, zoneName } from './render';
import { createRoomAudio } from './audio';

const HELP_KEY = 'substrate.room.help.v1';
const app = document.getElementById('room-app')!;
app.innerHTML = `
<header class="hud">
  <div class="hud-row">
    <a class="back" href="/">← SUBSTRATE</a>
    <span class="title">ROOM TEST</span>
    <span><button id="r-mute" class="icon-btn" type="button" aria-label="Sound">♪</button>
    <button id="r-help" class="icon-btn" type="button" aria-label="How to play">?</button></span>
  </div>
  <div class="stats">
    <div class="stat"><small>CREDITS</small><b id="r-credits">0</b></div>
    <div class="stat"><small>SCORE</small><b id="r-score">0</b></div>
    <div class="stat time"><small>TIME</small><b id="r-time">0</b></div>
  </div>
  <div class="rivals" id="r-rivals"></div>
</header>
<div class="stage" id="r-stage">
  <canvas id="r-canvas"></canvas>
  <div class="watch-tag" id="r-watch">EYE OPEN · DON'T MOVE</div>
</div>
<div class="bottom">
  <div class="reading"><div class="z" id="r-zone">—</div><div class="v" id="r-read">Hold to move</div></div>
  <button class="claim" id="r-claim" type="button"><div class="fill" id="r-claim-fill"></div><span>HOLD<br>CLAIM</span></button>
</div>
<div class="commit" id="r-commit"></div>

<div class="overlay" id="r-howto" hidden>
  <div class="card">
    <h2>HOW TO PLAY</h2>
    <ol>
      <li><b>Hold</b> anywhere to move toward your finger.</li>
      <li><b>Let go to scan.</b> Standing still reads the zone under you. The longer you stay still, the sharper the number gets, and nearby zones get faint hints.</li>
      <li><b>Don't move when the eye is open.</b> Standing still in its light is safe. Moving in it costs ${ROOM.spotCost} credits and knocks you back.</li>
      <li><b>Stand still on a glowing zone and hold Claim.</b> Rich zones pay right away and every few seconds. Duds and hazards cost you.</li>
      <li>Your zones fade unless you go back and stand on them.</li>
    </ol>
    <p>Rivals Vex-7, Orin and Null.Kid are scanning the same room. ${ROOM.duration} seconds. Highest score wins. Keys: WASD/arrows to move, Space to claim.</p>
    <button class="primary" id="r-start" type="button">START</button>
  </div>
</div>

<div class="overlay end-overlay" id="r-end" hidden>
  <div class="card">
    <h2 id="r-end-title">RUN OVER</h2>
    <table class="table" id="r-end-table"></table>
    <p id="r-end-check"></p>
    <button class="primary" id="r-again" type="button">PLAY AGAIN</button>
    <a class="secondary" href="/">Back to Substrate</a>
  </div>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('r-canvas');
const stage = $('r-stage');
const ctx = canvas.getContext('2d')!;
const lightCanvas = document.createElement('canvas');
const light = lightCanvas.getContext('2d')!;
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const audio = createRoomAudio();

let room: Room = makeRoom(randomSeed());
let playing = false;
let cssW = 0, cssH = 0, dpr = 1;
let hold: { x: number; y: number } | null = null;
let holdId: number | null = null;
let claimHeld = false;
const keys = new Set<string>();

function resize() {
  const rect = stage.getBoundingClientRect();
  cssW = Math.max(1, rect.width); cssH = Math.max(1, rect.height);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [canvas, lightCanvas]) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
}
new ResizeObserver(resize).observe(stage);
resize();

function toWorld(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  const c = fitCamera(cssW, cssH);
  return { x: (e.clientX - rect.left - c.ox) / c.scale, y: (e.clientY - rect.top - c.oy) / c.scale };
}
canvas.addEventListener('pointerdown', (e) => {
  if (!playing) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault(); audio.unlock();
  canvas.setPointerCapture(e.pointerId); holdId = e.pointerId; hold = toWorld(e);
});
canvas.addEventListener('pointermove', (e) => { if (e.pointerId === holdId) hold = toWorld(e); });
const release = (e: PointerEvent) => { if (e.pointerId === holdId) { holdId = null; hold = null; } };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const claimBtn = $<HTMLButtonElement>('r-claim');
claimBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); audio.unlock(); claimHeld = true; claimBtn.setPointerCapture(e.pointerId); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) claimBtn.addEventListener(ev, () => { claimHeld = false; });
claimBtn.addEventListener('contextmenu', (e) => e.preventDefault());

const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyC']);
window.addEventListener('keydown', (e) => { if (GAME_KEYS.has(e.code)) { e.preventDefault(); audio.unlock(); } keys.add(e.code); });
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); claimHeld = false; hold = null; });

function readInput() {
  let mx = 0, my = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (hold) {
    const dx = hold.x - room.you.x, dy = hold.y - room.you.y, d = Math.hypot(dx, dy);
    if (d > 10) { mx = dx / d; my = dy / d; } else { mx = 0; my = 0; }
  }
  return { mx, my, claim: claimHeld || keys.has('Space') || keys.has('KeyC') };
}

const events: RoomEvents = {
  scan: (_z, n) => audio.scan(n),
  spotted: () => { audio.spotted(); navigator.vibrate?.(60); },
  claim: (_z, kind) => audio.claim(kind),
  eyeOpen: () => audio.eye(),
  end: () => showEnd(),
};

// HUD
const els = {
  credits: $('r-credits'), score: $('r-score'), time: $('r-time'), rivals: $('r-rivals'),
  zone: $('r-zone'), read: $('r-read'), watch: $('r-watch'), fill: $('r-claim-fill'), commit: $('r-commit'),
};
const last: Record<string, string> = {};
const set = (k: keyof typeof els, v: string, html = false) => {
  if (last[k] === v) return; last[k] = v;
  if (html) els[k].innerHTML = v; else els[k].textContent = v;
};

function hud() {
  set('credits', String(Math.floor(room.credits)));
  set('score', String(Math.floor(room.you.score)));
  const left = Math.max(0, Math.ceil(ROOM.duration - room.time));
  set('time', `${left}s`);
  els.time.classList.toggle('low', left <= 15);
  set('rivals', room.rivals.map((k) => `<span><i style="background:${k.color}"></i>${k.name} ${Math.floor(k.score)}</span>`).join(''), true);
  const here = zoneAt(room.you.x, room.you.y);
  const c = room.cells[here];
  set('zone', `Zone ${zoneName(here)}`);
  let read: string;
  const moving = Math.hypot(room.you.vx, room.you.vy) > ROOM.moveThreshold;
  const range = c.scans > 0 || c.known[1] - c.known[0] < 100 ? `${c.known[0]}–${c.known[1]}` : '?';
  if (c.status === 'owned') read = c.owner === room.you.id ? `Yours · ${Math.round(c.integrity)}% · recharging` : `Taken by ${room.rivals.find((k) => k.id === c.owner)?.name ?? 'rival'}`;
  else if (c.status === 'dud') read = 'Dud';
  else if (c.status === 'hazard') read = 'Hazard';
  else if (moving) read = `Reading ${range} · stop to scan`;
  else if (c.scans >= ROOM.maxScans) read = `Reading ${range} · fully scanned`;
  else read = `Reading ${range} · scanning ${'●'.repeat(c.scans)}${'○'.repeat(ROOM.maxScans - c.scans)}`;
  set('read', read);
  els.watch.classList.toggle('on', room.watched && !room.ended);
  els.watch.classList.toggle('warn', room.warning && !room.watched && !room.ended);
  els.fill.style.width = `${Math.round(room.claimProgress * 100)}%`;
  claimBtn.disabled = room.ended || c.status !== 'open';
  set('commit', `map commit ${room.commit.slice(0, 10)}…${room.commit.slice(-6)}`);
}

function showEnd() {
  playing = false; hold = null; claimHeld = false;
  const rows = standings(room);
  const youWin = rows[0].you;
  $('r-end-title').textContent = youWin ? 'YOU WIN THE ROOM' : `${rows[0].name.toUpperCase()} WINS`;
  $('r-end-table').innerHTML = rows.map((s, i) =>
    `<tr class="${s.you ? 'you' : ''}"><td>${i + 1}. <span style="color:${s.color}">●</span> ${s.name}</td><td>${s.zones} zones</td><td>${s.score}</td></tr>`).join('');
  $('r-end-check').innerHTML = `${room.endReason} Map revealed. Seed <code>${room.seed}</code> ` +
    (room.verified ? `<span class="ok">matches the commit ✓</span>` : `<span class="bad">does NOT match the commit ✗</span>`) +
    ` · spotted ${room.spotted}×`;
  $('r-end').hidden = false;
}

function start() {
  room = makeRoom(randomSeed());
  $('r-howto').hidden = true; $('r-end').hidden = true;
  playing = true; acc = 0; lastT = performance.now();
  audio.unlock();
  try { localStorage.setItem(HELP_KEY, '1'); } catch { /* private mode */ }
}
$('r-again').addEventListener('click', start);
$('r-help').addEventListener('click', () => { playing = false; $('r-start').textContent = room.time > 0 && !room.ended ? 'RESUME' : 'START'; $('r-howto').hidden = false; });
$('r-mute').addEventListener('click', () => { $('r-mute').style.opacity = audio.toggle() ? '0.4' : '1'; });

// Resume instead of restarting when the help card was opened mid-run.
$('r-start').addEventListener('click', () => {
  if (room.time > 0 && !room.ended) { $('r-howto').hidden = true; playing = true; lastT = performance.now(); return; }
  start();
});

const STEP = 1 / 60;
let acc = 0;
let lastT = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (playing) {
    acc += dt;
    const input = readInput();
    while (acc >= STEP) { stepRoom(room, input, STEP, events); acc -= STEP; if (!playing) break; }
  } else if (room.ended) stepRoom(room, { mx: 0, my: 0, claim: false }, dt);
  renderRoom(ctx, light, room, cssW, cssH, dpr, reduced);
  hud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let seenHelp = false;
try { seenHelp = localStorage.getItem(HELP_KEY) === '1'; } catch { /* ignore */ }
const params = new URLSearchParams(location.search);
if (seenHelp && !params.has('help')) start(); else $('r-howto').hidden = false;

// Small debug hook for headless playtests.
(window as unknown as { substrateRoom: unknown }).substrateRoom = {
  get room() { return room; },
  start,
  claimThreshold: CONFIG.claimThreshold,
};
