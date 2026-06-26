# 012 — A squad gets stuck on buildings in the COP (RESOLVED — 2026-06-06)

**Severity: High (movement correctness / immersion).** Reported on seed `valley-2533`:
"one squad is getting stuck on buildings in the COP." It looked like a movement bug; it was
a **terrain-generation** bug, and `copaudit` had a **metric blind spot** that hid it.

## What was actually wrong (measured, not guessed)

`buildCop` placed **8 buildings at fixed positions with no guaranteed street between them**, and
the COP wire is always small (R ≈ 17 cells / 85 m). Their `Land.Structure` footprints **touched and
sealed off interior pockets**, and — because all billets were placed at positive `back` (away from a
gate that can face any direction) — they **piled into one rear corner**. The result: garrison posts
(building seats, fighting positions) that a man literally **could not path to**, and orphan courtyards
he could be funnelled into. He ground the wall: `walkTo` hands him a path that grazes a building, the
stall watchdog drops it after 2 s, garrison re-issues the same path — forever.

The existing `copaudit` measured interior **open%** (~80 %, looked healthy) but **never checked whether
that open space was connected** — so a broken COP passed the audit. New harnesses turned it into hard
numbers:

| seed | unreachable posts (seat+FP) | building-grind ticks / 600 s |
|---|---:|---:|
| `valley-2533` | 5 (Armory, Barracks A, Latrines + 2 FPs) | **1169** |
| `survey-44` (split-yard) | 7 seats + 3 FPs | **12808** |
| **sweep** | **21 / 30 seeds had an unreachable post** | 23 / 30 over 50 |

Diagnostics: `scripts/copstuck.ts` (per-squad / per-building grind), `scripts/copinterior.ts`
(authoritative `findPath` reachability of every post + pocket/fragmentation), `scripts/cop-render.ts`
(top-down render — sealed pockets in red).

**Two oracle subtleties that mattered.** (1) `reachableFromGate()` is 8-connected and *permits*
corner-cuts, so it marks a berm-edge cell "reachable" the anti-corner-cut planner can't actually walk
to. (2) `findPath` returns a **degenerate single-waypoint fallback** (`[goal]`, straight through a
wall) for an unreachable goal — its endpoint *is* the goal, so a naive `endDist < 2 cells` check reads
it as "arrived." Both fooled early measurements. The authoritative oracle is an **anti-corner-cut
flood from the muster** (== what the planner can truly walk), and the audit's `findPath` check now
rejects the degenerate path (`r.length > 1 || walkable(...)`).

## The fix (`lib/sim/terrain.ts`, `lib/sim/world/garrison.ts`)

Modelled on the existing `ensureGatePortal` generation-time guard. All deterministic — integer cell
math, fixed iteration order, **zero RNG** — so replays stay bit-identical.

1. **Re-spaced layout** — TOC central-rear, chow hall fronting the yard, two slim billet rows pushed
   wide apart, latrines rearmost, distributed across bearings (not piled in one corner).
2. **`spaceCopBuildings()`** — a deterministic min-gap relaxation: separates any pair closer than 2
   cells along the axis *closest to clearing* (gap = max of x/y separation, so clearing either axis
   suffices — works for any bearing), clamps every footprint inside R−3, shrinks a low-priority one as
   a last resort. Guarantees a ≥ 10 m walkable street between all buildings.
3. **`ensureInteriorConnectivity()`** (runs LAST in `generate()`, after the gate/river/network guards,
   so its checks see the final terrain): floods the interior from the muster (anti-corner-cut),
   enumerates the unreachable passable components, and carves a **widening benched Gravel lane**
   (`carveInteriorDoor`, half-width 0→2) from each large-or-post-holding component to the nearest
   already-reachable cell **until the whole interior is one walkable yard**. Then relocates any
   fighting position not in the flood inward to reachable berm (the MG gunner spawns on `fps[0/1]`), and
   seals only *small* (< 9-cell) post-free orphan slivers as `Structure`. Carving never touches the
   HESCO wire / compounds and stays inside R−3 (the perimeter — and infiltration / coarse-transit
   behaviour — is unchanged).
4. **Garrison belt-and-suspenders** — a man wedged (moving but not advancing) far from his post accrues
   `postStuck`; past 4 s he is escalated from the cheap `walkTo` to a full `findPath`, so he routes
   around a tight interior instead of grinding. Fires only for a genuinely stuck man, so no per-tick
   A* on open ground (issue 010 stall not reintroduced).

## Results (after, same harnesses)

| metric | before | after |
|---|---:|---:|
| seeds with an unreachable post (60-seed sweep) | ~42 / 60 | **0 / 60** |
| fresh-seed correctness sweep (`adv-0..199`) | — | **0 / 200** |
| `valley-2533` building-grind / 600 s | 1169 | **26** |
| `survey-44` (split-yard) grind / 600 s | 12808 | **26** |
| min building gap | 0 m (touching) | **≥ 10 m** |
| worst single garrison man stuck | 561 s (whole sim) | none (transient only) |

