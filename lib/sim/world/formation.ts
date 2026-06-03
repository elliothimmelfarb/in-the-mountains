import { clamp, clamp01 } from "../rng";
import { Vec2, dist, sub, add, scale, norm, len, fromAngle, angle } from "../vec";
import { Unit } from "../entities";
import type { World } from "./world";
import { Task } from "./types";
import { centroidOf } from "./helpers";

/**
 * Squad movement, composed on the real structure of a US infantry squad. A
 * nine-man squad is a squad leader plus two four-man fire teams (each a team
 * leader, an automatic rifleman, a grenadier and a rifleman). The squad does
 * not move as nine loose dots — it moves as an echelon: the lead team's leader
 * (with a rifleman out on point) navigates the ground; his automatic rifleman
 * and grenadier hold the team's flanks; the squad leader follows controlling
 * the element with the medic/RTO; the trail team brings up the rear and watches
 * the backtrail. Each leader keeps his own people together; the squad leader
 * keeps the teams together. Doctrine (file/column/wedge, spacing, whether to
 * hug cover or take the road) is chosen from the mission, posture, terrain and
 * what the squad expects to run into. Combat AI takes over the instant rounds
 * crack; this only runs the move.
 */

export type Formation = "file" | "wedge" | "column" | "dispersed";

export interface FormationPlan {
  formation: Formation;
  spacing: number; // meters between men within a team
  concealBias: number; // pathfinding: thread cover
  roadBias: number; // pathfinding: use the road
  expectContact: boolean;
}

interface FireTeamS {
  leaderId: string | null; // team leader (null if no NCO present)
  ids: string[]; // all team members incl. the leader
}

interface SquadS {
  navigatorId: string; // who runs the route (lead team leader / best scout)
  slId: string | null; // squad leader (commands the element)
  teams: FireTeamS[]; // lead team first
  attachedIds: string[]; // medic / RTO / JTAC / terp move with the SL
}

const ATTACHED = new Set(["medic", "rto", "jtac", "interpreter", "engineer"]);
const AUTO = new Set(["saw_gunner", "auto_rifleman", "machinegunner"]);

/** Decide how the squad moves from mission, posture, terrain and the threat. */
export function planFormation(w: World, t: Task, members: Unit[]): FormationPlan {
  const tech = t.technique;
  const center = centroidOf(members);
  const open = terrainOpenness(w, center); // 0 = restrictive (forest/draw), 1 = open
  const expect = expectsContact(w, t, center);
  const seeking = t.missionType === "ambush" || t.missionType === "recon" || tech === "concealed" || tech === "crawl";

  let spacing =
    tech === "crawl" ? 4 : tech === "concealed" ? 6 : tech === "tactical" ? 8 : tech === "patrol" ? 9 : tech === "traveling" ? 11 : 13;
  if (expect) spacing *= 1.3; // open the interval up when contact is likely
  if (open < 0.4) spacing *= 0.72; // close it down in restrictive terrain for control
  spacing = clamp(spacing, 3.5, 20);

  let formation: Formation;
  if (open < 0.42 || tech === "concealed" || tech === "crawl")
    formation = "file"; // restrictive ground or moving stealthy → file
  else if ((tech === "traveling" || tech === "rush") && !expect)
    formation = "column"; // admin road march, contact not expected
  else if (expect)
    formation = "dispersed"; // expecting contact in the open → teams abreast, all-round
  else formation = "wedge"; // movement to contact in the open

  let concealBias = tech === "concealed" ? 0.72 : tech === "tactical" ? 0.38 : 0;
  if (seeking) concealBias = Math.max(concealBias, 0.42);

  let roadBias = tech === "rush" ? 0.72 : tech === "traveling" ? 0.6 : tech === "patrol" ? 0.25 : tech === "tactical" ? 0.1 : 0;
  if (seeking) roadBias = 0; // never walk the obvious road when sneaking or hunting
  else if (expect) roadBias *= 0.4; // don't canalize onto the road into an ambush

  return { formation, spacing, concealBias, roadBias, expectContact: expect };
}

/**
 * Steer the squad toward `target` this tick as a composed echelon. Returns the
 * element centroid for leg-progression checks in the caller.
 */
