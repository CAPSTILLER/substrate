import './style.css';
import { CONFIG, YOU, idx, zoneLabel, signalWord, tickYield, type ActionKind, type Game, type Seat } from './game';
import { World, ARENA_COUNT, HOME_ARENA, arenaId, arenaIndex, type StepEvent } from './world';
import {
  computeLayout, drawOverview, hitArena, renderPng, heatHue, fitPx, sanitizePalette, seatColorIn, DEFAULT_PALETTE,
  type Layout, type Palette,
} from './overview';
import { randomSeed } from './rng';
import { loadScores, saveScore, qualifies, loadHandle, saveHandle } from './scores';

const BG_PRESETS = [
  { name: 'void', color: '#040908' },
  { name: 'black', color: '#000000' },
  { name: 'ink', color: '#0d1330' },
  { name: 'ember', color: '#1c0710' },
  { name: 'paper', color: '#f1ece2' },
];
const BASE_TICK_MS = 1000; // 1x = one tick per second
const REVEAL_HOLD_TICKS = 5; // the revealed map stays up this many ticks before the next round

const app = document.getElementById('app')!;
app.innerHTML = `
<header class="top">
  <div class="brand">
    <h1>SUBSTRATE</h1>
    <span class="by">by CAPSTILLER · <a class="room-link" href="/room.html">Room test</a></span>
  </div>
  <div class="top-actions">
    <button id="btn-help" class="ghost" type="button">How to play</button>
    <button id="btn-records" class="ghost" type="button">Records</button>
  </div>
</header>

<section id="v-arena">
  <p class="lore">The universe map is hidden in the substrate. Send scouts, read the signal, and harvest a zone before the rival agents figure it out.</p>
  <div class="demo-badge">DEMO · fake credits · no wallet</div>
  <div class="arena-bar">
    <div class="ab-text">
      <b id="arena-label">ARENA</b>
      <span id="arena-sub"></span>
    </div>
    <button id="btn-map" class="mapbtn" type="button" aria-label="Open the Substrate map"><i class="mini-grid"></i>Substrate map</button>
  </div>
  <main class="layout">
    <section class="left">
      <section class="stats">
        <div class="stat"><span class="k" id="k1">Demo credits</span><span class="v" id="s-credits"></span></div>
        <div class="stat"><span class="k" id="k2">Score</span><span class="v" id="s-score"></span></div>
        <div class="stat"><span class="k">Tick</span><span class="v" id="s-tick"></span></div>
      </section>
      <section class="rivals" id="rivals" aria-label="Seats at this arena"></section>
      <section id="endcard" class="endcard" hidden></section>
      <section class="board-wrap">
        <div class="axis-top" id="axis-top"></div>
        <div class="board-row">
          <div class="axis-left" id="axis-left"></div>
          <div class="grid" id="grid" role="grid" aria-label="Arena map"></div>
        </div>
      </section>
    </section>

    <section class="right">
      <section class="panel" id="panel">
        <div class="zone-info" id="zone-info"></div>
        <div class="actions" id="actions">
          <button id="a-probe" class="act probe" type="button">Probe<small id="c-probe"></small></button>
          <button id="a-claim" class="act claim" type="button">Claim<small id="c-claim"></small></button>
          <button id="a-maint" class="act maint" type="button">Maintain<small id="c-maint"></small></button>
          <button id="a-wait" class="act wait" type="button">Wait<small>+1 tick</small></button>
        </div>
        <div class="spectate" id="spectate" hidden>
          <div id="spec-text"></div>
          <div class="spec-btns">
            <button class="primary" id="spec-join" type="button">Join this arena</button>
            <button class="ghost" id="spec-back" type="button">Back to my arena</button>
          </div>
        </div>
        <div class="toast" id="toast" aria-live="polite">Pick a zone and Probe it to start scouting.</div>
      </section>
      <section class="legend" id="legend"></section>
      <section class="log" id="log" aria-label="Event log"></section>
      <section class="commit">
        <div><span class="k">Arena</span> <code id="c-arena"></code></div>
        <div><span class="k">Seed</span> <code id="seed">sealed until the round ends</code></div>
        <div><span class="k">Commit</span> <code id="commit"></code></div>
        <div class="hint">Each arena has its own seed and commit: sha256(seed + map), shown before the round. At the end every seed is revealed and checked, so you can see no map was changed. Later this moves onchain.</div>
      </section>
      <button id="btn-switch" class="ghost wide" type="button">Switch arena</button>
    </section>
  </main>
</section>

<section id="v-overview" class="overview" hidden>
  <div class="ov-head">
    <div class="ov-title"><b>SUBSTRATE MAP</b><span id="ov-sub"></span></div>
    <button id="ov-back" class="ghost" type="button">◀ My arena</button>
  </div>
  <div class="ov-controls">
    <div class="seg" id="ov-speed" role="group" aria-label="Simulation speed">
      <button type="button" data-speed="0" aria-label="Pause">❚❚</button>
      <button type="button" data-speed="1">1×</button>
      <button type="button" data-speed="2">2×</button>
      <button type="button" data-speed="4">4×</button>
    </div>
    <button id="ov-labels" class="chip" type="button" aria-pressed="true">Labels</button>
    <button id="ov-clean" class="chip" type="button">Text off</button>
    <button id="ov-save" class="chip strong" type="button" title="Save image / share as PNG">Save image</button>
  </div>
  <div class="ov-stage" id="ov-stage"><canvas id="ov-canvas" aria-label="Top-down map of all 25 arenas"></canvas></div>
  <aside class="ov-side">
    <div class="ov-bg" id="ov-bg" role="group" aria-label="Background colour">
      <span class="k">Background</span>
      ${BG_PRESETS.map((p) => `<button type="button" class="swatch" data-bg="${p.color}" style="--sw:${p.color}" aria-label="${p.name}" title="${p.name}"></button>`).join('')}
      <label class="swatch custom" title="custom colour" aria-label="custom colour"><input type="color" id="ov-bgc" value="#040908" /></label>
    </div>
    <details class="ov-colors" id="ov-colors">
      <summary><span>Colors</span><span class="cdots" id="ct-dots"></span></summary>
      <div class="ct" id="ct-targets" role="group" aria-label="What to recolour"></div>
      <div class="cp" id="ct-palette" role="group" aria-label="Colour"></div>
      <div class="cr">
        <span class="muted" id="ct-hint"></span>
        <button type="button" class="chip" id="ct-reset">Reset to default</button>
      </div>
    </details>
    <div class="ov-note" id="ov-note"></div>
    <div class="lb">
      <h3>Leaderboard <span>· all 100 seats</span></h3>
      <ol id="lb"></ol>
      <div id="lb-you" class="lb-you"></div>
    </div>
    <div class="ov-key">
      <span><i id="key-you"></i>your zones</span>
      <span><i class="k-heat"></i>probe heat</span>
      <span><i class="k-own"></i>claimed (brighter = richer, fuller integrity)</span>
      <span><i class="k-dud"></i>dud / collapsed</span>
      <span><i class="k-hz"></i>hazard</span>
    </div>
  </aside>
</section>

<footer class="foot" id="foot">Substrate demo · fake CAPH-demo credits, nothing onchain · records are stored on this device only and will go onchain later.</footer>

<div id="clean" class="clean" hidden>
  <canvas id="clean-canvas" aria-label="Substrate map, clean view"></canvas>
  <div class="clean-hint" id="clean-hint">Tap to exit</div>
</div>

<dialog id="dlg-help">
  <h2>How to play</h2>
  <ol>
    <li><b>Probe</b> (−${CONFIG.probeCost}): tap a zone, then Probe. You get a signal range for its hidden value (0–100). Probe again to narrow it. Nearby zones get fainter hints.</li>
    <li><b>Claim</b> (−${CONFIG.claimCost}): if the zone is worth ${CONFIG.claimThreshold}+ you harvest half its value right away and it keeps yielding every tick. Under ${CONFIG.claimThreshold} it's a dud and the stake is lost. Hazards (⚠) cost ${CONFIG.hazardPenalty} extra.</li>
    <li><b>Decay</b>: your zones lose ${CONFIG.decayPerTick}% integrity every tick, and yield less as they fade. <b>Maintain</b> (−${CONFIG.maintainCost}) puts one back to 100%. At 0% it collapses.</li>
    <li>Probe, Claim and Wait each take one tick. Maintain is instant. The three other seats at your arena move every tick and can snipe zones you haven't claimed yet.</li>
    <li>A round lasts ${CONFIG.maxTicks} ticks. If you run out of credits with no zones, you're out and the round finishes without you. <b>Score</b> = everything you harvested.</li>
    <li><b>25 arenas</b> run at once, 4 seats each (100 seats). They share one clock, so every move you make ticks all of them. Open the <b>Substrate map</b> to see all 25 from above as one 50×50 piece, watch any arena, switch seats, or save the map as an image.</li>
  </ol>
  <p class="muted">Tip: rich zones come in clusters. A strong hint next to a probe means a vein is close.</p>
  <form method="dialog"><button class="primary wide">Got it</button></form>
</dialog>

<dialog id="dlg-records">
  <h2>Records</h2>
  <p class="muted">Offline records on this device. They'll go onchain later.</p>
  <ol id="records-list" class="records"></ol>
  <form method="dialog"><button class="primary wide">Close</button></form>
</dialog>

<dialog id="dlg-arenas">
  <h2>Pick an arena</h2>
  <p class="muted">25 arenas, 4 seats each. Joining replaces a house bot. If you switch mid-round, your current run ends.</p>
  <div class="picker" id="picker"></div>
  <div class="picker-btns">
    <button class="ghost" id="pick-random" type="button">Random arena</button>
    <button class="ghost" id="pick-watch" type="button">Just watch</button>
  </div>
  <form method="dialog"><button class="primary wide">Close</button></form>
</dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const gridEl = $('grid');
const cellsEl: HTMLButtonElement[] = [];

// ---------- state ----------
interface Result {
  arena: string; round: number; seed: string; commit: string; verified: boolean;
  score: number; endReason: string; out: boolean; bestName: string; bestScore: number;
  probes: number; claims: number; zones: number;
}

let world: World;
let view: 'arena' | 'overview' = 'arena';
let viewArena = HOME_ARENA;
let selected: number | null = null;
let lastResult: Result | null = null;
let saved = false;
let clean = false;
let ovDirty = true;
let ovLayout: Layout = computeLayout(400);
let cleanLayout: Layout = computeLayout(400);

type Speed = 1 | 2 | 4;
const prefs = loadPrefs();
const clock = { running: true, speed: prefs.speed as Speed, acc: 0, last: 0 };
const art = { bg: prefs.bg, labels: prefs.labels };
let pal: Palette = loadPalette();

function loadPalette(): Palette {
  try { return sanitizePalette(JSON.parse(localStorage.getItem('substrate.colors') ?? '{}')); } catch { return sanitizePalette({}); }
}
function savePalette() {
  try { localStorage.setItem('substrate.colors', JSON.stringify(pal)); } catch { /* ignore */ }
}

function loadPrefs(): { bg: string; speed: number; labels: boolean } {
  const d = { bg: BG_PRESETS[0].color, speed: 1, labels: true };
  try {
    const p = JSON.parse(localStorage.getItem('substrate.art') ?? '{}');
    return {
      bg: typeof p.bg === 'string' && /^#[0-9a-f]{6}$/i.test(p.bg) ? p.bg : d.bg,
      speed: [1, 2, 4].includes(p.speed) ? p.speed : d.speed,
      labels: typeof p.labels === 'boolean' ? p.labels : d.labels,
    };
  } catch { return d; }
}
function savePrefs() {
  try { localStorage.setItem('substrate.art', JSON.stringify({ bg: art.bg, speed: clock.speed, labels: art.labels })); } catch { /* ignore */ }
}

const params = new URLSearchParams(location.search);
function seedFromUrl(): string | null {
  const s = params.get('seed');
  return s && /^[\w-]{1,40}$/.test(s) ? s : null;
}

// ---------- helpers ----------
const arenaOf = (i = viewArena) => world.arenas[i];
const gameOf = (i = viewArena): Game => world.arenas[i].game;
const isMine = () => world.humanArena !== null && viewArena === world.humanArena;
const youSeat = (): Seat | undefined => world.human?.seat;
const seatActive = () => !!youSeat() && world.phase === 'play' && !youSeat()!.out;
const hasProgress = () => {
  const s = youSeat();
  return !!s && world.phase === 'play' && (s.probesUsed > 0 || s.claimsMade > 0);
};
function seatColor(g: Game, id: string | null) { return seatColorIn(g, id, pal); }
function seatName(g: Game, id: string | null) { return g.seat(id)?.name ?? 'someone'; }
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function toast(msg: string, kind: 'good' | 'bad' | 'info' = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
}

// ---------- world lifecycle ----------
function newWorld(seed: string, arena: number | null = HOME_ARENA) {
  world = new World(seed);
  if (arena !== null) world.join(arena);
  viewArena = world.humanArena ?? HOME_ARENA;
  selected = null;
  lastResult = null;
  saved = false;
  clock.acc = 0;
  const t = $('toast');
  t.className = 'toast';
  t.textContent = world.humanArena !== null
    ? `You're seated in Arena ${arenaId(world.humanArena)}. Pick a zone and Probe it to start scouting.`
    : 'Spectating. Join an arena to play.';
  renderAll();
}

