# Sun, sky, and time-of-day color model — the master clock made visible (sun-position model, light/ambient/moon color ramps, night relight, dual-canvas color grade, and the SkyState API every other render system reads)

confidence: 0.82

## Summary
A single new pure render-layer module, lib/render/atmosphere.ts, turns world.secondsOfDay + weather into a complete SkyState: a physically-derived sun direction for a 34.8°N valley fixed at mid-July (declination +21°, the Korengal fighting season — and the one declination whose geometric sunrise 04:58/sunset 19:02 lands within minutes of the untouched gameplay solarLight() ramps at 05:00/19:30), plus sun/sky/moon colors keyed to sun altitude, a fixed anti-solar gibbous moon that rides the southern sky all night, and a shared color grade. The GL terrain underlayer consumes SkyState as uniforms (lighting combine, cached cast-shadow texture refreshed on a 0.5° sun-motion threshold so time-warp becomes a visible shadow time-lapse); the 2D top canvas consumes the same numbers via one source-atop tint fillRect inserted before drawNightLights and the HUD, so sprites grade coherently while map ink stays ungraded and additive muzzle/tracer light still punches through the dark. The flat navy night wash at topo.ts:587 dies, replaced by real low-key moonlight with the same target luminance (~0.3 of day) so legibility never regresses. A deliberate bonus falls out of the math: the evening sun sits at azimuth 287–296° (WNW), so the dynamic light converges on the ART_BIBLE's baked NW sprite key exactly at golden hour — the baked sprite art is "perpetual golden hour," and the worst mismatch (morning ENE) coincides with the least-visible shadows. The result clears the realism bar because it reproduces the single most documented visual fact about the Korengal: the sun line walking down the west wall at dawn and the floor staying in ridge shadow until mid-morning, on the live clock.

## Design
# Sun, Sky & Time-of-Day Color Model — Design

**Axis owner deliverables:** `lib/render/atmosphere.ts` (the model + API), the 2D screen-grade pass, the night relight (wash removal), the shadow-refresh *policy* (the terrain axis owns the shadow *pass* itself), and the consistency proof against `solarLight()`.

---

## 0. Component map & data flow

```
lib/sim/world/world.ts            (UNTOUCHED: solarLight/ambientLight/isNight/secondsOfDay)
        │  w.secondsOfDay, w.solarLight(), w.state.weather   (read-only, once per frame)
        ▼
lib/render/atmosphere.ts  [NEW — pure, deterministic, React-free, no wall clock, no random]
        │  SkyState { sunDir, sunColor, sunIntensity, skyColor, groundColor, skyIntensity,
        │             moonDir, moonColor, moonFactor, shadowStrength, nightFactor,
        │             grade{exposure, whiteBalance, saturation, lift, spriteTint},
        │             cloudShadowDensity, fogColor, spriteShadow{dx,dy,alpha} }
        ├──────────────► GL terrain underlayer (other axis): uniforms, every frame
        │                 └─ shadow FBO pass: rebaked only when sunDir moves > 0.5° (policy here)
        └──────────────► 2D top canvas (WorldView.draw):
                          • drawWeather / drawCop / drawNightLights night param → sky.nightFactor
                          • drawScreenGrade(ctx, cam, sky.grade.spriteTint)  ← NEW seam,
                            after all world content, BEFORE drawNightLights & HUD
```

One `skyState()` call per frame in `WorldView.draw()`; the result is passed down. Nothing in `lib/sim` changes. Determinism: the model is a pure function of `(secondsOfDay, weather, solar)` — same seed + same clock ⇒ same pixels (screenshot harness can pin the hour).

---

## 1. Sun-position model

**Fixed season: mid-July (day-of-year ≈ 196), solar declination δ = +21.0°.** Justification: (a) the Korengal's visual identity — *Restrepo*'s Battle Company footage and the OP Restrepo establishing shots — is the summer fighting season; *The Outpost*'s Kamdesh fight is October, but the campaign opens at the tempo peak, which is June–September; (b) measured fit: δ=21° is the declination whose geometry agrees with the untouched gameplay curve (proof below). Latitude φ = 34.8°N (Kunar). The game clock is treated as **local apparent solar time** (no equation of time, no UTC+4:30 — the clock IS the sun; document, don't model).

Hour angle `H = (secondsOfDay/3600 − 12) · 15°` (0 at solar noon, positive afternoon).

Standard equatorial→horizontal transform, in a local **E/N/U** frame:

```
sinAlt = sinφ·sinδ + cosφ·cosδ·cosH
east   = −cosδ·sinH
north  =  cosφ·sinδ − sinφ·cosδ·cosH
```

**World-frame mapping — the load-bearing sign:** world is `+x = east, +y = SOUTH` (y=0 is the north valley mouth; `worldToScreen` topo.ts:12-13 maps +y to screen-down, so north is up on screen). Therefore the **unit vector from surface toward the sun in WORLD coords** is:

```ts
// lib/render/atmosphere.ts
const DEG = Math.PI / 180;
const LAT = 34.8 * DEG;          // Kunar
const DECL = 21.0 * DEG;         // fixed mid-July (fighting season) — see consistency table
const sinPhi = Math.sin(LAT), cosPhi = Math.cos(LAT);
const sinDec = Math.sin(DECL), cosDec = Math.cos(DECL);

/** Unit vector surface→sun, world frame (+x E, +y S, +z up). Same convention as the
 *  old bake key (-0.55,-0.62,0.56) = "toward the NW sky" (−x west, −y north, +z up). */
export function sunDirWorld(secondsOfDay: number): [number, number, number] {
  const H = (secondsOfDay / 3600 - 12) * 15 * DEG;
  const cosH = Math.cos(H);
  const sinAlt = sinPhi * sinDec + cosPhi * cosDec * cosH;   // = sun z (up)
  const east = -cosDec * Math.sin(H);                         // = sun x
  const north = cosPhi * sinDec - sinPhi * cosDec * cosH;     // world y = SOUTH ⇒ negate
  return [east, -north, sinAlt]; // unit by construction (rotation of a unit vector)
}
```

**Verified table** (computed, not estimated — `node` check run against a copy of `solarLight()`):

| clock | sun alt | azimuth (compass) | toSun world vec | solarLight() |
|---|---|---|---|---|
| 04:58 | 0.0° | 64° ENE | (+0.900, −0.436, 0.00) | 0.05 starlight |
| 05:00 | +0.4° | 64° | (+0.902, −0.432, +0.006) | 0.05 (ramp starts) |
| 06:00 | +11.8° | 73° | (+0.934, −0.294, +0.205) | 0.53 |
| 07:00 | +23.8° | 80° | (+0.902, −0.156, +0.403) | 1.00 (full) |
| 12:00 | +76.2° | 180° S | (0, **+0.239**, +0.971) | 1.00 |
| 17:00 | +23.8° | 280° W | (−0.902, −0.156, +0.403) | 1.00 (dusk ramp starts) |
| 18:56 | +1.5° | 295° **WNW** | (−0.906, −0.423, +0.02) | 0.20 (isNight flips) |
| 19:02 | 0.0° | 296° WNW | geometric sunset | 0.14 |
| 19:30 | −5.1° | 300° | below horizon | 0.05 starlight |
| 19:35 | −6.0° | civil dusk ends | — | 0.05 |

**Consistency proof (the contract):** sun is below the geometric horizon whenever `solarLight()` sits at the 0.05 starlight floor (sunrise 04:58 vs ramp start 05:00; sunset 19:02 with civil glow dying at 19:35 vs ramp floor 19:30). `isNight()` flips at sun alt +1.5° (dusk) / +6° (dawn) — within minutes of the geometric events. The 05:00–07:00 gameplay ramp gets a *literal* mechanism: sun at 6–24° altitude casts ridge shadows 0.8–3.7 km long, so the valley floor sits in cast shadow under a bright ambient sky until ~08:00 — exactly the documented Korengal morning, while gameplay "full light at 07:00" stays true because shadowed ground is ambient-lit (shadowStrength caps below, never black). **Sanity anchors:** noon sun is in the SOUTH (+y world, shadows point north/up-screen, both valley walls lit, short shadows); 08:00 sun in the EAST lights the west wall; evening sun is **WNW (287–296°) — it converges on the ART_BIBLE's baked NW sprite key at golden hour** (the baked sprite art is "perpetual golden hour"; the only true mismatch is morning ENE, when sprite shadows are smallest on screen).

Module-level constants of interest exported for docs/probes: `SUNRISE_H = 4.968`, `SUNSET_H = 19.032`, `CIVIL_DUSK_H = 19.585`.

## 2. Light-color ramps (sun, sky hemisphere, weather folding)

All colors are linear-ish sRGB triplets 0..1, restrained to the ART_BIBLE dust palette (±10% rule: the grade and light tints shift hue mildly; albedo stays canonical). A single keyframe table indexed by **sun altitude in degrees**, piecewise-lerped (smoothstep between keys) — banding on altitude, not clock time, keeps the model coherent if season/curve ever changes:

| key alt | sunColor | sunIntensity (Clear) | skyColor (zenith) | groundColor (dust bounce) | skyIntensity |
|---|---|---|---|---|---|
| 90° | (1.00, 0.98, 0.92) | 1.15 | (0.42, 0.53, 0.68) | (0.45, 0.38, 0.28) | 0.42 |
| 25° | (1.00, 0.95, 0.86) | 1.05 | (0.44, 0.54, 0.66) | (0.45, 0.38, 0.28) | 0.38 |
| 10° | (1.00, 0.84, 0.62) | 0.90 | (0.47, 0.52, 0.62) | (0.42, 0.34, 0.24) | 0.33 |
| 4° | (1.00, 0.72, 0.42) | 0.75 | (0.50, 0.50, 0.58) | (0.40, 0.30, 0.20) | 0.30 |
| 0° | (1.00, 0.58, 0.32) | 0.50 | (0.46, 0.48, 0.60) | (0.34, 0.26, 0.18) | 0.24 |
| −2° | sun term → 0 | 0 | (0.42, 0.48, 0.66) blue hour | (0.26, 0.24, 0.22) | 0.16 |
| −6° | 0 | 0 | (0.34, 0.42, 0.62) | (0.20, 0.20, 0.22) | 0.09 |
| −12°+ | 0 | 0 | (0.30, 0.38, 0.55) starlight | (0.16, 0.17, 0.20) | 0.045 |

**Weather folding — each gameplay multiplier maps to two visual knobs**, so total luminance tracks `ambientLight()` semantics exactly once (no double-darkening):

