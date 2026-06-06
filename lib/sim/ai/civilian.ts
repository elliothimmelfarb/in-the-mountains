import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist, sub, norm, add, scale, len, dot } from "../vec";
import { clamp01, RNG } from "../rng";

/**
 * Civilian behavior. Unarmed. The valley is meant to read as LIVED-IN: villagers
 * amble their pattern of life at their own pace, stop to work and talk, and — as a
 * patrol comes near — react the way real people do, in GRADUATED tiers rather than a
 * single calm↔sprint switch:
 *
 *   OBLIVIOUS  no armed men close — go about the day (per-person pace, dwell, idle drift).
 *   WARY       armed men in the middle distance — stop, watch them, give a beat.
 *   CLEAR-ROAD a patrol bears down close — step off its line to the field edge and let it
 *              pass (children, curious, may instead drift IN for a look; elders withdraw home).
 *   FLEE       gunfire, a blast, or armed men right on top of them — bolt for home/dead ground.
 *
 * The tier rises the instant a threat appears and falls back one step at a time, so a
 * villager doesn't flip-flop. Their sudden absence is still the oldest tell in the valley.
 *
 * Every per-person trait (pace, dwell, curiosity, idle phase) is derived from a PURE hash
 * of the unit id — no per-tick randomness — so the headless sim stays bit-for-bit
 * reproducible across replays. The one O(units) scan the brain already did for gunfire
 * fear is reused to also find the nearest armed man and count the armed nearby; no second pass.
 */

const ARMED = new Set(["us", "ana", "insurgent"]);

/** Stable per-civ trait in [0,1) from the id (advances no RNG stream). */
function trait(id: string, salt: string): number {
  return (RNG.hashString(id + salt) % 100000) / 100000;
}

