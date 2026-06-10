# Issues 011 (relief-bake perf) + 009 (far-village residual) — 2026-06-10 closeout

## 011 — the relief bake is the dominant load cost
RE-CONFIRMED + a deliberate NON-fix, for two principled reasons that the original restraint-log only
half-stated:
1. **The obvious fix degrades realism — which is the wrong direction here.** Lowering `pxPerCell`
   8→6 (`topo.ts`) cuts ~44% of the pixels, but it SOFTENS the shaded relief at zoom — undoing the
   exact terrain-legibility the 2026-06 realism work added (cliffs read as sheer rock, paths as scaled
   lines). Trading visual fidelity for load speed is backwards on a project whose success metric is
   fidelity. So resolution-lowering is explicitly NOT recommended.
2. **The right fix is fidelity-PRESERVING but needs real-GPU measurement** (the headless ~5.9 s is a
   software-canvas figure). The clean option is a **seed-keyed cache** (IndexedDB): a deterministic
   seed → a deterministic baked sheet, so a re-deploy of a known valley skips the bake entirely with
   ZERO fidelity loss (issue option 3). Or an OffscreenCanvas worker (option 4). Both are real features
   that must be measured in a GPU browser, not headlessly.

**Status:** the cost is already COVERED by the staged loading screen + progressive bake (good UX, the
player's actual ask). Cutting it is a fidelity-preserving, GPU-measured pass (seed cache / worker) — NOT
a resolution cut. Characterized; the resolution-lowering trap is now explicitly logged as a do-not.

## 009 — far-village residual (the honest remainder of 006/008)
RE-CONFIRMED at HEAD: village point-man arrival across the 60-seed survey corpus = **180/300 (60%)**.
This is the characterised far-village tactical-window remainder — the worst village (often opposite the
gate, across a genuine cliff band or a long ford-detour) is a real multi-km march, not a routing bug
(`reachability.ts` is the fair metric; `movement-diag` is deliberately adversarial). The 2026-06-05/06
work (movement economy + connectivity guard + river-aware planner) took the headline from ~30% reached
to here; the remainder is genuine terrain distance, NOT a defect. Confirmed, kept as the honest tail.
