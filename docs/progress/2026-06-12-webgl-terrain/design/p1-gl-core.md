# WebGL terrain core — shader architecture replacing the baked-bitmap blit

confidence: 0.82

## Summary
A WebGL2 underlayer canvas replaces the 4096² baked-bitmap blit with one fullscreen-triangle draw: a CPU-baked UNLIT albedo (the existing bake minus its lighting terms, so all 26 landcover characters survive pixel-for-pixel) modulated per-fragment by live sun lighting computed from a 512² R32F heightmap. Normals reproduce topo.ts's exact forward-difference math in-shader, so relief is computed at screen resolution — sharper than today at every zoom. Cast ridge shadows come from a GPU ray-marched sun-visibility map rebaked into a 1024² R8 FBO only when the sun moves (≤4 Hz), costing one texture tap per frame — this is what makes the valley read like Restrepo aerial footage: east-wall shadow flooding the floor at 0700, crawling up the west wall by 1700. The sun model (lat 34.8°N, fixed summer declination) is calibrated so the sun is below the horizon exactly when solarLight() is at starlight; gameplay light functions are untouched. The 2D canvas keeps contours, paths, night wash, and everything above — pixel-identical stacking — and the old lit-bake path stays alive as the no-WebGL fallback, keeping every existing headless harness green. Deploy eventually gets ~2-3 s faster via an optional Phase-4 GLSL port of the albedo bake (render-to-texture, validated by perceptual diff). Per-frame GPU cost is ~1-3 ms on integrated graphics against a 16.6 ms budget; texture memory ~92 MB. Reserved uniform/texture slots (cloud-shadow sampler defaulting to 1×1 white, height-fog params defaulting to today's haze, lift/gain grade hooks) let the atmosphere and grade axes plug in without touching the core shader.

## Design
# WebGL Terrain Core — Design

## 0. Shape of the change

One new GL underlayer, one refactor seam, zero sim changes.

```
┌──────────────────────────────────────────────────────────┐
│ 2D canvas (existing, now transparent under terrain)      │  contours, paths, night wash,
│   drawTerrainOverlays → decoration → weather → units …   │  grid, units, FX, HUD — unchanged
├──────────────────────────────────────────────────────────┤
│ WebGL2 canvas (NEW, absolute inset-0, under the 2D one)  │  terrain albedo × live sun ×
│   TerrainGL.render(cam, env) — 1 fullscreen-tri draw     │  cast shadows × grade × haze
└──────────────────────────────────────────────────────────┘
```

New files (all React-free, `lib/render` layer):
- `lib/render/gl/terrain-gl.ts` — `TerrainGL` class: context, programs, textures, FBOs, render(), dispose(), context-loss recovery.
- `lib/render/gl/shaders.ts` — GLSL source strings (terrain frag/vert, shadow-bake frag, Phase-4 albedo-bake frag).
- `lib/render/gl/sun.ts` — pure sun model `sunPosition(secondsOfDay)` → `{az, alt, dir: [x,y,z]}`. Exported standalone so the sprite-shadow axis reuses the SAME sun on the 2D canvas.

Modified files:
- `lib/render/topo.ts` — `makeBake` gains a `lit` flag (albedo = current pixel math minus key/fill/sky shade, minus altitude warm/cool, minus haze; keeps landColor, dithered class edges, per-class `tex`, snow, cliff slate, saturation lift). New exports `bakeAlbedo`, `bakeAlbedoProgressive`; `drawTerrain` split so `drawTerrainOverlays` (noise tooth + contours + paths + night wash, topo.ts:560-592) is callable alone.
- `components/world/WorldView.tsx` — second canvas element, TerrainGL lifecycle, branch in `draw()`.
- `state/store.ts` — `renderWarmPhases` probes WebGL2 and bakes the right sheet.

## 1. Texture pipeline (what gets uploaded)

| unit | texture | format / filter | size | source |
|---|---|---|---|---|
| 0 | albedo | RGBA8, LINEAR_MIPMAP_LINEAR, generateMipmap | 4096² (8 px/cell — honors the DO-NOT-RE-TRY floor) | CPU `bakeAlbedo` canvas → texImage2D |
| 1 | height | **R32F, NEAREST** | 512² | `terrain.elev` Float32Array directly (RED/FLOAT) |
| 2 | sun-visibility (shadow) | R8, LINEAR | 1024² FBO | GPU shadow-bake pass, refreshed on sun motion |
| 3 | cloud shadow (reserved) | R8, LINEAR | 1×1 white default | atmosphere axis binds the real thing later |
| 4 | landcover (Phase 4 only) | R8UI, NEAREST | 512² | `terrain.land` Uint8Array |

