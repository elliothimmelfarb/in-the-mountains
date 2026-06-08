# 021 — COP fortification (`fob.hesco`) is written + read but not yet combat-coupled

**Severity:** Low–Medium (depth) · **Status:** 🟡 Open (restraint-logged 2026-06-08)

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
