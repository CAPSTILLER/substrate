# Substrate (demo)

A wallet-free browser demo of **Substrate** by CAPSTILLER. It's a hidden-map scouting and high-score game.

> The universe map is hidden in the substrate. Send scouts, read the signal, and harvest a zone before the rival agents figure it out.

**Demo only.** Fake CAPH-demo credits, no wallet, nothing onchain. High scores live in `localStorage` on the device and will move onchain later (CAPH vault + HighScoreRecords).

**25 arenas, 100 seats.** The demo runs 25 independent arenas at once, each a 10×10 hidden map with 4 seats. Laid out 5×5 they form one 50×50 board, the **Substrate map**, which doubles as a live art piece (like Caphet Arena). You play one seat; the other 99 are house bots for now.

## How a run plays

- **The map:** a 10×10 map of zones, each with a hidden value from 0 to 100. Most zones are poor. A few rich veins cluster together, and some zones are empty or hazards.
- **Probe (−3 credits, 1 tick):** gives a signal range that always contains the true value. Repeat probes narrow the range: 40 wide, then 24, then 14, and so on. Zones within 2 rings of the probe get fainter hints (70 and 90 wide).
- **Claim (−10, 1 tick):** what happens depends on the zone's value.
  - Value 20 or more: you harvest half the value right away, and the zone yields `value × 5% × integrity` every tick.
  - Under 20: the zone is a dud and the stake is lost.
  - Hazards cost 10 extra.
- **Decay:** your zones lose 10% integrity per tick. **Maintain** (−4, instant) puts a zone back to 100%. At 0% the zone collapses.
- **Rivals:** the other three seats at your arena act every tick. In C3 that's Vex-7 (aggressive), Orin (careful) and Null.Kid. They probe and claim on their own, and they can snipe zones you haven't claimed yet.
- **Wait:** passes 1 tick.
- **The end:** a round lasts 40 ticks. If you run out of credits and hold no zones you're out early, and the round finishes without you. **Score = everything you harvested.**

### Commit / reveal

At the start the game shows `commit = sha256("substrate-v1|" + seed + "|" + map)`, with the map serialized row by row and `H` for hazards. The seed stays sealed during the run. At the end the seed and the full map are revealed## Arenas, seats and the shared clock

- **Arenas:** 25 of them, ids `A1`..`E5` (rows A–E top to bottom, columns 1–5 left to right). Each has its own seed `"<master>-r<round>-<id>"`, its own hidden map and its own commit hash. All 25 seeds come from one master seed, so `?seed=xyz` replays the whole world.
- **Seats:** 4 per arena = 100. A seat is a generic slot `{ kind: 'human' | 'house' | 'agent' }`:
  - `house` seats run the built-in AI and the original rival rules (no credits, no decay).
  - `human` and `agent` seats play by the player rules (credits, decay, Maintain) and are driven by the UI or the API.
- **House bots:** five personality families inside the v1 tuning band: Vex (aggressive), Orin (careful), Null (balanced), Kite (restless) and Mote (patient). Arena **C3** (the centre) keeps the original Vex-7, Orin and Null.Kid; the other 96 bots get generated names and colours. Line-ups carry over between rounds.
- **Your seat:** by default you sit in C3 next to the original trio, so the single-table game plays exactly as before. `?arena=B4` picks another arena, and **Switch arena** (or *Join* while watching an arena) moves you. Joining replaces a house bot one for one. At tick 0 it's the newest bot; mid-round it's the lowest-scoring bot, and that bot's zones collapse. Switching mid-round ends your current run; the seat you leave goes back to a fresh house bot.
- **Shared clock:** all 25 arenas tick together, 40 ticks per round. When you're in your own arena, **your moves drive the clock**: Probe, Claim and Wait tick all 25 arenas, Maintain is instant. Gameplay and tuning are unchanged from v1. Anywhere else (the map, watching another arena, or after you bust), the clock runs on its own at 1×, 2× or 4× (1× = one tick per second), or pauses. While it auto-runs, your seat holds position, which is the same as Wait.
- **Rounds:** at tick 40 every arena ends. Its seed is revealed and checked against its commit, and the map shows the 25/25 result. After a short hold (or **Next round** in your arena), a new round starts with new seeds in all 25 arenas. If you run out of credits early you're marked *out* and the round finishes without you.

### How live players and agents replace house bots

The seat model is already in place for this. `World.seatAt(arena, { id, kind: 'agent' | 'human', name, color })` swaps a house bot for a live occupant, and `World.vacate(arena, seatId)` hands the seat back to a fresh bot. In the live version:

1. A player or agent pays to play (x402 / CAPH vault) and asks for a seat.
2. The game server puts it in the first arena with a house seat, centre-out from C3. Following the Arena rule, a newcomer takes a seat in the *next* round, replacing a house bot.
3. Every arena still runs 4 seats. Empty seats stay house bots, so the board always looks full and the art piece keeps moving.
4. Each round is one match per arena (arena id + round id). Payouts go through the shared CAPH vault, and scores go into HighScoreRecords tagged with arena and round. No new contracts are needed for more arenas.

Agent seats use `Game.act(seatId, kind, x, y)`, which runs the same rules as the human seat.

## The Substrate map (overview and art mode)

Tap **Substrate map** in the arena bar. Or open `/?view=map` directly, or `/?art=1` to start in clean mode.

- **The view:** a top-down 50×50 render of all 25 arenas, drawn on a canvas, square and as large as the screen allows.
  - Dark = unread.
  - Glow = probe heat: confident, rich readings glow brightest.
  - Claimed zones take the owner's colour, brighter for richer zones and fuller integrity.
  - Duds, hazards and collapsed zones are marked faintly.
  - Small dots = bot probes this tick.
  - Thin gutters separate the 5×5 arenas, and your arena is outlined in cyan.
  - At round end every map is revealed.
