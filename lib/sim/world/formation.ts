import { clamp, clamp01, RNG } from "../rng";
import { Vec2, dist, sub, add, scale, norm, len, dot, fromAngle, angle, angleDiff } from "../vec";
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

export interface FireTeamS {
  leaderId: string | null; // team leader (null if no NCO present)
  ids: string[]; // all team members incl. the leader
}

export interface SquadS {
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

  // The doctrinal "5 and 10": ~5 m between individual men, opened "to the limit of
  // control" in the open and closed down in restrictive ground. The old ladder (patrol 9 m)
  // marched the squad strung-out and gappy on a top-down view; this lands the working
  // interval at ~5 m in this valley — men close enough to keep eyes on their team leader.
  let spacing =
    tech === "crawl" ? 3.5 : tech === "concealed" ? 4.5 : tech === "tactical" ? 5 : tech === "patrol" ? 5.5 : tech === "traveling" ? 7 : 8.5;
  if (expect) spacing *= 1.3; // open the interval up when contact is likely
  if (open < 0.4) spacing *= 0.78; // close it down in restrictive terrain for control
  // Reduced visibility closes the interval (FM 3-21.8: keep visual contact with the man
  // ahead) — at night, and harder still in rain/fog/snow, the file visibly tightens up.
  if (w.isNight()) spacing *= 0.8;
  const wl = w.state.weather.label;
  if (wl === "Rain" || wl === "Snow" || wl === "Fog") spacing *= 0.88;
  spacing = clamp(spacing, 4, 12);

  // Formation choice. This valley is close, broken ground end to end — draws, benches,
  // the wire, terraced fields — and on close ground a foot squad moves in FILE: a single
  // snaking column on the leader's exact track, the only shape that fits a trail or a
  // wash without shouldering the flank men into the terrain beside it. That is also the
  // doctrinal default for restrictive terrain. (Open-ground wedges/echelons, where teams
  // spread abreast, are intentionally not used here yet — holding a lateral interval over
  // this ground reliably wedged the flankers into walls and stalled the element; a
  // terrain-fitted wedge is a future enhancement. The squad still opens and closes along
  // the column with the corridor, paces for the rear, and sets up all-round on the objective.)
  let formation: Formation;
  if ((tech === "traveling" || tech === "rush") && !expect)
    formation = "column"; // admin march, contact not expected — same single track, faster
  else formation = "file";
  void open; // openness no longer selects the formation, but still informs spacing above

  let concealBias = tech === "concealed" ? 0.72 : tech === "tactical" ? 0.38 : 0;
  if (seeking) concealBias = Math.max(concealBias, 0.42);

  // A presence patrol RIDES the graded network now that the connectivity guard guarantees a
  // continuous gate->village Track (terrain.ensureNetworkConnectivity): Track is moveCost 0.96 vs
  // 0.2-0.6 cross-country, so riding it is ~2x faster and is what lets far villages actually be
  // reached in a tactical window. (Pre-guard this bias was inert — there was no continuous track to
  // ride; with the carved lanes it becomes the second movement lever after the fatigue retune.)
  let roadBias = tech === "rush" ? 0.72 : tech === "traveling" ? 0.62 : tech === "patrol" ? 0.55 : tech === "tactical" ? 0.2 : 0;
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
  let lag = 0; // metres the most-behind man trails his slot, MEASURED ALONG THE WAKE
  let wedgedLag = 0; // worst lag among followers who are ACTUALLY blocked this tick (stuck on a
                     // building / the wire / broken ground) — the men the point man WAITS for
  for (const s of slots) {
    const u = sim.unit(s.id);
    if (!u || u === nav) continue;
    const { tan } = trailPoint(t, nav.pos, headDir, Math.max(0, s.back));
    const perp = { x: -tan.y, y: tan.x };
    const face =
      s.face === "rear" ? angle(scale(tan, -1)) : s.face === "left" ? angle(scale(perp, -1)) : s.face === "right" ? angle(perp) : angle(tan);
    setSecurity(u, t, face);
    const followLag = driveFollower(w, t, nav, u, headDir, s.back, s.lat * widthScale);
    lag = Math.max(lag, followLag);
    // A follower who is genuinely WEDGED this tick (blockedTimer>0 — stuck on a COP b-hut, the
    // HESCO wire, or broken ground) AND trailing is one the point man HOLDS for (below), as
    // distinct from a merely-slow climber. (The old `blockedTimer > 6` exclusion here was dead
    // code: watchStall resets blockedTimer at STALL_WINDOW=2s, so >6 never fired.)
    if ((u.blockedTimer ?? 0) > 0) wedgedLag = Math.max(wedgedLag, followLag);
  }

