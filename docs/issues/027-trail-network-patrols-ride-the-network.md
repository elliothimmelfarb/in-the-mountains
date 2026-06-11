# 027 — Denser trail network shifts patrol routing onto it: window times + WIA move

**Status:** OPEN (attribution in progress) · **Found:** 2026-06-11 trail-network campaign · **Severity:** balance/judgement

## What happened

The trail-network campaign (see `docs/progress/2026-06-11-trail-network/`) added +52 % trail cells
(sector fans + ridgeline links), benched-tread movement physics (`TREAD_GRADE_CAP` — a path cell's
movement slope is capped at its design grade) and a thetaClimb turn-penalty waiver on treads.
Terrain/footpath realism metrics all improved (walking grade alongGr 0.193 → 0.160, over-grade trail
length 14 % → 5 %, reach% preserved, route-quality unchanged, smoke OK, deterministic).

Side effects, measured:

1. **Far-village patrol windows.** `reachability.ts` (1500 s window) 28/44 → 27/44. Drill
   (`smoke-test`, per-village, extended window): nothing strands — every village arrives; far
   marches slowed (Donga 1321 → 1953 s, Korangal 1956 → ~2900 s), near marches got faster
   (Loy Kalay 408 → 380 s, Kandlay 518 → 478 s). Cause: coarse corridors drift onto the denser
   network (`path.ts nodeCost` block averages — trail cells at LAND_MOVE 0.92 raise block means),
   so patrols ride tracks/trails like a real column instead of beelining over spurs. The mover's
   fatigue model prices wall-clock distance, so longer network routes pay compounding fatigue the
   planner doesn't model.
2. **Balance 12×50:** KIA 1.67 → 1.42, enemy accounted 5.50 → 7.17, civ 0, no strands — but
   **WIA 6.92 → 12.58 (+82 %)**, in the same band as the recorded-negative cover-stamp (+89 %,
   2026-06-09). Hypothesis at time of writing: both sides ride the network → more contacts reach
   engagement range; firefights start on open treads (paths have ~zero cover/conceal) — ambush
   country. `ITM_NOTREADCAP=1` A/B attribution running.

## Repro

- `npx tsx scripts/village-drill.ts smoke-test [village]` (per-village arrive times;
  `ITM_REACH_MAXS=2500` extends the window; `ITM_NOTREADCAP=1` disables tread caps).
- `npx tsx scripts/balance.ts` vs `ITM_NOTREADCAP=1 npx tsx scripts/balance.ts`.

## Resolution

**2026-06-11 — attributed via `ITM_NOTREADCAP` A/B, caps narrowed to Trail+Footbridge only.**

Balance 12×50 attribution (tuned seed set):

| config | KIA | WIA | enemy accounted |
|---|---|---|---|
| HEAD | 1.67 | 6.92 | 5.50 |
| trails, no caps (landcover only) | 1.00 | 8.42 | 7.00 |
| trails + caps on ALL paths (Road/Track/Trail) | 1.42 | **12.58** | 7.17 |

- The **+82 % WIA was the road/track caps**, not the trails: roads/tracks are physically benched at
  generation (cell slope ≈ design grade already), so capping them only amplified the surface-laid
  steep sections — a valley-wide tempo speedup for BOTH sides (more contacts reach engagement
  range). Removed: `TREAD_GRADE_CAP` now covers **Trail + Footbridge only** (~0.4 % of map, up on
  the walls where the climbing fan lives — the steep-traversal ask without the valley tempo shift).
- The ladder: HEAD **6.92** (issue 026 had flagged this as *below* the ~8.58 band, "friendly side
  safer; watching") → landcover-only **8.42** (in band) → trail-only caps, final code **9.42**
  (+10 % over band; KIA 1.75 ≈ HEAD's 1.67, enemy 7.08, civ 0, 0 strands) → all-caps **12.58**
  (rejected). Residual: final WIA ~0.8 over band, within the same-family run spread (026's open
  σ-floor harness debt) — watch, don't tune to it. Runs:
  `docs/progress/2026-06-11-trail-network/after/balance-{final,nocaps,allcaps}.txt`.
- The far-village window residual (`reachability` 28/44 → 27/44; Donga 1321→~1700 s, arrives) is the
  landcover corridor drift — patrols riding the denser network like a real column. Kept deliberately:
  network-riding is the realistic behaviour, nothing strands, near villages got faster. If a future
  campaign wants the window back, the lever is the fatigue-blind planner cost (it under-prices
  wall-clock distance), NOT removing trails.
