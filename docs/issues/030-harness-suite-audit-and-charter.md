# 030 — Harness suite audit: the WIA-band blocker + the charter

**Status:** ✅ CORE RESOLVED 2026-06-26 (charter + COIN gate + balance re-anchor shipped) · 🟡 residual
debt + coverage gaps tracked below · **Found:** owner audit request, 2026-06-26

## What the owner asked

> "Deep audit of all our benchmarks and smoke tests … we've been developing against test harnesses
> … I wonder if they've become actual blockers to improving this game … make them ready to improve
> the game by 100%, or identify where the harnesses are holding us back and remove them."

## The finding (confirmed with primary sources + a measurement)

The 84-file suite is **mostly healthy** — most files are clean probes that print numbers and assert
nothing; the real gates (`smoke.ts` no-NaN/serialize/material-hash) are legitimate invariants. There
is **one** genuine blocker, and it is a *practice*, not a file:

**The "~8.58 WIA band" was a baseline-as-target overfit.** The number is the wounded-per-deployment
that one `balance.ts` run printed when aspect-vegetation shipped at strength 0.05
(`terrain.ts:665`, issue 007) — a sim output with no doctrine anchor. Treated as a target it:
- flagged HEAD's safer WIA of 6.92 as "below band, watch it" (issue 026) — *fewer wounded = defect*;
- set the stopping point for the issue-027 trail-network realism win (narrowed to "WIA 8.42, inside
  the band");
- reverted realism features (open-ground cover, 020; HVT dispersion/threat-weighting, 022).

And it was policed **finer than the harness's own noise.** Measured 2026-06-26 — four independent
12×50 prefixes (deterministic per prefix): WIA **{bal 7.08, balC 2.67, balD 5.00, balE 9.42}**, mean
6.04, **range 2.67–9.42** (spread 6.75), **σ ≈ 2.5**. The band policed deltas of ~1.0–1.5 — half its
own 1σ noise. (Issue 026 had listed "balance.ts run-to-run σ floor" as open debt; it had never been
measured.) Structural irony: the firefight was gated while the design's actual **win condition**
(COIN) had a probe — `campaign-loop.ts` — but no gate.

## What shipped

1. **The charter — `docs/wiki/Harnesses.md`.** Gate-vs-probe definitions; the governing law (*a gate's
   threshold may never be the sim's own past output*); the win-condition-first principle; the coverage
   gaps; an add-a-harness checklist. CLAUDE.md's "Done means" + Pointers wire it in.
2. **COIN promoted to the win-condition GATE — `campaign-loop.ts` (infrastructure in; practical config
   NOT yet calibrated).** The verdict now tallies failures and `exit(1)`s if the strategy layer goes
   inert; every assertion is a design oracle, not a fitted number. **Day-one reality
   (`evidence/coin-gate-day-one.md`):** the gate is **not yet a clean green standing check** — the
   3-seed default is impractically slow (did NOT finish in ~40 min wall; one heavy seed under
   weapons-free body-count is 9–15 min), and the fast 1-seed/8-day config **under-discriminates**
   (survey-0 spread 3.0, FAIL). The durable wins are the **exit-code** + the **charter principle** (the
   win condition deserves a gate). The required follow-on is a **fast, deterministic, pre-vetted COIN
   gate config** at a horizon long enough to discriminate — real calibration work (the fast-vs-reliable
   tension is genuine), logged not guessed. Whether COIN has *regressed* since 015 is unconfirmed.
3. **`balance.ts` re-anchored.** Header + output state plainly: casualties are a DIAGNOSTIC, not a
   target — there is no WIA band to defend. It prints the measured σ floor (`WIA_SIGMA_FLOOR = 2.5`)
   so no future delta is ever read finer than the noise. The no-NaN + no-stall gates are unchanged.

Evidence + the published explainer: `docs/progress/2026-06-26-harness-charter/` and
`public/manual/archive/reports/2026-06-26-harness-charter/`.

## Residual / deliberately NOT done (open for a future pass)

- **σ measured at n=4.** The RANGE (2.67–9.42) is robust, but the σ≈2.5 point estimate is from four
  draws; a 10–20-prefix run would tighten it. The `balance.ts` constant is documented as approximate.
- **Coverage gaps (candidate new harnesses, listed in the charter):** no standing gate for **AI
  tactical quality** (squad-maneuver / cell-coordination / autonomy run on-demand only), **render /
  lighting coherence** (the WebGL overhaul shipped on screenshots + ad-hoc luma), or **pacing / TIC**
  (`tic-release-probe`, issue 025, not standing). Each is a probe-first, oracle-gated build.
- **Harness debt NOT cleaned (low value, deliberately deferred):** 6 committed `scratch-*` files — some
  are durable visual tools that earned their keep (`scratch-shot1`, `scratch-pngluma`, `scratch-pngdiff`,
  used in the 2026-06-26 shadow work) and should be *renamed* to real names per charter principle 5;
  others are spent ("delete after C3"). Plus ~11 overlapping movement probes for a now-settled
  subsystem (consolidation candidate). None of these is "holding us back" (the blocker was the
  practice), so the rename/consolidate churn was deferred in favour of the high-value re-anchor.
- **COIN gate runtime.** The default (3 seeds × 8 days) is ~8 min wall — fine for a pre-commit gate but
  heavier than smoke/balance. If it becomes friction, a 1-seed fast mode exists (`campaign-loop.ts 1 8`).
