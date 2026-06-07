# 014 — World-map scale realism: soldiers/COP/villages drawn the wrong size

**Status: 🟢 Bucket 1 (REPRESENTATION) RESOLVED 2026-06-07; Bucket 2 (SIM SCALE) + R3 (village cluster) deferred.**
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
