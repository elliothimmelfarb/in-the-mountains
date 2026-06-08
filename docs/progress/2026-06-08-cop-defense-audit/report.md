# COP defense audit — expand the harness, find 5, ship 3, revert 2

**2026-06-08.** Goal: *expand `copaudit` to find 5 more improvements, implement with excellence.*
The interesting part isn't the five fixes — it's that the done-gate caught a regression the
audit alone declared a clean win, and the work backed two of its own fixes out.

## 1 · Expand the audit (metricize first)

`copaudit` measured COP **generation** (egress, ring, connectivity — all long green). It said
nothing about the COP as a **defended strongpoint**. Added a DEFENSE AUDIT table — pure geometry +
LOS over the seed, ATP 3-21.8 ch.5:

| metric | what it asks |
|---|---|
| `gateOW`   | is the ECP overwatched by a fighting position's sector **and** its LOS? |
| `secGap°`  | the largest perimeter azimuth arc covered by **no** sector (un-grazed frontage) |
| `mortFPF` / `asltCov%` | can the mortar (from `cop.mortarPit`) range its registered FPF / the assault band? |
| `hvtSep`   | min separation (m) between TOC / armory / aid (82 mm frag ~24 m) |
| `threat`   | which weapon holds the bearing to the nearest village (the avenue of approach) |

**Baseline (HEAD, 9 seeds) — 5 real shortfalls:** gate NOT overwatched 9/9 · sector gap >25° 9/9
(avg 47°) · FPF NOT firable 5/9 (the watch was requesting fire the 60 mm couldn't deliver — a real
bug) · HVT separation <30 m 7/9 (avg 26 m) · threat avenue not held by a heavy gun 6/9.

## 2 · Implement — 5 atomic fixes, each a measured delta

1. **ECP overwatch** — a dedicated gate tower, sited LOS-aware (a terrain-local `groundLOS` picks a
   spot that sees *through* the gap; a flanking wall position's line crosses the HESCO). Re-pointed
   the metric to the **entry kill zone** (gate + R+2), not the staging point 85 m down a switchback a
   steep spur masks. `gateOW` 9/9→0 (56/60 on the holdout).
2. **Interlocking sectors** — limits aimed at the wire MIDPOINTS between neighbours (fixing the
   radial-vs-perimeter parallax), so adjacent sectors meet, gate included. `secGap` 47°→0°.
3. **Firable FPF** — pit held near centre, the FPF pushed ≥85 m from it (past the 70 m min range),
   the watch clamps the aimpoint ≥75 m. `mortFPF` 5/9→0, `asltCov` 78→93%.
4. **HVT dispersion** — fold a centre-separation term into `spaceCopBuildings`. `hvtSep` 7/9→1/9.
5. **Threat-weighting** — bias the heavy guns toward the village. `threat` 6/9→0/9.

All five passed the audit on the survey-0..59 holdout. By the audit, a clean five-for-five.

## 3 · Adversarial verify — the done-gate caught it

`balance.ts` (the §6 stall-check) showed the five fixes raised lone-patrol casualties **0.13 → 1.88
avg KIA**. An **isolated git-worktree A/B bisect** localised it (deterministic probe):

```
922fc0b pre            0.13   ← baseline
fix2 interlock         0.13   innocent
fix1 ECP               0.75
fix5 threat            0.88
fix4 HVT = HEAD        1.88   ← +1.00 (dominant)
HEAD, threat reverted  1.38   ← fix5 = +0.50
keep 1,2,3             1.00
```

- **fix 4 (HVT dispersion): +1.00** — moving the footprints perturbs the gate/muster and the
  deterministic near-COP firefight; half the added deaths cluster at step-off. Benefit marginal
  (26→30 m, only 38/60 seeds reach 30 m).
- **fix 5 (threat-weighting): +0.50** — guns onto lower-LOS positions, weakening garrison support.

Confirmed **not** friendly fire (direct fire skips friendlies `combat.ts:980`; the COP FPF needs
player approval and never fires headless) — it's the layout-sensitivity of a near-COP firefight.

## 4 · Decision — ship 3, revert 2

Shipping three correctness fixes that make the COP demonstrably more defensible (gate overwatch,
interlock, firable FPF), and **reverting the two nice-to-haves** whose casualty cost beat their
marginal benefit, is the honest outcome (Law 8: don't force a regression; Law 5: restraint logged).
The audit *found* five; verification proved three worth keeping. The bisect is the deliverable.

**Final:** gateOW 0/9 (56/60 holdout) · secGap 0/9·0/60 · mortFPF 0/9·0/60 · HVT 7/9 + threat 4/9
(baseline, reverted). `tsc` clean · `npm run build` green · `SMOKE OK` · deterministic · balance
stall-gate green. Residuals + the reverted ideas as future work: `docs/issues/022`.
