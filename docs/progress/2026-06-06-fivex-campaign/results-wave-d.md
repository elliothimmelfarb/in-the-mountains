# 5× Campaign — Wave D results (COIN strategic soul) — verified

The biggest strategic lever: "Counterinsurgency is the real game" was mechanically DEAD (score spread 0.5).
Now it discriminates. Files: `lib/sim/world/{world,types,create,projects,tasks,events}.ts`, new
`lib/sim/world/directives.ts`, `lib/sim/campaign.ts`, `scripts/campaign-loop.ts`, `state/store.ts`,
`components/screens/DeployScreen.tsx`. Adversarial-verified; determinism contract independently confirmed.

## The flip (default 3×8 tour, campaign-loop.ts)
| metric | HEAD baseline | After | Verdict |
|---|---|---|---|
| Tour score: careful COIN vs body-count | 38.0 vs 37.5 (**spread 0.5**) | **60.0 vs 29.7 (spread 30.3)** | ✅ discriminates (target >25) |
| Careful COIN moves mean attitude | Δ +0.3 (flat) | **Δ +7.7** (vs body-count +0.1) | ✅ |
| CERP projects completed / tour | 0 (all 6 SABOTAGED) | **1.3–2.0 secured & completed** (4/4 on survey-40) | ✅ |
| CERP economy | one-way drain 30000→0 | **two-way** (stipend +5000/6–8d + project reimbursement); ever-rose yes | ✅ |
| Directives | dead; never fail; penalty never fires | **cadence 2.3–3.3/tour; fail FIRES at deadline** (D14 presence −10, confidence 60→50 exact) | ✅ |
| KLE / shura | 360s attitude-drip timer | **elder ASK raised; kept +10 / BROKEN −12** (exact, asymmetric) | ✅ |
| Secure-build order | none (#1 API gap) | **`World.secureBuild(memberIds, villageId, …)`** — patrol-level garrison order; harness drives it | ✅ |

## Determinism contract — independently confirmed (the #1 risk of this wave)
- Every new persisted field is in BOTH `serialize()` and `loadWorld()`: `WorldState.{nextCerpStipendAt,
  nextDirectiveAt, civCasualties, reliefWatchClock}`, `VillageState.{ask, brokenPromises, keptPromises}`,
  `Directive.startMetric`, `Task.secureVillageId`.
- **serialize→load→serialize round-trip BYTE-IDENTICAL (240,893 == 240,893)** — the strongest proof no field
  was dropped from loadWorld. Same-seed campaign-loop byte-identical ×2; smoke serialize round-trip OK.

## How it was made true (engineering)
- `computeTourScore` reweight (world.ts): `coin = projComplete×11 + dirComplete×4 + kept×3 + wonOver×3`;
  attrition only ×0.06; penalties civcas×8 + broken×5 + dirFailed×4 + kia×1.5. Winning the valley now
  out-weighs the body count.
- Sustained **relief-of-command** (FM 6-22): a 3-day review watch, not a single-firefight confidence spike.
- New `directives.ts`: issuance cadence + the 5 previously-dead DirectiveKinds + deadline/penalty enforcement.
- `secureBuild` + `secureHold` (tasks.ts): an element routes to the site (reachability-aware) and holds an
  open-ended overwatch; `securityAt` now counts the held element, so projects complete instead of sabotaging.
- HUD (store.ts/DeployScreen): directive feed w/ status, secure-build affordance, project/CERP status,
  boots-paused fix (clock runs after Step Off), call-for-fire hotkeys (F approve / X deny while pending).

## Honest residual (logged, NOT closed — Law 5/8) → issue 015
Held-out 4×14 tail does NOT discriminate on average (careful 27.5 vs body-count 30.5, **spread −3.0**) — BUT
this went from **inverted (−26.8)** to **bimodal**: where a careful tour survives it CRUSHES body-count
(survey-40 careful **96**, 4/4 projects, vs 29 — the seed that scored 2 pre-fix), while on 2/4 combat-heavy
seeds a scripted presence patrol (routed at the MOST hostile village — adversarial) takes a catastrophic
firefight → early relief → 0. Root cause: **coarse-dt harness + tactically-naive scripted patrol routing**,
NOT the COIN engine (which completes projects + moves attitude Δ+7.6 on every held-out seed). The validate
stage FIXED the instrument (adaptive fine-dt sub-step while a mobile patrol is in contact) rather than
curve-fitting the score, and did NOT touch the combat/movement guardrails. A clean held-out proof needs
smarter scripted routing or fine-dt patrol windows — logged for a future wave.

## A process win worth noting
The validate stage caught its predecessor's mislabeled "all-PASS" (the held-out had actually inverted),
root-caused it to the harness lying about combat (coarse DT=30 over-marched careful patrols into ambushes:
23 KIA at DT=30 vs 11–12 at fine dt on survey-40), and corrected the *measurement*. Law 4 (the oracle must
obey the mover's real rules) lived: a coarse-dt combat oracle was over-killing and lying.
