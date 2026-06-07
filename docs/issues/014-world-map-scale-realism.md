# 014 — World-map scale realism: soldiers/COP/villages drawn the wrong size

**Status: 🟢 FULLY RESOLVED 2026-06-07 — Bucket 1 (R1/R2) + R3/R4 render + Bucket 2 (S1/S2/S3/S4) sim all landed and verified.**
Full write-up + charts + annotated screenshots: `docs/progress/2026-06-06-world-scale-realism/report.html`.
Agent-ready fix spec (priority-ordered, with `file:line`, params, seams, metrics):
`docs/progress/2026-06-06-world-scale-realism/AGENT-BRIEF.md`.

## Resolution — Bucket 1 (render scale), 2026-06-07

The loud, felt half of the problem is fixed (render-only, zero sim risk). See
`docs/progress/2026-06-06-fivex-campaign/results-wave-e.md` for the full numbers.
- **R1 figure tracks footprint:** `figurePx` `max(15,min(40,ppm*7))` → `max(7,min(26,ppm*1.6))`
  (1.6 m kit footprint, 7 px legibility floor); `dotR` shrunk; LOD fade bands pushed to ppm 2.5/3.5.
- **R2 per-squad aggregation:** new `drawSquadIcon()` + WorldView groups friendlies by squadId below
  tactical zoom into one NATO icon each (echelon dot + `1st ×9` badge), 0.4-ppm crossfade.
- **combat-fx sync:** combat-fx now imports `figurePx`/`dotR` from draw.ts (one source of truth) so the
  suppression crescent / bleed pool / danger-close halo stay glued to the resized figures.
- **Verified (`scale-probe.mjs` korengal):** figVsTrue at default zoom 36×→**17×**, at tactical 12×→**3×**;
  soldier-as-%-of-COP 0.126→0.059→**~0.010** (≈ realistic ~1%); **`squadFiguresOverlap` true→false at EVERY
  zoom**. tsc/build/smoke green. Live re-capture: a squad now reads as spaced named individuals (tactical) or
  one squad icon (strategic), not a 21 m blob.
- **Deferred (logged):** R3 village sub-compound cluster (smallest slice), and all of **Bucket 2** (valley
  shape, weapons-squad 3→9, COP geometry) — sim/terrain is sensitive and 014 rates the relief/peaks already
  authentic; a deliberate realism-vs-playability call left for a measured future pass.

## Resolution — Bucket 2 (sim scale) + R3/R4, 2026-06-07 (the deferred work, now done)

The remaining items shipped as 6 atomic commits (`e4c28fb` S1 · `e8b1ebf` S3 · `e460857` R4 ·
`e365c33` S2+S4 · `41d22ef` R3 · `8c24bdc` hamlet stall-fix). All standing checks green
(tsc · build · lint · `smoke.ts` SMOKE OK · `balance.ts` 0 stranded). A 7-agent adversarial
verification pass (0 blockers, 0 majors) plus the dynamic balance harness gated each change.

- **S1 — weapons squad 3 → 9 (`entities.ts`).** Built a real 9-man weapons squad (WSL + two M240
  gun teams + two ammo bearers + grenadier + marksman) from existing roles. **Platoon 35 → 41**
  (verified `playerUnits().length===41`, weapons sqd `memberIds.length===9`). `rng.fork("platoon")`
  isolates the roster shift from terrain/weather/enemy strength (proven: parent rng unchanged by
  child draw-count), so the valley is unaffected.
- **S3 — floor gradient (`terrain.ts`). BRIEF CORRECTION:** the gradient was **NOT inverted**. Reading
  the y→compass mapping (`North is -y`, terrain.ts:145), the generation lerp already put the LOW end
  (1550) at the **north** mouth — the valley already drained north into the Pech, matching reality.
  Only the field *names* (`floorSouth`/`floorNorth`) and the `lerp` arg order were transposed, so the
  code *read* inverted. Fixed with a compensating double-swap (values + arg order) → **bit-identical
  terrain** (sha256 of the elev/slope/land/centerX arrays identical to the parent commit; elev
  1531/2899/1368 unchanged), honest names. The "narrow the floor to 0.5–1 km" half was **not** done:
  the *flat* floor already measures **median 420 m / p90 940 m** (<20° grade) — a real slot — and the
  ~2.2 km pathfinding-navigable width is steep-but-climbable mountainside that the issue-010
  anti-stranding work depends on. Narrowing it would re-break a logged win (restraint logged).
