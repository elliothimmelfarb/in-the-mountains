import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist, sub, norm, add, scale, len } from "../vec";

/**
 * Insurgent doctrine. They hold their fire in concealment until the patrol is in
 * the kill zone, mass fire from the high ground and defilade, then displace
 * before the mortars and aircraft arrive. They fight hardest near their villages
 * and break contact up the draws when they're hurt or when air is on station.
 */
export function insurgentBrain(sim: CombatSim, u: Unit, dt: number) {
  if (!u.conscious) {
    u.moving = false;
    u.path = [];
    return;
  }

  const weapon = sim.weaponOf(u);

  // Target reacquisition.
  u.brainTimer -= dt;
  if (u.brainState !== "ambush") {
    if (u.brainTimer <= 0) {
      u.targetId = sim.acquireTarget(u);
      u.brainTimer = 0.5 + sim.rng.next() * 0.5;
    }
  }

  // Stance: they fight low, from rocks and brush.
  if (u.moving) u.stance = "crouch";
  else u.stance = sim.terrain.coverAt(u.pos.x, u.pos.y) > 0.3 ? "prone" : "crouch";

  // Should we break contact? Air on station, heavy fire support, low morale,
  // isolated, or badly wounded all push toward exfil.
  if (u.brainState !== "exfil" && shouldBreak(sim, u)) {
    u.brainState = "exfil";
    u.rof = "hold";
    u.targetId = null;
    if (sim.rng.chance(0.3)) sim.addLog("ICOM: enemy fighters displacing.", "radio");
  }

  switch (u.brainState) {
    case "ambush": {
      u.rof = "hold";
      u.moving = false;
      // Initiate when a patrol enters the kill zone, or patience runs out.
      const trigger = weapon.effRange * (0.45 + 0.35 * u.aggression);
      const tgt = sim.acquireTarget(u);
      const enemy = sim.unit(tgt);
      // A cell waiting on an IED holds fire no matter how close the patrol gets — the
      // CHARGE initiates the ambush (stepIeds flips them to engage), not the small arms.
      const inKillZone = !u.iedInit && enemy && dist(u.pos, enemy.pos) <= trigger;
      // A LED cell holds the trigger for its leader (ai/cell-combat.ts springs the trap
      // as one volley); the man's own kill zone and patience defer to him. The
      // acquireTarget call above still runs every tick (rng stream unchanged).
      if (u._cellHold) break;
      if ((inKillZone || (!u.iedInit && u.brainTimer <= -8)) && tgt) {
        u.targetId = tgt;
        u.rof = "free";
        u.brainState = "engage";
        u.brainTimer = sim.rng.range(14, 26); // engage DWELL — fire a real spell before scooting
        if (sim.rng.chance(0.5)) sim.addLog("CONTACT! Small arms from the high ground!", "contact");
      } else if (u.brainTimer <= (u.iedInit ? -90 : -22)) {
        // Patience exhausted. The IED triggerman is disciplined and waits much longer
        // for the kill zone to fill; only a no-show finally compromises the position.
        if (tgt && sim.rng.chance(0.5)) {
          // the position is compromised; open up with what we have
          u.iedInit = false;
          u.targetId = tgt;
          u.rof = "free";
          u.brainState = "engage";
          u.brainTimer = sim.rng.range(4, 8);
        } else {
          // melt away up the draws
          u.brainState = "exfil";
          u.rof = "hold";
        }
      }
      break;
    }
    case "engage": {
      u.rof = "free";
      // Stay in or get to cover/defilade.
      if (!u.moving && sim.terrain.coverAt(u.pos.x, u.pos.y) < 0.22 && sim.rng.chance(0.02)) {
        const cover = sim.findCover(u.pos, u.threatDir, 30);
        if (cover) sim.moveTo(u, cover);
      }
      // Shoot and scoot: after a good spell of firing FROM a position, or when pressed,
      // displace to a new firing point (#17). Now that displacePosition reliably returns a
      // lateral bound, the engage DWELL is the throttle — a fighter must put real rounds
      // downrange before he bounds, or he never engages (the over-scoot regression). Pressure
      // (real suppression / near impacts) can cut the dwell short — that's the point of scoot.
      u.brainTimer -= dt;
      const pressed = u.suppression > 0.6 || nearImpacts(sim, u);
      if ((u.brainTimer <= 0 || pressed) && u.aggression < 0.85) {
        const spot = displacePosition(sim, u);
        if (spot) {
          sim.moveTo(u, spot);
          u.brainState = "scoot";
          u.rof = "hold";
          u.brainTimer = sim.rng.range(2, 4); // brief bound — get to the new spot and re-engage
        } else {
          u.brainTimer = sim.rng.range(8, 14); // nowhere to go — keep firing
        }
      }
      break;
    }
    case "patrolling": {
      // moving (unaware) along a trail until they take fire or spot the patrol
      u.rof = "free";
      if (u.visibleEnemyIds.length > 0 || u.suppression > 0.1) {
        u.brainState = "engage";
        u.brainTimer = sim.rng.range(14, 26);
        u.targetId = sim.acquireTarget(u);
        if (sim.rng.chance(0.5)) sim.addLog("They've spotted us — contact!", "contact");
      }
      break;
    }
    case "scoot": {
      u.rof = "hold";
      if (u.path.length === 0) {
        u.brainState = "engage";
        u.rof = "free";
        u.brainTimer = sim.rng.range(14, 26); // re-engage from the new spot for a full spell
        u.targetId = sim.acquireTarget(u);
      }
      break;
    }
    case "exfil": {
      u.rof = u.visibleEnemyIds.length > 0 && u.suppression < 0.3 ? "free" : "hold";
      if (u.path.length === 0) {
        const out = exfilPoint(sim, u);
        sim.moveTo(u, out);
      }
      // off the map / far enough → gone
      const m = sim.terrain.worldSize;
      if (u.pos.x < 8 || u.pos.y < 8 || u.pos.x > m - 8 || u.pos.y > m - 8) {
        u.evac = true;
        u.alive = true;
      }
      break;
    }
    default: {
      // fresh spawns default into the fight
      u.brainState = u.visibleEnemyIds.length > 0 ? "engage" : "ambush";
      if (u.brainState === "ambush") u.brainTimer = sim.rng.range(2, 10);
    }
  }
}

