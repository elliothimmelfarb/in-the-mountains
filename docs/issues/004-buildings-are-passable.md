# 004 — Interior buildings are passable (you can walk through the TOC)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-04) — mechanism current: `Land.Structure` returns impassable in `passableCell` (terrain.ts:2671) at HEAD.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity:** Low (fidelity) · **Confidence:** High (in code) · **Area:** terrain passability × COP structures

## Summary

`Land.Structure` (TOC, barracks, aid station, armory, chow hall, latrines) is **not** treated as
impassable. Units — soldiers, the garrison, anyone — can walk straight through buildings, and
pathfinding routes through them as if they were open ground. It's a realism gap, and it quietly
muddies movement debugging (units appear to be standing "on" or pathing "through" buildings).

## Evidence

`passableCell` (`lib/sim/terrain.ts`):

```ts
passableCell(cx, cy): boolean {
  if (!this.inBounds(cx, cy)) return false;
  const l = this.land[this.idx(cx, cy)] as Land;
  if (l === Land.Cliff) return false;
  if (l === Land.CompoundWall) return false;
  if (l === Land.Hesco) return false;          // the wire
  if (this.slope[this.idx(cx, cy)] > 1.25) return false;
  return true;                                  // <-- Land.Structure falls through to passable
}
```

`Land.Compound` (village qalat interiors) is likewise passable; only `CompoundWall` blocks. That's
arguably fine for villages (courtyards, alleys) but buildings reading as walk-through is not.

## Why it isn't already fixed / the catch

Making `Structure` impassable is a **one-line change with a blast radius**, which is why it's filed as
an issue rather than just done:

- The **garrison system** (`world/garrison.ts`) seats soldiers *at* buildings (barracks, TOC, aid).
  Those seat positions must move to building *doorways/edges*, or soldiers will be stranded on now-solid
  cells.
- **Structure placement** in `buildCop` (`stampRect`) would need to guarantee buildings don't seal off
  interior routes or the muster→gate lane (see issue 003), and don't overlap the (now thicker) wall.
- **Pathfinding** already penalizes blocked cells in a coarse node (issue 005), so a cluster of solid
  buildings would push routes around them — generally good, but interacts with the cramped interior.

## Suggested directions

- Make `Structure` impassable, **with**: (a) building footprints that leave clear interior lanes and a
  muster→gate corridor, (b) garrison seats relocated to building edges/doorways, (c) the assembly-phase
  A* fix from issue 003 so soldiers route around buildings to muster.
- Optionally model **doorways** (one passable cell per building) so buildings are enterable, if you ever
  want interior occupancy to matter.
- Decide intent for `Land.Compound`: keep village interiors passable (alleys) but consider a denser
  `CompoundWall` lattice so qalats read as the maze they are.

## Related

- 003 (assembly deadlock — gets more acute, and the A* assembly fix becomes mandatory, if buildings go solid).

## Resolution (2026-06-04)

`Land.Structure` is now impassable (`passableCell` in `lib/sim/terrain.ts`). The blast radius was
handled exactly as this issue anticipated:

- **(b) garrison seats relocated to building edges/doorways** — `terrain.buildingSeat` (yard-side, see 003),
  used by both `world/garrison.ts` and `world/create.ts` (billets).
- **(c) the assembly-phase A* fix** — `sim.walkTo` for assembly *and* garrison movement, so soldiers
  route around the now-solid b-huts instead of pinning on them (see 003).
- **(a) interior lanes stay clear** — the muster→gate axis is open ground (buildings sit behind/beside
  the centre), and the interior gravel lane is preserved.

Verified — `copaudit.ts`: **structures solid 16/16** (`solid? = Y`), interior still **77–81% open**.
`movement-diag.ts` blocked-ticks *dropped* vs. the passable-building baseline (the yard-side seats more
than paid for the solidity). `balance.ts`: no strandings, combat intact.
