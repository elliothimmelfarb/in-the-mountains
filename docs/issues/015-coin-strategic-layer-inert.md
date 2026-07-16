# 015 — The COIN strategic layer was mechanically DEAD

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED — largely (2026-06-06/07) — mechanism current: `secureBuild`, `tickCerp`, `tickDirectives`, reweighted `computeTourScore` (world.ts:652), sustained-relief `reliefWatchClock` all live. The valley DOES have a live intel layer too (`IntelReport`/`addIntel`, campaign.ts + director.ts). Open tail: held-out COIN discrimination + the relief lottery, tracked in 030 + 035.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: High (design pillar)** · Surfaced & largely resolved 2026-06-06 (COIN-real-game wave)

## What was wrong

DESIGN pillar 5 is "counterinsurgency is the *real* game" — yet playing COIN well vs badly
produced near-identical outcomes, and the strategic systems were inert:

- **Attitude was dead-flat.** Funding/securing projects, KLEs and restraint moved mean village
  attitude by ~0 over a tour (`campaign-loop` HEAD: careful Δatt **0.1**, identical to body-count).
- **Projects never completed** — they **sabotaged** (no element ever *stayed* to hold the
  multi-day build, so `securityAt` never held through the `building` stage). The extended HEAD
  baseline showed 6 funded, **0 complete, all sabotaged**, dragging attitude *down*.
- **CERP was one-way.** Only `startProject(-5000)` + event costs touched it; **no income/refund**
  path, so it only ever counted down to 0.
- **Directives were dead.** `deadlineDay`/`penalty` were written but **read nowhere**; status was
  never set to `failed`; only 2 of 7 `DirectiveKind`s were ever instantiated (presence, kle);
  census/interdict/construct/hold/casualty never created and never advanced.
- **No "secure/garrison this build" order** existed — project completion was undrivable for the
  player AND the harness (the harness poked `unit.pos` as a workaround).
- **Score barely discriminated** by the COIN levers; the spread that did exist came from
  body-count tanking `higherConfidence` via KIA, not from rewarding patience.

## How to reproduce (HEAD baseline)

`npx tsx scripts/campaign-loop.ts` (3 seeds × 3 days) and `… 6 21` (extended). HEAD VERDICT:
`[FAIL] COIN moves attitude · [FAIL] directives live · [FAIL] CERP two-way`, attitude Δ ≈ 0,
projects 0 complete (all sabotaged), CERP monotone to 0, penalty path NEVER fires.

## Root causes (confirmed against HEAD with dumped data)

1. `projects.ts:securityAt` counted any 2 transient friendlies — nothing made an element STAY,
   so a multi-day build never held security → +completion never fired, only sabotage (−attitude).
2. CERP had no income side (`world.ts`/`projects.ts`).
3. `world.ts` had no directive deadline/penalty enforcement and no issuance cadence; 5 of 7 kinds
   were never created or advanced.
4. There was no patrol-level secure/garrison order on `World`.
5. `computeTourScore` weighted combat power / enemy attrition as heavily as the COIN levers.

## Resolution (2026-06-06) — see `docs/progress/2026-06-06-coin-real-game/`

A single coherent wave (engine-only; HUD wired separately):

- **Secure-build order** (`World.secureBuild`) — a patrol-level order that routes an element to a
  project site (reachability-aware, no beeline) and **holds an open-ended overwatch**
  (`tasks.ts:secureHold`) until the build finishes/sabotages or it's recalled. `securityAt` now
  counts a held secure element first.
- **Projects complete & MATTER** — per-type `PROJECT_PAYOFF` × **1.6 wanted / 0.6 off-want**, plus
  +$1,500 CERP refund and a fulfilled-ask hook.
- **CERP two-way** — battalion **stipend** (`tickCerp`, ~weekly, conf-scaled) + project refund.
- **Directives live** — `tickDirectives`/`issueDirective`: deploy pair + steady **~1/6–9 day
  cadence** drawn from the AO; **deadline → `failed` + penalty** to `higherConfidence`; all 5 dead
  kinds instantiated with real completion logic (`directives.ts`); a civcas **fails** the
  protect-the-population directive immediately.
