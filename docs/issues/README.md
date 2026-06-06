# Known generation issues — index

A catalog of terrain- and COP-generation problems observed while rebuilding squad movement
(2026-06-03). These are written for a future pass that iterates on **terrain generation** broadly and
should resolve them. Each issue states what's wrong, how to reproduce it, the evidence, a root-cause
hypothesis with code references, and suggested directions — with an honest confidence level.

The headline thing to internalize: **the movement system is now solid** (see
`docs/progress/2026-06-03-movement-report.html`). The remaining failures are almost all **generation**
problems — a COP gets sited or shaped such that it is hard or impossible to move around — not movement
bugs. Fix the generation and the movement follows.

## Status — ALL RESOLVED (2026-06-04)

All five issues plus the player-reported "villagers wander into the wire" bug were fixed in
the 2026-06-04 terrain-generation pass and verified with the harnesses below. See
`docs/progress/2026-06-04-terrain/report.md` for the full write-up and before/after numbers.

| # | Issue | Severity | Status | Verified by |
|---|-------|----------|--------|-------------|
| [001](001-gate-egress-on-broken-ground.md) | Gate egress on broken ground; ring gaps | **High** | ✅ Fixed | `copaudit`: egress 0/16 blocked, ring 98% (was 1/9, 90%) |
| [002](002-cop-siting-ignores-objective-bearing.md) | COP siting/gate ignores the villages | Medium | ✅ Fixed | `copaudit`: gate faces >90° away 0/16 (was 7/9) |
| [003](003-interior-assembly-deadlock.md) | Squad deadlocks assembling in the interior | Medium | ✅ Fixed | `survey-9` assembles 9/9 at muster, patrol arrives |
| [004](004-buildings-are-passable.md) | Buildings are passable | Low (fidelity) | ✅ Fixed | `copaudit`: structures solid 16/16, no strandings |
| [005](005-coarse-pathfinding-vs-gate-and-walls.md) | Thin gate can seal at coarse resolution | Medium | ✅ Fixed | benched ECP apron + generation-time portal guard, 0/16 disconnected |
| — | **Villagers wander into the wire** (player report) | High | ✅ Fixed | `copaudit`: wire-pin ticks 0 (was 4467) |

The original issue text is preserved below each file with a **Resolution** section appended.

### Open / follow-up (surfaced during the same pass)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| [006](006-far-village-reachability.md) | Far villages are a long march (cliff-isolation); reachability metric vs. time-warp | Low–Medium | ✅ Largely resolved 2026-06-05 (movement economy + connectivity guard) — remainder in 009 |
| [007](007-sim-level-terrain-ecology.md) | Terrain ecology is render-deep, not sim-deep (aspect, terraces, qalats, hydrology) | Low (fidelity) | Future measured pass |
| [008](008-cop-pocket-reachability-ceiling.md) | Far-village reachability ceiling: COP/village cliff-pockets cap it ~30% (BFS ~64%) | **Medium** | ✅ **Resolved 2026-06-05** — connectivity guard + fatigue economy; arr-among-reachable 36%→76%, netVil 59%→72% |
| [009](009-far-village-tactical-window-and-network-ceiling.md) | Residuals: far-village tactical-window arrival, netVil 72% ceiling, trough cost | Low | Characterised (honest remainder of 006/008) |
| [010](010-river-as-chasm-and-navigation-stranding.md) | River was an impassable cliff-walled chasm (0 crossings, 28% of seeds split the valley); planner stranded patrols | **High** | ✅ **Resolved 2026-06-06** — walkable floodplain + fords/footbridges + free-A* fallback + component-aware snap + squad cohesion/return fixes; router-null 30%→0%, banks-split 28%→0%, return-home 23%→81% |

