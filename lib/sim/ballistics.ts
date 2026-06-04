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
  // Acute shock — a buddy just went down beside you; the hands shake for a few seconds.
  if (shooter.shaken && shooter.shaken > 0) moa *= 1.4;
  // Aiming bonus (settled shot)
  moa *= 1 - shooter.aimProgress * 0.35;
  // Beyond effective range accuracy degrades faster
  if (rangeM > weapon.effRange) {
    moa *= 1 + (rangeM - weapon.effRange) / weapon.effRange;
  }
  const sigma = Math.tan(moa * MOA_TO_RAD) * rangeM;
  return Math.max(0.05, sigma);
}

/**
 * Range-dependent terminal energy. A bullet's wounding power falls with range as
 * its velocity bleeds off — and for 5.56 it falls off a cliff once it drops below
 * the ~2500 fps that drives fragmentation/yaw (roughly 150–200 m from an M4's
 * barrel), which is the literal reason the Korengal fight demanded 7.62, .50 and
 * CAS at the 300–800 m ranges the valley imposed. Modeled as a per-kinetic-class
 * lethality curve; non-kinetic rounds (frag/HEAT/blast) are unaffected (their
 * falloff is spatial — see blastDamageAt).
 */
type KineticClass = "intermediate556" | "intermediate762" | "fullpower" | "heavy" | "pistol";

const LETHALITY_CURVE: Record<KineticClass, [number, number][]> = {
  // 5.56×45: sharp knee — fragmentation/yaw needs ~2500 fps, gone by ~150–200 m;
  // past that it still pokes .22-cal holes, so the tail isn't zero.
  intermediate556: [[0, 1], [100, 1], [200, 0.88], [300, 0.73], [400, 0.62], [500, 0.52], [700, 0.42], [1000, 0.36]],
  // 7.62×39: heavier/slower, no fragmentation reliance, but low BC bleeds it at distance.
  intermediate762: [[0, 1], [150, 1], [300, 0.84], [500, 0.68], [700, 0.57], [1000, 0.47]],
  // 7.62×51 / 7.62×54R / .303: full-power rifle — holds energy well downrange.
  fullpower: [[0, 1], [300, 0.95], [600, 0.86], [900, 0.77], [1200, 0.7]],
  // 12.7mm: huge bullet, very high BC — effectively flat across small-arms ranges.
  heavy: [[0, 1], [600, 0.98], [1000, 0.95], [1800, 0.9], [2600, 0.82]],
  // 9×19: pistol — falls off a cliff past close range.
  pistol: [[0, 1], [50, 0.95], [100, 0.82], [200, 0.58], [400, 0.32]],
};

function kineticClassOf(weapon: Weapon): KineticClass | null {
  if (weapon.damageType !== "ball") return null; // frag/HEAT/blast aren't kinetic
  const c = weapon.caliber;
  if (c.includes("5.56")) return "intermediate556";
  if (c.includes("7.62×39")) return "intermediate762";
  if (c.includes("12.7")) return "heavy";
  if (c.includes("9×19")) return "pistol";
  return "fullpower"; // 7.62×51/54R, .303, and any other full-power ball
}

/** 0..1 multiplier on a ball round's wounding power at `rangeM` (piecewise-linear
 *  over the kinetic-class curve). 1 for non-kinetic rounds. */
export function retainedLethality(weapon: Weapon, rangeM: number): number {
  const kc = kineticClassOf(weapon);
  if (!kc) return 1;
  const pts = LETHALITY_CURVE[kc];
  if (rangeM <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (rangeM <= pts[i][0]) {
      const [r0, m0] = pts[i - 1];
      const [r1, m1] = pts[i];
      return m0 + (m1 - m0) * ((rangeM - r0) / (r1 - r0));
    }
  }
  return pts[pts.length - 1][1];
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
  rng: RNG,
  wind: Vec2 = { x: 0, y: 0 }
): Projectile {
  const sigma = dispersionSigmaM(weapon, shooter, rangeM);
  // 2D gaussian offset
  const ox = rng.gauss(0, sigma);
  const oy = rng.gauss(0, sigma);
  const speed = weapon.muzzleVel;
  const indirect = !!weapon.indirect && (weapon.cls === "mortar" || rangeM > 60);
  const timeToImpact = indirect
    ? clamp(rangeM / Math.max(60, weapon.muzzleVel) + rangeM / 600, 1.5, 38)
    : 0;

  const aimpoint: Vec2 = { x: targetPos.x + ox, y: targetPos.y + oy };
  // Wind pushes the round downwind over its time of flight: negligible up close,
  // a metre-plus at the valley's long ranges, and harder on lofted indirect. A lag
  // coefficient — the bullet never takes the full wind.
  if (wind.x !== 0 || wind.y !== 0) {
    const tof = indirect ? timeToImpact : len(sub(aimpoint, shooter.pos)) / Math.max(1, speed);
    const k = indirect ? 0.6 : 0.45;
    aimpoint.x += wind.x * k * tof;
    aimpoint.y += wind.y * k * tof;
  }

  const dir = norm(sub(aimpoint, shooter.pos));
  const distToAim = len(sub(aimpoint, shooter.pos));

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
    // Terminal energy falls with range (5.56 sharply once it can't fragment).
    damage: weapon.damage * retainedLethality(weapon, rangeM),
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