- **S2 — COP 170 m → 120 m (`terrain.ts`).** Wire radius routed through one `copRadiusCells()` shared
  by siting (R0) and build (R) — fixed a latent sited-for-85/built-at-60 transposition. **Diameter
  170 → 120 m** (a platoon OP, not a FOB). Verified: cop-render **0 sealed pockets**, copaudit clean
  over 60 seeds incl. the held-out tail (vil∩ 0, vilGap positive, 0 unreachable garrison posts),
  copstuck ≤ baseline grind.
- **S4 — villages: monolith → hamlet (`terrain.ts`).** New deterministic `villageHamlet(v)` (FNV
  hash of `v.id`, no rng) stamps a **ring of 2–5 discrete walled qalats** around an open courtyard;
  village radius 4–8 → 6–10 cells (**hamlet extent ~70–90 m**, was a single ~40 m box). First cut
  scattered overlapping compounds that fused into a wall maze and trapped a returning patrol
  (bal-6, 1/12 stall — caught by the dynamic balance harness, *missed* by the static audit); rebuilt
  as the spaced ring → **stall gone (0/12)**. Structural connectivity **preserved: 98% (203/207, 40
  seeds) vs 99% baseline** — no hamlet seals a village; the misses are terrain-isolated benches.
- **R3 — render villages as the cluster (`WorldView.tsx`).** Paints one qalat sprite per `villageHamlet`
  compound — the **same** layout the worldgen stamped (one source of truth), so sprites sit over the
  real compounds. A village now reads as a hamlet of buildings.
- **R4 — monotonic LOD bands (`draw.ts`, `WorldView.tsx`).** Retimed the COP pin (0.35→0.7) so it
  retires as the built COP resolves (was double-drawing over finished barracks); crossfaded the
  garrison reveal (0.42→0.62) instead of a hard pop at ppm 0.5; deleted a dead role-glyph block.

**Re-baseline note (determinism contract).** S2/S4 reshape worldgen, so the single seeded RNG stream
ripples downstream — equivalent-but-reshuffled valleys. On the fixed seed sets this shows as a patrol-
march reach of 66→48% and balance WIA 4.9→7.5 (KIA ~1.0 flat); an A/B (same seeds, one variable) plus
98% structural connectivity confirm this is a reshuffle, not a sealed-village or logic regression.
**Restraint:** did not fork dedicated rngs for buildCop/village-stamp to zero out the ripple — a larger
determinism change with no correctness payoff once connectivity is preserved.

Full write-up + before/after framings: `docs/progress/2026-06-06-world-scale-realism/` and the published
report in `public/manual/archive/`.

## What's wrong

Player report (paraphrased): *the scale of the world-map elements doesn't feel true to life — soldiers
vs the COP vs villages, the spacing of the soldiers, the distances, the terrain.* Metricized on HEAD
(seed `korengal`) with a new probe and a cited real-world research pass. Two buckets:

**Bucket 1 — REPRESENTATION (render-only, the loud one).**
- **Soldiers are painted as giants.** `figurePx = clamp(ppm*7, 15, 40)` (`lib/render/draw.ts:19`) gives
  a soldier a 15 px floor → **≈21.4 m ground-width at the default ppm 0.7 (36× a real 0.6 m man)** and
  **never below ~5 m at any zoom**. The NATO dot `r = clamp(0.95*ppm, 4.5, 13)` (`draw.ts:96`) is
  ~13 m wide at default. At ppm 0.7 a single man spans **12.6% of the 170 m COP** (reality: 0.35%).