**2026-06-06 (river navigation overhaul):** a fast static structural audit (**`terrain-audit.ts`**)
showed the river was a cliff-walled chasm with **zero crossings** that **split the valley in 28% of
seeds** — the dominant "can't reach / stuck on the river / can't cross" cause. Rebuilt it as a
walkable floodplain crossed at **fords + footbridges**, made the foot planner river-aware (coarse
barrier + free-A* fallback + component-aware objective snap), and fixed squad-level stranding
(cohesion gate, lead-keyed return, altitude-fatigue). New harness **`squad-arrival.ts`** scores the
WHOLE squad (cohesion + the return leg), not just the point man. See [010] and
`docs/progress/2026-06-06-river-navigation/`.

New harnesses from this pass: **`copaudit.ts`** (one table for issues 001–005 + the wire-pin bug) and
**`reachability.ts`** (the fair all-villages movement metric — see 006).

**2026-06-05 (ONE WAYPOINT, ALWAYS pass):** instrumented the 30%-reached gap with a new adversarial
harness (**`opposite-gate.ts`** — real-sim arrival per village, bearing-bucketed, scored vs an 8-connected
BFS ground truth) + per-tick traces (`why-short.ts`, `lead-trace.ts`). The dominant cause was **movement
economy** (fatigue saturation + off-road crawl), not the hypothesised router/egress; fixed alongside a
generation-time **connectivity guard** (`terrain.ensureNetworkConnectivity`). See
`docs/progress/2026-06-05-pathfinding/report.html`. Resolved [008]; remainder tracked in [009].

**2026-06-05 update:** the eight-item batch (`docs/progress/2026-06-05-batch/`) added a tiered road
network (`Land.Track` + village→MSR spurs + a village MST) and fixed the "out-the-gate, loop, stuck"
routing bug (`findPath` bounded-box fallback; route-quality 1.26→1.01, loopy 6%→2%). The remaining
far-village *connectivity* ceiling (~30% reached vs ~64% BFS) is tracked in **[008](008-cop-pocket-reachability-ceiling.md)**;
new harness **`network-probe.ts`** (network connectivity % + benched-path "trough" cells).

## Reproduction toolkit

All of these reproduce from a seed, headless, in seconds. The seed is any string passed to
`createWorld(seed, days)`. Useful seeds found so far:

| seed | what it exhibits |
|------|------------------|
| `ridge-11` | **gate egress blocked** (`gateOutside` on impassable ground) — issue 001 |
| `survey-2` | long/broken route to the far village; patrol "sets up short" — issues 001/002 |
| `survey-9` | interior assembly **deadlock** (members stuck among structures) — issue 003 |
| `valley-3`, `korengal` | gate faces ~140–176° away from the nearest village (works, but via the long way around) — issue 002 |
| `smoke-test`, `delta-5` | perimeter ring 17–18% blocked (discontinuous "ring road") — issue 001 |

Harnesses (in `scripts/`):

- **`movement-diag.ts`** — forms a presence patrol to the village *most opposite the gate* (the worst
  case) across a seed list and reports: did the point man arrive, did the element set up on-station,
  wall-blocked ticks, body overlaps, and how far the squad "finished" from the objective. This is the
  fastest way to see a generation problem bite.
- **`trajectory-svg.ts <seed> <out.svg>`** — renders the squad's actual traced path around the COP. A
  bad generation shows up instantly as a route that can't get around.
- **`copsurvey.ts`** — surveys COP placement/road metrics across seeds.

A quick one-off COP audit (gate-egress passability, perimeter-ring continuity, interior open %, and
the gate-to-nearest-village bearing) is easy to write against `terrain.cop` — see the snippet in each
issue. Current-state numbers (10 seeds, 2026-06-03) are quoted in issues 001 and 002.

## Relevant code

- `lib/sim/terrain.ts` — `placeVillagesAndCOP` (siting), `buildCop` (wall, gate, perimeter track,
  structures, LZ), `passableCell`, `moveCostAt`, `gradeAccessRoad`.
- `lib/sim/path.ts` — hierarchical A*, the coarse `nodeCost` + `BARRIER_PENALTY`.
- `lib/sim/world/formation.ts`, `lib/sim/world/tasks.ts` — how patrols muster, file out, and move
  (the consumers that expose the generation problems).
