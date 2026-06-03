import { clamp, clamp01 } from "../rng";
import { Vec2, dist, sub, add, scale, norm, len, fromAngle, angle } from "../vec";
import { findPath } from "../path";
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

  // The lead team's leader navigates the terrain. Re-path only when the objective
  // actually changes — the mover owns continuation and getting un-stuck (its stall
  // watchdog), so we don't re-issue (and reset it) every tick.
  nav.technique = t.technique;
  nav.brainState = "moving";
  nav.faceLock = null;
  nav.formationHold = false;
  if (!nav.pathGoal || dist(nav.pathGoal, target) > 8) {
    sim.pathTo(nav, target, { concealBias: plan.concealBias, roadBias: plan.roadBias });
  }

  // Record where the point man actually walks. The rest of the squad moves in
  // TRACE along this breadcrumb — each man keeps to the leader's real route through
  // the terrain — instead of chasing geometric slots hung off the leader's
  // instantaneous heading (which made the whole formation swing like a turnstile
  // every time he turned). Lateral offsets that open the file into a fire-team
  // wedge are taken relative to the local trail tangent, so they stay smooth.
  recordTrail(t, nav);
  const ahead = nav.path.length ? nav.path[0] : target;
  let headDir = norm(sub(ahead, nav.pos));
  if (len(headDir) < 1e-3) headDir = fromAngle(nav.facing);

  // Corridor-aware width: sense how much passable ground there is to each side of the
  // point man, across his line of travel, and collapse the formation's lateral spread
  // to fit. In the open the squad rides a full fire-team wedge; threading the benched
  // track around the wire (or a draw) the wedge smoothly closes to single file — the
  // physical reason a column narrows at a choke — so the flank men stop being shoved
  // into the wall. This is continuous, not a discrete "now file" switch.
  const navPerp = { x: -headDir.y, y: headDir.x };
  const corridor = freeWidth(w, nav.pos, navPerp);
  const widthScale = clamp01((corridor - 6) / 14); // ~0 in a 6 m slot, full at ≥20 m

  const slots = squadSlots(w, sq, plan);
  let lag = 0; // how far the most-behind man has fallen from his assigned slot
  for (const s of slots) {
    const u = sim.unit(s.id);
    if (!u || u === nav) continue;
    const { tan } = trailPoint(t, nav.pos, headDir, s.back);
    const perp = { x: -tan.y, y: tan.x };
    const face =
      s.face === "rear" ? angle(scale(tan, -1)) : s.face === "left" ? angle(scale(perp, -1)) : s.face === "right" ? angle(perp) : angle(tan);
    setSecurity(u, t, face);
    driveFollower(w, t, nav, u, headDir, s.back, s.lat * widthScale);
    lag = Math.max(lag, dist(u.pos, u.pathGoal ?? u.pos));
  }

  // Smooth pace governor: the point man eases off the throttle when a man has fallen
  // well behind his slot, so the teams close back up — but he never plants his feet
  // (floor 0.3×). After ~18 s of waiting his patience runs out and he pushes on, so a
  // man genuinely hung up is left to chase and rejoin rather than freezing the patrol.
  // Lag is measured man-to-slot, NOT nav-to-tail: a file legitimately wrapped around
  // the COP ring spans a long straight-line distance while everyone is perfectly in
  // place, and the old nav-to-tail test mistook that for "strung out" and throttled
  // the navigator to a crawl, so he never finished rounding the wall.
  const slowZone = plan.spacing * 2.5;
  let slow = clamp01((lag - slowZone) / (slowZone * 1.5));
  t.holdTimer = slow > 0 ? (t.holdTimer ?? 0) + dt : 0;
  slow *= clamp01(1 - ((t.holdTimer ?? 0) - 18) / 30);
  nav.paceScale = 1 - 0.7 * slow;

  return centroidOf(members);
}

/**
 * Move the element as a single tight file — everyone bunched up behind the point
 * man at a small interval, no echelon, no flanks. This is how a squad pours
 * through a choke like the COP gate: fluid and close, not trying to hold a wide
 * formation in a 25 m gap. Bunching is welcome; only a genuine separation eases
 * the lead off, and only briefly.
 */
