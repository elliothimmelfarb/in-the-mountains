// THE single source of sun/moon/light/grade truth for the render layer. Every system that
// needs to know where the light comes from — the GL terrain shader, the cast-shadow pass,
// sprite shadows, the 2D screen grade — reads ONE SkyState computed here, so the sun can
// never fork across canvases (three independent sun models was the design fan-out's worst
// near-miss; see docs/progress/2026-06-12-webgl-terrain/DESIGN.md).
//
// Geometry: standard solar position at lat 34.8°N (Kunar), declination FIXED at +21.0°
// (mid-July — the Korengal fighting season). δ=21° is the one declination whose geometric
// sunrise/sunset (04:58 / 19:02) land inside the UNTOUCHED gameplay solarLight() ramps
// (05:00-07:00 dawn, 17:00-19:30 dusk, world.ts:122-129), so the visual sun is below the
// horizon exactly when gameplay light sits at the starlight floor. The game clock is local
// apparent solar time — the clock IS the sun.
//
// Sacredness contract: solarLight()/ambientLight()/isNight() are NEVER duplicated here.
// The caller passes solarLight() in; nightFactor ≡ 1 − clamp01(solar × weatherLightMult)
// is bit-identical to the `1 − ambientLight()` every existing night consumer already reads.
// Verified by scripts/scratch-sun-probe.ts (sun-below-horizon ⟺ starlight, identity across
// 24 h × 6 weathers).
//
// Pure + deterministic: functions of (secondsOfDay, weather, solar) only. No wall clock,
// no randomness, no World access — the layer line stays intact.

import { clamp01 } from "../sim/rng";
import { weatherLightMult, type Weather } from "../sim/campaign";
import type { Camera } from "./topo";

const DEG = Math.PI / 180;
const LAT = 34.8 * DEG; // Kunar
const DECL = 21.0 * DEG; // fixed mid-July (fighting season)
const MOON_DECL = -18.0 * DEG; // anti-solar gibbous: low southern arc, up all night
const MOON_ILLUM = 0.65;

const sinPhi = Math.sin(LAT);
const cosPhi = Math.cos(LAT);

// Exported for docs/probes (computed from δ=21°, φ=34.8°: cosH₀ = −tanφ·tanδ).
export const SUNRISE_H = 4.968;
export const SUNSET_H = 19.032;
export const CIVIL_DUSK_H = 19.585;

export type Vec3 = [number, number, number];

/** Unit vector surface→body for a body at declination `decl` and hour angle `H`.
 *  WORLD frame: +x east, +y SOUTH (y=0 is the north valley mouth; worldToScreen maps +y
 *  down-screen), +z up — so the standard ENU north component is NEGATED. Getting this sign
 *  wrong puts the noon sun in the north sky; the anchors are checked by the probe:
 *  noon toSun = (0, +0.239, +0.971) = due SOUTH, morning sun EAST lighting the west wall. */
function bodyDirWorld(secondsOfDay: number, decl: number, hourOffset: number): Vec3 {
  const H = ((secondsOfDay / 3600 - 12) * 15 + hourOffset) * DEG;
  const sinDec = Math.sin(decl);
  const cosDec = Math.cos(decl);
  const cosH = Math.cos(H);
  const alt = sinPhi * sinDec + cosPhi * cosDec * cosH; // = z (sin of altitude)
  const east = -cosDec * Math.sin(H);
  const north = cosPhi * sinDec - sinPhi * cosDec * cosH;
  return [east, -north, alt];
}

/** Unit vector surface→sun, world frame (+x E, +y S, +z up). Same toward-the-light
 *  convention as the old bake key (−0.55, −0.62, 0.56) = "toward the NW sky". */
export function sunDirWorld(secondsOfDay: number): Vec3 {
  return bodyDirWorld(secondsOfDay, DECL, 0);
}

