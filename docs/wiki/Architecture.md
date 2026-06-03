# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ React / Next.js (components/, app/)                        │
│   GameRoot → screens (menu, command, briefing, tactical,   │
│   afteraction, tourend) + TutorialCoach                    │
│   map/TopoMap (strategic)   tactical/TacticalView (RTWP)   │
└───────────────▲───────────────────────────┬───────────────┘
                │ reads/subscribes           │ actions
┌───────────────┴───────────────────────────▼───────────────┐
│ state/store.ts  (Zustand)                                  │
│   screen, campaign, terrain, sim, plan, selection, …       │
│   newCampaign / advance / launchPatrol / beginTactical /   │
│   orderAtWorld / fireAtWorld / endTactical / …             │
└───────────────▲───────────────────────────┬───────────────┘
                │                            │
┌───────────────┴────────────┐  ┌────────────▼───────────────┐
│ lib/sim  (pure engine)      │  │ lib/render (Canvas 2D)      │
│  campaign · patrol · events │  │  topo (bake + camera) ·     │
│  combat · ai · ballistics · │  │  draw (units, fx, markers)  │
│  los · terrain · weapons ·  │  └─────────────────────────────┘
│  entities · names · rng·vec │
└─────────────────────────────┘
```

The engine knows nothing about React. The renderers know nothing about React state (they take a
`Terrain`/`CombatSim` and a `Camera`). The store is the only bridge.

## Data flow

- **Command view** renders from `CampaignState`; HUD panels subscribe to a `tick` counter the store
  bumps on each mutation, and re-read campaign fields. The `TopoMap` runs its own `requestAnimationFrame`
  loop drawing the baked terrain + markers + the live planning route.
- **Tactical view** is authoritative real-time. `TacticalView` owns a RAF loop that steps
  `sim.tick(0.1)` in fixed substeps (scaled by the store's `speed`, pausable), draws every frame,
  and ~7×/sec calls `syncTactical()` to refresh the HUD and detect the end of the engagement (which
  triggers `endTactical` → `applyCombatResult` → after-action). Heavy per-frame data never round-trips
  through React state.

## Rendering

`lib/render/topo.ts` bakes a high-resolution shaded-relief image of the whole valley **once**
(hillshade from the elevation gradient + landcover tint + marching-squares contour lines), cached in
a `WeakMap` keyed by `Terrain`. Live views just `drawImage` that bitmap under a `Camera`
(center + pixels-per-meter), then overlay vector grid, markers, units (`lib/render/draw.ts`: MIL-style
friendly rectangles, hostile diamonds, civilian rings, facing wedges, health/suppression rings),
tracers, muzzle/impact/blast effects, smoke, LOS lines, and paths. Night applies a low-light wash.

## Determinism & saves

The engine is deterministic given seeds. `CampaignState` is plain serializable data; `Terrain` and
`CombatSim` are class instances rebuildable from a seed + state. (Persistence to `localStorage` is a
natural extension — the data model is ready for it.)

## Headless harnesses

`scripts/smoke.ts` and `scripts/balance.ts` (run with `npx tsx`) exercise the full engine without a
browser — useful for regression and for tuning combat balance (`balance.ts` reports average
casualties and asserts that engagements always resolve, never stall).

## Conventions

- World coordinates are **meters**; the terrain grid is **cells** (`cellSize` m each).
- Angles are radians, screen-space y-down. Compass helpers live in `vec.ts`.
- Transient per-unit combat scratch (`_fireTarget`, `_fireLOS`, burst counters) lives on `Unit`;
  persistent roster data lives on `RosterMember extends Unit`.