  // Pace governor (continuous — a squad NEVER abandons cohesion): the point man eases the
  // throttle the further the rearmost man trails his slot, and opens back up the instant the
  // element closes up. Lag is the man's shortfall ALONG THE WAKE — the arc he still has to
  // walk to reach his slot — not a straight-line distance, so a file legitimately wrapped
  // around the COP ring (long straight-line span, everyone in place) reads as zero lag.
  // FLOOR raised 0.2×→0.6× and the slow-zone widened (movement RC#2): on a long cliff detour
  // the file is chronically strung out, and a 0.2× floor throttled the WHOLE march to a crawl
  // — so a reachable village arrived only after the harness window and was mislabeled "stuck".
  // 0.6× keeps the element together without collapsing the advance to a near-stop.
  // The slow-zone is decoupled from the (now tighter, ~5 m) interval and floored at 15 m:
  // a 9-man file is naturally ~30 m long, so braking the moment a man trailed 1.8×spacing
  // (≈9 m) had the point man chronically throttling on a normally-strung column (throt% 40-60%).
  // Only ease once the rearmost is genuinely lagging his slot, and never below 0.65× — a squad
  // eases to stay together, it doesn't crawl.
  // Two-stage governor. MODERATE lag → a gentle ease (floor 0.65) so a normally-strung march
  // isn't throttled to a crawl. EXTREME lag → a firmer brake so the point man genuinely WAITS
  // for a straggler who's fallen way back (e.g. a man who cleared the gate late), instead of
  // marching on and leaving a 200 m gap in the file. `lag` is the rearmost man's shortfall
  // ALONG THE WAKE (arc to his slot), so a file legitimately wrapped around a cliff — everyone
  // in place — reads as ~0 and is never braked; only a genuine straggler trips the firm brake.
  const slowZone = Math.max(plan.spacing * 2.0, 15);
  const slow = clamp01((lag - slowZone) / (slowZone * 2.0));
  const farLag = clamp01((lag - slowZone * 3) / (slowZone * 3)); // engages only when truly strung out
  nav.paceScale = (1 - 0.35 * slow) * (1 - 0.55 * farLag); // ~0.65 floor normally, down to ~0.29 when badly strung

  const clock = w.state.clock;

  // WEDGE-WAIT — the missing behaviour the owner flagged ("he just keeps going ... unrealistically far
  // forward"). The pace governor only EASES the point man (floor ~0.29, never a stop), so when a follower
  // snags on a COP b-hut, the wire, or broken ground the lead marches away and the file strings out. Here
  // the point man instead TAKES A KNEE and holds (formationHold => halt(), a real stop that bypasses the
  // never-freeze march floor) whenever a genuinely WEDGED follower (blockedTimer>0) has fallen behind. It
  // is clock-latched and cooldown-bounded, so a single pathologically stuck man can never freeze the
  // patrol — he re-paths free in ~2s, and the cooldown resumes the march regardless. Gated on being
  // BLOCKED (not merely slow): a spent straggler on a long climb is never blocked, so this never fires
  // there and cannot reintroduce the far-village slow-failure the pace-floor prevents (issue 031 — that
  // cohesion is still paid from the trail by the hustle). Pure clock/geometry → deterministic.
  // Trigger on EITHER a genuinely wedged straggler (transient — stuck on something) OR a badly
  // strung file (large along-wake lag with no active wedge — a man simply left behind). Both are
  // bounded by HOLD_BUDGET per leg so the arrival can't slip out of the tactical window.
  const strung = wedgedLag > WEDGE_WAIT_GAP || lag > COHESION_HALT_GAP;
  if (!WEDGE_WAIT_OFF && strung && (t.wedgeHeldTotal ?? 0) < HOLD_BUDGET) {
    if ((t.wedgeHoldUntil ?? 0) > clock) {
      nav.formationHold = true; // holding the knee
      t.wedgeHeldTotal = (t.wedgeHeldTotal ?? 0) + dt; // spend the per-leg budget
    } else if ((t.wedgeCooldownUntil ?? 0) <= clock) {
      t.wedgeHoldUntil = clock + WEDGE_HOLD;
      t.wedgeCooldownUntil = clock + WEDGE_COOLDOWN;
    }
  }

