import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist, sub, norm, add, scale, len } from "../vec";
import { clamp01 } from "../rng";

/**
 * Civilian behavior. Unarmed. When calm they drift along their pattern of life;
 * when the shooting starts they scatter for their compounds and the dead ground.
 * Their sudden absence is the oldest tell in the valley — a player who reads the
 * empty fields knows contact is coming.
 */
export function civilianBrain(sim: CombatSim, u: Unit, dt: number) {
  if (!u.conscious) {
    u.moving = false;
    u.path = [];
    return;
  }
  u.panic = u.panic ?? 0;

  // Fear from nearby gunfire, explosions, and armed men.
  let fear = 0;
  for (const e of sim.effects) {
    if (e.kind === "muzzle" || e.kind === "impact" || e.kind === "blast" || e.kind === "frag_air") {
      const d = dist(e.pos, u.pos);
      if (d < 120) fear += (1 - d / 120) * (e.kind === "blast" ? 0.5 : 0.12);
    }
  }
  for (const o of sim.units) {
    if (o.alive && (o.faction === "insurgent" || o.faction === "us") && o.hasFired) {
      const d = dist(o.pos, u.pos);
      if (d < 80) fear += (1 - d / 80) * 0.05;
    }
  }
  u.panic = clamp01(u.panic + fear - dt * 0.08);

  if (u.panic > 0.3) {
    // flee: away from the nearest shooter, toward home compound / dead ground
    let threat: Unit | null = null;
    let nd = Infinity;
    for (const o of sim.units) {
      if (o.alive && o.hasFired && (o.faction === "insurgent" || o.faction === "us")) {
        const d = dist(o.pos, u.pos);
        if (d < nd) {
          nd = d;
          threat = o;
        }
      }
    }
    const home = homePoint(sim, u);
    let dir = threat ? norm(sub(u.pos, threat.pos)) : { x: 0, y: 1 };
    // blend toward home if home is not back toward the threat
    const toHome = norm(sub(home, u.pos));
    if (!threat || dist(home, threat.pos) > dist(u.pos, threat.pos)) {
      dir = norm(add(scale(dir, 0.5), scale(toHome, 0.6)));
    }
    if (len(dir) < 0.1) dir = { x: 0, y: 1 };
    const dest = add(u.pos, scale(dir, 60));
    // Flee to passable ground off the wire, routing around it if the straight bolt
    // is blocked — a panicked villager runs for home and dead ground, not into the HESCO.
    sim.civMoveTo(u, dest);
    u.stance = "stand";
    return;
  }

  // calm: amble toward today's routine objective (or idle), preferring the road/track network
  // for the longer hops between villages — so the inter-village tracks carry foot traffic.
  if (u.path.length === 0 && u.routine && u.routine.length > 0) {
    if (sim.rng.chance(0.01)) {
      const node = sim.rng.pick(u.routine);
      const far = dist(node.target, u.pos) > 160; // a real errand, not a step into the next field
      sim.civMoveTo(u, node.target, far ? 0.4 : 0);
    }
  }
}

function homePoint(sim: CombatSim, u: Unit): { x: number; y: number } {
  const vil = sim.terrain.villages.find((v) => v.id === u.villageId) ?? sim.terrain.villages[0];
  if (vil) return sim.terrain.cellCenter(vil.cx, vil.cy);
  return { x: u.pos.x, y: u.pos.y };
}
