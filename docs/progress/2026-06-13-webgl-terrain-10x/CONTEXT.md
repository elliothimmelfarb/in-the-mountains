# WebGL Terrain 10x — design brief (attempt #2)

> **You are designing the visual rebuild of *In the Mountains*, a defense-grade COIN infantry
> trainer set in a procedural Korengal-like valley (Kunar, Afghanistan, c. 2011).** The owner
> reverted attempt #1 and said, verbatim: *"do it again and 10× better, going the WebGL route
> for the terrain. Level up the visual awesomeness of ALL visuals and assets by 10×. Go wild."*

## The bar (success metric)

A skeptical domain expert — a soldier who has watched *Restrepo* / *Korengal* / read FM 3-24 —
looks at the screen and says **"holy shit, that's a real drone/satellite feed of a valley."**
Simultaneously, it must remain a **legible tactical instrument** at every zoom: the player
commands by *reading the ground* (LOS, cover, draws, ridgelines). Gorgeous-but-unreadable fails.

**The target aesthetic: photoreal aerial/drone footage of a Hindu Kush valley that is also a
clean tactical map.** Think the satellite/terrain layers of high-end mil-sims (Arma, DCS map
view), the drone-cam look of *Restrepo*, married to the legibility of a great strategy-game map.

## Why attempt #1 was reverted (DO NOT REPEAT THIS)

Attempt #1 was technically excellent and **artistically timid**. Its governing principle was
**PARITY**: it moved the existing flat Canvas-2D relief bitmap onto the GPU *byte-for-byte*
("blit parity"), then added a live sun direction, cast ridge shadows, a moon, a time-of-day
color *grade* (a tint), cloud shadows and valley fog. Real improvements — but the terrain was
still the **same flat painted hillshade with a filter on top**. Its own gates were all
"match today's bake," "force the old NW key, diff against today," "26 landcover characters
survive pixel-for-pixel." The shader's core was literally `col = albedo * (0.34 + 0.95*shade)`
— a hillshade multiply over a pre-painted bitmap. **No real materials, no surface detail at
close zoom, no specular, no real water, no ambient occlusion, no tonemap, no bloom, unchanged
flat-SVG assets.** Result: "the same map, but the sun moves." The owner wanted transformation
and got conservation.

**Your mandate is the opposite of parity.** You may and should *transform* the look. The only
thing that is sacred is **legibility at every LOD band** (see contract below).

## What is REUSABLE (build on it — don't redo)

Recovered from git into `/tmp/itm-recover/` and recoverable via `git show c55bf19:<path>`:

- **`lib/render/sky.ts` (REUSE NEARLY VERBATIM).** The single source of sun/moon/light/grade
  truth. Verified solar geometry: δ=+21° at φ=34.8°N → sunrise 04:58 / sunset 19:02, landing
  inside the untouched `solarLight()` gameplay ramps. Exports `skyState(secondsOfDay, weather,
  solar) → SkyState` with `sunDir`, `sunAltDeg`, `sunColor`, `sunIntensity` (weather-folded),
  `skyColor/groundColor/skyIntensity` (hemisphere), `moonDir/moonFactor`, `keyDir/keyIsSun`,
  `shadowStrength`, `nightFactor ≡ 1−ambientLight()`, a `grade` block (exposure/WB/sat/lift),
  and `spriteShadow`. The weather single-fold rule (exposure carries weatherLightMult exactly
  once; weather else redistributes direct/ambient) prevents double-darkening. This is gold —
  extend its keyframe tables if you want richer color, but keep the geometry + contracts.
- **The bit-faithful heightmap port** (GLSL `heightAt`/`normalAt` in recovered `shaders.ts`):
  512² R32F + NEAREST + manual 4-tap bilinear = exact `Terrain.elevAt`. Keeps the 2D contours
  (drawn on the top canvas from the same array) welded to GL relief. **Keep this registration.**
- **The exponential-stride cast-shadow march** (recovered `SHADOW_FRAG`): 56 steps × 1.13^k
  spans the whole 2.56 km map, so a 780 m ridge at low sun throws a multi-km floor shadow
  (the marquee Korengal dawn image). Correct — reuse, refine penumbra.
- **The two-canvas integration** (recovered `terrain-gl.ts` + WorldView wiring): a WebGL2
  canvas UNDER a transparent Canvas-2D canvas (contours/units/FX/HUD stay 2D & crisp). DPR +
  shake-offset sync between layers. The `worldToScreen` inverse in the vertex shader.
  Alive **2D fallback** when WebGL2 is unavailable. Keep this skeleton.
- **The floor-field valley fog** (recovered `atmosphere-model.ts`): 128² local-valley-floor
  min-field → fog pools in the rising river draw, ridges poke out. Physically right for an
  orthographic camera. Reuse/upgrade.

The **timid shader** (`TERRAIN_FRAG_LIT`) and the **parity gates** are what you THROW AWAY.

