# 001 — Gate / immediate egress sited on impassable or broken ground

**Severity:** High · **Confidence:** High (reproduced) · **Area:** COP generation (`buildCop`, `placeVillagesAndCOP`)

## Summary

The COP gate direction and the staging point just outside it (`gateOutside`) are chosen **without
checking that the ground there is actually passable.** On some seeds the gate faces a cliff/steep
slope, so the staging point a patrol files out to sits on an impassable cell, and the benched
perimeter track — which skips cliff cells — has gaps right where the squad needs to round the wire.

This is the root cause behind two of the worst movement cases: a patrol that egresses into broken
ground and a "ring road" that doesn't actually ring.

## Evidence (current state, 2026-06-03, 10 seeds)

```
seed         gateOutside   perimeter-ring open   nearest village
ridge-11     BLOCK         83%                   127 m
survey-2     PASS          76%                   332 m   (patrol "sets up short" 267 m out)
smoke-test   PASS          83%
delta-5      PASS          82%
korengal     PASS          100%                  227 m   (clean)
```

- **`ridge-11`: `gateOutside` is on an impassable cell.** The point man's exit staging target is
  unreachable; egress relies on the integrator's wall-slide and the perimeter track to recover.
- **Perimeter ring is 76–88% open on several seeds** — i.e. 12–24% of the bearings around the wall
  have *no* passable cell in the `R+1..R+5` band (cliff/steep terrain the benched track had to skip).
  Where the gap falls on the short way around to the objective, the squad must take the long way or
  stalls. `survey-2`'s patrol reaches only 267 m of a 332 m objective before the route-progress
  backstop fires.

Reproduce: `npx tsx scripts/movement-diag.ts` (watch `survey-2`), and a COP audit over `terrain.cop`
checking `passableCell(gateOutside)` and scanning `R+1..R+5` for each bearing.

## Root cause

`buildCop` (`lib/sim/terrain.ts`):

```ts
const roadX = this.centerXAt(c.cy);
let gd: Vec2 = { x: roadX - c.cx, y: 1 };            // toward the valley road, downhill bias
const ga = Math.round(angle(gd) / (Math.PI / 4)) * (Math.PI / 4);  // snap to 8 compass dirs
const gateDir = fromAngle(ga);
...
gateOutside: { cx: Math.round(c.cx + gateDir.x * (R + 4)), cy: Math.round(c.cy + gateDir.y * (R + 4)) },
```

The gate direction is purely "toward the valley road x, biased downhill," snapped to 8 directions. It
**never checks** that `gateOutside`, or the apron between the wall and the natural slope, is passable.
On a spur whose downhill/road side happens to be a cliff face, the gate opens onto nothing.

`placeVillagesAndCOP` rejects `slope > 0.35` at the COP *center* cell but does not evaluate the slope
profile around the perimeter or in the gate direction, so a site can be flat at the center and cliffed
on one side.

The benched perimeter track (also in `buildCop`) intentionally skips `Cliff/CompoundWall/Structure`
cells, so it cannot bridge a genuinely cliffed arc — correct behavior, but it means the ring is only
as continuous as the site allows.

## Suggested directions

- **Score gate directions, don't just compute one.** Evaluate all 8 compass directions and pick the
  one that (a) has a passable, low-slope apron out to `R+5`, (b) faces toward the road/valley, and
  ideally (c) faces toward the village cluster (see issue 002). Fall back to the most-open direction.
- **Make `gateOutside` a *found* passable point**, not a fixed `R+4` along the gate axis (e.g.
  `nearestPassable` along the gate ray, or the first passable cell on the perimeter track in the gate
  direction).
- **Validate the site at placement time.** Add a term to `placeVillagesAndCOP`'s score for "fraction
  of the perimeter that is benchable/passable" and for "gate direction has a clean run to the valley,"
  so genuinely cliff-ringed knobs lose to better-shaped benches.
- **Guarantee at least one continuous passable arc** from the gate to each cardinal side (so there is
  always a way around the wire in at least one direction).

## Related

- 002 (gate bearing vs villages), 003 (interior assembly), 005 (coarse pathfinding at the gate).

## Resolution (2026-06-04)

Fixed in `lib/sim/terrain.ts`:

- **The 8 gate directions are now scored, not computed.** `buildCop` evaluates all 8 compass
  headings on the raw ground and requires a passable, gentle apron out to `R+7` as a hard term
  (`apron`), so the gate can never open onto a cliff. (It also folds in AO/road bearing — see 002.)
- **A benched ECP apron** (`stampGateApron`, ≥7 cells wide, `R-3..R+8`, graded flat) guarantees the
  gate and its immediate egress are walkable regardless of how the downhill road later falls — the
  root cause was the access road *re-steepening the gate cell* after `buildCop` had validated it, which
  showed up only on diagonal gates (a narrow diagonal tread reads steep at its edges under the
  forward-difference slope). The downhill `descendTrack` now starts at the apron's **far end**.
- **`gateOutside` is the far end of that flat apron** (a found passable cell ≈`R+5`), not a fixed `R+4`.
- A **`perimeterBenchFrac`** term in `placeVillagesAndCOP` rewards benches whose wire can be fully
  ringed, so the ring road is continuous.

Verified — `npx tsx scripts/copaudit.ts 16`: **egress blocked 0/16** (was `ridge-11` BLOCK), **perimeter
ring open 98%** avg (was 90%). `scripts/smoke.ts`: gate passable, wall sealed.