function captureResult() {
  const h = world.human;
  if (!h) return;
  const g = h.arena.game;
  const best = [...g.rivals].sort((a, b) => b.score - a.score)[0];
  lastResult = {
    arena: h.arena.id, round: world.round, seed: h.arena.seed, commit: g.commit, verified: !!h.arena.verified,
    score: Math.floor(h.seat.score), endReason: h.seat.out ? h.seat.outReason : g.endReason, out: h.seat.out,
    bestName: best?.name ?? '-', bestScore: Math.floor(best?.score ?? 0),
    probes: h.seat.probesUsed, claims: h.seat.claimsMade, zones: g.ownedBy(YOU).length,
  };
  saved = false;
}

function handleEvent(ev: StepEvent | undefined) {
  if (ev === 'reveal') {
    captureResult();
    if (world.human) toast(`Round over: ${world.human.arena.game.endReason} Map revealed.`, 'info');
  } else if (ev === 'round') {
    selected = null;
    if (world.human) toast(`Round ${world.round} started. New maps in all 25 arenas.`, 'info');
  }
}

function stepWorld(): StepEvent {
  const ev = world.step();
  handleEvent(ev);
  ovDirty = true;
  if (view === 'arena') renderArena();
  else if (ev !== 'tick' || performance.now() - lastSideRender > 450) renderOverviewDom();
  else { renderOverviewSub(); sidePending = true; } // leaderboard refreshes ~2x a second at most; the canvas every tick
  return ev;
}
let lastSideRender = 0;
let sidePending = false;