## The live API you render from (exact, file:line)

- **Sun/clock** `lib/sim/world/world.ts`: `secondsOfDay` getter (:113), `solarLight()→[0.05,1]`
  (:122), `ambientLight()` (:130), `isNight()` (:133), `windVector()→{x,y}` m/s (:182). Day =
  86400 s. The clock IS the sun (local apparent solar time).
- **Weather** `state.weather`: `{label: "Clear"|"Hazy"|"Overcast"|"Rain"|"Fog"|"Snow",
  precip, visibilityM 600–4000, wind m/s, windDir}`.
- **Terrain** `lib/sim/terrain.ts`: 512² grid @ 5 m/cell = 2.56 km. `elev: Float32Array`
  (`elevAt(wx,wy)` :3137 bilinear). `slope: Float32Array` (:284, central-diff, >1.4 = cliff).
  `land: Uint8Array` of `Land` enum (26 classes, `LAND_COUNT=26` — see `landColor()` palette in
  `lib/render/topo.ts:23`). River centerline `centerX: Float32Array`; fords; `villages[]`;
  `cop: CopLayout` (HESCO ring, buildings, towers, mortar pit, LZ); `trailLines[]` (road/track/
  trail centerlines); `coverObjects[]` (boulders/rocks, drawn = sim). `cellCenter(cx,cy)` :3403.
- **Camera** `lib/render/topo.ts:4`: `{cx,cy,ppm,vw,vh}`. `ppm` = CSS px/meter (zoom).
  `worldToScreen`/`screenToWorld` :12/:16. `__setCam(x,y,ppm)` test hook in WorldView.
- **Render loop** `state/store.ts`: `frame(realDt)` (:542), `SIM_DT=0.1`, `getSimFrac()` for
  sub-tick interp. `window.__ITM` exposes the store. The 2D draw order lives in
  `components/world/WorldView.tsx`.
- **Sprites** `lib/render/sprites.ts`: 164 SVGs rasterized once → blit (`drawWorldSprite`,
  `drawScreenSprite`, `lodAlpha`). Manifest `lib/render/asset-manifest.generated.ts` built by
  `scripts/build-asset-manifest.mjs` from `docs/visual-overhaul/assets/*.svg` + `_meta.json`.
  Vegetation/rock scatter: `lib/render/decoration.ts` (stable-hash, FBM clumping).

## The LOD bands (legibility must hold at ALL of them)

- **Strategic** ppm ≤ 0.35 — the whole valley; reads as a relief/satellite map.
- **Operational** 0.35–1.2 — multi-village; terrain shape dominates.
- **Tactical** 1.2–3 — the COP and a village; structures legible.
- **Close** > 3 — individual soldiers, ground texture must resolve into real surface.

## The legibility contract (SACRED — the one guardrail on "go wild")

1. Contours stay welded to relief (don't break heightmap registration).
2. Units, orders, threat cues, fire-mission reticles, labels, HUD stay crisp and **ungraded**
   (the time-of-day tint touches world dressing/terrain, never the tactical symbology).
3. At noon (sun due south on a north-up map → flat) the relief must NOT invert or wash out —
   keep a form-light read at all 4 bands.
4. Fog/weather/night must never bury the tactical read below a legibility floor.
5. Determinism: the render layer is PURE w.r.t. (clock, weather, terrain seed). No wall-clock
   in world-anchored phenomena (clouds/fog/shadows follow the sim clock; only screen-space
   precip uses wall clock). Engine stays React-free; the layer line holds.

## Hard constraints

- **WebGL2** (the route the owner chose). Must run headless under **SwiftShader** (Chrome
  `--disable-gpu`, ~software) for the screenshot harness — no exotic extensions; prefer 8-bit
  UNORM textures + R32F height; everything cache-resident; honest per-frame cost on iGPU.
- **Robust**: context-loss handling; alive 2D fallback selected at one branch.
- Standing checks must stay green: `npx tsc --noEmit`, `npm run build`, `npm run lint`,
  `npx tsx scripts/smoke.ts`, `npx tsx scripts/balance.ts`.
- Verify with screenshots at the 4 LOD bands × times-of-day × weathers (matrix tool recovered
  at `/tmp/itm-recover/visual-matrix.mjs`; `shoot.mjs` drives the live app via CDP + `__setCam`).

## Reference imagery on disk

- Attempt-1 result (the timid look you must beat): `docs/progress/2026-06-12-webgl-terrain/c5-final/*.png`
- Pre-WebGL baseline: `docs/visual-overhaul/after/*.png`, `docs/visual-overhaul/baseline/*.png`
- Art direction: `docs/visual-overhaul/ART_BIBLE.md`
- Attempt-1 design corpus (excellent technical detail; timid art ambition):
  `/tmp/itm-recover/docs/DESIGN.md`, `judge-*.md`
