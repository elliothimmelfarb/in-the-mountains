import { RNG, clamp, clamp01 } from "./rng";
import { Vec2, sub, len, norm, scale, dist } from "./vec";
import { Weapon } from "./weapons";
import { Unit, Wound, unitHeight } from "./entities";
import { LOSResult } from "./los";

export interface Projectile {
  id: string;
  ownerId: string;
  faction: Unit["faction"];
  weaponId: string;
  origin: Vec2;
  pos: Vec2;
  vel: Vec2; // m/s (ground plane)
  speed: number;
  aimpoint: Vec2; // where this round is going
  targetId: string | null;
  traveled: number;
  distToAim: number;
  damage: number;
  damageType: Weapon["damageType"];
  penetration: number;
  blastRadius: number;
  suppressionRadius: number;
  suppression: number;
  indirect: boolean;
  timeToImpact: number; // seconds (indirect) or 0
  arcHeight: number; // peak height for indirect rendering (m)
  alive: boolean;
  age: number;
  tracer: boolean;
  hit: boolean; // resolved hit (for muzzle/impact fx)
  _losAtFire?: LOSResult | null; // LOS snapshot at the moment of firing
}

let _pid = 0;
function projId(): string {
  return `p${(_pid++).toString(36)}`;
}

const MOA_TO_RAD = Math.PI / (180 * 60);

/**
 * Linear dispersion radius (meters) at the target, folding the weapon's mechanical
 * accuracy together with the shooter's marksmanship, stance, suppression, fatigue,
 * movement, range vs effective range, and a deliberate-aim bonus.
 */
export function dispersionSigmaM(
  weapon: Weapon,
  shooter: Unit,
  rangeM: number
): number {
  let moa = weapon.dispersionMOA;
  // Skill: a great shot roughly halves dispersion; a poor one inflates it.
  const skill = clamp01(shooter.marksmanship);
  moa *= 1.6 - skill; // 0.65 .. 1.35
  // Stance
  if (shooter.stance === "prone") moa *= 0.7;
  else if (shooter.stance === "crouch") moa *= 0.85;
  // Suppression wrecks accuracy
  moa *= 1 + shooter.suppression * 2.4;
  // Fatigue
  moa *= 1 + shooter.fatigue * 0.6;
  // Movement
  if (shooter.moving) moa *= 1.8;
  // Composure (fear shakes the hands)
  moa *= 1 + (1 - shooter.composure) * 0.8;
  // Aiming bonus (settled shot)
  moa *= 1 - shooter.aimProgress * 0.35;
  // Beyond effective range accuracy degrades faster
  if (rangeM > weapon.effRange) {
    moa *= 1 + (rangeM - weapon.effRange) / weapon.effRange;
  }
  const sigma = Math.tan(moa * MOA_TO_RAD) * rangeM;
  return Math.max(0.05, sigma);
}

/** Effective silhouette radius (m) a round must land within to strike the target. */
export function silhouetteRadius(target: Unit, exposure: number): number {
  const h = unitHeight(target);
  // Roughly torso half-height + width, scaled by how exposed the target is.
  const base = 0.22 + h * 0.14;
  return base * (0.3 + 0.7 * clamp01(exposure));
}

/**
 * Build a fired round. The aimpoint is the true target center perturbed by a 2D
 * gaussian whose spread is the dispersion sigma; the round then flies to that
 * aimpoint and is resolved against the (possibly moved) target on arrival.
 */
export function spawnProjectile(
  shooter: Unit,
  weapon: Weapon,
  targetPos: Vec2,
  targetId: string | null,
  rangeM: number,
  rng: RNG
): Projectile {
  const sigma = dispersionSigmaM(weapon, shooter, rangeM);
  // 2D gaussian offset
  const ox = rng.gauss(0, sigma);
  const oy = rng.gauss(0, sigma);
  const aimpoint: Vec2 = { x: targetPos.x + ox, y: targetPos.y + oy };

  const dir = norm(sub(aimpoint, shooter.pos));
  const speed = weapon.muzzleVel;
  const distToAim = len(sub(aimpoint, shooter.pos));
  const indirect = !!weapon.indirect && (weapon.cls === "mortar" || rangeM > 60);
  const timeToImpact = indirect
    ? clamp(rangeM / Math.max(60, weapon.muzzleVel) + rangeM / 600, 1.5, 38)
    : 0;

  return {
    id: projId(),
    ownerId: shooter.id,
    faction: shooter.faction,
    weaponId: weapon.id,
    origin: { ...shooter.pos },
    pos: { ...shooter.pos },
    vel: indirect ? { x: 0, y: 0 } : scale(dir, speed),
    speed,
    aimpoint,
    targetId,
    traveled: 0,
    distToAim,
    damage: weapon.damage,
    damageType: weapon.damageType,
    penetration: weapon.penetration,
    blastRadius: weapon.blastRadius ?? 0,
    suppressionRadius: weapon.suppressionRadius,
    suppression: weapon.suppression,
    indirect,
    timeToImpact,
    arcHeight: indirect ? clamp(rangeM * 0.25, 30, 400) : 0,
    alive: true,
    age: 0,
    tracer: weapon.auto ? rng.chance(0.25) : rng.chance(0.12), // every 4th-ish round
    hit: false,
  };
}