export function steerSquad(w: World, t: Task, members: Unit[], target: Vec2, plan: FormationPlan, dt: number): Vec2 {
  const sim = w.sim;
  if (members.length === 0) return centroidOf(members);
  const sq = buildSquad(w, members);
  const nav = sim.unit(sq.navigatorId);
  if (!nav) return centroidOf(members);
  t.leadId = sq.navigatorId;

  // The lead team's leader navigates the terrain.
  nav.technique = t.technique;
  nav.brainState = "moving";
  nav.faceLock = null;
  const repath = nav.path.length === 0 || !nav.orderTarget || dist(nav.orderTarget, target) > 22;
  if (repath) sim.pathTo(nav, target, { concealBias: plan.concealBias, roadBias: plan.roadBias });

  const ahead = nav.path.length ? nav.path[0] : target;
  let dir = norm(sub(ahead, nav.pos));
  if (len(dir) < 1e-3) dir = fromAngle(nav.facing);
  const perp = { x: -dir.y, y: dir.x };

  const teamSp = plan.spacing;
  const squadSp = Math.max(plan.spacing * 2.2, 16); // teams/SL are spaced further than men in a team

  // Lead team forms around the navigator (its leader), point pushed forward.
  const leadTeam = sq.teams[0];
  if (leadTeam) placeTeam(w, t, plan, leadTeam, nav, nav.pos, dir, perp, teamSp, true);

  // Squad leader follows the lead team, controlling; medic/RTO ride with him.
  const sl = sq.slId ? sim.unit(sq.slId) : undefined;
  let anchorBase = nav.pos;
  if (sl && sl !== nav) {
    setSecurity(sl, t, angle(dir));
    moveToward(w, sl, passTarget(w, add(nav.pos, scale(dir, -squadSp)), nav.pos), plan.concealBias);
    anchorBase = sl.pos;
    placeAttached(w, t, plan, sq.attachedIds, sl, sl.pos, dir, perp, teamSp);
  } else {
    placeAttached(w, t, plan, sq.attachedIds, nav, nav.pos, dir, perp, teamSp);
  }

  // Trail team brings up the rear (offset to a flank when expecting contact).
  const trailTeam = sq.teams[1];
  if (trailTeam) {
    const lateral = plan.formation === "wedge" || plan.formation === "dispersed" ? squadSp * 0.55 : 0;
    const trailAnchor = passTarget(w, add(anchorBase, add(scale(dir, -squadSp), scale(perp, lateral))), anchorBase);
    const trailLeader = trailTeam.leaderId ? sim.unit(trailTeam.leaderId) : undefined;
    placeTeam(w, t, plan, trailTeam, trailLeader ?? null, trailAnchor, dir, perp, teamSp, false);
  }

  // Squad governor: the navigator waits whenever the element strings out, so the
  // teams stay together. Everyone routes terrain-aware, so the tail closes up.
  let tail = 0;
  for (const m of members) tail = Math.max(tail, dist(m.pos, nav.pos));
  const squadMaxLen = squadSp * 2 + teamSp * 3 + 22; // generous slack so it paces, not stutters
  // Hold to keep the squad together, but never freeze: a man who's only lagging
  // closes up in seconds, while a genuinely separated straggler (e.g. left across
  // an obstacle after a fight) would otherwise stall the patrol forever — so after
  // a long wait the point man pushes on and the straggler rejoins by chasing.
  const wantHold = tail > squadMaxLen;
  t.holdTimer = wantHold ? (t.holdTimer ?? 0) + dt : 0;
  nav.formationHold = wantHold && (t.holdTimer ?? 0) < 60;
  if (nav.formationHold) nav.faceLock = nav.facing;

  return centroidOf(members);
}

/** Lay an element into a 360° security halt around a point, facing outward. */
export function holdSecurity(w: World, members: Unit[], center: Vec2, radius: number) {
  const n = Math.max(1, members.length);
  members.forEach((m, i) => {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const slot = {
      x: clamp(center.x + Math.cos(a) * radius, 4, w.terrain.worldSize - 4),
      y: clamp(center.y + Math.sin(a) * radius, 4, w.terrain.worldSize - 4),
    };
    m.faceLock = a; // face out
    m.formationHold = false;
    m.brainState = "holding";
    m.path = dist(m.pos, slot) > 2 ? [slot] : [];
  });
}

/** Clear squad-movement locks (back to individual behavior). */
export function releaseFormation(members: Unit[]) {
  for (const m of members) {
    m.faceLock = null;
    m.formationHold = false;
  }
}

