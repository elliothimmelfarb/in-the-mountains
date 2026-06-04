# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ React / Next.js (components/, app/)                        │
│   GameRoot → screens (menu, deploy, tourend) + TutorialCoach│
│   world/WorldView  — the single live topo+tactical surface │
└───────────────▲───────────────────────────┬───────────────┘
                │ reads/subscribes (tick)    │ actions
┌───────────────┴───────────────────────────▼───────────────┐
│ state/store.ts  (Zustand)                                  │
│   screen, world, selection, orderTool, posture, planning,  │
│   paused/speed/warp, fireSupport, …                        │
│   frame(realDt)  ← the real-time loop (steps World.tick)   │
│   newCampaign / orderAtWorld / stepOff / conductKLE /      │
│   fundProject / requestResupply / fireAtWorld / …          │
└───────────────▲───────────────────────────┬───────────────┘
                │                            │
┌───────────────┴────────────┐  ┌────────────▼───────────────┐
│ lib/sim  (pure engine)      │  │ lib/render (Canvas 2D)      │
│  world/ (clock+orchestration)│ │  topo (bake + camera) ·     │
│  combat · ai · ballistics · │  │  draw (units, fx, markers)  │
│  los · path · terrain ·     │  └─────────────────────────────┘
│  weapons · entities · campaign ·                            │
│  names · rng · vec          │                               │
└─────────────────────────────┘
```

The engine knows nothing about React. The renderers know nothing about React state (they take a
`Terrain`/`CombatSim` and a `Camera`). The store is the only bridge.

## The continuous world (`lib/sim/world/`)

`world.ts` was getting large, so the world is a small **package** split by concern:

- **`world.ts`** — the `World` class: the master clock (`tick(dt)`), time-of-day/light, logging,
  supply burn, soldier rest/morale, metrics, casualty reconciliation, enemy culling, tour end, the
  player **order interface** (`formPatrol`, `conductKLE`, `startProject`, `requestResupply`, fire
  support, medevac), and queries (`inContact`, `nearestVillage`, …). It owns a single persistent
  `CombatSim`.
- **`types.ts`** — `WorldState`, `Task`, `Project`, `MissionType`, constants, and the shared `Ids`
  counters.
- **`create.ts`** — `createWorld(seed, days)` and `loadWorld(blob)` factories.
- **`director.ts`** — the enemy activity director (`runDirector`): heat drift + scheduled
  ambush / infiltration / harassment / complex-attack spawns, all routed through the terrain.
- **`tasks.ts`** — strategic task progression (`tickTasks`): muster → file out the gate → move to
  the objective as a squad → on-station security halt → return through the gate, yielding to combat
  AI on contact and resuming on the lull.
- **`formation.ts`** — squad movement composed on the real squad echelon (`planFormation`,
  `steerSquad`, `holdSecurity`): reconstructs the squad leader + two fire teams + attachments from a
  task's roster and moves them in formation (file/wedge/column/dispersed) by doctrine, point man
  navigating with A*, each man pulling a security sector, the SL pacing the squad so it stays
  together.
- **`garrison.ts`** — garrison life inside the wire (`tickGarrison`): a rotating guard roster on the
  fighting positions/towers, MG crews on their guns, meal hours at the chow hall, barracks after
  dark, leaders in the TOC, medic at the aid station — and a whole-COP **stand-to** when the wire
  takes fire.
- **`projects.ts`** — CERP project logistics (`tickProjects`) and resupply (`tickResupplies`).
- **`events.ts`** — decision events (`makeWorldEvent`, `applyWorldEventChoice`).
- **`helpers.ts`** — shared free functions (centroid, dwell times, enemy roles, civilian routines,
  the COP emplacement/crew layout).

Subsystem modules take the `World` as an argument and use its public surface; they import the
`World` type-only to avoid a runtime cycle.

## Data flow

There is one screen. `WorldView` owns a `requestAnimationFrame` loop that calls
`store.frame(realDt)` every frame and draws every frame. `frame`:

- Steps `world.tick(0.1)` in fixed 0.1 s slices, the count scaled by `speed` (combat clamps to
  ≤4×). **Warp** mode advances many slices per frame and stops on the first interrupt
  (`world.drainInterrupts()`) — contact, a patrol reaching its objective, a project milestone, a
  decision event, first light.
- Pauses stepping while `world.pendingEvent` is set (a decision modal blocks time).
- Bumps a `tick` counter ~9×/sec so HUD panels (which subscribe to `tick` and re-read `world.state`)
  refresh, and autosaves periodically. Heavy per-frame data never round-trips through React.

## Rendering

`lib/render/topo.ts` bakes a high-resolution shaded-relief image of the whole valley **once**
(hillshade from the elevation gradient + landcover tint, with fbm-dithered class boundaries so edges
are organic not 5 m stair-steps, + marching-squares contour lines), cached in a `WeakMap` keyed by
`Terrain`. The COP's HESCO walls, structures and gravel pads are baked right into the relief; live
views `drawImage` that bitmap under a `Camera`, plus a world-anchored noise overlay at high zoom that
hides the upscale blur. Night applies a low-light wash driven by `World.ambientLight()`.

### Sprite / asset system (map visual overhaul)

On top of the relief, entities are drawn as **hand-authored SVG sprites** rather than primitive shapes.
`lib/render/sprites.ts` rasterizes ~160 SVGs (`lib/render/asset-manifest.generated.ts`, built from
`docs/visual-overhaul/assets/`) once to offscreen canvases (bake-once / blit-many) and blits them
scaled + rotated each frame; a **level-of-detail** system crossfades by zoom (`lodAlpha`):

- `lib/render/draw.ts` — `drawUnit` crossfades a NATO mil-symbol → a top-down figure sprite (per
  faction+role) with a faction base-ring and de-cluttered nameplates; `drawCop` renders building / LZ
  pad / ECP gate / tower / fighting-position / flag / vehicle sprites (buildings stretched to their
  data footprint). Tracers, effects, smoke, LOS lines and the planning route still draw vectorially.
- `lib/render/decoration.ts` — scatters tree / rock / reed sprites by landcover from a **stable
  per-cell hash** (no jitter on pan/zoom), with clumping, clearance from roads/water/the COP, and
  per-instance variation; fades in at tactical zoom.
- `components/world/WorldView.tsx` — qalat village compounds + attitude-coloured banner pins, intel /
  named-feature markers, a Black Hawk on the LZ during air resupply, and a cartographic HUD
  (compass rose + scale bar). `components/Icon.tsx` puts the matching flat icons throughout the chrome.

The full art direction, asset catalogue and before/after live in **`docs/visual-overhaul/`**
(`ART_BIBLE.md` + the generated `asset-bible.html`). Regenerate the bundled manifest after editing any
asset: `node scripts/build-asset-manifest.mjs` (and `build-asset-doc.mjs` for the HTML bible).

## Determinism & saves

The engine is deterministic given seeds. `World.serialize()` writes `{ rngState, state, units }` to
`localStorage` (key `itm-save-v2`); `loadWorld` rebuilds the `Terrain` from the seed, restores the
RNG state and id counters, and re-attaches the live unit list (the platoon members **are** the live
sim units, so combat mutates the roster directly). The store autosaves as you play and on pause.

## Headless harnesses

`scripts/smoke.ts` and `scripts/balance.ts` (run with `npx tsx`) exercise the full continuous world
without a browser — `smoke` sends a patrol and prints a play-by-play + a landcover histogram + a
save round-trip; `balance` runs many deployments and reports casualties and checks that patrols
resume after contact (no stranded elements).

## Conventions

- World coordinates are **meters**; the terrain grid is **cells** (`cellSize` = 5 m).
- Angles are radians, screen-space y-down. Compass helpers live in `vec.ts`.
- Transient per-unit combat scratch (`_fireTarget`, `_fireLOS`, burst counters) lives on `Unit`;
  persistent roster data lives on `RosterMember extends Unit`. Move postures are `Unit.technique`.
