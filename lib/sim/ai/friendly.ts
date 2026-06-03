import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist } from "../vec";
import { clamp01 } from "../rng";

/**
 * Friendly (US/ANA) autonomy. The player gives intent — move here, hold this,
 * assault that — and soldiers fill in the gaps the way trained infantry do:
 * return fire, hit the dirt when rounds snap past, reload, drag and treat the
 * wounded, and keep fighting unless they're pinned and leaderless.
 */
export function friendlyBrain(sim: CombatSim, u: Unit, dt: number) {
  if (!u.conscious) {
    u.moving = false;
    u.path = [];
    return;
  }

  // Medic: stabilize the nearest casualty when ordered to, or on initiative.
  if (u.role === "medic") {
    if (medicTreat(sim, u, dt)) return;
  }

  // Reacquire a target every ~0.5s (cheap throttle).
  u.brainTimer -= dt;
  if (u.brainTimer <= 0) {
    if (u.rof !== "hold") u.targetId = sim.acquireTarget(u);
    u.brainTimer = 0.4 + sim.rng.next() * 0.3;
  }

  const underFire = u.suppression > 0.35;
  const pinned = u.composure < 0.22 || u.suppression > 0.8;
  const contact = u.visibleEnemyIds.length > 0 || underFire;

  // Stance: posture down in contact, especially when pinned or stationary.
  if (!u.moving) {
    if (pinned) u.stance = "prone";
    else if (contact) u.stance = sim.terrain.coverAt(u.pos.x, u.pos.y) > 0.3 ? "crouch" : "prone";
    else u.stance = "crouch";
  } else {
    const t = sim.techniqueOf(u);
    u.stance = t === "crawl" ? "prone" : t === "concealed" || t === "tactical" ? "crouch" : "stand";
  }

  // Pinned & leaderless: hunker, seek the nearest cover, don't expose to fire.
  if (pinned && !leaderNear(sim, u)) {
    if (u.path.length === 0 && underFire) {
      const cover = sim.findCover(u.pos, u.threatDir, 30);
      if (cover && dist(cover, u.pos) > 3) sim.moveTo(u, cover);
    }
    u.stance = "prone";
    // still return fire occasionally if a target is right there
    return;
  }

  switch (u.brainState) {
    case "moving": {
      // Traveling: the instant rounds are effective, get off the X — bound to the
      // nearest cover and return fire rather than walking through the kill zone.
      if ((underFire || u.visibleEnemyIds.length > 0) && u.path.length >= 0) {
        const cover = sim.findCover(u.pos, u.threatDir, 26);
        if (cover && sim.terrain.coverAt(u.pos.x, u.pos.y) < 0.3) sim.moveTo(u, cover);
        else u.path = [];
        u.stance = "prone";
        u.brainState = "suppressed_halt";
        u.brainTimer = sim.rng.range(2.5, 5);
      }
      maybeReachedDest(u);
      break;
    }
    case "suppressed_halt": {
      u.brainTimer -= dt;
      if (u.brainTimer <= 0 && u.suppression < 0.5) {
        // resume original move
        if (u.orderTarget) sim.moveTo(u, u.orderTarget);
        u.brainState = "moving";
      }
      break;
    }
    case "assaulting":
    case "moving_assault": {
      // push toward objective, firing on the move
      if (u.orderTarget && u.path.length === 0 && dist(u.pos, u.orderTarget) > 3) {
        sim.moveTo(u, u.orderTarget);
      }
      maybeReachedDest(u);
      break;
    }
    case "withdrawing": {
      if (u.orderTarget && u.path.length === 0 && dist(u.pos, u.orderTarget) > 3) {
        sim.moveTo(u, u.orderTarget);
      }
      maybeReachedDest(u, "withdrawn");
      break;
    }
    case "fragging": {
      if (u.orderTarget) {
        const r = dist(u.pos, u.orderTarget);
        if (r <= 40 && u.grenades > 0) {
          sim.throwFrag(u, u.orderTarget);
          u.brainState = "holding";
          u.orderTarget = null;
        } else if (r > 40) {
          sim.moveTo(u, u.orderTarget);
          if (r < 38) {
            sim.throwFrag(u, u.orderTarget);
            u.brainState = "holding";
          }
        }
      }
      break;
    }
    case "regroup": {
      maybeReachedDest(u, "holding");
      break;
    }
    case "holding":
    case "engaging":
    case "suppressing":
    default: {
      // hold position and fight; if no orderTarget, root in place
      if (u.path.length === 0) u.moving = false;
      break;
    }
  }
}

function maybeReachedDest(u: Unit, thenState = "holding") {
  if (u.path.length === 0) {
    u.brainState = thenState;
    u.moving = false;
  }
}

function leaderNear(sim: CombatSim, u: Unit): boolean {
  return sim.units.some(
    (o) => o.alive && o.isLeader && o.faction === u.faction && o.squadId === u.squadId && dist(o.pos, u.pos) < 35
  );
}

function medicTreat(sim: CombatSim, u: Unit, dt: number): boolean {
  let patient: Unit | null = null;
  if (u.targetId && u.brainState === "treating") {
    const t = sim.unit(u.targetId);
    if (t && t.alive && (t.bleedRate > 0 || t.wounds.some((w) => !w.treated))) patient = t;
  }
  if (!patient) patient = sim.nearestCasualty(u);
  if (!patient) {
    if (u.brainState === "treating") u.brainState = "holding";
    return false;
  }
  const d = dist(u.pos, patient.pos);
  if (d > 2.5) {
    sim.moveTo(u, patient.pos);
    u.brainState = "treating";
    return true;
  }
  // on the casualty — work the wound
  u.moving = false;
  u.stance = "crouch";
  const rate = (0.6 + u.medical * 1.6) * dt;
  patient.bleedRate = Math.max(0, patient.bleedRate - rate);
  if (patient.bleedRate <= 0.001) {
    for (const w of patient.wounds) w.treated = true;
    patient.bleedRate = 0;
    if (!patient.conscious && patient.hp > 10 && sim.rng.chance(0.02)) patient.conscious = true;
    patient.composure = clamp01(patient.composure + 0.2 * dt);
    if (u.brainState === "treating") {
      sim.addLog(`${sim.shortName(u)} stabilizes ${sim.shortName(patient)}.`, "casualty");
      u.brainState = "holding";
    }
    return false;
  }
  u.brainState = "treating";
  return true;
}
