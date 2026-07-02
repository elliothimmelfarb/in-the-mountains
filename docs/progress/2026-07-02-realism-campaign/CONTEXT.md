# CONTEXT BLOCK — 2026-07-02 realism campaign

Owner brief (reconstructed): *Up the realism of what already exists — no new features per se. Four fronts: (A) soldiers get stuck / squad movement feels off; (B) walked paths too squiggly / unrealistic; (C) terrain too smooth/abstract vs real Korengal photos; (D) the KOP feels fake. Total freedom, question everything — prior decisions (including recorded ones) are hypotheses, not constraints. Empirical DO-NOT-RE-TRY failures remain facts about those implementations.*

HEAD at campaign start: `83e4256`, tsc clean, SMOKE OK.

---

## VERIFIED CODE FACTS (do not rediscover)

### Movement / pathfinding
- Pipeline: `findPath` (`lib/sim/path.ts:154`): optional Theta* switchback `thetaClimb` (`path.ts:662`, gated ≤1300 m, gain ≥60 m, grade ≥0.12) → coarse A* 15 m (`path.ts:209`) → corridor-clipped fine A* 5 m (`path.ts:278,435`) → free A* backstop (`path.ts:216`) → best-effort (`path.ts:221`). All routes string-pulled (`stringPull` `path.ts:484`); waypoints are 5 m cell centers; no funnel/curvature smoothing.
- Locomotion: `moveUnit` (`combat.ts:783`), waypoint epsilon 1.2 m, speed = TECH×STANCE×moveCost×fitness×fatigue×supp×paceScale (cap 1.6), never-freeze floor 0.12–0.5 (`combat.ts:844`) — **the floor is load-bearing** (issue 031). Steering: 13-heading fan, PROBE=7 m (`steering.ts:42-45`). Wire-solid axis-slide else wedge (`combat.ts:871-880`). Stall watchdog drops path at 2 s blocked (`combat.ts:964`) — re-path is the driver's job.
- **In-combat movement has NO pathfinding**: `moveTo` (`combat.ts:1725`) = single straight waypoint; used by `ai/friendly.ts:175,206,211,230` for cover/objective moves. Cover >7 m behind a wall ⇒ fan can't route ⇒ 2 s stall ⇒ identical re-issue ⇒ grind loop. (Suspect #1 for "stuck on things," HIGH.)
- Squad: leader-follower wake/breadcrumb (`world/formation.ts`): nav re-paths on >8 m goal move (`:121`); followers walk the wake (`driveFollower :670`) + per-man sinusoidal **meander 0.3–0.8 m amp / 18–30 m wavelength** (`formation.ts:697-700`); straggler HUSTLE up to 1.6× (`:731`). Wedged follower excluded from pace calc but **navigator is not** (`formation.ts:160`) — nav wedge freezes squad. Only file/column formations (wedge disabled `:81-85`).
- Passability: `passableCell` (`terrain.ts:3347`) blocks Cliff/walls/Hesco/Structure/River, slope>1.4, steep-band>1.25 w/ mean3>1.4. Rocks/Boulders/Scree passable-but-slow (`LAND_MOVE` `terrain.ts:3502`). Decorations are render-only, CANNOT snag units.

### Terrain generation (`Terrain.generate()` `terrain.ts:338`)
- Elevation = smooth Perlin-fbm sum (`rng.ts:118` — gradient noise, quintic fade): power cross-valley curve (`terrain.ts:387`), rounded ridge fbm, spur fbm, 4–7 carved draws, river incision. **Fine roughness only `fbm(70 m)×7 m amp, 3 oct` (`terrain.ts:414`); zero 5–25 m relief energy. No ridged noise, no erosion, no talus, no geometric terracing.** Floodplain flattened ≥45 m each side (`terrain.ts:451-477`).
- Landcover: 26 classes, slope+moisture thresholds (`classifyLand` `terrain.ts:628`); aspect ecology shipped at ASPECT_STRENGTH=0.05 (near-off; >0.05 needs balance-compensation pass — recorded).
- Trails: `carveRoadsAndTrails` (`terrain.ts:2795`) — village↔MSR tracks, MST village links, `ascendTrail` switchbacks (**maxGrade 0.3** `:2341`), ridge `lateralTrail` (`:2553`). Conform-0 landcover only (benching trails = refuted, trenches). Real-world oracle: USFS half-rule, ~10% avg / 15–25% max sustained grade ⇒ current trails ~2× too steep / under-contoured.