export function steerFile(w: World, t: Task, members: Unit[], target: Vec2, spacing: number, dt: number): Vec2 {
  const sim = w.sim;
  if (members.length === 0) return centroidOf(members);
  const sq = buildSquad(w, members);
  const nav = sim.unit(sq.navigatorId);
  if (!nav) return centroidOf(members);
  t.leadId = sq.navigatorId;

  nav.technique = t.technique;
  nav.brainState = "moving";
  nav.faceLock = null;
  nav.formationHold = false;
  if (!nav.pathGoal || dist(nav.pathGoal, target) > 10) sim.pathTo(nav, target, { roadBias: 0.35 });

  const ordered = byTeam(w, members).filter((u) => u !== nav);
  let prev = nav;
  for (const f of ordered) {
    const toPrev = sub(prev.pos, f.pos);
    const d = len(toPrev);
    const pdir = d > 1e-3 ? scale(toPrev, 1 / d) : fromAngle(nav.facing);
    const tgt = add(prev.pos, scale(pdir, -spacing));
    f.technique = t.technique;
    f.brainState = "moving";
    f.formationHold = false;
    f.paceScale = 1;
    f.faceLock = null; // face the way you're walking through the gate
    f.pathGoal = tgt;
    if (dist(f.pos, tgt) > 1.0) {
      // walk to the slot if clear, else fall in directly behind the man ahead
      // (on cleared ground) — no per-follower A*.
      f.orderTarget = lineClear(w, f.pos, tgt) ? tgt : { ...prev.pos };
      f.path = [f.orderTarget];
    } else {
      f.path = [];
    }
    prev = f;
  }

  // The gate file is a short, transient pour through a choke: bunching and
  // stringing out are both fine and expected (the file naturally spans muster to
  // the gate). The point man drives straight out at full pace — throttling him
  // here only stalls the egress — and the squad governor closes the element up
  // again the moment it's through the wire and back in formation.
  nav.paceScale = 1;
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
    m.paceScale = 1;
    m.brainState = "holding";
    m.pathGoal = slot; // so a man who's reached his sector doesn't re-plan every tick
    m.path = dist(m.pos, slot) > 2 ? [slot] : [];
  });
}