**Albedo decision — hybrid, weighed seriously.** Three options considered:
1. *Port all 26 landcover procedural textures to per-frame GLSL.* Rejected for the per-frame path: the bake's character (forest dapple, contour-aligned furrows, HESCO basket grid, snow, slate cliffs, saturation lift) is hard-won and tuned; `hash2` in topo.ts:83-87 relies on JS double-precision int32-coercion semantics (`(h^(h>>13)) * 1274126177` exceeds 2^53 before ToInt32) so a uint GLSL port is statistically identical but NOT bit-identical — verifying 26 classes by eye per frame forever is the wrong risk, and per-frame fbm at 8 M fragments is gratuitous ALU on the iGPU budget.
2. *Keep the lit bake.* Rejected: DECIDED — the sun becomes real; NW hillshade baked into the bitmap can't sweep.
3. **Chosen: CPU-baked UNLIT albedo.** Same `processRows` loop with the lighting terms compiled out. Character survives pixel-for-pixel; the only loop change is deleting the `key/fill/sky` dots, the `warm/cool` altitude grade, and the haze mix (all of which move to the GPU where they become live). GPU procedural detail noise (§6) replaces the 2D `noiseTile` overlay for close-zoom tooth. Phase 4 optionally moves this bake itself to GLSL render-to-texture for deploy speed, validated by perceptual screenshot diff against the CPU albedo (not bit equality — see hash note above).

**Height format decision.** R32F + NEAREST + **manual bilinear via `texelFetch`** everywhere. R16F-with-LINEAR was rejected on arithmetic: elevation spans 1550→2780 m; half-float's 10-bit mantissa gives ~0.6 m quantization even normalized, and 0.6 m steps over 5 m cells put ±0.12 rise/run noise into normals — visible slope banding. OES_texture_float_linear was rejected as a device-dependent branch; 4 `texelFetch` + 2 `mix` is cheap, runs identically on every GPU and on SwiftShader, and lets us reproduce `Terrain.elevAt` (lib/sim/terrain.ts:3137-3150) **exactly** — same cell-corner lattice, no half-texel offset, same `clamp(w/cell, 0, size-1.001)`:

```glsl
uniform sampler2D u_height;          // 512×512 R32F, NEAREST
uniform float u_cell;                // 5.0
uniform float u_grid;                // 512.0
float heightAt(vec2 w) {             // w in world meters — EXACT port of Terrain.elevAt
  vec2 g = clamp(w / u_cell, vec2(0.0), vec2(u_grid - 1.001));
  vec2 i = floor(g), f = g - i;
  ivec2 c = ivec2(i);
  float h00 = texelFetch(u_height, c,               0).r;
  float h10 = texelFetch(u_height, c + ivec2(1, 0), 0).r;
  float h01 = texelFetch(u_height, c + ivec2(0, 1), 0).r;
  float h11 = texelFetch(u_height, c + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
```

Getting this bit-faithful matters: the 2D canvas draws contours from the same `elev` array directly on top — any lattice offset reads as contours sliding off the relief.

## 2. Camera transform (the quad/UV math)

One fullscreen triangle; world position interpolated from the same `{cx,cy,ppm,vw,vh}` camera (topo.ts:4-18 semantics, vw/vh in CSS px so the math is DPR-independent). The camera-punch shake (WorldView.tsx:193-201) is passed as a pixel offset so terrain shakes with everything else:

```glsl
#version 300 es
layout(location=0) in vec2 a_clip;   // (-1,-1) (3,-1) (-1,3)
uniform vec2  u_camCenter;           // cx, cy (m)
uniform vec2  u_viewCss;             // vw, vh (CSS px)
uniform float u_ppm;                 // CSS px per meter
uniform vec2  u_shakePx;             // transient camera-punch offset (CSS px)
out vec2 v_world;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  // NDC +y is up; world +y is south (down-screen) → negate y. Inverse of worldToScreen (topo.ts:12).
  vec2 fromCenter = vec2(a_clip.x, -a_clip.y) * u_viewCss * 0.5 - u_shakePx;
  v_world = u_camCenter + fromCenter / u_ppm;
}
```

Fragment: `uv = v_world / u_worldSize` for albedo/shadow; outside `[0,1]²` output `u_bgColor` (the page `bg-bg` token, passed once). GL canvas created with `{alpha:false, antialias:false, preserveDrawingBuffer:false}` — opaque bottom layer, cheapest compositing. `preserveDrawingBuffer:false` is safe because we redraw every rAF; note for the screenshot harness that captures must happen in the same frame (Playwright `screenshot()` of the page composites fine — it reads the composited surface, not the GL backbuffer).

## 3. The sun model (`lib/render/gl/sun.ts`)

Render-layer only; reads `world.secondsOfDay`; **consistent with the gameplay curve, which is untouched**. Standard solar position at φ = 34.8°N (Kunar), fixed declination δ = +20° (high-summer fighting season — no season system exists, DECIDED), solar noon at 12:00 game time:

```
H = (secondsOfDay/86400)·2π − π                      // hour angle
sinAlt = sinφ·sinδ + cosφ·cosδ·cosH
az     = atan2(sinH, cosH·sinφ − tanδ·cosφ) + π      // from north, clockwise through east
dir    = [sin(az)·cos(alt), −cos(az)·cos(alt), sin(alt)]   // world frame: +x east, +y SOUTH, z up
```