function doAct(kind: ActionKind, x?: number, y?: number) {
  if (lastResult && lastResult.round < world.round) lastResult = null; // first move of a new round dismisses the old result
  const wasOut = youSeat()?.out;
  const r = world.act(kind, x, y);
  handleEvent(r.event);
  if (!wasOut && youSeat()?.out && world.phase === 'play') toast('Out of credits. The round keeps going without you.', 'bad');
  ovDirty = true;
  renderAll();
  return r;
}

function joinArena(i: number, ask = true): boolean {
  if (i === world.humanArena) { showArena(i); return true; }
  if (world.openSeats(i) === 0) { toast(`Arena ${arenaId(i)} is full.`, 'bad'); return false; }
  if (ask && hasProgress() && !confirm(`Leave Arena ${arenaId(world.humanArena!)}? Your run there ends.`)) return false;
  if (lastResult && lastResult.round === world.round && world.phase === 'reveal') lastResult = null;
  world.join(i);
  selected = null;
  showArena(i);
  toast(`You took a seat in Arena ${arenaId(i)}${world.tick > 0 ? ` at tick ${world.tick}` : ''}. Fresh ${CONFIG.startCredits} credits.`, 'good');
  return true;
}

function nextRound() {
  if (world.phase === 'reveal') stepWorld();
  lastResult = null;
  saved = false;
  renderAll();
}

// ---------- views ----------
function showArena(i = world.humanArena ?? viewArena) {
  if (i !== viewArena) selected = null;
  viewArena = i;
  view = 'arena';
  $('v-arena').hidden = false;
  $('v-overview').hidden = true;
  document.body.classList.remove('mode-overview');
  renderArena();
  window.scrollTo(0, 0);
}

function showOverview() {
  view = 'overview';
  $('v-arena').hidden = true;
  $('v-overview').hidden = false;
  document.body.classList.add('mode-overview');
  window.scrollTo(0, 0);
  fitOverview();
  renderOverviewDom();
  ovDirty = true;
}

function renderAll() {
  if (view === 'arena') renderArena();
  else renderOverviewDom();
  ovDirty = true;
}

// ---------- arena view ----------
function buildGrid() {
  const size = CONFIG.size;
  $('axis-top').innerHTML = Array.from({ length: size }, (_, x) => `<span>${zoneLabel(x, 0)[0]}</span>`).join('');
  $('axis-left').innerHTML = Array.from({ length: size }, (_, y) => `<span>${y + 1}</span>`).join('');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.dataset.i = String(idx(x, y));
      b.setAttribute('aria-label', zoneLabel(x, y));
      b.innerHTML = '<span class="num"></span><span class="bar"><i></i></span><span class="ping"></span>';
      b.addEventListener('click', () => { selected = idx(x, y); renderArena(); });
      gridEl.appendChild(b);
      cellsEl.push(b);
    }
  }
}

function zoneInfo(g: Game, i: number, mine: boolean): string {
  const c = g.cells[i];
  const x = i % CONFIG.size;
  const y = Math.floor(i / CONFIG.size);
  const label = `<b class="zl">${zoneLabel(x, y)}</b>`;
  if (g.over) {
    const z = g.map[i];
    const who = c.owner ? ` · held by <b style="color:${seatColor(g, c.owner)}">${escapeHtml(seatName(g, c.owner))}</b>` : '';
    return `${label} True value <b>${z.value}</b>${z.hazard ? ' · ⚠ hazard' : ''}${who}`;
  }
  switch (c.status) {
    case 'owned':
      if (c.owner === YOU && mine) {
        const v = g.map[i].value;
        return `${label} Yours · value ${v} · integrity <b>${c.integrity}%</b> · next yield ≈ ${tickYield(v, c.integrity).toFixed(1)}`;
      }
      return `${label} Held by <b style="color:${seatColor(g, c.owner)}">${escapeHtml(seatName(g, c.owner))}</b> · value ${g.map[i].value}${mine ? '. Gone.' : ''}`;
    case 'dud': return `${label} Dud. Nothing worth harvesting.`;
    case 'hazard': return `${label} ⚠ Hazard zone. Avoid.`;
    case 'depleted': return `${label} Collapsed. Depleted.`;
  }
  const k = mine ? g.knowledge(YOU) : g.knowledge();
  const [lo, hi] = k.known[i];
  if (hi - lo >= 100) return mine ? `${label} No reading yet. Probe to scan it (also hints its neighbours).` : `${label} No scout has read this zone yet.`;
  const src = mine
    ? (k.probes[i] > 0 ? `probed ${k.probes[i]}×` : 'hint from nearby probes')
    : `all scouts' readings combined${k.probes[i] ? ` · ${k.probes[i]} probes` : ''}`;
  return `${label} Signal <b>${lo}–${hi}</b> (${signalWord(k.known[i])}) · ${src}${k.hazard[i] ? ' · <span class="warn">⚠ unstable, likely hazard</span>' : ''}`;
}

