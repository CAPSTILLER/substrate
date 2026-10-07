import './style.css';
import { Game, CONFIG, RIVAL_DEFS, idx, zoneLabel, signalWord, verifyCommit, tickYield } from './game';
import { randomSeed } from './rng';
import { loadScores, saveScore, qualifies, loadHandle, saveHandle } from './scores';

const RIVAL_COLOR: Record<string, string> = Object.fromEntries(RIVAL_DEFS.map((r) => [r.id, r.color]));
const RIVAL_NAME: Record<string, string> = Object.fromEntries(RIVAL_DEFS.map((r) => [r.id, r.name]));

const app = document.getElementById('app')!;
app.innerHTML = `
<header class="top">
  <div class="brand">
    <h1>SUBSTRATE</h1>
    <span class="by">by CAPSTILLER</span>
  </div>
  <div class="top-actions">
    <button id="btn-help" class="ghost" type="button">How to play</button>
    <button id="btn-records" class="ghost" type="button">Records</button>
  </div>
</header>
<p class="lore">The universe map is hidden in the substrate. Send scouts, read the signal, and harvest a zone before the rival agents figure it out.</p>
<div class="demo-badge">DEMO · fake credits · no wallet</div>

<main class="layout">
  <section class="left">
    <section class="stats">
      <div class="stat"><span class="k">Demo credits</span><span class="v" id="s-credits"></span></div>
      <div class="stat"><span class="k">Score</span><span class="v" id="s-score"></span></div>
      <div class="stat"><span class="k">Tick</span><span class="v" id="s-tick"></span></div>
    </section>
    <section class="rivals" id="rivals" aria-label="Rival agents"></section>
    <section id="endcard" class="endcard" hidden></section>
    <section class="board-wrap">
      <div class="axis-top" id="axis-top"></div>
      <div class="board-row">
        <div class="axis-left" id="axis-left"></div>
        <div class="grid" id="grid" role="grid" aria-label="Substrate map"></div>
      </div>
    </section>
  </section>

  <section class="right">
    <section class="panel" id="panel">
      <div class="zone-info" id="zone-info"></div>
      <div class="actions">
        <button id="a-probe" class="act probe" type="button">Probe<small id="c-probe"></small></button>
        <button id="a-claim" class="act claim" type="button">Claim<small id="c-claim"></small></button>
        <button id="a-maint" class="act maint" type="button">Maintain<small id="c-maint"></small></button>
        <button id="a-wait" class="act wait" type="button">Wait<small>+1 tick</small></button>
      </div>
      <div class="toast" id="toast" aria-live="polite">Pick a zone and Probe it to start scouting.</div>
    </section>
    <section class="legend">
      <span><i class="sw sw-you"></i>You</span>
      ${RIVAL_DEFS.map((r) => `<span><i class="sw" style="--c:${r.color}"></i>${r.name}</span>`).join('')}
      <span><i class="sw sw-dud">✕</i>Dud</span>
      <span><i class="sw sw-hz">⚠</i>Hazard</span>
    </section>
    <section class="log" id="log" aria-label="Event log"></section>
    <section class="commit">
      <div><span class="k">Seed</span> <code id="seed">sealed until the run ends</code></div>
      <div><span class="k">Commit</span> <code id="commit"></code></div>
      <div class="hint">sha256(seed + map), shown before you play. At the end the seed is revealed so you can check the map wasn't changed. Later this moves onchain.</div>
    </section>
    <button id="btn-new" class="ghost wide" type="button">New run</button>
  </section>
</main>

<footer class="foot">Substrate demo · fake CAPH-demo credits, nothing onchain · records are stored on this device only and will go onchain later.</footer>

<dialog id="dlg-help">
  <h2>How to play</h2>
  <ol>
    <li><b>Probe</b> (−${CONFIG.probeCost}): tap a zone, then Probe. You get a signal range for its hidden value (0–100). Probe again to narrow it. Nearby zones get fainter hints.</li>
    <li><b>Claim</b> (−${CONFIG.claimCost}): if the zone is worth ${CONFIG.claimThreshold}+ you harvest half its value right away and it keeps yielding every tick. Under ${CONFIG.claimThreshold} it's a dud and the stake is lost. Hazards (⚠) cost ${CONFIG.hazardPenalty} extra.</li>
    <li><b>Decay</b>: your zones lose ${CONFIG.decayPerTick}% integrity every tick, and yield less as they fade. <b>Maintain</b> (−${CONFIG.maintainCost}) puts one back to 100%. At 0% it collapses.</li>
    <li>Probe, Claim and Wait each take one tick. Maintain is instant. Three rival agents move every tick and can snipe zones you haven't claimed yet.</li>
    <li>The run ends after ${CONFIG.maxTicks} ticks, or when you're out of credits with no zones. <b>Score</b> = everything you harvested.</li>
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
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const gridEl = $('grid');
const cellsEl: HTMLButtonElement[] = [];

let game: Game;
let selected: number | null = null;
let saved = false;

function seedFromUrl(): string | null {
  const s = new URLSearchParams(location.search).get('seed');
  return s && /^[\w-]{1,40}$/.test(s) ? s : null;
}

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
      b.addEventListener('click', () => select(idx(x, y)));
      gridEl.appendChild(b);
      cellsEl.push(b);
    }
  }
}

function heat(mid: number): string {
  // cold teal -> green -> gold -> hot magenta for the richest ground
  const hue = mid < 60 ? 190 - mid * 1.7 : 88 - (mid - 60) * 1.4;
  return `${Math.round(hue)}`;
}

function newRun(seed?: string) {
  game = new Game(seed ?? seedFromUrl() ?? randomSeed());
  selected = null;
  saved = false;
  const t = document.getElementById('toast');
  if (t) { t.className = 'toast'; t.textContent = 'Pick a zone and Probe it to start scouting.'; }
  render();
}

function select(i: number) {
  selected = i;
  render();
}

function toast(msg: string, kind: 'good' | 'bad' | 'info' = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
}

function act(kind: 'probe' | 'claim' | 'maintain' | 'wait') {
  if (game.over) return;
  if (kind === 'wait') {
    game.endTurn();
    toast(game.over ? `Run over: ${game.endReason} Map revealed.` : `Tick passed. ${game.tick}/${CONFIG.maxTicks}`);
    render();
    return;
  }
  if (selected === null) { toast('Tap a zone first.'); return; }
  const x = selected % CONFIG.size;
  const y = Math.floor(selected / CONFIG.size);
  const r = kind === 'probe' ? game.probe(x, y) : kind === 'claim' ? game.claim(x, y) : game.maintain(x, y);
  const bad = !r.ok || (kind === 'claim' && r.harvested === 0);
  toast(r.message, bad ? 'bad' : kind === 'claim' ? 'good' : 'info');
  if (game.over) toast(`Run over: ${game.endReason} Map revealed.`, 'info');
  render();
}

function zoneInfo(i: number): string {
  const c = game.cells[i];
  const x = i % CONFIG.size;
  const y = Math.floor(i / CONFIG.size);
  const label = `<b class="zl">${zoneLabel(x, y)}</b>`;
  if (game.over) {
    const z = game.map[i];
    return `${label} True value <b>${z.value}</b>${z.hazard ? ' · ⚠ hazard' : ''}`;
  }
  switch (c.status) {
    case 'owned':
      if (c.owner === 'you') {
        const v = game.map[i].value;
        return `${label} Yours · value ${v} · integrity <b>${c.integrity}%</b> · next yield ≈ ${tickYield(v, c.integrity).toFixed(1)}`;
      }
      return `${label} Held by <b style="color:${RIVAL_COLOR[c.owner!]}">${RIVAL_NAME[c.owner!]}</b>. Gone.`;
    case 'dud': return `${label} Dud. Nothing worth harvesting.`;
    case 'hazard': return `${label} ⚠ Hazard zone. Avoid.`;
    case 'depleted': return `${label} Collapsed. Depleted.`;
  }
  const [lo, hi] = c.known;
  if (hi - lo >= 100) return `${label} No reading yet. Probe to scan it (also hints its neighbours).`;
  const src = c.probes > 0 ? `probed ${c.probes}×` : 'hint from nearby probes';
  return `${label} Signal <b>${lo}–${hi}</b> (${signalWord(c.known)}) · ${src}${c.hazardFlag ? ' · <span class="warn">⚠ unstable, likely hazard</span>' : ''}`;
}

function render() {
  const g = game;
  $('s-credits').textContent = String(Math.floor(g.credits));
  $('s-score').textContent = String(Math.floor(g.score));
  $('s-tick').textContent = `${g.tick}/${CONFIG.maxTicks}`;
  $('c-probe').textContent = `−${CONFIG.probeCost}`;
  $('c-claim').textContent = `−${CONFIG.claimCost}`;
  $('c-maint').textContent = `−${CONFIG.maintainCost}`;

  $('rivals').innerHTML = g.rivals
    .map((r) => `<div class="rival" style="--c:${r.color}"><i></i><span class="rn">${r.name}</span><span class="rs">${Math.floor(r.score)}</span></div>`)
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
    if (g.over) {
      const z = g.map[i];
      cls.push('revealed');
      el.style.setProperty('--h', heat(z.value));
      el.style.setProperty('--a', String(0.12 + (z.value / 100) * 0.85));
      text = z.hazard ? '⚠' : String(z.value);
      if (c.owner) cls.push(c.owner === 'you' ? 'own-you' : 'own-rival');
      if (c.owner && c.owner !== 'you') el.style.setProperty('--c', RIVAL_COLOR[c.owner]);
    } else if (c.status === 'owned') {
      if (c.owner === 'you') {
        cls.push('own-you');
        text = String(g.map[i].value);
        if (c.integrity <= 30) cls.push('low');
      } else {
        cls.push('own-rival');
        el.style.setProperty('--c', RIVAL_COLOR[c.owner!]);
        text = RIVAL_NAME[c.owner!][0];
      }
    } else if (c.status === 'dud') {
      text = '✕';
    } else if (c.status === 'hazard') {
      text = '⚠';
    } else if (c.status === 'depleted') {
      text = '·';
    } else {
      const [lo, hi] = c.known;
      const w = hi - lo;
      if (w < 100) {
        const mid = (lo + hi) / 2;
        cls.push('known');
        el.style.setProperty('--h', heat(mid));
        el.style.setProperty('--a', String(Math.min(0.9, 0.05 + Math.pow(1 - w / 100, 1.4) * 0.85 * (0.3 + mid / 110))));
        if (c.probes > 0) text = String(Math.round(mid));
        if (c.probes > 0) cls.push('probed');
      }
      if (c.hazardFlag) { text = '⚠'; cls.push('flag'); }
    }
    if (c.ping && !g.over) { cls.push('pinged'); (el.lastElementChild as HTMLElement).style.background = RIVAL_COLOR[c.ping]; }
    if (selected === i) cls.push('sel');
    el.className = cls.join(' ');
    num.textContent = text;
    bar.style.width = c.owner === 'you' && !g.over ? `${c.integrity}%` : '0';
  });

  $('zone-info').innerHTML = selected === null
    ? (g.over ? 'Map revealed. Tap any zone to see its true value.' : 'Tap a zone on the map to select it.')
    : zoneInfo(selected);

  const sc = selected === null ? null : g.cells[selected];
  const canProbe = !g.over && !!sc && sc.status === 'open' && g.credits >= CONFIG.probeCost;
  const canClaim = !g.over && !!sc && sc.status === 'open' && g.credits >= CONFIG.claimCost;
  const canMaint = !g.over && !!sc && sc.owner === 'you' && sc.integrity < 100 && g.credits >= CONFIG.maintainCost;
  $<HTMLButtonElement>('a-probe').disabled = !canProbe;
  $<HTMLButtonElement>('a-claim').disabled = !canClaim;
  $<HTMLButtonElement>('a-maint').disabled = !canMaint;
  $<HTMLButtonElement>('a-wait').disabled = g.over;

  $('log').innerHTML = g.log
    .slice(-6)
    .reverse()
    .map((e) => `<div class="le ${e.kind}"><span class="lt">t${e.tick}</span>${e.text}</div>`)
    .join('');

  $('commit').textContent = g.commit;
  $('seed').textContent = g.over ? g.seed : 'sealed until the run ends';
  renderEnd();
}

function renderEnd() {
  const card = $('endcard');
  if (!game.over) { card.hidden = true; card.innerHTML = ''; return; }
  if (!card.hidden && card.dataset.seed === game.seed && card.dataset.saved === String(saved)) return;
  card.hidden = false;
  card.dataset.seed = game.seed;
  card.dataset.saved = String(saved);
  const score = Math.floor(game.score);
  const ok = verifyCommit(game.seed, game.commit);
  const best = [...game.rivals].sort((a, b) => b.score - a.score)[0];
  const beat = score > best.score;
  const mine = game.cells.filter((c) => c.owner === 'you').length;
  card.innerHTML = `
    <div class="end-reason">${game.endReason}</div>
    <div class="end-score">${score}<span>score</span></div>
    <div class="end-sub">${beat ? `You out-harvested every rival (best: ${best.name} ${Math.floor(best.score)}).` : `${best.name} led with ${Math.floor(best.score)}.`}
      ${game.probesUsed} probes · ${game.claimsMade} claims · ${mine} zones still yours.</div>
    <div class="end-verify ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} Seed <code>${game.seed}</code> ${ok ? 'matches the commit. Map was fixed from the start.' : 'does NOT match the commit.'}</div>
    ${saved ? `<div class="end-saved">Saved to records.</div>` : qualifies(score) ? `
      <form class="save" id="save-form">
        <input id="handle" maxlength="16" placeholder="Your name or handle" autocomplete="nickname" value="${escapeHtml(loadHandle())}" />
        <button class="primary" type="submit">Save record</button>
      </form>` : `<div class="end-saved">Not in the top 10 this time.</div>`}
    <div class="end-btns">
      <button class="primary" id="end-new" type="button">New run</button>
      <button class="ghost" id="end-records" type="button">Records</button>
    </div>`;
  $('end-new').addEventListener('click', () => newRun(randomSeed()));
  $('end-records').addEventListener('click', openRecords);
  const form = document.getElementById('save-form') as HTMLFormElement | null;
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ($('handle') as HTMLInputElement).value.trim().slice(0, 16) || 'anon';
    saveHandle(name);
    const rank = saveScore({ name, score, seed: game.seed, commit: game.commit, date: new Date().toISOString() });
    saved = true;
    renderEnd();
    toast(rank ? `Saved: #${rank} on this device.` : 'Saved.', 'good');
  });
  if (!saved) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function openRecords() {
  const list = loadScores();
  $('records-list').innerHTML = list.length
    ? list.map((e) => `<li><span class="rn">${escapeHtml(e.name)}</span><span class="rs">${e.score}</span><span class="rd">${new Date(e.date).toLocaleDateString()}</span></li>`).join('')
    : '<li class="muted">No records yet. Finish a run to set one.</li>';
  $<HTMLDialogElement>('dlg-records').showModal();
}

