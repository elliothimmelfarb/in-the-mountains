# 022 — COP defense audit: 5 strongpoint metrics, 3 shipped, 2 reverted

**Severity:** Medium (realism/correctness) · **Status:** ✅ **3 shipped, 2 reverted 2026-06-08**

## What

`copaudit` measured the COP's *generation* (egress, ring, connectivity) but said nothing about its
fitness as a defended **strongpoint**. It was expanded with a DEFENSE AUDIT table (ATP 3-21.8 ch.5,
pure geometry + LOS over the seed): `gateOW` (ECP overwatched by fire), `secGap°` (largest un-grazed
perimeter arc), `mortFPF` + `asltCov%` (can the mortar range its FPF / the assault band), `hvtSep`
(TOC/armory/aid blast separation), `threat` (is the nearest-village avenue held by a heavy gun), plus
an `mgSpread` diagnostic. The baseline (HEAD, 9 seeds) surfaced **5 real, systemic shortfalls**.

## Outcome — numbers first (9-seed tune / 60-seed holdout)

| # | metric | baseline | result | status |
|---|--------|----------|--------|--------|
| 1 | gate overwatched by fire | 0/9 covered | **9/9** (56/60 holdout, 93%) | ✅ shipped |
| 2 | perimeter sector gap | 9/9 >25° (avg 47°) | **0/9, 0/60** (avg 0°) | ✅ shipped |
| 3 | FPF rangeable by the mortar | 5/9 unfirable | **0/9, 0/60** (asltCov 78→93%) | ✅ shipped |
| 4 | HVT separation ≥30 m | 7/9 under | (improved to 1/9) — **REVERTED** | ❌ backed out |
| 5 | threat avenue held by heavy gun | 6/9 not | (improved to 0/9) — **REVERTED** | ❌ backed out |

### Shipped (correctness)
1. **ECP overwatch** — a dedicated, LOS-aware gate tower (a terrain-local `groundLOS` picks a spot
   with a clear sightline *through the gap*; a flanking wall position's line crosses the HESCO). Also
   re-pointed the metric to the **entry kill zone** (gate + R+2), not the staging point 85 m down a
   switchback that a steep spur masks. Residual: 4/60 extreme spurs have no ground-LOS to the entry.
2. **Interlocking sectors** — limits aimed at the wire MIDPOINTS between azimuthal neighbours (fixing
   the radial-vs-perimeter parallax), so adjacent sectors meet on the wire, gate included.
3. **Firable FPF** — pit held ≤3 cells off centre, the FPF pushed ≥85 m from the pit (past the 70 m
   60 mm min range), and the watch clamps the aimpoint ≥75 m from the pit. The watch also now fires
   only for a genuine wire assault (garrison engaged + defer to a forward squad).

### Reverted (Law 8 / Law 5 — caught by the done-gate balance probe)
The 5 fixes collectively raised `balance.ts` lone-patrol casualties **0.13 → 1.88 avg KIA**. An
isolated-worktree A/B bisect (`docs/progress/2026-06-08-cop-defense-audit/balance-bisect.txt`)
localised it: **fix 4 (HVT dispersion) = +1.00** (moving the footprints perturbs the gate/muster and
the deterministic near-COP firefight; benefit marginal — sep 26→30 m on only 38/60 seeds) and
**fix 5 (threat-weighting) = +0.50** (guns onto lower-LOS positions). Both reverted; the crew-served
return to best-avenue siting and the buildings to the proven ≥10 m-street relaxation. **Not friendly
fire** (direct fire skips friendlies `combat.ts:980`; the COP FPF needs player approval — never fires
headless). The residual shift from the 3 kept fixes is the layout-sensitivity of a near-COP firefight
probe; the STALL CHECK (the probe's real gate) stays green throughout.

## Future work (the reverted ideas, if they're worth re-approaching)
- **HVT dispersion** without the step-off cost: constrain the relaxation so it never moves a footprint
  into the gate/muster egress corridor (or accept the 26 m baseline — a 60 m COP can't disperse far).
- **Threat-weighting** that requires a minimum avenue score, so a heavy gun is never sited on a blind
  position just because it faces the village.
Both must be proven on the `balance.ts` casualty delta (held-out), not just the audit.
