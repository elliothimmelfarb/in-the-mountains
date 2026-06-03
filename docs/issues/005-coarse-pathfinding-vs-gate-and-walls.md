# 005 — Coarse pathfinding vs. gate width: a thin opening in a thick wall can seal at 15 m resolution

**Severity:** Medium · **Confidence:** Medium · **Area:** pathfinding × COP wall/gate generation (`path.ts`, `buildCop`)

## Summary

The movement rebuild fixed A* tunnelling through the walled COP by (a) thickening the HESCO wall to
**≥3 cells** so a coarse node centred on it is genuinely impassable, and (b) charging a
**`BARRIER_PENALTY`** for any wall/cliff cells a coarse node still contains. This is correct and works
today — but it sets up a **latent fragility**: the gate is a single ~5-cell opening in a thick wall,
and the coarse pathfinder works at **15 m (3-cell) nodes**. Transit through the gate is only reliable
while the opening aligns with the grid well enough that a low-penalty coarse node connects inside ↔
outside. Push the wall thicker, the gate narrower, or the penalty higher, and the gate can seal *at
coarse resolution* even though it's wide open at full resolution.

It is not currently broken (verified: `findPath` from inside → `gateOutside` escapes from all 8
bearings on the tested seeds), but it's a sharp edge worth designing away before tuning these knobs.

## Background / how it bit during the rebuild

While tuning, intermediate settings (`BARRIER_PENALTY` 60 + a 2-cell wall, and various combinations)
produced exactly this: `findPath(muster, gateOutside)` returned the straight-line *fallback* (coarse
route `null`) for some seeds — the interior was coarse-disconnected from the exterior. The shipped
combination avoids it, but the failure mode is real and the margin is unknown.

## Root cause

- **`path.ts`**: coarse factor `COARSE = 3` (15 m nodes). `nodeCost` is passable if *any* subcell is,
  times `1 + BARRIER_PENALTY * blockFrac²`. A gate-area node that straddles the opening *and* a chunk
  of the thick wall has a high `blockFrac` → expensive; if the only connecting nodes become expensive
  enough (or fully wall → `Infinity`), the coarse graph pinches shut.
- **`buildCop`**: gate width is angular — `gateHalf = atan2(2.6, R)` (~5 cells at the wall) — in a wall
  band now `R-2.4 .. R+0.6` (≥3 cells thick). Neither the gate width nor its alignment is tied to the
  coarse grid, so whether a clean coarse node lands on the opening is luck of the seed.

## Suggested directions

- **Make the gate a guaranteed coarse portal.** Carve the gate opening at least one full coarse node
  (≥3 cells, ideally with a one-cell margin) wide *and* keep the gate's interior/exterior staging on
  passable, low-penalty ground, so a clean coarse node always sits on the opening regardless of seed
  alignment. A wider ECP is also more realistic for a vehicle gate.
- **Or special-case connectivity:** seed the coarse graph with an explicit passable link across the
  gate (a "portal" edge between the inside and outside gate nodes), so the gate is never at the mercy
  of node alignment. More machinery, but robust.
- **Add a generation-time assertion:** after `buildCop`, assert `findPath(muster, gateOutside)` returns
  a real (non-fallback) route; fail/re-roll the COP otherwise. Cheap insurance, and it would have caught
  the intermediate regressions instantly.
- **Generalize the lesson:** thin openings in thick barriers are unreliable at coarse resolution. The
  same risk applies to village compound entrances, footbridges over the river channel, and narrow draws
  between cliffs — worth a coarse-connectivity check anywhere generation creates a chokepoint.

## Related

- 001 (gate egress terrain), the movement report's "Bug 3" section
  (`docs/progress/2026-06-03-movement-report.html`).