export function civilianBrain(sim: CombatSim, u: Unit, dt: number) {
  if (!u.conscious) {
    u.moving = false;
    u.path = [];
    return;
  }
  u.panic = u.panic ?? 0;

  // --- ONE pass over effects + units: gunfire/blast fear AND nearest-armed / armed-count ---
  let fear = 0;
  for (const e of sim.effects) {
    if (e.kind === "muzzle" || e.kind === "impact" || e.kind === "blast" || e.kind === "frag_air") {
      const d = dist(e.pos, u.pos);
      if (d < 120) fear += (1 - d / 120) * (e.kind === "blast" ? 0.5 : 0.12);
    }
  }
  let nearArmed: Unit | null = null;
  let nad = Infinity;
  let armedCount = 0;
  let firingThreat: Unit | null = null;
  let fd = Infinity;
  for (const o of sim.units) {
    if (!o.alive || !ARMED.has(o.faction)) continue;
    const d = dist(o.pos, u.pos);
    if (d < 45) {
      armedCount++;
      if (d < nad) {
        nad = d;
        nearArmed = o;
      }
    }
    if (o.hasFired) {
      if (d < 80) fear += (1 - d / 80) * 0.05;
      if (d < fd) {
        fd = d;
        firingThreat = o;
      }
    }
  }
  u.panic = clamp01(u.panic + fear - dt * 0.08);

  // --- threat scalar → graduated tier (rises instantly, falls one step / FALL_S) ---
  const proximity = nearArmed ? clamp01(1 - nad / 45) : 0;
  const threat = clamp01(0.6 * proximity + 0.25 * (Math.min(armedCount, 3) / 3) + u.panic);
  let want = threat > 0.6 || u.panic > 0.45 ? 3 : threat > 0.35 ? 2 : threat > 0.15 ? 1 : 0;
  const prev = u.reactTier ?? 0;
  if (want >= prev) {
    u.reactTier = want;
    u.tierHoldS = 0;
  } else {
    u.tierHoldS = (u.tierHoldS ?? 0) + dt;
    if (u.tierHoldS > 2.5) {
      u.reactTier = prev - 1;
      u.tierHoldS = 0;
    }
  }
  const tier = u.reactTier ?? want;

  const isChild = u.role === "child";
  const isElder = u.role === "elder";

  // ---------------------------------------------------------------- FLEE
  if (tier >= 3) {
    const threatU = firingThreat ?? nearArmed;
    const home = homePoint(sim, u);
    let dir = threatU ? norm(sub(u.pos, threatU.pos)) : { x: 0, y: 1 };
    const toHome = norm(sub(home, u.pos));
    if (!threatU || dist(home, threatU.pos) > dist(u.pos, threatU.pos)) {
      dir = norm(add(scale(dir, 0.5), scale(toHome, 0.6)));
    }
    if (len(dir) < 0.1) dir = { x: 0, y: 1 };
    const dest = sim.terrain.reachablePoint(u.pos.x + dir.x * 60, u.pos.y + dir.y * 60);
    sim.civMoveTo(u, dest);
    u.technique = "rush"; // run, don't amble
    u.paceScale = 1;
    u.stance = "stand";
    u.faceLock = null;
    return;
  }

  // ---------------------------------------------------------------- CLEAR-ROAD
  if (tier === 2 && nearArmed) {
    u.technique = "patrol";
    u.paceScale = 1;
    // A curious child drifts IN for a look instead of clearing (never inside FLEE range).
    if (isChild && trait(u.id, "cur") > 0.5 && threat < 0.6) {
      const to = sub(nearArmed.pos, u.pos);
      const d = len(to);
      if (d > 6) {
        const dest = add(u.pos, scale(norm(to), Math.min(d - 5, 8)));
        sim.civMoveTo(u, dest);
      } else {
        u.path = [];
        u.moving = false;
        u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x);
      }
      return;
    }
    // Elder: withdraw toward the compound and turn away.
    if (isElder) {
      sim.civMoveTo(u, homePoint(sim, u));
      u.faceLock = null;
      return;
    }
    // Everyone else: step off the patrol's line to the near field edge, then watch it pass.
    const away = norm(sub(u.pos, nearArmed.pos));
    const perp = { x: -away.y, y: away.x };
    const home = homePoint(sim, u);
    const side = dot(perp, norm(sub(home, u.pos))) >= 0 ? 1 : -1;
    const step = { x: away.x * 0.5 + perp.x * side, y: away.y * 0.5 + perp.y * side };
    const dest = add(u.pos, scale(norm(step), 5));
    sim.civMoveTo(u, dest);
    u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x); // watch them
    return;
  }

  // ---------------------------------------------------------------- WARY
  if (tier === 1 && nearArmed) {
    u.path = [];
    u.moving = false;
    u.stance = "stand";
    u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x); // look up, watch
    return;
  }

  // ---------------------------------------------------------------- OBLIVIOUS (pattern of life)
  u.faceLock = null;
  u.technique = "patrol"; // amble (1.5 m/s base) eased by a per-person pace, not a uniform 2 m/s march
  // per-person amble pace; paceScale is clamped <=1 in the integrator, so 0.5-0.92 * 1.5 = ~0.75-1.4 m/s
  const pb = trait(u.id, "pace");
  u.paceScale = isChild ? 0.62 + 0.3 * pb : isElder ? 0.42 + 0.18 * pb : 0.55 + 0.37 * pb;

  if (u.path.length === 0) {
    // Dwell at a node — work a field, water animals, chat — for a per-person spell, then
    // amble to the next errand (longer hops prefer the track network).
    u.brainTimer = (u.brainTimer ?? 0) - dt;
    if (u.brainTimer <= 0 && u.routine && u.routine.length > 0 && sim.rng.chance(0.02)) {
      const node = sim.rng.pick(u.routine);
      const far = dist(node.target, u.pos) > 160;
      sim.civMoveTo(u, node.target, far ? 0.4 : 0);
      const dwell = isElder ? 18 + 28 * trait(u.id, "dwell") : isChild ? 4 + 10 * trait(u.id, "dwell") : 10 + 22 * trait(u.id, "dwell");
      u.brainTimer = dwell;
    } else {
      // standing idle: a slow look-around so a villager isn't a frozen statue
      u.stance = "stand";
      u.moving = false;
      const ph = trait(u.id, "idle") * Math.PI * 2;
      u.facing = ph + 0.55 * Math.sin(sim.timeS * 0.16 + ph);
    }
  }
}

function homePoint(sim: CombatSim, u: Unit): { x: number; y: number } {
  const vil = sim.terrain.villages.find((v) => v.id === u.villageId) ?? sim.terrain.villages[0];
  if (vil) return sim.terrain.cellCenter(vil.cx, vil.cy);
  return { x: u.pos.x, y: u.pos.y };
}
