# 019 — Elevation pathing: a squad rings the spur instead of switchbacking up the face

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-10) — mechanism current: any-angle Theta* tactical planner (`thetaClimb`, `dirSpeedAt`), gated by `opts.switchback` so world generation stays byte-identical. Do-not-retry (refuted at/before e5b5795): in-place anisotropic Tobler cost / cutoff-softening on the 8-dir grid — it stalled the mover and missed target; binds while the coarse+corridor router is unchanged.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Status: ✅ RESOLVED 2026-06-10 — the any-angle (Theta\*) tactical planner shipped (signed-grade cost +
turn penalty, gated + additive). op-route held-out ×3.58→×3.16, climbable-face OPs ×2.19→×1.31, route-
quality/reachability/terrain byte-identical, balance stall-guard passes. Connectivity half resolved
2026-06-09. See the Resolution section at the bottom.**

_(historical, pre-2026-06-10: 🟡 DIAGNOSED + a fix attempt explored and REVERTED — the clean fix was an
any-angle (Theta\*) finer planner, a scoped rebuild, since shipped.)_
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

## Resolution — SWITCHBACK route-quality SHIPPED 2026-06-10 (any-angle Theta\* tactical planner)

The switchback-efficiency residual is **resolved** with the scoped rebuild this issue scoped: an
**any-angle (Theta\*) tactical planner** with a **signed-grade (anisotropic) cost** + a **turn penalty**,
fired only for a genuine climb, bolted onto the proven coarse+corridor router without changing a line of it.

**The three pieces (all required, only together):**
1. `terrain.dirSpeedAt(wx,wy,ux,uy)` — moves the slope penalty OUT of the per-cell `moveCostAt` and INTO
   the edge: speed = `LAND_MOVE·clamp01(1 − S·0.62)` on the **signed grade S along travel** (`∇elev·u`).
   Climbing the fall line is slow, a cross-slope traverse is fast → a longer switchback genuinely beats a
   short scramble (minimises travel TIME, not length). `moveCostAt` itself is **unchanged**.
2. `path.ts thetaClimb()` — Theta* on the fine grid: each node relaxes against its parent's PARENT when
   line-of-sight allows, so a leg runs at ANY heading (the traverse angle the 8-dir grid couldn't represent).
   Box-bounded with an escalating-margin connectivity pre-check (`connectedInBox`/`switchbackBoxMargin`),
   so a clean face is a cheap tight search and a genuine cross-valley OP falls through.
3. A mandatory **turn penalty** (`TURN_PENALTY_M`) — few clean bends, no staircase jitter (the pathology
   that sank the reverted attempt #2).

**Gated + additive — why it can't regress the rest (the reason the prior attempt was reverted):** the
branch fires ONLY for `opts.switchback` (set by `combat.ts pathTo` for a deliberate squad march) to a
steep, elevated, tactical-range objective (`crow 80–1300 m, climb ≥ 60 m, grade ≥ 0.12`). World
**generation never sets the flag → the valley is byte-identical**; valley-floor village routing never
trips the gate → `reachability`/`route-quality` byte-identical; `moveCostAt` + the whole coarse+corridor
pipeline untouched. `ITM_NOSWITCH=1` / `OPROUTE_NOSWITCH=1` are A/B kill-switches.

**Numbers (before → after):**
- op-route mean detour **×4.17 → ×3.81** (6 tuned seeds); **held-out ×3.58 → ×3.16**, worst ×5.97 → ×5.50,
  reached **8/8** (Law 3 — fresh seeds never tuned on).
- Climbable-face OPs land in the target band: korengal **×2.19 → ×1.31**, restrepo ×1.42 → **×1.21**,
  ridgeline ×1.88 → ×1.63, survey-52 ×1.07, kunar-9 ×1.54. Switchback jitter **3–6 → 1–2** reversals.
- `route-quality` ALL 48 ratio 1.12 loopy 0 — **byte-identical**. `reachability` (60 seeds): **arrival
  counts identical on all 60** (2 seeds — survey-50/52, both elevated-village — shifted *which* village is
  the worst-miss with no change to the count, i.e. the switchback rerouted an approach but lost no
  reachability). `smoke` OK (no new persisted state).
- **balance** A/B (same-seed): planner OFF = **byte-identical to HEAD** (KIA 0.92, WIA 7.33); planner ON =
  KIA 1.08, WIA 7.83 — the realistic, measured cost of squads now climbing **exposed** high ground; the
  **stall guard PASSES (0 stranded)**, the exact failure that reverted the two prior in-place attempts.

**Adversarial verification (4-agent workflow, all lenses no-issue):** an independent skeptical pass
(determinism / generation byte-identity / perf / mover-stall) re-read the planner and re-measured from
scratch — generation byte-identical confirmed on fresh seeds, held-out win reproduced independently, zero
regressions. It caught one real fidelity gap my own testing missed: `thetaClimb`'s grid-edge corner-cut
was looser than the mover's `walkable()` (7/601 legs clipped a corner — no stall, ≤0.9 s slide). Fixed by
matching the mover's exact rule (strict corner-cut + the LOS shortcut now calls `walkable()` itself):
non-walkable legs **7 → 1** (the residual is `stringPull`'s pre-existing best-effort, shared with the
coarse pipeline), detour unchanged. Law 4 — the planner obeys the mover's real rules.

**Honest residual (characterised, not hidden):** OPs the probe picks behind a genuinely impassable massif
(valley-7 ×4.88, kunar-3 ×4.57, korengal-2 ×9.25) still detour — that is **real terrain**, not a planning
failure (the probe deliberately targets the highest, most cliff-surrounded cell). korengal-2's true route
loops outside even a near-whole-map box, so it correctly falls through to the proven router. **Restraint
logged:** we did NOT raise the box cap to chase it (a near-whole-map anisotropic search per order is the
wrong trade for one adversarial seed), and did NOT narrow the planner to dodge the small balance cost (a
squad ordered up a face should climb it). See `docs/progress/2026-06-10-open-issues/019-switchback/` +
`public/manual/archive/reports/2026-06-10-switchback-climb/`.