/** The moon: fixed anti-solar gibbous (hour angle = sun's − 180°, δ = −18°). Rises ~19:00,
 *  transits 37° due south at midnight, sets ~05:00 — the whole night is moonlit with long
 *  raking southern shadows. Phase realism buys nothing the sim reads and costs a moonless-
 *  night legibility floor; a fixed bright moon is the deliberate trade (DESIGN.md). */
export function moonDirWorld(secondsOfDay: number): Vec3 {
  return bodyDirWorld(secondsOfDay, MOON_DECL, 180);
}

// ---- altitude-keyed keyframe tables (piecewise smoothstep on sun altitude in DEGREES) ----
// Restraint contract: light/grade tints stay inside the ART_BIBLE ±10% hue-push line; the
// dust palette warms and cools, it never goes Instagram.

interface LightKey {
  alt: number;
  sunColor: Vec3;
  sunI: number; // direct beam intensity (Clear)
  skyColor: Vec3; // hemisphere zenith
  groundColor: Vec3; // dust bounce
  skyI: number;
}

const LIGHT_KEYS: LightKey[] = [
  { alt: 90, sunColor: [1.0, 0.98, 0.92], sunI: 1.15, skyColor: [0.42, 0.53, 0.68], groundColor: [0.45, 0.38, 0.28], skyI: 0.42 },
  { alt: 25, sunColor: [1.0, 0.95, 0.86], sunI: 1.05, skyColor: [0.44, 0.54, 0.66], groundColor: [0.45, 0.38, 0.28], skyI: 0.38 },
  { alt: 10, sunColor: [1.0, 0.84, 0.62], sunI: 0.9, skyColor: [0.47, 0.52, 0.62], groundColor: [0.42, 0.34, 0.24], skyI: 0.33 },
  { alt: 4, sunColor: [1.0, 0.72, 0.42], sunI: 0.75, skyColor: [0.5, 0.5, 0.58], groundColor: [0.4, 0.3, 0.2], skyI: 0.3 },
  { alt: 0, sunColor: [1.0, 0.58, 0.32], sunI: 0.5, skyColor: [0.46, 0.48, 0.6], groundColor: [0.34, 0.26, 0.18], skyI: 0.24 },
  { alt: -2, sunColor: [1.0, 0.58, 0.32], sunI: 0, skyColor: [0.42, 0.48, 0.66], groundColor: [0.26, 0.24, 0.22], skyI: 0.22 },
  { alt: -6, sunColor: [1.0, 0.58, 0.32], sunI: 0, skyColor: [0.34, 0.42, 0.62], groundColor: [0.2, 0.2, 0.22], skyI: 0.17 },
  { alt: -12, sunColor: [1.0, 0.58, 0.32], sunI: 0, skyColor: [0.3, 0.38, 0.55], groundColor: [0.16, 0.17, 0.22], skyI: 0.14 },
];