This puts sunrise at ~05:04 and sunset at ~18:56 — inside `solarLight()`'s 05–07 dawn and 17–19.5 dusk ramps (world.ts:122-129), so the sun is **below the horizon whenever solarLight is at starlight** and above it through the full-light plateau. Direct sun term fades to zero over alt ∈ [0°, 4°] so dawn/dusk hand off smoothly to ambient; the night look itself stays the 2D wash for now (§7).

## 4. Fragment lighting model

Normals: in-shader, the bake's exact forward-difference at one-cell spacing (topo.ts:155-165) — but evaluated per fragment, so relief is screen-resolution-sharp at ppm 8 where today's bitmap upscales:

```glsl
vec3 normalAt(vec2 w) {
  float e  = heightAt(w);
  float eX = heightAt(w + vec2(u_cell, 0.0));
  float eY = heightAt(w + vec2(0.0, u_cell));
  vec2 dz = vec2(eX - e, eY - e) / u_cell;          // rise/run, matches topo.ts:159-160
  return normalize(vec3(-dz.x, -dz.y, 1.0));
}
```

Lighting — Lambert sun + sky ambient (the bake's `0.5+0.5·nz` term, which doubles as cheap AO) + an anti-solar bounce fill so shadowed faces keep form (the bake's SE-fill role, now sun-relative):

```glsl
vec3  n      = normalAt(v_world);
float vis    = texture(u_shadow, uv).r * texture(u_cloud, uv + u_cloudOff).r; // cast × cloud (cloud=1 default)
float sunUp  = smoothstep(0.0, 0.07, u_sunDir.z);          // fade direct light through ~0–4° altitude
float ndl    = max(0.0, dot(n, u_sunDir));
vec3  fillDir= normalize(vec3(-u_sunDir.x, -u_sunDir.y, 0.35));
float nfl    = max(0.0, dot(n, fillDir));
float sky    = 0.5 + 0.5 * n.z;                            // topo.ts:171
float shade  = ndl * vis * sunUp * u_keyGain               // u_keyGain ≈ 1.05·calibration (§9)
             + nfl * 0.34 * sunUp
             + sky * mix(0.45, 0.24, sunUp);               // sky carries twilight when the sun is down
shade        = clamp(shade * 0.94 + 0.02, 0.0, 1.0);       // topo.ts:173
vec3 col     = texture(u_albedo, uv).rgb * (0.34 + 0.95 * shade);   // compose, topo.ts:297
```

## 5. Cast ridge shadows — rebaked GPU ray-march (the decision)

**Chosen: a sun-visibility map ray-marched on the GPU into a 1024² R8 FBO, rebaked only when the sun direction changes by >0.25°, throttled to ≤4 Hz wall-clock.** Per-frame cost in the terrain shader: one bilinear tap.

Rejected alternatives:
- *Per-fragment ray-march every frame*: 8.3 M fragments (1080p @ dpr 2) × ~56 steps × 4 fetches ≈ 1.9 G fetches/frame — hostile to integrated GPUs and fatal to the SwiftShader harness path.
- *Horizon maps (precomputed max-horizon-angle per azimuth sector)*: correct and classic, but needs a 16–32-sector sweep precompute in JS (hundreds of ms at deploy, or a GPU sweep — more passes), 4× RGBA8 packed textures, and azimuth-sector interpolation that visibly softens/doubles shadow edges at sector boundaries. The rebaked march is *exact for the current sun azimuth*, simpler (reuses `heightAt`), and its amortized cost (~1-3 ms GPU at ≤4 Hz) is noise.

Shadow-bake fragment (drawn with the same fullscreen-tri vertex shader, camera set to the whole world so `v_world` spans the map; FBO texel = 2.5 m):

```glsl
#version 300 es
precision highp float;
in vec2 v_world;
uniform sampler2D u_height;
uniform vec3  u_sunDir;        // normalized, z up; only meaningful when z > 0
uniform float u_worldSize;     // 2560.0
out vec4 o;
void main() {
  float h0 = heightAt(v_world) + 1.5;          // 1.5 m lift kills self-shadow acne on 5 m cells
  vec2  toSun = normalize(u_sunDir.xy);
  float tanAlt = u_sunDir.z / max(1e-4, length(u_sunDir.xy));
  float occl = 0.0;
  float d = u_cell;                            // start one cell out
  for (int i = 0; i < 56; i++) {               // 5 m·1.13^56 ≈ spans the whole 2.56 km map
    vec2 p = v_world + toSun * d;
    if (p.x < 0.0 || p.y < 0.0 || p.x > u_worldSize || p.y > u_worldSize) break;
    float pen = heightAt(p) - (h0 + tanAlt * d);   // meters the terrain pokes above the sun ray
    occl = max(occl, pen / d);                     // tangent of overshoot → distance-aware softness
    d *= 1.13;                                     // exponential stride: fine near, coarse far
  }
  float lit = 1.0 - smoothstep(0.0, 0.04, occl);   // ~2.3° penumbra — soft, mountain-scale shadows
  o = vec4(lit, 0.0, 0.0, 1.0);
}
```