```ts
// directMult kills the BEAM (and with it cast shadows); exposure carries the gameplay total.
const WX: Record<string, { direct: number; cloudShadow: number }> = {
  Clear: { direct: 1.0, cloudShadow: 0.0 },  Hazy: { direct: 0.8, cloudShadow: 0.25 },
  Overcast: { direct: 0.15, cloudShadow: 0.85 }, Rain: { direct: 0.08, cloudShadow: 0.9 },
  Fog: { direct: 0.05, cloudShadow: 0.2 },   Snow: { direct: 0.2, cloudShadow: 0.6 },
};
sunIntensity = baseIntensity(alt) * WX[w.label].direct;
skyIntensity = baseSky(alt) * lerp(1.25, 1.0, WX[w.label].direct);   // overcast = flatter, softer
grade.exposure = baseExposure(alt) * weatherLightMult(w);            // import from lib/sim/campaign
shadowStrength = baseShadow(alt) * WX[w.label].direct;               // overcast ⇒ shadows melt away
nightFactor = 1 - clamp01(solar * weatherLightMult(w));              // EXACTLY today's `night`
```
`weatherLightMult` is imported from `lib/sim/campaign.ts:186` (render importing sim functions is established practice — combat-fx.ts already imports sim types). `solar` is passed in by the caller (`w.solarLight()`), so the gameplay curve is **never duplicated** in the render layer.

`shadowStrength` base: 0.55 high day → 0.65 at golden hour (alt < 10°) → 0.5 under moon. Hard legibility cap: shadowed terrain receives full hemisphere ambient, so day shade ≥ ~0.45× lit luma — the tactical read survives everywhere (legibility > realism, per contract).

## 3. Night — moon, starlight, and the death of the navy wash

