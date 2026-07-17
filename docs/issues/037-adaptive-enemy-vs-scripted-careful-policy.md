# 037 — The adaptive enemy punishes the harness's fixed-route careful policy (combined-tree COIN mean at gate threshold)

> **Ledger status (resolved 2026-07-16, same day):** RESOLVED — all three directions worked;
> the titular hypothesis was **REFUTED by measurement** (see Resolution). Entries here are
> dated claims; code outranks the ledger.

**Severity: Medium (calibration + harness-instrument; NOT a gate failure — the gate passed).**

## What was measured

`campaign-loop 3×8` on the combined tree (relief evidence file + enemy network,
@ `89d5e4a`): **COIN GATE OK, all 8 PASS** — but mean careful collapsed to **33.3
(per-seed 0, 0, 100)** vs **85.7 (82/77/98)** on the relief-only tree the same day, with
2/3 careful tours relieved (endDay 7, attributed patterns, post-grace). Body-count fell
too (4.0 → 7.7 — noise-band). Best-pair discrimination hit the highest value yet
(survey-2: careful **100** vs 7 = **93**), so the win condition discriminates harder than
ever when the careful tour survives; the MEAN is carried down by the two relieved tours.
Evidence: `docs/progress/2026-07-16-enemy-network/` (both verbatim gate outputs).

## The mechanism (hypothesis, partially confirmed)

The network made the enemy effective against PREDICTABILITY: patrol-heat IED siting
targets habitual routes, and cells stage from persistent home ground near their villages.
The harness's scripted careful policy walks fixed presence routes at the same villages
every day — it is the maximally-predictable commander, i.e. exactly the behavior the
adaptation is designed to punish. A human player can vary routes; the script cannot.
Confounder: the tick-RNG stream changed wholesale with the network (expected), so
per-seed relief-tree↔combined-tree comparisons are unpaired — some of the 85.7→33.3 drop
is trajectory reshuffle inside the documented ~19-pt null-perturbation noise floor.

## Why this is NOT issue 035 returning

The two relieved careful tours died by the new rules: past the 5-day grace, with
nameable multi-day casualty patterns they kept re-earning by walking the same IED'd
ground. Attribution and grace worked; the question is DIFFICULTY and INSTRUMENT, not
lottery.

## Suggested directions

1. **Instrument first:** a patrol-heat→IED-incidence probe (predictable vs varied-route
   policies, same seeds) to quantify the adaptation's real tax. The builder report names
   this exact gap.
2. **Harness:** give the scripted careful policy cheap route variety (rotate approach
   axes per day) so the gate measures COIN, not route hygiene. This mirrors issue 015's
   known "tactically-naive scripted patrol routing" residual, now amplified.
3. **Calibration read (issue 030's scope):** decide the intended difficulty of the
   adaptive enemy against a competent human, then characterize — never tune casualties
   to a target (harness law).

## Repro

`npx tsx scripts/campaign-loop.ts 3 8` at `89d5e4a`+ — compare per-seed careful endDay
and the day dumps' IED/ambush sites against the patrol routes.

## Resolution (2026-07-16, same day) — hypothesis REFUTED by the instrument it asked for

All three directions done; evidence `docs/progress/2026-07-16-patrol-predictability/`.

1. **Instrument (direction 1):** `scripts/patrol-predictability-probe.ts` — the gate's FULL
   careful commander, fixed vs rotated approach axes ({+1,−1,0}×240 m), one decision changed.
   **Measured on the 3 gate seeds × 8 days: 6 IED plants, 0 detonations, 0 IED casualties;
   hot-seed KIA/day 5.14 (fixed) vs 5.00 (varied).** The predictability tax on the current
   enemy is ~ZERO. The careful-tour killers are POSITION-REACTIVE (ambush/harass spawn around
   the live patrol centroid — `director.ts` — which route hygiene cannot dodge by construction);
   the memory-based IED channel never connects (radial 30–95 m placement guess vs 8 m
   victim-trigger, cell patience ~104 s → all duds — **filed as issue 038**). This entry's
   "kept re-earning by walking the same IED'd ground" was interpretation, not measurement:
   the relieved tours' casualties were ambush casualties; the probe's fixed legs reproduce the
   morning gate's careful legs exactly (relieved d7/d7, survey-2 survived).
2. **Harness (direction 2):** `campaign-loop.ts` careful policy rotates approach axes per visit;
   `ITM_FIXED_ROUTES=1` reproduces the old routes (A/B kill-switch). Kept as instrument hygiene,
   explicitly NOT a score lever. Gate 3×8 after: **all 8 PASS**, careful 0/0/70 (mean 23.3,
   relief 2/3→1/3), best-pair 63; **body-count legs byte-identical to the baseline record
   (0/16/7, mean 7.7)** — determinism cross-check validating both documents. The 33.3→23.3 and
   93→63 movements are trajectory reshuffle inside the documented ~19-pt noise band (survey-2
   careful 100→70 with zero IEDs in both trees).
3. **Difficulty read (direction 3, characterized — nothing tuned, harness law):** on 2 of 3
   gate seeds the enemy delivers ~5 KIA/day against a tight-ROE route-varying careful commander
   (36–40 KIA in ≤9 days; a survivor tour still scores 0 on casualty penalties). Reference:
   the entire Korengal campaign 2006–2010 ≈ 50 US KIA. The intended-difficulty decision is the
   owner's; the levers to examine are the position-reactive channels, not heat/IED. Recorded in
   issue 030's calibration scope.

**What this issue got right:** the gate's careful commander WAS maximally predictable (015's
residual) and the mean DID sit at the threshold. **What it got wrong:** the cause. The
enemy-network wave raised lethality through cell proximity-staging/aggression, not through
punishing predictability — the adaptation designed to punish predictability doesn't function
as a threat yet (038).
