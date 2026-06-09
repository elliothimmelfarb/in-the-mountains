# 019 — Elevation pathing: a squad rings the spur instead of switchbacking up the face

**Status: 🟡 DIAGNOSED + a fix attempt explored and REVERTED. The clean fix is an any-angle (Theta\*)
finer planner — a scoped rebuild, deferred.**
Full record (baseline, every attempt + the numbers that killed it, the rebuild design):
`docs/progress/2026-06-07-soldier-scale-impl/ws4-elevation-pathing-RECORD.md`.
Fair, fixed-objective probe: `scripts/op-route-probe.ts`.

## Symptom
A squad ordered to a peak OP plans a huge detour AROUND the mountain instead of climbing it. Measured
(`op-route-probe.ts`, strict-reachable fixed objective): worst seed **korengal-2 detour ×6.85**
(468 m crow-flight → 3.2 km route); mean over 6 seeds **×3.78**.

## Root cause (confirmed against HEAD)
1. `terrain.moveCostAt` is **isotropic** — `clamp(landMult·clamp01(1 − slope·0.62), 0.1, 1)` reads only the
   cell's slope MAGNITUDE, identical in every heading, so a switchback only adds distance, never pays off.
2. `passableCell` hard-blocks `slope > 1.25` (≈51°); procedural 5 m roughness scatters `>1.25` cells across a
   climbable face → FAKE CLIFFS (korengal-2 direct line 48% "impassable").
3. The planner is coarse-A\* (15 m, 8-dir) → corridor → fine-A\* (5 m, 8-dir). On an **8-direction** grid the
   shallow traverse angle a switchback needs falls between grid headings, so even anisotropic cost can't make
   it zig-zag — it snaps to straight-up-or-around.

## Why the in-place fix was reverted (numbers)
- Anisotropic Tobler cost alone → korengal-2 **×6.85→×8.00** (worse; no through-line to switchback on).
- + softened cutoff (1.7) → mean **×3.78→×4.52** (worse; exponential Tobler over-penalises, pathological
  zig-zag from the missing turn penalty).
- + directional penalty (engine's own slope shape on the SIGNED grade) + turn penalty → mean **×3.78→×3.13**
  (better; reachability 50%→55%, route-quality flat) **BUT introduced a `balance.ts` movement stall**
  (bal-9: a unit froze on flat ground — a re-path freeze the route change exposed) and still missed the
  target (korengal-2 ×6.22; 45% of that line is GENUINE cliff/river). The cutoff softening and the
  anisotropic cost are coupled — softening alone made the worst case ×9.21. Reverted to keep the
  most load-bearing movement system green.

## The fix (next campaign)
Plan tactical climbing legs on a **~5 m (or finer) patch with ≥16-direction / any-angle (Theta\*)**
connectivity; apply the directional grade cost (proven at the right magnitude) + the mandatory turn penalty
on that planner; soften the impassable cutoff into a steep-but-slow band on the patch ONLY (so a cross-valley
mover can't be stranded). This is the **two-tier-terrain tactical patch** the soldier-scale plan scopes — it
also carries WS3's discrete micro-cover objects. The 8-dir coarse pass stays for the global cross-valley line.

## Verify (when built)
`op-route-probe.ts` detour for reachable elevated OPs toward ≈×1.2–1.6 on **held-out** seeds; switchbacks
appear only above ~25% grade (a turn penalty guards gentle ground); **every** movement harness stays green
(`reachability.ts`, `route-quality.ts`, `cohesion.ts`, `balance.ts` no-stall, `smoke.ts`).

## Resolution — CONNECTIVITY half shipped 2026-06-09 (commit 7b24c19); switchback route-quality deferred

The 2026-06-09 terrain-realism campaign reframed this issue: the probe had **conflated two problems**.

1. **Can you get up there at all?** — the dominant, gameplay-true problem. A new probe
   (`scripts/passability-probe.ts`) showed only **48%** of the *passable* map was gate-reachable: the
   hard `slope > 1.25` cutoff didn't just block climbing, it **salt-and-peppered fake cliffs** (5 m
   roughness noise) that shattered climbable faces into disconnected pockets. **Fixed** by softening the
   foot-impassable line to `FOOT_CLIFF_SLOPE = 1.40` (the band 1.25–1.40 becomes climbable-but-slow; the
   genuine cliffs ≥1.40 and the `Land.Cliff` ≥1.5 stay impassable) **globally** (planner and mover share
   one truth → no planner/mover divergence, which was the cause of this issue's reverted freeze) + a 3×3
   mean-slope anti-speckle guard. **reach% 48 → 61**, route-quality unchanged (1.13→1.12), 0 stranded,
   balance unmoved (WIA 3.75→3.50). The movement-cost curve is bit-identical to HEAD. Switchback foot-
   trails (`ascendTrail`, issue 007) give the bulk of climbing a real graded path.

2. **Do you switchback *efficiently* up an arbitrary high OP, or meander?** — the original headline
   ("rings the spur"). Still **OPEN**: with the band now passable the probe targets *higher* reachable
   OPs and the isotropic planner zig-zags up them (op-route worst still high). The clean fix remains the
   directional-grade-cost + turn-penalty planner this issue scoped (now **de-risked** — the global
   passability change removed the freeze cause). Deferred as a measured follow-up. See
   `docs/progress/2026-06-09-terrain-realism/`.
