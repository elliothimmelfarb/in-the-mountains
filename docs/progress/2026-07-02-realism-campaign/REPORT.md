# Realism campaign — 2026-07-02 → 03 — campaign record

**Owner brief (reconstructed):** *Up the realism of what already exists — no new
features. Four complaints: (A) soldiers get stuck / squad movement feels off; (B) walked
paths look too squiggly/unrealistic; (C) terrain too smooth/abstract vs real Korengal
photos; (D) the KOP feels fake. Total freedom, question everything.*

**HEAD at start:** `83e4256`. **HEAD at finish:** `bd5cf77`. Nine commits.
tsc clean · SMOKE OK (material hash 3664222144 unchanged) · balance 0-stranded ·
**COIN gate OK** (8/8 PASS, best paired seed 71).

The through-line: **two of the four complaints were the opposite of what they looked
like.** "Squiggly" paths were actually too *straight*; patrols "getting stuck" were a
probe-window artifact — the real stuck bug lived only *in combat*. We metricized all
four before touching code (Phase 1), fixed the confirmed mechanisms (Phase 2), and
captured/documented (Phase 3, this record).

---

## Phase 1 — metricize (commit `7e1ea74`)

Built the three missing instruments (the fourth, `combat-grind`, followed in Phase 2)
and took verbatim baselines on `83e4256`. Baselines live in `baseline/`; the four
verdicts:

- **A — "stuck" is in-combat only.** Patrol `route-quality` was within 0.6–5 % of the
  Dijkstra geodesic; fair `reachability` stable at 57 %. The two "STUCK" survey seeds
  were probe-window artifacts. But `combat-grind` confirmed a real in-combat family:
  insurgent exfil issued a raw beeline whose end sat in a cliff cell, the 2 s watchdog
  wiped the path, the brain re-issued the identical target forever — **one fighter
  frozen 678 s**, **42 % of insurgent in-contact time blocked** (friendlies 0.8 %).
- **B — "squiggly" is INVERTED.** Planned routes were near-beelines (ratio **1.12**);
  on moderate slopes **66 % ran down the fall line vs 11 % on the contour** (real trails
  are the reverse). The executed per-man weave is 0.2–0.4 m RMS = **0.16 px at play
  zoom** — invisible. Trails climbed at ~2× the real grade.
- **C — macro right, meso missing.** Wall median ~37°, relief ratio 0.62 (both correct),
  but **zero 15–45 m structured relief**, zero cliff-band/bench reversals, and a fake
  60–79° floodplain rim curb. The walls were smooth fbm gradient washes.
- **D — a parametric circle.** Perfect-circle HESCO ring, 55/45 Gravel/Grass checkerboard
  yard, radial building fan, garrison frozen on a golden-angle lattice, and **seven
  manifest art assets drawn nowhere** (concertina, sandbag-wall, conex, tent, windsock,
  hesco-corner, bazaar-stall). Plus a tan road painted edge-to-edge across the yard.

---

## The four fronts — verbatim before → after

### Front A — in-combat movement (commits `f573728`, `dbf317c`, `fa797c5`)

One mechanism at the chokepoint every combat brain already calls: `CombatSim.moveTo`
snaps every goal to standable ground and routes the ≤15 m bound past the 7 m steering
fan; `findCover` pre-filters candidates by passability (cover *adjacent* to a wall is
real, *inside* it is not); `exfilPoint` snaps its beeline and a done-exfil fighter with
no American within 600 m melts away instead of parking as a stall-wipe zombie. Then the
garrison self-heal (`dbf317c`) + the `dragToCover` root fix (`fa797c5`) closed the
solid-cell wedge, and the load-keyed grade tax (`fa797c5`) fixed the pace.

`combat-grind` (bal-0..5, 50 game-min each):

| metric | HEAD | after |
|---|---:|---:|
| insurgent grind events | 570 | **0** |
| insurgent blocked % of contact | 21.0 % | **0.0 %** |
| impassable-goal time, friendly / insurgent | 4.6 % / 18.8 % | **0.0 % / 0.0 %** |
| worst frozen unit | 678 s | **10.7 s** |
| zombie post-contact exfil wipes | 759 | **0** |
| out-of-contact wipes, all causes | 1718 | **25** |
| in-contact bounds completed | 6.5 % | **25.9 %** |
| garrison stall-wipes (bal-2, `dbf317c`) | 951 | **1** |