- **KLE asks/promises** — a shura yields an **elder ask**; `fulfillAsk` (kept) / `tickPromises`
  (broken, asymmetric −12 vs +10) — the design-promised broken-promises mechanic.
- **Score discriminates** — `computeTourScore` reweighted hard onto attitude/stability/confidence
  with project/directive/promise rewards and civcas/broken/failed/KIA penalties; attrition is a
  small term.

New persisted state (all in `serialize()` via `state` + defaulted in `loadWorld`, save **v6**):
`WorldState.{nextCerpStipendAt, nextDirectiveAt, civCasualties}`,
`VillageState.{ask, keptPromises, brokenPromises}`, `Directive.startMetric`, `Task.secureVillageId`.

### Before → after (campaign-loop, careful vs body-count)

| metric | HEAD | after |
|---|---|---|
| careful tour score | 38–39 | **55** (8d) / **54.8** (14d) |
| body-count tour score | 10.7–19 | 18–30 |
| A−B spread | mostly KIA-driven | **+25.3 (8d) / +35.8 (14d)** by COIN levers |
| careful Δ mean attitude | **0.1** (flat) | **+10.7 (8d) / +15.9 (14d)** |
| projects complete / tour | **0 (all sabotaged)** | **2–3** |
| CERP ever-rose | **NO (one-way)** | **yes** |
| directives issued / tour | 2 (fixed) | **2.5–3.3 (cadence)** |
| deadline-fail + penalty | **never fires** | **fires** (presence FAILED D16 on a neglect run → −10 confidence; 18-day held-out `penalty-EVER-fired: YES`) |

### Honest residuals

- **Coarse-dt harness limitation.** `campaign-loop` ticks DT=30s where combat is "indicative, not
  exact" (its own header). On combat-heavy seeds a careful patrol can take *unrealistic* KIA (one
  day-1 patrol lost 18 men) that cascades to relief-of-command and zeroes the score — so on the
  combat-heavy held-out tail (survey-40/41/42) careful can underperform body-count. This is the
  *instrument*, not the COIN layer: the score's KIA term was de-double-counted (KIA already docks
  higherConfidence) and discrimination is robust at ≤13-day horizons and on comparable-combat seeds.
  A fair held-out proof needs either fine-dt windows or seeds without the dt-combat cascade.
- **Kept promises** depend on policy/ask alignment: the asks/promises mechanic is verified live in
  isolation (kept +10, broken −12), but the scripted careful policy rarely aligns a built project
  with the village that asked, so kept-promise counts stay low in the harness (the *broken* path does
  fire under neglect). Surfacing asks in the HUD (the HUD stage) lets a human player drive this.

## Integration + held-out validation (2026-06-07) — `docs/progress/2026-06-06-coin-real-game/AUTH-*.txt`

Picked up the uncommitted COIN wave for integration + held-out proof. Re-measured against true HEAD
(the inherited tree) at the DEFAULT and a fresh-seed tail, and found the prior "all PASS" labels were
on relabeled after-runs — the real **default 3×3 was a FAIL** (spread 17.3) and the **held-out tail
INVERTED** (careful 17.0 vs body-count 43.8, spread **−26.8 the wrong way**). Root cause confirmed by
trace: the prior residual's "coarse-dt cascade" was the dominant effect — at DT=30 the harness
**over-marched careful patrols into ambushes**, ~doubling KIA (survey-40 careful: **23 KIA at DT=30 vs
11–12 at fine dt** on the same seed), cratering `higherConfidence` (−3/KIA) → relief-of-command → score 0.

