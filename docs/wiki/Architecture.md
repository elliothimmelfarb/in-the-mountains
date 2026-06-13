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
│   screen, world, activeSquadId, attachOfficers, planning,  │
│   planRoute, planMission, planSOP, paused/speed/warp,      │
│   fireSupport, …                                           │
│   frame(realDt)  ← the real-time loop (steps World.tick)   │
│   newCampaign / selectSquad / setPlanSOP / stepOff /       │
│   reroute / setSquadSOP / approveFires / denyFires /       │
│   conductKLE / fundProject / requestResupply / …           │
└───────────────▲───────────────────────────┬───────────────┘
                │                            │
┌───────────────┴────────────┐  ┌────────────▼───────────────┐
│ lib/sim  (pure engine)      │  │ lib/render (WebGL2 + 2D)    │
│  world/ (clock+orchestration)│ │  gl/ TerrainGL (HDR terrain)│
│  combat · ai · ballistics · │  │  sky · atmosphere-model ·   │
│  los · path · terrain ·     │  │  topo (2D bake / fallback) ·│
│  weapons · entities ·       │  │  draw (units, fx, markers)  │
│  campaign · names · rng·vec │  └─────────────────────────────┘
└─────────────────────────────┘
```

The engine knows nothing about React. The renderers know nothing about React state (they take a
`Terrain`/`CombatSim` and a `Camera`). The store is the only bridge.

## The continuous world (`lib/sim/world/`)

`world.ts` was getting large, so the world is a small **package** split by concern:

- **`world.ts`** — the `World` class: the master clock (`tick(dt)`), time-of-day/light, logging,
  supply burn, soldier rest/morale, metrics, casualty reconciliation, enemy culling, tour end, the
  player **command interface** (`formPatrol`/`conductKLE` step a fixed squad off with a `SquadSOP`,
  `setSOP`/`reroute` adjust a deployed squad, `startProject`, `requestResupply`,
  `approveFireRequest`/`denyFireRequest` gate the AI's call-for-fire, `medevac`), and queries
  (`inContact`, `nearestVillage`, …). It owns a single persistent `CombatSim`.
- **`types.ts`** — `WorldState`, `Task`, `Project`, `MissionType`, constants, and the shared `Ids`
  counters.
- **`create.ts`** — `createWorld(seed, days, terrain?)` and `loadWorld(blob)` factories, plus
  `createTerrain(seed)` (the terrain seam the loading screen builds as its own phase).
- **`director.ts`** — the enemy activity director (`runDirector`): heat drift + scheduled
  ambush / infiltration / harassment / complex-attack spawns, all routed through the terrain.
- **`tasks.ts`** — strategic task progression (`tickTasks`): muster → file out the gate → move to
  the objective as a squad → on-station security halt → return through the gate, yielding on contact
  to the squad-combat coordinator (`ai/squad-combat.ts`, below) and resuming on the lull.
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

## Combat AI (`lib/sim/ai/`)

The player commands **squads, never men**: combat is 100% AI. The command surface a squad carries
into a fight is its standing **`SquadSOP`** — three settings set before step-off and **locked once
in contact**: MOVEMENT (Stealth / Patrol / Fast), ON CONTACT (Hold & Return Fire / Suppress & Call
Fires / Assault / Break Contact), and ROE (Weapons Hold / Tight / Free). The mission type seeds
sensible defaults (`defaultSOP`).

- **`squad-combat.ts`** — the squad-combat coordinator (`squadFight`), the squad leader's brain,
  invoked from `tickTasks` on contact (so the decision lands the tick the men act on it). It reads
  the SOP and the tactical picture, then runs the doctrinal drill: react (everyone to cover, return
  fire per ROE) → designate a base-of-fire and a maneuver element → bound onto the objective
  (Assault), pin + raise a call-for-fire (Suppress), hold from cover (Hold), or leapfrog back to a
  rally (Break). A squad that becomes **combat-ineffective always breaks contact automatically** —
  the one drill the player can't override. It only *decides*: it stamps the per-man intent fields
  (`rof`, `roe`, order target, …) that `friendlyBrain` executes each tick.
- **`friendly.ts`** — `friendlyBrain` executes each US/ANA soldier (cover-seeking, return fire,
  buddy-aid, the per-man assault bound). A **civilian-fire gate** (`civClear`) checks ROE on every
  friendly shot: under Tight a soldier holds fire rather than risk a civilian in the kill zone (that
  restraint nudges village attitude up — a real COIN reward), while civilian casualties tank it.
- **`insurgent.ts`** / **`civilian.ts`** — the enemy state machine and the civilian routines.

**Fires and MEDEVAC are AI-requested, player-approved.** When suppressing or pinned, the squad's
JTAC/leader raises a call-for-fire (`World.state.fireRequest`: squad, reason, proposed grid); the
commander **approves** (`approveFireRequest` — rounds fly) or **denies** (`denyFireRequest`).
Likewise the AI surfaces a CASUALTY callout and the player calls the 9-line bird (`medevac`). The
player's only in-combat levers are: approve/deny fires, call MEDEVAC, and the SOP + route set
beforehand.

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

## Deploy / loading flow (`store.runDeploy`)

A deploy is several hundred ms — to seconds — of synchronous main-thread work (heightmap gen, the
4096² relief bake, the 164-sprite atlas). Done in one click handler it would freeze the UI with no
feedback, so `newCampaign` / `loadCampaign` / `startTutorial` route through `runDeploy`, which shows
a `"loading"` screen and stages the work into phases, **yielding to a real browser paint
(double-`requestAnimationFrame`) before each phase** so the loading screen — a phase checklist +
spinner + progress bar (`components/screens/LoadingScreen.tsx`, fed by `loadProgress` in the store)
— renders before anything blocks. Phases: `createTerrain` → `createWorld(seed, days, terrain)` (the
terrain seam lets it be one visible phase, built once, byte-identical) → `bakeTerrainProgressive`
(bakes the relief in yielding row-bands, reporting 0→1 so the bar fills *through* the multi-second
bake, into the **same `WeakMap` the live draw reads** — so the first deploy frame is a warm cache
hit, no first-frame freeze) → `loadSprites`. Deploy cost itself is unchanged; see
`docs/issues/011` for the bake-time follow-up and
`docs/progress/2026-06-06-deploy-loading-screen/` for the write-up.

## Rendering

The map is **two stacked canvases**: an opaque **WebGL2 terrain underlayer** (`lib/render/gl/`)
below a transparent **Canvas-2D layer** for contours, units, combat FX and HUD. The split is the
legibility firewall — everything graded/lit lives in GL; everything you *read* (contours, symbols,
reticles, callouts) is ungraded ink on the 2D layer above. `WorldView` constructs one `TerrainGL`
against the GL canvas; if WebGL2 is unavailable `TerrainGL.ok` is `false` and the 2D layer falls
back to the **alive 2D bake** (`topo.ts`) — the look survives, just flat-lit.

```
   visible <canvas>  (transparent Canvas-2D — contours, units, FX, callouts, HUD)   ← ungraded ink
   ──────────────────────────────────────────────────────────────────────────────
   visible <canvas>  (opaque WebGL2 — TerrainGL, OR the topo.ts 2D bake on .ok=false) ← lit/graded
