# 003 — Squad can't assemble/egress: members deadlock in the COP interior

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-04) — mechanism current: A* assembly `sim.walkTo` (combat.ts:1825) + yard-side `buildingSeat` (terrain.ts:3774) live. (COP-egress `Structure` grind residual now tracked in 036(b).)
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity:** Medium · **Confidence:** Medium (one synthetic seed) · **Area:** COP interior layout × assembly/movement (interplay)

## Summary

On `survey-9`, roughly half the squad never leaves the COP. They start at their garrison posts among
the interior buildings (r ≈ 50 m from center, on `Structure` cells), and during the **assembling**
phase they fail to reach the muster yard and then fail to file out — they mill/deadlock among the
structures while the rest of the squad patrols to the village without them.

This is the weakest "generation" issue in the catalog because it's **partly a movement/assembly
problem**, not purely terrain. But it manifests as a property of the generated interior, so it belongs
here for the terrain pass to consider.

## Evidence

`npx tsx scripts/movement-diag.ts` → `survey-9` shows ~15k wall/structure-blocked ticks, almost all
**inside** the wire on `Structure` cells, and the task never reaches on-station. A per-member trace
shows ~5 members pinned at r ≈ 50–68 m for the whole run with low speed and a path that never gets
them out the gate.

Important context that argues this is *not* mainly interior crowding: an audit shows the interior is
**78–81% open** (non-structure, passable) on *every* seed, including the ones that work perfectly. So
`survey-9` isn't uniquely cramped — its specific gate angle + structure arrangement + where members
start creates a local steering/assembly trap that the other seeds don't.

## Root cause (hypothesis)

Two contributing factors:

1. **Assembly uses straight-line `moveTo`, not pathfinding.** In `tickTasks` (`world/tasks.ts`,
   `assembling` phase) each member does `w.sim.moveTo(m, jitter(muster))` — a straight line that the
   integrator re-issues when blocked. Among a cluster of buildings, the straight line + the
   re-issue + body separation can loop without ever routing *around* a building to the muster point.
   A member that needs to navigate around two buildings to reach muster has no route to do so.
2. **Members start at garrison posts spread through the interior** (the garrison system seats off-task
   soldiers at the wall, the barracks, etc.). For an awkward gate angle, some posts are on the far side
   of the interior from the gate, behind structures, so the egress file never collects them.

Generation's contribution: the placement of structures + the muster point relative to the gate can box
in some garrison posts. (`buildCop` places structures at fixed back/side offsets from the gate; muster
is `R*0.4` along the gate axis.)

## Suggested directions

- **Movement side (most likely the real fix):** during `assembling`, route members to muster with A*
  (`pathTo`) rather than straight-line `moveTo`, at least when a straight step is blocked. Cheap (~9
  members, one-off), and it dissolves the deadlock by letting them navigate around buildings.
- **Generation side:** keep a clear, structure-free **assembly lane** from the muster yard to the
  gate, and ensure muster sits in open ground with an unobstructed path to every garrison post (or
  seat patrol members near the muster yard when a patrol is forming).
- Add an assembly check to `movement-diag.ts` (does every member reach the muster yard within the
  assembling timer?) so this is caught directly rather than via the downstream "never arrives."

## Related

- 004 (buildings are passable — units phase through them today, which masks/changes this behavior; if
  buildings become solid this issue's framing changes and the A* assembly fix becomes mandatory).

## Resolution (2026-06-04)

Both contributing factors were fixed (and, as predicted, the A* fix became mandatory once buildings
went solid — see 004):

- **Garrison seats moved to building YARD-side doorways.** `terrain.buildingSeat` steps off each
  footprint toward the COP centre before snapping passable, so no soldier is ever boxed between a
  building and the wall. On `survey-9` the squad *navigator* had been seated on the wall side of a
  barracks and could never reach muster — that single boxed-in point man was the whole deadlock.
- **Assembly routes with A*.** `world/tasks.ts` (assembling) and `world/garrison.ts` now call a new
  `sim.walkTo` (straight when the line is clear, else `findPath`) instead of straight `moveTo`, so
  members thread around now-solid buildings to the muster yard.

Verified — `survey-9` now assembles **9/9 at the muster yard** within the timer and the patrol reaches
its objective; wall/structure-blocked ticks across the diag seeds fell sharply (e.g. `korengal`
8518 → 311, `valley-3` 8937 → ~400). `scripts/balance.ts`: no elements stranded.