Rebake policy (in `TerrainGL.render`): recompute `sunPosition`; if `angleBetween(lastBakedDir, dir) > 0.25°` AND >250 ms since last bake → run the pass. At 1× speed that's roughly one bake per game-minute; at high warp it saturates at 4 Hz and the shadow line visibly sweeps — which is exactly the wanted effect. When `alt < 0°` skip baking and let `sunUp` zero the direct term.

## 6. Splat/landcover blending and close-zoom detail

**Phase 2/3 (shipping path):** the "splat" — dithered organic class edges + 26 per-class procedural textures — stays in the CPU albedo (topo.ts:176-253, verbatim minus lighting). No GLSL risk to the character.

**Phase 4 (GPU albedo bake, deploy-speed option):** port the same math to a one-shot render-to-texture pass sampling the R8UI landcover texture. Load-bearing pieces:

```glsl
// hash/value-noise/fbm — uint port of topo.ts:83-103 (statistically identical; see decision note)
float hash2(ivec2 p) {
  uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return float(h ^ (h >> 16)) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(ivec2(i)), b = hash2(ivec2(i) + ivec2(1,0));
  float c = hash2(ivec2(i) + ivec2(0,1)), d = hash2(ivec2(i) + ivec2(1,1));
  return a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
}
float fbm2(vec2 p) { return vnoise(p)*0.6 + vnoise(p*2.13)*0.27 + vnoise(p*4.7)*0.13; }

// dithered class sampling — port of topo.ts:178-180 (organic interlocking edges)
vec2 dither = (vec2(fbm2(w*0.34), fbm2(w*0.34 + vec2(21.7, 8.3))) - 0.5) * u_cell * 1.6
            + (vec2(fbm2(w*1.1),  fbm2(w*1.1  + vec2(5.0, 9.0)))  - 0.5) * u_cell * 0.5;
uint land = texelFetch(u_land, ivec2(clamp((w + dither)/u_cell, vec2(0.0), vec2(u_grid-1.0))), 0).r;
// then: switch (land) { … 26 cases, each a direct transcription of topo.ts:187-253 … }
```

**Per-frame close-zoom tooth** (replaces the 2D `noiseTile` overlay, topo.ts:454-480 + 564-578, on the GL path — world-anchored, never shimmers):

```glsl
float detailA = clamp((u_ppm - 0.6) / 2.0, 0.0, 1.0) * 0.5;          // same fade-in as today
float grain = fbm2(v_world * 2.5) * 0.6 + vnoise(v_world * 0.9) * 0.4;
col *= 1.0 + (grain - 0.5) * 0.6 * detailA;                          // overlay-equivalent contrast
```

## 7. Grade, haze, night — defaults now, hooks for the other axes

The bake's altitude grade and haze (topo.ts:298-309) move into the shader as the *default parameterization*, so visuals don't regress and the grade/atmosphere axes later just drive uniforms:

```glsl
float altN = clamp((heightAt(v_world) - u_minElev) / u_elevRange, 0.0, 1.0);
col *= vec3(1.0 - altN * 0.08, 1.0, 1.0 + altN * 0.13);              // warm-low / cool-high (default)
float haze = clamp(u_hazeBase - altN * u_hazeFalloff, 0.0, 1.0);     // defaults 0.10 / 0.16 = today
col = mix(col, u_hazeColor, haze);                                   // default (164,170,166)/255
col = col * u_gain + u_lift;                                         // grade-axis hook, default (1, 0)
col = mix(col, u_nightColor, u_nightMix);                            // default u_nightMix = 0 — see below
```

**Night decision:** today's wash `rgba(8,14,30, 0.35+night·0.42)` is painted at the END of drawTerrain (topo.ts:587-592), i.e. OVER contours and paths but UNDER decoration. To keep that stacking pixel-identical, **the wash stays on the 2D canvas in Phase 1-3** (it composites over the transparent top canvas onto the GL terrain below — same result as today). `u_nightMix/u_nightColor` are reserved for the grade axis to move night onto the GPU later (terrain-aware moonlit relief), at which point the 2D wash is zeroed in one place.

Valley-fog-pooling hook: `u_fogTopElev/u_fogDensity/u_fogColor` uniforms with density defaulting 0; the core shader already computes `heightAt` so the atmosphere axis gets terrain-aware pooling for free: `fog = u_fogDensity * clamp((u_fogTopElev - h) / u_fogDepth, 0.0, 1.0); col = mix(col, u_fogColor, fog)`.

## 8. Draw-call structure & uniform layout (the contract for other axes)

Per frame: **exactly one draw call** (terrain program, fullscreen tri), plus the shadow-bake draw at ≤4 Hz. Programs: `terrain`, `shadowBake`, (Phase 4: `albedoBake`). No UBOs needed at this uniform count; one flat `setUniforms(env)`.

```ts
// lib/render/gl/terrain-gl.ts (public surface)
export class TerrainGL {
  constructor(canvas: HTMLCanvasElement);          // ok=false if webgl2 unavailable
  readonly ok: boolean;
  setTerrain(t: Terrain): void;                    // uploads height+albedo (+land), resets shadow
  render(cam: Camera, env: TerrainEnv): void;      // resize-aware; bakes shadow if sun moved
  dispose(): void;
}
export interface TerrainEnv {
  secondsOfDay: number;                            // → sunPosition() internally
  shakePx: { x: number; y: number };
  // hooks (all optional, defaulted): cloudTex?, cloudOff?, fog?, grade?, nightMix?
}
```

