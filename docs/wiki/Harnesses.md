# Harnesses — the charter

> *A harness exists to let you change the game with confidence. The day it instead stops you from
> improving the game, it has inverted its purpose and must be re-anchored or removed.*

This page is the **constitution for the test/benchmark suite** (`scripts/*.ts`, run via `npx tsx`,
no jest/vitest). It exists because a 2026-06-26 audit found the suite had quietly grown one real
**blocker** — not a file, a *practice* — and was missing a gate on the thing the design says is the
whole point. Read this before you add, delete, or "tune to pass" any harness.

## The two kinds, and the one law that separates them

- **GATE** — a hard pass/fail that *blocks a change*. A gate may only assert an **invariant** or a
  **design oracle**: something that is true by the contract of the game or by doctrine, independent
  of what the sim currently outputs. Determinism. No-NaN. "A secured CERP project completes." "The
  gate is passable." "Civilians are home at night." These are knowable without running the sim.
- **PROBE** — measures and *informs*. It prints numbers; it asserts nothing (or only NaN). A probe
  is where you look when a number moves, to decide — with judgment — whether the move is good.

**THE LAW: a gate's threshold may never be the sim's own past output.** The moment you write
`assert(metric ≈ <whatever it does today>)`, you have frozen the present and criminalised every
future improvement that moves the number. That is a curve-fit wearing a lab coat. If you cannot
justify a threshold from the *design* or from *cited doctrine* (FM/ATP 3-21.8, FM 7-8, FM 3-24,
named first-hand accounts), it is a **probe**, not a gate.

## The cautionary tale (why this page exists)

`balance.ts` reports tactical casualties from 12 deployments. It hard-asserts only no-NaN and a
no-stall watchdog — both legitimate invariants. But a **social gate** grew on top of it: a
remembered "**~8.58 WIA band**" that development came to treat as a target.

That number's provenance: it is the WIA output of *one* `balance.ts` run at the moment
aspect-vegetation shipped at strength 0.05 (`terrain.ts:665`, issue 007: "WIA 6.17→**8.58**"). It
has **no real-world anchor.** Yet it then:

- **Flagged safer outcomes as defects.** Issue 026 recorded HEAD's WIA of 6.92 as "*below band*,
  watch it" — i.e. *fewer wounded friendlies* was treated as a regression to correct **upward**.
- **Set the stopping point for a realism win.** Issue 027 — denser trails, where "patrols riding the
  network IS the realism" — pushed WIA to 12.58; the work was narrowed not until it was *right* but
  until "WIA 8.42, inside the ~8.58 historical band."
- **Reverted realism features.** Open-ground cover was cut for moving WIA +89% (020); COP HVT
  dispersion + threat-weighting reverted for +1.00/+0.50 KIA (022).

And the band was policed **finer than the harness's own noise.** `balance.ts` is deterministic per
seed-prefix, so re-running `bal` gives the identical number — but each prefix is just one 12-sample
draw. Measured 2026-06-26 across four independent prefixes: WIA = **{7.08, 2.67, 5.00, 9.42}**, mean
6.04, **range 2.67–9.42** (spread 6.75), **σ ≈ 2.5**. The band policed deltas of ~1.0–1.5 WIA — *half*
its own sampling noise; four identical-config draws spanned more than **4×** the delta that triggered a
revert. Issue 026 itself listed "balance.ts run-to-run σ floor" as open debt; it had simply never been
measured. It now prints on every run.

None of this was malice — it was a missing principle. Here it is.

## Principles

1. **Casualties are a DIAGNOSTIC, never a target.** WIA/KIA from `balance.ts` tell you *what
   changed*, not *what should be*. Never narrow, revert, or "rebalance" a realism improvement to make
   a casualty number return to its historical value. If a defensible change moves casualties, the
   honest move is to **report the new number and say why it is right** (cited to doctrine or the
   design), not to engineer it back.
2. **Respect the noise floor.** A casualty delta inside the between-sample σ is **noise**, not a
   finding. `balance.ts` now prints the σ; treat anything within it as flat. Want a real read on a
   casualty change? Run **held-out seed prefixes** and look at the spread, not one number.
3. **The win condition gets a gate; the firefight gets a probe.** The design's soul is *"you can win
   every firefight and still lose the valley."* So the **standing gate is the COIN discriminator**
   (`campaign-loop.ts`: does playing COIN well beat playing it badly?), and the firefight is a
   diagnostic probe. The gravity well of routine verification must pull toward the win condition, not
   away from it.
4. **A gate asserts an oracle, a probe reports a number.** Before adding any `process.exit(1)`, ask:
   *is this threshold knowable without running the sim?* If no → make it a probe.
5. **Disposables are disposable.** A `scratch-*` harness is deleted when its campaign ships (the
   `metricize` rule). A `scratch-*` that proved durable is **renamed to a real name** and kept. A
   committed `scratch-*` is debt — resolve it, don't let it accrete.
6. **Coverage is not free, but stale coverage is a tax.** A probe for a long-resolved bug is cheap to
   keep and occasionally catches a regression — keep it, but say so in its header (`# regression
   probe for issue NNN, resolved`). Eleven overlapping probes for a settled subsystem is a smell:
   consolidate.

## The standing checks (what "Done means" runs)