### Rendering
- WebGL relief shipped (`lib/render/gl/`), but **`u_detailGain = clamp((ppm−1.0)/2.0,0,1)` (`terrain-gl.ts:696`) ⇒ material tooth is ZERO below ppm 1.0; default camera ppm 0.4** (`WorldView.tsx:104`). Decoration fades in ppm 0.9–1.8 (`decoration.ts:74`). At play zoom: smooth hillshade + flat class colors only.
- Normals = 5 m forward difference of the smooth field (`shaders.ts:48`); rock/cliff "texture" is brightness speckle, no silhouette (`topo.ts:224-232`).
- Trails drawn `drawPathsLive` (`topo.ts:580`), midpoint-quadratic smoothing, de-braid occupancy grid (issue 029 fixed render squiggle for the *map network*).
- Per-unit route preview: dashed amber `drawPath` (`draw.ts:1074`), plan preview `WorldView.tsx:721-756`.

### KOP/COP (`buildCop` `terrain.ts:931`)
- **Perfect-circle HESCO ring** R=12 cells (~120 m) (`terrain.ts:1007-1025`), drawn cos/sin (`draw.ts:419-445`); radial parametric building fan at (back,side)·R fractions (`terrain.ts:1089-1096`); bench-flattened pad. 8 fighting positions + ECP overwatch + mortar pit + FPF (audited, keep: gateOW 9/9, secGap 0°, mortFPF 0).
- Garrison (`world/garrison.ts`): stand-to/guard/detail/chow rotations; off-duty snap to golden-angle lattice seat + faceLock (`yardSpot :243`) — evenly spaced frozen dots.
- **Manifest assets with ZERO draw refs (verified): `concertina`, `sandbag-wall`, `bld-conex`, `bld-tent`, `windsock`, `hesco-corner`, `bazaar-stall`.**