**Moon (decided): fixed anti-solar gibbous.** Hour angle `Hm = H − 180°`, declination δm = −18°, illumination factor 0.65. Verified: moonrise ≈ 19:00, transit 37° due south at 00:00, moonset ≈ 05:00 — **up for essentially the entire night**, riding low across the southern sky with long raking shadows (a low summer moon is astronomically correct: a near-full moon mirrors the sun's declination). Rationale: a permanently-up moon maximizes night-ops readability and makes night terrain *gorgeous* instead of flat; phase realism (illum cycles) buys nothing the sim reads and costs a dark-night legibility floor problem. `moonColor = (0.70, 0.78, 0.95)`, `moonIntensity = 0.10 × 0.65 × clamp01(moonAlt/12°) × WX.direct` — overcast kills moonlight and its shadows, exactly like the sun.

**Starlight floor:** hemisphere ambient row at alt ≤ −12° above, ×`weatherLightMult`. Hard floor on terrain mean luma ≈ **0.12 of day** (moonless + overcast worst case) — never illegible.

**Replacing topo.ts:587-592 (the flat `rgba(8,14,30, .35+night*.42)` wash):**
- **Terrain (GL):** the lighting equation simply *continues* at night — key light = moon (real cast shadows from the same shadow path, moon direction), ambient = starlight. Target mean luminance ≈ 0.30 of day with moon up (matches today's wash result of ~0.37, slightly darker but with *form*), cool white-balance and scotopic desaturation from the grade (§4). The relief survives the night: ridges still shade, the moon line still moves.
- **2D top canvas:** delete the wash; sprites are darkened by the source-atop tint (§4) — they sit *in* the moonlight instead of under a veil.
- **Additive night FX stay readable by construction:** the grade seam is inserted **before** `drawNightLights` (WorldView.tsx:605), which already draws with `gco="lighter"` — muzzle sparks, tracer glow, and blast blooms are painted *after* the dark grade and therefore bloom against it at full warm intensity, exactly the current behavior but against real low-key terrain instead of a navy veil. `drawNightLights`'s `night <= 0.25` gate keeps its semantics because `nightFactor` is bit-identical to today's `1 − ambientLight()`.

## 4. The full-screen time-of-day grade — **dual-pass, shared math** (decision)

CSS filter on a wrapper is rejected (it would grade the in-canvas HUD ink and React chrome, and offers only coarse hue-rotate/sepia controls). A single source-over veil on the top canvas is rejected (it's the flat-wash contrast-killer we're deleting). **Chosen: grade each canvas with the same numbers from atmosphere.ts:**

**(a) Terrain canvas — graded in the GL fragment shader** (free; it's where the light already lives):

```glsl
uniform float uExposure;      // baseExposure(alt) * weatherLightMult — gameplay-consistent
uniform vec3  uWhiteBalance;  // per-channel gain
uniform float uSaturation;    // 1.0 day → 0.45 deep night (scotopic)
uniform vec3  uLift;          // shadow-region tint (blue-hour/dawn shadows)

vec3 grade(vec3 c) {
  c *= uExposure * uWhiteBalance;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c += uLift * (1.0 - clamp(l, 0.0, 1.0));   // lifts/tints shadows only, highlights untouched
  return c;
}
```

Grade keyframes (same altitude-lerped table):

| band | exposure (Clear) | whiteBalance | saturation | lift | spriteTint (r,g,b,a) |
|---|---|---|---|---|---|
| high day (alt ≥ 30°) | 1.00 | (1, 1, 1) | 1.00 | (0,0,0) | a = 0 (pass skipped) |
| afternoon (10°) | 0.97 | (1.04, 0.99, 0.93) | 1.03 | (0,0,0) | (255,196,140, 0.05) |
| golden (2–6°) | 0.90 | (1.10, 0.92, 0.78) | 1.08 | (0.02, 0.01, 0.00) | (255,176,112, 0.12) |
| civil twilight (−4°) | 0.55 | (0.88, 0.92, 1.10) | 0.80 | (0.01, 0.02, 0.05) | (70, 86, 130, 0.20) |
| night (≤ −10°) | 0.32 | (0.78, 0.85, 1.12) | 0.45 | (0.01, 0.02, 0.06) | (14, 20, 38, 0.42) |

(The golden WB (1.10,0.92,0.78) is a ≤10% hue push — inside the ART_BIBLE tint-restraint line; the dust palette warms, it doesn't become Instagram.)

**(b) Top canvas — one `source-atop` tint fillRect**, NEW function in a new file (it's atmosphere's output, not topo's):

```ts
// lib/render/atmosphere.ts
/** Grade the 2D world layer: lerps every ALREADY-DRAWN pixel toward the tint without
 *  touching alpha — transparent areas stay transparent (the GL terrain below is NOT
 *  veiled; it grades itself in-shader with the same table). Cost: one composite op.  */
export function drawScreenGrade(ctx: CanvasRenderingContext2D, cam: Camera, t: SpriteTint) {
  if (t.a < 0.01) return;                       // clear midday: literally free
  ctx.save();
  ctx.globalCompositeOperation = "source-atop"; // C' = a·T + (1−a)·C, alpha preserved
  ctx.fillStyle = `rgba(${t.r},${t.g},${t.b},${t.a})`;
  ctx.fillRect(0, 0, cam.vw, cam.vh);
  ctx.restore();
}
```

Why `source-atop` is the load-bearing choice: `multiply`/`soft-light` blend modes composite source-over, so on the now transparent-backed top canvas they'd paint a flat veil over the see-through regions and re-create the navy-wash bug on top of the GL terrain. `source-atop` is the only op that grades **only drawn pixels** and preserves alpha exactly. The lerp-toward-tint is a good mid-tone approximation of the shader grade for sprite-sized content; coherence comes from both passes reading one keyframe table. **Legibility guards:** tint alpha hard-capped at 0.5 (faction accents must survive deepest night — the GL terrain carries the darkness, not the sprites); seam placed before `drawNightLights` and the HUD block so additive gun-light and all ink/HUD stay ungraded.

## 5. The API surface — `lib/render/atmosphere.ts`

```ts
import type { Weather } from "@/lib/sim/campaign";          // type-only
import { weatherLightMult } from "@/lib/sim/campaign";

export interface SkyState {
  sunDir: [number, number, number];   // unit, world frame, surface→sun
  sunAlt: number;                     // radians, signed
  sunAzimuth: number;                 // radians compass (N=0, E=π/2) — sprite-shadow axis
  sunColor: [number, number, number];
  sunIntensity: number;               // after weather direct-kill; 0 ⇒ no beam, no cast shadows
  skyColor: [number, number, number]; // hemisphere zenith
  groundColor: [number, number, number]; // hemisphere dust bounce
  skyIntensity: number;
  moonDir: [number, number, number];
  moonColor: [number, number, number];
  moonFactor: number;                 // intensity after altitude/phase/weather
  keyDir: [number, number, number];   // = sun if sunIntensity ≥ moonFactor else moon (shadow-map key)
  shadowStrength: number;             // 0..1, weather-faded; uniform for the shadow term
  nightFactor: number;                // ≡ 1 − clamp01(solar·weatherLightMult) — today's `night`, exactly
  cloudShadowDensity: number;         // hook for the cloud-shadow axis (pans with sim wind)
  fogColor: [number, number, number]; // hook for the valley-fog axis (graded horizon color)
  grade: { exposure: number; whiteBalance: [number,number,number]; saturation: number;
           lift: [number,number,number]; spriteTint: { r:number; g:number; b:number; a:number } };
  spriteShadow: { dx: number; dy: number; alpha: number }; // world-units per meter of object height
}

/** PURE. (secondsOfDay, weather, solar) → SkyState. `solar` = world.solarLight(), passed in so
 *  the gameplay curve is never duplicated in the render layer. No wall clock, no random. */
export function skyState(secondsOfDay: number, weather: Weather, solar: number): SkyState;

export function sunDirWorld(secondsOfDay: number): [number, number, number];
export function drawScreenGrade(ctx, cam, tint): void;
```

`spriteShadow` (one source of truth for the sun-tracking sprite-shadow axis): direction `−normalize(keyDir.xy)`, length-per-meter `clamp(1/tan(max(alt, 8°)), 0.3, 4.0)`, `alpha = 0.34 · max(sunIntensity, moonFactor) · shadowStrength`. World +y is screen-down, so the vector needs **no flip** for screen use.

## 6. GLSL — the terrain shader terms this axis owns

Heightmap orientation contract: `elev` rows upload in cy order ⇒ texture **v = wy / worldSize with NO flip** (row 0 = north = y 0). Formats per the hazard: heightmap **R32F + NEAREST** (manual 4-tap bilinear where smooth sampling matters — avoids the OES_texture_float_linear dependency AND the R16F precision trap: half-float ulp at 2 km elevation is 1–2 m, which would terrace the normals); normals precomputed CPU-side once into RGBA8 (8-bit normals are fine at 5 m cells; same central-difference as topo.ts:157-165).

```glsl
// --- normal (from the baked normal texture; matches the old bake's convention) -------
vec3 n = normalize(texture(uNormalTex, vUV).xyz * 2.0 - 1.0);   // world frame, +z up

// --- cast-shadow: ray-march the heightmap toward the key light (sun or moon) ---------
// Runs in the SHADOW FBO PASS, not per-frame: rebaked only when keyDir moves > 0.5°.
float castShadow(vec2 wpos, vec3 toKey) {              // wpos in meters
  if (toKey.z <= 0.02) return 0.0;                     // body at/below horizon: all shadow
  float stepM = uShadowStepM;                          // ~2 texels: 10 m (5 m headless)
  vec2  dxy   = normalize(toKey.xy) * stepM;
  float dzds  = toKey.z / length(toKey.xy) * stepM;    // ray rise per step (m)
  float rayH  = heightAt(wpos) + 1.0;                  // 1 m bias kills self-shadow acne
  float soft  = 0.0;
  for (int i = 1; i <= 48; i++) {                      // 48·10 m = 480 m reach ≈ max ridge throw at alt>9°;
    vec2 p = wpos + dxy * float(i);                    // below that the floor is fully shadowed anyway
    rayH += dzds;
    soft = max(soft, clamp((heightAt(p) - rayH) * 0.25, 0.0, 1.0)); // soft penumbra, no aliasing
    if (soft >= 1.0) break;
  }
  return 1.0 - soft;                                   // 1 = lit, stored in uShadowTex (R8, 1024²)
}

// --- lighting combine (main terrain fragment, every frame) ---------------------------
float lit    = texture(uShadowTex, vUV).r;             // cached; keyed to uKeyDir
float shadow = mix(1.0 - uShadowStrength, 1.0, lit);   // shadowed ground keeps full ambient below
float sunNL  = max(dot(n, uSunDir), 0.0);
float moonNL = max(dot(n, uMoonDir), 0.0);
float skyVis = 0.5 + 0.5 * n.z;                        // hemisphere visibility = the bake's old `sky` term
vec3 direct  = uSunColor  * (uSunIntensity * sunNL)  * shadow
             + uMoonColor * (uMoonFactor  * moonNL)  * shadow;
vec3 ambient = mix(uGroundColor, uSkyColor, skyVis) * uSkyIntensity;
vec3 color   = albedo.rgb * (direct + ambient);        // albedo = de-shaded 4096² bake (terrain axis)

// optional Phase-4 flourish: the sun made visible on water (river mask in albedo.a)
float glint  = pow(max(dot(reflect(-uSunDir, n), vec3(0,0,1)), 0.0), 48.0);
color += albedo.a * glint * uSunColor * uSunIntensity * 0.6;

fragColor = vec4(grade(color), 1.0);                   // grade() from §4
```

**Albedo contract with the terrain axis (hard requirement):** the 4096² bake keeps landcover color, procedural `tex` detail, snow line, and saturation lifts, but **drops the `shade` term entirely** (topo.ts:169-173 — key/fill/sky move into the shader above). Shipping a lit albedo under this shader double-shades every slope. Altitude haze moves to the fog axis.

**Shadow-refresh policy (this axis owns the schedule):** rebake `uShadowTex` when `dot(prevKeyDir, keyDir) < cos(0.5°)` or the key body swaps (sun↔moon — the swap happens while both are near zero intensity, so it's invisible). Sun moves 0.25°/min ⇒ at 1× one 1024² rebake per ~2 min of game time (~free); at 60× warp one per ~2 s — and the sweeping shadow line becomes the *feature*: time-warp is a visible shadow time-lapse, the master clock made literal. Cap at one rebake per 2 frames so extreme warp can't stack passes. Headless/SwiftShader: 512² shadow tex + 5 m steps via the existing `--webgl` flag plumbing in scripts/visual-matrix.mjs.

## 7. Exact integration seams

1. **NEW `lib/render/atmosphere.ts`** — everything in §1–§5 (~250 lines + keyframe tables).
2. **components/world/WorldView.tsx:220** — replace `const night = 1 - w.ambientLight();` with `const sky = skyState(w.secondsOfDay, w.state.weather, w.solarLight()); const night = sky.nightFactor;` (downstream `night` users at :234, :357, :605 untouched in Phase 1).
3. **components/world/WorldView.tsx:222** — Phase 1: `drawTerrain(ctx, terrain, cam)` (night param deleted) followed by an interim module-colored veil (Phase 1 only, see §8); Phase 2: GL underlayer consumes `sky` uniforms, veil deleted.
4. **lib/render/topo.ts:586-592** — DELETE the night-wash block; drop the `night` param from `drawTerrain`.
5. **components/world/WorldView.tsx:~602** (immediately before the `drawNightLights` call at :605) — insert `drawScreenGrade(ctx, cam, sky.grade.spriteTint);`. Everything after (night lights, HUD, edge-flash, pointers) stays ungraded.
6. **GL terrain pass (terrain axis file, e.g. `lib/render/gl/terrain-pass.ts`)** — uniform block: `uSunDir, uSunColor, uSunIntensity, uMoonDir, uMoonColor, uMoonFactor, uKeyDir, uShadowStrength, uExposure, uWhiteBalance, uSaturation, uLift` — set once per frame from `sky`.
7. **Shadow FBO pass (`lib/render/gl/shadow-pass.ts`, shared ownership)** — march shader from §6; refresh policy + `keyDir` from this module.
8. **scripts/shoot.mjs / scripts/visual-matrix.mjs** — add `--hour H` (sets `world.state.clock` before capture) so dawn/golden/night goldens are reproducible; matrix rows: 05:30, 07:30, 12:00, 18:30, 19:15, 23:00 × Clear/Overcast.
9. **scripts/scratch-sun-probe.ts (disposable)** — asserts: (a) sun below horizon whenever the inlined gameplay curve copy is at starlight, and the copy matches `World.solarLight()` at 1-min resolution; (b) `nightFactor === 1 − ambientLight()` across 24 h × 6 weathers; (c) `|sunDirWorld|` ≈ 1 everywhere. Delete after Phase 2.

## 8. Phased implementation (game never broken)

- **Phase 0 — model + proof (no visual change).** Ship `atmosphere.ts` + the scratch probe. tsc/build/smoke green; zero pixels change.
- **Phase 1 — 2D-only rewire (immediate visible win, pre-GL).** Seams 2/4/5 + an interim terrain veil: since the old bake still carries baked NW shade, replace the flat navy wash with a module-colored source-over veil over the terrain only (drawn right after :222, alpha ≈ today's, color from the grade table — dusk goes golden, night goes cold blue-grey, dawn warms) + the sprite tint at seam 5. Screenshot A/B at 6 hours. Game fully playable; this phase stands alone even if GL slips.
- **Phase 2 — GL terrain lands (terrain axis).** Uniforms wired (seam 6), albedo de-shaded (contract §6), interim terrain veil deleted; cast ridge shadows live on the clock. Verify the dawn money-shot: 05:30–08:00 time-lapse, sun line walking down the west wall.
- **Phase 3 — night relight.** Moon shadows via the key-swap, scotopic grade, wash fully dead; verify night firefight readability (muzzle blooms over moonlit relief) and the 0.12 luma floor on a moonless overcast night.
- **Phase 4 (optional, cut first)** — river sun-glint (albedo alpha mask), golden-hour horizon lift.

## 9. Residual risk deliberately taken

The static sprite library keeps its baked NW key light and SE cast shadows (164 SVGs are NOT re-authored). The dynamic terrain sun matches them exactly at golden hour, acceptably at noon (short shadows), and contradicts them at dawn (sun ENE) — accepted because morning sprite shadows are sub-8-px at typical zoom, and the sun-tracking *procedural* contact shadows (separate axis, fed by `spriteShadow`) carry the directional read. If a skeptical eye catches it, the fix is per-band shadow re-tints, not re-authoring.

## Key decisions
- **Fixed season = mid-July, solar declination +21.0°, latitude 34.8°N, clock treated as local apparent solar time**
  - rejected: June solstice (δ=23.44°) — sunrise 04:50, sun above horizon 10 min before the gameplay dawn ramp starts; a real seasonal model driven by campaign day — rejected because no season system exists in the sim, it would let the visual day length drift away from the FIXED gameplay solarLight() ramps, and the Korengal's visual identity is the summer fighting season anyway; modeling equation-of-time/UTC+4:30 — pointless precision against a stylized clock
  - why: Verified numerically: δ=21° gives geometric sunrise 04:58 / sunset 19:02 / civil dusk 19:35 against the untouched gameplay ramps at 05:00 / 19:30, and isNight() flips within minutes of geometric sunset — the one declination where the visual sun and the sacred gameplay curve agree to within minutes, for free, forever. Restrepo/The Outpost deployments are summer-heavy.
- **Sun vector mapping: toSun_world = (−cosδ·sinH, −(cosφ·sinδ − sinφ·cosδ·cosH), sinφ·sinδ + cosφ·cosδ·cosH) — the north component is NEGATED because world +y is south**
  - rejected: Copying a standard ENU formula without the y-flip — would put the noon sun in the NORTH sky and rake morning light from the west; both visibly wrong to anyone who's seen the reference footage
  - why: Verified against anchors: noon vector (0, +0.239, 0.971) = sun in the south, shadows north/up-screen; 08:00 sun east lighting the west wall; sunrise azimuth 64° ENE matches real summer Kunar. Same toward-the-light convention as the existing bake key (−0.55,−0.62,0.56).
- **Dual-pass shared-math grade: GL terrain grades itself in-shader; the 2D top canvas gets ONE source-atop tint fillRect before drawNightLights/HUD, both reading one altitude-keyed table in atmosphere.ts**
  - rejected: CSS filter on a wrapper div — grades the in-canvas HUD ink and React chrome, only coarse controls, rejected; single source-over veil on the top canvas — re-creates the flat-wash contrast-killer over the GL terrain showing through transparent regions; multiply/soft-light blend on the top canvas — blend modes composite source-over, so they paint a veil over the transparent areas (verified against the canvas compositing spec: where dest α=0, Cr=Cs), rejected
  - why: source-atop is the only canvas op that grades exactly the drawn pixels and preserves alpha, so the transparent-backed top canvas never veils the terrain below; coherence between canvases comes from shared numbers, not a shared pass; HUD and additive night FX drawn after the seam stay ungraded ink/light.
- **Moon: fixed anti-solar gibbous (hour angle H−180°, δ=−18°, illumination 0.65), cool-blue key with real cast shadows via the same shadow path**
  - rejected: Real lunar phase cycle — buys nothing the sim reads, and dark-of-the-moon nights would need an artificial legibility floor anyway; no moon (starlight only) — night terrain goes formless, regressing on the current wash's legibility
  - why: Verified up 19:00–05:00, transiting 37° due south at midnight — the entire night is moonlit with long raking southern shadows, visually distinct from any daytime light; weather kills it exactly like the sun (overcast night = the dark floor).
- **nightFactor ≡ 1 − clamp01(solar × weatherLightMult), with solarLight() passed IN as an argument rather than re-implemented in the render layer**
  - rejected: Duplicating the piecewise solarLight curve inside atmosphere.ts — a silent-drift hazard if the gameplay curve is ever tuned; reading World directly from the module — violates the render-layer purity/bridge rule
  - why: Every existing night consumer (drawWeather :234, drawCop :357, drawNightLights :605, the ≤0.25 gate) keeps bit-identical semantics; the visual model can never disagree with the gameplay light because it is parameterized by it.
- **Cast-shadow texture is CACHED (1024² R8) and rebaked only when the key direction moves > 0.5° or the key body swaps sun↔moon; weather's direct-kill fades shadowStrength to near zero under Overcast/Rain/Fog**
  - rejected: Per-frame in-fragment ray march — 48 heightmap taps × 2 Mpx every frame, ruinous on SwiftShader/iGPU; precomputed horizon maps (more memory, more complexity than a 2-min-interval rebake warrants)
  - why: Sun moves 0.25°/min: one cheap FBO pass per ~2 game-minutes at 1×, and at time-warp the sweeping shadow line becomes the headline feature — the master clock made visible. Body swap happens while both intensities are ~0, so it is invisible.
- **Heightmap as R32F + NEAREST with manual 4-tap bilinear in the shadow march; normals precomputed CPU-side into RGBA8**
  - rejected: R32F + LINEAR — needs OES_texture_float_linear (the named hazard); R16F + LINEAR — filterable in core WebGL2 but half-float ulp at ~2000 m elevation is 1–2 m, terracing the normals (the relief-legibility DO-NOT-RE-TRY in spirit)
  - why: 512² R32F is 1 MB; manual bilinear costs 4 taps only inside the amortized shadow pass; 8-bit normals at 5 m cells match the existing bake's visual quality.
- **Keep the baked NW key/SE shadow in the 164 static sprites; the dynamic terrain sun converges on it at golden hour (evening azimuth 287–296° WNW, verified)**
  - rejected: Re-authoring the sprite library with split-out shadows — weeks of work for sub-8-px shadows at typical zoom; rejecting the dynamic sun to protect the sprites — re-litigates a DECIDED item
  - why: The ART_BIBLE's fixed NW key is 'perpetual golden hour'; the only true mismatch window (morning, sun ENE) is when sprite shadows are smallest, and the sun-tracking procedural contact shadows (separate axis, fed by this module's spriteShadow output) carry the directional read.

## Integration points
- lib/render/atmosphere.ts (NEW) — The single module: sunDirWorld(), moon model, altitude-keyed color/grade tables, skyState(secondsOfDay, weather, solar) → SkyState, drawScreenGrade(), spriteShadow output. Pure, deterministic, React-free; imports only Camera type from ./topo and weatherLightMult + Weather type from ../sim/campaign.
- components/world/WorldView.tsx:220 — Replace `const night = 1 - w.ambientLight();` with `const sky = skyState(w.secondsOfDay, w.state.weather, w.solarLight()); const night = sky.nightFactor;` — bit-identical value, threads SkyState through draw().
- components/world/WorldView.tsx:222 — Phase 1: drawTerrain(ctx, terrain, cam) loses the night arg; interim module-colored terrain veil drawn immediately after. Phase 2: the GL underlayer (terrain axis) renders first with sky uniforms; veil deleted; drawTerrain reduces to contours/paths/detail-grain on the transparent top canvas.
- lib/render/topo.ts:586-592 — DELETE the flat navy night-wash block (`rgba(8,14,30, .35+night*.42)` fillRect); remove the `night` parameter from drawTerrain's signature.
- components/world/WorldView.tsx:~602 (immediately before the drawNightLights call at :605) — Insert `drawScreenGrade(ctx, cam, sky.grade.spriteTint);` — grades all world-space 2D content via source-atop; drawNightLights (additive), HUD, edge-flash, and off-screen pointers drawn after remain ungraded.
- components/world/WorldView.tsx:234, :357, :605 — drawWeather / drawCop / drawNightLights keep their `night` argument, now sourced from sky.nightFactor (identical semantics, no signature change).
- lib/render/gl/terrain-pass.ts (terrain axis's new file) — Consumes the per-frame uniform block from SkyState: uSunDir/uSunColor/uSunIntensity/uMoonDir/uMoonColor/uMoonFactor/uKeyDir/uShadowStrength/uExposure/uWhiteBalance/uSaturation/uLift. HARD CONTRACT: the 4096² albedo bake must drop the shade term at topo.ts:169-173 (key/fill/sky lighting moves into this shader) or every slope double-shades.
- lib/render/gl/shadow-pass.ts (NEW, shared with terrain axis) — 1024² R8 FBO ray-march (GLSL in design §6) keyed to sky.keyDir; rebake policy owned by this axis: refresh when dot(prevDir, keyDir) < cos(0.5°) or key body swaps, max one rebake per 2 frames; 512² + coarser step under the headless/SwiftShader flag.
- scripts/shoot.mjs + scripts/visual-matrix.mjs — Add `--hour H` (sets world clock before capture) and a time-of-day matrix row set {05:30, 07:30, 12:00, 18:30, 19:15, 23:00} × {Clear, Overcast} for golden screenshots.
- scripts/scratch-sun-probe.ts (disposable, delete after Phase 2) — Asserts sun-below-horizon ⟺ solarLight at starlight floor, nightFactor ≡ 1−ambientLight() across 24 h × 6 weathers, |sunDirWorld|≈1, and that any inlined curve copy matches World.solarLight() at 1-min resolution.

## Risks
- [high] Albedo not de-shaded when the GL pass lands → every slope is lit twice (baked NW shade × dynamic sun), relief reads muddy and doubled → Explicit written contract in the design (§6) naming topo.ts:169-173 as the code that moves into the shader; Phase-2 acceptance screenshot at 12:00 Clear compared against HEAD — noon relief must be FLATTER than today's bake (high sun), which is impossible if the bake still carries shade.
- [medium] SwiftShader (headless --disable-gpu harness) renders the GL pass too slowly or not at all, breaking the screenshot/verification pipeline → Shadow march lives in an amortized FBO pass, never per-frame; headless profile drops to 512² shadow tex + 10 m steps; scripts/visual-matrix.mjs already has the --use-angle=swiftshader plumbing; Phase 1 (2D-only) ships standalone so the game and harness are never hostage to GL.
- [medium] Night/dusk grade erodes tactical legibility — faction accents and wounded/pinned cues unreadable at 23:00 → Sprite tint alpha hard-capped at 0.5 (terrain carries the darkness in-shader instead); HUD/ink/additive FX drawn after the grade seam; terrain mean-luma floor 0.12 on moonless-overcast nights; Phase-3 acceptance is a night-firefight screenshot where threat crescents and bleed pools pass the squint test.
- [low] Baked NW sprite shadows contradict the morning ENE sun (worst at 06:00–09:00) → Accepted residual (decision #8): morning sprite shadows are sub-8-px at typical zoom; the sun-tracking procedural contact shadows from spriteShadow carry direction; evening (golden hour) converges on the baked NW key exactly. Escalation path is per-band shadow re-tint, not re-authoring 164 SVGs.
- [medium] weatherLightMult double-counted (in exposure AND in sun/sky intensities) → overcast nights twice as dark as the gameplay model says → Single-fold rule written into the module (§2): exposure carries weatherLightMult exactly once; weather's other effect is the direct/ambient REDISTRIBUTION (directMult). The scratch probe asserts nightFactor ≡ 1−ambientLight() across all 6 weather states.
- [low] Hidden coupling: something assumes drawTerrain still applies the night wash (e.g. DeployScreen.tsx:321 reads ambientLight for its own tinting) and night looks inconsistent across screens during the phase gap → Phase 1 keeps an interim module-colored veil at the same draw position with matched alpha, so no frame ever ships with bright-noon terrain at midnight; grep for drawTerrain callers (WorldView is the only one today) gated in Phase-1 review.

## Perf budget
CPU: skyState() is ~40 flops + table lerps, called once per rAF — < 2 µs/frame, invisible next to the existing 2D draw. GPU (the new costs this axis adds): (1) lighting+grade in the terrain fragment shader ≈ +40 ALU and 3 texture taps per pixel over a bare blit — at 1920×1080 ≈ 2.1 Mpx, ~0.5–1.0 ms on a 2015-class Intel iGPU, well inside budget; (2) cast-shadow FBO rebake: 1024² × ≤48 height taps ≈ 50 M fetches ≈ 2–4 ms GPU, but amortized — sun moves 0.25°/min so at 1× speed it fires once per ~2 game-minutes (~0 ms/frame average), at 60× warp once per ~2 s real time (< 0.2% duty), hard-capped at one rebake per 2 frames; (3) the 2D screen grade is one source-atop fillRect ≈ 0.1–0.3 ms, and literally skipped (a<0.01) during clear midday — the most common state. Texture memory added by this axis's requirements: 512² R32F height (1 MB) + 512² RGBA8 normals (1 MB) + 1024² R8 shadow (1 MB) = 3 MB on top of the terrain axis's 4096² RGBA8 albedo (64 MB, which replaces the existing equally-sized 2D bake canvas, so net VRAM is roughly flat). Today's measured 116 fps at tactical zoom leaves ~8.6 ms/frame headroom at 60 fps; worst case added steady-state is ~1.3 ms (lighting+grade+tint) and worst transient is ~5 ms on a rebake frame at warp — 60 fps holds with ≥5 ms margin even on SwiftShader-class fill rates, and Phase 1 alone (pure 2D, two fillRects) is measurably cheaper than the wash+overlay it replaces.

## Open questions
- Who owns lib/render/gl/shadow-pass.ts in the synthesis — this axis specifies the march GLSL and the refresh policy, the terrain axis owns the FBO/context plumbing; one writer per file must be assigned.
- Should contour lines and path ink (drawn inside drawTerrain at topo.ts:581-584, i.e. before the grade seam) be graded at night? Current design grades them (they're world ink); if night contour legibility suffers in the Phase-3 screenshot, the one-line fix is moving drawContoursLive/drawPathsLive after the grade seam — needs an eyeball call on the actual capture.
- Does the campaign ever want a seasonal arc (multi-month deployments)? The fixed δ=+21° assumption is correct for the current design and the solarLight() contract, but a future season system would need the declination to become a function of campaign day AND a renegotiation of the fixed gameplay ramps — flagging so it's a recorded decision, not an accident.
- Snow weather in high summer is now visibly incongruous (it predates this design): the grade treats Snow as a cold front (cool WB, direct-kill 0.2) — fine visually, but worth a campaign-layer look at whether Snow should be gated by season once a season exists.
- The interim Phase-1 terrain veil alpha needs one tuning pass against HEAD night screenshots (match current mean luma within ~10%) — trivial but requires the capture, not a number I can pin in the doc.
