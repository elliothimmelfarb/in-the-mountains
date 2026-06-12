# atmosphere — cloud shadows, terrain-aware valley fog, aerial perspective, and the evolution of the 2D weather layer

confidence: 0.82

## Summary
The atmosphere layer makes the valley breathe: a world-anchored two-octave cloud-shadow field (CPU-baked tileable FBM texture, sampled in the terrain fragment shader) drifts with the live windVector and the master clock — sparse hard-edged cumulus shadows on Clear days, broad soft mottle under Overcast, frozen when paused and racing like timelapse at 8x warp, with sun-parallax projection off weather.ceiling so ridge tops sit closer to the deck than the river. Valley fog becomes physically pooled: a once-baked 128-square "local valley floor" min-field plus a diurnal radiation-fog schedule (mist builds after midnight, peaks at dawn in the 1550-1700 m river draw, burns off by 09:30 — consistent with solarLight()'s 07:00 full-sun) gives per-pixel exponential transmittance through the fog layer; Fog weather drives depth straight from weather.ceiling (300 m), reproducing the Korengal inversion layer with ridges poking out — and visually explaining airAvailable=false. The 2D layer stays consistent via one shared TS module: fogVisAt(wx,wy) samples the SAME Float32 floor-field and noise arrays the GPU uses, so sprites/decoration fade with the fog while tactical symbology is clamped to a 0.55 alpha floor (legibility never loses). The baked warm-low/cool-high haze (topo.ts:298-309) moves into the shader as live aerial perspective, now weather- and zoom-aware. drawWeather sheds its veil and fog blobs (replaced by GL terms) and keeps only the crisp screen-space precip particles, which remain wall-clock. Cheap extras land as two albedo uniforms: sim-clock-integrated ground wetness during/after precip and a dynamic snow line that descends from the baked 68% cap toward 40% during Snow weather. All parameters are low-pass filtered over ~90 s of sim time so the 4-9 h weather re-rolls roll in instead of popping. Cost: 4 small-texture fetches + ~40 ALU per terrain pixel and 144 KB of texture — well inside budget next to the lighting axis's shadow march, and the 2D canvas actually gets cheaper (fullscreen gradient blobs deleted).

## Design
# Atmosphere Axis — Cloud Shadows, Valley Fog, Aerial Perspective, 2D Weather Evolution

## 0. Contract with the other axes

This axis owns the **atmospheric terms** of the terrain fragment shader and the **shared TS atmosphere module** that keeps the 2D canvas consistent with the GL underlayer. It assumes from the other axes (per DECIDED):

- The terrain fragment shader already computes, per pixel: `worldM` (vec2, world metres), `elev` (m, from the 512² heightmap), `altNorm = (elev - uElevMin) / uElevRange`, `N` (normal), `sunVis` (cast ridge-shadow term), `direct` and `ambient` light scalars/colors, `cliff` (cliffness 0..1, from the same slope derivation the normals use), and `albedo` (from the 4096² albedo texture / splat — texture axis).
- The time-of-day grade axis owns the global color grade and the night wash replacement (topo.ts:587-592 deletion). This axis owns every **altitude-, weather-, and cloud-dependent** term and composes BEFORE the global grade.
- **Cross-axis deletion I require:** the albedo bake must become *grade-free* — the baked altitude warm/cool + haze block at `lib/render/topo.ts:296-309` is deleted from `makeBake` (those lines move into this shader, live). The baked static snow cap should also move to the shader (it is pure elevation+slope, and unifying it with dynamic accumulation removes a seam) — texture axis's call; both layouts are handled below.

## 1. Components & files

| Component | Path | What it is |
|---|---|---|
| Atmosphere param model + integrators | `lib/render/gl/atmosphere.ts` (new, React-free) | Weather→uniform table, fog schedule, cloud-offset / wetness / snow integrators, parameter low-pass filter, `AtmoFrame` uniform pack |
| Shared CPU samplers (2D-canvas consistency) | same file | `fogVisAt(wx,wy)`, bilinear samplers over the SAME Float32 arrays uploaded to the GPU |
| Noise tile bake (one-time, seeded) | same file | 256² two-channel tileable FBM (`Float32Array` → R8G8 texture) |
| Valley-floor field bake (one-time) | same file | 128² local-min-filtered elevation (`Float32Array` → R8 texture normalized over [minElev, range]) |
| GLSL chunk | `lib/render/gl/shaders/atmosphere.glsl.ts` (new) | Exported GLSL string: uniform decls + `cloudField/cloudShadow/fogT/applyAtmosphere` functions, spliced into the terrain shader by the GL-core axis |
| 2D weather slim-down | `lib/render/topo.ts:640-761` | Veil + fog blobs deleted; precip particles kept |
| Sprite/decoration fog hookup | `components/world/WorldView.tsx` draw() | Multiply world-anchored draw alphas by `fogVisAt` with per-class floors |

**Data flow (per frame, inside WorldView's existing draw()):**
```
world.state.clock ──┐
world.windVector() ─┼─► atmo.step(world, cam)           // CPU, ~µs
world.state.weather ┘      │  integrates cloud offsets (Δclock × wind),
world.ambientLight()       │  wetness, snowAcc; low-pass filters params (τ≈90 s sim)
                           ▼
                    AtmoFrame { uniforms… }
                      ├─► GL underlayer uniform upload (terrain shader)
                      └─► fogVisAt(wx,wy) closures → 2D sprite/decoration alphas
```
No store changes; the integrator is a module-level object keyed to the World instance (reset when the World identity changes, exactly like the bake's WeakMap).

## 2. Cloud shadows

### 2.1 Where computed — DECISION: CPU-baked tileable FBM **texture**, sampled in-shader
Not live GLSL hash-FBM. A 4-5-octave hash FBM per pixel is ~100+ ALU; on the SwiftShader harness path (`--use-angle=swiftshader`) that is the difference between a usable screenshot run and a crawl. Two fetches from a 256² R8G8 texture (resident in L1 forever) + a smoothstep gets the same look for ~6 ALU. The texture is baked once at boot from a **fixed seed** (deterministic, no Math.random):

```ts
// lib/render/gl/atmosphere.ts — one-time, deterministic, tileable value-noise FBM
function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function bakeCloudTile(N = 256): { base: Float32Array; detail: Float32Array } {
  const mk = (octaves: number, seed: number) => {
    const out = new Float32Array(N * N);
    for (let o = 0, amp = 0.5, freq = 4; o < octaves; o++, amp *= 0.5, freq *= 2) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = (x / N) * freq, fy = (y / N) * freq;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;          // smoothstep-interpolated lattice
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const w = (xi: number, yi: number) => hash2(((xi % freq) + freq) % freq, ((yi % freq) + freq) % freq, seed + o); // modulo lattice → TILES
        out[y * N + x] += amp * ((w(x0,y0)*(1-sx)+w(x0+1,y0)*sx)*(1-sy) + (w(x0,y0+1)*(1-sx)+w(x0+1,y0+1)*sx)*sy);
      }
    }
    return out; // ~[0,1)
  };
  return { base: mk(5, 101), detail: mk(3, 202) };
}
```
Uploaded as one **RG8 texture, LINEAR, REPEAT** (R=base, G=detail; 8-bit UNORM is filterable everywhere — no float-linear extension hazard). The `Float32Array`s are **retained** for the TS-side parity samplers (§3.3).

### 2.2 The shader terms (load-bearing GLSL)
```glsl
uniform sampler2D uCloudTex;  // 256² RG8 tileable FBM (R base, G detail), LINEAR/REPEAT
uniform vec2  uCloudOff0;     // base-layer world-space scroll offset (m) — CPU-integrated
uniform vec2  uCloudOff1;     // detail-layer offset (advected at 1.6× — interior churn)
uniform vec2  uSunXY;         // sun dir horizontal (lighting axis's sun model)
uniform float uSunZ;          // sun dir vertical (>0 above horizon)
uniform float uCloudCover;    // coverage THRESHOLD (lower = more sky covered)
uniform float uCloudDense;    // max occlusion of the DIRECT term — hard cap 0.45 (legibility)
uniform float uCloudSoft;     // shadow edge half-width
uniform float uCloudMottle;   // ambient luminance mottle amplitude (overcast labels)
uniform float uCloudAlt;      // cloud deck height above valley mean floor (m) ← weather.ceiling

float cloudField(vec2 worldM) {
  // WORLD-anchored wavelengths: 1800 m base shapes, 450 m interior detail.
  float base = texture(uCloudTex, (worldM + uCloudOff0) / 1800.0).r;
  float det  = texture(uCloudTex, (worldM + uCloudOff1) /  450.0).g;
  float d = base * 0.78 + det * 0.22;          // big shapes carry; detail breaks the edges
  return smoothstep(uCloudCover - uCloudSoft, uCloudCover + uCloudSoft, d);
}
// multiplies the DIRECT sun term only (sky/ambient barely sees cumulus)
float cloudShadow(vec2 worldM, float elev) {
  // project the deck onto the ground along the sun ray: dawn shadows displace
  // down-sun; ridge tops (closer to the deck) displace less than the river floor.
  float h = max(0.0, uCloudAlt - (elev - uElevMin));
  vec2 off = clamp(uSunXY / max(uSunZ, 0.25) * h, vec2(-2000.0), vec2(2000.0));
  return 1.0 - uCloudDense * cloudField(worldM + off);
}
// overcast labels: diffuse light has no crisp shadows — a low-amplitude luminance
// mottle keeps the ground alive instead (applied to ambient):
float cloudMottle(vec2 worldM) {
  float lf = texture(uCloudTex, (worldM + uCloudOff0 * 0.6) / 2600.0).r;
  return 1.0 - uCloudMottle * (lf - 0.5) * 2.0;   // ±uCloudMottle around 1
}
```

### 2.3 Per-label parameters (TS table, exhaustive over the 6 labels)
```ts
//                cover  dense  soft  mottle  veilA  — cover is a threshold: ↓cover = ↑coverage
const CLOUD = {
  Clear:    { cover: 0.62, dense: 0.34, soft: 0.10, mottle: 0.00, veil: 0.00 }, // sparse, hard cumulus
  Hazy:     { cover: 0.52, dense: 0.24, soft: 0.18, mottle: 0.05, veil: 0.05 },
  Overcast: { cover: 0.30, dense: 0.18, soft: 0.26, mottle: 0.10, veil: 0.08 }, // broad soft occlusion
  Rain:     { cover: 0.22, dense: 0.28, soft: 0.30, mottle: 0.12, veil: 0.10 }, // heavy
  Snow:     { cover: 0.25, dense: 0.26, soft: 0.28, mottle: 0.10, veil: 0.09 }, // heavy
  Fog:      { cover: 1.00, dense: 0.00, soft: 0.30, mottle: 0.06, veil: 0.12 }, // no cast shadows under fog
} as const satisfies Record<WeatherLabel, …>;
```
Realism note: under Overcast/Rain the lighting axis's direct-sun fraction already collapses (consistent with `weatherLightMult`), so `dense` mostly bites on Clear/Hazy — which is correct: crisp cloud shadows only exist in direct sun. `uCloudAlt = clamp(weather.ceiling, 400, 3000)`.

### 2.4 Clock — DECISION: sim-clock advection (frozen when paused), precip stays wall-clock
Cloud offsets are **integrated on the CPU**: `off0 += windVector × Δ(world.state.clock)` each frame (Δ clamped to [0, 60] to survive loads; negative Δ → re-seed). Why integration and not `clock × wind`: weather re-rolls every 4-9 h change `windDir` discontinuously — closed-form phase would teleport every shadow on the map; integration just bends the streamlines. Seed offset at world load from the terrain seed (deterministic start).

Why sim-clock: the sun (DECIDED) is tied to the master clock, so at 8× warp the terminator sweeps fast — clouds racing with it like timelapse footage is one of the cheapest "holy shit" moments available, and wall-clock clouds would crawl incoherently under a speeding sun. At pause, sun, units, AND clouds freeze — the paused map is a still photo, which is correct feedback while planning. The screen-space precip particles (§5) stay **wall-clock** (unchanged, topo.ts:624-626) so the UI never looks hung during pause. This split is intentional: world-anchored phenomena follow world time; screen-space ephemera follow the player's time.

### 2.5 The scale question — answered with numbers
Wavelengths are fixed in WORLD space, never screen space. The map is 2560 m:
- **Strategic (ppm 0.28, full valley visible):** base 1800 m wavelength with cover thresholding yields 3-6 distinct shadow patches of ~400-900 m — unmistakably clouds over a valley, not noise. (DO-NOT shrink the base below ~1200 m: smaller reads as sensor dirt at this zoom.)
- **Tactical (ppm 2, ~700×450 m on screen):** one shadow edge crossing the screen, broken up by the 450 m detail channel — reads as "a cloud is passing over the fight," with the 450 m octave preventing a flat full-screen dim.
- Edge sharpness scales with label (`soft` 0.10 Clear → 0.30 Rain), so Clear-day cumulus have the crisp aerial-footage edge while bad-weather occlusion is shapeless, as it should be.

## 3. Terrain-aware valley fog

### 3.1 The floor field (the trick that makes pooling real)
Fog must hug the river draw, whose floor RISES 1550→2000 m south along the valley — a fixed MSL ceiling would fog the north half and miss the south. Bake once at terrain load: separable **min-filter** over the 512² elev (radius ~12 cells ≈ 60 m) → box blur (radius ~20 cells ≈ 100 m) → downsample to **128² R8** normalized over [minElev, elevRange] (UNORM = filterable everywhere; quantization 450/255 ≈ 1.8 m, invisible after the blur). This gives "height of the local valley floor" everywhere — fog pools in the main draw AND tributary draws automatically. Retain the Float32 version for the TS sampler.

### 3.2 Density model — vertical transmittance (load-bearing GLSL)
For a top-down camera the path length through a pooled layer is exactly the fog thickness above the terrain point — so transmittance is closed-form per pixel, no ray march:
```glsl
uniform sampler2D uFloorTex;   // 128² R8 local-valley-floor, LINEAR/CLAMP
uniform float uFogTopAdd;      // fog depth above local floor (m) — CPU schedule, low-passed
uniform float uFogK;           // extinction per metre (≈0.012)
uniform vec3  uFogColor;       // PRE-SCALED by the gameplay light curve on CPU — never glows at night
uniform float uWorldSize;      // 2560

float fogT(vec2 worldM, float elev) {
  float floorE = uElevMin + texture(uFloorTex, worldM / uWorldSize).r * uElevRange;
  // organic bank edge: wobble the top with the slow cloud channel (reuses uCloudTex)
  float wob = (texture(uCloudTex, (worldM + uCloudOff0 * 0.35) / 900.0).r - 0.5) * 30.0;
  float depth = max(0.0, (floorE + uFogTopAdd + wob) - elev);  // metres of fog on the view ray
  return exp(-uFogK * depth);
}
```
With Fog-weather depth 300 m and k=0.012: river floor T≈0.03 (white-out), 150 m up-slope T≈0.16, ridge tops (+780 m) fully clear — the classic Korengal inversion with ridgelines floating above the cloud, and a visual explanation of `airAvailable=false`.

### 3.3 The schedule (CPU, consistent with solarLight)
```ts
function fogDepthM(world: World): number {
  const h = world.secondsOfDay / 3600;
  const w = world.state.weather;
  // Radiation fog: builds after midnight, peaks at dawn, burns off by mid-morning.
  // CONSISTENT with solarLight(): ramp 05-07, full sun 07:00 → mist gone by 09:30.
  const dawn = smoothstep(1.5, 5.5, h) * (1 - smoothstep(7.0, 9.5, h));
  // Radiation fog wants CLEAR, CALM nights (cold-air pooling) — wind tears it apart.
  const calm = clamp01(1 - w.wind / 6);
  const dawnDepth = (w.label === "Clear" || w.label === "Hazy" ? 70 : 40) * dawn * calm;
  const base = w.label === "Fog" ? Math.min(w.ceiling, 350)        // the dramatic case
             : w.label === "Rain" ? 45 : w.label === "Snow" ? 35
             : w.label === "Overcast" ? 25 : 0;                    // persistent valley mist
  return Math.max(base, dawnDepth);
}
```
`uFogColor` = dayFog(196,200,198) → dawn-warm tint (lerp toward (212,196,176) when uSunZ < 0.25) → multiplied by `0.12 + 0.88 * world.ambientLight()` so fog is near-black under starlight and never fights the night grade. All fog params go through the 90 s low-pass, so a Fog re-roll **rolls in over a minute** instead of popping.

### 3.4 Sprites above the fog — the reconciliation
DECIDED keeps FX/units on the 2D canvas, so GL cannot occlude them. Resolution: **one shared TS function over the same data the GPU samples** — exact parity because both sides read the identical baked Float32 arrays (GPU filtering vs TS bilinear differ only at the LSB):
```ts
// lib/render/gl/atmosphere.ts — used by the 2D layer
export function fogVisAt(a: AtmoFrame, wx: number, wy: number): number {
  const floorE = a.elevMin + bilinear(a.floorF32, 128, wx / a.worldSize, wy / a.worldSize) * a.elevRange;
  const wob = (bilinear(a.cloudBaseF32, 256, (wx + a.off0x * 0.35) / 900, (wy + a.off0y * 0.35) / 900) - 0.5) * 30;
  return Math.exp(-a.fogK * Math.max(0, floorE + a.fogTopAdd + wob - a.terrain.elevAt(wx, wy)));
}
```
**Per-class legibility floors (the map stays a tactical map):**
- Decoration (trees/rocks, `drawDecoration`), civilians, qalat footprints, scorch/crater decals: `alpha *= fogVis` (fade fully — they are scenery).
- Tactical symbology (squad icons, village pins, labels, intel markers, feature glyphs): `alpha *= 0.55 + 0.45 * fogVis` — **never below 0.55**; selection rings and HUD never fade. Enemy contact markers get the same floor: the sim's `visibilityM` perception gate already decides WHETHER you know about them; what is drawn is known, so it stays readable.
- Contours/paths (drawn live in drawTerrain): dim by at most 35% (`0.65 + 0.35 * fogVis`).
- Smoke (`drawSmoke`) draws over fog untouched — smoke above a fog layer is plausible and it is a combat signal.
A `scratch-atmo-parity.ts` harness asserts |TS − GLSL(readPixels)| < 0.02 on 64 probe points before Phase D ships.

## 4. Aerial perspective (replaces baked topo.ts:296-309)
The baked altitude grade and haze are deleted from `makeBake` and become live shader terms, now weather- and zoom-aware:
```glsl
uniform float uHazeK;       // CPU: 0.105 * (1.2 - visibilityM/4000) * zoomBoost
uniform vec3  uHazeColor;   // (164,170,166)/255 base, warmed when uSunZ low
uniform float uAltWarm;     // 0.08  — preserved from the bake (don't regress the look)
uniform float uAltCool;     // 0.13

vec3 applyAtmosphere(vec3 lit, vec2 worldM, float elev, float altNorm) {
  lit.r *= 1.0 - altNorm * uAltWarm;            // low ground warm…
  lit.b *= 1.0 + altNorm * uAltCool;            // …high ground cool & clear (was bake :299-303)
  float t = exp(-uHazeK * (1.0 - altNorm));     // ≈ bake's 10%-at-floor haze at uHazeK=0.105
  lit = mix(uHazeColor, lit, t);                // (was bake :306-309)
  lit = mix(uVeilColor, lit, 1.0 - uVeilA);     // flat weather veil (absorbed from 2D §1)
  return mix(uFogColor, lit, fogT(worldM, elev));  // pooled fog LAST — it is nearest the camera
}
// composition upstream: lit = albedo * (direct * sunVis * cloudShadow(worldM, elev)
//                                       + ambient * cloudMottle(worldM));
```
**Distance-from-camera desaturation: not warranted** — the camera is orthographic top-down; every pixel is equidistant, so radial distance grading is physically false here. The honest version of "pulling out adds air": `zoomBoost = lerp(1.35, 1.0, clamp01((ppm - 0.2) / 0.6))` on `uHazeK` — strategic zoom reads as viewing from higher altitude through more atmosphere. One uniform, and it doubles as a gentle strategic-zoom unifier without a separate desat pass.

## 5. What remains of drawWeather (topo.ts:640-761)
| Section | Fate | Why |
|---|---|---|
| §1 Veil (topo.ts:652-669) | **DELETE** → GL `uVeilA/uVeilColor` (same per-label alphas, table §2.3) | A fullscreen fillRect that belongs in the shader; z-order identical (current veil draws under units anyway, WorldView.tsx:229 precedes all unit drawing) |
| §2 Fog blobs (topo.ts:671-696) | **DELETE** | Fully superseded by real pooled fog + cloud mottle; these were the placeholder for exactly what GL now does |
| §3 Precip particles (topo.ts:698-760) | **KEEP, unchanged** | Crisp screen-space vector ephemera — the 2D canvas's home turf; GL buys nothing. Frozen-grid + wall-clock + snow-elevation gate all stay |
| Night wash (topo.ts:587-592) | DELETE — owned by the grade axis | Flagged as the cross-axis seam; until that lands, the wash stays |
`drawWeather` slims to precip-only; `WeatherView` keeps `label/precip/windX/windY/minElev/elevRange/elevAt` and drops `visibilityM/wind` veil duties (note: `lib/render/draw.ts:361` mirrors WeatherView in a comment — update it).

## 6. Cheap extras — wetness & snow accumulation (albedo uniforms)
Two scalars integrated in `atmo.step()` from Δsim-clock (clamped), passed as uniforms; **not persisted** (a reload after a storm loses the wet sheen — recorded as an accepted residual; promote to `serialize()` later if the owner cares):
- `uWet`: `+Δt/1200` while `weather.precip` (rain saturates in ~20 min), `−Δt/5400` drying (faster ×(0.5+solarLight)). Shader: `albedo *= 1.0 - 0.26 * uWet * (1.0 - cliff * 0.6);` — wet ground darkens, sheer rock sheds water. Slope-weighted so scree slopes darken less than the river flats.
- `uSnowAcc`: `+Δt/7200` during Snow (2 h to full), melt `−Δt/43200 × (0.3 + solarLight)`. Shader (assuming snow moves fully to shader, preferred — else restrict to the 0.40-0.68 band below the baked cap):
```glsl
float snowLine = mix(0.68, 0.40, uSnowAcc);               // accumulation lowers the line
float sK = smoothstep(snowLine, snowLine + 0.07,
                      altNorm + (texture(uCloudTex, worldM / 180.0).g - 0.5) * 0.08) // patchy edge
         * (1.0 - cliff) * clamp(uSnowAcc * 3.0 + bakedCapK, 0.0, 1.0);
albedo = mix(albedo, vec3(0.88, 0.90, 0.94), sK * 0.85);
```
This couples with the existing 2D flake-density elevation gate (topo.ts:734-742, snow line 0.55) — flakes already concentrate where snow will visibly stick. No change needed there.

## 7. Phases (game never broken between phases)
- **A. Module only** — `lib/render/gl/atmosphere.ts`: tables, schedule, integrators, both bakes, TS samplers; `scratch-atmo-parity.ts` (TS-vs-formula golden values). Zero visual change. tsc/build/smoke green.
- **B. Shader splice, neutral defaults** — `atmosphere.glsl.ts` chunk composed into the terrain shader with uniforms defaulted to reproduce the baked look exactly (uHazeK=0.105, warm/cool 0.08/0.13, clouds/fog/veil off); delete bake lines topo.ts:296-309 in the same commit the GL underlayer becomes the active terrain path (coordinated with texture axis). Screenshot A/B vs HEAD bake must be near-identical.
- **C. Cloud shadows on** — Clear/Hazy first, then the full table; `scripts/visual-matrix.mjs --webgl` across 4 LOD bands × {dawn, noon, dusk, night} × {Clear, Overcast}; verify frozen-on-pause and 8×-warp racing live.
- **D. Fog on** — GL fog + the 2D `fogVisAt` hookups (WorldView decoration/pins/markers, drawCop, drawDecoration) + delete drawWeather §1-2; parity harness gate; dawn-mist timelapse screenshot strip (04:00→10:00) as the evidence artifact.
- **E. Extras** — uWet, uSnowAcc, strategic haze zoomBoost. Balance/smoke untouched throughout (render-only); standing checks each phase.

## 8. Legibility guards (named constants, enforced in the table)
`CLOUD_DENSE_MAX = 0.45` · `SYMBOLOGY_FOG_FLOOR = 0.55` · `CONTOUR_FOG_FLOOR = 0.65` · `VEIL_A_MAX = 0.18` (matches today's max ≈0.20) · base cloud wavelength ≥ 1200 m. Every cap lives in `atmosphere.ts` next to the table, with a comment naming the contract: realism never beats the tactical read.

## Key decisions
- **Cloud noise = one-time CPU-baked 256-square tileable two-channel FBM texture (RG8, LINEAR, REPEAT), sampled twice in the terrain shader with wind-scrolled world-space UVs**
  - rejected: Live hash-FBM in GLSL (rejected: ~100+ ALU/pixel, crawls on the SwiftShader headless harness path; buys nothing visually over a scrolled texture). Per-frame CPU-rendered scrolling shadow canvas uploaded as a texture (rejected: per-frame texSubImage upload + CPU fill for something two texture fetches do free).
  - why: Two fetches from a 64 KB always-resident texture + a smoothstep is ~6 ALU, deterministic (fixed-seed bake, no Math.random), works on integrated GPUs and SwiftShader, and retaining the Float32 source array gives the 2D layer an exact-parity CPU sampler for free.
- **Cloud advection uses sim-clock (CPU-integrated offset += windVector x delta(world.state.clock)); precip particles stay wall-clock**
  - rejected: Wall-clock clouds (rejected: at 8x warp the DECIDED master-clock sun sweeps fast while clouds crawl - incoherent; and clouds moving during pause contradicts the frozen sun). Closed-form clock x wind phase (rejected: weather re-rolls every 4-9 h change windDir discontinuously and would teleport every shadow; integration just bends streamlines).
  - why: World-anchored phenomena follow world time: pause = still photo (good planning feedback), 8x warp = timelapse clouds racing with the terminator (the cheapest available 'holy shit' moment). Screen-space precip on wall-clock keeps the UI visibly alive during pause.
- **Fog pooling is computed against a baked 128-square 'local valley floor' min-filtered elevation field, with depth = f(time-of-day, weather) ABOVE that local floor, and transmittance = exp(-k x thickness) closed-form per pixel**
  - rejected: Fixed MSL fog ceiling (rejected: the river floor rises 1550 to 2000 m south - a fixed ceiling drowns the north half and never fogs the south draw). Volumetric ray-march (rejected: pointless for an orthographic top-down camera where the path length through a pooled layer IS the layer thickness - closed form is exact, not an approximation).
  - why: The floor field makes fog hug the main river draw AND tributary draws automatically, reproducing the Korengal dawn inversion (ridges poking out of a 300 m fog deck under Fog weather, driven directly by the sim's weather.ceiling), for one 16 KB texture fetch and one exp().
- **2D sprite/fog consistency via one shared TS function (fogVisAt) sampling the SAME Float32 arrays the GPU textures were uploaded from, with per-class alpha floors (symbology never below 0.55)**
  - rejected: A second GL overlay canvas on top for fog (rejected: DECIDED says FX/units stay on the 2D canvas; adds a third canvas and compositing cost). Fading nothing (rejected: units floating bright over a white-out destroys the effect). Fading everything fully (rejected: the map must stay a legible tactical map - the sim's visibilityM perception gate already decides what you KNOW; what is drawn must stay readable).
  - why: Shared source arrays give exact parity (verified by a scratch parity harness), zero new canvases, and the class-based floors encode the legibility contract explicitly: scenery fogs out, symbology dims at most 45%.
- **Baked altitude warm/cool + haze (topo.ts:296-309) deleted from makeBake and moved into the shader as live, weather- and zoom-aware aerial perspective; distance-from-camera desaturation NOT implemented**
  - rejected: Keeping the haze baked (rejected: it double-applies once GL fog/veil exist, and a baked haze cannot respond to visibilityM or zoom). Radial distance desat at strategic zoom (rejected: orthographic top-down camera - every pixel is equidistant, the effect is physically false here).
  - why: Same default coefficients (0.08 warm / 0.13 cool / ~10% floor haze) preserve the proven look at Phase B, then visibilityM scales haze strength (Hazy days show real depth grading) and a ppm-driven hazeK boost (1.35x at strategic) gives the honest version of 'pulling out adds air'.
- **drawWeather keeps ONLY the precip particle system; veil and fog blobs are deleted (absorbed by GL veil uniform + real pooled fog); all atmosphere parameters low-pass filtered over ~90 s sim time**
  - rejected: Porting precip to GL points (rejected: screen-space frozen-grid vector streaks are exactly what the 2D canvas does well, and they sit at the same z-order today - under units - so nothing improves). Letting weather re-rolls switch params instantly (rejected: a 4-9 h re-roll would pop the whole sky in one frame).
  - why: The veil is a fullscreen fillRect that belongs in the shader for free; the blobs were a hand-drawn placeholder for exactly what the pooled fog now does physically; the low-pass makes fog ROLL IN over a minute, which is both more real and more dramatic.

## Integration points
- lib/render/gl/atmosphere.ts (new) — Atmosphere module: per-label uniform table, fog schedule (dawn radiation fog consistent with solarLight ramp 05-07), cloud-offset/wetness/snow integrators keyed on delta(world.state.clock), 90 s param low-pass, one-time bakes (256sq RG8 FBM tile, 128sq R8 valley-floor min-field), TS samplers fogVisAt/bilinear for the 2D layer, AtmoFrame uniform pack.
- lib/render/gl/shaders/atmosphere.glsl.ts (new) — Exported GLSL chunk (uniform decls + cloudField/cloudShadow/cloudMottle/fogT/applyAtmosphere) spliced into the terrain fragment shader by the GL-core axis; composition contract: lit = albedo*(direct*sunVis*cloudShadow + ambient*cloudMottle) then applyAtmosphere (alt grade, haze, veil, fog last).
- components/world/WorldView.tsx:229-234 — drawWeather call stays at the same z-order but the view slims to precip-only fields; immediately before it, call atmo.step(world, cam) and hand the AtmoFrame to the GL underlayer's uniform upload (the underlayer element the GL-core axis adds under the existing canvas at WorldView.tsx:810).
- lib/render/topo.ts:652-696 — DELETE drawWeather section 1 (veil fillRect) and section 2 (drifting fog blobs) once GL veil+fog are live (Phase D); section 3 precip (topo.ts:698-760) is kept verbatim, wall-clock and frozen-grid unchanged.
- lib/render/topo.ts:296-309 — DELETE the baked altitude warm/cool grade and valley haze from makeBake in the same commit the GL underlayer becomes the active terrain path (coordinate with texture axis - the albedo bake must ship grade-free); shader defaults in Phase B reproduce these exact coefficients.
- lib/render/topo.ts:587-592 — Night wash deletion - owned by the time-of-day grade axis; flagged here as the seam this axis depends on (fog color is pre-scaled by ambientLight so it composes correctly under the new grade).
- components/world/WorldView.tsx:223 (drawDecoration), :290-306 (qalat/pin draws), :357 (drawCop), and the decal/scorch draw block near :359+ — Multiply world-anchored draw alphas by fogVisAt(frame, wx, wy) with per-class floors: scenery/decoration/civilians full fade; tactical symbology alpha floor 0.55; contours/paths floor 0.65 (inside drawContoursLive/drawPathsLive via an optional fogVis param).
- lib/render/draw.ts:361 — Comment references WeatherView mirroring drawWeather's struct - update when WeatherView slims to precip-only fields.
- scripts/scratch-atmo-parity.ts (new, disposable) — Parity gate before Phase D ships: evaluates TS fogVisAt vs GLSL fogT via readPixels on 64 probe points, asserts max abs diff < 0.02; deleted after the phase lands per scratch-* convention.

## Risks
- [high] Fog or cloud shadows hide the fight - the tactical read degrades at exactly the moment (TIC under Fog weather at dawn) the player most needs it → Hard named caps in one place (CLOUD_DENSE_MAX=0.45, SYMBOLOGY_FOG_FLOOR=0.55, VEIL_A_MAX=0.18, contour floor 0.65); symbology/HUD/selection rings never fade; screenshot-matrix gate at all 4 LOD bands x Fog-dawn worst case before Phase D merges; the sim's perception gate is untouched so no gameplay information is lost, only restyled.
- [medium] 2D sprites visibly mismatch GL fog at the fog-bank edge (a tree fading where the terrain looks clear, or vice versa) → Both sides sample the SAME baked Float32 arrays (floor field + noise tile) with the same closed-form formula - the only divergence is GPU texture filtering LSBs; scratch-atmo-parity.ts asserts <0.02 transmittance error on 64 probes; the wobble term is shared, not approximated.
- [medium] Cloud shadows misread as terrain relief in a still frame (screenshots, pause) - a dark patch on a slope looks like a reentrant → Density cap 0.34 on Clear (shadows never approach the darkness of the cast ridge-shadow term), soft edges per label, 1800 m world-anchored shapes too large to alias with 5 m terrain features, and motion disambiguates in play; pause-frame review included in the Phase C screenshot matrix.
- [medium] SwiftShader headless harness path renders the atmosphere terms too slowly or incorrectly (float filtering, exp precision) → All atmosphere textures are 8-bit UNORM (RG8/R8) with LINEAR - universally filterable, no OES_texture_float_linear dependency; added cost is 4 small-texture fetches + ~40 ALU, dwarfed by the lighting axis's shadow march; visual-matrix.mjs --webgl (--use-angle=swiftshader) runs are a standing check from Phase B on.
- [low] Weather re-roll (every 4-9 h) pops the sky: veil, fog depth, cloud coverage all jump in one frame → All atmosphere parameters pass through a 90 s sim-time low-pass in atmo.step(); wind discontinuities cannot teleport clouds because offsets are integrated, not closed-form.
- [low] Wetness/snow accumulation state is not persisted - reload after a storm loses the wet ground → Recorded as an accepted residual (cosmetic-only, re-converges within ~20 min of sim time); if the owner wants it, two floats added to serialize()/loadWorld() with a save-version bump - flagged in open questions rather than silently widening the save schema.

## Perf budget
GPU per frame (added by this axis to the terrain fragment shader): 4 fetches from tiny resident textures (256sq RG8 cloud tile = 128 KB, 128sq R8 floor field = 16 KB - both live in cache permanently) + ~40 ALU including one exp() and one clamped division, per terrain pixel. At 1920x1080 dpr1 (~2.1 MPix) on an Intel Iris Xe-class iGPU this is well under 0.5 ms - an estimated 10-15% increment on the terrain pass, whose cost is dominated by the lighting axis's ridge-shadow march, not these terms. At dpr2 (~8.3 MPix) it scales to ~1.5-2 ms worst case, still comfortably inside a 16.6 ms frame that today runs at ~116 fps with headroom. CPU per frame: atmo.step() is a few dozen float ops (offset integration, table lerp, low-pass) plus ~16 uniform uploads - microseconds; fogVisAt is called per world-anchored 2D draw (~100-300 calls/frame at tactical zoom), each ~20 float ops + one elevAt bilinear = well under 0.1 ms. One-time costs: cloud tile bake ~5 ms, floor-field bake (separable min+blur over 512sq, downsample) ~10-20 ms, both inside the existing multi-second deploy bake window. Texture memory added: 144 KB total - noise next to the 64 MB 4096sq albedo upload the GL core already budgets. The 2D canvas gets CHEAPER: the deleted fullscreen veil fillRect and up to 3 fullscreen radial-gradient blobs (among the slowest canvas2d ops) save an estimated 1-2 ms on Fog/Overcast frames. Net: atmosphere holds 60 fps with margin on integrated GPUs alongside the existing 2D pass, and the worst pre-existing frame (Fog weather) actually improves on the 2D side.

## Open questions
- Does the GL-core terrain shader expose cliffness/slope to my chunk, or do I derive it from heightmap derivatives locally? (Design assumes the normals' central-difference is reusable; trivial either way, but the splice contract should name it.)
- Snow ownership: does the texture axis keep the static 68%-elevation snow cap baked into the albedo, or move it to the shader as preferred here? Dynamic accumulation works in both layouts but unifying in-shader removes a visible seam at the baked cap edge.
- Is weather.ceiling AGL (above valley floor) or MSL? Design treats it as height above the valley mean floor for uCloudAlt and Fog depth; confirm against the air-support availability code before Phase C.
- Should uWet/uSnowAcc be persisted in serialize()/loadWorld() (save-version bump) or stay an accepted cosmetic residual? Defaulting to residual; owner's call.
- Sun-parallax cloud projection (offset by ceiling height along the sun ray) is included at ~3 ALU - if the synthesis judge finds it visually negligible at top-down zooms in Phase C screenshots, it deletes cleanly to a constant offset.
- Exact uniform-block plumbing (single UBO vs individual uniforms) belongs to the GL-core axis - AtmoFrame is presented as a flat struct and adapts to either.
