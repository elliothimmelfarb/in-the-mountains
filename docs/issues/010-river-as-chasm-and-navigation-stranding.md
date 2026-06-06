# 010 — The river was an impassable chasm; the planner stranded patrols (RESOLVED 2026-06-06)

**Severity: High.** The single largest source of soldiers and squads that could not reach an
objective, "got stuck on the river", or could not cross the valley. Found, fixed, and verified in
the 2026-06-06 navigation pass. This is a **navigation-realism** overhaul: the valley now reads and
moves like real terrain — a walkable floodplain flanking a real river that is crossed at fords and
footbridges — and the foot planner reliably routes the whole squad there and home.

## What was wrong

Turning the fuzzy complaint ("soldiers get stuck, can't cross the river, can't reach places") into
hard numbers with a new **fast static structural audit** (`scripts/terrain-audit.ts`, 40 seeds) was
decisive. The valley floor was structurally broken:

| metric (40 seeds) | before | meaning |
|---|---:|---|
| river bank-cliff fraction | **59%** | the river ran in a deeply-incised channel walled by cliffs |
| river "trap" cells | **5,296** | passable river cells with no dry escape — wade in, never climb out |
| crossings (ford/footbridge) | **0** | nothing to cross at; worst crossing gap **1,495 m** |
| seeds with the two banks SPLIT | **28%** | the valley literally could not be walked across |
| villages BFS-unreachable | **18%** | |
| router NULL routes to villages | **30%** | `findPath` gave up short of the objective |
| far reachable objectives missed by the router | **20%** | physically reachable, router gives up |

Root cause of the terrain half: the elevation generator carved a `riverCut` incision (~22 m deep,
~48 m wide) straight down the valley centerline, so the cells flanking the water classified as
`Cliff` (slope > 1.5) and the river channel itself fragmented into steep, impassable, disconnected
pieces. There were no fords or footbridges except the rare road crossing, and `passableCell` treated
the river as walkable everywhere — so a unit could wade *into* the chasm and then be walled in.

Root cause of the planner half (exposed once the floor was made walkable):

1. **Coarse plan cut the river optimistically.** A 15 m coarse A* node is "open if ANY 5 m subcell is
   passable", so a node straddling the channel (one dry bank cell) was merely *penalised*, not
   blocked — cheaper than detouring to a ford. The coarse line cut the channel where there was no
   crossing; the full-resolution pass (river truly impassable) could not follow it.
2. **Corridor confinement.** A cross-river route must often detour far up/down the valley to a ford,
   swinging well outside even the widest corridor radius, so the corridor-confined fine pass gave up
   short (`scripts/corridor-shortfall.ts`: 64/64 shortfalls were pure corridor confinement — a free
   unclipped A* reached every one).
3. **Objective snap to the wrong component.** `reachableObjective` snapped to the nearest *passable*
   cell, which could sit across a wall, the river, or a cliff in a **different** connected component
   (~16.9% of snaps) — halting the squad opposite a point it could never reach.
4. **Squad-level stranding** (whole-element, which the point-man-only harnesses never measured):
   on-station was declared the instant the *point man* arrived (element strung out behind him); the
   return file-in was keyed on the *centroid* so it never triggered while the lead was at the wire
   and the column trailed (the squad stood down **outside** the wire, 0/9 inside); and the altitude
   fatigue term accrued even on a flat track, pinning a long patrol at ~0.68× so far villages
   arrived only after the tactical window.

## How to reproduce (before the fix)

```
npx tsx scripts/terrain-audit.ts 40      # 59% bank-cliff, 5296 traps, 0 crossings, 28% banks SPLIT
npx tsx scripts/corridor-shortfall.ts 16 # CORRIDOR shortfalls: free A* reaches, findPath gives up
npx tsx scripts/squad-arrival.ts 6       # RETURN home 23–36%, cohesion not even measured before
```

## The fix

A realistic river + a planner that respects it, all gated at generation time:

- **Walkable floodplain** (`terrain.carveFloodplain`): bench a continuous, gentle floor around the
  meandering centerline, overriding the incision cliffs and the worst detail-noise spikes, leaving a
  shallow channel for the water. The floor is now walkable on **both** banks.
- **River is a real obstacle** (`passableCell`: `River` impassable) crossed **only** at a `Ford` (new
  landcover — a shallow gravel-bar crossing, `moveCost 0.5`, almost no cover: a killing ground) or a
  `Footbridge`. "Cross at the ford" is now a real tactical act.
- **Fords generated + guaranteed** (`placeFords` every ~260 m; `ensureRiverCrossings` adds a ford at
  any reach where the two banks are still in different components, until the valley is one piece).
- **River-aware coarse plan** (`path.ts`): a coarse node the channel runs through (≥3 river cells)
  with no crossing in it is impassable, so the global line routes through real crossings.
- **Free-A\* fallback** (`path.ts`): when every corridor fails, a free unclipped full-resolution A\*
  finds the genuine (often long, ford-detouring) route before settling for best-effort.
- **Component-aware objective snap** (`terrain.nearestReachable` + `reachableObjective`): snap to the
  nearest cell that is passable **and** in the gate's connected component — never the far bank.
- **Squad cohesion gate, lead-keyed return, exertion-gated altitude fatigue** (`tasks.ts`,
  `combat.ts`): set up on station only once the element has closed up; file back in keyed on the
  point man reaching the gate; altitude only drags when actually climbing.

## Resolution — verified

Static structural audit (`scripts/terrain-audit.ts`, 40 seeds), mover-faithful (anti-corner-cut)
ground truth, objectives snapped as in-game:

| metric | before | after |
|---|---:|---:|
| river bank-cliff fraction | 59% | **1%** |
| river trap cells | 5,296 | **0** |
| seeds with banks SPLIT | 28% | **0%** |
| villages BFS-unreachable | 18% | **1%** (genuine cliff-pocket sitings, reported honestly) |
| router NULL routes to villages | 30% | **0%** |
| far reachable objectives missed by router | 20% | **0%** |
| crossings present | 0 | ~70–140 / seed |

Whole-squad behaviour (`scripts/squad-arrival.ts`, combat-free, 6 seeds × nearest villages):

| metric | before | after |
|---|---:|---:|
| RETURN home (≥60% inside the wire) | 23–36% | **81%** |
| squad cohesion @ objective (whole element) | (unmeasured) | **94%** (88% of squads ≥70% closed up) |
| watchdog identical re-plans (thrash-probe) | up to 7/seed | **0** |

The remaining residual is a small number of genuinely cliff-pocketed COP sitings (the honest
ceiling of issue 008) whose far villages are long (real ~30 min) marches — now correctly *reached*,
just slow, rather than faked or stranded.

New/expanded harnesses from this pass: **`terrain-audit.ts`** (fast static structural audit),
**`squad-arrival.ts`** (whole-squad cohesion + return leg), plus the hunt probes
`corridor-shortfall.ts`, `snap-side.ts`, `return-audit.ts`, `thrash-probe.ts`, `follower-strand.ts`.
