// GLSL source for the WebGL2 terrain underlayer.
//
// The vertex shader is the real, final camera transform (the inverse of worldToScreen,
// topo.ts:12) — a fullscreen triangle whose interpolated v_world is the world-meter position
// under each fragment. The lit fragment computes relief shading from the heightmap at SCREEN
// resolution (sharper than the old upscaled bitmap), lit by the live clock sun, with cast
// ridge shadows sampled from a rebaked sun-visibility map. The shadow program ray-marches
// that visibility map into an FBO only when the sun moves (see terrain-gl.ts).

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
  // Subtracting shake reproduces the 2D ctx.setTransform pixel offset (WorldView:199-201).
  vec2 fromCenter = vec2(a_clip.x, -a_clip.y) * u_viewCss * 0.5 - u_shakePx;
  v_world = u_camCenter + fromCenter / u_ppm;
}`;

// Shared GLSL: bit-faithful heightAt (= Terrain.elevAt, terrain.ts:3137), per-fragment normals
// (the bake's forward difference, topo.ts:157-165, evaluated at screen res), and value-noise
// fbm for the close-zoom ground tooth. Prepended to every fragment program that touches terrain.
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
vec3 normalAt(vec2 w) {       // forward difference at one-cell spacing (matches topo.ts:159-160)
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
`;

