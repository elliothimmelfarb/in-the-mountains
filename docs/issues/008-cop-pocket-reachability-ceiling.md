# 008 — Far-village reachability ceiling: COP/village cliff-pockets cap it at ~30% (BFS ~64%)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-05) — mechanism current: `ensureNetworkConnectivity` guard + fatigue economy live; honest remainders tracked in 009. Do-not-retry: the "COP must sit in the largest raw-passable component" hard constraint (regressed reachability 26%→13%) — binds while siting scores raw `passableCell` not network reachability.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity:** Medium · **Confidence:** High (measured 2026-06-05) · **Area:** terrain connectivity × COP siting × pathfinding/formation · **Status:** ✅ RESOLVED 2026-06-05 (connectivity guard + fatigue economy; honest remainders → [009](009-far-village-tactical-window-and-network-ceiling.md)) — see Resolution below

## Summary

After the 2026-06-05 batch (`docs/progress/2026-06-05-batch/`), the **routing** and **failure-mode**
halves of far-village reachability are fixed, but the **connectivity** half is not. On the adversarial
all-villages metric (`scripts/reachability.ts`, 12 survey seeds) a patrol still reaches only **~30%**
of villages in a 1500 s window, while a BFS ground-truth flood from `gateOutside` says **~64%** are
genuinely foot-reachable. That 30→64 gap is the headroom, and it is a **generation** problem: the COP
and/or villages get sited in cliff-walled pockets that the road network only partly stitches together.

