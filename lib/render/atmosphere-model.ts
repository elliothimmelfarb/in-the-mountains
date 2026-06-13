// Pure atmosphere model for the WebGL terrain: cloud-shadow drift + terrain-aware valley fog.
// Mirrors sky.ts — a deterministic function of (secondsOfDay, weather, sky) plus a cloud
// drift offset that the caller INTEGRATES from the sim clock (so cloud shadows advect with
// the wind, freeze on pause, and survive a weather re-roll without teleporting). No wall
// clock, no randomness. The same fog math is exposed as fogVisAt() so 2D sprites fade in
// step with the GL fog (parity), not float over it.

import { clamp01 } from "../sim/rng";
import type { Weather } from "../sim/campaign";
import type { SkyState, Vec3 } from "./sky";

export interface AtmoState {
  cloudOffset: [number, number]; // world-meter scroll of the cloud field (integrated by caller)
  cloudScale: number; // 1/metres — cloud cell size on the ground
  cloudDensity: number; // 0..1 coverage of cloud shadow (per weather)
  cloudStrength: number; // 0..1 how much a cloud shadow darkens the sunlit ground
  fogThickness: number; // metres of fog above the LOCAL valley floor (dawn-heavy, burns off)
  fogFade: number; // metres over which fog density falls to 0 at its top
  fogStrength: number; // 0..1 max opacity
  fogColor: Vec3; // graded fog/haze colour (cool, from the sky)
  hazeStrength: number; // 0..1 aerial-perspective veil, keyed to the sacred visibilityM
  hazeColor: Vec3; // aerial-perspective in-scatter colour (cool, sky-derived)
  wetness: number; // 0..1 wet-ground darkening + low-sun sheen (after rain; pure fn of weather)
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// per-weather cloud coverage + the ground-fog boost (Fog label socks the whole valley in)
const WX_ATMO: Record<string, { cloudDensity: number; cloudStrength: number; fogBoost: number; fogStrengthMax: number; wetness: number }> = {
  Clear: { cloudDensity: 0.18, cloudStrength: 0.45, fogBoost: 0, fogStrengthMax: 0.55, wetness: 0 },
  Hazy: { cloudDensity: 0.32, cloudStrength: 0.4, fogBoost: 30, fogStrengthMax: 0.6, wetness: 0 },
  Overcast: { cloudDensity: 0.6, cloudStrength: 0.3, fogBoost: 50, fogStrengthMax: 0.6, wetness: 0.12 },
  Rain: { cloudDensity: 0.72, cloudStrength: 0.35, fogBoost: 70, fogStrengthMax: 0.65, wetness: 0.85 },
  Fog: { cloudDensity: 0.2, cloudStrength: 0.2, fogBoost: 260, fogStrengthMax: 0.92, wetness: 0.18 },
  Snow: { cloudDensity: 0.5, cloudStrength: 0.3, fogBoost: 90, fogStrengthMax: 0.7, wetness: 0.25 },
};

/** Diurnal ground-fog thickness (metres above the local valley floor): heavy before dawn,
 *  burns off through the morning, gone midday, a little returns at dusk and overnight. The
 *  documented Korengal morning — the river draw full of fog until the sun reaches it. */
function diurnalFog(hour: number): number {
  if (hour < 4) return 110; // pre-dawn pooling
  if (hour < 7) return lerp(110, 140, (hour - 4) / 3); // densest right at first light
  if (hour < 10) return lerp(140, 0, (hour - 7) / 3); // burns off through mid-morning
  if (hour < 16) return 0; // clear day
  if (hour < 19) return lerp(0, 70, (hour - 16) / 3); // evening cool settles back in
  return lerp(70, 110, clamp01((hour - 19) / 3)); // overnight
}

/** PURE. The cloud offset is passed IN (the caller integrates it from the sim clock). */
export function atmoState(secondsOfDay: number, weather: Weather, sky: SkyState, cloudOffset: [number, number]): AtmoState {
  const hour = secondsOfDay / 3600;
  const wx = WX_ATMO[weather.label] ?? WX_ATMO.Clear;
  const fogThickness = diurnalFog(hour) + wx.fogBoost;
  // fog colour: a cool, slightly-lifted version of the sky zenith, so it grades with the day
  const fogColor: Vec3 = [
    sky.skyColor[0] * 0.55 + 0.34,
    sky.skyColor[1] * 0.55 + 0.36,
    sky.skyColor[2] * 0.55 + 0.34,
  ];
  // aerial perspective: extinction keyed to the SACRED visibilityM (600 m → strong, 4000 m → faint),
  // so the veil can never exceed what the weather declares. Sober: clear days stay nearly clean.
  const visN = clamp01((weather.visibilityM - 600) / 3400);
  const hazeStrength = lerp(0.34, 0.05, visN);
  const hazeColor: Vec3 = [
    sky.skyColor[0] * 0.5 + 0.42,
    sky.skyColor[1] * 0.5 + 0.43,
    sky.skyColor[2] * 0.5 + 0.44,
  ];
  return {
    cloudOffset,
    cloudScale: 1 / 760, // cloud cells ~760 m across the ground — reads at strategic AND tactical
    cloudDensity: wx.cloudDensity,
    cloudStrength: wx.cloudStrength,
    fogThickness,
    fogFade: 55,
    fogStrength: wx.fogStrengthMax,
    fogColor,
    hazeStrength,
    hazeColor,
    wetness: wx.wetness,
  };
}

/** Advance the integrated cloud offset by one frame. dClock = Δ(world.state.clock) in seconds
 *  (0 when paused — clouds freeze; clamped so a clock jump can't teleport the field). Wind in
 *  m/s. Caller keeps the running offset keyed to World identity and re-seeds on load/jump. */
export function advanceCloud(offset: [number, number], windX: number, windY: number, dClock: number): [number, number] {
  const dt = Math.max(0, Math.min(dClock, 120)); // clamp huge/again-monotonic jumps
  const k = 0.12; // clouds drift slower than the surface wind
  return [offset[0] + windX * dt * k, offset[1] + windY * dt * k];
}

/** 2D-coherence fog factor (0 = clear, 1 = fully fogged) at a world point of the given
 *  elevation, with `localFloor` the local valley-floor elevation there (the same min-field the
 *  GL shader samples). Mirrors the shader fog so decoration/village sprite alpha fades in step
 *  with the terrain fog instead of poking through it. */
export function fogVisAt(elev: number, localFloor: number, a: AtmoState): number {
  if (a.fogThickness <= 0.5 || a.fogStrength <= 0.01) return 0;
  const top = localFloor + a.fogThickness;
  return clamp01((top - elev) / a.fogFade) * a.fogStrength;
}
