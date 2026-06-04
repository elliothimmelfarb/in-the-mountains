# 006 — Far villages are a long march (cliff-isolation), not always reachable in a short window

**Severity:** Low–Medium · **Confidence:** High (measured) · **Area:** terrain connectivity × pathfinding × patrol pace · **Status:** OPEN (characterised, partially mitigated)

## Summary

A fair, all-villages reachability harness (`scripts/reachability.ts`, added 2026-06-04) shows a patrol
reaches only ~40–46% of villages within a 1500 s real-time window. This is **not a routing bug** — it's
that a chunk of villages sit across genuine **cliff bands** that fragment the 5 m valley, so the only
foot route detours **2–6× the straight-line distance**, and a patrol at ~1 m/s can't cover a 2.5–3 km
route in 1500 s. With the game's **time-warp** these patrols do arrive; the metric understates real
playability. But the worst cases (a village a few hundred metres away behind a cliff requiring a
kilometres-long detour) read as awkward and are worth designing down.

## Evidence (2026-06-04)

```
scripts/reachability.ts            21/46 villages reached in 1500 s (≈46%)  ← AFTER this pass
                                   18/46 (≈39%) on the pre-pass baseline    ← this is PRE-EXISTING
scripts/copaudit-style findPath    valid route to ~every village; 1 genuine FALLBACK across the sample
                                   detour ratios: survey-2 Babiyal 3242 m route / 517 m straight = 6.3×
movement-diag worst case           survey-2 / survey-7 "set up short": the most-opposite village sits
                                   below a cliff band; route loops to a draw at the map edge
```

A connectivity flood-fill confirms the valley breaks into pockets separated by `slope>1.25`/`Cliff`
bands (16–23% of the map is impassable). The COP itself is on a commanding bench, often with a cliff on
one side — realistic Korengal geography, but it isolates the villages under that side.

Reproduce: `npx tsx scripts/reachability.ts` (window/pace artifact) and `npx tsx scripts/movement-diag.ts`
(watch `survey-2`, `survey-7`).

## Root cause

- **Terrain fragmentation.** `classifyLand` turns `slope>1.5` into impassable `Cliff` and `passableCell`
  rejects `slope>1.25`. On the steep cross-valley profile this carves cliff bands that seal pockets with
  no passable thread through them, so routes must go the long way around.
- **No village↔village connectors.** Villages are tied to the valley road (issue resolved this pass) but
  not to each other through the passes/draws a real trail network would use.
- **The reachability *metric* conflates "reachable" with "reachable fast"** — a fixed real-time window
  penalises long-but-valid routes that the in-game time-warp would cover.

## What was tried (honest negatives)

- A straight-line "village accessibility" term in COP siting — **reverted**: a ray over a cliff ignores
  the draw that routes around it, so it scored good benches as bad and destabilised placements.
- Graded village→road foot trails — **kept**: they help the worst-case patrols (`korengal` STUCK →
  arrives) and add authenticity, but they don't move the window metric (route *distances* are unchanged).

## Suggested directions

- **Reduce gratuitous 5 m-scale cliff.** A light smoothing / higher cliff threshold so the passable
  terrain is better connected (the biggest lever; tune carefully against combat balance — the steep feel
  is deliberate). Measure the impassable % and the largest connected component before/after.
- **A real trail web through the passes.** Connect each village to its 1–2 nearest neighbours with a
  terrain-following graded trail (the `descendTrack` machinery generalises), so there's a direct route
  that doesn't detour to the map edge.
- **A path-based accessibility siting term** (not straight-line): score candidate COP sites by the
  *route* length to the nearest villages, sampled cheaply (a coarse flood-fill, not full A* per
  candidate). Avoid cliff-isolated benches without overfitting.
- **Make the metric honest:** measure reachability at warp / with a generous window, and report the
  detour ratio separately, so "long march" and "genuinely unreachable" don't get conflated.

## Related

- 002 (gate/siting vs villages), the graded village trails added this pass, 007 (terrain fidelity).
