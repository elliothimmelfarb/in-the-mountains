# Item 2 — Movement Stranding: Root-Cause Diagnosis
(from the diagnosis agent; 26% live-reached vs 64% BFS-reachable = a 38-pt execution gap)

## RC#1 — findPath best-effort path-explosion (dominant execution bug, ~29% of misses)
path.ts:142-159 findPath + 329-351 best-effort fallback, via formation.ts:108 steerSquad.
When re-pathing from a position whose direct corridor is blocked by a terrain band, the
bestEffort=true branch returns a valley-circling route ~10x too long (3331m for a 329m goal)
that is partially UNWALKABLE (clips impassable cells). Route length is discontinuous in start
pos (3331m at navPos, 17m just 15m away). Fires at the `exited`->formation switch
(tasks.ts:143-161). route-quality.ts missed it: from COP center the route gives up SHORT
(scores as healthy ratio 1.26).
FIX: in the fallback (path.ts:155-158), reject routes that exceed ~3x coarse-route length OR
clip impassable cells (walkable check); instead return path to nearest reachable cell that
reduces straight-line dist to goal. Widen final best-effort corridor. Only the blocked/fallback
path changes; the clear-corridor case is untouched.

## RC#2 — pace-governor crawl (~20% of misses; slow mislabeled as stuck)
formation.ts:133-157 (paceScale = 1 - 0.8*slow) eases point man to 0.2x when rear man lag >
spacing*1.6. Long winding detours keep the file strung out -> throttled. Arrivals p50=1135s,
p90=2480s for ~350m objectives; 9/39 reachable villages arrive only after 1500s (survey-9
arrives 1211s but movement-diag/reachability time out -> "STUCK").
FIX: raise the pace floor (1 - 0.4*slow, floor ~0.6) and/or stop far-back-but-not-blocked men
dragging pace. Combat already overrides paceScale to 1 (friendly.ts:68).

## RC#3 — terrain-gen seals gate into a pocket (~49% of misses) == ITEM 1
terrain.ts:783-851 ensureGatePortal only checks connectivity in a radius+12 window (815) and
won't carve through Compound/Wall/Structure (844). COP next to a qalat or cliff -> gate opens
into a sealed pocket. BFS reachable% from gateOutside: survey-2 0.2%, survey-5 1.9%, survey-9
7.3% vs korengal 53%. copaudit: survey-7 vilGap=-33m (COP/village OVERLAP), portal N on 3/9.
FIX: (a) remove the radius+12 window cap so the flood verifies the gate connects to the OPEN
VALLEY; (b) on persistent failure relocate the COP/gate axis; (c) reject COP placements where
vilGap < clearance or vil-overlap > 0 at generation time (== item 1).

## Breakdown of 45 missed villages: ~22 (49%) RC#3 unreachable; ~13 (29%) RC#1; ~9 (20%) RC#2.

## Secondary
- route-quality.ts blind to give-up-short routes: also assert dist(end,goal)<ARRIVE + walkable
  per segment, and sample starts partway along blocked approaches.
- reachability/movement-diag windows conflate slow with stuck: longer window + "arrived-slow".
- steerSquad re-paths when goal moves >8m (formation.ts:107); reachableObjective jitter
  (tasks.ts:131) can force a fresh explosive re-path. Minor; amplifies RC#1.