function renderArena() {
  const a = arenaOf();
  const g = a.game;
  const mine = isMine();
  const you = mine ? g.you : undefined;
  const know = mine ? g.knowledge(YOU) : g.knowledge();

  $('arena-label').textContent = `ARENA ${a.id}`;
  const phase = world.phase === 'reveal' ? 'revealed' : `tick ${g.tick}/${CONFIG.maxTicks}`;
  $('arena-sub').textContent = `Round ${world.round} · ${mine ? 'your seat' : 'spectating'} · ${phase}`;

  if (mine && you) {
    $('k1').textContent = 'Demo credits';
    $('k2').textContent = 'Score';
    $('s-credits').textContent = String(Math.floor(you.credits));
    $('s-score').textContent = String(Math.floor(you.score));
  } else {
    $('k1').textContent = 'Leader';
    $('k2').textContent = 'Claimed';
    $('s-credits').textContent = String(Math.floor(Math.max(...g.seats.map((s) => s.score))));
    $('s-score').textContent = String(g.cells.filter((c) => c.status === 'owned').length);
  }
  $('s-tick').textContent = `${g.tick}/${CONFIG.maxTicks}`;
  $('c-probe').textContent = `−${CONFIG.probeCost}`;
  $('c-claim').textContent = `−${CONFIG.claimCost}`;
  $('c-maint').textContent = `−${CONFIG.maintainCost}`;

  const shown = mine ? g.rivals : g.seats;
  const rv = $('rivals');
  rv.style.setProperty('--n', String(shown.length));
  rv.classList.toggle('four', shown.length >= 4);
  rv.innerHTML = shown
    .map((r) => `<div class="rival" style="--c:${seatColor(g, r.id)}" title="${escapeHtml(r.name)} (${r.kind}${r.kind === 'house' ? `, ${r.family}` : ''})"><i></i><span class="rn">${escapeHtml(r.name)}${r.kind !== 'house' ? `<em>${r.id === YOU ? 'you' : r.kind}</em>` : ''}</span><span class="rs">${Math.floor(r.score)}</span></div>`)
    .join('');

  g.cells.forEach((c, i) => {
    const el = cellsEl[i];
    const num = el.firstElementChild as HTMLElement;
    const bar = el.querySelector('.bar i') as HTMLElement;
    const cls = ['cell', `st-${c.status}`];
    let text = '';
    el.style.removeProperty('--c');
    el.style.removeProperty('--h');
    el.style.removeProperty('--a');
    const ownYou = c.owner === YOU && mine;
    if (g.over) {
      const z = g.map[i];
      cls.push('revealed');
      el.style.setProperty('--h', String(heatHue(z.value)));
      el.style.setProperty('--a', String(0.12 + (z.value / 100) * 0.85));
      text = z.hazard ? '⚠' : String(z.value);
      if (c.owner) cls.push(ownYou ? 'own-you' : 'own-rival');
      if (c.owner && !ownYou) el.style.setProperty('--c', seatColor(g, c.owner));
    } else if (c.status === 'owned') {
      if (ownYou) {
        cls.push('own-you');
        text = String(g.map[i].value);
        if (c.integrity <= 30) cls.push('low');
      } else {
        cls.push('own-rival');
        el.style.setProperty('--c', seatColor(g, c.owner));
        text = mine ? seatName(g, c.owner)[0] : String(g.map[i].value);
      }
    } else if (c.status === 'dud') {
      text = '✕';
    } else if (c.status === 'hazard') {
      text = '⚠';
    } else if (c.status === 'depleted') {
      text = '·';
    } else {
      const [lo, hi] = know.known[i];
      const w = hi - lo;
      if (w < 100) {
        const mid = (lo + hi) / 2;
        cls.push('known');
        el.style.setProperty('--h', String(heatHue(mid)));
        el.style.setProperty('--a', String(Math.min(0.9, 0.05 + Math.pow(1 - w / 100, 1.4) * 0.85 * (0.3 + mid / 110))));
        if (know.probes[i] > 0) { text = String(Math.round(mid)); cls.push('probed'); }
      }
      if (know.hazard[i]) { text = '⚠'; cls.push('flag'); }
    }
    if (c.ping && !g.over) { cls.push('pinged'); (el.lastElementChild as HTMLElement).style.background = seatColor(g, c.ping); }
    if (selected === i) cls.push('sel');
    el.className = cls.join(' ');
    num.textContent = text;
    bar.style.width = ownYou && !g.over ? `${c.integrity}%` : '0';
  });

  $('zone-info').innerHTML = selected === null
    ? (g.over ? 'Map revealed. Tap any zone to see its true value.' : mine ? 'Tap a zone on the map to select it.' : 'Tap a zone to see what the scouts have read.')
    : zoneInfo(g, selected, mine);

  $('actions').hidden = !mine;
  $('spectate').hidden = mine;
  $('toast').hidden = !mine;
  if (mine && you) {
    const sc = selected === null ? null : g.cells[selected];
    const live = !g.over && !you.out;
    $<HTMLButtonElement>('a-probe').disabled = !(live && !!sc && sc.status === 'open' && you.credits >= CONFIG.probeCost);
    $<HTMLButtonElement>('a-claim').disabled = !(live && !!sc && sc.status === 'open' && you.credits >= CONFIG.claimCost);
    $<HTMLButtonElement>('a-maint').disabled = !(live && !!sc && sc.owner === YOU && sc.integrity < 100 && you.credits >= CONFIG.maintainCost);
    $<HTMLButtonElement>('a-wait').disabled = !live;
  } else {
    const open = world.openSeats(viewArena);
    $('spec-text').innerHTML = `Spectating <b>Arena ${a.id}</b>. Read-only: the map shows every scout's readings combined. ${world.phase === 'play' ? 'The clock runs on its own while you watch.' : ''}`;
    const join = $<HTMLButtonElement>('spec-join');
    join.disabled = open === 0;
    join.textContent = open === 0 ? 'Arena full' : `Join Arena ${a.id}`;
    const back = $<HTMLButtonElement>('spec-back');
    back.hidden = world.humanArena === null;
    back.textContent = world.humanArena === null ? '' : `Back to ${arenaId(world.humanArena)}`;
  }

  $('legend').innerHTML = [
    ...(mine ? [`<span><i class="sw sw-you"></i>You</span>`] : []),
    ...shown.map((r) => `<span><i class="sw" style="--c:${seatColor(g, r.id)}"></i>${escapeHtml(r.name)}</span>`),
    `<span><i class="sw sw-dud">✕</i>Dud</span>`,
    `<span><i class="sw sw-hz">⚠</i>Hazard</span>`,
  ].join('');

  $('log').innerHTML = g.log
    .slice(-6)
    .reverse()
    .map((e) => `<div class="le ${mine ? e.kind : e.kind === 'you' ? 'rival' : e.kind}"><span class="lt">t${e.tick}</span>${escapeHtml(e.text)}</div>`)
    .join('');

  $('c-arena').textContent = `${a.id} · round ${world.round}`;
  $('commit').textContent = g.commit;
  $('seed').textContent = g.over ? `${a.seed} ${a.verified ? '✓ verified' : '✕ mismatch'}` : 'sealed until the round ends';
  $('btn-switch').textContent = world.humanArena === null ? 'Pick an arena to play' : 'Switch arena';
  renderEnd();
}

