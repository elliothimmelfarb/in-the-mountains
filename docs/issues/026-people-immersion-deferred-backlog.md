# 026 · People-immersion campaign — the deferred backlog (Wave 4+)

**Status:** OPEN (deliberate Law-3/Law-8 deferrals from the 2026-06-10 people-immersion
campaign — each item was DESIGNED with seams verified against HEAD, then consciously not
built this session. The full judged designs live in
`docs/progress/2026-06-10-people-immersion/plan.md`.)

## Shipped context (what these build on)

The campaign shipped: the enemy cell brain (`lib/sim/ai/cell-combat.ts` — volley discipline,
group displace, coordinated peel, contagion), the diegetic callout bus (`CombatSim.say` +
`lib/render/callouts.ts`), pinned-revert + per-man nerve, post-contact consolidate + the
medic-scene security buddy, point-man caution + line meander + weather interval, and the
village wave (elder-as-agent + staged shura, households + named grievances + first-light
funerals, kids trailing, reception). Probes: `cell-coordination-probe`, `callout-probe`,
`drill-timeline-probe`, `transitions-probe`, `encounter-probe`.

## Deferred items, in the plan's priority order

1. **Cookfire smoke at meal hours** (render-only; suppressed when the village melts) — the
   cheapest pattern-of-life win; zero sim risk.
2. **Compound dogs** (1–2 real units/village; night alarm field nudges `updatePerception`
   alertness — the tell that cuts both ways). Guards: diurnal probe must exclude role
   "dog"; `civClear` must exempt animals.
3. **Trap repositioning** (director re-look ~45 s; the cell slips concealed to new
   `firingPositions` against the patrol's projected route; **the melt follows the moving
   cell** — assert `meltFollowLeadS`).
4. **Succession beat** (deferred `takesChargeAt` 6–18 s command gap; the squad visibly sags,
   then "on me"). Hazard: the gap creates real `slDown` windows → mustBreak tightens; cap
   the gap, never soften the floor.
5. **Cross-squad fix-and-flank** (task-array blackboard; opposite flank signs; fires
   ownership; two-squad probe asserts bothAssault% → 0).
6. **Danger-area crossing drill** (halt short, leaders look, teams bound across under
   overwatch; march-FSM states; per-leg texture budget shared with SLLS).
7. **SLLS listening halts** · **terrain-fitted wedge** (hysteretic corridor-EMA selection,
   quadruple-guarded, dies if wedgeBlocked regresses — respect the DO-NOT-RE-TRY history)
   · **MEDEVAC as a staged scene** (carry to LZ, ring, bird timer; `medevacs` in the
   `combat:` serialize block) · **bait-and-reattack** · **blend-into-population** (break
   into a hostile village ≤250 m; `evac` latch + strength credit; deliberately invisible
   to the melt — they HAVE fired) · **goat herds** · **prayer-clock courtyard convergence**.
8. **Settled-prone at long halts** (men in cover go prone after 60 s outside the wire) —
   implemented then HELD BACK during the balance bisect (changes LOS height in fights);
   re-attempt with a same-seed A/B.
9. **Harness debt:** atmospherics-probe AGGREGATE mode (the single-seed closure/midday %
   gates flip on 1–2 of 5 seeds per build at n≈5–24 — the mechanism gates never flip;
   aggregate over ≥5 seeds and keep per-seed mechanism asserts); a staged-scenario proof
   that pinned-revert fires (rvt was 0 at natural tempo across all drill-probe runs —
   the mechanism is tested by hand but a dug-in-MG scenario probe would pin it);
   balance.ts run-to-run σ characterization (same-build KIA varied 1.25→1.67 at n=12 —
   the ±15% gate needs a known noise floor).

## Open residuals from the shipped waves

- **WIA below band**: balance WIA 8.58 → ~6-7 (friendly side safer than baseline; watch it).
- **fireCont** A/B inverted slightly post-fix (0.27 vs 0.31) — the displace discipline trades
  continuity for coherence; acceptable, re-examine with trap repositioning.
- Issues **024** (drag-vs-medic race residual) and **025** (fleeing straggler holds the TIC
  latch — pre-existing, discovered during live verification).
