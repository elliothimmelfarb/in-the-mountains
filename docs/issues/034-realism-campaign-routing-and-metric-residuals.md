# 034 — Realism-campaign routing & metric residuals (route-quality detours, probe re-aims, survey-5 pace)

> **Ledger status (verified 2026-07-16 @ da10926):** OPEN (named measurement/routing residuals) — probes current. (a) route-quality 1.46 is issue-019 planner-cost territory (terrain, not the router), (b)/(c) are 1–2 line probe re-aims, (d) survey-5 pace 0.71 is a route-selection curiosity. None blocks play.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: Low (fidelity / measurement hygiene).** A cluster of named, honest
residuals left by the 2026-07-02 realism campaign (strata walls `7180b41` + contour
trails `bd5cf77`). None blocks play; each is recorded so a future pass does not
re-discover them or misread a probe. Evidence throughout:
`docs/progress/2026-07-02-realism-campaign/after/` and `.../after/trails-2a/`.

## (a) Route-quality mean sits at 1.46, not the 1.25 guard — and it is terrain, not the router

`route-quality` (planned gate→village path length ÷ straight-line) went **HEAD 1.12 →
strata 1.52 → contour-trails 1.46**, loopy 4→3 (`after/trails-2a/route-quality-FINAL.txt`).
The 1.12 was the *smooth* fbm field; banded walls impose **real** detours around cliff
bands and river geometry — the higher number is the realism, not a regression. The
mean is carried by a small number of structural cases:

- **3 ford / wall-geometry crossings** where the only passable line detours to a ford
  or around a strata riser (survey-7 1.62 / exc 63 m, survey-9 1.92 / exc 146 m,
  delta-4 1.91 / exc 77 m). Routes still ride the trail network 75–100 % of their length.
- **1 truncated best-effort stub** to a hard-to-reach objective (ridge-11 maxRatio 6.77).

Held-out survey-40..47 tracked flat (HEAD 1.95 → 1.91, loopy 3→3): no held-out
regression. **The lever that would actually move it is router cost (a fatigue/grade-aware
planner), which is issue 019 territory — NOT a trail-generation change** (see the
recorded negative in (e) below). Repro: `npx tsx scripts/route-quality.ts`.

## (b) route-smoothness "fall-line %" is a floor-marching artifact, not a squiggle

The route-smoothness terrain-response table reports moderate-slope route length as
~59 % fall-line / ~10 % contour (target 45/25). **Diagnosed as a classification
artifact:** ~76 % of moderate-slope route length is floor + toe-slope **down-valley
marching**, which is fall-line *by definition* and doctrinally correct (you walk down
the valley to the objective). The metric counts heading-vs-contour without excluding
valley-axis travel. **Re-aim: restrict the contour/fall split to WALL cells only**
(|dx| > ~13 cells from centreline), the same wall mask `terrain-roughness` uses, so the
number reflects trail behaviour on the *slopes* rather than valley-floor marching.
Probe: `scripts/route-smoothness.ts` (`ITM_PART=plan`).

## (c) network-probe troughCells semantics broke under strata

`network-probe` reported `troughCells 2330` on the campaign HEAD vs a "must drop to ~0"
guard (`after/trails-2a/network-FINAL.txt`). The guard's **"0" baseline was a broken
capture**: strata geometry legitimately flags riser-base tread with zero carving as a
"trough," so the metric now counts real bedded-ground tread, not a defect. Villages
network-connected held at **43/43 (100 %)** — the connectivity the probe actually
guards is green. **Re-aim: redefine `troughCells` to exclude strata riser-base tread**
(or drop the "~0" target and report the raw count as informational). Probe:
`scripts/network-probe.ts`.

## (d) doctrine-pace survey-5 reads 0.71 (too slow) — pre-exists strata, not a campaign regression

Campaign-HEAD doctrine-pace is **mean 0.98 [0.71, 1.22], 8/8 arrive**
(`after/trails-2a/doctrine-pace-FINAL.txt`) — right at the FM oracle after the load-keyed
grade tax (`fa797c5`) brought the baseline **1.42 → 0.98**. The low outlier **survey-5 =
0.71** (a 1325 m walk, Darbart, only 5 m ascent yet 2901 s) is a route that spends its
length on gentler-than-average ground and prices *slow*; a same-day HEAD-7180b41 control
showed the **identical 0.71** (bit-identical band), so it **pre-exists the trail pass and
the strata pass** — it is a router/route-selection quirk, not a grade-tax miscalibration.
Recorded so it is not "fixed" by nudging the tax (which would push the honest flat routes
below 1.0). Repro: `npx tsx scripts/doctrine-pace.ts`.

## Suggested directions

- (a) is the real one and it is **issue 019's** fatigue/grade-aware planner cost, held
  out on survey-40..59 — do not attack it from trail generation.
- (b)/(c) are 1–2 line probe re-aims (wall-mask the smoothness split; redefine or
  demote the trough count). Cheap; do them the next time these probes are touched.
- (d) is a route-selection curiosity; only worth chasing if survey-5-class routes feel
  slow in play (they do not — 8/8 arrive inside the tour).

## Relevant code

`scripts/route-quality.ts`, `scripts/route-smoothness.ts`, `scripts/network-probe.ts`,
`scripts/doctrine-pace.ts`; `lib/sim/path.ts` (the planner cost that (a) would touch),
`lib/sim/terrain.ts` `trailRoute`/`layTrailRoute` (the contour-trail generation).
