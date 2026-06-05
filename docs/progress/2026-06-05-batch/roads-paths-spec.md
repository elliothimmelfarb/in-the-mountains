# Item 8 — Road & Path Network (implementation checklist)

Goal: remove the village→water troughs; add a realistic 4-tier network that interacts
with terrain, connects all villages, and shapes villager + soldier movement.

## Trough root cause
`carveRoadsAndTrails` (terrain.ts:1230-1239) calls `descendTrack(...Land.Trail, maxGrade=0.5)`
per village → `gradeTreadAt` benches `elev` 62% toward a grade line that descends to the
river floor → a dead-straight trench. The COP access road uses the SAME `descendTrack` with
`Land.Road` and is CORRECT — keep it.

## Tier scheme — add ONE Land class `Track = 24` (graded secondary)
Ladder (LAND_MOVE): **Road 1.00 > Track 0.96 > Trail 0.92 > Footbridge 0.85** >> open ground.
Tables to update (TS `Record<Land,…>` will fail compile until LAND_MOVE & COVER_CONCEAL get it):
- terrain.ts: `Land.Track = 24` (append, never renumber); `LAND_COUNT 24->25`;
  `LAND_MOVE[Track]=0.96`; `COVER_CONCEAL[Track]=[0.05,0.07]`.
- topo.ts `landColor`: `case Land.Track: return [128,116,96]`.
- WorldView.tsx `LAND_NAME`: `[Land.Track]:"Track"`.
- path.ts:255 roadCells test: add `|| l === Land.Track` (load-bearing — makes fast movement
  prefer the secondaries).
- decoration.ts:69 `isClearanceBlocker`: add `|| land === Land.Track`.
`passableCell` needs NO change (Track is gentle, not in any reject list).

## New helper `layPath(x0,y0,x1,y1,half,land,conform=0)` — the no-trench primitive
Stamp tier landcover along a line WITHOUT global benching: skip Hesco/Structure/Compound/
Wall/Road/Gravel; River->Footbridge; else set `land`. Elevation: `conform===0` -> don't touch
`elev` (trails); `conform<=0.25` -> lerp toward the cell's LOCAL 4-neighbour median (tracks).
Never toward `floorE` -> no trench.

## Rewrite `carveRoadsAndTrails`
1. MSR (Tier-1 Road) — keep the valley-floor loop verbatim.
2. Per-village spur (Track) — REPLACES troughs: trailhead at qalat edge -> nearest MSR cell;
   `route=findPath(head,tieIn,{roadBias:0.6})`; `layPath(route, Track, half=1, conform=0.2)`;
   `layPath(v->head, Track)`. DELETE terrain.ts:1234-1235 (descendTrack+stampTrail trough).
3. Village MST (Track) — complete graph over `this.villages` (seeded order), weight = straight
   dist; MST; each edge `findPath(...{roadBias:0.6})` then `layPath(Track)`.
4. Tier-3 trails — keep the cosmetic uphill spur but via `layPath(...Land.Trail, conform=0)`;
   optional short trail up nearest draw mouth.
5. Keep `gradeAccessRoad(rng)` (COP road, Land.Road) UNCHANGED, stamped last.
6. Keep `computeSlope()`. `ensureGatePortal()` still runs after — gate never walled.
Keep descendTrack/gradeTreadAt/gradeCorridor/stampTrail/stampLane intact (COP road uses them).

## AI hooks
- Soldiers: only the path.ts:255 line (fast/traveling/rush already set roadBias 0.72/0.6/0.25
  via formation.planFormation). No formation/tasks change.
- Villagers: helpers.ts `buildRoutine` — add 1-2 inter-village/bazaar waypoints (seeded
  `rng.chance(0.5)`, snapped via `civSafePoint`). civilian.ts calm branch routes with
  `roadBias:0.4`; flee branch stays roadBias 0.

## Verification (re-baseline; terrain reshapes)
- tsc (Record typing catches missing Track) + build.
- reachability.ts -> should IMPROVE (village MST). route-quality holds. copaudit HOLDS
  (vil-overlap=0, portal, egress unchanged — layPath never stamps Hesco/Compound). smoke
  landcover histogram now includes Track. balance stuck% no regression.
- NEW probes: `trough cells = 0`; `network-connected villages = 100%` (flood-fill over
  {Road,Track,Trail,Footbridge} from MSR reaches every village trailhead).
- Playwright: screenshot 2-3 villages — no trench, graded Track to MSR, faint goat trails.