function renderEnd() {
  const card = $('endcard');
  const mine = isMine();
  const you = youSeat();
  let key = '';
  if (mine && lastResult) key = `res-${lastResult.round}-${saved}-${world.phase}-${world.round}`;
  else if (mine && you?.out && world.phase === 'play') key = `out-${world.round}`;
  if (!key) { card.hidden = true; card.innerHTML = ''; card.dataset.key = ''; return; }
  if (!card.hidden && card.dataset.key === key) return;
  const fresh = card.dataset.key !== key && key.startsWith('res-') && !saved;
  card.hidden = false;
  card.dataset.key = key;

  if (key.startsWith('out-')) {
    card.innerHTML = `
      <div class="end-reason">${escapeHtml(you!.outReason)}</div>
      <div class="end-score">${Math.floor(you!.score)}<span>score so far</span></div>
      <div class="end-sub">The round keeps going without you. The other seats finish it out, then all 25 maps reveal at tick ${CONFIG.maxTicks}.</div>
      <div class="end-btns">
        <button class="primary" id="end-ff" type="button">▶▶ Fast-forward</button>
        <button class="ghost" id="end-map" type="button">Substrate map</button>
      </div>`;
    $('end-ff').addEventListener('click', () => { clock.running = true; clock.speed = 4; savePrefs(); toast('Fast-forwarding to the reveal…'); });
    $('end-map').addEventListener('click', showOverview);
    return;
  }

  const r = lastResult!;
  const beat = r.score > r.bestScore;
  const sameRound = world.phase === 'reveal' && r.round === world.round;
  card.innerHTML = `
    <div class="end-reason">Arena ${r.arena} · round ${r.round} · ${escapeHtml(r.endReason)}</div>
    <div class="end-score">${r.score}<span>score</span></div>
    <div class="end-sub">${beat ? `You out-harvested your table (best rival: ${escapeHtml(r.bestName)} ${r.bestScore}).` : `${escapeHtml(r.bestName)} led your table with ${r.bestScore}.`}
      ${r.probes} probes · ${r.claims} claims · ${r.zones} zones held at the end.</div>
    <div class="end-verify ${r.verified ? 'ok' : 'bad'}">${r.verified ? '✓' : '✕'} Seed <code>${escapeHtml(r.seed)}</code> ${r.verified ? 'matches the commit. Map was fixed from the start.' : 'does NOT match the commit.'}</div>
    ${saved ? `<div class="end-saved">Saved to records.</div>` : qualifies(r.score) ? `
      <form class="save" id="save-form">
        <input id="handle" maxlength="16" placeholder="Your name or handle" autocomplete="nickname" value="${escapeHtml(loadHandle())}" />
        <button class="primary" type="submit">Save record</button>
      </form>` : `<div class="end-saved">Not in the top 10 this time.</div>`}
    <div class="end-btns">
      <button class="primary" id="end-next" type="button">${sameRound ? 'Next round' : `Play round ${world.round}`}</button>
      <button class="ghost" id="end-records" type="button">Records</button>
    </div>`;
  $('end-next').addEventListener('click', () => { if (sameRound) nextRound(); else { lastResult = null; renderAll(); } });
  $('end-records').addEventListener('click', openRecords);
  const form = document.getElementById('save-form') as HTMLFormElement | null;
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ($('handle') as HTMLInputElement).value.trim().slice(0, 16) || 'anon';
    saveHandle(name);
    const rank = saveScore({ name, score: r.score, seed: r.seed, commit: r.commit, date: new Date().toISOString(), arena: r.arena, round: r.round });
    saved = true;
    renderEnd();
    toast(rank ? `Saved: #${rank} on this device.` : 'Saved.', 'good');
  });
  if (fresh) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function act(kind: ActionKind) {
  if (!isMine()) return;
  const g = gameOf();
  if (kind === 'wait') {
    const r = doAct('wait');
    if (!r.ok) toast(r.message, 'bad');
    else if (!g.over && world.phase === 'play' && !youSeat()?.out) toast(`Tick passed. ${world.tick}/${CONFIG.maxTicks}`);
    return;
  }
  if (selected === null) { toast('Tap a zone first.'); return; }
  const x = selected % CONFIG.size;
  const y = Math.floor(selected / CONFIG.size);
  const r = doAct(kind, x, y);
  const bad = !r.ok || (kind === 'claim' && r.harvested === 0);
  if (world.phase === 'reveal' && r.ok) return; // the round-over toast already shows
  if (youSeat()?.out && r.ok) return;
  toast(r.message, bad ? 'bad' : kind === 'claim' ? 'good' : 'info');
}

function openRecords() {
  const list = loadScores();
  $('records-list').innerHTML = list.length
    ? list.map((e) => `<li><span class="rn">${escapeHtml(e.name)}</span>${e.arena ? `<span class="rt">${escapeHtml(e.arena)} · R${e.round ?? '?'}</span>` : ''}<span class="rs">${e.score}</span><span class="rd">${new Date(e.date).toLocaleDateString()}</span></li>`).join('')
    : '<li class="muted">No records yet. Finish a round to set one.</li>';
  $<HTMLDialogElement>('dlg-records').showModal();
}

function openPicker() {
  const lb = world.leaderboard();
  $('picker').innerHTML = world.arenas.map((a) => {
    const top = lb.find((r) => r.arenaIndex === a.index);
    const you = a.index === world.humanArena;
    const open = world.openSeats(a.index);
    return `<button type="button" class="pk${you ? ' you' : ''}" data-i="${a.index}" ${!you && open === 0 ? 'disabled' : ''}>
      <b>${a.id}</b><small>${you ? 'your seat' : open === 0 ? 'full' : open === 4 ? '4 bots' : `${4 - open} live · ${open} bots`}</small><small>top ${top?.score ?? 0}</small></button>`;
  }).join('');
  $('pick-watch').hidden = world.humanArena === null;
  $<HTMLDialogElement>('dlg-arenas').showModal();
}

