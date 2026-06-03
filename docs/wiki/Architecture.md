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
- **`tasks.ts`** — strategic task progression (`tickTasks`): assemble → move (terrain-routed) →
  on-station dwell → return, yielding to combat AI on contact and resuming on the lull.
- **`projects.ts`** — CERP project logistics (`tickProjects`) and resupply (`tickResupplies`).
- **`events.ts`** — decision events (`makeWorldEvent`, `applyWorldEventChoice`).
- **`helpers.ts`** — shared free functions (centroid, dwell times, enemy roles, civilian routines).

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
(hillshade from the elevation gradient + landcover tint + marching-squares contour lines), cached in
a `WeakMap` keyed by `Terrain`, capped to a fixed sheet size so the 5 m grid bakes fast. Live views
`drawImage` that bitmap under a `Camera`, then overlay grid, intel markers, villages, project rings,
the COP, units (`lib/render/draw.ts`: MIL-style friendly rectangles, hostile diamonds, civilian
rings, facing wedges, health/suppression rings), tracers, effects, smoke, LOS lines, paths, and the
live planning route. Night applies a low-light wash driven by `World.ambientLight()`.

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
