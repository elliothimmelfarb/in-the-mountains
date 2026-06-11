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
| [007](007-sim-level-terrain-ecology.md) | Terrain ecology is render-deep, not sim-deep (aspect, terraces, qalats, hydrology) | Low (fidelity) | 🟢 **Aspect-vegetation SHIPPED ACTIVE 2026-06-10** (@0.05, on by default) — vegetation reads the sun (forest-faces-north 59→64%, scrub-faces-south 48→56%); held-out validated: **KIA 1.17→1.08 down on both seed sets**, no aspect-caused strandings (the held-out stranding is pre-existing), village/COP siting + gate-overwatch byte-identical (slope>0.62 gate). A 3-strength sweep showed combat moves chaotically; 0.05 clears the no-stall guard, WIA/enemy texture is terrain-dependent (disclosed), `ITM_ASPECT` dials it. 🟡 **Footpaths shipped 2026-06-09** — switchback foot-trails up the spurs + every path centerline captured & drawn as scaled lines (trail cells 492→760, paths/seed ~6→22-32). Deeper ecology (aspect/terraces/qalats/hydrology) still open. See `docs/progress/2026-06-09-terrain-realism/` |
| [008](008-cop-pocket-reachability-ceiling.md) | Far-village reachability ceiling: COP/village cliff-pockets cap it ~30% (BFS ~64%) | **Medium** | ✅ **Resolved 2026-06-05** — connectivity guard + fatigue economy; arr-among-reachable 36%→76%, netVil 59%→72% |
| [009](009-far-village-tactical-window-and-network-ceiling.md) | Residuals: far-village tactical-window arrival, netVil 72% ceiling, trough cost | Low | ✅ **RESOLVED** — the active fix IS shipped (006/008 connectivity guard + movement economy, 26%→60–76%). The "residual" (60% on a generous 25-min window, **0 stranded**) is a long-march tactical WINDOW closed by a player's multi-hour patrol + time-warp — realistic terrain distance, NOT an unfixed defect. Re-confirmed + budget made tunable 2026-06-10. |
| [010](010-river-as-chasm-and-navigation-stranding.md) | River was an impassable cliff-walled chasm (0 crossings, 28% of seeds split the valley); planner stranded patrols | **High** | ✅ **Resolved 2026-06-06** — walkable floodplain + fords/footbridges + free-A* fallback + component-aware snap + squad cohesion/return fixes; router-null 30%→0%, banks-split 28%→0%, return-home 23%→81% |
| [011](011-deploy-relief-bake-cost.md) | Deploy-time relief bake (4096² sheet) is the dominant load cost (~seconds) | Low–Medium | ✅ **USER-FACING PROBLEM RESOLVED** — the deploy freeze is GONE (shipped progressive bake + staged loading screen + cache, 2026-06-06). The remainder is a perf *nicety* (cut raw bake CPU) that is browser-gated (no headless canvas) and whose only headless shortcut (lower resolution) would degrade the relief — correctly deferred, not shipped as a fidelity regression. |
| [012](012-cop-interior-connectivity.md) | A squad gets stuck on buildings in the COP (terrain-gen + a `copaudit` metric blind spot) | **High** | ✅ **Resolved 2026-06-06** — see `docs/progress/2026-06-06-cop-interior/` |
| [013](013-call-for-fire-danger-close-and-aimpoint.md) | Squad called mortar missions on itself / nowhere near the enemy (centroid-averaging + no danger-close gate → real fratricide) | **High** | ✅ **Resolved 2026-06-06** — densest-cluster PID aimpoint + danger-close withhold + FDC check-fire; `fire-mission-probe`: dangerClose 3–4%→0%, fratricide 1→0, offLive 0% (held-out confirmed) |
| [014](014-world-map-scale-realism.md) | World-map scale doesn't feel true to life: soldiers drawn ~36× too big (render clamp) → squads blob; villages drawn as one building not a hamlet; valley is a short square slice; platoon 35 vs 39–42 | **Medium** | 🟢 **FULLY RESOLVED 2026-06-07** — Bucket 1 (figure/squad-icon LOD: figVsTrue 36×→17×/12×→3×, overlap→false at every zoom) **+ Bucket 2 + R3/R4**: weapons squad 3→9 (platoon 35→**41**), COP 170→**120 m** (0 sealed pockets, copaudit clean ×60 seeds), villages monolith→**2–5-qalat hamlet** (stall-safe ring, 98% connectivity), honest north-draining gradient (bit-identical terrain), monotonic LOD bands. 0-blocker adversarial pass + 0-stranded balance. See `014-world-map-scale-realism.md` + `public/manual/archive/` |
| [015](015-coin-strategic-layer-inert.md) | The COIN strategic layer was mechanically DEAD — attitude flat, projects sabotaged-not-completed, CERP one-way, directives never failed/penalized, no secure-build order, score barely discriminating | **High** (design pillar) | ✅ **Largely resolved 2026-06-06** — secure-build order + per-type/wanted project payoff + two-way CERP + live directives (cadence/deadline/penalty/5 dead kinds) + KLE asks/broken-promises + COIN-weighted score. See `docs/progress/2026-06-06-coin-real-game/` |
| [016](016-civilian-diurnal-and-calm-before.md) | Valley was diurnally FLAT (civilians out 24/7) and the flagship COIN tell — civilians MELTING AWAY before an ambush (the tutorial teaches it) — did not exist | **Medium** (soul/realism) | ✅ **Resolved 2026-06-06** — `sim.light`-keyed diurnal occupancy (home-by-dusk, indoors at night, night-home pre-empts wary/clear) + pre-contact melt-away off staged-ambush/infiltrator sensing. New probe `atmospherics-probe.ts`: outdoor 100%-flat→night ~0% (tuned)/~13% (hot, real flee-residual), midday ≥62%, rising/falling edges; melt cohort closes ~50% distance-home before any shot while control stays flat, kids first. Held-out + determinism confirmed |
| [017](017-soundscape-immersion.md) | Soundscape was flat: combat-only, essentially **mono** (corr 0.98), **no reverb**, **silent between firefights** (−120 dB), no master dynamics/occlusion/weapon-tell | **High** (soul/immersion) | ✅ **Resolved 2026-06-07** — additive bus architecture: shared procedural **valley reverb** (decaying-noise IR + ridge slap-taps), 3-tier **ambient bed** (wind/river/generator/wildlife, day+weather, contact-ducked), **5-layer gunfire**, HDR mix + ducking + priority voices, terrain **occlusion**/elevation. Offline oracle (`audio-render.ts`, seed-pinned): firefight corr 0.98→**0.39**, ambient −120→**−42.6 dB**, spread **23 dB**, reverb tail 0→**7100 ms**, no clip, occlusion **−9 dB**, weapon 5.56>7.62 tell restored. Adversarial-verified + live. See `docs/progress/2026-06-07-soundscape/report.html` · **2026-06-11 follow-up (sound pass):** calm-width residual closed (4→**12.4%**, loop-offset decorrelation + bearing-panned beds), + per-category **sound mixer**, **incoming-shell whistle**, thunder, adhan vibrato, ricochet families — `docs/progress/2026-06-11-sound-pass/report.html` |
| [018](018-ui-ux-legibility-accessibility.md) | UI/UX legibility + accessibility: right-column dock clipped supply bars / crushed Task Org / left dead voids; colour-only status cues | **Medium** (legibility) | ✅ **Largely resolved 2026-06-08** (UI/UX 20× campaign) — every right panel `auto`-height (Squad Orders never scrolls, all 5 squads + 8 supply bars show), one flex spacer absorbs slack (no void), Roster modal for soldiers; per-panel scrolling 6–8 states → **0/10** (matrix-verified). Residual tracked: a glyph fallback for the few colour-only status dots/bars (WCAG 1.4.1). See `018-ui-ux-legibility-accessibility.md` |
| [019](019-elevation-pathing-rings-the-spur.md) | A squad ordered to a peak OP **rings the spur** (×6.85 detour worst seed) instead of switchbacking up the face — isotropic move cost + a 1.25 hard cliff cutoff + an 8-direction grid that can't represent a shallow switchback traverse | **Medium** (realism) | ✅ **RESOLVED 2026-06-10** — any-angle (Theta\*) tactical planner: signed-grade cost + turn penalty, gated + additive. Held-out detour ×3.58→×3.16, korengal ×2.19→×1.31, village routing/terrain byte-identical, stall guard passes; adversarially verified (caught + fixed a 7→1 mover-fidelity gap). · _history:_ 🟡 Diagnosed + attempt REVERTED 2026-06-08 — anisotropic Tobler cost on the existing grid REGRESSED (mean ×3.78→×4.52); a tamed directional cost + turn penalty got ×3.13 (reachability 50→55%) **but introduced a movement stall** and still missed target, so it was reverted (Law 8 / restraint-note signal). Clean fix = an **any-angle (Theta\*) finer planner** on the two-tier-terrain tactical patch. Fair probe `scripts/op-route-probe.ts` kept. **CONNECTIVITY half resolved 2026-06-09** — the probe conflated "can you get there" with "do you switchback efficiently"; a global steep-band softening (1.25→1.40) + anti-speckle guard reconnected the map (reach% 48→61, 0 stranded, balance unmoved) — see `docs/progress/2026-06-09-terrain-realism/`. The switchback-efficiency residual is still open (now de-risked — the global change removed the freeze cause). See `docs/progress/2026-06-07-soldier-scale-impl/ws4-elevation-pathing-RECORD.md` |
| [020](020-micro-terrain-cover-objects.md) | Cover is a single averaged scalar per 5 m cell and the drawn rocks/walls are cosmetic (decoupled) — a soldier can't take cover behind *that* rock/low wall | **Medium** (realism/soul) | ✅ **RESOLVED 2026-06-10** — directional + posture cover: an object stops only the round from the bearing it faces (a flanker sees you), posture-scaled, fire-path only. The OPPOSITE of the reverted omnidirectional grind: US WIA −22% tuned / −36% held-out, enemy preserved, 0 stranded; adversarially verified. · _history:_ 🟡 Diagnosed + scoped 2026-06-08 — the autonomous-flank work found a covered flank only **3–7%** of the time on the coarse cover raster (mechanism proven, ratio 1.68–1.84). Fix = a **discrete cover-object layer** (posture-dependent, sim-backed = drawn) on the shared two-tier-terrain tactical patch (with [019]). 🟡 **Object layer shipped 2026-06-09; combat-cover DEFERRED on the numbers** — boulders/outcrops are now sim objects (`terrain.coverObjects`, ~11,600/valley) the renderer draws (drawn=sim verified; on rocky ground the rock you see IS the cover) + erratics strewn on open slopes (more on the map). **Combat-cover cut**: a same-seed 12×50 A/B showed even a light open-ground stamp dragged firefights (WIA 3.92→7.42, +89%) — the 5 m cell scalar is too coarse; field left byte-identical (provably balance-neutral). Sub-cell directional + posture cover (the usable-AND-non-grinding fix) still open. See `docs/progress/2026-06-09-terrain-realism/` |
| [021](021-cop-fortification-not-combat-coupled.md) | After the COP overhaul, `fob.hesco` is written (work details) + read (the COP-integrity bar) but not yet **combat-coupled**; `claymores` and low water/batteries/medical are still consequence-free | Low–Medium (depth) | 🟢 **LOGISTICS TEETH SHIPPED 2026-06-10** — batteries→NOD (2.4× night detection), water/food→fatigue (50%), medical→wound-recovery (54%), all bounded + balance-neutral at full stock. hesco/claymore combat-coupling DEFERRED on a measured finding: a complex attack is a STANDOFF (insurgents never close the wire). · _history:_ 🟡 Open (restraint-logged 2026-06-08) — the deliberate Law-3 deferral from the COP overhaul: coupling hesco→defensive resilience + a "Harden the COP" work order + claymore detonation + logistics modifiers all change firefight balance and need **held-out** tuning (`survey-40..59`). Spec + verify recipe in the issue. See `docs/progress/2026-06-08-cop-overhaul/` |
| [022](022-cop-defense-audit.md) | `copaudit` measured COP generation but not its fitness as a **defended strongpoint** (ATP 3-21.8): gate overwatch, interlocking sectors, a firable FPF, HVT dispersion, threat-avenue coverage | **Medium** (correctness/realism) | ✅ **3 shipped, 2 reverted 2026-06-08** — expanded `copaudit` with 5 defense metrics. Shipped: ECP overwatch (gateOW 0/9→9/9, 93% holdout), interlocking sectors (secGap 47°→0°), **firable FPF** (mortFPF 5/9→0 — the watch was requesting unfirable fire). Reverted via worktree A/B bisect: HVT dispersion (+1.00 KIA) + threat-weighting (+0.50 KIA) cost more in patrol survivability than their marginal gain (Law 8). See `docs/progress/2026-06-08-cop-defense-audit/` |
| [023](023-combat-feel-smoothness-suppression.md) | Firefight *feel*: bullets teleported (appeared midway), feedback flickered, suppressed soldiers fired just as much, every combatant felt the same, the MG buzzed | **Medium** (feel/realism) | ✅ **5 shipped 2026-06-08** — survey→judge ranked 5 fixes across visual+sim+audio. One sub-tick render interpolation (`getSimFrac`) fixed bullet-teleport **AND** resurrected the muzzle flash (drawable 0/453→**453/453**; jump 123→~20 px, frozen 93→0%). Suppression now cuts fire rate (flat→**−48%**); composure/aggression shape bursts (4.55/4.33→**4.06/5.16**); ComBloc tracers burn **green** + ride the guns (rifle 25→8%); MG **8 cracks not ~56**. Both sim edits reshape the existing rng draw (determinism byte-identical, adversarial-verified); balance within ±15%. See `docs/progress/2026-06-08-combat-feel/report.html` |
| [024](024-buddy-drag-outruns-the-medic.md) | The aid buddy's 0.7 m/s casualty drag can outrun the chasing medic, who stops 2.5 m short of his moving patient — a casualty can bleed out with the doc an arm's length away (4/6 staged scenes pre-fix) | **Medium** (casualty realism) | 🟡 **Open, partially mitigated 2026-06-10** — the medic now publishes his patient (`targetId`) and the buddy flips to the kneeling `securing` posture (stops dragging) once the medic closes within 4 m, so the staged race self-resolves; the long-approach residual is unbounded. Found by `scripts/transitions-probe.ts` (people-immersion campaign). |
| [025](025-fleeing-straggler-holds-tic-latch.md) | A fleeing, *visible* straggler holds `inContact()` (and the 1× TIC speed latch, the CFF re-raise, and the consolidate beat) for 10+ game-minutes after the fight is decided — `visibleEnemyIds.length > 0` counts a harmless runner the same as a man shooting at you (`world.ts:856`) | **Medium** (pacing/feel) | 🔴 **Open (observed live 2026-06-10**, people-immersion W3 capture session) — survey-12: all enemies `exfil` ≥ 230 m, suppression 0, yet `squadState "break"` held clock 8631→9796+; teleporting the one in-LOS runner out released contact within the 10 s `contactHold` decay and the consolidate beat fired immediately. Fix shape: threat-weighted contact (fired-recently OR closing), not mere visibility. |
| [026](026-people-immersion-deferred-backlog.md) | People-immersion deferred backlog (Wave 4+): cookfire smoke, compound dogs, trap repositioning, the succession beat, cross-squad fix-and-flank, danger-area crossing, settled-prone at long halts, plus harness debt (atmospherics aggregate mode, a staged pinned-revert proof, balance.ts run-to-run σ floor) | Low–Medium (depth) | 🟡 **Open (deliberate Law-3/Law-8 deferrals, 2026-06-10)** — each Wave-4 item was DESIGNED with seams verified against HEAD, then consciously not built this session; full judged designs in `docs/progress/2026-06-10-people-immersion/plan.md`. Builds on the shipped campaign (cell brain, callout bus, pinned-revert + nerve, consolidate + medic security buddy, movement texture, the village wave). Open residuals tracked there: WIA ~6–7 below the 8.58 band (friendly side safer; watching), fireCont A/B 0.27 vs 0.31. |
| [027](027-trail-network-patrols-ride-the-network.md) | Denser trail network + benched-tread physics shifted patrol routing ONTO the network: far-village window times +27–34% (`reachability` 28/44→27/44 — arrives, slower) and balance WIA spiked when ROADS/TRACKS were capped too (6.92→12.58) | **High** (balance) | ✅ **Attributed + resolved 2026-06-11** — `ITM_NOTREADCAP` A/B pinned the WIA spike on the road/track caps (already-benched ground, pure tempo amplifier); caps narrowed to **Trail+Footbridge only** → WIA 8.42, inside the ~8.58 historical band (026 had flagged HEAD's 6.92 as below-band), KIA 1.67→1.00, 0 strands. Window residual (Donga arrives ~1700 s vs 1321) kept deliberately: patrols riding the network IS the realism; future lever = fatigue-aware planner cost. `docs/progress/2026-06-11-trail-network/` |

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