  // Escalation-of-force feel: ease the throttle (never a dead stop) if an unalarmed civilian
  // is on the patrol's track just ahead — let him clear rather than barging through. Pure
  // throttle (no re-path), so cohesion and the stall watchdog are untouched; clears the
  // instant the lane is empty.
  if (civAhead(w, nav, headDir)) nav.paceScale = Math.min(nav.paceScale, 0.6);

  // POINT-MAN CAUTION: he reads the ground AHEAD, not just underfoot. Sample the
  // corridor 6/12/18 m up his planned route; when it pinches hard relative to here he
  // eases off — and at the mouth of a true choke (<5 m) he halts one beat (the raised
  // fist), the file accordioning in behind him, before leading through. One beat per
  // choke (clock-latched + cooldown), never on an admin traveling march. Pure terrain
  // reads — no rng, no re-path, the stall watchdog untouched.
  if (plan.expectContact || t.technique === "patrol" || t.technique === "tactical") {
    let aheadMin = Infinity;
    for (const d of [6, 12, 18]) {
      const p = aheadOnPath(nav, d);
      const dir2 = norm(sub(p, nav.pos));
      const perp2 = len(dir2) > 1e-3 ? { x: -dir2.y, y: dir2.x } : navPerp;
      aheadMin = Math.min(aheadMin, freeWidth(w, p, perp2));
    }
    if (aheadMin < corridor * 0.6) nav.paceScale = Math.min(nav.paceScale, 0.7);
    if ((t.chokeHoldUntil ?? 0) > clock) {
      nav.formationHold = true; // the held beat at the mouth
    } else if (aheadMin < 5 && corridor >= 5 && (t.chokeCooldownUntil ?? 0) <= clock) {
      t.chokeHoldUntil = clock + 2.5;
      t.chokeCooldownUntil = clock + 90;
    }
  }

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

/** Below this gap to his sector a man is "in place" — he settles and stops re-pathing.
 *  Kept above moveUnit's 1.2 m waypoint-arrival epsilon so "arrived" is stable (a man
 *  parked just shy of his slot doesn't get handed a fresh one-waypoint path every tick
 *  and re-aim — the old source of the on-station dither). */
const SETTLE_IN = 1.5;

/**
 * Lay an element into a 360° security halt — the cigar/hasty-perimeter the way a real
 * squad occupies one. Two things make it read right instead of a clown-car pile-up:
 *
 *  1. NEAR-SIDE OCCUPATION. Slots are NOT handed out by roster index (which routinely
 *     ordered a man on the east to walk to the west slot, straight through the other
 *     eight — the "stuck on each other in a 360" the player saw). Instead each man takes
 *     the ring sector NEAREST the bearing he's already on: we lay n evenly-spaced outward
 *     slots and rotate that ring against the men (sorted by their current bearing from
 *     center) to minimize total angular travel. For points on a circle that pairing is
 *     crossing-free — everyone peels to his own side.
 *  2. COMMAND IN THE CENTER. The squad leader and any attachments (medic/RTO/terp) hold
 *     the inside of the cigar — they control from within the perimeter, which also thins
 *     the ring so the security men get a clean ~45° interval and full 360° coverage.
 *
 * Each ring slot is nudged a little off the geometric ideal per man (so the circle isn't
 * a machined lattice), snapped onto passable ground, and biased onto nearby cover — a man
 * sets up behind the wall/rock/ditch he can see, not on an open arc. The assignment is
 * cached on the task and reused across a contact flicker so the element doesn't reshuffle
 * its whole perimeter every time someone ducks.
 */
export function holdSecurity(w: World, members: Unit[], center: Vec2, radius: number, t?: Task) {
  if (members.length === 0) return;
  radius = fitRadius(w, center, radius); // occupy what the ground gives — shrink to fit broken terrain
  const sq = buildSquad(w, members);
  const inner = new Set<string>();
  if (sq.slId) inner.add(sq.slId);
  sq.attachedIds.forEach((id) => inner.add(id));
  const ring = members.filter((m) => !inner.has(m.id));
  const cmd = members.filter((m) => inner.has(m.id));

  // --- the security ring: bearing-optimal, no-crossing assignment ---
  const n = ring.length;
  if (n > 0) {
    const bm = ring
      .map((u) => ({ u, a: Math.atan2(u.pos.y - center.y, u.pos.x - center.x) }))
      .sort((p, q) => p.a - q.a);
    const slotA = Array.from({ length: n }, (_, k) => (k / n) * Math.PI * 2);
    // rotate the slot ring against the men to minimize total angular travel (≤ n² ops)
    let bestR = 0;
    let bestCost = Infinity;
    for (let r = 0; r < n; r++) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += Math.abs(angleDiff(bm[i].a, slotA[(i + r) % n]));
      if (cost < bestCost) {
        bestCost = cost;
        bestR = r;
      }
    }
    for (let i = 0; i < n; i++) {
      const u = bm[i].u;
      const h = hashUnit01(u.id);
      const h2 = hashUnit01(u.id + "r");
      const aBase = slotA[(i + bestR) % n];
      const a = aBase + (h - 0.5) * 0.32; // ±~9° tangential personality (no machined ring)
      const rad = radius + (h2 - 0.5) * 1.4; // ±0.7 m radial personality
      const ideal = { x: center.x + Math.cos(a) * rad, y: center.y + Math.sin(a) * rad };
      const slot = securitySlot(w, ideal, center);
      placeOnSector(w, u, slot, center, t);
    }
  }

