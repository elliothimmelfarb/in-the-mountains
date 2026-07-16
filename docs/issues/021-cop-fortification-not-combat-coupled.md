# 021 — COP fortification (`fob.hesco`) is written + read but not yet combat-coupled

> **Ledger status (verified 2026-07-16 @ da10926):** PARTIALLY RESOLVED (2026-06-10) — logistics teeth SHIPPED and current (`nvgPower`/`hydration`/med factor, world.ts:140). hesco/claymore combat-coupling DEFERRED on a measured finding (a COP "complex attack" is a standoff — `insurgent.ts` has no press-the-wire assault, so there is no event to couple to). Do-not-couple hesco/claymores until an assault behaviour exists.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity:** Low–Medium (depth) · **Status:** 🟢 LOGISTICS TEETH SHIPPED 2026-06-10 (Part 4); hesco/claymore
combat-coupling (Parts 1, 3) DEFERRED on a measured finding — a complex attack on the COP is a STANDOFF
(insurgents never close the wire), so there's no assault for fortification/claymores to bite on. See the
Resolution at the bottom.

## Context

The 2026-06-08 COP overhaul (`docs/progress/2026-06-08-cop-overhaul/`) gave the dead
`fob.hesco` stat (0–100 fortification) its first **writer** — garrison **work details** at the
wire raise it over the deployment — and a **reader** — the squad panel's *COP integrity* bar.
That closes the "a counter that changes but means nothing" smell at the UI level.

What it deliberately did **not** do, because it changes firefight balance and needs held-out
tuning (Law 3), is couple `fob.hesco` to **combat outcomes**. That coupling is the honest
follow-up.

## The deferred work (spec for a future measured pass)

1. **`fob.hesco` scales the COP's defensive resilience.** A well-built wire (high hesco) should
   make a complex attack on the outpost measurably less costly: e.g. raise the cover value of the
   garrison's fighting positions, and/or lower the enemy's effectiveness against men on the wire,
   bounded as a clamp so a degenerate value can't zero out combat.
2. **A "Harden the COP" work order** (reuse the `world/projects.ts` pipeline + CERP) that spends
   construction effort to raise hesco faster than passive work details — giving the campaign a COP
   build-up loop and a reason to invest at the outpost.
3. **`claymores` as a one-shot command detonation** during a complex attack (reuse the
   approve/deny fire-request action) — `fob.claymores` is currently as dead as hesco was.
4. **Logistics teeth** (separate but adjacent): low water/batteries/medical currently drain to a
   floor with zero consequence (only `ammo_556` feeds any metric). A bounded modifier block on
   rest recovery / NOD edge / recovery time would make `requestResupply` a real decision.

## How to verify (when built)

`scripts/balance.ts` across deployments with hesco/supplies forced **low vs full** — confirm a
neglected wire makes a complex attack measurably more dangerous (casualty delta) and a hardened
one blunts it. **Tune on `survey-0..39`, prove the win on the `survey-40..59` holdout** (Law 3),
and lead the report with the unflattering casualty delta. Keep every modifier a bounded clamp.

## Also cut from the same pass (render-only, intentional)

- **ECP serpentine is render-only.** A terrain-stamped chicane would risk pinching the proven
  ≥3-cell gate-egress corridor that `copaudit` guards; the T-walls are drawn, the apron untouched.
- **The Mk19 isn't crewed full-time** — only two machine-gunners exist, so it sits emplaced and
  manned at stand-to. Adding a third crew (or a stand-to pick-up-the-emplaced-weapon behaviour) is
  optional polish, not a stub to paper over.

## Resolution — LOGISTICS TEETH shipped 2026-06-10; hesco/claymore coupling deferred on a measured finding

**Law-1 redirect (the key finding):** before coupling `fob.hesco`, I metricized whether a COP assault even
produces casualties to protect against. `cop-defense-probe.ts` + a 20-min trace: a "complex attack" stages
8–16 fighters at 260–560 m who **harass from ~340 m and never close the wire** (garrison KIA/WIA ≈ 0, enemy
down 0, ×8 seeds). Cause: `insurgent.ts` is engage + shoot-and-scoot **lateral** bounds — there is **no
close-the-wire / assault behaviour**. So `fob.hesco` (wire fortification) and `claymores` (detonated on an
assaulting element) have **no event to bite on**; coupling them couples to a near-zero. This is the realistic
Korengal dynamic (ridge harassment, not assaults), so **Parts 1 + 3 are DEFERRED with this measured reason**,
not faked. (Part 2, the Harden work order, is marginal while hesco stays combat-inert.) A genuine fix would
first add an occasional press-the-wire assault behaviour — a bigger, balance-risky AI change beyond
"couple the existing stat."

**SHIPPED — logistics teeth (Part 4), the salvageable high-value win (it affects the PATROL):** the four
drained-but-inert supplies now bite, as **bounded clamps** (recovery never zeroes):
- **batteries → US night-vision** (`combat.ts` nvg gated on `sim.nvgPower`, pushed from `supplies.batteries`):
  NVG = **2.4× night detection** vs naked-eye (50–250 m, non-firing target); end-to-end gate verified
  (batteries 2 → NODs dark). A patrol that neglects resupply fights the dark on the naked eye.
- **water/food → fatigue recovery** (`combat.ts` stationary recovery × `sim.hydration`): full→depleted
  **0.43 → 0.21 (50%)**.
- **medical → wound-recovery time** (`world.ts` `daysToRecover` × `medFactor`): **54%** of full rate.

**Balance-neutral by construction:** at full (default) supplies every factor = 1, and a 50-min deployment
drains < 1 unit, so normal play is unchanged (6×40 balance KIA 1.17 / WIA 7.00 / 0 stranded == committed
post-B). The teeth only bite a NEGLECTED COP — the intended decision. smoke OK (no new persisted state; the
sim factors are transient, pushed each tick). tsc clean. Oracle: `scripts/logistics-probe.ts`. See
`docs/progress/2026-06-10-open-issues/021-cop-fortification/` +
`public/manual/archive/reports/2026-06-10-supplies-that-bite/`.