/** Is fire support or aircraft pressuring this fighter into breaking contact. */
function shouldBreak(sim: CombatSim, u: Unit): boolean {
  if (u.hp < 35 && u.bleedRate > 0) return true;
  if (u.composure < 0.25) return true;
  // air / heavy indirect on station near them
  const friendlyFireNear = sim.fireMissions.some(
    (f) => f.faction === "us" && dist(f.target, u.pos) < 140
  );
  if ((sim.casUsed || friendlyFireNear) && sim.rng.chance(0.02)) return true;
  // isolated: few friends left near, many enemies visible
  let friends = 0;
  for (const o of sim.units) {
    if (o.faction === "insurgent" && o.alive && o.conscious && o !== u && dist(o.pos, u.pos) < 120) friends++;
  }
  const enemies = u.visibleEnemyIds.length;
  if (friends <= 1 && enemies >= 3 && sim.rng.chance(0.01)) return true;
  return false;
}

function nearImpacts(sim: CombatSim, u: Unit): boolean {
  return sim.effects.some((e) => (e.kind === "blast" || e.kind === "impact") && dist(e.pos, u.pos) < 25);
}

/**
 * Where to bound for shoot-and-scoot. Prefer a covered position to displace to; but on the
 * open high ground a covered cell is almost never within reach, so the old "cover or nothing"
 * returned null ~always and the fighter never scooted (#17, baseline 0.02%). The real scoot is
 * a LATERAL defilade bound off the gun-target line — break the line, re-engage from a new spot;
 * cover is a bonus, not a requirement.
 */
export function displacePosition(sim: CombatSim, u: Unit): { x: number; y: number } | null {
  const cover = sim.findCover(u.pos, u.threatDir, 55);
  if (cover && dist(cover, u.pos) > 6) return cover;
  // No cover within reach → lateral scoot perpendicular to the threat line.
  const td = u.threatDir ?? { x: 0, y: -1 };
  const perp = { x: -td.y, y: td.x };
  const side = sim.rng.chance(0.5) ? 1 : -1;
  const reach = sim.rng.range(14, 28);
  const cand = add(u.pos, scale(perp, side * reach));
  const m = sim.terrain.worldSize;
  if (cand.x < 8 || cand.y < 8 || cand.x > m - 8 || cand.y > m - 8) return null;
  const cs = sim.terrain.cellSize;
  if (!sim.terrain.passableCell(Math.floor(cand.x / cs), Math.floor(cand.y / cs))) return null;
  return cand;
}

/** Where to run to break contact — away from the nearest enemy and uphill, toward the map edge. */
export function exfilPoint(sim: CombatSim, u: Unit) {
  // direction away from nearest enemy
  let away = { x: 0, y: 0 };
  let nd = Infinity;
  for (const o of sim.units) {
    if ((o.faction === "us" || o.faction === "ana") && o.alive) {
      const d = dist(u.pos, o.pos);
      if (d < nd) {
        nd = d;
        away = norm(sub(u.pos, o.pos));
      }
    }
  }
  if (len(away) < 0.1) away = { x: 0, y: -1 };
  // bias uphill (toward higher ground / the ridges and draws)
  const e0 = sim.terrain.elevAt(u.pos.x, u.pos.y);
  const probe = add(u.pos, scale(away, 30));
  const uphill = sim.terrain.elevAt(probe.x, probe.y) > e0 ? 1 : 0.5;
  const far = add(u.pos, scale(norm(away), 400 * uphill + 200));
  return far;
}