buildGrid();
$('a-probe').addEventListener('click', () => act('probe'));
$('a-claim').addEventListener('click', () => act('claim'));
$('a-maint').addEventListener('click', () => act('maintain'));
$('a-wait').addEventListener('click', () => act('wait'));
$('btn-help').addEventListener('click', () => $<HTMLDialogElement>('dlg-help').showModal());
$('btn-records').addEventListener('click', openRecords);
$('btn-new').addEventListener('click', () => {
  if (game.over || confirm('Abandon this run and start a new one?')) newRun(randomSeed());
});
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap backdrop to close
}
newRun();
if (!localStorage.getItem('substrate.seenHelp')) {
  localStorage.setItem('substrate.seenHelp', '1');
  $<HTMLDialogElement>('dlg-help').showModal();
}

// ---- Machine-friendly hook for agents (future x402 / pay-per-play) ----
type Api = {
  version: string;
  state: () => ReturnType<Game['state']>;
  probe: (x: number, y: number) => ReturnType<Game['probe']>;
  claim: (x: number, y: number) => ReturnType<Game['claim']>;
  maintain: (x: number, y: number) => ReturnType<Game['maintain']>;
  endTurn: () => ReturnType<Game['endTurn']>;
  newRun: (seed?: string) => ReturnType<Game['state']>;
};
const wrap = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { const r = fn(...a); render(); return r; };
const api: Api = {
  version: 'substrate-demo-1',
  state: () => game.state(),
  probe: wrap((x: number, y: number) => game.probe(x, y)),
  claim: wrap((x: number, y: number) => game.claim(x, y)),
  maintain: wrap((x: number, y: number) => game.maintain(x, y)),
  endTurn: wrap(() => game.endTurn()),
  newRun: (seed?: string) => { newRun(seed ?? randomSeed()); return game.state(); },
};
(window as unknown as { substrate: Api }).substrate = api;