| Check | Kind | Asserts | Why it's legitimate |
|---|---|---|---|
| `npx tsc --noEmit` / `npm run build` / `eslint` | gate | compiles, builds, lints | invariant |
| `scripts/smoke.ts` | gate | no-NaN; serialize round-trip; **material-lib hash pin** | determinism invariants (the hash is an intentional change-detector — re-pin on purpose) |
| `scripts/balance.ts` | **probe** + no-stall **gate** | no-NaN; no stranded mover. Casualties are **printed, not asserted**, with the σ floor | the stall is an invariant; casualties are a diagnostic (this page) |
| `scripts/campaign-loop.ts` | **gate** (the win-condition) | COIN **discriminates** (careful beats body-count), attitude moves, directives live, CERP two-way, enemy dynamic, projects complete | every assertion is a **design oracle**, not a fitted output |
| `scripts/enemy-network-probe.ts` | **gate** (order-of-battle invariants) | same-seed byte-identical serialize; Σ cells === derived scalar; roster conservation (exfil net-zero, KIA −1); cache economics; leader succession; located-intel truthiness; save round-trip + pre-v10 migration | every assertion is a conservation/determinism invariant or a design oracle (2026-07-16 wave) |

> **COIN-gate cost & scope.** `campaign-loop.ts` runs a multi-day sim per seed (minutes/seed; a heavy
> seed can run 10–25 min, and the event-driven pacing re-anchor of 2026-07-03 puts the 3-seed default
> at ~30–40 min wall), so it is a **pre-merge check for sim / AI / COIN / balance changes**, not an
> every-commit gate. **One seed is too noisy to gate on** (survey-0 alone gives a ~3-pt score spread and
> fails to discriminate) — use the 3-seed default. A faster, more deterministic "COIN smoke" variant
> suitable for routine gating is an open coverage item.
>
> **COIN-gate noise floor & censoring (measured 2026-07-03).** A tour's score is **censored by
> relief-of-command**: the opening-days combat lottery (trajectory-chaotic, policy-blind) relieves
> ~half of careful tours at the 8-day horizon and floors them at ~0, so per-seed careful scores are
> bimodal (0 relieved | ~30–70 survived). **One extra world-init RNG draw — zero behavior change —
> swung the 3-seed mean spread 37.3 → 18.3 at the same commit** (and a second null draw at the next
> commit relieved all 3 careful tours). Mean-spread deltas of ~±19 are therefore **noise**. The
> discrimination checks accordingly key on the **paired best seed** (same valley, only the policy
> differs), and a **fully-censored draw** (0 careful survivors) asserts liveness + ordinal dominance
> only, reporting magnitudes as CENSORED rather than red — see the verdict comments in
> `campaign-loop.ts` and `docs/progress/2026-07-02-realism-campaign/after/coin-*` for the evidence.

## Coverage gaps (candidate NEW harnesses — the "improve the game 100%" list)

These dimensions have **no standing protection**. Building any of these *enables* improvement (each
is a probe-first, oracle-gated instrument, never a baseline freeze):

- **AI tactical quality** — `squad-maneuver-probe`/`cell-coordination-probe`/`autonomy` exist but run
  only on demand. "The hardest part of command is watching" has no standing bar that the AI fights
  *well*.
- **Render / lighting coherence** — the WebGL overhaul shipped on screenshots + ad-hoc luma reads.
  An oracle is possible (e.g. *the same scene at noon vs golden differs only in graded exposure, not
  in relief contrast*; *no object is darker than its own cast shadow*).
- **Pacing / TIC** — `tic-release-probe` (issue 025) is not standing; the one-way speed latch is a
  known footgun.
- **Run-to-run variance** — bake the σ floor into `balance.ts` permanently (done) so no future
  casualty delta is ever again read finer than the noise.

## Durable probes added by the 2026-07-03 realism campaign

Four coverage gaps recorded in the campaign's `CONTEXT.md` (no curvature metric, no
terrain roughness/relief-spectrum metric, no doctrine-pace check, no in-combat movement
probe) are now filled by durable, oracle-*informed* probes (they print; they do not
assert sim-output baselines — Law-compliant):

- **`scripts/route-smoothness.ts`** — planned-route small-angle turn density + terrain
  response (contour vs fall-line, cited to the USFS half-rule) + executed-track weave;
  `ITM_NOMEANDER` A/B. *This is how "squiggly" was proven to actually be too-straight.*
  (Re-aim noted in issue 034: wall-mask the contour/fall split.)
- **`scripts/terrain-roughness.ts`** — slope percentiles, band energy (E5-15/E15-45),
  wall-reversal density, 100 m local relief, floodplain rim seam, transect CSVs, all
  against the real-Korengal oracle. *This is how "too smooth" was quantified and the
  strata pass verified.*
- **`scripts/doctrine-pace.ts`** — patrol effective km/h vs FM 21-18 (2.4 kph day) and
  the FM 3-97.6 ascent tax. *This is how the 2.45× uphill over-speed and its fix to
  ~1.0 were measured.*
- **`scripts/combat-grind.ts`** — the in-combat movement probe (renamed from a
  `scratch-*` per Principle 5): grind events, blocked-% of contact, impassable-goal
  time, worst-frozen-unit, bounds-completed, post-contact wipe zombies. *All existing
  movement probes were patrol-based (combat-free); this one covers the fight, where the
  real "stuck" bug lived.*

## How to add a harness (the checklist)

1. Decide **gate or probe** by the Law above. When unsure, probe.
2. If a gate: write the oracle in the header — *what must be true, and why (cite it)*. No sim-output
   constants.
3. Baseline on HEAD, make the change, re-measure, prove on **held-out seeds**, verify in-app
   (the `metricize` skill is the full playbook).
4. If it's a `scratch-*`: delete it when the campaign ships, or rename it if it earned its keep.