/** Members reordered so each fire team is contiguous (teams take ring sectors). */
export function byTeam(w: World, members: Unit[]): Unit[] {
  const sq = buildSquad(w, members);
  const out: Unit[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const u = members.find((m) => m.id === id);
    if (u && !seen.has(id)) {
      out.push(u);
      seen.add(id);
    }
  };
  if (sq.slId) push(sq.slId);
  sq.attachedIds.forEach(push);
  for (const team of sq.teams) team.ids.forEach(push);
  for (const m of members) push(m.id); // anyone left over
  return out;
}

// --------------------------------------------------------------------------- internals

/** Position one fire team around its leader's anchor, by role. */
function placeTeam(
  w: World,
  t: Task,
  plan: FormationPlan,
  team: FireTeamS,
  leaderUnit: Unit | null,
  anchorPos: Vec2,
  dir: Vec2,
  perp: Vec2,
  teamSp: number,
  isLead: boolean
) {
  const sim = w.sim;
  // The lead team's leader is the squad navigator (already steered by the
  // caller); only the trail team's leader needs to be moved to his anchor here.
  if (leaderUnit && !isLead) {
    setSecurity(leaderUnit, t, angle(dir));
    moveToward(w, leaderUnit, passTarget(w, anchorPos, leaderUnit.pos), plan.concealBias);
  }
  const leaderPos = leaderUnit ? leaderUnit.pos : anchorPos;

  const rest = team.ids.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.id !== team.leaderId);
  let riflemen = 0;
  const file = plan.formation === "file";
  rest.forEach((u, k) => {
    let tgt: Vec2;
    let face: number;
    if (file) {
      // single file: stacked behind the leader
      tgt = add(leaderPos, scale(dir, -teamSp * (k + 1)));
      face = k === rest.length - 1 && !isLead ? angle(scale(dir, -1)) : angle(dir);
    } else if (AUTO.has(u.role)) {
      tgt = add(leaderPos, add(scale(dir, -teamSp * 0.7), scale(perp, -teamSp * 0.85))); // left flank (fields of fire)
      face = angle(scale(perp, -1));
    } else if (u.role === "grenadier") {
      tgt = add(leaderPos, add(scale(dir, -teamSp * 0.7), scale(perp, teamSp * 0.85))); // right flank
      face = angle(perp);
    } else {
      // riflemen: point for the lead team, rear security for the trail team
      riflemen++;
      if (isLead && riflemen === 1) {
        tgt = add(leaderPos, scale(dir, teamSp * 0.9)); // out front on point
        face = angle(dir);
      } else {
        tgt = add(leaderPos, scale(dir, -teamSp * (1.4 + 0.5 * riflemen)));
        face = isLead ? angle(dir) : angle(scale(dir, -1)); // trail team's rifleman watches the backtrail
      }
    }
    setSecurity(u, t, face);
    moveToward(w, u, passTarget(w, tgt, leaderPos), plan.concealBias);
  });
}

function placeAttached(
  w: World,
  t: Task,
  plan: FormationPlan,
  ids: string[],
  anchor: Unit,
  anchorPos: Vec2,
  dir: Vec2,
  perp: Vec2,
  teamSp: number
) {
  ids.forEach((id, i) => {
    const a = w.sim.unit(id);
    if (!a || a === anchor) return;
    const tgt = add(anchorPos, add(scale(dir, -teamSp * (0.7 + i * 0.5)), scale(perp, (i % 2 ? 1 : -1) * teamSp * 0.5)));
    setSecurity(a, t, angle(dir));
    moveToward(w, a, passTarget(w, tgt, anchorPos), plan.concealBias);
  });
}

function setSecurity(u: Unit, t: Task, face: number) {
  u.technique = t.technique;
  u.brainState = "moving";
  u.formationHold = false;
  u.faceLock = face;
}

/** Walk a unit to a target — straight if clear, A* around the terrain if not. */
function moveToward(w: World, u: Unit, tgt: Vec2, concealBias: number) {
  if (dist(u.pos, tgt) <= 1.2) {
    u.path = [];
    u.orderTarget = tgt;
    return;
  }
  if (lineClear(w, u.pos, tgt)) {
    u.orderTarget = tgt;
    u.path = [tgt];
  } else if (u.path.length === 0 || !u.orderTarget || dist(u.orderTarget, tgt) > w.terrain.cellSize * 3) {
    w.sim.pathTo(u, tgt, { concealBias });
  }
}