/** Clear squad-movement locks (back to individual behavior). */
export function releaseFormation(members: Unit[]) {
  for (const m of members) {
    m.faceLock = null;
    m.formationHold = false;
    m.paceScale = 1;
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

/** A man's place in the moving echelon, expressed relative to the leader's trail. */
interface Slot {
  id: string;
  back: number; // metres behind the navigator along his breadcrumb (negative = ahead, on point)
  lat: number; // metres lateral of the route (+ = right of travel)
  face: "fwd" | "left" | "right" | "rear";
}

/**
 * Lay out the squad's echelon as trail-relative slots: a distance back along the
 * point man's route, a lateral offset that opens the file into a fire-team wedge
 * in the open (and collapses to zero in restrictive country), and a security
 * sector to scan. The lead team forms on the navigator with a man on point; the
 * squad leader and his attachments control from the centre; the trail team brings
 * up the rear, offset to a flank in open formations and watching the backtrail.
 */
function squadSlots(w: World, sq: SquadS, plan: FormationPlan): Slot[] {
  const interval = plan.spacing;
  const file = plan.formation === "file" || plan.formation === "column";
  const width = file ? 0 : plan.formation === "wedge" ? interval * 0.85 : interval * 1.25;
  const gap = Math.max(interval * 2.0, 14); // along-trail gap between lead team, SL and trail team
  const slots: Slot[] = [];

  if (sq.teams[0]) addTeamSlots(w, slots, sq.teams[0], 0, 0, interval, width, file, true);

  if (sq.slId && sq.slId !== sq.navigatorId) {
    slots.push({ id: sq.slId, back: gap, lat: file ? 0 : width * 0.25, face: "fwd" });
  }
  sq.attachedIds.forEach((id, i) => {
    slots.push({ id, back: gap + interval * (0.7 + i * 0.5), lat: file ? 0 : (i % 2 ? 1 : -1) * width * 0.4, face: "fwd" });
  });

  if (sq.teams[1]) {
    const open = plan.formation === "wedge" || plan.formation === "dispersed";
    addTeamSlots(w, slots, sq.teams[1], gap * 1.8, open ? width * 0.9 : 0, interval, width, file, false);
  }
  return slots;
}

/** Add one fire team's members as slots around its leader's place on the trail. */
function addTeamSlots(
  w: World,
  slots: Slot[],
  team: FireTeamS,
  teamBack: number,
  teamLat: number,
  interval: number,
  width: number,
  file: boolean,
  isLead: boolean
) {
  // The lead team's leader IS the navigator (the head of the trail), so he's never
  // a slot; the trail team's leader sits at the team's base.
  if (team.leaderId && !isLead) slots.push({ id: team.leaderId, back: teamBack, lat: teamLat, face: "fwd" });
  const rest = team.ids.filter((id) => id !== team.leaderId);
  let riflemen = 0;
  rest.forEach((id, k) => {
    const u = w.sim.unit(id);
    const role = u ? u.role : "rifleman";
    let back: number;
    let lat: number;
    let face: Slot["face"];
    if (file) {
      back = teamBack + interval * (k + 1);
      lat = teamLat;
      face = !isLead && k === rest.length - 1 ? "rear" : "fwd"; // tail-end Charlie watches the backtrail
    } else if (AUTO.has(role)) {
      back = teamBack + interval * 0.7;
      lat = teamLat - width; // automatic rifleman on the left, fields of fire out
      face = "left";
    } else if (role === "grenadier") {
      back = teamBack + interval * 0.7;
      lat = teamLat + width; // grenadier on the right
      face = "right";
    } else {
      riflemen++;
      if (isLead && riflemen === 1) {
        back = teamBack - interval * 0.9; // lead team's rifleman walks point, out front
        lat = 0;
        face = "fwd";
      } else {
        back = teamBack + interval * (1.4 + 0.5 * riflemen);
        lat = teamLat * 0.6;
        face = isLead ? "fwd" : "rear";
      }
    }
    slots.push({ id, back, lat, face });
  });
}

const TRAIL_STEP = 2.5; // metres between recorded breadcrumb points
const TRAIL_MAX = 170; // metres of route kept behind the point man

/** Append the navigator's position to the squad's breadcrumb, trimming the tail. */
function recordTrail(t: Task, nav: Unit) {
  if (t.trailLeadId !== nav.id || !t.trail) {
    t.trail = [{ ...nav.pos }];
    t.trailLeadId = nav.id;
    return;
  }
  const tr = t.trail;
  const last = tr[tr.length - 1];
  if (!last || dist(last, nav.pos) >= TRAIL_STEP) tr.push({ ...nav.pos });
  let total = 0;
  for (let i = tr.length - 1; i > 0; i--) {
    total += dist(tr[i], tr[i - 1]);
    if (total > TRAIL_MAX) {
      tr.splice(0, i);
      break;
    }
  }
}

/**
 * The point on the breadcrumb `back` metres behind the navigator, with the forward
 * tangent there. Negative `back` is ahead of him — extrapolated along his heading
 * (the point man walks out in front of where the leader has been). If the trail is
 * shorter than `back`, the slot is extended backward along its oldest tangent.
 */
function trailPoint(t: Task, headPos: Vec2, headDir: Vec2, back: number): { pt: Vec2; tan: Vec2 } {
  const tr = t.trail;
  if (back <= 0 || !tr || tr.length === 0) return { pt: add(headPos, scale(headDir, -back)), tan: headDir };
  let remaining = back;
  let cur = headPos;
  for (let i = tr.length - 1; i >= 0; i--) {
    const p = tr[i];
    const seg = sub(cur, p);
    const segLen = len(seg);
    if (segLen < 1e-6) {
      cur = p;
      continue;
    }
    if (remaining <= segLen) {
      const f = remaining / segLen;
      return { pt: { x: cur.x - seg.x * f, y: cur.y - seg.y * f }, tan: scale(seg, 1 / segLen) };
    }
    remaining -= segLen;
    cur = p;
  }
  const tan = tr.length >= 2 ? norm(sub(tr[1], tr[0])) : headDir;
  return { pt: add(cur, scale(tan, -remaining)), tan };
}

function setSecurity(u: Unit, t: Task, face: number) {
  u.technique = t.technique;
  u.brainState = "moving";
  u.formationHold = false;
  u.paceScale = 1;
  u.faceLock = face;
}

/**
 * Drive a follower to its formation slot by TRACING the navigator's recorded route,
 * not beelining at the slot. The slot is a point `back` metres behind the point man
 * along his breadcrumb, offset `lat` to the side; the follower's path is the run of
 * breadcrumb points from where it currently is, forward to that slot, each nudged to
 * the side by `lat` (and clamped onto passable ground). Because the breadcrumb is
 * literally ground the point man already walked, the follower is guaranteed a
 * walkable route around big obstacles (the COP ring, a draw) — local steering only
 * has to handle the small stuff. The lateral nudge opens the file into a fire-team
 * wedge in the open and collapses to single file where the corridor is tight (the
 * clamp pulls the offset back onto the trail). No per-follower A*.
 */
function driveFollower(w: World, t: Task, nav: Unit, u: Unit, headDir: Vec2, back: number, lat: number) {
  const tr = t.trail;
  // The exact slot point (used as the final waypoint and the pathGoal).
  const sp = trailPoint(t, nav.pos, headDir, back);
  const perp = { x: -sp.tan.y, y: sp.tan.x };
  const slot = passTarget(w, add(sp.pt, scale(perp, lat)), sp.pt);
  u.pathGoal = slot;
  if (dist(u.pos, slot) <= 1.2) {
    u.path = [];
    return;
  }
  // Men on or ahead of the point man (back <= 0, e.g. the man on point) have no
  // breadcrumb to trace — they extrapolate straight off his heading.
  if (back <= 0 || !tr || tr.length < 3) {
    u.orderTarget = slot;
    u.path = [slot];
    return;
  }
  // Nearest breadcrumb index to the follower (where it joins the route).
  let nIdx = 0;
  let nBest = Infinity;
  for (let i = 0; i < tr.length; i++) {
    const d = dist(u.pos, tr[i]);
    if (d < nBest) {
      nBest = d;
      nIdx = i;
    }
  }
  // Slot index: walk back from the head (newest) accumulating arc length until we
  // reach `back` metres — that breadcrumb point is where the slot sits.
  let arc = dist(nav.pos, tr[tr.length - 1]);
  let sIdx = tr.length - 1;
  for (let i = tr.length - 1; i > 0; i--) {
    const seg = dist(tr[i], tr[i - 1]);
    if (arc + seg >= back) {
      sIdx = i;
      break;
    }
    arc += seg;
    sIdx = i - 1;
  }
  // Path = breadcrumb points from just ahead of the follower up to the slot, each
  // offset to the side; then the exact slot point.
  const path: Vec2[] = [];
  for (let i = nIdx + 1; i <= sIdx; i++) {
    const a = tr[Math.max(0, i - 1)];
    const b = tr[Math.min(tr.length - 1, i + 1)];
    const tang = norm(sub(b, a));
    const pp = { x: -tang.y, y: tang.x };
    path.push(passTarget(w, add(tr[i], scale(pp, lat)), tr[i]));
  }
  path.push(slot);

  // Rejoin: if a wall stands between the follower and the start of its trace (it's
  // still inside the wire while the squad has filed out, so every breadcrumb point is
  // across the HESCO), tracing only grinds it against the wall. Hand it a real A* route
  // to catch up, then resume tracing once it's back on the leader's wake. A man still
  // inside the wire rejoins THROUGH THE GATE (always a clean egress) rather than toward
  // his slot directly — routing straight at a slot on the far side of the outpost can't
  // be solved by the coarse pathfinder and would leave him orbiting the inner wall.
  if (!lineClear(w, u.pos, path[0])) {
    const wire = w.terrain.cop.radius * w.terrain.cellSize;
    // "Inside the wire" means inside the wall ring (the wall occupies the band just
    // below `wire`); a man on the perimeter track outside it rejoins toward his slot,
    // not back through the gate.
    const rejoinTo = dist(u.pos, w.copWorld()) < wire - 14 ? w.gateOutsideWorld() : slot;
    if (u.path.length === 0 || !lineClear(w, u.pos, u.path[0])) {
      u.path = findPath(w.terrain, u.pos, rejoinTo, { roadBias: 0.3 });
    }
    u.orderTarget = u.path[0] ?? rejoinTo;
    return;
  }
  u.orderTarget = path[0];
  u.path = path;
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
 * Passable width (m) across `perp` through `pos` — how much room the squad has to
 * spread to either side of the line of travel. Probes out each way until it hits
 * impassable ground (the wire, a cliff), capped at MAX_HALF each side.
 */
const MAX_HALF = 18;
function freeWidth(w: World, pos: Vec2, perp: Vec2): number {
  let left = 0;
  let right = 0;
  for (let s = 1; s <= MAX_HALF; s++) {
    if (!passableAt(w, { x: pos.x - perp.x * s, y: pos.y - perp.y * s })) break;
    left = s;
  }
  for (let s = 1; s <= MAX_HALF; s++) {
    if (!passableAt(w, { x: pos.x + perp.x * s, y: pos.y + perp.y * s })) break;
    right = s;
  }
  return left + right;
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
