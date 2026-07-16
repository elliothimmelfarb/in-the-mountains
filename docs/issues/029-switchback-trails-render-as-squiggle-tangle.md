# 029 — Switchback / goat trails render as a squiggle-over-squiggle tangle

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-13) — mechanism current: generation visited-cell guard + net-climb gate in `ascendTrail`/`lateralTrail` (terrain.ts) + render `cleanPath`/per-kind occupancy-merge in `drawPathsLive` (topo.ts); self-overlap polylines 10→0.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Status:** ✅ RESOLVED 2026-06-13 · **Found:** owner report, 2026-06-13 · **Severity:** Medium (visual fidelity)

## What the owner saw

> "The paths and switchbacks simply don't look realistic and in some cases are two or more lines
> that squigalize over each other."

The COP-to-village roads and the foot-trails climbing the spurs read as a tangle of doubled,
overlapping lines instead of clean dirt tracks and legible zig-zag switchbacks.

## Mechanism (confirmed with a probe, not vibes)

A headless probe (`scratch-trail-probe.ts` / `scratch-trail-geom.ts`, since deleted) dumped
`terrain.trailLines` and measured self- and cross-overlap. Two distinct defects:

1. **Self-stacking switchbacks (the dominant "squiggle over squiggle").** The climbing-trail walkers
   `ascendTrail` / `lateralTrail` in `terrain.ts` snap every step to a 5 m cell center, dedup only the
   *immediately-previous* cell, and — when boxed against a cliff band — recover via a hairpin
   (`side = -side`) PLUS a slightly-downhill candidate (`tries` ended with `-0.12`). Combined, a boxed
   walker bounced downhill→sideways→back among a small cluster of passable cells, gaining no height,
   for up to `stall > 36` steps. Result: **10 of ~24 trail polylines had 25–95 % of their vertices
   retracing a non-adjacent leg, at a median 0.0 m** — the polyline was a knot-in-place. Stroked as a
   casing+tread, that knot reads as many lines squiggling over each other.

2. **Braided trail fans.** Each trailhead radiates a 3-sector fan (up-/down-valley/abeam) plus a goat
   trail; where a village can only climb in one direction the fan collapses and 3+ trails retrace the
   same lower stem (probe: **6 trails packed into one 180 × 120 m knot** above a village).

## Fix

**Generation (`terrain.ts`, `ascendTrail` + `lateralTrail`) — pure cosmetic, determinism-safe.**
Trails are laid as conform-0 landcover (no elevation edit), so changing the captured polyline only
changes which cells get the `Land.Trail` *tint* — the passable graph is bit-identical. Changes:
- **Visited-cell guard:** a step onto a cell already on the line is rejected, so the trail makes
  genuine new ground or terminates — it never folds back over itself.
- **Dropped the downhill `-0.12` candidate** (a climbing trail never steps downhill — it was the
  engine of the shuffle) and **tightened the stall break** 36 → 12 steps.
- **Net-climb gate:** a trail that gained < 24 m of height (a shuffle-in-place, not a path) lays
  nothing, exactly like the existing too-short guard.

**Render (`lib/render/topo.ts`, `drawPathsLive`) — belt-and-braces, zero sim impact.**
- `cleanPath()`: de-stacks any residual 0 m retrace + prunes near-collinear vertices (cached per
  polyline — costs nothing per frame).
- **World-cell occupancy merge per kind:** a braided stem whose cells an earlier equal-kind trail
  already drew is skipped, so the shared corridor strokes ONCE while the fan still splays where the
  trails diverge. World-anchored so it never flickers on pan.

## Before → after (probe, three seeds)

| Metric | Before | After |
|---|---|---|
| Trail polylines with ≥25 % self-overlap | **10** | **0** |
| Switchback nearest-non-adjacent-leg distance (median) | **0.0 m** | n/a (no stacking) |
| `visual-baseline` trail polylines / total vertices | 23 / 1614 | 16 / 664 |

`tsc` clean · `eslint lib/render/topo.ts lib/sim/terrain.ts` no new errors · `smoke.ts` SMOKE OK
(serialize round-trip + no-NaN, i.e. determinism preserved) · `npm run build` green ·
`reachability.ts` **28/44 (64%) — identical to the documented HEAD baseline** (issue 027), confirming
the trail-geometry change is purely cosmetic and did not touch routing. Before/after crops in
`docs/progress/2026-06-13-trail-render/`.

## Residual deliberately not changed

A genuine switchback to a high shoulder still hairpins tightly — the legs come close at the turn
(that's a real switchback, not a defect). The render occupancy merge keeps it legible; pushing the
trailhead fan to splay HARDER (so two villages don't both climb the same face) is a generation
topology change left for a future pass, tracked here.
