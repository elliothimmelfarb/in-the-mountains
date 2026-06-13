// GLSL source for the WebGL2 terrain underlayer — the 10x rebuild (attempt #2).
//
// PASS A (TERRAIN_FRAG): the fullscreen-triangle terrain, lit in LINEAR radiance by the live
// clock sun + sky hemisphere + moon, gated by the rebaked cast-shadow visibility map, rendered
// into an RGBA16F HDR target. Outputs UNCLAMPED linear light (so highlights can bloom and ACES
// can roll them off). The albedo bake is one input, not the image.
// PASS C (COMPOSITE_FRAG): reads the HDR target, applies ACES filmic tonemap → time-of-day
// grade (sky.ts: exposure/WB/sat/lift) → ordered dither → sRGB, to the visible canvas.
// The 2D canvas (contours/units/HUD) sits ABOVE this, ungraded — the legibility firewall.
//
// The vertex shader is the inverse of worldToScreen (topo.ts:12); v_world is the world-meter
// position under each fragment. heightAt/normalAt (PRELUDE) are the bit-faithful Terrain.elevAt
// port — the contour-registration contract. SHADOW_FRAG's exponential march is reused verbatim.

export const TERRAIN_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_clip;   // fullscreen triangle: (-1,-1) (3,-1) (-1,3)
uniform vec2  u_camCenter;             // cx, cy (world meters)
uniform vec2  u_viewCss;               // vw, vh (CSS px — DPR-independent)
uniform float u_ppm;                   // CSS px per meter
uniform vec2  u_shakePx;               // camera-punch offset (CSS px), matches the 2D transform
out vec2 v_world;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  // Invert worldToScreen: NDC +y is up, world/screen +y is south(down) → negate y.
  // Subtracting shake reproduces the 2D ctx.setTransform pixel offset (WorldView shake).
  vec2 fromCenter = vec2(a_clip.x, -a_clip.y) * u_viewCss * 0.5 - u_shakePx;
  v_world = u_camCenter + fromCenter / u_ppm;
}`;

// Shared GLSL: bit-faithful heightAt (= Terrain.elevAt, terrain.ts:3137), per-fragment normals
// (forward difference, topo.ts:163-171, at screen res), and value-noise fbm for cloud shadows
// + close-zoom tooth. Prepended to every fragment program that touches terrain.
const PRELUDE = /* glsl */ `
uniform sampler2D u_height;   // 512x512 R32F, NEAREST
uniform float u_cell;         // 5.0
uniform float u_grid;         // 512.0