- **A squad is a blob.** The sim disperses men at a correct **5.5 m** (doctrinal); but a 15 px figure
  is ~4× the 3.85 px on-screen gap, so 9 men overlap into one shape at **every** zoom — the spacing
  can never be seen. (`squadFiguresOverlap` = true for ppm 0.3…8.)
- **No per-squad aggregation.** `WorldView.tsx:345/347/370` draw one figure per soldier; all 35 men are
  individual oversized markers. (The codebase already hides the garrison below ppm 0.5,
  `WorldView.tsx:342` — an LOD instinct to generalize.)
- **A village is one building.** `WorldView.tsx:198` draws a single qalat sprite per village; a real
  Korengal village is a **cluster of ~80–100 stacked houses** (overlaps issue **007**).

**Bucket 2 — SIM SCALE (worldgen).**
- **Valley shape.** Real Korengal ≈ **9.7 km × 0.5–1.0 km (~10:1 slot)**; the model is a **2.56 km
  square** (`terrain.ts:118`) — ~3.8× too short, ~3.4× too wide for the floor. Best framed as one
  *segment*. Floor gradient is also **inverted** (`floorSouth 1550 / floorNorth 2000`, `terrain.ts:121`
  — the real valley drains north).
- **Roster.** Weapons squad is **3 vs the doctrinal 9** (`entities.ts:420`), so the platoon is 35 vs
  the real **39–42**.
- **COP geometry.** A clean **170 m circle (~220 m of wall)** vs a real small OP's **~30-HESCO fishhook
  (~70–100 m of wall)** conforming to the terrace (`buildCop`, `terrain.ts:744`). Footprint *scale*
  (~250 m) is right; the geometry and wall length are not.

## What's already authentic (do NOT change)

Verified against doctrine + the real valley: **vertical relief 1,368 m** (measured 1,531–2,899 m);
ridge crests 2,330–2,780 m (vs Abas Ghar 2,378 / Sawtalo Sar 2,854); floor elevation 1,550 m ≈ the
DEM-measured KOP terrace ~1,500 m; engagement band 30–620 m (vs real bimodal 16–800 m); **9-man rifle
squad** exact; **5.5 m dispersion** inside the 1–10 m doctrinal wedge band; COP sited above the floor.

## Reproduce

```
node scripts/scale-probe.mjs korengal     # needs the dev server on :3000
```
Prints the per-zoom projection table (`figureGroundM`, `figVsTrue`, soldier-as-%-of-COP,
`squadFiguresOverlap`) and writes `docs/progress/2026-06-06-world-scale-realism/scale-measurements.json`
+ framing screenshots. This is also the **verification** harness for the fix (baseline is saved).

## Root cause & code references

| Symptom | Cause | Code |
|---|---|---|
| Soldier 5–50 m on map | fixed pixel-floor figure size, divorced from footprint | `lib/render/draw.ts:19,96,17-18` |
| Squad blob | figure ≫ on-screen dispersion gap; no aggregation | `components/world/WorldView.tsx:342,345,347,370` |
| Village = 1 building | single qalat sprite / single stamped compound | `WorldView.tsx:198`, `terrain.ts:627-660` |
| Square short valley, inverted gradient | map config | `lib/sim/terrain.ts:118,121-122` |
| Platoon 35 not 39–42 | 3-man weapons squad | `lib/sim/entities.ts:420-427` |
| Circular over-walled COP | circular perimeter `R` | `lib/sim/terrain.ts:744,819-823` |

## Suggested direction (confidence)

Do **Bucket 1 first** (render-only, ~90% of the felt problem, near-zero sim risk): R1 footprint-tracking
figure size + R2 per-squad icon below tactical zoom + R3 village sub-compound cluster. Then **Bucket 2**
in order S1 (weapons squad → 41) → S3 (narrow playable floor + fix gradient) → S2 (COP geometry, highest
risk) → S4 (sim-deep village clusters, pairs with 007). Determinism contract applies to all of Bucket 2.
Confidence the render fixes resolve the player's complaint: **high (0.85)**; the sim-geometry fixes are
deliberate realism-vs-playability calls. See `AGENT-BRIEF.md` for the full spec + verification metrics.