  // --- command element holds the inside of the perimeter ---
  cmd.forEach((u, i) => {
    const a = cmd.length > 1 ? (i / cmd.length) * Math.PI * 2 + 0.5 : bestSectorBias(center);
    const slot = securitySlot(w, { x: center.x + Math.cos(a) * radius * 0.35, y: center.y + Math.sin(a) * radius * 0.35 }, center);
    placeOnSector(w, u, slot, center, t);
  });
}

/** Put one man on his security slot: face outward, settle (don't re-path) if he's already
 *  there, else walk to it — ROUTING AROUND obstacles when the straight line is blocked, so
 *  a man whose sector sits past a wall/rock peels around it instead of grinding the terrain
 *  forever (the broken-ground churn). Cache his sector bearing on the task for stable
 *  re-occupation across a contact flicker. */
function placeOnSector(w: World, u: Unit, slot: Vec2, center: Vec2, t?: Task) {
  let path: Vec2[] = [];
  const straight = dist(u.pos, slot);
  if (straight > SETTLE_IN) {
    path = lineClear(w, u.pos, slot) ? [slot] : findPath(w.terrain, u.pos, slot, { cheapFallback: true });
    // If the assigned sector needs a long detour (cramped/broken ground — a wall or draw
    // between the man and his geometric slot), take a HASTY position on his OWN near side
    // instead of grinding a 60 m loop to the ideal arc. This is what a man actually does:
    // occupy the nearest workable spot facing out, not march across the objective.
    if (path.length === 0 || routeLength(u.pos, path) > straight * 2.0 + 12) {
      slot = hastyPosition(w, u.pos, center, dist(center, slot));
      path = dist(u.pos, slot) <= SETTLE_IN ? [] : lineClear(w, u.pos, slot) ? [slot] : findPath(w.terrain, u.pos, slot, { cheapFallback: true });
    }
  }
  u.faceLock = Math.atan2(slot.y - center.y, slot.x - center.x); // face out of the perimeter
  u.formationHold = false;
  u.paceScale = 1;
  u.brainState = "holding";
  u.pathGoal = slot;
  u.orderTarget = slot;
  u.path = path;
  if (t) (t.ringSlots ??= {})[u.id] = u.faceLock;
}

