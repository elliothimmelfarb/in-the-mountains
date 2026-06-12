# SYNTHESIS — WebGL terrain lighting rebuild + atmosphere + art seam

The implementation contract, synthesized from 4 independent proposals + 3 judge verdicts
(`design/p1..p4.md`, `design/judge-*.md`). The judges converged; conflicts below are RESOLVED —
do not re-litigate. Baseline evidence: `BASELINE.md` + `baseline/*.png` (18 shots, seed
`visual-baseline`, 28 fps on the software harness).

## The architecture (P1 spine, amended)

```
2D canvas (top, transparent-backed): contours/paths (ungraded ink decision: graded, revisit on
  night capture) → decoration/villages/COP (world dressing, GRADED via source-atop seam)
  → [GRADE SEAM] → markers/units/orders/cues/FX (ungraded) → night-light additive → HUD
WebGL2 canvas (bottom, opaque): albedo × (sun·shadow·cloud + fill + sky-ambient)
  → atmosphere chunk (alt warm/cool, haze, veil, pooled fog, cloud mottle on ambient)
  → full grade() (exposure/WB/saturation/lift) → out
Fallback: terrainGL.ok=false → today's 2D lit-bake path, byte-identical, selected at one branch.
```

- Albedo: CPU-baked UNLIT (existing `processRows` minus key/fill/sky shade, minus altitude
  warm/cool, minus haze — those move to GPU). 4096² RGBA8 + mips. **Alpha pinned: opaque
  (255), reserved — river glint stays CUT.**
- Height: 512² R32F + NEAREST, manual bilinear `heightAt` = bit-faithful `Terrain.elevAt`
  port (cell-corner lattice, clamp size−1.001). Normals per-fragment, forward difference at
  one-cell spacing (topo.ts:157-165 is a FORWARD difference — P2/P4 miscited it).
- Cast shadows: 1024² R8 FBO, GPU ray-march, **exponential stride spanning the whole map**
  (P1's march — P2's 480 m reach REFUTED: 780 m ridge at 20° throws ~2.1 km). Pass owned by
  terrain core; **policy + keyDir owned by sky module** (sun↔moon swap at night, rebake when
  keyDir moves >0.25-0.5°, ≤1 per 2 frames; wall-clock appears only as a rate limiter).
- Sun/moon/grade: ONE module `lib/render/sky.ts` (P2 renamed; P1's gl/sun.ts and P4's sun.ts
  DELETED). φ=34.8°N, **δ=+21°, solar noon 12:00** (verified table, sunrise 04:58/sunset
  19:02 inside the gameplay ramps). Moon: anti-solar gibbous, δm=−18°, illum 0.65, transit
  37°S at midnight. `nightFactor ≡ 1 − clamp01(solar × weatherLightMult)` with solarLight()
  PASSED IN — the sacred curve is never duplicated. Gate: `scripts/scratch-sun-probe.ts`.