This is the explicit follow-up to the offer at the end of the batch ("lift reachability past the
cliff-pocket ceiling"). It supersedes the open half of [006](006-far-village-reachability.md) with
sharper numbers and a documented honest negative.

## Evidence (2026-06-05 batch, 12 `survey-*` seeds unless noted)

```
reachability.ts            16/61 (26%)  →  18/61 (30%)      full-sim, 1500 s window
BFS from gateOutside        ~64% of villages reachable        ground truth (passableCell flood)
route-quality.ts            mean ratio 1.26 → 1.01, loopy 6% → 2%, maxRatio 5.60 → 5.10
                            ⇒ routing is now near-optimal — this is NOT a routing bug
network-probe.ts            village↔MSR network connectivity 36% → 59% (village MST + spurs added)
movement-diag.ts            failures now "SET UP SHORT" / clean advance-and-hold, no loops
copaudit.ts                 gate portal disconnect 5/24 → 2/24; village/COP overlap 0/24
```

Per-seed BFS reachable% from the gate (from the diagnosis): `survey-2` 0.2%, `survey-5` 1.9%,
`survey-9` 7.3% — these COPs sit in tiny pockets — vs `korengal` 53%, `valley-3` 44% (healthy).

Reproduce: `npx tsx scripts/reachability.ts 12` · `npx tsx scripts/network-probe.ts 12` ·
`npx tsx scripts/movement-diag.ts`. Full root-cause trace: `docs/progress/2026-06-05-batch/movement-diagnosis.md`.

## Root cause

1. **COP-in-a-pocket.** The COP is scored onto a commanding bench (realistic), but on the steep
   cross-valley profile that bench is sometimes walled off from most of the valley by `slope>1.25`/
   `Cliff` bands. The gate then opens onto ground that connects to only a small fraction of the AO, so
   the coarse `findPath` pass returns `null` for most village goals (now handled gracefully —
   advance-and-hold — but the squad still can't *arrive*).
2. **The road network merges *some* pockets, not all.** The 2026-06-05 village→MSR spurs + village MST
   (`carveRoadsAndTrails` → `layTrack`/`layPath`) raised network connectivity 36→59%, but the
   `descendTrack` graded-Track fallback for a cliff-isolated village doesn't reliably produce a
   **coarse-pathable** (≥3-cell / 15 m) corridor that the patrol's formation can actually follow, and
   the COP's own access road can land in a side-pocket of the valley floor.
3. **The metric still conflates "reachable" with "reachable fast"** (006's point): a long-but-valid
   route the in-game time-warp covers reads as a miss in a fixed 1500 s window.

## What was tried this batch (honest negatives)

- **"COP must sit in the largest passable component" (hard constraint) — REVERTED.** It judged
  connectivity on the *raw* terrain, so it rejected legitimate benches that the switchback access road
  *would* connect and forced the COP onto the exposed valley floor. Measured: reachability **26% → 13%**,
  portal disconnect **5/24 → 12/24**. The lesson: the connectivity test must account for the roads
  (graded corridors), not just raw `passableCell` — and it must not destabilise good bench placements.
- **Steeper cross-valley profile (audit's high-impact realism lever) — NOT applied.** It would add
  cliff bands in the movement zone and make this worse; the peaks are already realistic without it.

## Suggested directions (build on what's there)

- **Gen-time COP↔network connectivity guard.** After building the COP + access road + village network,
  BFS over `{passable ∪ Road ∪ Track ∪ Trail ∪ Footbridge}` from `gateOutside`; if it fails to reach the
  MSR and/or most villages, *fix the connection* — regrade/relocate the access road, widen the gate
  corridor, or re-site the COP — rather than ship a pocket. This is the **smart** version of the reverted
  component check: gate on *network* reachability, not raw-component membership.
- **Make the graded-Track fallback coarse-robust.** Ensure every `layTrack` cliff-fallback lays a
  ≥3-cell benched tread that ties into the MSR (the 2026-06-05 pass tied the descent to `nearestRoadCell`
  but didn't verify a continuous coarse corridor), and confirm the squad **formation** can follow a thin
  track (widen tracks to coarse width on steep segments, or special-case follower spacing on tracks).
- **Path-based accessibility siting term** (not straight-line — 006 reverted that; not raw-component —
  008 reverted that): score candidate COP sites by a *coarse flood-fill route length* to the nearest
  villages over a surface that treats gradeable slopes as connectable. Cheap (one coarse flood per
  candidate region, not full A* per candidate); avoids cliff-isolated benches without overfitting.
- **Reduce gratuitous 5 m-scale cliff** (006's biggest lever): a light smoothing / slightly higher cliff
  threshold so the passable terrain is better connected. Measure impassable % and largest-component size
  before/after; tune carefully against the deliberately-steep combat feel.
- **Make the metric honest:** report reachability at warp / a generous window, the detour ratio, the BFS
  ceiling, AND the `network-probe` connectivity % (a fast leading indicator) — so "long march", "thin
  track the formation can't follow", and "genuinely walled off" are distinguished, not lumped as "miss".

## Done when

`reachability.ts` clears ~the BFS ceiling (≥60% on the survey sweep) at a fair window, `network-probe`
connectivity ≥95%, with **no regression** to `copaudit` (overlap 0, portal, egress), `route-quality`
(ratio ~1.0, loopy ~2%), or `balance` (no stranding, casualty bands). Verify each terrain change in
isolation and re-baseline (per CLAUDE.md).

## Related

- [006](006-far-village-reachability.md) — original characterisation; its "village↔village connector"
  suggestion was implemented this batch (the MST), and its straight-line siting term remains reverted.
- [002](002-cop-siting-ignores-objective-bearing.md) — gate/siting vs villages.
- [007](007-sim-level-terrain-ecology.md) — terrain fidelity.
- New harness: `scripts/network-probe.ts` (network connectivity % + benched-path "trough" cells).

## Resolution (2026-06-05) — the connectivity ceiling is lifted; the cause was not what the title said

Fixed on branch `fix/one-waypoint-always` (the "ONE WAYPOINT, ALWAYS" pass). Full write-up + before/after
diagrams: `docs/progress/2026-06-05-pathfinding/report.html`.

**The instrumented finding overturned this issue's framing.** A new adversarial harness
(`scripts/opposite-gate.ts`: real-sim arrival per village, bucketed by bearing from the gate, scored
against an 8-connected BFS ground truth) plus per-tick traces (`scripts/{why-short,lead-trace}.ts`)
showed the 30%-reached-vs-64%-BFS gap was **dominated by movement economy, not connectivity**: on a long
march fatigue saturated to 1.0 and pinned the squad at ~0.55× speed forever, and routes crawled
cross-country (moveCost 0.2–0.6) instead of riding the road net. The router was already near-optimal
(`route-quality` 1.01). Connectivity was real but **pocket-specific** (`survey-5`: gate flood = 2% of map).

**The fix (three changes, each measured in isolation):**
1. **Fatigue economy** (`combat.ts`) — penalty 0.45→0.32, flat-march accrual cut, slope term raised, and an
   exertion-gated recovery so a routine patrol *plateaus* while climbs/rushes still saturate (combat
   fatigue preserved). Alone: arrived-among-reachable 36%→48%.
2. **Connectivity guard** (`terrain.ensureNetworkConnectivity`, after `ensureGatePortal`) — the *smart*
   form of the reverted raw-component check: it runs `findPath` from the gate to each village and benches a
   ≥3-cell graded Track along the route; for a cliff-pocketed village a bounded gradeable Dijkstra carves a
   benched Track *around* the cliffs; a village with no gradeable route is left genuinely unreachable
   (honest refusal). Deterministic → save/load safe. No straight-line term, no raw-component constraint, no
   steeper profile (all three documented negatives honoured).
3. **Ride the net** (`formation.ts`) — patrol roadBias 0.25→0.55 (now a real lever).

**Measured (12 survey seeds, before → after):** arrived-among-reachable **36% → 76%**;
opposite-gate (REAR) bucket **13% → 50%**; `network-probe` netVil **59% → 72%**;
worst pocket `survey-5` **0/4 → 4/4** connected; **false-success 0** (the metric never fakes an arrival);
`copaudit` egress **1/16 → 0/16**, no regression (overlap 0, gate>90° 0); `balance` no stranding;
`tsc`/`build` green; deterministic rebuild.

**Status:** the reachable-but-stranded bug and the connectivity ceiling are resolved. The honest remainders
(far villages exceed the 25-min *tactical* window though they now arrive; netVil 72% not 100%; trough cells
rose from benched corridors) are tracked in **[009](009-far-village-tactical-window-and-network-ceiling.md)**.