- **Fairness:** your own arena only shows *your* readings while the round is live. The other arenas show every scout's readings combined.
- **Tap any arena** to watch it (read-only). From there you can join it or go back to yours. The leaderboard covers all 100 seats.
- **Controls:**
  - ❚❚ / 1× / 2× / 4×: pause and speed.
  - **Labels:** arena ids, your outline and the export caption.
  - **Text off:** full-screen clean piece with no UI at all. Tap or press Esc to exit.
  - **Background:** 5 presets plus a custom colour picker.
  - **Save image:** exports a 2048×2048 PNG. It uses the Android share sheet when the browser supports sharing files, otherwise it downloads.

Rendering: the simulation runs separately from drawing. The canvas only redraws when something changed, via `requestAnimationFrame`, and cells are batched by colour into one path per colour.

## Agent hook (`window.substrate`)

This is a small machine-friendly API for later agent / x402 pay-per-play work. Open the browser console, or drive it with Playwright.

The original single-table calls still work and act on **your** arena:

```js
substrate.state()          // your arena: { arena, round, phase, seated, ...game state } (see below)
substrate.probe(x, y)      // x,y are 0..9 (x = column A..J, y = row 1..10). Ticks all 25 arenas.
substrate.claim(x, y)      // ticks all 25 arenas
substrate.maintain(x, y)   // your zone back to 100% integrity. No tick.
substrate.endTurn()        // wait 1 tick
substrate.newRun(seed?)    // fresh world from a new master seed (random if omitted); you keep your arena
```

Arena-aware calls:

```js
substrate.listArenas()        // [{ id, index, row, col, round, tick, commit, seed|null, over, verified, you, openSeats,
                              //    seats: [{ slot, id, kind, name, color, family, score, zones, out }] }]
substrate.joinArena('B4')     // take a seat (accepts 'B4', 0-based index, or '1'..'25'); returns state()
substrate.leaveArena()        // give your seat back to the house and just watch
substrate.state('D2')         // public spectator snapshot of any arena (no private readings)
substrate.world()             // { master, round, tick, maxTicks, phase, seats, humans, agents, house, yourArena, verified, running, speed }
substrate.leaderboard(10)     // top seats across all 100
substrate.step()              // advance the shared clock 1 tick (your seat holds)
substrate.nextRound()         // during the reveal: start the next round now
substrate.setClock({ running: true, speed: 4 })
substrate.view('map' | 'arena' | 'clean', arenaId?)
substrate.setBackground('#0d1330')
substrate.saveImage()         // same as the Save image button
substrate.bench(), substrate.perf()   // timing probes
```

Every action returns `{ ok, message, range?, harvested?, event? }` (`event` is `'tick' | 'reveal' | 'round'`) and updates the UI.

`state()` for your arena returns:

```ts
{
  arena: 'C3', round, phase: 'play'|'reveal', verified: boolean|null, seated: true,
  seed: string | null, commit: string, tick, maxTicks, credits, score, over, endReason, out, outReason,
  costs: { probe, claim, maintain },
  rules: { size, claimThreshold, decayPerTick, yieldRate, claimHarvestRate },
  rivals: [{ id, kind, name, score, zones }],
  zones: [{ x, y, label, status: 'open'|'owned'|'dud'|'hazard'|'depleted', owner: 'you'|seatId|null,
            range: [lo, hi], probes, hazardFlag, integrity?, rivalPing, value?, hazard? }],
  log: [{ tick, kind, text }]
}
```

### Code layout

- `src/game.ts`: one arena (`Game`). The hidden map, commit, seats, actions and house AI. Pure TypeScript, no DOM. `new Game(seed)` is still the original single table.
- `src/world.ts`: `World` with 25 arenas, the roster, the shared clock and rounds, seat replacement, leaderboard, and arena/global coordinate helpers (`globalCell(row, col, x, y)` → 50×50).
- `src/overview.ts`: the canvas renderer and PNG export.
- `src/main.ts`: the UI.

Both `Game` and `World` can run server-side when plays become paid.

ivalId|null,
            range: [lo, hi], probes, hazardFlag, integrity?, rivalPing, value?, hazard? }],
  log: [{ tick, kind, text }]
}
```

The core rules are in `src/game.ts`, which is pure TypeScript with no DOM. The same `Game` class can run server-side when plays become paid.

## Develop

```bash
npm install
npm run dev      # local dev server
npm test         # vitest: map/commit/probe/claim/replay + 25-arena world, rounds, seats, 50x50 mapping, records
npm run build    # outputs dist/
```

On Vercel, import the repo with framework **Vite**, build command `npm run build`, and output directory `dist`. `vercel.json` already sets these.

## Tuning (v1)

| Knob | Value |
| --- | --- |
| Start credits | 100 |
| Ticks per run | 40 |
| Probe / Claim / Maintain cost | 3 / 10 / 4 |
| Dud threshold | value < 20 |
| Claim harvest | 50% of value |
| Yield per tick | 5% of value × integrity |
| Decay per tick | 10% |
| Probe widths | 40 → 24 → 14 → 9 → … (min 4) |
| Neighbour hints | 70 wide (adjacent), 90 wide (2 rings) |
| Map | 3–4 veins (peak 60–100), 8 empty, 6 hazards |
| House bots | act 75–85% of ticks, greed 32–40, width 22–36 |
| World | 25 arenas × 4 seats, 40 ticks per round, 1× = 1 tick/s |

In simulations over 400 seeds, a strong bot scored about 950 median. Without maintaining zones it scored about 440, and rivals finished around 300 to 550 each.
