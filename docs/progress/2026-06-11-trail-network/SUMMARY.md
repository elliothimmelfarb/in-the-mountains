# Trail-network realism campaign — verbatim numbers (2026-06-11)

HEAD at start: `981133c`. Goal: "meaningfully improve the graphics and terrain generation, including
improving trails and roads — more trails going up steep hills that enable better traversal, more
realistic trails like in real life."

Baselines in `baseline/` (captured on a HEAD worktree at `/tmp/itm-trailnet-head`), shots in `shots/`.
Tune set = the 8 documented footpath seeds; holdout = survey-40..59 (never tuned on).

## What changed (one mechanism each)

1. **Trail-network topology** (`terrain.ts layTrailNetwork`): the uphill annulus scan is binned into
   THREE along-valley sectors per trailhead (village/COP gate) — a fan of switchback trails per
   origin instead of one. Trail summits per valley side are linked by contour-holding **ridgeline
   trails** (new `lateralTrail` walker; only laid when it actually arrives).
2. **Draw trails molded** (`carveRoadsAndTrails`): the village goat-trail up the draw was a dead-
   straight `layPath` up the fall line (survey-9: trail mean ground-slope 1.18 ≈ 50° "trail").
   Now an `ascendTrail` switchback toward the same point (straight fallback only on gentle ground).
   The rng draw is kept — the seed stream is unperturbed.
3. **Trails are pure landcover** (`ascendTrail`/`lateralTrail` lay with conform 0): NO elevation
   writes. The old conform 0.15 nudged neighbour forward-difference slopes past the cliff gate and
   severed a connectivity neck (survey-45 gate reach% 36.0 → 10.6 — caught by the holdout pass,
   fixed by conform 0; survey-45 restored to 36.0).
4. **Benched-tread movement physics** (`TREAD_GRADE_CAP` in `moveCostAt`/`dirSpeedAt`): a mover on a
   FOOT TRAIL (or footbridge) walks at the trail's DESIGN grade (Trail 0.35), never the raw face
   slope under the 5 m elevation field. **Trail + Footbridge only** (~0.4 % of map, on the walls):
   a first version capped Road/Track too and was measured at WIA 12.58 (+82 %, the recorded-negative
   band) — roads/tracks are already physically benched, so capping them was a pure valley-tempo
   amplifier for both sides. Cut back via `ITM_NOTREADCAP` A/B (precedent: `ITM_NOSWITCH`); see
   issue 027 for the attribution table.
