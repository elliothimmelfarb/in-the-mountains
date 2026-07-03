# 033 — KOP generation rebuild (Wave 2b): the perfect circle is still a perfect circle

**Severity: Medium (fidelity — the single loudest "this looks fake" tell after the
2026-07-02 dressing pass). TOP follow-up of the realism campaign.** The Wave-2a/2b
render dressing (`5764134`) transformed how the COP *reads* — concertina, sandbag
parapets, camo nets, conex/tent skins, clutter, worn foot-lanes, road clipped at the
wire — but it dressed a shape that is still **generated as a parametric circle on a
flat bench**. Real KOPs (Junger *War*/*Vanity Fair*; *Restrepo*; *The Outpost*) are
terraced up a hillside over several hundred metres, structures cut into benches at
different elevations, HESCO runs kinked along the contour into a "lumpy amoeba," with
an ANA sub-compound hung off one side. This issue is the **generation-side rebuild**
that the dressing pass deliberately did not attempt.

## What still reads fake (evidence: `docs/progress/2026-07-02-realism-campaign/final/cop-FINAL.png`)

1. **Perfect-circle HESCO ring.** `buildCop` (`lib/sim/terrain.ts`) stamps the wall as
   a cos/sin circle of radius R=12 cells (~120 m) (`terrain.ts:~1007`, drawn `draw.ts:~419`).
   Dressing softened its edge (the wire fuzzes the outline) but the underlying ring is
   still geometrically round on every seed. Real perimeters follow the ground.
2. **Checkerboard yard.** The interior is a 55/45 Gravel/Grass class alternation that
   reads as a faint grid at operational zoom. Real yards are one continuous worn,
   compacted surface (dirt/gravel), not a two-tone lattice.
3. **Flat bench.** The pad is elevation-flattened. Real outposts terrace — the TOC,
   the LZ, the fighting positions, and the ANA side sit at **different cut elevations**
   connected by short ramps/steps.
4. **Radial parametric building fan.** Structures are placed at `(back,side)·R`
   fractions around the centre (`terrain.ts:~1089`). The result is evenly-radial, not
   the organic "built where the bench was" clustering of a real COP.
5. **No ANA sub-compound.** A real Korengal-era COP has a partitioned Afghan side.

## The rebuild (design directions — a Wave-2b generation campaign)

- **Terrain-conforming polygonal perimeter.** Replace the cos/sin ring with a polygon
  whose vertices sit on the local contour (walk the ~120 m offset, kink at slope
  breaks). Stamp the **`hesco-corner`** asset at the vertices (it is in the manifest,
  drawn nowhere yet — see below) and straight HESCO runs between them. Kinked, not round.
- **Terraced interior benches.** Cut 2–3 benches at stepped elevations; anchor
  structure clusters and the LZ to benches, connected by ramps. The bench-flatten
  already exists (`buildCop` pad); generalise it to *multiple* pads.
- **Continuous yard.** Replace the Gravel/Grass checkerboard with one worn-ground
  class (compacted dirt/gravel), optionally with worn-lane darkening where traffic
  concentrates (the render foot-lanes already hint this).
- **Organic building anchoring.** Place structures on the benches by fit, not by radial
  fraction — cluster the billets, put the TOC on the high bench, the LZ on a flat shelf.
- **ANA sub-compound.** A partitioned side compound (its own short wire run + a gate to
  the main yard).

## What is ALREADY fixed (verify before re-diagnosing)

- **Road-through-the-yard (K's diagnosis).** `5764134` noted the render residual
  (`carveRoadsAndTrails` stamps `Land.Road` AFTER `buildCop`, leaving ~7–9 Road cells
  inside the ring and an edge-to-edge tan band across the yard) and clipped it
  render-side. The **generation** residual is now ALSO fixed by `bd5cf77`: the MSR
  row-stamp excludes the COP disc (R+3) and routes around on the river side;
  `descendTrack` gained an avoid-disc so the access road slides around the perimeter
  verge instead of through the yard. Verified: **Road inside ring 0, verge 0, Hesco
  wall closed on all 360 bearings × 8 seeds**
  (`after/trails-2a/issue032-check-FINAL.txt`). Do NOT re-report this as open.

## Render-side items K flagged (smaller, can ship independently of the rebuild)

- **Blobby foot-lanes retune.** The worn muster→gate/LZ/chow/TOC/latrine lanes
  (`topo.ts`) read slightly blobby at some zooms; the A/B pixel-diff proved they are
  NOT the dark yard blobs (those are gen-side ground material, 0.01% of pixels), but
  the wash+tread pair wants a tighter falloff.
- **`dfac` dome sprite.** The mess/dfac currently borrows a GP-tent skin; a dedicated
  low dome sprite would read better than the reused tent.
- **`hesco-corner` asset is drawn nowhere** — it exists in the manifest specifically
  for the polygonal-perimeter vertices above; wiring it in is part of the rebuild.

## Repro recipe

1. `node scripts/cop-shot.mjs /tmp/cop.png` (drives the live app, port 9334) on the
   default `valley-2533` — the round ring + checkerboard yard are immediately visible.
2. Compare against `docs/progress/2026-07-02-realism-campaign/final/cop-FINAL.png`
   (dressed) and `baseline/cop-HEAD.png` (undressed) — the dressing delta is the
   render pass; the *shape* is unchanged between them, which is this issue.
3. `scripts/copaudit.ts` for the generation-side metrics (egress, ring continuity,
   FPF); a Wave-2b rebuild must hold `copaudit` green (egress 0 blocked, FPF firable).

## Relevant code

`lib/sim/terrain.ts` — `buildCop` (ring, gate, perimeter track, structure fan, pad),
`placeVillagesAndCOP` (siting). `lib/render/draw.ts` `drawCop` (the dressing).
`lib/render/topo.ts` (foot-lanes, path clipping). `lib/render/asset-manifest.generated.ts`
(the `hesco-corner`/`bld-conex`/`bld-tent` assets — regenerate via
`node scripts/build-asset-manifest.mjs`, do not hand-edit).

**DO-NOT-RE-TRY carried in:** shrinking COP colliders for "stuck on buildings" (issue
012 — cause was garrison placement, not colliders); COP HVT dispersion / threat-weighted
guns (issue 022 — +1.00/+0.50 KIA). A polygonal perimeter must not reintroduce sealed
pockets (`copaudit` egress + `terrain-audit` banksSplit are the guards).