Texture units fixed: 0 albedo · 1 height · 2 shadow · 3 cloud (1×1 white default) · 4 landcover (Phase 4). Atmosphere/grade axes extend `TerrainEnv`, never the shader plumbing.

## 9. Canvas stack, WorldView integration, fallback

- **WorldView.tsx:808-815** — wrap div gains, as first child: `<canvas ref={glRef} className="absolute inset-0 block" aria-hidden />`; the existing canvas becomes `className="block relative"` (stacks above; it keeps ALL pointer/keyboard handlers — the GL canvas never receives input).
- **WorldView.tsx:164-212 (loop effect)** — create `TerrainGL` once (`new TerrainGL(glRef.current)`); in the rAF, resize the GL canvas with the same `dpr/cw/ch` logic as the 2D one (WorldView.tsx:183-191); detect terrain swap by object identity (`lastTerrain !== w.terrain` → `setTerrain`); call `terrainGL.render(cam, { secondsOfDay: w.secondsOfDay, shakePx: {x: ox, y: oy} })` before `draw(ctx, …)`, passing the same shake offsets computed at WorldView.tsx:199-200.
- **WorldView.tsx:214-222 (draw)** — `if (terrainGL.ok) drawTerrainOverlays(ctx, terrain, cam, night*0.7); else drawTerrain(ctx, terrain, cam, night*0.7);` (overlays = contours + paths + night wash; tooth noise comes from the GPU on the GL path).
- **Fallback decision: the 2D bake path STAYS.** One probe at mount; `ok=false` → today's code runs byte-identical. This keeps `scripts/shoot.mjs:32`, `scripts/scene-shots.mjs:20` and every `--disable-gpu` harness green with their existing baselines, and covers blacklisted drivers. `webglcontextlost`/`restored` handlers re-run `setTerrain`; unrecoverable loss flips to the 2D path at the same branch.
- **DPR**: GL backing store = `cw·dpr × ch·dpr` (cap dpr at 2, same as WorldView.tsx:183); shader math is in CSS px via `u_viewCss/u_ppm`, so harnesses at dpr 1 and laptops at dpr 2 share one code path.

## 10. The old bake path & deploy speed

- No-WebGL: `renderWarmPhases` (state/store.ts:373-380) keeps `bakeTerrainProgressive` exactly as today.
- WebGL (Phase 2/3): the relief phase runs `bakeAlbedoProgressive` instead — same duration (~2-3 s; the lighting terms it drops are a minority of the per-pixel cost — the `elevAt`/fbm calls dominate), same progress UX. The 4096² upload (~30-80 ms) happens in `setTerrain` on the first frame, under the deploy fade; if it ever reads as a hitch, split into 8 `texSubImage2D` row bands across frames.
- Phase 4 (the real win): GPU `albedoBake` renders the 4096² albedo into a texture in ~1-4 ms — **the 2-3 s relief phase collapses to near-zero and the texture never crosses the bus**. The loading phase becomes "upload 1 MB heightmap + 0.25 MB landcover, one FBO pass". The CPU `bakeAlbedo` is kept for the no-GL fallback and as the perceptual-diff reference.

## 11. Zoom-range quality (ppm 0.18 → 8)