- Grade: GL side full grade() block (exposure/WB/sat/lift — P1's gain/lift hook deleted);
  2D side ONE `source-atop` tint fillRect (only op that grades drawn pixels & preserves alpha).
  Shared altitude-keyed table in sky.ts. P4's alpha-mix-parity mandate DROPPED; parity gate =
  calibration screenshots 06:00/12:00/17:30/22:00.
- Atmosphere (`lib/render/gl/atmosphere.ts`, P3): named GLSL chunk spliced into the terrain
  fragment shader at a defined insertion point (core exposes locals: worldM, elev, altN, N,
  sunVis, direct, ambient, albedo + slope/cliff scalar). Cloud shadows: CPU-baked tileable
  2-ch FBM (RG8), offsets INTEGRATED from Δ(world.state.clock) — **re-seed rule:
  offset = f(seed, clock) on load and any non-monotonic clock change** (stable --hour goldens).
  Pooled fog: 128² local-valley-floor min-field + closed-form vertical transmittance;
  90 s sim-time low-pass on weather re-rolls. 2D coherence: `fogVisAt` samples the SAME
  Float32 arrays (parity probe `scratch-atmo-parity.ts`, <0.02 on 64 probes), with early-out
  when fog depth ≈ 0, sized against the real 1800-sprite decoration cap. Legibility constants:
  SYMBOLOGY_FOG_FLOOR=0.55, CLOUD_DENSE_MAX=0.45, VEIL_A_MAX=0.18, contour floor 0.65.
  Precip stays wall-clock screen-space (pause: clouds freeze, rain keeps falling).
  Wet-ground/snow-accumulation uniforms: NOT persisted (recorded cosmetic residual).
- Sprite shadows (P4): strip baked SE shadows from static sprite SOURCES via
  `data-cast-shadow` groups + build-time castHeight ⟺ group cross-validation (mismatch =
  manifest build ERROR); runtime skew-projected silhouette shadows, first at FIXED legacy NW
  angle (pure screenshot-diff QA vs baseline), switch to live `sky.spriteShadow` in the same
  commit as the night relight. Fixes latent rotated-statics bug (draw.ts:404/445 — project in
  world axes AFTER opts.rot). Behind a flag until `shoot.mjs --fps` at dense-forest worst case
  passes (moonlit-night case included — moon shadows void the "off at night" subsidy).
- Relief-inversion guard: `uFormLightNW` uniform — blend ~25-35% fixed NW form light into
  terrain diffuse so noon (sun due south, high) keeps the raking relief read. Default low,
  tuned by the noon LEGIBILITY squint gate at all 4 LOD bands vs HEAD.
- Night: wash (topo.ts:587-592) survives until the night-relight commit, then dies in ONE
  commit together with grade seam + moon keyDir. Target: moonlit mean luma ≈ 0.30 of day;
  moonless+overcast floor 0.12. Additive night FX drawn after the grade seam (unchanged).

## File ownership (one writer per file)

| Files | Owner |
|---|---|
| lib/render/gl/terrain-gl.ts, gl/shaders.ts (core+shadow pass) | terrain core (me) |
| lib/render/sky.ts (+scratch-sun-probe) | sky |
| lib/render/gl/atmosphere.ts (+chunk GLSL, fogVisAt, scratch-atmo-parity) | atmosphere agent |
| topo.ts (albedo split, overlays split), WorldView.tsx, store.ts warm phases | terrain core (me) |
| draw.ts/decoration.ts sprite shadows, sprite SVG sources, build-asset-manifest.mjs | art-seam agent |
| ART_BIBLE.md rewrite, hero asset SVGs | art-seam agents (trailing) |
| visual-matrix.mjs/shoot.mjs (--hour, GPU flags) | terrain core (me) |

## Commit plan (game green at every step)

- C1 `feat(render): sky module` — sky.ts + sun probe; no pixel changes. tsc/build/smoke.
- C2 `feat(render): GL terrain underlayer at blit parity` — TerrainGL renders the EXISTING lit
  bake as a textured quad; second canvas; fallback branch; --hour flag; GPU harness flags.
  GATE: visual-matrix GL vs baseline ≈ 0 diff (parity per zoom); fps ≥ baseline.
- C3 `feat(render): the sun is real` — unlit albedo; lighting+shadow pass; defaults haze;
  detail grain; uFormLightNW. GATE: NW-forced-key calibration ≈ today's noon; then live sun;
  dawn 05:30-08:00 timelapse strip; noon legibility squint at 4 LOD bands; sun probe green.
- C4 `feat(render): night relight + time-of-day grade` — grade GL+2D, seam placement per
  P4, drawCopNightLights split, wash dies, moon keyDir. GATE: night firefight squint; calib
  screenshots; nightFactor identity probe.
- C5 `feat(render): atmosphere` — clouds, pooled fog, fogVisAt wiring, drawWeather slimdown
  (veil absorbed, blobs die, precip reordered above structures), wet/snow extras.
  GATE: parity probe; luma-tracks-ambientLight probe across 24h×6wx; fog-dawn matrix.
- C6 `feat(art): sun-tracked sprite shadows` — SVG strip + runtime shadows + rotated-statics
  fix. GATE: fixed-NW diff ≈ baseline, then live; fps worst-case incl. moonlit night.
- C7 `feat(art): hero assets` — ≤15 sprites, 2-4× detail + AO (trailing, parallel).
- C8 verification sweep + after-matrix + report + publish (publish-report skill) + docs/wiki
  + README + ART_BIBLE + issue entries.

## Joint gates no single axis owns
1. Noon legibility (uFormLightNW) — squint test 4 LOD bands vs HEAD.
2. Terrain mean luma tracks ambientLight() across 24 h × 6 weathers WITH atmosphere chunk on.
3. Forest worst-case fps under moonlit night (sprite shadows + moon shadow pass).
4. Dawn timelapse strip = the marquee evidence (sun line walking down the west wall).
5. Fog-dawn worst-case legibility matrix at all LOD bands.

## Refuted / cut (do not re-attempt)
- P2's 480 m fixed-stride shadow march (truncates real ridge shadows — arithmetic refuted).
- Precomputed normal textures (second source of truth, worse at close zoom).
- P4's δ=15°/noon-12:15 sun, gradeFor() elevation-derived night, GL-grade-as-alpha-mix
  mandate, top-canvas fog blobs.
- P1's gl/sun.ts (δ=20°) — superseded by sky.ts δ=21°.
- River sun-glint (no albedo alpha provisioned), cloud sun-parallax (likely invisible
  top-down) — cut until stills prove otherwise.
- CSS-filter grading, multiply/soft-light top-canvas grades (spec-refuted: veil over α=0).
- Per-frame per-fragment shadow march (1.9 G fetches/frame — iGPU/SwiftShader hostile).
