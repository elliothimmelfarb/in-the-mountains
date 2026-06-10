# 009 — Residuals after the connectivity guard: far-village tactical window, netVil 72% ceiling, trough cost

**Severity:** Low · **Confidence:** High (measured 2026-06-05) · **Area:** terrain connectivity × patrol pace × metric honesty · **Status:** ✅ RESOLVED — the active fix IS shipped. The defect this issue spun off from (reachable-but-stranded, ~26% reached) was fixed by the SHIPPED connectivity guard + movement economy (006/008, 2026-06-05/06: 26%→60–76%). What's labelled "residual" here is the characterised honest tail — a long-march tactical WINDOW (60% arrival on a generous 25-min budget with 0 elements stranded; closed by a player's multi-hour patrol + time-warp), which is realistic terrain distance, NOT an unfixed defect. Re-measured + the budget made tunable (`ITM_REACH_MAXS`) 2026-06-10.

**2026-06-10 re-confirmation:** village point-man arrival across the 60-seed survey corpus = **180/300
(60%)** at HEAD (`reachability.ts`, the fair metric). The unreached villages are the genuine far cases
(worst village opposite the gate, across a real cliff band or a long ford-detour) — terrain distance, not
a routing bug (`movement-diag` is deliberately adversarial and over-states). The 2026-06-05/06 work took
the headline from ~30% reached to here; this is the honest floor the valley itself sets. No fix
warranted. See `docs/progress/2026-06-10-open-issues/011-009-closeout/`.

## Summary

The 2026-06-05 pathfinding pass ("ONE WAYPOINT, ALWAYS" — see
`docs/progress/2026-06-05-pathfinding/report.html`) fixed the dominant cause of "physically reachable
village never reached" (fatigue runaway + off-road crawl) and added a generation-time **connectivity
guard** (`terrain.ensureNetworkConnectivity`) that benches a graded ≥3-cell Track from the gate to
every reachable village. Arrival-among-reachable rose from **36%** toward the BFS ceiling and the worst
cliff-pocket seed (`survey-5`) went **0/4 → 4/4** network-connected. Three honest residuals remain.

## Residuals (measured)

1. **Far villages exceed the 25-min tactical window.** A village >1.5 km behind a cliff band is a
   genuine 40–60 min foot march. With the fix it now *arrives* (counted in `opposite-gate`'s
   arrival-eventually column, which ends on the sim's own STUCK_S backstop, not a wall-clock), but not
   inside the 1500 s tactical window — so `reachability.ts` (a fixed 1500 s window) still reads only
   ~40%. This is realistic (in-game time-warp covers it), not a stranding. The metric now distinguishes
   the two; the gap is distance × foot-speed, not a bug.

2. **`network-probe` netVil plateaus at ~72%, not 100%.** The remaining un-networked villages are
   either genuinely cliff-walled (no gradeable route within `MAX_CARVE` ≈ 700 m → correctly left
   unreachable) or connect via Trail webs that the Road-rooted netVil flood doesn't credit. Forcing
   100% risks gratuitous carving / re-introducing the documented negatives (008).

3. **Trough cells rose (3071 → ~3520).** The guard benches real patrol corridors on steep ground —
   legitimate cuts, not the gratuitous water-trail trenches 008 referred to. Benching is what makes the
   Track ~1.3× faster than a Track left on the cross-slope (the difference between a borderline far
   village arriving and not), so it is a deliberate trade. The "~0 trough" aspiration for *all* trails
   is a separate light-tread pass over `gradeTreadAt`/`descendTrack`.

Plus a pre-existing carry-over: `copaudit` gate-portal disconnect **1/16** (one seed where the gate is a
thin coarse portal — `ensureGatePortal` territory, issue 005), and the BFS ceiling itself is <100% on
cliff-pocket seeds (issue 008's deepest half).

## Reproduce

```
npx tsx scripts/opposite-gate.ts 12   # arrival-eventually vs ≤1500s tactical, vs BFS truth
npx tsx scripts/reachability.ts 12    # the fixed 1500 s window (reads lower — that's the point)
npx tsx scripts/network-probe.ts 12   # netVil ~72%, trough ~3520
```

## Suggested directions

- **Tactical-window honesty in-game:** surface estimated patrol duration to the player so a 50-min march
  reads as expected, not "stuck."
- **Lighter benched tread on gentle grades** (widen the `gradeTreadAt` feather, or only bench where
  slope > a threshold) to claw trough cells back without losing the speed on the steep sections.
- **Credit Trail webs in netVil** (flood from the gate over the full network, not just Road) so the
  metric matches what the squad can actually ride — then push the genuine gaps only.
- **Coarse-portal hardening** for the 1/16 seed (issue 005's `ensureGatePortal`).

## Related

- Supersedes the *open* half of [008](008-cop-pocket-reachability-ceiling.md) (routing + failure-mode +
  the dominant movement-economy cause now fixed; this tracks the honest remainder).
- [006](006-far-village-reachability.md) (the original window-vs-warp observation), [005](005-coarse-pathfinding-vs-gate-and-walls.md) (coarse portal).
- Full write-up + before/after: `docs/progress/2026-06-05-pathfinding/report.html`.
