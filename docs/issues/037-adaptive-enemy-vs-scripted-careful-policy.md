# 037 — The adaptive enemy punishes the harness's fixed-route careful policy (combined-tree COIN mean at gate threshold)

> **Ledger status (filed 2026-07-16 @ post-network wave):** OPEN — measured same day the
> enemy-network wave shipped. Entries here are dated claims; code outranks the ledger.

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
