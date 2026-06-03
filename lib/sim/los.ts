import { Terrain } from "./terrain";
import { Vec2, dist } from "./vec";
import { clamp01 } from "./rng";

export interface SmokeScreen {
  x: number;
  y: number;
  radius: number;
  density: number; // 0..1 opacity at core
}

export interface LOSResult {
  /** Geometric+vegetation visibility: is the target perceivable at all. */
  visible: boolean;
  /** 0..1 fraction of the target that is exposed to the observer (defilade + veg + smoke). */
  exposure: number;
  /** True if a terrain mass fully blocks the line (dead ground / behind a crest). */
  terrainBlocked: boolean;
  /** Accumulated vegetation/smoke concealment along the path (0..1). */
  concealment: number;
  rangeM: number;
}

export interface LOSOptions {
  observerHeight?: number; // eye height above ground (m)
  targetHeight?: number; // target standing height (m)
  smoke?: SmokeScreen[];
  /** Sampling step in meters. Smaller = more accurate, slower. */
  step?: number;
}

const DEG = Math.PI / 180;

/**
 * Terrain + vegetation line of sight with partial defilade.
 *
 * We march the ground profile between observer and target and track the maximum
 * upward angle to any intervening terrain. Comparing that "horizon angle" against
 * the angles to the target's feet and head yields a smooth exposure fraction —
 * so a man behind a ridge with only his head and shoulders showing reads as ~0.3
 * exposed, not a binary visible/hidden. Vegetation and smoke crossed along the
 * way multiply the exposure down (concealment), independent of geometry.
 */
export function lineOfSight(
  terrain: Terrain,
  from: Vec2,
  to: Vec2,
  opts: LOSOptions = {}
): LOSResult {
  const observerHeight = opts.observerHeight ?? 1.6;
  const targetHeight = opts.targetHeight ?? 1.0;
  const step = opts.step ?? terrain.cellSize * 0.6;

  const D = dist(from, to);
  if (D < 1e-3) {
    return { visible: true, exposure: 1, terrainBlocked: false, concealment: 0, rangeM: 0 };
  }

  const eyeZ = terrain.elevAt(from.x, from.y) + observerHeight;
  const baseZ = terrain.elevAt(to.x, to.y);
  const targetBaseZ = baseZ + targetHeight * 0.15; // a touch off the deck (prone/low)
  const targetTopZ = baseZ + targetHeight;

  const angBase = Math.atan2(targetBaseZ - eyeZ, D);
  const angTop = Math.atan2(targetTopZ - eyeZ, D);

  const dx = (to.x - from.x) / D;
  const dy = (to.y - from.y) / D;

  let maxHorizon = -Infinity;
  let veg = 0;
  let smokeAcc = 0;

  // March intermediate ground (exclude the immediate endpoints).
  const start = step;
  const end = D - step * 0.5;
  for (let s = start; s < end; s += step) {
    const px = from.x + dx * s;
    const py = from.y + dy * s;
    const gz = terrain.elevAt(px, py);
    const horiz = Math.atan2(gz - eyeZ, s);
    if (horiz > maxHorizon) maxHorizon = horiz;

    // Vegetation/canopy concealment accumulates with path length through cover.
    const conceal = terrain.concealAt(px, py);
    if (conceal > 0) veg += conceal * (step / 25);

    if (opts.smoke) {
      for (const sm of opts.smoke) {
        const ddx = px - sm.x;
        const ddy = py - sm.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < sm.radius * sm.radius) {
          const f = 1 - Math.sqrt(d2) / sm.radius;
          smokeAcc += sm.density * f * (step / 18);
        }
      }
    }
  }

  // Terrain exposure: how much of the target's height pokes above the horizon line.
  let terrainExposure: number;
  let terrainBlocked = false;
  if (maxHorizon === -Infinity) {
    terrainExposure = 1;
  } else if (maxHorizon <= angBase + 0.0005) {
    terrainExposure = 1; // nothing intervenes up to the feet
  } else if (maxHorizon >= angTop) {
    terrainExposure = 0;
    terrainBlocked = true;
  } else {
    terrainExposure = clamp01((angTop - maxHorizon) / Math.max(1e-4, angTop - angBase));
  }

  const concealment = clamp01(1 - Math.exp(-(veg + smokeAcc)));
  const exposure = clamp01(terrainExposure * (1 - concealment));
  return {
    visible: exposure > 0.04 && !terrainBlocked,
    exposure,
    terrainBlocked,
    concealment,
    rangeM: D,
  };
}

/** Cheap boolean: does the observer have any usable LOS to the target. */
export function hasLOS(terrain: Terrain, from: Vec2, to: Vec2, opts?: LOSOptions): boolean {
  return lineOfSight(terrain, from, to, opts).visible;
}

/**
 * Probability that an observer *detects* a target this moment, folding in range,
 * exposure, target movement & stance, light level, and observer optics/NVGs.
 * Used by combat for acquisition (distinct from whether a bullet can connect).
 */
export function detectionChance(params: {
  los: LOSResult;
  light: number; // 0 (pitch dark) .. 1 (full day)
  observerNVG: boolean;
  targetMoving: boolean;
  targetFiring: boolean; // muzzle flash/dust gives you away
  targetProne: boolean;
  observerOpticRangeM: number; // effective spotting range of optics
  alertness: number; // 0..1 observer alertness
}): number {
  const { los } = params;
  if (!los.visible) return 0;
  // Base falls off with range relative to optic range.
  const rangeFactor = clamp01(1 - los.rangeM / Math.max(50, params.observerOpticRangeM));
  let p = 0.9 * rangeFactor * (0.3 + 0.7 * los.exposure);

  // Light: NVGs recover most of the night penalty but not all.
  let lightF = params.light;
  if (params.observerNVG) lightF = Math.max(lightF, 0.62 - los.rangeM / 4000);
  p *= 0.25 + 0.75 * clamp01(lightF);

  if (params.targetMoving) p *= 1.45;
  if (params.targetFiring) p *= 2.2; // hard to hide a muzzle flash
  if (params.targetProne) p *= 0.6;
  p *= 0.55 + 0.45 * params.alertness;
  return clamp01(p);
}
