# Deploy loading screen — feedback while the valley builds (2026-06-06)

**Player report:** *"They click Deploy and nothing happens for several seconds before the game
screen. I'd like a loading screen — a spinner, a progress bar if we have one, and a list of
what's happening."*

## Root cause (measured, not guessed)

Clicking **Deploy** ran the entire deploy synchronously in the click handler, then switched the
screen. Because JS is single-threaded, React could not paint anything until the work finished —
so the button just froze. Worse, the single biggest cost was *invisible*: it fired on the **first
animation frame after** the screen switch.

Breakdown (CDP harness, headless `--disable-gpu` → software canvas, seed `kunar-2011`, 120-day):

| phase | cost | where |
|---|---:|---|
| `createTerrain` (512² heightmap, rivers, roads) | ~319 ms | `lib/sim/world/create.ts` |
| `createWorld` (platoon, villages, civilians, COP) | ~6 ms | `lib/sim/world/create.ts` |
| **`bakeTerrain` (4096² = 16.7 M-pixel shaded relief)** | **~5,900 ms** | `lib/render/topo.ts` — **the hidden villain** |
| `loadSprites` (164 SVG rasters) | ~265 ms | `lib/render/sprites.ts` |
| **total click → playable** | **~6.5 s, frozen, zero feedback** | |

The bake was lazy — `drawTerrain` → `bakeTerrain` ran on WorldView's first frame, *after* the
deploy screen mounted, so even a naive loading screen would have frozen on it.

## The fix — one mechanism, staged with paint-yields

1. **Terrain seam** (`create.ts`): `createTerrain(seed)` + an optional `terrain` arg to
   `createWorld` so the heightmap is its own visible phase, built once. **Verified byte-identical**
   to the one-shot path across 5 seeds (`_probe-determinism` recipe below).
2. **Staged deploy** (`state/store.ts` `runDeploy`): set `screen:"loading"`, **yield to a real
   browser paint** (double-rAF) so the loading screen renders *before* any blocking work, then run
   each phase with a paint-yield in front of it. Routes `newCampaign`, `loadCampaign`,
   `startTutorial`.
3. **Render pre-warm, progressively** (`topo.ts` `bakeTerrainProgressive`): the relief bake now
   shades the sheet in 40 row-bands, **reports 0→1 and yields a frame between bands**, and populates
   the same `WeakMap` the live draw reads. So the progress bar fills smoothly through the 6 s bake,
   and the first deploy frame is a pure cache hit (no first-frame freeze). Sprites are pre-warmed
   too; WorldView's mount now guards with `spritesReady()`.
4. **The screen** (`components/screens/LoadingScreen.tsx`): phase checklist (spinner / ✓ / ○),
   "PHASE n/N", a live % + gliding bar, a faint military map-grid, a rotating field-manual line.

## After (same harness)

| metric | before | after |
|---|---:|---:|
| feedback after click | none (frozen button) | **loading screen @ 0.2 ms** |
| progress-bar updates during the 5.9 s bake | 0 (frozen) | **42 samples, 40 distinct %** (50→75%) |
| first deploy frame | bake freeze (~5.9 s) | **instant** (pre-warmed cache hit) |
| determinism (5 seeds) | — | **byte-identical** |
| total click → playable | ~6.5 s | ~6.5 s *(unchanged — the goal was feedback, not speed)* |

**Standing checks:** `tsc` ✓ · `build` ✓ · `lint` (changed files clean) ✓ · `smoke` SMOKE OK ·
`balance` no stalls · determinism byte-identical.

Screenshots: `01-menu-before.png` · `02-loading-hero.png` · `03-loading-live-0..3.png` (real flow)
· `04-deploy-after.png` (terrain painted instantly). Full explainer: `report.html`.

## Honest residual (restraint logged)

The deploy is now *covered* by feedback, not *faster*. The ~6 s relief bake (a 4096² sheet, partly
software-canvas in this headless harness) is the dominant cost and is **deliberately not optimized
here** — that's a separate perf trade-off (bake resolution vs. zoom crispness, or an off-thread /
cached bake). Logged as **`docs/issues/011-deploy-relief-bake-cost.md`** for a future measured pass.

## Reproduction recipe (the scratch harness was deleted; the technique is the asset)

- **Determinism oracle:** `createWorld(seed,d)` vs `createWorld(seed,d,createTerrain(seed))` →
  `JSON.stringify(world.serialize())` must be identical. (5 seeds, all identical.)
- **Live timing + capture:** a zero-dep CDP script drives an **isolated** headless Chrome
  (`--user-data-dir=/tmp/...`, own port → no MCP contention) with throttling disabled
  (`--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
  --disable-background-timer-throttling` — headless backgrounds the tab and throttles rAF to ~1 Hz,
  which corrupts both the timing and the nextPaint yields). Time the flow **page-side** via
  `window.__ITM.subscribe(...)` (Node-side polling blocks behind the same main thread the bake is
  hogging). Capture frames Node-side with `Page.captureScreenshot` (works during page jank).
