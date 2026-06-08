# WS4 — Elevation pathing (switchback up the mountain, don't ring the spur)

**Outcome: diagnosed + measured + a fix attempt explored and REVERTED. The clean fix is an any-angle
(Theta\*) finer planner — scoped in `docs/issues/019`.** This is the Law-8 / restraint-note outcome the
campaign plan explicitly anticipated: *"If anisotropic-cost-on-the-existing-grid thrashes, that's the
signal to do the finer-patch/any-angle planner as a rebuild, not more patches."*

## The complaint (owner)
A squad ordered to a peak OP **rings the spur** instead of climbing — a ~470 m crow-flight OP plans a
3 km route around the mountain.

## Baseline (measured, `scripts/op-route-probe.ts`, FIXED strict-reachable objective per seed)
The probe picks the highest cell in a 250–560 m annulus **reachable under the strict 1.25 cutoff**
(a fixed objective — identical before/after a cutoff change, because the elevation field is unchanged;
the flood honours the planner's anti-corner-cut rule). detour = route ÷ crow.

```
seed         BEFORE detour   switch   impass%
korengal        ×2.20          1       29%
korengal-2      ×6.85          3       48%   <- worst, "rings the spur"
ridgeline       ×1.49          1       60%
restrepo        ×1.42          1       30%
kunar-3         ×4.83          3       33%
valley-7        ×5.87          2        9%
MEAN            ×3.78
```

## Root cause (confirmed against HEAD)
- `terrain.moveCostAt` is **isotropic**: `clamp(landMult·clamp01(1 − slope·0.62), 0.1, 1)` — reads only the
  cell's slope MAGNITUDE, identical in every heading, so a switchback only adds distance and never pays off.
- `passableCell` hard-blocks `slope > 1.25` (≈51°); procedural 5 m roughness scatters `>1.25` cells across a
  climbable face, fragmenting it into FAKE CLIFFS (korengal-2's direct line is 48% "impassable").
- The planner is a coarse-A\* (15 m, 8-dir) → corridor → fine-A\* (5 m, 8-dir). On an 8-direction grid the
  shallow traverse angle a switchback needs falls BETWEEN grid headings (Crowe/NPS), so even with
  anisotropic cost the grid snaps to straight-up-or-around.

## What was tried (and the numbers that killed it)
1. **Anisotropic Tobler cost alone** (`e^(−3.5|S+0.05|)`), cutoff unchanged → korengal-2 ×6.85 → **×8.00**
   (WORSE). With the face hard-blocked there is no through-line to switchback ON; the Tobler penalty just
   makes the planner ring around the steep edges even more carefully.
2. **+ softened cutoff to 1.7 (≈60°)** → mean ×3.78 → **×4.52** (WORSE), switchbacks ballooned (3→6, 2→6):
   the exponential Tobler over-penalises (33× at 45° vs the engine's own ~2.6×), so the planner detours AND
   zig-zags pathologically. The missing mandatory **turn penalty** was the cause of the zig-zag.
3. **Directional penalty (engine's own `1/(1−S·0.62)` shape, applied to the SIGNED travel grade) + turn
   penalty + softened cutoff** → mean ×3.78 → **×3.13** (BETTER, held-out seeds included), switchbacks clean
   (kunar-3 7→1). Reachability **50%→55%** (+2 villages, none lost); route-quality flat (1.13→1.15, 0 loopy).
   **BUT** it introduced a movement-harness regression: a `balance.ts` stall (bal-9: a unit froze on FLAT
   ground, pathLen=0 — a re-path freeze the route change exposed). And it still missed the target
   (korengal-2 ×6.22; its direct line is 45% GENUINE cliff/river, so a large detour there is partly real).

The softened cutoff and the anisotropic cost proved **coupled**: softening alone (with the original isotropic
cost) made the worst case WORSE (×6.85→×9.21). Neither half is independently clean.

## Decision: REVERTED
A modest, below-target win (×3.78→×3.13) that **regresses the repo's most load-bearing, hard-won system**
(a new movement stall) is the wrong trade. All WS4 code was reverted; `balance.ts` + `op-route-probe.ts`
confirm HEAD-original behaviour restored (0 stalls). `scripts/op-route-probe.ts` (the fair, fixed-objective
probe) is KEPT for the rebuild.

## The clean fix (next campaign — `docs/issues/019`)
Plan the tactical legs on a **~5 m (or finer) patch with ≥16-direction / any-angle (Theta\*)** connectivity so
a shallow switchback traverse is representable; apply the directional grade cost (proven here at the right
magnitude) + the mandatory turn penalty on THAT planner; soften the cutoff into a steep-but-slow band on the
patch only (so it can't strand a cross-valley mover). This is a **rebuild**, isolated to a tactical patch
around the climbing element — exactly the two-tier-terrain foundation the campaign plan scopes (it also
carries WS3's discrete cover objects). The corridor/8-dir coarse pass stays for the global cross-valley line.

## Restraint logged (what was deliberately NOT done, and why)
- Did **not** ship the ×3.13 attempt — it stalls a squad; movement harnesses must stay green.
- Did **not** keep the softened cutoff alone — it regresses OP routing (×9.21 worst) without the anisotropic cost.
- Did **not** chase the bal-9 re-path freeze with more patches on the existing grid — that is the thrash the
  rebuild exists to avoid.
```