/** Reconstruct the squad's echelon (SL, fire teams, attachments) from a roster. */
function buildSquad(w: World, members: Unit[]): SquadS {
  const attachedIds = members.filter((m) => ATTACHED.has(m.role)).map((m) => m.id);
  const combat = members.filter((m) => !ATTACHED.has(m.role));
  const sl =
    combat.find((m) => m.role === "squad_leader") ??
    combat.find((m) => m.role === "platoon_leader" || m.role === "platoon_sergeant") ??
    null;
  const rest = combat
    .filter((m) => m !== sl)
    .sort((a, b) => canonicalIndex(w, a.id) - canonicalIndex(w, b.id) || (a.id < b.id ? -1 : 1));

  const teams: FireTeamS[] = [];
  for (const m of rest) {
    if (m.role === "team_leader") {
      teams.push({ leaderId: m.id, ids: [m.id] });
    } else {
      if (teams.length === 0) teams.push({ leaderId: null, ids: [] });
      teams[teams.length - 1].ids.push(m.id);
    }
  }
  // A leaderless lead team gets its best scout as de-facto leader/navigator.
  if (teams[0] && !teams[0].leaderId && teams[0].ids.length) teams[0].leaderId = bestScout(w, teams[0].ids);

  let navigatorId: string;
  if (teams[0]?.leaderId) navigatorId = teams[0].leaderId;
  else if (teams[0]?.ids.length) navigatorId = teams[0].ids[0];
  else navigatorId = sl?.id ?? members[0].id;

  return { navigatorId, slId: sl?.id ?? null, teams, attachedIds };
}

function bestScout(w: World, ids: string[]): string {
  let best = ids[0];
  let bestS = -Infinity;
  for (const id of ids) {
    const u = w.sim.unit(id);
    if (!u) continue;
    const s = scoutScore(u);
    if (s > bestS) {
      bestS = s;
      best = id;
    }
  }
  return best;
}

function scoutScore(u: Unit): number {
  let s = u.stealth * 0.6 + u.experience * 0.4;
  if (u.role === "rifleman" || u.role === "team_leader") s += 0.3;
  if (AUTO.has(u.role)) s -= 0.4;
  return s;
}

/** Index of a member in its platoon squad (so fire teams reconstruct in order). */
function canonicalIndex(w: World, id: string): number {
  const squads = w.platoon.squads;
  for (let s = 0; s < squads.length; s++) {
    const i = squads[s].memberIds.indexOf(id);
    if (i >= 0) return s * 100 + i;
  }
  return 9999;
}

/** Quick passability test at a world point. */
function passableAt(w: World, p: Vec2): boolean {
  return w.terrain.passableCell(Math.floor(p.x / w.terrain.cellSize), Math.floor(p.y / w.terrain.cellSize));
}

/**
 * Snap a slot onto passable ground, pulling it toward `fallback` (a position we
 * know is good, e.g. the man's leader). Keeps a follower from being assigned a
 * spot inside a cliff or the wire, which would strand him and stall the squad.
 */
function passTarget(w: World, tgt: Vec2, fallback: Vec2): Vec2 {
  if (passableAt(w, tgt)) return tgt;
  for (let f = 0.5; f < 1; f += 0.25) {
    const p = { x: tgt.x + (fallback.x - tgt.x) * f, y: tgt.y + (fallback.y - tgt.y) * f };
    if (passableAt(w, p)) return p;
  }
  return fallback;
}

/** Is the straight segment a→b passable the whole way (cheap, for slot moves). */
function lineClear(w: World, a: Vec2, b: Vec2): boolean {
  const cs = w.terrain.cellSize;
  const d = dist(a, b);
  const steps = Math.max(1, Math.ceil(d / cs));
  for (let k = 1; k <= steps; k++) {
    const tt = k / steps;
    if (!passableAt(w, { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt })) return false;
  }
  return true;
}

/** 0 = restrictive (thick concealment), 1 = open ground, sampled around a point. */
function terrainOpenness(w: World, p: Vec2): number {
  let c = w.terrain.concealAt(p.x, p.y);
  let n = 1;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
    const q = add(p, fromAngle(a, 18));
    c += w.terrain.concealAt(q.x, q.y);
    n++;
  }
  return clamp01(1 - (c / n) * 1.2);
}

/** Does the element expect to make contact (drives dispersion & weapons posture). */
function expectsContact(w: World, t: Task, center: Vec2): boolean {
  if (t.missionType === "ambush" || t.missionType === "cordon" || t.missionType === "recon") return true;
  if (w.isNight()) return true;
  if (w.secondsSinceContact() < 600) return true;
  if (w.state.enemyHeat > 0.5) return true;
  const v = w.nearestVillage(center, 220);
  return !!(v && v.attitude < 0);
}