// ---------- overview ----------
/**
 * Size a canvas so its backing store maps 1:1 to device pixels (no resampling) and the
 * 50x50 block uses whole-pixel cells with no leftover slack.
 */
function sizeCanvas(c: HTMLCanvasElement, css: number): Layout {
  const dpr = window.devicePixelRatio || 1;
  const px = fitPx(Math.floor(css * dpr));
  c.style.width = `${px / dpr}px`;
  c.style.height = `${px / dpr}px`;
  if (c.width !== px) { c.width = px; c.height = px; }
  return computeLayout(px);
}

function fitOverview() {
  if (view !== 'overview') return;
  const stage = $('ov-stage');
  const w = stage.clientWidth;
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const availH = wide ? window.innerHeight - top - 14 : window.innerHeight - 24;
  const css = Math.max(240, Math.floor(Math.min(w, availH)));
  ovLayout = sizeCanvas($<HTMLCanvasElement>('ov-canvas'), css);
  ovDirty = true;
}

function fitClean() {
  const css = Math.floor(Math.min(window.innerWidth, window.innerHeight) - 16);
  cleanLayout = sizeCanvas($<HTMLCanvasElement>('clean-canvas'), Math.max(200, css));
  ovDirty = true;
}

function drawCanvases() {
  if (clean) {
    drawOverview($<HTMLCanvasElement>('clean-canvas').getContext('2d')!, world, cleanLayout, { bg: art.bg, text: false, highlight: null, palette: pal });
  } else if (view === 'overview') {
    drawOverview($<HTMLCanvasElement>('ov-canvas').getContext('2d')!, world, ovLayout, { bg: art.bg, text: art.labels, highlight: world.humanArena, palette: pal });
  }
  ovDirty = false;
}

function renderOverviewSub() {
  $('ov-sub').textContent = `Round ${world.round} · ${world.phase === 'reveal' ? 'revealed' : `tick ${world.tick}/${world.maxTicks}`} · 100 seats`;
}

function renderOverviewDom() {
  if (view !== 'overview') return;
  lastSideRender = performance.now();
  sidePending = false;
  const s = world.summary();
  renderOverviewSub();
  $('ov-back').textContent = s.yourArena ? `◀ My arena ${s.yourArena}` : 'Pick an arena';
  for (const b of $('ov-speed').querySelectorAll<HTMLButtonElement>('button')) {
    const sp = Number(b.dataset.speed);
    const on = sp === 0 ? !clock.running : clock.running && clock.speed === sp;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const lab = $('ov-labels');
  lab.classList.toggle('on', art.labels);
  lab.setAttribute('aria-pressed', String(art.labels));
  for (const b of $('ov-bg').querySelectorAll<HTMLButtonElement>('.swatch[data-bg]')) b.classList.toggle('on', b.dataset.bg === art.bg);
  $('ov-bg').querySelector('.custom')!.classList.toggle('on', !BG_PRESETS.some((p) => p.color === art.bg));

  let note: string;
  if (s.phase === 'reveal') note = `Round ${s.round} revealed · <b class="ok">${s.verified}/25 commits verified ✓</b>${clock.running ? ' · next round in a moment' : ' · paused'}`;
  else if (!clock.running) note = 'Paused. Pick a speed to run the map.';
  else if (seatActive()) note = `Your seat in <b>${s.yourArena}</b> holds position while the map runs, and your zones still decay. Pause, or go back to ${s.yourArena} to make moves.`;
  else note = `${s.humans} human · ${s.house} house bots${s.agents ? ` · ${s.agents} agents` : ''}. Tap any arena to watch it.`;
  $('ov-note').innerHTML = note;

  const lb = world.leaderboard();
  const row = (r: (typeof lb)[number]) =>
    `<li class="${r.you ? 'me' : ''}"><span class="lr">${r.rank}</span><i style="background:${seatColor(world.arenas[r.arenaIndex].game, r.seatId)}"></i><span class="ln">${escapeHtml(r.name)}</span><span class="la">${r.arena}</span><span class="ls">${r.score}</span></li>`;
  $('lb').innerHTML = lb.slice(0, 10).map(row).join('');
  const me = lb.find((r) => r.you);
  $('lb-you').innerHTML = me && me.rank > 10 ? `<ol class="lb-me">${row(me)}</ol>` : '';
}

// ---------- colours ----------
type ColorTarget = 'heat' | 'you' | 's0' | 's1' | 's2' | 's3' | 'base' | 'dud' | 'hazard' | 'divider';
const COLOR_TARGETS: { key: ColorTarget; label: string; def: string }[] = [
  { key: 'heat', label: 'Probe heat', def: 'Spectrum' },
  { key: 'you', label: 'Your squares', def: 'Default' },
  { key: 's0', label: 'Seat 1', def: 'Bot colors' },
  { key: 's1', label: 'Seat 2', def: 'Bot colors' },
  { key: 's2', label: 'Seat 3', def: 'Bot colors' },
  { key: 's3', label: 'Seat 4', def: 'Bot colors' },
  { key: 'base', label: 'Unexplored', def: 'Default' },
  { key: 'dud', label: 'Dud', def: 'Default' },
  { key: 'hazard', label: 'Hazard', def: 'Default' },
  { key: 'divider', label: 'Dividers', def: 'Background' },
];
const COLOR_PRESETS = [
  '#3ee6ff', '#19f5b0', '#a6ff4d', '#ffe14d', '#ffb23f', '#ff6b4a', '#ff4fd8',
  '#b18cff', '#5b7cff', '#ffffff', '#8a9a96', '#0b1b17', '#1a1033', '#000000',
];
let colorTarget: ColorTarget = 'heat';

function getColor(t: ColorTarget): string | null {
  if (t[0] === 's' && t.length === 2) return pal.seats[Number(t[1])];
  return pal[t as 'heat' | 'you' | 'base' | 'dud' | 'hazard' | 'divider'];
}
function setColor(t: ColorTarget, v: string | null) {
  if (t[0] === 's' && t.length === 2) pal.seats[Number(t[1])] = v;
  else if (t === 'heat' || t === 'divider') pal[t] = v;
  else (pal as unknown as Record<string, string>)[t] = v ?? (DEFAULT_PALETTE as unknown as Record<string, string>)[t];
  pal = sanitizePalette(pal);
  applyPalette();
}
/** Swatch preview for a target's current value (defaults get a pattern). */
function preview(t: ColorTarget): string {
  const v = getColor(t);
  if (v) return v;
  if (t === 'heat') return 'linear-gradient(90deg, hsl(180 95% 50%), hsl(100 95% 50%), hsl(45 95% 55%))';
  if (t === 'divider') return art.bg;
  return 'conic-gradient(#ff4fd8 0 25%, #ffb23f 0 50%, #a6ff4d 0 75%, #b18cff 0)';
}
function renderColors() {
  $('ct-targets').innerHTML = COLOR_TARGETS.map((t) =>
    `<button type="button" class="ctb${t.key === colorTarget ? ' on' : ''}" data-t="${t.key}"><i style="background:${preview(t.key)}"></i>${t.label}</button>`).join('');
  const cur = getColor(colorTarget);
  const def = COLOR_TARGETS.find((t) => t.key === colorTarget)!;
  $('ct-palette').innerHTML =
    `<button type="button" class="chip cdef${cur === null || cur === (DEFAULT_PALETTE as unknown as Record<string, unknown>)[colorTarget] ? ' on' : ''}" data-c="">${def.def}</button>` +
    COLOR_PRESETS.map((c) => `<button type="button" class="swatch${cur === c ? ' on' : ''}" data-c="${c}" style="--sw:${c}" aria-label="${c}" title="${c}"></button>`).join('') +
    `<label class="swatch custom${cur && !COLOR_PRESETS.includes(cur) ? ' on' : ''}" title="custom colour" aria-label="custom colour"><input type="color" id="ct-input" value="${cur ?? '#3ee6ff'}" /></label>`;
  $('ct-hint').textContent = colorTarget[0] === 's' && colorTarget.length === 2
    ? `Seat ${Number(colorTarget[1]) + 1} in every arena (your own seat keeps Your squares).`
    : '';
  $('ct-dots').innerHTML = ['heat', 'you', 's0', 's1', 's2', 's3'].map((k) => `<i style="background:${preview(k as ColorTarget)}"></i>`).join('');
}
function applyPalette() {
  savePalette();
  document.documentElement.style.setProperty('--youc', pal.you);
  $('key-you').style.background = pal.you;
  ovDirty = true;
  renderColors();
  if (view === 'arena') renderArena();
  else renderOverviewDom();
}

function setSpeed(sp: number) {
  if (sp === 0) clock.running = !clock.running; // the pause button toggles
  else { clock.running = true; clock.speed = sp as Speed; }
  savePrefs();
  renderOverviewDom();
}

function setBg(c: string) {
  art.bg = c;
  ($('ov-bgc') as HTMLInputElement).value = c;
  savePrefs();
  ovDirty = true;
  renderOverviewDom();
  if (clean) $('clean').style.background = c;
  renderColors();
}

let hintTimer = 0;
function enterClean() {
  clean = true;
  const el = $('clean');
  el.style.background = art.bg;
  el.hidden = false;
  document.body.classList.add('mode-clean');
  fitClean();
  const hint = $('clean-hint');
  hint.classList.remove('gone');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.add('gone'), 1600);
}
function exitClean() {
  clean = false;
  $('clean').hidden = true;
  document.body.classList.remove('mode-clean');
  ovDirty = true;
  if (view === 'overview') fitOverview();
}