// Lit terrain fragment. Reproduces the old bake's scalar relief structure (so forcing the NW
// key over noon matches HEAD — the C3 calibration gate) but driven by the LIVE sun, tinted by
// the sun color, and gated by the cast-shadow visibility map. Ambient carries MORE when the
// sun is down (night-before-wash stays a legible flat relief; the 2D wash still darkens it in
// C3 — night relight + grade arrive in C4).
export const TERRAIN_FRAG_LIT = /* glsl */ `#version 300 es
precision highp float;
${PRELUDE}
in vec2 v_world;
uniform sampler2D u_albedo;     // UNLIT albedo (bakeAlbedo)
uniform sampler2D u_shadow;     // sun-visibility map (1 = lit), rebaked on sun motion
uniform float u_worldSize;      // 2560.0
uniform float u_minElev;
uniform float u_elevRange;
uniform vec3  u_bgColor;
uniform float u_ppm;
// sky/sun (from lib/render/sky.ts SkyState)
uniform vec3  u_sunDir;         // unit, world frame (+x E, +y S, +z up)
uniform vec3  u_sunColor;
uniform float u_sunI;
uniform vec3  u_moonDir;        // unit, world frame
uniform vec3  u_moonColor;
uniform float u_moonFactor;     // night key intensity (0 by day / overcast)
uniform vec3  u_skyColor;
uniform vec3  u_groundColor;
uniform float u_skyI;
uniform float u_keyGain;        // calibration to the old bake's key*1.05
uniform float u_formLightNW;    // 0..1 relief-inversion guard: blend a fixed NW key into the diffuse
// time-of-day grade (lib/render/sky.ts SkyState.grade). Exposure stays near 1 — the day→night
// darkness is carried by the LIGHTING above, not by exposure (no double-darkening).
uniform float u_exposure;
uniform vec3  u_whiteBalance;
uniform float u_saturation;
uniform vec3  u_lift;
// atmosphere defaults (reproduce topo.ts:304-314; the atmosphere axis drives these live in C5)
uniform float u_warmLow;        // 0.08
uniform float u_coolHigh;       // 0.13
uniform float u_hazeBase;       // 0.10
uniform float u_hazeFalloff;    // 0.16
uniform vec3  u_hazeColor;      // (164,170,166)/255
// atmosphere (lib/render/atmosphere-model.ts): drifting cloud shadows + terrain-aware valley fog.
// Clouds are procedural fbm of the wind-drifted world position (the prelude's fbm2) — no texture.
uniform vec2  u_cloudOffset;    // integrated wind drift (world m)
uniform float u_cloudScale;     // 1/m
uniform float u_cloudDensity;   // 0..1 coverage
uniform float u_cloudStrength;  // 0..1 beam dimming
uniform sampler2D u_localFloor; // 128² R32F: local valley-floor elevation (fog pools from here)
uniform float u_fogThickness;   // m above the local floor
uniform float u_fogFade;        // m
uniform float u_fogStrength;    // 0..1
uniform vec3  u_fogColor;
out vec4 o;

const vec3 NW_KEY = vec3(-0.6726, -0.7583, 0.6850);  // normalize(-0.55,-0.62,0.56) — the old bake key

// time-of-day grade: exposure + white-balance gain, then saturation, then a shadow-only lift.
vec3 grade(vec3 c) {
  c *= u_exposure * u_whiteBalance;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_saturation);
  c += u_lift * (1.0 - clamp(l, 0.0, 1.0));   // lift/tint shadows only; highlights untouched
  return c;
}

void main() {
  vec2 uv = v_world / u_worldSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(u_bgColor, 1.0); return; }

  vec3  n      = normalAt(v_world);
  vec3  albedo = texture(u_albedo, uv).rgb;
  float vis    = texture(u_shadow, uv).r;                 // cast-shadow visibility (1 lit)
  float sunUp  = smoothstep(0.0, 0.07, u_sunDir.z);       // fade direct light through ~0-4° altitude

  // key diffuse: live sun, with a fraction of the fixed NW key blended in so a high noon sun
  // (due south on a north-up map → flat, shadowless relief) still rakes the slopes (legibility).
  float keySun = max(0.0, dot(n, u_sunDir));
  float keyNW  = max(0.0, dot(n, NW_KEY));
  float key    = mix(keySun, max(keySun, keyNW), u_formLightNW);
  // anti-solar bounce fill (the bake's SE fill role, now sun-relative) keeps shadowed faces in form
  vec3  fillDir = normalize(vec3(-u_sunDir.x, -u_sunDir.y, 0.35));
  float fill    = max(0.0, dot(n, fillDir)) * 0.34;
  float sky     = 0.5 + 0.5 * n.z;                        // hemisphere visibility ~ cheap AO (topo.ts:171)

  // moon as a second key at night — same cast-shadow vis, raking the relief so night has FORM
  float moonUp     = smoothstep(0.0, 0.04, u_moonDir.z);
  float keyMoon    = max(0.0, dot(n, u_moonDir));
  float moonDirect = keyMoon * vis * moonUp * u_moonFactor;

  // drifting cloud shadows: dim the SUN beam where a cloud passes over (reads like aerial
  // footage). Procedural fbm of the wind-drifted world position; coverage/contrast per weather.
  float cl = fbm2((v_world + u_cloudOffset) * u_cloudScale);
  float cloudShadow = smoothstep(0.58 - u_cloudDensity * 0.45, 0.82, cl) * u_cloudStrength;
  float cloudVis = 1.0 - cloudShadow;

  float shade = key * vis * cloudVis * sunUp * u_keyGain * 1.05  // direct sun (shadowed + clouded)
              + moonDirect * 4.0                          // direct moon (night relief)
              + fill * sunUp
              + sky * mix(0.45, 0.24, sunUp) * u_skyI / 0.33 * (1.0 - cloudShadow * 0.25);  // ambient mottle
  shade = clamp(shade * 0.94 + 0.02, 0.0, 1.0);

  vec3 col = albedo * (0.34 + 0.95 * shade);
  // tint the sunlit contribution toward the sun color (warm dawn/dusk; neutral noon)
  col *= mix(vec3(1.0), u_sunColor, 0.55 * sunUp * key * vis);
  // tint the moonlit contribution cool
  col *= mix(vec3(1.0), u_moonColor, 0.6 * moonDirect * 4.0);
  // and tint the ambient-dominated (shadowed/night) regions toward the cool sky
  col *= mix(vec3(1.0), mix(u_groundColor, u_skyColor, sky) * 2.2, (1.0 - sunUp) * 0.4);

  // altitude grade: low ground warm, high ground cool & clear (topo.ts:304-305 defaults)
  float altN = clamp((heightAt(v_world) - u_minElev) / u_elevRange, 0.0, 1.0);
  col *= vec3(1.0 - altN * u_warmLow, 1.0, 1.0 + altN * u_coolHigh);
  // light valley haze (topo.ts:311-314 defaults)
  float haze = clamp(u_hazeBase - altN * u_hazeFalloff, 0.0, 1.0);
  col = mix(col, u_hazeColor, haze);

  // close-zoom ground tooth — world-anchored grain that sharpens with zoom (replaces the 2D
  // noiseTile overlay the GL path dropped; never shimmers because it's a spatial hash).
  float detailA = clamp((u_ppm - 0.6) / 2.0, 0.0, 1.0) * 0.5;
  if (detailA > 0.01) {
    float grain = fbm2(v_world * 2.5) * 0.6 + vnoise(v_world * 0.9) * 0.4;
    col *= 1.0 + (grain - 0.5) * 0.6 * detailA;
  }

  // terrain-aware valley fog: pools from the LOCAL valley floor (min-field) up to a diurnal
  // ceiling — thick in the river draw at dawn, burning off by mid-morning, the whole valley
  // socked in under Fog weather. Mixed before the grade so it carries the time-of-day colour.
  if (u_fogStrength > 0.01 && u_fogThickness > 0.5) {
    float lf = texture(u_localFloor, uv).r;
    float fog = clamp((lf + u_fogThickness - heightAt(v_world)) / u_fogFade, 0.0, 1.0) * u_fogStrength;
    col = mix(col, u_fogColor, fog);
  }

  o = vec4(grade(col), 1.0);
}`;

// Shadow-bake vertex: map the fullscreen triangle straight onto world coords [0, worldSize].
// FBO memory row 0 = render bottom = NDC y −1 = world y 0 (north), so sampling the result with
// uv = v_world/worldSize matches the albedo orientation exactly (both: v=0 ↔ north).
export const SHADOW_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_clip;
uniform float u_worldSize;
out vec2 v_world;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  v_world = (a_clip * 0.5 + 0.5) * u_worldSize;
}`;

// Sun-visibility ray-march (P1 §5). Exponential stride spans the whole 2.56 km map for the
// current sun azimuth so a 780 m ridge at low sun throws a multi-km shadow correctly (P2's
// fixed 480 m march was refuted). One R8 texel = 2.5 m. Rebaked only when the sun moves.
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
