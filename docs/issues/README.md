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
| [011](011-deploy-relief-bake-cost.md) | Deploy-time relief bake (4096² sheet) is the dominant load cost (~seconds) | Low–Medium | 🟡 **Open (restraint-logged 2026-06-06)** — now *covered* by the staged loading screen + progressive bake; speed is a future measured perf pass |
| [012](012-cop-interior-connectivity.md) | A squad gets stuck on buildings in the COP (terrain-gen + a `copaudit` metric blind spot) | **High** | ✅ **Resolved 2026-06-06** — see `docs/progress/2026-06-06-cop-interior/` |
| [013](013-call-for-fire-danger-close-and-aimpoint.md) | Squad called mortar missions on itself / nowhere near the enemy (centroid-averaging + no danger-close gate → real fratricide) | **High** | ✅ **Resolved 2026-06-06** — densest-cluster PID aimpoint + danger-close withhold + FDC check-fire; `fire-mission-probe`: dangerClose 3–4%→0%, fratricide 1→0, offLive 0% (held-out confirmed) |
| [014](014-world-map-scale-realism.md) | World-map scale doesn't feel true to life: soldiers drawn ~36× too big (render clamp) → squads blob; villages drawn as one building not a hamlet; valley is a short square slice; platoon 35 vs 39–42 | **Medium** | 🟢 **Bucket 1 (render scale) RESOLVED 2026-06-07** — footprint-tracking figure size + per-squad icon LOD; `scale-probe`: figVsTrue 36×→17× default / 12×→3× tactical, squadFiguresOverlap true→**false** at every zoom. Bucket 2 (sim/terrain) + R3 (village cluster) deferred. See `docs/progress/2026-06-06-fivex-campaign/results-wave-e.md` |
| [015](015-coin-strategic-layer-inert.md) | The COIN strategic layer was mechanically DEAD — attitude flat, projects sabotaged-not-completed, CERP one-way, directives never failed/penalized, no secure-build order, score barely discriminating | **High** (design pillar) | ✅ **Largely resolved 2026-06-06** — secure-build order + per-type/wanted project payoff + two-way CERP + live directives (cadence/deadline/penalty/5 dead kinds) + KLE asks/broken-promises + COIN-weighted score. See `docs/progress/2026-06-06-coin-real-game/` |
| [016](016-civilian-diurnal-and-calm-before.md) | Valley was diurnally FLAT (civilians out 24/7) and the flagship COIN tell — civilians MELTING AWAY before an ambush (the tutorial teaches it) — did not exist | **Medium** (soul/realism) | ✅ **Resolved 2026-06-06** — `sim.light`-keyed diurnal occupancy (home-by-dusk, indoors at night, night-home pre-empts wary/clear) + pre-contact melt-away off staged-ambush/infiltrator sensing. New probe `atmospherics-probe.ts`: outdoor 100%-flat→night ~0% (tuned)/~13% (hot, real flee-residual), midday ≥62%, rising/falling edges; melt cohort closes ~50% distance-home before any shot while control stays flat, kids first. Held-out + determinism confirmed |

**2026-06-06 (river navigation overhaul):** a fast static structural audit (**`terrain-audit.ts`**)
showed the river was a cliff-walled chasm with **zero crossings** that **split the valley in 28% of
seeds** — the dominant "can't reach / stuck on the river / can't cross" cause. Rebuilt it as a
walkable floodplain crossed at **fords + footbridges**, made the foot planner river-aware (coarse
barrier + free-A* fallback + component-aware objective snap), and fixed squad-level stranding
(cohesion gate, lead-keyed return, altitude-fatigue). New harness **`squad-arrival.ts`** scores the
WHOLE squad (cohesion + the return leg), not just the point man. See [010] and
`docs/progress/2026-06-06-river-navigation/`.

**2026-06-06 (call-for-fire realism):** a player report ("squad called a mission much too close to
them, nowhere near the enemy") metricized with a new probe (**`fire-mission-probe.ts`**, intercepts
every AI call-for-fire and scores the aimpoint vs ground truth + counts fratricide). Both halves were
real: a centroid-of-all-enemies aimpoint that lands *between* split contacts (on the squad), and **no
danger-close gate** (one run produced a real US fratricide). Fixed with a densest-cluster PID
aimpoint + a danger-close withhold + an FDC check-fire. dangerClose 3–4%→0%, fratricide 1→0,
off-target-vs-living-enemy 0% (held-out confirmed). See [013] and
`docs/progress/2026-06-06-firemission-realism/`.

**2026-06-06 (world-map scale realism audit):** a player report ("the scale of things on the map
doesn't feel true to life") metricized with a new probe (**`scale-probe.mjs`** — drives the live app,
applies the renderer's exact clamp formulas per zoom) and a cited 13-agent real-world research pass
(Korengal geography, US outposts, villages/qalats, FM/ATP 3-21.8 doctrine; adversarially verified).
The loud cause is **representation, not simulation**: `figurePx = clamp(ppm*7,15,40)` paints a soldier
**≈21 m wide (36×) at the default zoom** and a 9-man squad at correct 5.5 m spacing fuses into a blob;
villages render as one building. The sim's vertical scale, relief, ridge heights, engagement ranges,
squad size and dispersion are already authentic. Audited & specified (render-first), not yet fixed —
see [014] and `docs/progress/2026-06-06-world-scale-realism/`.

**2026-06-06 (civilian atmospherics — diurnal + the calm-before tell):** the valley was diurnally
flat (civilians out 24/7) and the flagship COIN tell — civilians **melting away before an ambush**,
which the tutorial explicitly teaches — **did not exist**. Both built in `ai/civilian.ts` keyed to
data the sim already computes (`sim.light` for the daily rhythm; staged-ambush/concealed-infiltrator
markers the brain already sees in its one armed-scan), **deterministic and with no new persisted
field**. New probe **`atmospherics-probe.ts`** (mover-faithful: ground-truth time from
`world.secondsOfDay`, "home" = the snapped point the mover walks to): diurnal outdoor 100%-flat →
night ~0% (tuned) / ~13% (hot seed — a *real* residual of civilians fleeing night infiltrators),
midday ≥62%, rising/falling edges present; melt-away cohort closes ~50% of its distance home **before
any shot** while a control cohort stays flat, **children first**. Held-out (`survey-43`) + same-seed
determinism confirmed. See [016] and `docs/progress/2026-06-06-atmospherics/`.

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