```

### WebGL2 terrain (`lib/render/gl/`, the shipped path)

The terrain is **recomposed per-pixel from the sim's own arrays** — the landcover bake is one input
of several, not "the image." A two-pass HDR pipeline, driven entirely by the master clock through
`SkyState`/`AtmoState` uniforms (pure w.r.t. clock/weather/seed):

- **PASS A — terrain in LINEAR radiance → an RGBA16F HDR target** (RGBA8 contingency if a driver
  can't render half-float): per-landcover material recomposition from a deterministic CPU-baked PBR
  atlas (`material-atlas.ts`, hashed in `smoke.ts` so it is part of the seed contract) + detail-normal
  raking, baked horizon AO on the ambient term, live-sun cast shadows (the 56-step exponential-stride
  march into an R8 visibility map, rebaked on sun motion, with PCF penumbra), a flow-advected specular
  **dark-silt** river, single-scatter aerial perspective (zoom-scaled — full at strategic, ~12% by
  tactical) + in-fog god-rays, and wet-ground. A single `u_detailGain` zoom ramp (ppm 1.0→3.0)
  collapses all added high-frequency detail to **byte-faithful relief** at strategic zoom.
- **PASS B — threshold bloom** (half-res bright-pass + separable blur, GL canvas only).
- **PASS C — ACES (Narkowicz) tonemap + time-of-day grade + Bayer dither → sRGB** to the visible
  canvas.

`shaders.ts` holds the GLSL: a **bit-faithful `heightAt` prelude** (= `Terrain.elevAt`, the
contour-registration contract) and the lighting/material/shadow passes. `sky.ts` is the verified
solar model (δ=+21° Kunar) feeding `SkyState`; `atmosphere-model.ts` is the floor-field valley fog
(local-floor min-field + diurnal ramp + clock-driven cloud drift). The 2D fallback bake (`topo.ts`)
sizes the relief at `~4500/size` px-per-cell (8 px/cell → a 4096² sheet) and is cached in a `WeakMap`
keyed by `Terrain`.

**Contour lines are NEVER baked** — `drawContoursLive` redraws them every frame on the 2D layer as
sharp marching-squares **vectors** in screen space over only the visible cell window, with a
zoom-adaptive interval (10–200 m) and grid-downsampling to bound cost, so a contour line is razor-sharp
at any zoom (the "blurry contours on zoom" fix). On the GL path night/grade come from the tonemap pass;
on the 2D fallback night applies a low-light wash driven by `World.ambientLight()`.

> **Honest scope (shipped 2026-06-13).** The *terrain* got the full overhaul. World-dressing sprites
> got **grounding** — COP structures and vegetation cast sun-tracked shadows that track the live clock
> — but full per-sprite normal/AO **relight** (a deferred GBuffer pass), a continuous-extruded HESCO
> berm, and FX particles (movement dust, volumetric smoke) are **deferred backlog**: see
> `docs/issues/028`.

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