export interface SpriteTint {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface GradeKey {
  alt: number;
  exposure: number;
  whiteBalance: Vec3;
  saturation: number;
  lift: Vec3;
  spriteTint: SpriteTint;
}

// exposure stays near 1: the day→night darkness is carried by the LIGHTING (sun gone, only
// moon + sky-ambient at night), NOT by exposure — collapsing both is the double-darkening trap.
// The grade's real job is colour: warm WB at golden hour, cool scotopic WB + desaturation at
// night, shadow lift. (nightFactor — the SACRED 2D value — is separate and untouched.)
const GRADE_KEYS: GradeKey[] = [
  { alt: 30, exposure: 1.0, whiteBalance: [1, 1, 1], saturation: 1.0, lift: [0, 0, 0], spriteTint: { r: 0, g: 0, b: 0, a: 0 } },
  { alt: 10, exposure: 0.99, whiteBalance: [1.04, 0.99, 0.93], saturation: 1.03, lift: [0, 0, 0], spriteTint: { r: 255, g: 196, b: 140, a: 0.05 } },
  { alt: 4, exposure: 0.96, whiteBalance: [1.1, 0.92, 0.78], saturation: 1.08, lift: [0.02, 0.01, 0.0], spriteTint: { r: 255, g: 176, b: 112, a: 0.14 } },
  { alt: -4, exposure: 0.9, whiteBalance: [0.86, 0.92, 1.12], saturation: 0.72, lift: [0.01, 0.02, 0.05], spriteTint: { r: 60, g: 78, b: 124, a: 0.3 } },
  { alt: -10, exposure: 0.86, whiteBalance: [0.74, 0.84, 1.16], saturation: 0.4, lift: [0.012, 0.022, 0.06], spriteTint: { r: 18, g: 26, b: 52, a: 0.46 } },
];

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Find the smoothstepped blend between the two table keys bracketing `alt` (keys sorted
 *  by alt DESCENDING; clamps beyond the ends). Returns [lower-index key, next key, t]. */
function keyBlend<K extends { alt: number }>(keys: K[], altDeg: number): [K, K, number] {
  if (altDeg >= keys[0].alt) return [keys[0], keys[0], 0];
  for (let i = 1; i < keys.length; i++) {
    if (altDeg >= keys[i].alt) {
      const hi = keys[i - 1];
      const lo = keys[i];
      return [lo, hi, smooth((altDeg - lo.alt) / (hi.alt - lo.alt))];
    }
  }
  const last = keys[keys.length - 1];
  return [last, last, 0];
}

// ---- weather folding: each gameplay multiplier maps to a beam redistribution ----
// directMult kills the BEAM (and with it cast shadows); exposure carries the gameplay
// total via weatherLightMult exactly ONCE (the single-fold rule — the atmosphere axis's
// veil/haze are chroma shifts, never a second luminance fold).
const WX: Record<string, { direct: number }> = {
  Clear: { direct: 1.0 },
  Hazy: { direct: 0.8 },
  Overcast: { direct: 0.15 },
  Rain: { direct: 0.08 },
  Fog: { direct: 0.05 },
  Snow: { direct: 0.2 },
};

export interface SkyState {
  sunDir: Vec3; // unit, world frame, surface→sun
  sunAltDeg: number; // signed degrees
  sunColor: Vec3;
  sunIntensity: number; // after the weather direct-kill; 0 ⇒ no beam, no cast shadows
  skyColor: Vec3; // hemisphere zenith
  groundColor: Vec3; // hemisphere dust bounce
  skyIntensity: number;
  moonDir: Vec3;
  moonColor: Vec3;
  moonFactor: number; // intensity after altitude/illumination/weather
  keyDir: Vec3; // shadow-map key body: sun while it outshines the moon, else moon
  keyIsSun: boolean;
  shadowStrength: number; // 0..1 — how dark cast shadow may push terrain (weather-faded)
  nightFactor: number; // ≡ 1 − clamp01(solar × weatherLightMult) — today's `night`, exactly
  grade: {
    exposure: number;
    whiteBalance: Vec3;
    saturation: number;
    lift: Vec3;
    spriteTint: SpriteTint;
  };
  /** Sun-tracking sprite shadows: screen/world direction (unit, world +y = screen-down so
   *  NO flip needed), length in meters per meter of object height, and alpha. */
  spriteShadow: { dx: number; dy: number; lengthPerM: number; alpha: number };
}

const MOON_COLOR: Vec3 = [0.7, 0.78, 0.95];

/** PURE. (secondsOfDay, weather, solar) → SkyState. `solar` = world.solarLight(), passed in
 *  so the sacred gameplay curve is never duplicated in the render layer. */
export function skyState(secondsOfDay: number, weather: Weather, solar: number): SkyState {
  const sunDir = sunDirWorld(secondsOfDay);
  const sunAltDeg = Math.asin(sunDir[2]) / DEG;
  const wx = WX[weather.label] ?? WX.Clear;
  const wlm = weatherLightMult(weather);

  const [lo, hi, t] = keyBlend(LIGHT_KEYS, sunAltDeg);
  const sunColor = lerp3(lo.sunColor, hi.sunColor, t);
  const sunIntensity = lerp(lo.sunI, hi.sunI, t) * wx.direct;
  const skyColor = lerp3(lo.skyColor, hi.skyColor, t);
  const groundColor = lerp3(lo.groundColor, hi.groundColor, t);
  // overcast = flatter but relatively softer/brighter hemisphere vs the killed beam
  const skyIntensity = lerp(lo.skyI, hi.skyI, t) * lerp(1.25, 1.0, wx.direct);

  const moonDir = moonDirWorld(secondsOfDay);
  const moonAltDeg = (Math.asin(moonDir[2]) / Math.PI) * 180;
  const moonFactor = 0.22 * MOON_ILLUM * clamp01(moonAltDeg / 12) * wx.direct;

  const keyIsSun = sunIntensity >= moonFactor;
  const keyDir = keyIsSun ? sunDir : moonDir;

  // base shadow depth: raking golden-hour shadows read darkest; the moon a touch softer.
  // Legibility floor: shadowed terrain always keeps full hemisphere ambient (the shader
  // adds ambient OUTSIDE the shadow term), so day shade never drops below ~0.45× lit luma.
  const baseShadow = keyIsSun ? lerp(0.65, 0.55, clamp01((sunAltDeg - 10) / 20)) : 0.5;
  const shadowStrength = baseShadow * wx.direct;

  const nightFactor = 1 - clamp01(solar * wlm);

  const [glo, ghi, gt] = keyBlend(GRADE_KEYS, sunAltDeg);
  const tintLo = glo.spriteTint;
  const tintHi = ghi.spriteTint;
  const grade = {
    exposure: lerp(glo.exposure, ghi.exposure, gt) * wlm,
    whiteBalance: lerp3(glo.whiteBalance, ghi.whiteBalance, gt),
    saturation: lerp(glo.saturation, ghi.saturation, gt),
    lift: lerp3(glo.lift, ghi.lift, gt),
    spriteTint: {
      r: Math.round(lerp(tintLo.r, tintHi.r, gt)),
      g: Math.round(lerp(tintLo.g, tintHi.g, gt)),
      b: Math.round(lerp(tintLo.b, tintHi.b, gt)),
      // hard cap 0.5: faction accents must survive deepest night — the GL terrain carries
      // the darkness in-shader, the sprites only take a tint (legibility > realism).
      a: Math.min(0.5, lerp(tintLo.a, tintHi.a, gt)),
    },
  };

  const keyAltDeg = keyIsSun ? sunAltDeg : moonAltDeg;
  const kxy = Math.hypot(keyDir[0], keyDir[1]) || 1;
  const spriteShadow = {
    dx: -keyDir[0] / kxy,
    dy: -keyDir[1] / kxy,
    lengthPerM: Math.min(4.0, Math.max(0.3, 1 / Math.tan(Math.max(keyAltDeg, 8) * DEG))),
    alpha: 0.34 * Math.max(sunIntensity, moonFactor) * shadowStrength,
  };

  return {
    sunDir,
    sunAltDeg,
    sunColor,
    sunIntensity,
    skyColor,
    groundColor,
    skyIntensity,
    moonDir,
    moonColor: MOON_COLOR,
    moonFactor,
    keyDir,
    keyIsSun,
    shadowStrength,
    nightFactor,
    grade,
    spriteShadow,
  };
}

/** Grade the 2D world layer: lerps every ALREADY-DRAWN pixel toward the tint without
 *  touching alpha — transparent areas stay transparent, so the GL terrain showing through
 *  is never veiled (it grades itself in-shader from the same table). `source-atop` is the
 *  one canvas op with that property: multiply/soft-light composite source-over and would
 *  paint a flat wash across the see-through regions (the exact bug this rebuild deletes).
 *  Cost: one composite fillRect; skipped entirely in clear midday (a≈0). */
export function drawScreenGrade(ctx: CanvasRenderingContext2D, cam: Camera, t: SpriteTint) {
  if (t.a < 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = `rgba(${t.r},${t.g},${t.b},${t.a})`;
  ctx.fillRect(0, 0, cam.vw, cam.vh);
  ctx.restore();
}