## REAL-WORLD ORACLE (cited — see agent brief in campaign dir)
- Real KOP: terraced up a hillside over several hundred yards, structures on cut benches at different elevations, HESCO runs kinked along contours, "lumpy amoeba" perimeter; clutter IS the realism (water pallets, ammo stacks, burn barrels, camo net, improvised gym, ANA sub-compound, C-wire everywhere); few vehicles; small LZ; 120 mm mortar pit. [Junger *War*/VF; Restrepo]
- Terrain: 1,200–1,800 m relief over 2–3 km; sustained 30–45° slopes, cliff bands, scree chutes, gneiss/schist outcrop; aspect asymmetry (N-facing conifer, S-facing scrub/rock); terraced green pockets only near villages; geometric clear-cut scars (timber economy); one west-bank road; single-thread river.
- Movement: FM 21-18 cross-country 2.4 kph day; FM 3-97.6 +1 h per 300 m ascent ⇒ ~0.65 km/h effective uphill (matches Junger sub-1 km/h). FM 3-21.8: file in restrictive terrain (sim's file-only choice is CORRECT), 10 m wedge interval when open.
- Real trails: contour traverses + switchback ladders at spur noses; USFS half-rule; ~10% avg grade, 15–25% max sustained. NOT fall-line, NOT squiggle.

## VERBATIM HEAD BASELINES (2026-07-02, files in baseline/)
- route-quality: ALL 48 ratio **1.12**, worst 1.67, loopy **0**, rev 0.0, maxExc 3 m.
- passability-probe MEAN: pass 80.9, **reach 60.6**, slopeImp 26%, speckle 6%, recover 9%, comps 5.3, big 64.4%. Outlier: survey-9 reach 11.0 / big 36.6%.
- terrain-audit: banksSplit 0/9, vilUnreach 2/44, routerNULL 0/44, farMissed 0/252.
- footpath-probe MEAN: trailC 1095, path% 2.13, trGrade 0.54, **alongGr 0.185, along>45% 9%**.
- copaudit: egress 0 blocked, FPF firable 9/9; HVT sep <30 m on 7/9 (recorded revert — do not re-fix via dispersion), threat-avenue gun 4/9 (recorded revert).
- squad-arrival: cohesion **100%**, ≥70% closed 27/27, worst straggler 29 m, return-home **89%** (24/27).
- cohesion MEAN: paceEff 0.57, paceP10 0.60, throttle 12%, lenCV 0.71, jitter 0.23, blocked ~0%.
- thrash-probe: 9/10 OK; **survey-4 STUCK 127 m short (687 m trip), zero replans/thrash**.
- movement-diag (ADVERSARIAL): survey-9/valley-3/ridge-11 OK; **survey-7 STUCK — closest 370 m of 510 m**.
- Trajectory PNGs: traj-{korengal,survey-0,survey-7}-HEAD.png (korengal = near-beeline diagonal across drainage; survey-7 = long ridge circle, never arrives).

## DO-NOT-RE-TRY (empirical failures — question the *conclusion*, never repeat the *implementation*)
1. Anisotropic Tobler cost on 8-dir coarse grid ⇒ detours ×6.85→×8.00 worse (`94b3f07`, issue 019).
2. Softening slope cutoff alone ⇒ ×9.21 worst-case detour.
3. Cost-floor 0.1→0.02 ⇒ A* frontier explosion, sim 1.5× slower, WIA +71% (`7b24c19` restraint log).
4. Navigator waits/eases below march floor for stragglers ⇒ india-9 stops arriving at every floor tried (issue 031). Never-freeze floor is load-bearing.
5. Omnidirectional raster cover stamp ⇒ WIA +89% grind (issue 020); the working mechanism is directional+posture occlusion.
6. Elevation-benched trails ⇒ trenches in passable graph (issue 007). Trails stay conform-0.
7. TREAD_GRADE_CAP on Road/Track ⇒ WIA +82% (issue 027). Caps are Trail+Footbridge only.
8. COP HVT dispersion / threat-weighted guns ⇒ +1.00 / +0.50 KIA (issue 022, `c561d29`).
9. Aspect strength >0.05 without a balance-compensation pass ⇒ KIA +56% & stranding (issue 007).
10. Shrinking COP colliders for "stuck on buildings" ⇒ refuted; cause was garrison placement (issue 012).
11. Asserting any casualty number / sim-output-derived threshold as a gate (Harness law; WIA σ≈2.5 noise floor — deltas finer than σ are noise).

## HARNESS LAW
Gate = invariant or cited doctrine/design oracle only. Casualties diagnostic, never target. Tune survey-0..39, prove survey-40..59 / fresh prefixes. Adversarial probes (movement-diag, opposite-gate REAR, follower-strand, thrash, egress) ≠ fair probes (reachability, squad-arrival); cross-check before declaring regression. campaign-loop.ts = COIN win gate, pre-merge for sim/AI/balance changes (~min/seed, heavy seed ~9 min). smoke.ts material-hash is a change-detector: re-pin deliberately when terrain gen changes, with justification.

## MEASUREMENT GAPS (build as scratch-*)
- No planned-route small-angle turn-density / curvature metric (squiggle is sub-120°; `rev` blind to it).
- No terrain slope-distribution / roughness / relief-spectrum metric (smoothness only inferred via passability).
- No doctrine-pace check (effective km/h vs FM 21-18 / FM 3-97.6 bands).
- No in-combat movement probe (all existing movement probes are patrol-based, combat-free).