float heightAt(vec2 w) {      // EXACT port of Terrain.elevAt — cell-corner lattice, clamp grid-1.001
  vec2 g = clamp(w / u_cell, vec2(0.0), vec2(u_grid - 1.001));
  vec2 i = floor(g), f = g - i;
  ivec2 c = ivec2(i);
  float h00 = texelFetch(u_height, c,               0).r;
  float h10 = texelFetch(u_height, c + ivec2(1, 0), 0).r;
  float h01 = texelFetch(u_height, c + ivec2(0, 1), 0).r;
  float h11 = texelFetch(u_height, c + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
vec3 normalAt(vec2 w) {       // forward difference at one-cell spacing (matches the bake's math)
  float e  = heightAt(w);
  float eX = heightAt(w + vec2(u_cell, 0.0));
  float eY = heightAt(w + vec2(0.0, u_cell));
  vec2 dz = vec2(eX - e, eY - e) / u_cell;
  return normalize(vec3(-dz.x, -dz.y, 1.0));
}
float hash2(ivec2 p) {
  uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return float(h ^ (h >> 16u)) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(ivec2(i)), b = hash2(ivec2(i) + ivec2(1,0));
  float c = hash2(ivec2(i) + ivec2(0,1)), d = hash2(ivec2(i) + ivec2(1,1));
  return a + (b-a)*u.x + (c-a)*u.y + (a-b-c+d)*u.x*u.y;
}
float fbm2(vec2 p) { return vnoise(p)*0.6 + vnoise(p*2.13)*0.27 + vnoise(p*4.7)*0.13; }
float fbm3(vec2 p) { return vnoise(p)*0.52 + vnoise(p*2.03)*0.27 + vnoise(p*4.1)*0.14 + vnoise(p*8.7)*0.07; }
vec3 degamma(vec3 c){ return pow(max(c, 0.0), vec3(2.2)); }   // sRGB-ish → linear (albedo is authored sRGB)
`;

// ── PASS A: linear-radiance terrain → RGBA16F HDR ──────────────────────────────────────────
// Replaces attempt-1's `albedo*(0.34+0.95*shade)` scalar hack with a real linear lighting model:
// L = albedo·(sunColor·sunI·NdotL·shadow·cloud + skyHemisphere + moon). Output is UNCLAMPED
// linear light. No grade, no tonemap here — those live in PASS C so highlights survive to bloom.
export const TERRAIN_FRAG_LIT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PRELUDE}
in vec2 v_world;
uniform sampler2D u_albedo;     // UNLIT albedo (bakeAlbedo), authored sRGB
uniform sampler2D u_shadow;     // sun-visibility map (1 = lit), rebaked on key-dir motion
uniform sampler2D u_ao;         // 512² R8 baked horizon AO (1 open, →0 occluded) — AMBIENT only
// material spine (C3/C4): per-landcover detail recomposition, faded in by zoom (u_detailGain)
uniform highp usampler2D u_landId;     // 512² R8UI — Land class per cell
uniform sampler2D u_control;           // 512² RGBA8 — R=slope/2, G=conceal, B=cover
uniform highp sampler2DArray u_matAlbedo;  // MAT_COUNT layers — luma detail (.rgb) + roughness (.a)
uniform highp sampler2DArray u_matNormal;  // MAT_COUNT layers — micro detail-normal (.rg)
uniform float u_detailGain;            // 0 strategic → 1 close (the legibility firewall)
uniform float u_tileMeters;            // world meters one material tile spans (≈8)
uniform float u_worldSize;      // 2560.0
uniform float u_minElev;
uniform float u_elevRange;
uniform vec3  u_bgColor;        // off-map void (sRGB)
uniform float u_ppm;
// sky/sun (lib/render/sky.ts SkyState) — all light is driven from here, never duplicated
uniform vec3  u_sunDir;         // unit, world frame (+x E, +y S, +z up)
uniform vec3  u_sunColor;
uniform float u_sunI;           // direct beam intensity (weather direct-kill already folded)
uniform vec3  u_moonDir;
uniform vec3  u_moonColor;
uniform float u_moonFactor;     // night key intensity (0 by day / overcast)
uniform vec3  u_skyColor;       // hemisphere zenith
uniform vec3  u_groundColor;    // dust bounce
uniform float u_skyI;           // hemisphere intensity
uniform float u_formLightNW;    // 0..1 noon relief-inversion guard: blend a fixed NW key into NdotL
uniform float u_ambientFloor;   // legibility: minimum ambient so shadowed faces never crush
// altitude warm/cool (mild here; full single-scatter aerial perspective arrives in C7)
uniform float u_warmLow;
uniform float u_coolHigh;
// drifting cloud shadows: procedural fbm of the wind-drifted world position (dims the BEAM only)
uniform vec2  u_cloudOffset;
uniform float u_cloudScale;
uniform float u_cloudDensity;
uniform float u_cloudStrength;
// terrain-aware valley fog: pools from the 128² local valley-floor min-field
uniform sampler2D u_localFloor;
uniform float u_fogThickness;
uniform float u_fogFade;
uniform float u_fogStrength;
uniform vec3  u_fogColor;
// water (C6): flow-advected specular river + ford/bank foam
uniform sampler2D u_flow;       // RG8 downstream flow dir at water cells
uniform sampler2D u_waterMask;  // R8 water mask (LINEAR → shoreline ramp)
uniform float u_time;           // secondsOfDay — water phase (freezes on pause, races at time-warp)
out vec4 o;

const vec3 NW_KEY = vec3(-0.6726, -0.7583, 0.6850);  // normalize(-0.55,-0.62,0.56) — the form-light key
// Land class (0..25) → material group (must mirror MAT_SLOT in material-atlas.ts)
const int MAT_SLOT[26] = int[26](4,4,7,3,3,5,2,1,1,1,2,0,0,0,0,5,5,5,7,7,7,6,5,7,7,4);
// per-group rake (detail-normal) + albedo-detail strength (ROCK..GRAVEL)
const float MAT_NRM[8] = float[8](1.0, 0.5, 0.9, 0.7, 0.35, 0.4, 0.7, 0.6);
const float MAT_ALB[8] = float[8](0.9, 0.7, 0.85, 0.7, 0.5, 0.5, 0.8, 0.75);

// 5-tap PCF on the R8 sun-visibility map — distance-aware soft penumbra (wider when zoomed out).
float shadowPCF(vec2 uv) {
  float s = (1.0 / 1024.0) * (1.0 + 1.6 / max(u_ppm, 0.3));
  float v = texture(u_shadow, uv).r * 0.4;
  v += texture(u_shadow, uv + vec2(s, 0.0)).r * 0.15;
  v += texture(u_shadow, uv + vec2(-s, 0.0)).r * 0.15;
  v += texture(u_shadow, uv + vec2(0.0, s)).r * 0.15;
  v += texture(u_shadow, uv + vec2(0.0, -s)).r * 0.15;
  return v;
}

void main() {
  vec2 uv = v_world / u_worldSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(degamma(u_bgColor), 1.0); return; }

  vec3  n      = normalAt(v_world);
  vec3  albedo = degamma(texture(u_albedo, uv).rgb);      // → linear
  float vis    = shadowPCF(uv);                            // cast-shadow visibility (1 lit), soft penumbra
  float ao     = texture(u_ao, uv).r;                      // baked horizon AO (multiplies AMBIENT only)
  float sunUp  = smoothstep(0.0, 0.07, u_sunDir.z);        // fade direct light through ~0-4° altitude

  // ── material recomposition (C4): the surface becomes a photograph, not a painted bitmap ──
  // The detail fades in with zoom (u_detailGain→0 at strategic ⇒ byte-faithful relief; the band
  // attempt-1 got right is provably preserved). The low sun rakes micro detail-normals so close
  // ground resolves into scree grains / furrows / canopy lobes — luminance only, palette intact.
  if (u_detailGain > 0.001) {
    ivec2 cell = ivec2(clamp(v_world / u_cell, vec2(0.0), vec2(u_grid - 1.0)));
    uint lid = texelFetch(u_landId, cell, 0).r;
    int slot = MAT_SLOT[int(min(lid, 25u))];
    float slope2 = texture(u_control, uv).r;             // slope/2 (0..1); >0.5 ⇒ slope>1.0 (steep)
    if ((slot == 1 || slot == 3) && slope2 > 0.5) slot = 0;   // grass/crop on a steep face → talus rock
    vec2 mu = v_world / u_tileMeters;                    // world-scale; REPEAT layer = seamless tile
    vec2 mu2 = mu * 3.17 + vec2(0.37, 0.71);             // 2nd octave so the tile never visibly repeats
    vec3 dnA = texture(u_matNormal, vec3(fract(mu),  float(slot))).xyz;
    vec3 dnB = texture(u_matNormal, vec3(fract(mu2), float(slot))).xyz;
    vec2 dN  = (dnA.xy + dnB.xy) - 1.0;                  // decode two averaged (·*0.5+0.5) taps
    float la = texture(u_matAlbedo, vec3(fract(mu),  float(slot))).r;
    float lb = texture(u_matAlbedo, vec3(fract(mu2), float(slot))).r;
    float lum = la + lb;                                 // two ~0.5-neutral taps → ~1.0 neutral
    // rake harder when the sun is low (long facet shadows), softer at noon so micro ≠ macro never fights
    float rake = u_detailGain * (0.6 + 0.4 * smoothstep(0.0, 0.45, length(u_sunDir.xy)));
    n = normalize(n + vec3(dN * MAT_NRM[slot] * rake, 0.0));
    albedo *= clamp(mix(1.0, lum, u_detailGain * MAT_ALB[slot]), 0.45, 1.7); // bold tooth, never crush to black
  }

  // diffuse key: live sun, with a fraction of the fixed NW key blended in so a high noon sun
  // (due south on a north-up map → flat, shadowless relief) still rakes the slopes (legibility).
  float keySun = max(0.0, dot(n, u_sunDir));
  float keyNW  = max(0.0, dot(n, NW_KEY));
  float ndl    = mix(keySun, max(keySun, keyNW), u_formLightNW);

  // drifting cloud shadow dims the SUN beam (and with it cast shadows), never the ambient
  float cl = fbm3((v_world + u_cloudOffset) * u_cloudScale);
  float cloudShadow = smoothstep(0.58 - u_cloudDensity * 0.45, 0.84, cl) * u_cloudStrength;
  float cloudVis = 1.0 - cloudShadow;

  vec3 direct = u_sunColor * u_sunI * ndl * vis * cloudVis * sunUp;

  // sky hemisphere (dome zenith ↔ dust ground bounce by face orientation) — the ambient that
  // carries shadowed faces and the moonless floor. ambientFloor keeps shaded ground legible.
  float hemiMix = 0.5 + 0.5 * n.z;
  vec3  hemi = mix(u_groundColor, u_skyColor, hemiMix) * (u_skyI + u_ambientFloor) * ao;

  // moon as the night key — same cast-shadow vis, raking the relief so night has FORM
  float moonUp  = smoothstep(0.0, 0.04, u_moonDir.z);
  float ndlMoon = max(0.0, dot(n, u_moonDir));
  vec3  moon = u_moonColor * u_moonFactor * ndlMoon * vis * moonUp;

  vec3 L = albedo * (direct + hemi + moon);

  // ── water surface (C6): the river becomes actual moving water ──
  // Masked to river/marsh/ford cells (early-out keeps cost to a few % of pixels). Two noise
  // octaves advected along the downstream flow build a ripple normal; fresnel sky reflection +
  // depth tint + a SOBER sun-tracked glint + ford/bank foam. All phase keyed to the sim clock
  // (u_time = secondsOfDay) so it freezes on pause and races at time-warp — no wall clock.
  float water = texture(u_waterMask, uv).r;
  if (water > 0.04) {
    vec2 flow = texture(u_flow, uv).rg * 2.0 - 1.0;
    // low-frequency flow bands (≈8-20 m) advected downstream — smooth undulation, not per-pixel speckle
    vec2 a1 = v_world * 0.11 + flow * u_time * 0.4;
    vec2 a2 = v_world * 0.27 - flow * u_time * 0.7 + 21.0;
    float e = 1.5;
    float h  = fbm2(a1) + 0.5 * fbm2(a2);
    float hx = fbm2(a1 + vec2(e, 0.0)) + 0.5 * fbm2(a2 + vec2(e, 0.0));
    float hy = fbm2(a1 + vec2(0.0, e)) + 0.5 * fbm2(a2 + vec2(0.0, e));
    vec3 wn = normalize(vec3((h - hx) * 0.32, (h - hy) * 0.32, 1.0));  // very gentle tilt — calm river
    // depth-tinted body — gravel-teal shallows → deeper slate-teal mid-channel, never black, kept bright
    vec3 body = mix(degamma(vec3(0.36, 0.48, 0.50)), degamma(vec3(0.21, 0.33, 0.40)), water * 0.7);
    float ambW = u_skyI * 2.4 + u_ambientFloor + 0.3;
    vec3 wcol = body * ambW;
    // subtle cool sky-reflection brightening where the surface tilts (kept low → no froth speckle)
    float fres = clamp(pow(1.0 - wn.z, 4.0), 0.0, 0.25);
    wcol += mix(u_groundColor, u_skyColor, 0.85) * (u_skyI * 1.4) * fres;
    // sober sun-tracked glint (HDR → faint bloom in C8); view straight down
    vec3 H = normalize(u_sunDir + vec3(0.0, 0.0, 1.0));
    wcol += u_sunColor * pow(max(0.0, dot(wn, H)), 70.0) * u_sunI * sunUp * vis * 0.6;
    // foam: only the rare brightest churn peak + a hair at fast water — most of the channel is clean
    float churn = fbm2(v_world * 0.32 + flow * u_time * 0.5);
    float foam = smoothstep(0.9, 0.99, churn) * 0.25;
    wcol = mix(wcol, degamma(vec3(0.86, 0.88, 0.84)) * (u_skyI * 2.0 + u_sunI * 0.4 * sunUp + 0.2), foam);
    L = mix(L, wcol, smoothstep(0.04, 0.4, water));   // soft blend in over the bank
  }

  // mild altitude warm/cool (the floor reads warm, the crests cool); superseded by C7 aerial perspective
  float altN = clamp((heightAt(v_world) - u_minElev) / u_elevRange, 0.0, 1.0);
  L *= vec3(1.0 - altN * u_warmLow, 1.0, 1.0 + altN * u_coolHigh);

  // terrain-aware valley fog (pools from the local floor up to a diurnal ceiling); linear in-scatter
  if (u_fogStrength > 0.01 && u_fogThickness > 0.5) {
    float lf = texture(u_localFloor, uv).r;
    float fog = clamp((lf + u_fogThickness - heightAt(v_world)) / u_fogFade, 0.0, 1.0) * u_fogStrength;
    vec3 fogLit = degamma(u_fogColor) * (u_skyI * 1.2 + u_sunI * 0.25 * sunUp);
    L = mix(L, fogLit, fog);
  }

  o = vec4(L, 1.0);   // LINEAR HDR — tonemapped + graded in PASS C
}`;

// ── PASS C: HDR composite → ACES tonemap → grade → dither → sRGB ────────────────────────────
export const COMPOSITE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_clip;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  v_uv = a_clip * 0.5 + 0.5;   // sample the HDR target in the same NDC orientation it was rendered
}`;

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_hdr;
uniform sampler2D u_bloom;       // half-res bloom (C8); 1x1 black until then
uniform float u_bloomStrength;
uniform float u_sceneExposure;   // base scene exposure (calibration knob, tuned once)
uniform float u_exposure;        // grade exposure — time-of-day × weatherLightMult (single-fold)
uniform vec3  u_whiteBalance;
uniform float u_saturation;
uniform vec3  u_lift;
uniform vec2  u_res;             // drawing-buffer px, for the ordered dither
out vec4 o;

// ACES filmic (Narkowicz fit) — linear scene radiance → display-linear [0,1]
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c){ return mix(1.055*pow(max(c,0.0), vec3(1.0/2.4)) - 0.055, c*12.92, step(c, vec3(0.0031308))); }
// 4x4 ordered Bayer dither — kills 8-bit banding in the smooth sky-ambient gradients
float bayer(vec2 p){
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  int idx = y*4 + x;
  float m[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
  return m[idx] / 16.0 - 0.5;
}

void main(){
  vec3 hdr = texture(u_hdr, v_uv).rgb;
  hdr += texture(u_bloom, v_uv).rgb * u_bloomStrength;     // add bloom BEFORE tonemap (rolls off naturally)
  hdr *= u_sceneExposure * u_exposure * u_whiteBalance;    // exposure (single-folded weather) + WB, in linear
  vec3 tm = aces(hdr);                                     // → display-linear
  float l = dot(tm, vec3(0.2126, 0.7152, 0.0722));
  tm = mix(vec3(l), tm, u_saturation);                     // saturation
  tm += u_lift * (1.0 - clamp(l, 0.0, 1.0));               // tint/lift shadows only
  vec3 srgb = toSRGB(clamp(tm, 0.0, 1.0));
  srgb += bayer(gl_FragCoord.xy) / 255.0;                  // ordered dither
  o = vec4(srgb, 1.0);
}`;

// ── Shadow pass (REUSED VERBATIM — refuted alternatives must not be re-rolled) ──────────────
// Map the fullscreen triangle straight onto world coords [0, worldSize]. FBO row 0 = world y 0.
export const SHADOW_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_clip;
uniform float u_worldSize;
out vec2 v_world;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  v_world = (a_clip * 0.5 + 0.5) * u_worldSize;
}`;

// Sun-visibility ray-march: exponential stride spans the whole 2.56 km map for the current key
// azimuth so a 780 m ridge at low sun throws a multi-km shadow (the 480 m fixed march was
// arithmetically REFUTED). One R8 texel = 2.5 m. Rebaked only when the key dir moves.
export const SHADOW_FRAG = /* glsl */ `#version 300 es
precision highp float;
${PRELUDE}
in vec2 v_world;
uniform vec3  u_keyDir;        // normalized sun (or moon) dir; only meaningful when z > 0
uniform float u_worldSize;
out vec4 o;
void main() {
  if (u_keyDir.z <= 0.02) { o = vec4(1.0); return; }   // body at/below horizon: handled by sunUp, leave lit
  float h0     = heightAt(v_world) + 1.5;               // 1.5 m lift kills self-shadow acne on 5 m cells
  vec2  toKey  = normalize(u_keyDir.xy);
  float tanAlt = u_keyDir.z / max(1e-4, length(u_keyDir.xy));
  float occl   = 0.0;
  float d      = u_cell;                                // start one cell out
  for (int i = 0; i < 56; i++) {                        // 5 m·1.13^56 ≈ spans the whole map
    vec2 p = v_world + toKey * d;
    if (p.x < 0.0 || p.y < 0.0 || p.x > u_worldSize || p.y > u_worldSize) break;
    float pen = heightAt(p) - (h0 + tanAlt * d);        // metres the terrain pokes above the ray
    occl = max(occl, pen / d);                          // overshoot tangent → distance-aware softness
    d *= 1.13;                                          // exponential stride: fine near, coarse far
  }
  float lit = 1.0 - smoothstep(0.0, 0.04, occl);        // ~2.3° penumbra — soft, mountain-scale shadows
  o = vec4(lit, lit, lit, 1.0);
}`;