async function saveImage() {
  const btn = $<HTMLButtonElement>('ov-save');
  btn.disabled = true;
  try {
    const caption = art.labels ? `SUBSTRATE · round ${world.round} · ${world.phase === 'reveal' ? 'revealed' : `tick ${world.tick}/${world.maxTicks}`}` : undefined;
    const blob = await renderPng(world, { bg: art.bg, text: art.labels, highlight: world.humanArena, caption, palette: pal }, 2048);
    const name = `substrate-r${world.round}-t${world.tick}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Substrate', text: `Substrate map · round ${world.round}` });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  } catch (e) {
    alert(`Couldn't save the image: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- clock ----------
/** Should the shared clock tick on its own right now? */
function autoTicking(): boolean {
  if (!clock.running || document.hidden) return false;
  if (view === 'arena' && isMine() && !clean) {
    if (seatActive()) return false; // in your own arena, your moves drive the clock (v1 turn-based play)
    if (world.phase === 'reveal') return false; // hold the reveal so you can save your record
  }
  return true;
}

const perfLog: number[] = []; // JS ms spent in frames that ticked and/or redrew (last 60)
function frame(t: number) {
  const dt = clock.last ? Math.min(250, t - clock.last) : 0;
  clock.last = t;
  const t0 = performance.now();
  const busy = ovDirty;
  let ticked = false;
  if (autoTicking()) {
    clock.acc += dt;
    const tickMs = BASE_TICK_MS / clock.speed;
    const need = world.phase === 'reveal' ? tickMs * REVEAL_HOLD_TICKS : tickMs;
    if (clock.acc >= need) { clock.acc = 0; stepWorld(); ticked = true; }
  } else {
    clock.acc = 0;
  }
  if (ovDirty && (clean || view === 'overview')) drawCanvases();
  if (sidePending && view === 'overview' && performance.now() - lastSideRender > 450) renderOverviewDom();
  if (ticked || busy) {
    perfLog.push(performance.now() - t0);
    if (perfLog.length > 60) perfLog.shift();
  }
  requestAnimationFrame(frame);
}

// ---------- wiring ----------
buildGrid();
$('a-probe').addEventListener('click', () => act('probe'));
$('a-claim').addEventListener('click', () => act('claim'));
$('a-maint').addEventListener('click', () => act('maintain'));
$('a-wait').addEventListener('click', () => act('wait'));
$('btn-help').addEventListener('click', () => $<HTMLDialogElement>('dlg-help').showModal());
$('btn-records').addEventListener('click', openRecords);
$('btn-map').addEventListener('click', showOverview);
$('btn-switch').addEventListener('click', openPicker);
$('spec-join').addEventListener('click', () => joinArena(viewArena));
$('spec-back').addEventListener('click', () => showArena(world.humanArena ?? viewArena));
$('ov-back').addEventListener('click', () => (world.humanArena === null ? openPicker() : showArena(world.humanArena)));
$('ov-speed').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) setSpeed(Number(b.dataset.speed));
});
$('ov-labels').addEventListener('click', () => { art.labels = !art.labels; savePrefs(); ovDirty = true; renderOverviewDom(); });
$('ov-clean').addEventListener('click', enterClean);
$('ct-targets').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.ctb');
  if (b?.dataset.t) { colorTarget = b.dataset.t as ColorTarget; renderColors(); }
});
$('ct-palette').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-c]');
  if (b) setColor(colorTarget, b.dataset.c || null);
});
$('ct-palette').addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'ct-input') setColor(colorTarget, t.value);
});
$('ct-reset').addEventListener('click', () => {
  pal = sanitizePalette({});
  setBg(BG_PRESETS[0].color);
  applyPalette();
});
$('ov-save').addEventListener('click', saveImage);
$('ov-bg').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.swatch[data-bg]');
  if (b?.dataset.bg) setBg(b.dataset.bg);
});
$('ov-bgc').addEventListener('input', (e) => setBg((e.target as HTMLInputElement).value));
$('clean').addEventListener('click', exitClean);
$('ov-canvas').addEventListener('click', (e) => {
  const c = e.currentTarget as HTMLCanvasElement;
  const r = c.getBoundingClientRect();
  const k = c.width / r.width;
  const i = hitArena(ovLayout, (e.clientX - r.left) * k, (e.clientY - r.top) * k);
  if (i !== null) showArena(i);
});
$('picker').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pk');
  if (!b || b.disabled) return;
  if (joinArena(Number(b.dataset.i))) $<HTMLDialogElement>('dlg-arenas').close();
});
$('pick-random').addEventListener('click', () => {
  const open = world.arenas.filter((a) => a.index !== world.humanArena && world.openSeats(a.index) > 0);
  if (!open.length) return;
  if (joinArena(open[Math.floor(Math.random() * open.length)].index)) $<HTMLDialogElement>('dlg-arenas').close();
});
$('pick-watch').addEventListener('click', () => {
  if (hasProgress() && !confirm('Give up your seat and just watch? Your run ends.')) return;
  world.leave();
  $<HTMLDialogElement>('dlg-arenas').close();
  showOverview();
});
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap backdrop to close
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && clean) exitClean(); });
window.addEventListener('resize', () => { if (clean) fitClean(); if (view === 'overview') fitOverview(); });
document.addEventListener('visibilitychange', () => { clock.last = 0; });

