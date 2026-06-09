# 007 — Terrain ecology is render-deep, not sim-deep (aspect, terraces, qalats)

**Severity:** Low (fidelity) · **Confidence:** High (in code) · **Area:** `terrain.ts` land classification × visuals · **Status:** OPEN (future fidelity pass)

## Summary

The 2026-06-04 pass made the map *look* far more alive — aspect-ish shading, per-landcover texture, snow,
forest/cropland variety — but all of that lives in the **render bake** (`render/topo.ts`), not in the
**simulation's land classification** (`terrain.ts classifyLand`). The ecology a unit actually moves and
fights through is still the older moisture+slope model. Pulling the realism down into the sim would make
cover/concealment and movement read truer, at the cost of re-validating combat balance.

## Evidence

- `classifyLand` chooses landcover from `moist` (value noise) + `slope` + height band. There is **no
  aspect term** — north- and south-facing slopes get the same vegetation, though in reality the shaded
  (here, north/pole-facing) slopes hold moisture and forest while sun-facing slopes are dry scrub.
- **Terraces** are individual `slope>0.22 && <0.6` cells with the occasional `TerraceWall` riser — not the
  stacked, contour-parallel benches a real terraced hillside is.
- **Qalats** are a filled disc of `Compound` with a one-cell `CompoundWall` ring — not the dense
  wall-lattice maze of courtyards and alleys an Afghan village actually is.
- No hydrology: draws are placed by `rng`, not by where water would actually collect (flow accumulation),
  so the drainage network is plausible-but-arbitrary.

## Why it wasn't done in this pass

Each of these changes `slope`/`cover`/`conceal`/`passability`, which feeds **combat balance** and
**pathfinding** — both deliberately tuned (see CLAUDE.md / git history). Doing them safely needs a
baseline-then-remeasure loop (`scripts/balance.ts`, `scripts/movement-diag.ts`, `scripts/copaudit.ts`)
that wasn't in scope once the catalogued issues + the wire bug + visuals were done. Filed so it's a
deliberate, measured pass rather than an unverified slip-in.

## Suggested directions

- **Aspect-driven vegetation:** add an aspect term to `classifyLand` (forest/orchard on shaded faces,
  scrub/grass on sun-facing); fold a treeline into the height band. Re-derive cover/conceal, re-run
  balance.
- **Contour terraces:** near villages on moderate slopes, stamp stacked contour-parallel benches with
  `TerraceWall` risers (linear hard cover that matters tactically) instead of scattered cells.
- **Denser qalats:** a `CompoundWall` lattice (courtyards + alley gaps) so a village reads — and fights —
  as the maze it is; keep alleys passable.
- **Light hydrology:** a flow-accumulation pass to place the river + washes where water collects, so the
  drainage network (and the enemy's covered approaches) is physically motivated.
- Mirror each sim change in the render so the look and the simulation agree.

## Related

- 006 (reducing cliff fragmentation overlaps with the hydrology/aspect work), the render bake added this pass.

## Resolution — FOOTPATHS shipped 2026-06-09 (commit 359ce27); deeper ecology still open

The 2026-06-09 terrain-realism campaign took the **footpath** slice of this issue (the owner asked for
"more footpaths that mold to the terrain"). Added `layTrailNetwork`/`ascendTrail`: switchback foot-trails
that climb the spurs from every reachable trailhead toward an OP shoulder, surface-laid (no benched
trench — a benched version cut impassable trenches and was caught + fixed via a trail render), staying on
passable ground. Also captured **every** path centerline (MSR, tracks, access road, descents, goat trails,
climbing trails) into `terrain.trailLines` so the renderer strokes them as scaled lines that mold to the
ground (commit 96793c2), instead of the old invisible 5-m landcover tint. Measured (`footpath-probe.ts`):
trail cells 492→760, distinct paths/seed ~6→22-32, trail mean grade 0.57→0.54; reach% unchanged, balance
clean, deterministic. See `docs/progress/2026-06-09-terrain-realism/`.

**Still OPEN** (the deeper sim-ecology this issue is really about): aspect-driven vegetation, stacked
contour terraces, denser qalat wall-lattices, and **flow-accumulation hydrology** (river/washes placed
where water actually collects). Those reshape slope/cover/passability and want their own measured,
balance-revalidated pass — deliberately not slipped in here.