- **0.18 (whole valley)**: albedo minified ~9:1 → full mip chain + trilinear: no shimmer while panning (this is exactly what mips are for; today's single-level canvas blit relies on the browser's resampler).
- **1-3 (tactical)**: albedo near 1:1; GPU normals + shadow at screen resolution — strictly sharper relief than the baked hillshade.
- **8 (close)**: albedo texel = 8 screen px (bilinear, same softness as today's upscaled bake) + per-fragment lighting (crisp) + world-anchored procedural grain (§6) ≥ today's noiseTile tooth. Effective detail ≥ 8 px/cell equivalent everywhere — the DO-NOT-RE-TRY floor is met by construction, and relief legibility (the thing that actually regressed at 6 px/cell) no longer depends on albedo resolution at all.
- Determinism: all animation inputs are `secondsOfDay` + spatial hashes; no per-frame randomness; rebaked shadows depend only on sun angle, so a paused game never flickers.

## 12. Phased implementation (game never broken between phases)

1. **Phase 0 — refactor only.** Split `drawTerrainOverlays` out of `drawTerrain` (topo.ts:552-593); behavior identical. Verify: screenshot diff = 0 via `scripts/shoot.mjs`.
2. **Phase 1 — GL blit parity.** Add the GL canvas + `TerrainGL` rendering the EXISTING lit bake as a plain textured quad (no lighting). Proves canvas stack, camera/DPR math, resize, fallback branch, context loss, `--webgl` harness. Verify: `scripts/visual-matrix.mjs --webgl` vs 2D baselines — near-zero diff; `shoot.mjs --fps` (default = 2D path) unchanged.
3. **Phase 2 — the real sun.** Unlit albedo + height texture + lighting + shadow bake + grade/haze defaults + detail grain. Calibrate `u_keyGain`/sun color so a debug uniform forcing the old NW key direction reproduces today's midday look (perceptual diff gate), then unlock the live sun. Verify: time-of-day matrix at 05:30/07/09/12/15/17/18:30 over 2 seeds; fps probe on a real GPU.
4. **Phase 3 — polish + perf pass.** Shadow rebake thresholds under warp, dawn/dusk handoff, dpr-2 perf on Intel iGPU; publish before/after report.
5. **Phase 4 (optional, deploy speed) — GPU albedo bake.** Port the splat (§6) to `albedoBake`; gate behind perceptual diff vs CPU albedo; relief loading phase → instant.

## 13. Data flow (per frame)

```
store.frame(dt) → World ticks (untouched)
rAF in WorldView:
  cam, shake → TerrainGL.render(cam, env)
      sun.ts: sunPosition(world.secondsOfDay)
      [if sun moved >0.25° & >250 ms] shadowBake pass → R8 FBO
      terrain pass: albedo × (sun·shadow·cloud + fill + sky) × grade × haze → GL canvas
  draw(ctx2d): clearRect (transparent) → drawTerrainOverlays (contours/paths/wash)
               → decoration → grid → weather → smoke → units → FX → HUD   (all unchanged)
```

## Key decisions
- **Hybrid texture pipeline: CPU-baked UNLIT albedo (4096² RGBA8, the existing bake minus its lighting/grade/haze terms) sampled by a GPU lighting shader; full GLSL albedo bake deferred to an optional Phase 4 behind a perceptual-diff gate**
  - rejected: (a) Full per-frame GLSL procedural landcover — rejected: the 26-class character is tuned and load-bearing, JS hash2 semantics (double-precision int32 coercion past 2^53) cannot be ported bit-exactly to uint GLSL, and per-frame fbm at 8 M fragments wastes the iGPU budget; (b) keep the lit bake — rejected, DECIDED the sun is live
  - why: Character survives pixel-for-pixel with near-zero porting risk (the albedo loop is a strict subset of code that already ships), while lighting/shadows/grade become live on the GPU; deploy speed is recovered later by the validated GPU bake rather than gambled up front
- **Heightmap as 512² R32F with NEAREST filtering and manual bilinear via 4 texelFetch, replicating Terrain.elevAt's exact cell-corner lattice (clamp to size-1.001, no half-texel offset); normals computed in-shader with the bake's forward-difference-at-one-cell math (topo.ts:155-165)**
  - rejected: R16F + hardware LINEAR — rejected on arithmetic: 10-bit mantissa over a 1230 m range gives ~0.6 m quantization → ±0.12 rise/run normal banding; OES_texture_float_linear — rejected as a device-dependent branch; precomputed normal texture — rejected as a second source of truth (12 L1-cached texelFetches are effectively free, and per-fragment normals beat any fixed-resolution normal map at close zoom)
  - why: Bit-faithful height sampling keeps the GL relief registered to the 2D contours drawn from the same array on the canvas above — any lattice mismatch reads as contours sliding off the terrain; identical behavior on every GPU and SwiftShader
- **Cast ridge shadows via a GPU ray-marched sun-visibility map rebaked into a 1024² R8 FBO only when the sun moves >0.25° (throttled ≤4 Hz); one bilinear tap per frame in the terrain shader; soft penumbra from max-occlusion-tangent + smoothstep**
  - rejected: Per-fragment per-frame ray-march — rejected: ~1.9 G texture fetches/frame at 1080p dpr2, hostile to integrated GPUs and fatal on SwiftShader; horizon-map precompute (16-32 azimuth sectors) — rejected: JS sweep precompute or extra GPU passes at deploy, 4 packed RGBA8 textures, and azimuth-sector interpolation artifacts at shadow edges, all to approximate what a 1-3 ms rebake computes exactly for the current sun
  - why: Amortized cost is noise (≤4 bakes/s of a ~1-3 ms pass), the per-frame cost is one tap, the result is exact for the live sun azimuth, and at high time-warp the shadow line visibly sweeps the valley — the marquee effect
- **Keep the 2D lit-bake path fully alive as the no-WebGL fallback, selected once at mount; night wash stays on the 2D top canvas (pixel-identical stacking) with a u_nightMix GPU hook reserved for the grade axis**
  - rejected: Delete the 2D path — rejected: every headless harness runs --disable-gpu today and their screenshot baselines stay valid only on the 2D path; blacklisted drivers and context loss need a landing spot; moving night to GPU now — rejected because the wash sits OVER contours/paths and UNDER decoration (topo.ts:587-592), and replicating that stacking on the GPU buys nothing until the grade axis owns night
  - why: Zero-risk rollout: ok=false (or context loss) reverts to today's renderer byte-identical at one branch point; harness ecology untouched; night regression impossible in Phases 1-3
- **Render-layer sun model in lib/render/gl/sun.ts: φ=34.8°N, fixed declination +20° (high-summer fighting season), solar noon 12:00 → sunrise ~05:04 / sunset ~18:56, with the direct term fading over 0-4° altitude**
  - rejected: Deriving sun altitude by inverting solarLight() — rejected: solarLight is a piecewise gameplay ramp with no azimuth, useless for shadow geometry; modeling calendar seasons — rejected: no season system exists (verified) and a drifting sunset would silently decouple from the fixed solarLight ramps
  - why: Real solar geometry gives correct azimuth sweep (shadows N-of-E at dawn → short at noon → N-of-W at dusk in a N-S valley) while staying consistent with the sacred gameplay curve: sun below horizon exactly when solarLight is at starlight, above it through the 07-17 plateau
- **One fullscreen-triangle draw call with a fixed uniform/texture contract: units 0-4 assigned, cloud-shadow sampler defaulting to 1×1 white, fog/grade uniforms defaulting to today's haze/identity — the atmosphere and grade axes extend TerrainEnv, never the shader plumbing**
  - rejected: Terrain-extent quad with vertex-grid mesh — rejected: no 3D perspective exists, a fullscreen tri with world-space interpolation is exact and cheaper; deferring the hooks until those axes land — rejected: re-opening the core shader three times invites churn; UBOs — rejected as overkill at this uniform count
  - why: The synthesis step needs hard seams: cloud shadows multiply into the existing visibility term, fog pooling reuses the already-fetched height, grade drives lift/gain — all land as uniform writes with zero core-shader edits

## Integration points
- components/world/WorldView.tsx:808-815 — Add `<canvas ref={glRef} className="absolute inset-0 block" aria-hidden />` as the first child of the wrap div; existing canvas becomes `className="block relative"` so it stacks above and keeps all input handlers
- components/world/WorldView.tsx:164-212 — Loop effect: construct `new TerrainGL(glRef.current)` once; per rAF resize the GL canvas with the same dpr/cw/ch logic (lines 183-191), detect terrain swap by identity (`lastTerrain !== w.terrain` → `setTerrain`), and call `terrainGL.render(cam, {secondsOfDay: w.secondsOfDay, shakePx: {x: ox, y: oy}})` (shake offsets from lines 199-200) before `draw(ctx, …)`
- components/world/WorldView.tsx:214-222 — In draw(): replace the unconditional `drawTerrain(ctx, terrain, cam, night*0.7)` with `terrainGL.ok ? drawTerrainOverlays(ctx, terrain, cam, night*0.7) : drawTerrain(ctx, terrain, cam, night*0.7)`
- lib/render/topo.ts:120-361 — makeBake(terrain, lit: boolean): compile out the key/fill/sky shade (lines 169-173, 296-297 → flat compose), the altitude warm/cool grade (299-303), and the haze mix (304-309) when lit=false; export `bakeAlbedo` / `bakeAlbedoProgressive` with a parallel WeakMap cache entry; `bakeTerrain` (lit) unchanged for the fallback
- lib/render/topo.ts:552-593 — Split drawTerrain: extract `drawTerrainOverlays(ctx, terrain, cam, night)` = noise-tooth overlay + drawContoursLive + drawPathsLive + night wash (lines 560-592, with the tooth skipped on the GL path since the shader supplies grain); drawTerrain = blit (553-558) + overlays, byte-identical fallback
- state/store.ts:373-380 — renderWarmPhases: probe `document.createElement('canvas').getContext('webgl2')` once; relief phase runs `bakeAlbedoProgressive` when available, `bakeTerrainProgressive` otherwise (Phase 4 later replaces the GL branch with the instant GPU bake)
- lib/render/gl/terrain-gl.ts (new) — TerrainGL class: webgl2 context ({alpha:false, antialias:false}), programs (terrain, shadowBake, later albedoBake), textures (albedo/height/shadow/cloud-default/land), shadow-FBO rebake policy (>0.25° sun motion, ≥250 ms), render(cam, env), context-loss handlers, dispose()
- lib/render/gl/shaders.ts (new) — GLSL source strings: fullscreen-tri vertex (camera/shake/world mapping), terrain fragment (heightAt/normalAt/lighting/grade/haze/grain + reserved cloud/fog/night hooks), shadow-bake fragment (56-step exponential ray-march)
- lib/render/gl/sun.ts (new) — Pure `sunPosition(secondsOfDay): {az, alt, dir}` at φ=34.8°N, δ=+20°, solar noon 12:00 — exported standalone so the sprite-shadow axis drives 2D sprite shadows from the SAME sun
- scripts/visual-matrix.mjs:25 — No code change needed (--webgl / --use-angle=swiftshader already exists); add a time-of-day shot matrix (05:30/07/09/12/15/17/18:30) to the Phase-2 verification run; shoot.mjs --fps stays on the 2D fallback by default — note in its doc-comment

## Risks
- [high] Registration mismatch between GL relief and the 2D contours/paths drawn on top (lattice or camera-math offset reads as contours sliding off ridgelines) → heightAt is a verified bit-faithful port of Terrain.elevAt (terrain.ts:3137-3150, cell-corner lattice, clamp size-1.001); vertex math is the exact inverse of worldToScreen (topo.ts:12); Phase-1 parity step diffs GL blit vs 2D blit before any lighting lands; add a debug checkerboard uniform to eyeball sub-pixel registration at ppm 8
- [medium] The live-sun look drifts from the locked art: midday under a real ~75°-altitude sun is flatter than the baked NW key (kz=0.56), and sprite art has NW-key shading baked in (ART_BIBLE contract) while terrain shadows sweep → Calibration gate in Phase 2: a debug uniform forcing the old NW key direction must perceptually match today's bake before unlocking the sweep; keep the fill+sky structure so shadowed faces keep form; flag the sprite-key tension explicitly to the sprite-shadow/grade axes — terrain key gain stays restrained so NW-lit sprites don't read as wrong
- [medium] WebGL context loss or creation failure mid-session (driver resets, tab backgrounding on weak iGPUs) → webglcontextlost/restored handlers re-run setTerrain; unrecoverable loss flips terrainGL.ok and the existing 2D path resumes at the single branch point in draw() — the lit bake is lazily baked on first fallback use (one-time ~2-3 s, rare edge), or pre-warmed if the deploy probe already failed
- [low] Shadow-map resolution (1024², 2.5 m/texel) shows blocky penumbra edges at ppm 8, or visible 4 Hz stepping of the shadow line at extreme time-warp → Bilinear R8 sampling + the smoothstep penumbra hides texel edges (mountain shadows are physically soft); if close-zoom edges still offend, bump to 2048² (4 MB, still ~ms); warp stepping is bounded by the 0.25° threshold — if it reads badly, crossfade two shadow textures (noted as deferred polish, not built now)
- [medium] Phase-4 GPU albedo bake silently changes the 26-class character (hash2 not bit-portable from JS double semantics) → Phase 4 is optional and gated: perceptual screenshot diff (per-landcover crops at 3 zooms) against the CPU albedo must pass before the GPU bake ships; the CPU bake remains the reference and the fallback forever
- [low] 8.3 M fragments at dpr 2 on a weak Intel iGPU pushes the terrain pass past budget when the 2D pass is also heavy (big firefight + weather) → Measured lever held in reserve: render the GL canvas at dpr 1.5 and let CSS upscale (terrain is mostly low-frequency under the crisp 2D vector layer); fps probe on Intel hardware in Phase 3 decides; note the 2D pass simultaneously LOSES its per-frame 4096² drawImage blit and pattern fill, partially offsetting

## Perf budget
Per-frame GPU (terrain pass, 1 draw call): at 1920×1080 css × dpr 2 = 8.3 M fragments; per fragment ~14 height texelFetches (3 manual bilinears for normal + reuse for alt/fog), 1 trilinear albedo tap, 1 shadow tap, 1 cloud tap, ~100 ALU ops → ~1 GFLOP + ~120 M fetches/frame. The 512² R32F heightmap (1 MB) sits entirely in L2, so fetches are cache hits. Estimated 0.5-1.5 ms on Apple M1, 2-4 ms on Intel Iris Xe — against a 16.6 ms budget shared with a 2D pass that today sustains 116 fps WITH the 4096² drawImage blit it now sheds. Shadow rebake: 1024² × 56 steps × 4 fetches ≈ 235 M fetches ≈ 1-3 ms GPU, fired ≤4 Hz (typically once per game-minute) → ≤12 ms/s amortized, invisible. CPU per frame: ~20 uniform writes + 1-2 draw calls, < 0.05 ms; no per-frame texture uploads ever. Texture memory: albedo 4096² RGBA8 + mips ≈ 89 MB, height 1 MB, shadow 1-2 MB, landcover 0.25 MB → ~92 MB total (one-time, within iGPU shared-memory norms; the old path's 4096² canvas held ~67 MB in RAM anyway). Deploy: Phases 2-3 unchanged (~2-3 s CPU albedo bake, same progress bar); Phase 4 collapses the relief phase to <100 ms (GPU bake, no 67 MB bus crossing). Headless harnesses: default --disable-gpu runs the unchanged 2D path at today's 116 fps; visual-matrix --webgl on SwiftShader renders correctly but slowly (~10-20 fps) — fine for screenshots, excluded from fps assertions.

## Open questions
- Fixed declination: +20° (high-summer, sunset 18:56) is proposed to fit the solarLight ramps — owner may prefer a specific campaign month; any δ in +15°..+23° stays consistent with the gameplay curve, but it should be pinned before shadow-length tuning.
- Exact `bg-bg` color for fragments outside the world rect (read the CSS token once at TerrainGL construction vs hardcode the hex — needs the token value at implementation time).
- Should extreme time-warp get shadow-map crossfading (two R8 targets, lerp) or is the ≤4 Hz sweep acceptable as-is? Deferred to Phase 3 eyeballing.
- Phase-2 midday calibration target: match today's bake brightness exactly (u_keyGain compensating the brighter noon ndl), or accept a slightly brighter true-noon and let the grade axis own final exposure? Proposed: match today, hand exposure to the grade axis.
- Does any future axis need CPU readback of the terrain image (verified: nothing reads the bake today)? If a minimap ever does, it must render its own GL pass — flag in the synthesis so nobody assumes canvas readback.