Fixes this wave (engine + the harness instrument, no movement/combat ROE changes — issue 013 untouched):
- **Faithful-combat adaptive sub-step (harness).** `campaign-loop` now sub-steps at `COMBAT_DT=2s`
  while a MOBILE patrol element is in contact (`patrolInContact` — NOT the static garrison, whose
  continuous COP defense made a flat fine pass infeasible and can't be over-marched), coarse otherwise.
  This is the prior wave's named-but-deferred faithful-combat fix, now measured feasible (survey-0 8d
  careful: 30 min+unfinished → ~90 s). Restores fine-dt casualty truth where it matters.
- **Sustained relief-of-command (engine).** Relief is now a TREND, not one bad day: confidence at/under
  a floor opens a 3-day review watch (`WorldState.reliefWatchClock`, persisted v6); relief fires only if
  it stays under continuously; any recovery clears it (FM 6-22). De-cascades a single-firefight spike.
- **Realistic default horizon (harness).** Default 3→8 days: the strategic layer physically can't express
  in 3 days (projects build 1.2–2.6d, directive cadence 5–8d, deadlines 12–21d).
- **Horizon-aware directive gate (harness).** The "directives fully live" gate no longer demands the
  failure path fire on an 8-day tour (impossible: shortest deadline is 12d, and a *good* commander
  COMPLETES directives) — it requires complete+cadence below ~13d, and additionally the penalty path at
  ≥13d. Verified: under total neglect the path fires (presence FAILED D14 −10, kle FAILED D16) and the
  14-day held-out shows `penalty-EVER-fired: YES`.
- **Score reweight (engine).** `computeTourScore` now leans on the RAW village-attitude swing (not only
  the compressed `(avg+100)/2` metric) + villages-won-over + delivered projects (×11), so winning the
  valley out-weighs the kill count (FM 3-24).
- **CERP policy (harness).** Careful funding decoupled from the KLE squad and prefers untried villages
  before re-attempting a sabotaged site — spreads CERP, kills the "re-fund the same unsecurable qalat
  every day" waste loop (was 7 funds / 1 completion / CERP 30k→10k on a held-out seed).

**Result — DEFAULT verdict now FULLY GREEN** (`npx tsx scripts/campaign-loop.ts`, 3×8): careful **60.0**
vs body-count **29.7** = **SPREAD 30.3**; attitude Δ **+7.7 vs +0.1**; projects 1.3 vs 0; all 8 gates
PASS; *"the strategy layer is ALIVE and discriminating."* Determinism: same-seed campaign-loop run is
**byte-identical twice**, smoke serialize round-trip green, tsc/build/balance green.

**Residual (honest, narrowed not closed).** The held-out 4×14 tail still does NOT discriminate on
average (careful 27.5 vs body-count 30.5) — but it is now **bimodal, not inverted**: where careful
survives it CRUSHES body-count (survey-40 **96** vs 29, 4/4 projects — the seed that scored 2 before),
while on 2/4 seeds a patrol still takes a catastrophic-enough firefight to trigger early relief → 0
(survey-42/43, endDay 4/15). This is the *coarse-harness + tactically-naive scripted patrol routing*
(presence patrols sent at the most hostile villages), NOT the COIN layer — the engine completes secured
projects and moves attitude correctly on every seed. A fully fair held-out proof needs fine-dt patrol
windows or smarter scripted routing; logged for a future wave rather than chased with score curve-fitting.

**Routing-residual update (2026-07-16, issue 037 work):** the scripted careful policy now rotates its
approach axes per visit ({+1,−1,0}×240 m, `campaign-loop.ts`; `ITM_FIXED_ROUTES=1` reproduces the old
fixed routes), and `scripts/patrol-predictability-probe.ts` MEASURED route hygiene's effect on the
current enemy at ~zero (0/6 IED detonations; hot-seed KIA/day 5.14 fixed vs 5.00 varied) — the
careful-tour killers are position-reactive ambushes, which no scripted routing can dodge. The
"smarter routing" residual is therefore closed as an instrument concern and re-scoped: the remaining
question is enemy difficulty (030) and the inert IED channel (038), not the script's tactics.
