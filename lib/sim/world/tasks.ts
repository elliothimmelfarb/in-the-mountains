import { clamp } from "../rng";
import { dist, Vec2 } from "../vec";
import { Unit } from "../entities";
import type { World } from "./world";
import { Task } from "./types";
import { centroidOf, dwellFor } from "./helpers";
import { planFormation, steerSquad, holdSecurity, releaseFormation, byTeam, FormationPlan } from "./formation";

/**
 * Strategic tasks: the orders that take time. A patrol musters in the yard,
 * files out through the gate, then moves to its objective as a squad — in
 * formation, point man navigating the terrain, the rest pulling security — sets
 * up on the objective, and comes home. Combat AI takes over the instant rounds
 * crack, and the task resumes the move on the lull.
 */
export function tickTasks(w: World, dt: number) {
  for (const t of w.state.tasks) {
    if (t.phase === "complete") continue;
    const members = t.memberIds.map((id) => w.sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
    if (members.length === 0) {
      t.phase = "complete";
      continue;
    }
    const centroid = centroidOf(members);
    const contact = members.some((m) => m.visibleEnemyIds.length > 0 || m.suppression > 0.3);

    switch (t.phase) {
      case "assembling": {
        t.timer -= dt;
        const muster = w.musterWorld();
        for (const m of members) {
          if (m.path.length === 0 && dist(m.pos, muster) > 12) w.sim.moveTo(m, jitter(w, muster, 6));
        }
        if (t.timer <= 0) {
          t.phase = "moving";
          t.legIndex = 0;
          t.exited = false;
          for (const m of members) {
            m.technique = t.technique;
            m.brainState = "moving";
            m.rof = t.missionType === "ambush" || t.missionType === "overwatch" ? "hold" : "free";
          }
          w.log(`${t.label}: ${members.length} pax filing out the gate (${t.technique}).`, "radio");
          w.interrupt(`${t.label} steps off`);
        }
        break;
      }
      case "moving": {
        if (!contact) drivePatrol(w, t, members, dt);
        break;
      }
      case "onstation": {
        if (!contact) {
          t.timer -= dt;
          onStationEffects(w, t, members, dt);
          if (t.timer <= 0) {
            t.phase = "returning";
            releaseFormation(members);
            w.log(`${t.label}: objective complete, returning to ${w.state.fob.name}.`, "radio");
          }
        }
        break;
      }
      case "returning": {
        if (!contact) driveReturn(w, t, members, dt, centroid);
        break;
      }
    }
  }

  // clean up finished tasks and stand the men down
  const done = w.state.tasks.filter((t) => t.phase === "complete");
  for (const t of done) {
    for (const id of t.memberIds) {
      const m = w.platoon.members.find((x) => x.id === id);
      if (m && m.alive) {
        m.status = m.rest < 0.5 ? "rest" : "ready";
        m.brainState = "garrison";
        m.technique = undefined;
        m.path = [];
        m.faceLock = null;
        m.formationHold = false;
      }
    }
    if (t.kind !== "standto") {
      w.log(`${t.label}: element back inside the wire.`, "info");
      w.interrupt(`${t.label} returned`);
    }
  }
  w.state.tasks = w.state.tasks.filter((t) => t.phase !== "complete");
}

/** Move the element to its next objective as a squad, filing out the gate first. */
function drivePatrol(w: World, t: Task, members: Unit[], dt: number) {
  const plan = planFormation(w, t, members);

  // 1) Clear the wire: file out through the entry-control point. We switch to
  //    objective navigation once the point man is through the gate (so the
  //    route A* only ever runs outside the wire); the file trails out behind him.
  if (!t.exited) {
    const go = w.gateOutsideWorld();
    steerSquad(w, t, members, go, gateFile(plan), dt);
    const lead = w.sim.unit(t.leadId);
    const center = w.copWorld();
    if (lead && (dist(lead.pos, go) < 14 || dist(lead.pos, center) > w.terrain.cop.radius * w.terrain.cellSize)) {
      t.exited = true;
    }
    return;
  }

  // 2) Move along the route, leg by leg, in formation. The leg is "made" when
  //    the point man reaches the waypoint (the column may still be trailing in).
  const target = t.route[t.legIndex];
  if (!target) {
    enterOnStation(w, t, members);
    return;
  }
  steerSquad(w, t, members, target, plan, dt);
  const lead = w.sim.unit(t.leadId);
  if (lead && dist(lead.pos, target) < 20) {
    t.legIndex++;
    if (t.legIndex >= t.route.length) enterOnStation(w, t, members, target);
  }
}

/** Bring the element home: back to the gate, then in through the ECP to muster. */
function driveReturn(w: World, t: Task, members: Unit[], dt: number, centroid: Vec2) {
  const center = w.copWorld();
  if (dist(centroid, center) < 45) {
    t.phase = "complete";
    return;
  }
  const go = w.gateOutsideWorld();
  const nearGate = dist(centroid, go) < 28 || dist(centroid, center) < w.terrain.cop.radius * w.terrain.cellSize * 1.15;
  const target = nearGate ? w.musterWorld() : go;
  const plan = planFormation(w, t, members);
  const home: FormationPlan = nearGate
    ? gateFile(plan)
    : { ...plan, roadBias: Math.max(plan.roadBias, 0.45), concealBias: Math.min(plan.concealBias, 0.3) };
  steerSquad(w, t, members, target, home, dt);
}

/** Tight file with no concealment detour — for threading the gate. */
function gateFile(plan: FormationPlan): FormationPlan {
  return { ...plan, formation: "file", spacing: Math.min(plan.spacing, 5), concealBias: 0, roadBias: 0.3 };
}

function enterOnStation(w: World, t: Task, members: Unit[], center?: Vec2) {
  t.phase = "onstation";
  t.timer = dwellFor(t);
  const at = center ?? centroidOf(members);
  const radius = t.kind === "kle" ? 14 : 20;
  // Set up around the objective by team, each fire team holding a sector.
  holdSecurity(w, byTeam(w, members), at, radius);
  w.interrupt(`${t.label} on objective`);
}

function jitter(w: World, p: Vec2, r: number): Vec2 {
  return { x: p.x + w.rng.range(-r, r), y: p.y + w.rng.range(-r, r) };
}

function onStationEffects(w: World, t: Task, members: Unit[], dt: number) {
  const here = centroidOf(members);
  const near = w.nearestVillage(here, 70);
  if (t.kind === "kle" && near) {
    near.attitude = clamp(near.attitude + (8 / 360) * dt, -100, 100);
    near.cooperation = clamp(near.cooperation + (10 / 360) * dt, 0, 100);
    near.lastVisitedDay = w.day;
    if (w.rng.chance(0.02 * dt)) {
      w.addIntel({
        source: "HUMINT",
        text: `${near.elder} hints outsiders pressure his village and cache weapons up the draw.`,
        reliability: 0.5 + near.cooperation / 250,
        cx: near.cx,
        cy: near.cy,
      });
    }
    w.advanceDirective("kle", (0.5 / 360) * dt);
  } else if (near && (t.missionType === "presence" || t.missionType === "cordon")) {
    near.attitude = clamp(near.attitude + (3 / dwellFor(t)) * dt, -100, 100);
    near.lastVisitedDay = w.day;
    w.advancePresence();
    if (t.missionType === "cordon" && w.rng.chance(0.015 * dt) && near.sympathy > 30) {
      near.sympathy = clamp(near.sympathy - 1, 0, 100);
    }
  } else if (t.missionType === "census" && near) {
    near.censusDone = true;
    near.lastVisitedDay = w.day;
    w.advanceCensus();
  } else if (t.missionType === "recon" && w.rng.chance(0.02 * dt)) {
    w.addIntel({
      source: "PATROL",
      text: `Patrol reports trail use and fresh tracks in the ${w.bearingDesc(here)} valley.`,
      reliability: 0.6,
      cx: Math.round(here.x / w.terrain.cellSize),
      cy: Math.round(here.y / w.terrain.cellSize),
    });
  }
}