const startArena = (() => {
  const a = params.get('arena');
  if (a === 'none' || a === 'watch') return null;
  const i = a ? arenaIndex(a) : -1;
  return i >= 0 ? i : HOME_ARENA;
})();
newWorld(seedFromUrl() ?? randomSeed(), startArena);
applyPalette();
if (params.get('view') === 'map' || params.get('art') === '1' || startArena === null) showOverview();
if (params.get('art') === '1') enterClean();
if (!localStorage.getItem('substrate.seenHelp') && params.get('view') !== 'map' && params.get('art') !== '1') {
  localStorage.setItem('substrate.seenHelp', '1');
  $<HTMLDialogElement>('dlg-help').showModal();
}
requestAnimationFrame(frame);

// ---- Machine-friendly hook for agents (future x402 / pay-per-play) ----
type Res = ReturnType<World['act']>;
const api = {
  version: 'substrate-demo-2',
  /** Your arena's state (no argument), or a public spectator snapshot of any arena. */
  state(arena?: string | number) {
    const i = arena === undefined ? world.humanArena : arenaIndex(arena);
    if (i === null) return { arena: null, seated: false, world: world.summary() };
    if (i < 0) throw new Error(`Unknown arena ${String(arena)}`);
    const a = world.arenas[i];
    const base = { arena: a.id, round: world.round, phase: world.phase, verified: a.verified };
    return i === world.humanArena
      ? { ...base, seated: true, ...a.game.state() }
      : { ...base, seated: false, ...a.game.publicState() };
  },
  probe: (x: number, y: number): Res => doAct('probe', x, y),
  claim: (x: number, y: number): Res => doAct('claim', x, y),
  maintain: (x: number, y: number): Res => doAct('maintain', x, y),
  endTurn: (): Res => doAct('wait'),
  /** Fresh world (new master seed); you keep your arena. */
  newRun(seed?: string) {
    newWorld(seed ?? randomSeed(), world.humanArena ?? HOME_ARENA);
    return api.state();
  },
  listArenas: () => world.listArenas(),
  joinArena(arena: string | number) {
    const i = arenaIndex(arena);
    if (i < 0) throw new Error(`Unknown arena ${String(arena)}`);
    joinArena(i, false);
    return api.state();
  },
  leaveArena() { world.leave(); renderAll(); return world.summary(); },
  world: () => ({ ...world.summary(), running: clock.running, speed: clock.speed }),
  leaderboard: (n = 100) => world.leaderboard().slice(0, n),
  /** Advance the shared clock one tick (your seat holds). */
  step() { stepWorld(); return world.summary(); },
  nextRound() { nextRound(); return world.summary(); },
  setClock(o: { running?: boolean; speed?: Speed }) {
    if (typeof o.running === 'boolean') clock.running = o.running;
    if (o.speed && [1, 2, 4].includes(o.speed)) clock.speed = o.speed;
    savePrefs();
    renderAll();
    return { running: clock.running, speed: clock.speed };
  },
  view(name: 'arena' | 'map' | 'clean', arena?: string | number) {
    if (clean && name !== 'clean') exitClean();
    if (name === 'map') showOverview();
    else if (name === 'clean') { showOverview(); enterClean(); }
    else showArena(arena === undefined ? (world.humanArena ?? viewArena) : arenaIndex(arena));
  },
  setBackground: (c: string) => setBg(c),
  /** Map colours: { heat, you, seats: [s1..s4], base, dud, hazard, divider } (null = default). Returns the palette. */
  setColors(p?: Partial<Palette>) {
    if (p) { pal = sanitizePalette({ ...pal, ...p }); applyPalette(); }
    return pal;
  },
  resetColors() { pal = sanitizePalette({}); setBg(BG_PRESETS[0].color); applyPalette(); return pal; },
  saveImage,
  arenas: ARENA_COUNT,
  /** JS time of recent frames that ticked the sim and/or redrew the map. */
  perf() {
    const a = [...perfLog].sort((x, y) => x - y);
    if (!a.length) return { frames: 0 };
    return { frames: a.length, avgMs: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95Ms: +a[Math.floor(a.length * 0.95)].toFixed(2), maxMs: +a[a.length - 1].toFixed(2) };
  },
  /** Timing probe: average ms per shared-clock tick (sim only) and per full overview redraw. */
  bench(n = 40, cssPx = 392) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) world.step();
    const t1 = performance.now();
    const c = document.createElement('canvas');
    const l = computeLayout(Math.round(cssPx * Math.min(3, window.devicePixelRatio || 1)));
    c.width = c.height = l.px;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < n; i++) drawOverview(ctx, world, l, { bg: art.bg, text: true, highlight: world.humanArena, palette: pal });
    const t2 = performance.now();
    renderAll();
    return { stepMs: +((t1 - t0) / n).toFixed(2), drawMs: +((t2 - t1) / n).toFixed(2), canvasPx: l.px };
  },
};
(window as unknown as { substrate: typeof api }).substrate = api;
