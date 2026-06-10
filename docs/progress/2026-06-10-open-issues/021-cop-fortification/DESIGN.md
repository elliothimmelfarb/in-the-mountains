# Campaign C — 021 COP fortification combat-coupling · design + plan

**Goal:** make `fob.hesco` (and claymores, logistics) MATTER in a firefight. Today hesco is written
(garrison work details, garrison.ts:174) + read (the DeployScreen COP-integrity bar) but combat ignores
it — a neglected wire is as survivable as a hardened one. Balance-sensitive → tune survey-0..39, prove
survey-40..59 (Law 3), lead with the casualty delta, every modifier a bounded clamp.

## Verified seams
- `fob.hesco` 0–100. Writer: `garrison.ts:174` (`fob.hesco += detail.size·0.00012·dt`, capped 100).
  Reader: `DeployScreen.tsx:827` (the integrity bar). Init `create.ts:132` hesco 60, claymores 12.
- COP defense: `garrison.ts` posts men to `cop.fightingPositions` (carry facing + sector) at stand-to;
  they are normal CombatSim units → take fire via `stepProjectiles → resolveDirectHit → coverFor`.
- `coverFor(target, fromPos)` (combat.ts) is THE cover chokepoint — now object-aware (issue 020). The
  hesco coupling adds a per-unit fortification bonus here.
- `fob.claymores` (init 12) — currently dead. Approve/deny fire-request machinery exists (the watch's
  FPF request). Claymore = a one-shot command detonation on the wire avenue during a complex attack.
- Logistics: water/batteries/medical drain to a floor with NO consequence (only ammo_556 feeds a metric).

## Plan (bounded clamps; one mechanism each)
1. **hesco → defensive resilience (CORE).** When a garrison member mans a fighting position during a
   defense, set a transient `u.fortify` cover value = `clamp(0.15 + 0.45·hesco/100, 0.15, 0.6)` (NOT
   serialized — recomputed each tick by garrison, like brainState). `coverFor` folds it in via max. A
   hardened wire (hesco 100 → fortify 0.60) blunts a wire assault; a neglected one (hesco 20 → 0.24)
   doesn't. Bounded so a degenerate value can't zero combat.
2. **"Harden the COP" work order** (projects.ts + CERP) — spends construction effort to raise hesco
   faster than passive details. A COP build-up loop.
3. **Claymores** — one-shot command detonation (reuse approve/deny fire action) on the assaulting
   element during a complex attack; decrement fob.claymores.
4. **Logistics teeth** — bounded modifier block: low water → faster fatigue; low batteries → NOD edge;
   low medical → slower wound recovery. Makes requestResupply a real decision.

## Verify (the gate)
New probe `scripts/cop-defense-probe.ts` (or extend balance): force a complex attack on the COP with
hesco LOW (20) vs FULL (100); confirm KIA/WIA on the wire is measurably higher with low hesco. Kill-switch
env for the A/B. Tune survey-0..39, PROVE survey-40..59. balance.ts (patrol) must stay green. copaudit clean.

## Scope call
Part 1 (hesco→resilience) is the core realism win and ships first with the held-out proof. Parts 2–4
follow or are honestly scoped/deferred with numbers — NOT forced if balance says no (the 020 precedent).

## OUTCOME 2026-06-10 — logistics teeth SHIPPED; hesco/claymore combat-coupling DEFERRED (measured)

### The Law-1 redirect (the key finding)
A `cop-defense-probe` + a 20-min trace showed a "complex attack" on the COP is a STANDOFF: 8–16 fighters
spawn at 260–560 m, harass from ~340 m, and NEVER close the wire (verified: insurgent.ts has engage +
shoot-and-scoot LATERAL bounds, **no close-the-wire/assault behavior**). Garrison KIA/WIA ≈ 0, enemy down 0
over 20 min, across 8 seeds. So `fob.hesco` (wire fortification) and `claymores` (detonated on an assaulting
element) have **no wire-assault event to bite on** — coupling them now couples to a near-zero event. This is
the realistic Korengal dynamic (harassment from the ridges, not assaults), so it's defensible, not a bug to
force-fix. **Parts 1 (hesco→resilience) + 3 (claymores) DEFERRED** with this measured reason (and Part 2, the
Harden work order, is marginal while hesco stays combat-inert — the COP-integrity bar already reads it).

### Shipped — logistics teeth (Part 4), the salvageable high-value win that affects the PATROL
All four drained-but-inert supplies now BITE (bounded clamps — a degenerate value never zeroes recovery):
- **batteries → the US NIGHT-VISION edge** (`combat.ts` nvg gated on `sim.nvgPower` < reserve). Proven:
  NVG = **2.4× night detection** vs naked-eye for a non-firing mover (50–250 m); end-to-end gate verified
  (batteries 2 → NODs dark). A patrol that neglects resupply goes blind at night.
- **water/food → fatigue recovery** (`combat.ts` stationary recovery × `sim.hydration`): FULL vs DEPLETED
  **0.426 → 0.215 (50%)** — a dehydrated, underfed soldier shakes off fatigue at half rate.
- **medical → wound-recovery time** (`world.ts` daysToRecover × medFactor): **54%** — wounds heal slower.

**Balance-neutral at full supplies BY CONSTRUCTION:** at the default stocked levels every factor = 1
(hydration 1.0, medFactor 1.0, NODs on), and a 50-min deployment drains <1 unit, so normal balance is
unchanged. The teeth only bite a NEGLECTED COP — exactly the intended decision. smoke OK (no new persisted
state — the sim factors are transient, pushed each tick). Oracle: `scripts/logistics-probe.ts`.