/** Total length of a polyline route from `start` through `path`. */
function routeLength(start: Vec2, path: Vec2[]): number {
  if (path.length === 0) return 0;
  let total = dist(start, path[0]);
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  return total;
}

/** A hasty all-round position on the man's OWN bearing from the perimeter center, at the
 *  ring radius, snapped onto reachable ground — the near-side spot he can occupy without
 *  crossing the element when his ideal sector is walled off. */
function hastyPosition(w: World, manPos: Vec2, center: Vec2, radius: number): Vec2 {
  const cs = w.terrain.cellSize;
  let dir = sub(manPos, center);
  if (len(dir) < 1e-3) dir = { x: 1, y: 0 };
  dir = norm(dir);
  const p = { x: center.x + dir.x * radius, y: center.y + dir.y * radius };
  const rc = w.terrain.nearestReachable(Math.floor(p.x / cs), Math.floor(p.y / cs), 8);
  return w.terrain.cellCenter(rc.cx, rc.cy);
}

/** A default inward-facing bearing for a lone command man (faces back down the likely
 *  approach axis — toward the center of the map's lower edge as a stable fallback). */
function bestSectorBias(center: Vec2): number {
  return angle({ x: 0 - center.x, y: 0 - center.y }); // toward map origin; deterministic
}

/**
 * Snap a security slot onto passable ground and bias it onto the best nearby cover
 * within a short search — a man digs in behind the wall/rock/ditch he can reach, not on
 * an exposed arc. Falls back toward `center` (known-good ground) if the ideal is blocked.
 */
function securitySlot(w: World, ideal: Vec2, center: Vec2): Vec2 {
  const cs = w.terrain.cellSize;
  let best = ideal;
  let bestScore = -Infinity;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (const r of [0, 2, 4]) {
      const p = { x: ideal.x + Math.cos(a) * r, y: ideal.y + Math.sin(a) * r };
      if (!passableAt(w, p)) continue;
      const score = w.terrain.coverAt(p.x, p.y) * 1.5 - r * 0.12; // prefer cover, mild distance penalty
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  // Guarantee the slot is on ground the element can actually REACH (broken terrain / a
  // cliff edge / the wrong side of a wall), so a man settles on his sector instead of
  // creeping toward an unreachable point forever. nearestReachable keeps it in the gate's
  // connected component — the side the squad is on.
  void center;
  const rc = w.terrain.nearestReachable(Math.floor(best.x / cs), Math.floor(best.y / cs), 8);
  return w.terrain.cellCenter(rc.cx, rc.cy);
}

/** Shrink a security perimeter to the largest radius whose ring is mostly on passable
 *  ground — a squad halting in a draw or against a cliff sets a TIGHTER all-round, it
 *  doesn't hang men over the edge. Returns the desired radius unchanged on open ground. */
function fitRadius(w: World, center: Vec2, want: number): number {
  for (const f of [1, 0.88, 0.76, 0.64, 0.52, 0.42]) {
    const r = want * f;
    let open = 0;
    const N = 24;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      if (passableAt(w, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })) open++;
    }
    if (open / N >= 0.8) return r;
  }
  return want * 0.42;
}

/** Stable per-unit scalar in [0,1) from the unit id — a pure hash (advances no RNG
 *  stream), so every derived bit of "personality" is identical across replays. */
