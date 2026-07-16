# 035 — Relief-of-command is an opening-days lottery that censors ~half of careful tours

> **Ledger status (verified 2026-07-16 @ da10926):** OPEN — mechanism confirmed current: relief fires on a sustained confidence dip (`reliefWatchClock`, RELIEF_WINDOW 3 days, world.ts:610-637) but with NO opening grace window, NO cause attribution, and it still censors the whole tour score. Combat+director domain, not a harness fix (contained for gating via paired-best-seed in 030).
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: Low–Medium (design smell / COIN-gate noise source; combat + director
domain).** Surfaced repeatedly during the 2026-07-02 realism campaign's COIN-gate
de-noising (`3666d14`, `9c031da`). Relief-of-command (`lib/sim/world/world.ts:~617-637`)
censors a whole tour's score to ~0 when opening-days casualties cross a threshold — but
those opening-days fights are **trajectory-chaotic and policy-blind** (they happen
before the player's COIN choices have had time to matter), so *whether you get relieved*
is closer to a coin-flip than a verdict on how you commanded. Measured: **~50–60 % of
8-day careful tours are relieved**, flooring per-seed careful scores into a **bimodal**
distribution (0 relieved | ~28–69 survived; measured survival ~5/12 over the campaign's
runs). Evidence: `docs/progress/2026-07-02-realism-campaign/after/coin-*` and
`.../after/trails-2a/campaign-loop-*.txt`.

## Why it is a problem

1. **It is the dominant COIN-gate noise source.** Because the 3-seed *mean* careful
   score is a survivor-count lottery, a **single extra world-init RNG draw with zero
   behaviour change** was measured swinging the 3-seed mean spread **37.3 → 18.3** at one
   commit, and a second null draw **relieved all 3 careful tours** at the next
   (`after/coin-q1-noise-table.txt`). The campaign had to re-anchor the gate onto the
   **paired best seed** + a censored-draw tier (`3666d14`) precisely to route around this.
   The lottery is now *contained* for gating purposes but not *fixed* at the source.
2. **It reads as unfair in play.** A careful commander who takes early contact through
   no fault of policy can lose the whole tour to a relief that a body-count commander,
   luckier in the opening days, survives (observed: bodycount survey-41 lucked into
   score 14 while careful survey-41 was relieved d4 — same byte-identical world layout).

## The smell, precisely

Relief is being driven by an **outcome the player cannot yet have influenced** (opening
casualties, RNG-chaotic) rather than by a **pattern of command** (repeated ROE breaches,
sustained neglect of force protection, civilian-casualty trend, missed directives). A
relief mechanic is *good* design — it is one of the few strategic consequences with real
teeth — but it should fire on a legible, policy-attributable trajectory, not a day-3
dice roll.

## Suggested directions (combat/director domain — NOT a harness fix)

- **Grace window + trajectory, not a single threshold.** Base relief on a *trend* over
  several days (casualty rate, ROE violations, civ-cas, directive failures) with an
  opening grace period, so it discriminates command *patterns* the player owns rather
  than opening-day variance.
- **Attribute the cause.** When relief fires, it should be explainable ("three ROE
  breaches + two lost directives + civilian casualties trending up"), which also makes
  it teachable and fair.
- **Decouple from the score censor.** Consider a partial score penalty for a relieved
  tour rather than flooring it to ~0 (a relieved-but-not-zeroed tour still carries the
  COIN signal it earned before the relief).

## Repro recipe

1. `npx tsx scripts/campaign-loop.ts 3 8` (3 seeds × 8 days, careful vs body-count) and
   watch the per-seed careful `endDay` / `relieved` in the day dumps — expect ~half the
   careful tours to end early via relief with score ~0.
2. Add one `rng.next()` at world init (`lib/sim/world/create.ts`, zero behaviour change)
   and re-run: the set of relieved tours changes, confirming the relief is RNG-trajectory
   driven, not policy driven (the exact null-perturbation control from `3666d14`).

## Relevant code

`lib/sim/world/world.ts` (relief-of-command logic, ~617-637), `lib/sim/world/create.ts`
(world-init RNG order), `scripts/campaign-loop.ts` (the gate that has to route around
this today). Cross-ref: issue 030 (harness charter — this is the measured root cause of
the COIN-gate's noise floor) and issue 015 (the COIN strategic layer this belongs to).