Standing checks all green: `tsc` ✓ · `build` ✓ · `smoke` ✓ · `balance` (12 runs, 0 civ-cas, no
stranded — identical to baseline) ✓ · determinism bit-identical (terrain + 300 s full-sim) ✓ ·
`copaudit` egress/ring%/portal/village-separation/`solid?` **unchanged**, interior open% +1 %.
Live (`window.__ITM` + Playwright, `valley-2533`): 35/35 men inside the wire, **0 grinding** at 90 s.

`copaudit` now carries the connectivity invariant (`seatBad`/`pockets` columns + "seeds with an
unreachable garrison post: 0/N") so the blind spot can never silently hide this again.

## Known limitation (honest)

Two of 60 seeds (`survey-7` 56, `survey-52` 72) show low, **distributed** grind (≈ 0.01–0.02 men, no
single stuck soldier) — a man brushing a building corner while milling, not a trapped man. On a
genuinely split site (`survey-44`) the guard carves a graded street through the internal rise (≈ 60
benched cells) to connect the yard — realistic, but more carved ground than a flat site needs.

## Reproduce

```
npx tsx scripts/copinterior.ts 60     # authoritative: 0 unreachable posts, grind per seed
npx tsx scripts/copstuck.ts valley-2533 600   # per-squad / per-building grind breakdown
npx tsx scripts/cop-render.ts valley-2533 out.png   # top-down: sealed pockets in red
npx tsx scripts/copaudit.ts 30        # standing audit (now incl. the connectivity invariant)
```

---

## Follow-up (2026-06-27) — the SECOND half: garrison CROWDING, not reachability

**Player report:** *"soldiers getting stuck on COP buildings, perhaps too close together — maybe shrink
the collider boxes."* Re-raised after this issue was closed. The connectivity fix above (reachability)
**still holds** — but it was only half the story, and the proposed cause (collider footprints) was the
wrong lever.

**What was NOT wrong (measured, not guessed).** `scripts/scratch-cop-footprint.ts`: across seeds, **0
solid-on-solid footprint overlaps** (the negative `minGap` `copinterior` prints is the *passable* Motor
Pool clipping the Chow Hall — cosmetic), every building's walkable **apron is 80–100% open**, and
`copinterior` reports **0/40 unreachable seats/pockets**. No building boxes anyone in; no man is
trapped (`copstuck` worst-offender `maxRun ≤ 1 s`, men move 25–60 m net). Shrinking colliders would
have fixed nothing.

**What WAS wrong — placement, not terrain.** After the COP shrank R≈17→**R=12** (issue 014), garrison
life was still modelled as *jit-onto-a-point* for whole groups (`garrison.ts`): the entire off-duty/
sleeping pool was assigned to **one of two barracks** (`jit 5–9`), 20 men piled at the **chow hall**
at meals, and the work **detail's wire bearing was `hashId(id) % 360`** — and because consecutive
member ids hash to consecutive values, all 11 detail men landed in a **16° arc** of the wire. Result:
~13 men stacked on the barracks footprints + a wire clump = the "stuck on buildings, too close
together" the player saw. New metric `scratch-cop-men.ts` (settled-garrison render + `BUNCH(<3 m)`
count): **BUNCH 21–24 / 41** — over half the platoon shoulder-to-shoulder.

**The fix (`lib/sim/world/garrison.ts`, placement only — terrain gen byte-identical).** Spread every
gathering group by an **even ordinal**, the same idea three times:
- **off-duty / rest** → `yardSpot()`: a golden-angle (phyllotaxis) lattice keyed to platoon index, so
  men fan evenly across the whole yard (night biased to the rear billets). Any subset stays spread.
- **work detail** → wire bearing by **ordinal** `(ord+0.5)/n·2π`, walking the detail around the full
  perimeter instead of one corner.
- **chow** → `fanAround()`: a loose fanned line at the dfac, not a 5 m pile on the building.

Deterministic (platoon index + pure id hash, **zero RNG, no new persisted state**) → replays
bit-identical; the existing `reachablePoint` snap keeps every spot walkable.

| metric | before | after |
|---|---:|---:|
| `BUNCH(<3 m)` settled garrison (valley-2533, hour 6) | 21 | **5** |
| `BUNCH(<3 m)` steady (hour 8) / chow (hour 7) | 21 / 24 | **8 / 13** |
| detail wire spread (bearing arc) | 16° (all in one corner) | even, full 360° |
| `copinterior` unreachable seats/pockets (40 seeds) | 0 | **0** (held) |
| `copstuck` grind valley-2533 / survey-44 (600 s) | 67 / 150 | 65 / 119 (flat — benign transit-brush, never the issue) |

**Honest residual.** `copstuck` grind is ~flat: it counts a man *brushing* a wall in transit
(`maxRun ≤ 1 s`), not the cluster, and the central buildings stay in everyone's path — so it was never
the right measure of "too close together." The crowding (`BUNCH`) is the real symptom and it's resolved
(renders: a pile on two barracks → men dispersed across the COP; the work detail ringing the whole
wire). Standing checks green: `tsc` · `build` · `smoke` (determinism + serialize) · `garrison.ts`
lint-clean · `balance`. Evidence: `docs/progress/2026-06-27-cop-crowding/`.

```
npx tsx scripts/scratch-cop-men.ts valley-2533 out.png 1400   # settled garrison render + BUNCH(<3m)
npx tsx scripts/scratch-cop-footprint.ts                       # footprint overlaps + apron (refutes the collider theory)
```
