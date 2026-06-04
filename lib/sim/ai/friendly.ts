import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist } from "../vec";
import { clamp01 } from "../rng";

/** Automatic weapons — the squad's base of fire in a deliberate assault. */
const AUTO_ROLES = new Set(["saw_gunner", "auto_rifleman", "machinegunner"]);

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

  // Casualty care is every soldier's job, not just the medic's. If a buddy is down
  // nearby and I'm the closest man who can reach him, I peel off to drag him to cover
  // and put a tourniquet on (the bleed model then stops his arterial bleed — #7). The
  // pinned and the assaulting stay in the fight; one buddy responds per casualty.
  if (u.role !== "medic" && !pinned && u.orderType !== "assault") {
    const cas = sim.nearestDownedNeedingHelp(u, 24);
    if (cas && sim.nearestAbleBuddy(cas) === u) {
      u.faceLock = null;
      const d = dist(u.pos, cas.pos);
      if (d > 2.2) {
        sim.moveTo(u, cas.pos);
        u.stance = underFire ? "prone" : "crouch";
        u.brainState = "aiding";
        return;
      }
      u.moving = false;
      u.stance = "crouch";
      u.brainState = "aiding";
      // pull him out of the open; once in cover, just stay on him (buddy-aid applies)
      if (sim.terrain.coverAt(cas.pos.x, cas.pos.y) < 0.3) sim.dragToCover(u, cas, dt);
      return;
    }
    if (u.brainState === "aiding") u.brainState = "holding"; // casualty handled / gone
  }

  // In contact, break the march formation: orient on the threat and move freely.
  if (contact) {
    u.faceLock = null;
    u.formationHold = false;
    u.paceScale = 1;
  }

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
      // A deliberate ASSAULT is fire and maneuver, not a banzai walk (an assault
      // order sets brainState "moving" + orderType "assault"): the automatic weapons
      // set a BASE OF FIRE on the objective from cover while the riflemen and leaders
      // BOUND onto it under that suppression.
      if (u.orderType === "assault") {
        if (AUTO_ROLES.has(u.role) && contact) {
          u.rof = "suppress"; // hose the objective so the assault element can move
          if (sim.terrain.coverAt(u.pos.x, u.pos.y) < 0.25 && u.path.length === 0) {
            const cover = sim.findCover(u.pos, u.threatDir, 16);
            if (cover && dist(cover, u.pos) > 2) sim.moveTo(u, cover);
          } else {
            u.path = [];
            u.moving = false;
            u.stance = sim.terrain.coverAt(u.pos.x, u.pos.y) > 0.3 ? "crouch" : "prone";
          }
          break; // the gunner holds the base of fire — he isn't closing on the objective
        }
        // assault element bounds onto the objective (gunner displaces forward on the lull)
        if (!contact && u.rof === "suppress") u.rof = "free"; // stop hosing empty ground
        if (u.orderTarget && u.path.length === 0 && dist(u.pos, u.orderTarget) > 3) sim.moveTo(u, u.orderTarget);
        maybeReachedDest(u);
        break;
      }
      // Plain move: the instant rounds are effective, get off the X — bound to the
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
      // Legacy aliases — assault now flows through the "moving" case (orderType
      // "assault"), which runs the base-of-fire / bounding split. Route there.
      u.brainState = "moving";
      if (u.orderTarget && u.path.length === 0 && dist(u.pos, u.orderTarget) > 3) sim.moveTo(u, u.orderTarget);
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
  // keep the invariant bleedTQable <= bleedRate, so a partially-treated-then-abandoned
  // mixed wound can't let a conscious casualty self-cure the internal (medic-only) part.
  patient.bleedTQable = Math.min(patient.bleedTQable ?? 0, patient.bleedRate);
  if (patient.bleedRate <= 0.001) {
    for (const w of patient.wounds) w.treated = true;
    patient.bleedRate = 0;
    patient.bleedTQable = 0;
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
