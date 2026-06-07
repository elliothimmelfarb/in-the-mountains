# 5× Campaign — verbatim HEAD baselines (2026-06-06)

Captured BEFORE any code change, on `main` @ `c6bf324`. These are the numbers every
"improved" claim in this campaign is measured against (Law 1: no fix without a number;
Law 5: report numbers-first).

## Standing checks
- `npx tsx scripts/smoke.ts` → **SMOKE OK** (builds world, 30 game-min, no NaN, serialize round-trip; save 128.9 KB, 70 units)
- (tsc / build / lint not yet re-run this session — green at last commit per git history)

## Balance — `npx tsx scripts/balance.ts 12 50`
> Ran 12 continuous deployments, 50 game-min each (1 squad + medic patrol, heat ~0.6–0.9):
> - Contacts: **12/12** runs saw a firefight · avg peak enemies on map **8.3**
> - Avg US **KIA 0.75** · Avg US **WIA 5.58** · Avg **enemy accounted 1.25** · **Civ cas 0**
> - ✓ No elements left stranded mid-route.

### Reads off the baseline (hypotheses to validate, not yet confirmed)
1. **Inverted exchange ratio (H-LETHALITY):** ~6.3 friendly casualties vs 1.25 enemy accounted per
   contact. Real US infantry won firefights tactically; this is backwards. Validate whether US fire
   is under-effective, enemy fire over-lethal, or "enemy accounted" undercounts exfil/evac fighters.
2. **Civ casualties always 0 (H-CIV-PRESENCE):** is the civ-fire gate doing it, or are civilians not
   present in firefights at all (so "fighters meld into the population" never bites)?

## Smoke log texture (Day-1 first patrol)
- 2 KIA at 06:14, ~1 min after "objective complete" on the return leg — casualties arrive fast and
  early; the first contact of a tour is already costly.

## Independent code-read facts (for downstream agents — VERIFIED CODE FACTS)
- Engine is genuinely deep: `lib/sim/ai/squad-combat.ts` (react→hold/suppress/assault/break, scored
  base-of-fire vs maneuver `assignElements`, leapfrog rally, smoke screening, PID + danger-close
  `maybeRequestFires`/`fireAimpoint`), `lib/sim/ai/insurgent.ts` (ambush→engage→scoot→exfil, IED
  L-ambush), `lib/sim/world/director.ts` (heat-driven tempo: ambush/IED/infil/harass/complex/indirect).
- Combat is already legible: `lib/render/combat-fx.ts` Combat Visual Language (threat-bearing
  crescent, pinned ring, arterial bleed pool, buddy-aid tether, danger-close halo, TIC-onset
  starburst, suspected-shooter pinpoints, LOD combat-haze, scorch decals).
- **AUDIO SEAM (for the audio system):** render-side, determinism-safe. Subscribe from the RAF
  `frame()` loop (state/store.ts) the same way `noteCombatEffects` does:
  - `sim.effects: Effect[]` — `EffectKind = muzzle|impact|ricochet|blast|blood|frag_air|smoke_pop|flare`,
    each with monotonic `id`, `pos`, `faction`, `size`, `facing`, `ied` (lib/sim/combat.ts:26–47).
  - `LogEntry` bus via `addLog(msg, kind)` — `LogKind = info|contact|casualty|kia|radio|support|objective`
    (lib/sim/combat.ts:49–56).
  - `FireMission` status `requested→inbound→firing→complete` + `etaS` + `dangerClose` = the "shot/splash"
    of indirect (lib/sim/combat.ts:66–80).
  - **Zero audio dependencies in repo** → procedural Web-Audio synthesis (no binary assets), client-only,
    unlocked on first user gesture (Next 16 App Router + browser autoplay policy).
- COIN layer is comparatively thin: `lib/sim/world/events.ts` has only **4** decision events; village
  attitude shifts via small hardcoded deltas scattered across events/projects.

## COIN strategic baseline — `npx tsx scripts/campaign-loop.ts` (NEW harness, this campaign)
Drives full multi-day tours under two scripted commander policies and measures whether the strategy layer
discriminates. Default `2 3` (2 seeds × 3 days) + a 30-day combat-suppressed probe.

> ── POLICY A — careful COIN ──   TOUR SCORE **38.0** (27, 49)
>   village attitude start→end: -8.2 → -7.9 (Δ 0.3) · directives: issued 2 complete 0 **failed 0** penalty-fired **no** · CERP 30000 → 20000 **ever-rose: NO** · projects funded 2 **complete 0**
> ── POLICY B — body count ──     TOUR SCORE **37.5** (37, 38)
>   attitude -8.2 → -8.0 · CERP 30000 → 30000 · projects funded 0 complete 0
> === VERDICT ===  [FAIL] discriminates (spread **0.5**) · [FAIL] COIN moves attitude · [FAIL] directives live · [FAIL] CERP two-way · [PASS] loop NaN-free · [PASS] enemy dynamic
> Extended (survey-1 careful, 30 days, ideal COIN): projects funded 6 **complete 0** stages [sabotaged ×6] · attitude → **-12.7** (FELL) · CERP → 0 · score 47

### Confirmed COIN inertness (recon #3/#4/#10/#20/#21 — numbers)
- **Score non-discriminating:** careful 38.0 vs reckless 37.5 = spread 0.5 (need >25). The soul is mechanically dead.
- **Good COIN is self-harming:** 0/6 projects complete even garrisoned daily — all sabotaged (securityAt 2-within-80m unsatisfiable through the multi-day build); +14 completion bonus never fires; attitude FELL to -12.7.
- **Directives:** failed always 0, penalty never fires (`deadlineDay`/`penalty` written in create.ts:219-235, **read nowhere**); only 2/7 DirectiveKinds instantiated (presence, kle); census/interdict/construct/hold/casualty never created.
- **CERP one-way:** 30000→0, no income/refund path exists.
- **Enemy strength healthy (refuted worry):** min 45–52 / mean 51–55, 0% at cap 80 — dynamic.

### API gaps Wave D must close (from the harness)
1. **No "secure/garrison this build site" order** — the biggest gap; project completion is undrivable for player AND harness.
2. **No directive-issuance API / cadence / deadline-penalty tick** — directives seeded only at deploy; 5/7 kinds dead.
3. Combat doesn't resolve at coarse dt (harness uses dt=30 with approximate ballistics; strategic integrators are dt-exact, so inertness findings are solid).
