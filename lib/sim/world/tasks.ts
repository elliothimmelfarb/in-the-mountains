import { clamp } from "../rng";
import { dist, Vec2 } from "../vec";
import { Unit } from "../entities";
import { Land } from "../terrain";
import type { World } from "./world";
import { Task, defaultSOP } from "./types";
import { centroidOf, dwellFor } from "./helpers";
import { planFormation, steerSquad, steerFile, holdSecurity, releaseFormation, byTeam } from "./formation";
import { squadFight } from "../ai/squad-combat";

const GATE_SPACING = 3.2; // tight file — bunch up and pour through the ECP
const LEG_ARRIVE = 18; // m — the point man has reached the objective
const STUCK_S = 90; // s of zero route progress before a leg is declared genuinely stuck
const CONTACT_HOLD_S = 10; // s a squad stays "in contact" after the last round/sighting (anti-flicker)

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
    // Sticky contact: a squad stays "in contact" for a few seconds after the last round
    // or sighting, so a momentary break in LOS (the enemy ducking) doesn't make the whole
    // element stand up, declare all-clear, and walk on — only to be hit again next tick.
    const rawContact = members.some((m) => m.visibleEnemyIds.length > 0 || m.suppression > 0.3);
    if (rawContact) t.contactHold = CONTACT_HOLD_S;
    else if (t.contactHold) t.contactHold = Math.max(0, t.contactHold - dt);
    const contact = rawContact || (t.contactHold ?? 0) > 0;

    switch (t.phase) {
      case "assembling": {
        t.timer -= dt;
        const muster = w.musterWorld();
        for (const m of members) {
          // Route to the muster yard around solid buildings (issue 003): a straight
          // moveTo could loop forever against a now-solid b-hut; walkTo paths around it.
          if (m.path.length === 0 && dist(m.pos, muster) > 12) w.sim.walkTo(m, jitter(w, muster, 6));
        }
        if (t.timer <= 0) {
          t.phase = "moving";
          t.legIndex = 0;
          t.exited = false;
          resetProgress(t);
          {
            const sop = t.sop ?? defaultSOP(t.missionType);
            for (const m of members) {
              m.technique = t.technique;
              m.brainState = "moving";
              m.rof = t.missionType === "ambush" || t.missionType === "overwatch" ? "hold" : "free";
              m.roe = sop.roe; // the civilian-fire gate reads this from the start of the patrol
            }
          }
          w.log(`${t.label}: ${members.length} pax filing out the gate (${t.technique}).`, "radio");
          w.interrupt(`${t.label} steps off`);
        }
        break;
      }
      case "moving": {
        if (contact) squadFight(w, t, members, dt);
        else {
          if (t.squadState) releaseCombat(w, t, members);
          drivePatrol(w, t, members, dt);
        }
        break;
      }
      case "onstation": {
        if (contact) {
          squadFight(w, t, members, dt);
        } else {
          if (t.squadState) releaseCombat(w, t, members);
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
        if (contact) squadFight(w, t, members, dt);
        else {
          if (t.squadState) releaseCombat(w, t, members);
          driveReturn(w, t, members, dt, centroid);
        }
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
        m.paceScale = 1;
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
    // Cleared once the point man is past the wall. The backstop watches the POINT
    // MAN's progress toward the gate, not the squad centroid — the file naturally
    // trails the centroid well behind him, so a centroid-based check would "give
    // up" and flip to formation while the lead is still inside the wire, leaving
    // the element to tangle on the HESCO. Only a point man who genuinely can't
    // make the gate (wedged on a structure) trips it.
    if ((nav && dist(nav.pos, center) > wire + 8) || noProgress(t, nav ? nav.pos : centroidOf(members), go, dt, 40)) {
      t.exited = true;
      resetProgress(t);
    }
    return;
  }

  // Outside the wire: move to the objective in formation.
  steerSquad(w, t, members, target, planFormation(w, t, members), dt);
  const lead = w.sim.unit(t.leadId);
  // Progress is the navigator's REMAINING ROUTE LENGTH, not straight-line distance to
  // the objective. Rounding a convex obstacle (the COP ring) temporarily *increases*
  // the straight-line distance, which spuriously tripped the old distance backstop and
  // froze the patrol half-way (the bug that stranded squads on the wire). Route length
  // falls monotonically as the point man advances, so the backstop only fires when he
  // genuinely can't move at all.
  const arrived = !!lead && dist(lead.pos, target) < LEG_ARRIVE;
  const stuck = stalled(t, lead ? routeRemaining(lead) : 0, dt, STUCK_S);
  if (arrived || stuck) {
    if (stuck && !arrived) w.log(`${t.label}: held up short of the objective.`, "radio");
    t.legIndex++;
    resetProgress(t);
    // Only ever "set up on the objective" where the element actually is — never
    // pretend a stalled patrol reached a point it never got to.
    if (t.legIndex >= t.route.length) enterOnStation(w, t, members, arrived ? target : undefined);
  }
}

/** Remaining distance along a unit's current route (monotonic as it advances). */
function routeRemaining(u: Unit): number {
  if (!u.path || u.path.length === 0) return u.pathGoal ? dist(u.pos, u.pathGoal) : 0;
  let total = dist(u.pos, u.path[0]);
  for (let i = 1; i < u.path.length; i++) total += dist(u.path[i - 1], u.path[i]);
  return total;
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
  return stalled(t, dist(from, goal), dt, limit);
}

/**
 * Generic stall tracker on any monotonically-decreasing progress scalar (straight-line
 * distance, or remaining route length). Resets whenever the value drops by >2 m; once
 * it has been flat for `limit` seconds the element is genuinely stuck. Using route
 * length (not straight-line distance) is what lets a patrol round the COP ring without
 * the backstop firing on the temporary distance increase.
 */
function stalled(t: Task, value: number, dt: number, limit: number): boolean {
  if (t.goalDist === undefined || value < t.goalDist - 2) {
    t.goalDist = value;
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

/**
 * Contact has broken — hand the squad back from the combat coordinator to the task
 * machine. Clear the combat bookkeeping, reset each man's fire posture to the mission
 * default, and re-establish the right baseline for the phase (re-secure the objective
 * on-station, otherwise resume the march). Called once on the contact→lull transition.
 */
function releaseCombat(w: World, t: Task, members: Unit[]) {
  if (!t.squadState) return;
  t.squadState = undefined;
  t.bofIds = undefined;
  t.mnvrIds = undefined;
  t.rallyPt = undefined;
  const sop = t.sop ?? defaultSOP(t.missionType);
  const baseRof = t.missionType === "ambush" || t.missionType === "overwatch" ? "hold" : "free";
  for (const m of members) {
    if (!m.alive) continue;
    m.orderType = undefined;
    m.orderTarget = null;
    m.rof = baseRof;
    m.roe = sop.roe;
    m.brainState = t.phase === "onstation" ? "holding" : "moving";
  }
  releaseFormation(members);
  if (t.phase === "onstation") {
    holdSecurity(w, byTeam(w, members), centroidOf(members), t.kind === "kle" ? 14 : 20);
  }
  w.log(
    `${t.label}: contact broken — ${t.phase === "returning" ? "continuing exfil" : t.phase === "onstation" ? "re-securing the objective" : "resuming movement"}.`,
    "radio"
  );
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
