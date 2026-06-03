import { clamp } from "../rng";
import { dist, Vec2 } from "../vec";
import { Unit } from "../entities";
import { Land } from "../terrain";
import type { World } from "./world";
import { Task } from "./types";
import { centroidOf, dwellFor } from "./helpers";
import { planFormation, steerSquad, steerFile, holdSecurity, releaseFormation, byTeam } from "./formation";

const GATE_SPACING = 3.2; // tight file — bunch up and pour through the ECP

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
          resetProgress(t);
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
            resetProgress(t);
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

/** Move the element to its next objective as a squad — tight file out the gate, then formation. */
function drivePatrol(w: World, t: Task, members: Unit[], dt: number) {
  const raw = t.route[t.legIndex];
  if (!raw) {
    enterOnStation(w, t, members);
    return;
  }
  // Snap the objective onto reachable ground (off cliffs and out of walled
  // compounds) so the point man is always heading somewhere he can actually go.
  const target = reachableObjective(w, raw);
  const center = w.copWorld();
  const wire = w.terrain.cop.radius * w.terrain.cellSize;

  // Clear the wire first: collapse into a tight file and pour straight out to the
  // staging point just outside the gate (an on-axis, wall-free shot). Only once
  // the point man is clear do we open into the doctrinal formation; the file
  // behind him keeps pouring out the graded gate and falls in as it clears.
  if (!t.exited) {
    const go = w.gateOutsideWorld();
    steerFile(w, t, members, go, GATE_SPACING, dt);
    const nav = w.sim.unit(t.leadId);
    // Cleared once the point man is past the wall — or, backstop, if the element
    // just can't make the gate (a man wedged on a structure): give up filing and
    // let the formation branch route everyone out to the objective.
    if ((nav && dist(nav.pos, center) > wire + 8) || noProgress(t, centroidOf(members), go, dt, 30)) {
      t.exited = true;
      resetProgress(t);
    }
    return;
  }

  // Outside the wire: move to the objective in formation.
  steerSquad(w, t, members, target, planFormation(w, t, members), dt);
  const lead = w.sim.unit(t.leadId);
  // The leg is made when the point man reaches the objective, or — backstop —
  // when the element simply can't get any closer for a sustained spell.
  if ((lead && dist(lead.pos, target) < 20) || noProgress(t, centroidOf(members), target, dt, 40)) {
    t.legIndex++;
    resetProgress(t);
    if (t.legIndex >= t.route.length) enterOnStation(w, t, members, target);
  }
}

/** Bring the element home: back to the gate, then in through the ECP to muster. */
function driveReturn(w: World, t: Task, members: Unit[], dt: number, centroid: Vec2) {
  const center = w.copWorld();
  const wire = w.terrain.cop.radius * w.terrain.cellSize + 18;
  // Home once the bulk is inside the wire (a single straggler can't hold the
  // task open — the garrison walks him in); or the no-progress backstop.
  const inside = members.filter((m) => dist(m.pos, center) < wire).length;
  if (inside >= Math.ceil(members.length * 0.6) || noProgress(t, centroid, center, dt, 60)) {
    t.phase = "complete";
    return;
  }
  const go = w.gateOutsideWorld();
  const nearGate = dist(centroid, go) < 30 || dist(centroid, center) < w.terrain.cop.radius * w.terrain.cellSize * 1.2;
  if (nearGate) {
    // Bunch up and file back in through the gate to the muster yard.
    steerFile(w, t, members, w.musterWorld(), GATE_SPACING, dt);
    return;
  }
  const plan = planFormation(w, t, members);
  steerSquad(w, t, members, go, { ...plan, roadBias: Math.max(plan.roadBias, 0.45), concealBias: Math.min(plan.concealBias, 0.3) }, dt);
}

/** No-progress backstop: true once the element hasn't closed on `goal` for `limit` s. */
function noProgress(t: Task, from: Vec2, goal: Vec2, dt: number, limit: number): boolean {
  const d = dist(from, goal);
  if (t.goalDist === undefined || d < t.goalDist - 4) {
    t.goalDist = d;
    t.noProgressS = 0;
    return false;
  }
  t.noProgressS = (t.noProgressS ?? 0) + dt;
  return (t.noProgressS ?? 0) > limit;
}

function resetProgress(t: Task) {
  t.goalDist = undefined;
  t.noProgressS = 0;
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

/**
 * Snap an objective onto ground the squad can actually reach: off cliffs/walls,
 * and — crucially — out of a walled compound interior (which A* can't enter) to
 * the village edge on the approach side. Keeping objectives reachable is what
 * lets the mover stay simple (it never chases a goal it can't get to).
 */
function reachableObjective(w: World, p: Vec2): Vec2 {
  const cs = w.terrain.cellSize;
  let cx = Math.floor(p.x / cs);
  let cy = Math.floor(p.y / cs);
  const inCompound = (x: number, y: number) => {
    const l = w.terrain.land[w.terrain.idx(x, y)] as Land;
    return l === Land.Compound || l === Land.CompoundWall;
  };
  if (w.terrain.inBounds(cx, cy) && inCompound(cx, cy)) {
    // step out toward the COP until clear of the qalat
    const cop = w.state.copCell;
    const dx = Math.sign(cop.cx - cx);
    const dy = Math.sign(cop.cy - cy);
    for (let s = 0; s < 24; s++) {
      const nx = cx + dx * s;
      const ny = cy + dy * s;
      if (w.terrain.inBounds(nx, ny) && !inCompound(nx, ny) && w.terrain.passableCell(nx, ny)) {
        cx = nx;
        cy = ny;
        return w.terrain.cellCenter(cx, cy);
      }
    }
  }
  if (w.terrain.passableCell(cx, cy)) return p;
  const c = w.terrain.nearestPassable(cx, cy);
  return w.terrain.cellCenter(c.cx, c.cy);
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