5. **Turn-penalty waiver on treads** (`path.ts thetaClimb`): a bend on a laid path costs ×0.15 —
   the penalty prices cross-country navigation, which a worn tread eliminates. Both leg endpoints
   must be on path landcover, so open-ground jitter (the penalty's reason to exist) cannot enter.
   Adversarial-review hardening: foot-trail walkers lay NOTHING under their minimum length (no
   invisible sub-6-point stubs), never stamp a river cell (`layPath bridge=false` — no phantom
   one-cell fords; crossings come only from placeFords/tracks), `onTread` includes Footbridge and
   is hoisted out of the Theta* hot loop.
6. **Render smoothing** (`topo.ts drawPathsLive`): centerlines stroked as midpoint quadratic curves
   instead of 7 m jagged segments — hairpins read as worn curves.
7. **footpath-probe extended**: new `alongGr` (length-weighted walking grade along trail centerlines)
   and `along>45%` (over-grade length share) columns — the old trGrade/trSteep% read GROUND slope at
   trail cells, which *should* rise when trails dare steep walls; alongGr is the authenticity number.

## Numbers (tune set, mean over 8 seeds)

| metric | HEAD | after (final) | read |
|---|---|---|---|
| trail cells | 753 | 1137 | +51 % more trail |
| trail polylines/seed (korengal) | 9 | 24 | the fan + ridgelines |
| path% of map | 2.01 | 2.15 | |
| ground slope at trail cells (trGrade) | 0.54 | 0.52 | trails cross steeper walls… |
| trSteep% (ground >0.5 at trail) | 27 % | 30 % | …more daring |
| **alongGr (walking grade)** | **0.193** | **0.160** | …at a GENTLER tread |
| **along>45% (unwalkable length)** | **14 %** | **5 %** | the straight-up-the-fall-line residual, killed |
| survey-9 alongGr / over-grade | 0.291 / 29 % | 0.156 / 5 % | the worst seed fixed |
| pass% / reach% | 80.8 / 60.6 | 80.9 / 60.6 | connectivity preserved |
| route-quality meanRatio / loopy | 1.12 / 0 % | 1.12 / 0 % | no routing pathology |
| climb onPath% (ridgeline seed) | 20 % | 23 % | climbs ride the network (was 31 % under all-path caps) |
| smoke | SMOKE OK | SMOKE OK | determinism: same seed → same land+elev hash ×2 |

## Holdout (survey-40..59, never tuned on) — FINAL code

- footpath: trail cells 731 → 979 (+34 %), **alongGr 0.224 → 0.188**, **over-grade length 14 % → 7 %**,
  trGrade 0.54 → 0.51, path% 1.99 → 2.09 — generalises.
- passability: pass% 79.6 → 79.6, **reach% 57.5 → 57.5 (parity)** — the survey-45 severance
  (36.0 → 10.6, conform-0.15 neighbour-slope flip) was found here and fixed by conform 0.

## Final engine-true movement verification (after caps narrowed to Trail-only)

- **`reachability.ts`: 28/44 → 28/44 — HEAD parity restored.** The earlier 27/44 was the road/track
  caps flipping far-march corridors onto long valley detours; with Trail-only caps the smoke-test
  drill reads: Loy Kalay 408→381 s, Kandlay 518→482 s, **Donga 1321→1296 s (faster)**, Landigal
  615→735 s, Korangal 1956→2275 s — every village arrives, three of five faster or equal.
- route-quality: meanRatio 1.12, loopy 0 % — unchanged.
- **Balance WIA, attributed and resolved** (12×50, tuned seed set): the first cap set (Road/Track/
  Trail) measured WIA 12.58 (+82 %) — `ITM_NOTREADCAP` A/B pinned it on the ROAD/TRACK caps (already-
  benched ground; capping them was a pure tempo amplifier for both sides: HEAD 6.92 → landcover-only
  8.42 → all-caps 12.58). Caps narrowed to **Trail + Footbridge only**; landcover-only WIA 8.42 sits
  inside the historical ~8.58 band that issue 026 flagged HEAD's 6.92 as BELOW. KIA 1.67 → 1.00,
  enemy 5.50 → 7.00, civ 0, 0 strands. Final-code run: `after/balance-final.txt` (all-caps attribution run preserved as `after/balance-allcaps.txt`).
- korengal-2 strict-graph big% 99.2 → 51.8 (probe's conservative ≤1.25 graph only — the ENGINE-true
  gate reach% is unchanged at 82.1; tracks re-routed under shifted block costs bench different ground).
- Climb-time to high shoulders (trail-utility, fixed oracle, arrived-only, FINAL code):
  3606 → 3580 (−0.7 %); planner-arrival 27/40 → 26/40 — the flip is korengal-2 village (233,69) →
  a 645 m-gain-over-559 m-crow destination (grade 1.15, mountaineering ground): HEAD "arrived" via a
  tortured 2.6 km claw, final code best-efforts to 325 m short and holds ("as close as the ground
  allows"). Engine-true patrol marches (reachability) are at HEAD parity, so recorded as a residual.
- The climb-trail fan tops out at the 180 m gain cap per trail (ascendTrail), so the highest
  shoulders are served by trail + a cross-country finish, not trail end-to-end. Raising the cap was
  considered and deliberately NOT done this session — it multiplies trail length on the steepest
  walls and deserves its own measured pass.

## Standing checks

`tsc --noEmit` green (pre-existing lib/audio errors are another agent's WIP) · `npm run build` green ·
eslint: 0 errors in touched files · smoke SMOKE OK · balance: no strands (WIA flagged above).