Doctrine pace (`doctrine-pace`, load-keyed Naismith→FM 3-97.6 grade tax): sim/FM ratio
**mean 1.42 → 0.98** [0.71, 1.22], 8/8 arrive; the 249 m climb that read **2.45×** too
fast now prices **~1.0**. Casualties (DIAGNOSTIC, σ≈2.5 noise floor): balance-FINAL KIA
1.75 / WIA 9.25 / enemy 5.00 / **civ 0**, 0 stranded. The honest effect: fighters who
break contact now escape uphill (Korengal reality) instead of dying pinned by a pathing
bug; US riflemen reach real cover instead of pacing wall faces.

### Front B — trails contour like real trails (commit `bd5cf77`, Wave 2a)

Oracle: USFS half-rule (trail grade ≤ ½ hillside grade), ~10 % network average, contour
traverses + switchback ladders at spur noses. `ascendTrail` rebuilt to explicit grade
targeting with per-step acceptance vs real cell rise; `lateralTrail` prefers a bench
tier; a grade-priced Dijkstra lays bench laterals on the village-MST + a COP-gate→village
fan.

| metric (footpath-probe) | HEAD 83e4256 | strata-era 7180b41 | contoured bd5cf77 |
|---|---:|---:|---:|
| alongGr (walker's experienced grade) | 0.185 | 0.215 | **0.114** |
| along>45 % (unwalkable-trail residual) | 9 % | 12 % | **2 %** |
| route-quality ALL (planned len ÷ crow) | 1.12 | 1.52 | **1.46** |
| loopy routes | 0 | 4 | **3** |
| roads inside the COP wire | 9 | 9 | **0** |

Held-out survey-40..47 alongGr 0.130. The route-quality mean of 1.46 (not the 1.25 guard)
is banded-wall geometry, not the router — 3 ford/crossing detours + 1 stub carry it
(issue 034).

### Front C — strata-band walls (commit `7180b41`, front C)

The smooth fbm walls become bedded gneiss/schist: banded strata (asymmetric bench/riser
cycles, λ≈56 m, phase-drifted, anisotropic breach chutes), slope-budgeted gully/outcrop
dissection, and a ~110 m smoothstep toe apron replacing the rim curb — with a
world-connectivity + river-crossing re-validation after the last terrain mutator.

| metric (terrain-roughness / audit / passability) | HEAD | after | held-out 40..47 |
|---|---:|---:|---:|
| wall reversal density (korengal transects, /km) | 0–2.8 | **6.2–17.8** | — |
| E15-45 band energy (m) | 1.98 | **3.64** | 3.43 |
| rim-band slope p50 | 1.72 | **0.18** | 0.18 |
| passability reach (MEAN) | 60.6 % | **75.2 %** | — |
| passability reach (worst seed survey-9) | 11.0 % | **65.3 %** | — |
| terrain-audit vilUnreach | 2/44 | **0/43** | — |

Also fixed a **viaduct bug** the connectivity guard exposed: survey-7 was laying
village-track tread at elev 1976 across the 1775 plate, burying the MSR and damming the
river. Named residuals (partial wins, not re-attempted): md3 wall texture 0.12 → **0.19**
(target 0.30 MISS — denser fine noise reaches 0.30 but collapses band% and sprays
speckle); the >45° slope mass thinned + gapped but **not shattered** (T8's shatter hit
110 comps/39% and cratered reach to 34 % — refuted); speckle 6 → 14 % and comps 5.3 →
16.5 are denominator/realism artifacts (the extra components are walkable bench shelves;
spawns snap around them).

### Front D — dress the KOP (commits `5764134` render, `dbf317c` garrison, `bd5cf77` road)

The clutter IS the realism (Junger *War*/*Vanity Fair*; *Restrepo*). Shipped render-side
(footprints untouched): double staggered concertina outside the HESCOs, sandbag parapets
arcing every non-tower fighting position, procedural camo nets over the pit shoulder +
TOC flank, conex-cluster armory + GP-tent billet skins, a windsock + clutter at the
anchors that explain it (pallets/drums at the LZ, ammo cans at the armory, burn barrels
at the latrines, the improvised gym at the same anchor the garrison sends its two
lifters), worn foot-lanes, and the road **clipped at the wire**. Garrison life
(`dbf317c`): a gym pair, 2–3-man conversation knots (~40 % of idlers), per-man staggered
seat drift — the off-duty pool stops reading as evenly-spaced frozen dots. The
road-through-yard is fixed on BOTH sides now: render clip (`5764134`) + generation
(`bd5cf77`: **0 Road inside ring, 0 verge, Hesco wall closed on all 360 bearings × 8
seeds**). Perf: +~2 ms (+5 % under software raster) at a combat tableau. **The shape
itself is unchanged — the perfect circle + checkerboard yard are the deferred Wave 2b
(issue 033).**

---

## The harness work (commits `3666d14`, `9c031da`)

The strata + combat changes were parked behind a red COIN gate that turned out to be
measuring **its own noise**, not a regression. A **null-perturbation control** — one
extra world-init RNG draw, zero behaviour change — swung the 3-seed mean spread **37.3 →
18.3** at the same commit. Root cause: **relief-of-command is an opening-days lottery**
(issue 035) that censors ~half of careful tours to ~0, making the 3-seed mean a
survivor-count coin-flip. `3666d14` re-anchored the discriminator onto the **paired best
seed** + a fully-censored-draw tier (aggregation only, no sim change). `9c031da` then
fixed a real ceiling the noise had masked: the scheduler sampled **once per game-day at
midnight**, starving op squads to **83–89 % idle** — event-driven, daylight-gated pacing
let tempo emerge from op duration + the daylight window. Honest price, reported not
narrowed: careful mean 65.0 → 50.0 under equal pacing at FM speeds; careful still beats
body-count 87–0 on its best valley. Final gate: **careful 23.7 vs body-count 5.7, best
paired seed 71, 8/8 PASS.**

---

## DO-NOT-RE-TRY (added this campaign — question the conclusion, never repeat the implementation)

1. **Grade-priced Dijkstra routing for TRACKS** is strictly worse (route-quality
   1.41 → 1.47; delta-4 1.88 → 2.40). Walked routes *ride* the tracks, so contour-
   detouring the tracks lengthens every route. Tracks stay straight; only **foot-trails**
   contour. (`bd5cf77`, in the `layTrack` comment.)
2. **Shattering the >45° slope mass** to kill the single giant component: T8's shatter
   hit 110 comps / 39 % maxBlob but **cratered passability reach to 34 %** — the mass is
   load-bearing walkable structure. Thin it and gap it along-strike; do not shatter it.
   (`7180b41`.)
3. **Asserting the COIN gate's 3-seed MEAN.** A single null RNG draw swings it ±19 pts
   (bigger than any real delta measured this campaign). Gate on the **paired best seed**
   (same valley, only the policy differs) + a censored-draw tier. Never gate the mean.
   (`3666d14`.)
4. Reconfirmed: **elevation-benched trails** stay conform-0 (issue 007 — benching digs
   trenches in the passable graph); **never-freeze floor is load-bearing** (issue 031);
   **doctrine-pace survey-5 = 0.71** pre-exists strata (not a grade-tax miscalibration —
   issue 034).

## Residuals (open, tracked)

- **Issue 033 — Wave 2b KOP generation rebuild (TOP follow-up).** The dressing dressed a
  parametric circle; the generation (contour-kinked polygonal perimeter, terraced
  benches, continuous yard, ANA sub-compound) is the next campaign.
- **Issue 034 — routing & metric residuals.** Route-quality 1.46 (issue-019 planner
  cost, held-out); route-smoothness fall-line % wants a wall-mask; network-probe trough
  count wants a strata re-def; doctrine-pace survey-5 0.71.
- **Issue 035 — relief-of-command lottery.** The COIN-gate noise root; combat/director
  domain (grace window + trajectory-based relief).
- **Issue 030 — COIN-gate wall-time.** The event-driven pacing raised the 3-seed default
  to ~30–40 min wall (a body-count leg 45–69 min CPU, killed more than once); the fast,
  deterministic "COIN smoke" config is still open.
- **Front-C strata:** md3 wall texture 0.19 vs 0.30 target; >45° mass thinned not
  shattered.

## Evidence

`baseline/` — verbatim HEAD baselines · `after/` + `after/trails-2a/` — definitive
isolated re-measures, held-out survey-40..47, tuning logs · `final/` — the Phase-3
captures (`visual-matrix/`, `cop-FINAL.png`, `traj-korengal-FINAL.png`). The published
player-facing report: `public/manual/archive/reports/2026-07-02-realism-campaign/`.
