# Terrain generation pass — 2026-06-04

This pass took the COP-generation issue catalog (`docs/issues/001–005`) plus the player-reported
"villagers wander into the wire" bug, fixed all of them with simple, verifiable architecture, then
pushed terrain coherence and the map's visuals to a new level. Everything below is a hard number from
a headless harness or the live game — per the project's "verify, don't assume" rule.

## What was wrong, and the fix (all verified)

| Problem | Before | After | How |
|---|---|---|---|
| **Villagers wander into the wire** | 4467 civ-ticks pinned on the HESCO | **0** | civ routine/spawn/flee snapped off the wire (`terrain.civSafePoint`) + `sim.civMoveTo` routes around it |
| 001 — gate egress on broken ground | 1/9 seeds BLOCK, ring 90% | **0/16 BLOCK, ring 98%** | 8-direction gate scoring (passable apron required) + benched ECP apron + found `gateOutside` |
| 002 — gate faces away from villages | 7/9 seeds >90° away | **0/16 >90°** | siting `aoScore` standoff term + gate aimed at the nearest-village bearing |
| 003 — interior assembly deadlock | `survey-9` 8/9 (boxed point man) | **9/9 at muster, patrol arrives** | yard-side garrison seats (`buildingSeat`) + A* assembly (`walkTo`) |
| 004 — buildings are passable | walk-through | **solid 16/16, 77–81% open, no strandings** | `Structure` impassable + seats/billets reseated + `walkTo` |
| 005 — thin gate seals at coarse scale | latent | **0/16 disconnected, guarded** | wide flat apron = clean coarse portal + `ensureGatePortal()` generation check |

Measure them yourself: `npx tsx scripts/copaudit.ts 16` (one harness for every issue above),
`npx tsx scripts/movement-diag.ts`, `npx tsx scripts/smoke.ts`, `npx tsx scripts/balance.ts 16 45`.

## The instructive failures (what the evidence taught)

- **The villager bug had no panic in it.** The audit sim has no gunfire, so civilians never flee — the
  4467 wire-pins were *calm* villagers ambling at routine waypoints placed across the wire. Fixing the
  generation of those waypoints (and routing around the wire) zeroed it.
- **Diagonal gates exposed a slope artifact.** `computeSlope` is a forward difference, so a *narrow
  diagonal* graded tread reads steep at its own edges (its `+x/+y` neighbour falls off onto natural
  ground). That's why only diagonal gates flipped to BLOCK — fixed by widening the apron and starting
  the downhill road past its far end.
- **One boxed-in soldier = whole-squad deadlock.** `survey-9` failed because the squad *navigator* was
  seated on the wall side of a barracks. Seating soldiers on the yard side fixed assembly across the board
  and, as a bonus, cut wall-blocked ticks far below the passable-building baseline.
- **A village "accessibility" siting term was tried and reverted.** A straight ray over a cliff ignores
  the draw that routes around it, so it scored good benches as bad and destabilised placements. Honest
  negative result; the nearest-village gate bearing carries issue 002 instead.

## Terrain coherence + reachability (orthogonal finding)

A fair, all-villages reachability harness (`scripts/reachability.ts`) surfaced a **pre-existing** truth:
only ~40% of villages are reached by a patrol inside a 1500 s window. This is **not a routing bug** —
`findPath` returns a valid route to ~every village (one genuine unreachable across the whole sample); the
"misses" are simply long cliff-detour routes (2–6× straight-line on this rugged 5 m terrain) that a
1500 s real-time window can't cover at patrol pace. With the game's time-warp they arrive.

To improve coherence anyway, every village now gets a **graded, terrain-following foot trail** down to the
valley road (`descendTrack`, the access-road switchback logic generalised), so the valley reads as a real
connected network and the worst-case patrols benefit (`korengal`'s far-side patrol went STUCK → arrives).

## Visuals

The terrain bake (`lib/render/topo.ts`) was rebuilt from a flat olive-grey relief into a field-guide map:

- **Two-light shaded relief** (NW key + soft SE fill) with a sky-ambient/occlusion term, higher contrast
  so the ridges feel tall.
- **Per-landcover procedural texture**: dappled forest/orchard canopy (with planted rows), patchwork
  cropland with contour furrows, grainy rock/scree speckle, flowing-water shimmer on the river.
- **Snow on the high crests**, a **saturation lift** so the valley reads vivid not muddy, and light
  **altitude/haze grading** for depth.

Before/after screenshots in this folder: `baseline-wide.png`, `baseline-cop.png` (before);
`after-valley.png`, `after-detail.png`, `after-cop.png` (after). Live game verified: 0 console errors,
`npm run build` ✓, `npx tsc --noEmit` ✓.