export interface HitOutcome {
  hit: boolean;
  region: Wound["region"];
  effectiveDamage: number;
  killed: boolean;
}

const REGIONS: Wound["region"][] = ["leg", "leg", "arm", "arm", "abdomen", "chest", "head"];
const REGION_WEIGHT = [22, 22, 16, 16, 12, 9, 3];

/** Does a direct-fire round that arrived at its aimpoint actually strike the target,
 *  and if so, where and how badly. Cover can stop an otherwise-on-target round. */
export function resolveDirectHit(
  proj: Projectile,
  target: Unit,
  los: LOSResult,
  coverHere: number,
  rng: RNG
): HitOutcome {
  const miss = dist(proj.aimpoint, target.pos);
  const silhouette = silhouetteRadius(target, los.exposure);
  const geometricHit = miss <= silhouette;
  if (!geometricHit) {
    return { hit: false, region: "chest", effectiveDamage: 0, killed: false };
  }
  // Hard cover may still stop the round (penetration vs cover fraction).
  const stop = coverHere * (1 - proj.penetration);
  if (rng.chance(stop)) {
    return { hit: false, region: "chest", effectiveDamage: 0, killed: false };
  }
  const region = rng.weighted(REGIONS, REGION_WEIGHT);
  const outcome = applyDamage(target, proj.damage, proj.damageType, region, rng);
  return { hit: true, ...outcome };
}

/** Whether the unit wears body armor (IOTV/plates + helmet). */
export function hasArmor(u: Unit): boolean {
  return u.faction === "us" || u.faction === "ana";
}

/** Apply a wound to a unit. Returns region, effective damage, and lethality. */
export function applyDamage(
  target: Unit,
  rawDamage: number,
  type: Weapon["damageType"],
  region: Wound["region"],
  rng: RNG
): { region: Wound["region"]; effectiveDamage: number; killed: boolean } {
  let dmg = rawDamage * rng.range(0.7, 1.3);

  // Body armor: plates protect chest/abdomen well vs ball, helmet helps head vs frag.
  if (hasArmor(target)) {
    if (region === "chest" || region === "abdomen") {
      if (type === "ball") dmg *= 0.32; // SAPI plate
      else if (type === "frag") dmg *= 0.22;
      else dmg *= 0.6; // HEAT/blast overmatch
    } else if (region === "head") {
      if (type === "frag" || type === "blast") dmg *= 0.45; // ACH
      else dmg *= 0.9;
    }
  }

  // Region lethality multiplier
  const regionMult =
    region === "head" ? 2.4 : region === "chest" ? 1.6 : region === "abdomen" ? 1.3 : 0.7;
  const effective = dmg * regionMult;

  target.hp -= effective;
  const bleeding = clamp(effective * 0.028 * (region === "leg" || region === "arm" ? 0.7 : 1.2), 0, 4);
  const wound: Wound = {
    region,
    severity: clamp01(effective / 90),
    bleeding,
    treated: false,
    timeM: 0,
  };
  target.wounds.push(wound);
  // total bleed-out rate is capped — buddy aid keeps a casualty alive long enough
  // to matter; a medic or MEDEVAC is what actually saves them.
  target.bleedRate = Math.min(4.5, target.bleedRate + bleeding);
  target.woundedCount++;

  let killed = false;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.conscious = false;
    killed = true;
  } else if (target.hp < 22 || (region === "head" && effective > 30)) {
    // Severe wound — likely unconscious, definitely combat-ineffective.
    if (rng.chance(0.6)) target.conscious = false;
    target.stance = "prone";
  } else if (region === "leg") {
    // Can't move well.
    target.stance = target.stance === "stand" ? "crouch" : target.stance;
  }
  return { region, effectiveDamage: effective, killed };
}

/** Blast damage falloff for indirect/explosive impacts. */
export function blastDamageAt(distM: number, blastRadius: number, baseDamage: number): number {
  if (distM > blastRadius) return 0;
  const f = 1 - distM / blastRadius;
  return baseDamage * (0.35 + 0.65 * f * f);
}
