# Substrate (demo)

A wallet-free browser demo of **Substrate** by CAPSTILLER. It's a hidden-map scouting and high-score game.

> The universe map is hidden in the substrate. Send scouts, read the signal, and harvest a zone before the rival agents figure it out.

**Demo only.** Fake CAPH-demo credits, no wallet, nothing onchain. High scores live in `localStorage` on the device and will move onchain later (CAPH vault + HighScoreRecords).

## How a run plays

- **The map:** a 10×10 map of zones, each with a hidden value from 0 to 100. Most zones are poor. A few rich veins cluster together, and some zones are empty or hazards.
- **Probe (−3 credits, 1 tick):** gives a signal range that always contains the true value. Repeat probes narrow the range: 40 wide, then 24, then 14, and so on. Zones within 2 rings of the probe get fainter hints (70 and 90 wide).
- **Claim (−10, 1 tick):** what happens depends on the zone's value.
  - Value 20 or more: you harvest half the value right away, and the zone yields `value × 5% × integrity` every tick.
  - Under 20: the zone is a dud and the stake is lost.
  - Hazards cost 10 extra.
- **Decay:** your zones lose 10% integrity per tick. **Maintain** (−4, instant) puts a zone back to 100%. At 0% the zone collapses.
- **Rivals:** three agents act every tick: Vex-7 (aggressive), Orin (careful) and Null.Kid. They probe and claim on their own, and they can snipe zones you haven't claimed yet.
- **Wait:** passes 1 tick.
- **The end:** a run lasts 40 ticks, or ends early if you're out of credits and hold no zones. **Score = everything you harvested.**

### Commit / reveal

At the start the game shows `commit = sha256("substrate-v1|" + seed + "|" + map)`, with the map serialized row by row and `H` for hazards. The seed stays sealed during the run. At the end the seed and the full map are revealed and checked against the commit. This mirrors the onchain commit-reveal that comes later.

Add `?seed=yourseed` to the URL to replay a specific map. All randomness (map, probe noise, rival moves) comes from the seed, so the same seed plus the same actions always gives the same run.

## Agent hook (`window.substrate`)

This is a small machine-friendly API for later agent / x402 pay-per-play work. Open the browser console, or drive it with Playwright:

```js
substrate.state()          // JSON snapshot (see below). Hidden values/seed only after the run is over.
substrate.probe(x, y)      // x,y are 0..9 (x = column A..J, y = row 1..10). Uses 1 tick.
substrate.claim(x, y)      // Uses 1 tick.
substrate.maintain(x, y)   // Your zone back to 100% integrity. No tick.
substrate.endTurn()        // Wait 1 tick.
substrate.newRun(seed?)    // Start over (random seed if omitted). Returns state().
```

Every action returns `{ ok, message, range?, harvested? }` and updates the UI.

`state()` returns:

```ts
{
  seed: string | null, commit: string, tick, maxTicks, credits, score, over, endReason,
  costs: { probe, claim, maintain },
  rules: { size, claimThreshold, decayPerTick, yieldRate, claimHarvestRate },
  rivals: [{ id, name, score, zones }],
  zones: [{ x, y, label, status: 'open'|'owned'|'dud'|'hazard'|'depleted', owner: 'you'|rivalId|null,
            range: [lo, hi], probes, hazardFlag, integrity?, rivalPing, value?, hazard? }],
  log: [{ tick, kind, text }]
}
```

The core rules are in `src/game.ts`, which is pure TypeScript with no DOM. The same `Game` class can run server-side when plays become paid.

## Develop

```bash
npm install
npm run dev      # local dev server
npm test         # vitest: map determinism, commit verify, probe narrowing, claim/yield/decay, replay
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
| Rivals | act 75–80% of ticks |

In simulations over 400 seeds, a strong bot scored about 950 median. Without maintaining zones it scored about 440, and rivals finished around 300 to 550 each.