export function hashUnit01(id: string): number {
  return RNG.hashString(id) / 4294967296;
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
  const gap = clamp(interval * 2.2, 10, 14); // inter-team gap (~10-14 m), SL rides between the teams
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
        // The navigator IS the front of the element (he picks the route); the lead scout
        // falls in just off his shoulder, tracing the same wake. (Earlier this man was
        // projected OUT IN FRONT off the leader's heading, which marched him into every
        // wall the leader curved around — he ground terrain the whole patrol.)
        back = teamBack + interval * 0.55;
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

const WAKE_STEP = 3; // metres between the wake waypoints handed to a follower
// ITM_NOMEANDER=1 (env, read ONCE at module load — constant per process, so determinism holds)
// zeroes the per-man meander weave in driveFollower, for the executed-track texture A/B in
// scripts/scratch-route-smoothness.ts. Unset (the app, all gates) is byte-identical behavior.
const NO_MEANDER = typeof process !== "undefined" && process.env?.ITM_NOMEANDER === "1";
// Straggler hustle (cohesion from the trail side — see driveFollower): how far behind his slot a man
// must fall before he picks up the pace, how hard he closes per metre of lag, and the cap (matches
// combat.ts PACE_MAX, the integrator's upper bound on paceScale).
const HUSTLE_LAG = 5; // m behind his slot before he double-times to close
const HUSTLE_GAIN = 0.03; // extra pace per metre of lag beyond HUSTLE_LAG
const HUSTLE_CAP = 1.6; // max catch-up multiplier (a spent man hustles, never sprints)
// Wedge-wait (steerSquad): the point man HOLDS when a genuinely blocked follower trails this far,
// for a bounded beat, then a cooldown resumes the march (never a permanent freeze). Tuned so the
// lead effectively waits (~HOLD of every HOLD+gap seconds) while a man is snagged, without stalling
// the advance once he's free. Wedges are transient (watchStall re-paths at 2s), so a short hold covers most.
const WEDGE_WAIT_GAP = 8; // m a WEDGED follower must trail his slot before the point man takes a knee
const COHESION_HALT_GAP = 26; // m the rearmost man may trail ALONG THE WAKE before the lead halts even
                              // without an active wedge — a badly strung file (a 9-man column is ~30m,
                              // so 26m of slot-lag means the rear is nearly a whole file-length back)
const WEDGE_HOLD = 4; // s the point man holds (a real halt) per wedge beat
const WEDGE_COOLDOWN = 6; // s min between holds — resumes even if the man is still closing (no freeze)
const HOLD_BUDGET = 45; // s of total halt PER LEG (reset each waypoint) — caps the arrival delay so this
                        // can never reproduce the issue-031 slow-failure: 45s is negligible vs the 1500s
                        // tactical window, yet enough to rein a strung file back in on a normal patrol.
// ITM_NOWAIT=1 (env, read ONCE at module load — constant per process, so determinism holds) disables
// the wait, for the A/B in scripts/scratch-village-wedge.ts. Unset (the app, all gates) runs the wait.
const WEDGE_WAIT_OFF = typeof process !== "undefined" && process.env?.ITM_NOWAIT === "1";

/**
 * Drive one follower along the navigator's WAKE, and return how far it trails its slot
 * (arc-length along the wake — the quantity the pace governor uses).
 *
 * A follower's job is to walk the exact ground the point man already walked: that ground
 * is guaranteed traversable (it routes around the COP ring, the draws, the wash banks),
 * so a man handed it can never wedge on terrain, and the squad stays a coherent file. We
 * model him as a bead on the wake — project him onto it to find how far back he is, set
 * his slot a fixed arc behind the leader, then hand him the RUN of wake points from just
 * ahead of him forward to his slot. Because consecutive wake points are ~WAKE_STEP apart
 * on ground the leader cleared, every segment is walkable; the man advances steadily and
 * local steering only has to keep his spacing. This is what the old single-carrot pursuit
 * got wrong — it let a follower's steering pick a wall-ward heading and wedge, stalling
 * the patrol. The lateral wedge offset rides ON the wake (clamped to passable ground and
 * to the sensed corridor), so the file opens to a wedge in the open and never shoulders a
 * man into the wire at a choke.
 */
function driveFollower(w: World, t: Task, nav: Unit, u: Unit, headDir: Vec2, back: number, lat: number): number {
  const tr = t.trail;

  // The man on point (back <= 0) walks OUT IN FRONT of the leader. There's no wake ahead
  // of the navigator, but the navigator HAS a planned route — so the point man leads along
  // THAT (guaranteed-walkable ground the element is about to cross), a few metres up the
  // path, rather than a dead-reckoned point off the heading that would march him straight
  // into the wall the navigator is curving around (the old behavior — one man grinding the
  // terrain the whole patrol).
  if (back <= 0) {
    const aim = aheadOnPath(nav, -back);
    u.pathGoal = aim;
    u.orderTarget = aim;
    u.path = dist(u.pos, aim) > 1.2 ? [aim] : [];
    return 0;
  }

  // Per-soldier interval personality: a stable ±10% on his slot distance, so no two men
  // hold the exact same spacing and the file reads as people rather than a machined lattice.
  // Pure id-hash (advances no RNG stream) → identical across replays.
  back *= 0.9 + 0.2 * hashUnit01(u.id);

  // PERSONAL LINE-PICKING: each man also rides a small GROUND-STABLE lateral weave
  // around the wake — his own amplitude, wavelength and phase, keyed to the terrain
  // position (not the arc), so he picks the same line past the same rock every pass and
  // nine men thread nine slightly different lines instead of one rail. Snapped onto
  // passable ground by the same passTarget clamp as the wedge offset.
  const mA = NO_MEANDER ? 0 : 0.3 + 0.5 * hashUnit01(u.id + "mA");
  const mL = 18 + 12 * hashUnit01(u.id + "mL");
  const mP = Math.PI * 2 * hashUnit01(u.id + "mP");
  const meanderAt = (p: Vec2) => mA * Math.sin(((p.x + p.y) * 0.7071 * Math.PI * 2) / mL + mP);

  const slotSP = trailPoint(t, nav.pos, headDir, back);
  const slotPerp = { x: -slotSP.tan.y, y: slotSP.tan.x };
  // Clamp the wedge offset to the room ACTUALLY available abreast of this man's slot, so
  // the formation opens to a wedge only where the ground is open and collapses to file in
  // a draw or along the wire — instead of shouldering the flank men into terrain (which
  // stalled them and throttled the whole patrol). Most of this valley is tight, so this
  // usually means file.
  if (lat !== 0) {
    const sign = Math.sign(lat);
    let room = 0;
    for (let s = 1; s <= Math.abs(lat) + 2; s++) {
      if (!passableAt(w, { x: slotSP.pt.x + slotPerp.x * sign * s, y: slotSP.pt.y + slotPerp.y * sign * s })) break;
      room = s;
    }
    lat = sign * Math.min(Math.abs(lat), Math.max(0, room - 1.2));
  }
  const slot = passTarget(w, add(slotSP.pt, scale(slotPerp, lat + meanderAt(slotSP.pt))), slotSP.pt);
  u.pathGoal = slot;

  const proj = projectBack(nav.pos, tr, u.pos); // {back, dist} of the man's projection on the wake
  const lag = proj.back - back; // >0 = behind the slot (must advance); <=0 = at/ahead of it
  const offWake = proj.dist > 12 || !tr || tr.length < 2;

  // HUSTLE: a man who has fallen behind his slot picks up the pace to close the interval HIMSELF
  // (FM 3-21.8 — "close it up"), so the element stays together without the point man slowing. Slowing
  // the lead instead misses the objective on a hard far-village climb (the slow-failure, issue 031),
  // so the cohesion is paid from the TRAIL side: the nav holds his floor, the straggler double-times.
  // Capped (combat.ts PACE_MAX) so a spent man hustles, never sprints; clears the instant he's back in
  // his slot (lag ≤ HUSTLE_LAG → 1×). Pure geometry → deterministic.
  u.paceScale = lag > HUSTLE_LAG ? Math.min(HUSTLE_CAP, 1 + (lag - HUSTLE_LAG) * HUSTLE_GAIN) : 1;

  // Rejoin with real pathfinding when he's off the wake — typically still inside the wire
  // while the squad has filed out (every wake point is across the HESCO), or shoved aside
  // in a fight. A man inside the wire rejoins THROUGH THE GATE (the only clean egress);
  // otherwise he routes to his slot, then resumes following once back on the wake.
  if (offWake || (u.blockedTimer && u.blockedTimer > 1.5)) {
    const wire = w.terrain.cop.radius * w.terrain.cellSize;
    const rejoinTo = dist(u.pos, w.copWorld()) < wire - 14 ? w.gateOutsideWorld() : slot;
    if (u.path.length === 0 || !lineClear(w, u.pos, u.path[0])) {
      u.path = findPath(w.terrain, u.pos, rejoinTo, { roadBias: 0.3 });
    }
    u.orderTarget = u.path[0] ?? rejoinTo;
    return Math.max(0, lag);
  }

  if (lag <= 0.8) {
    // At or ahead of the slot — hold and let the leader draw the file forward.
    u.path = [];
    return Math.max(0, lag);
  }

  // Hand him the run of wake points from just ahead of him forward to his slot, each
  // nudged to the side by `lat` for the wedge (clamped onto passable ground). These are
  // real, cleared positions ~WAKE_STEP apart, so every leg is walkable — no wedging.
  const path: Vec2[] = [];
  for (let a = proj.back - WAKE_STEP; a > back; a -= WAKE_STEP) {
    const sp = trailPoint(t, nav.pos, headDir, a);
    const pp = { x: -sp.tan.y, y: sp.tan.x };
    const off = lat + meanderAt(sp.pt);
    path.push(off !== 0 ? passTarget(w, add(sp.pt, scale(pp, off)), sp.pt) : { ...sp.pt });
  }
  path.push(slot);
  u.path = path;
  u.orderTarget = path[0];
  return lag;
}

/** A point `d` metres ahead of the navigator along his PLANNED route (nav.path), so the
 *  man on point leads over ground the element is actually about to walk. Falls back to a
 *  short heading extrapolation only if the navigator has no path left. */
function aheadOnPath(nav: Unit, d: number): Vec2 {
  let remaining = d;
  let cur = nav.pos;
  for (const wp of nav.path) {
    const seg = sub(wp, cur);
    const segLen = len(seg);
    if (segLen < 1e-6) continue;
    if (remaining <= segLen) return { x: cur.x + (seg.x / segLen) * remaining, y: cur.y + (seg.y / segLen) * remaining };
    remaining -= segLen;
    cur = wp;
  }
  // ran past the end of the route — extrapolate the last heading we had
  const head = nav.path.length ? norm(sub(nav.path[nav.path.length - 1], nav.pos)) : fromAngle(nav.facing);
  return add(cur, scale(head, remaining));
}

/**
 * Project a point onto the navigator's wake (the polyline navPos → trail[last] → … →
 * trail[0], newest first) and return how far BEHIND the navigator that projection lies,
 * in arc-length metres, plus the perpendicular distance to the wake. This is what lets a
 * follower be treated as a bead sliding along the leader's actual route.
 */
function projectBack(navPos: Vec2, tr: Vec2[] | undefined, pos: Vec2): { back: number; dist: number } {
  if (!tr || tr.length === 0) return { back: dist(navPos, pos), dist: dist(navPos, pos) };
  let arc = 0;
  let bestDist = Infinity;
  let bestBack = 0;
  let a = navPos;
  for (let i = tr.length - 1; i >= 0; i--) {
    const b = tr[i];
    const seg = sub(b, a);
    const segLen = len(seg);
    if (segLen > 1e-6) {
      // closest point on segment a→b to pos
      const tt = clamp01((dot(sub(pos, a), seg)) / (segLen * segLen));
      const cp = { x: a.x + seg.x * tt, y: a.y + seg.y * tt };
      const d = dist(pos, cp);
      if (d < bestDist) {
        bestDist = d;
        bestBack = arc + tt * segLen;
      }
      arc += segLen;
    }
    a = b;
  }
  return { back: bestBack, dist: bestDist };
}

/** Reconstruct the squad's echelon (SL, fire teams, attachments) from a roster. */
export function buildSquad(w: World, members: Unit[]): SquadS {
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

/** True if an unalarmed civilian is on the patrol's track just ahead of the point man — the
 *  cue to ease the pace and let him clear (escalation of force). A fleeing civ (tier 3) is
 *  already clearing, so it doesn't trip the yield. */
function civAhead(w: World, nav: Unit, headDir: Vec2): boolean {
  for (const c of w.sim.liveCivilians()) {
    if (!c.alive || (c.reactTier ?? 0) >= 3) continue;
    const to = sub(c.pos, nav.pos);
    const fwd = dot(to, headDir);
    if (fwd < 1 || fwd > 14) continue; // within 14 m ahead
    const lateral = Math.abs(to.x * -headDir.y + to.y * headDir.x);
    if (lateral < 4) return true; // within ~4 m of the line of travel
  }
  return false;
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
