# COP interior connectivity — "a squad gets stuck on buildings" — 2026-06-06

**Report:** `valley-2533` — "one squad is getting stuck on buildings in the COP." Felt like a movement
bug; it was a **terrain-generation** bug that the COP audit's metrics had been *blind* to.

Worked **verify-don't-assume** (every step is a hard number from a headless harness, baselined and
re-measured), **research-first** (a multi-agent workshop on real COP/FOB layout + the surgical fix),
and **adversarially reviewed** (a second multi-agent pass hunting determinism / perf / edge-case
breaks). Full issue write-up: `docs/issues/012-cop-interior-connectivity.md`.

## 1. What was wrong (measured)

`buildCop` placed 8 buildings at fixed positions with **no guaranteed street**, in a small (R≈17 cells)
wire. Footprints touched, sealing interior courtyards; billets piled in one rear corner. Garrison posts
ended up **unreachable**, and a man sent there ground a wall forever (cheap `walkTo` → path grazes a
building → 2 s stall-drop → re-issue → repeat).

| symptom | metric | baseline |
|---|---|---|
| men can't reach their posts | `copinterior` unreachable seats+FPs | **21 / 30 seeds** |
| the reported squad stuck | `copstuck valley-2533` grind / 600 s | **1169** (93 % at the dead-centre TOC) |
| pathological split yard | `copstuck survey-44` | **12808**, 7 seats + 3 FPs unreachable |
| buildings touching | min building gap | **0 m** (6 / 10 named seeds) |
| the blind spot | `copaudit` measured open% (~80 %) | but **never checked connectivity** |

New harnesses: `scripts/copstuck.ts`, `scripts/copinterior.ts`, `scripts/cop-render.ts`. The render
made it visible — see `cop-valley-2533-BEFORE.png` (a red sealed courtyard walled by Chow Hall +
Barracks + Latrines, the exact trap the worst offender fell into) and `cop-survey-44-AFTER.png` vs the
split-yard disaster.

## 2. Two oracle traps (why early measurement lied)

- `reachableFromGate()` is 8-connected and **permits corner-cuts** → marks a berm cell "reachable" the
  planner can't walk to.
- `findPath` returns a **degenerate `[goal]` waypoint** (straight through a wall) for an unreachable
  goal → a naive `endDist < 2 cells` check reads "arrived."

The trustworthy oracle is an **anti-corner-cut flood from the muster** (== what the planner truly
walks); the audit's `findPath` check now rejects the degenerate path.

## 3. The fix (`lib/sim/terrain.ts`, `lib/sim/world/garrison.ts`) — all deterministic, zero RNG

1. **Re-spaced** layout across bearings (TOC central-rear, chow fronting, slim billet rows wide apart,
   latrines rearmost).
2. **`spaceCopBuildings()`** — min-gap relaxation separating pairs along the axis closest to clearing,
   clamped inside R−3 → a ≥ 10 m street between every pair.
3. **`ensureInteriorConnectivity()`** (runs LAST in `generate()`) — floods from the muster, carves a
   **widening benched lane** from every large / post-holding unreachable component to the nearest
   reachable cell until the **whole interior is one yard**; relocates a stranded fighting position
   inward to reachable berm; seals only small (< 9-cell) post-free slivers. Never touches the HESCO
   wire / compounds; stays inside R−3 (perimeter & infiltration unchanged).
4. **Garrison escalation** — a man wedged > 4 s short of his post upgrades from the cheap router to a
   full `findPath` (fires only when genuinely stuck → no per-tick A* stall).

## 4. Results (after, same harnesses)

| metric | before | after |
|---|---:|---:|
| seeds with an unreachable post (60-seed sweep) | ~42 / 60 | **0 / 60** |
| fresh-seed sweep `adv-0..199` | — | **0 / 200** (guard converges ≤ 5 passes) |
| `valley-2533` grind / 600 s | 1169 | **26** |
| `survey-44` grind / 600 s | 12808 | **26** |
| min building gap | 0 m | **≥ 10 m** |
| sealed pocket cells `survey-44` | 181 | **1** |

Green: `tsc` · `build` (1.4 s) · `smoke` · `balance` (12 runs, 0 civ-cas, **no stranded** — identical
to baseline) · determinism bit-identical (terrain hash + 300 s full-sim) · `copaudit`
egress/ring%/portal/village-sep/`solid?` **unchanged**, open% +1 %. Live (`__ITM` + Playwright,
`valley-2533`): 35/35 inside the wire, **0 grinding** at 90 s — see `live-valley-2533-cop.png`.

`copaudit` now carries the connectivity invariant ("seeds with an unreachable garrison post: 0/N"),
closing the metric blind spot for good.

## 5. Records

- `cop-valley-2533-BEFORE.png` / `-AFTER.png` — the reported seed (red sealed courtyard → connected yard).
- `cop-bravo-2-BEFORE.png` — another over-packed seed.
- `cop-survey-44-AFTER.png` — the pathological split-yard seed, now one connected yard (12808 → 26 grind).
- `live-valley-2533-cop.png`, `live-valley-2533-cop-zoom.png` — the live game, men at posts not on walls.

## 6. Reproduce

```
npx tsx scripts/copinterior.ts 60            # 0 unreachable posts; grind per seed
npx tsx scripts/copstuck.ts valley-2533 600  # per-squad / per-building grind breakdown
npx tsx scripts/cop-render.ts valley-2533 docs/progress/2026-06-06-cop-interior/x.png
npx tsx scripts/copaudit.ts 30               # standing audit incl. the connectivity invariant
```
