import type { World } from "../world/world";
import { Task, SquadSOP, defaultSOP } from "../world/types";
import { buildSquad } from "../world/formation";
import { centroidOf } from "../world/helpers";
import { Unit } from "../entities";
import { getWeapon } from "../weapons";
import { dist, Vec2, norm, sub, add, scale, len } from "../vec";

/**
 * The SQUAD-COMBAT COORDINATOR — the squad leader's tactical brain.
 *
 * Under the "hands-off" model the player never commands a man in a firefight. This
 * function is the squad leader the player used to be: when rounds crack it reads the
 * squad's standing SOP (movement / on-contact drill / ROE) and the tactical picture,
 * then runs a doctrinal battle drill — designating a base-of-fire and a maneuver
 * element, bounding, suppressing, breaking contact, popping smoke — and it always
 * breaks a squad that has become combat-ineffective (the automatic safety).
 *
 * It only DECIDES. It stamps the same per-man intent fields (`rof`, `brainState`,
 * `orderType`, `orderTarget`, `roe`) that `friendlyBrain` already executes each sim
 * tick (cover-seeking, return fire, buddy-aid, the per-man assault bound). It mirrors
 * the state-machine shape of `insurgent.ts`. Invoked from `tickTasks` (world tick),
 * which runs BEFORE `sim.tick`, so the decision lands the same tick the men act on it.
 */

const AUTO_ROLES = new Set(["saw_gunner", "auto_rifleman", "machinegunner"]);
const RECONSIDER = 1.2; // seconds between squad-level reconsiderations (per-man exec is every tick)
const SMOKE_COOLDOWN_S = 28; // game-seconds between squad smoke pops (a screen lasts ~67s)

export function squadFight(w: World, t: Task, members: Unit[], dt: number) {
  const sim = w.sim;
  const sop = t.sop ?? defaultSOP(t.missionType);

  // Per-tick upkeep: push the squad ROE onto every man (the civ-fire gate + fire
  // discipline read it), and drop the march locks — the formation doesn't hold in a fight.
  for (const m of members) {
    if (!m.alive || !m.conscious) continue;
    m.roe = sop.roe;
    m.civGuard = undefined; // let civClear derive the keep-out per weapon from roe
    m.faceLock = null;
    m.formationHold = false;
    m.paceScale = 1;
  }

  // Squad-level decisions are throttled; the per-man brains fill the gaps every tick.
  t.squadTimer = (t.squadTimer ?? 0) - dt;
  const fresh = !t.squadState || NON_COMBAT.has(t.squadState);
  if (!fresh && (t.squadTimer ?? 0) > 0) return; // not time to reconsider yet

  const threat = threatCentroid(sim, members);
  t.threatPt = threat; // surfaced to the map for the base-of-fire/maneuver readability overlay
  const enemyCount = visibleEnemyCount(sim, members);
  // Denominator is the strength assigned at step-off (t.memberIds keeps KIA/evac ids), so the
  // break-safety stays aware of attrition even as casualties are dragged off / MEDEVAC'd.
  const eff = effectiveness(w, members, t.memberIds.length);

  // First contact → orient (react), then choose the working drill on the next pass.
  if (fresh) {
    t.squadState = "react";
    t.squadTimer = w.rng.range(0.9, 1.8);
    t.bofIds = undefined;
    t.mnvrIds = undefined;
    t.rallyPt = undefined;
    stampReact(w, members, threat, sop);
    w.log(`${t.label}: CONTACT — ${enemyCount > 0 ? `enemy to the ${w.bearingDesc(threat)}` : "taking fire"}.`, "contact");
    w.interrupt(`${t.label} IN CONTACT`);
    return;
  }

  // The automatic break-contact safety overrides any SOP: never feed a destroyed
  // element into the fight. (This is why "when to break" is not a player dial.)
  const mustBreak = eff.effFrac < 0.6 || (eff.slDown && eff.effFrac < 0.78) || (eff.effective <= 3 && enemyCount >= eff.effective * 2 && eff.effFrac < 0.72);

  if (mustBreak && t.squadState !== "break") {
    enterBreak(w, t, members, threat, true);
    return;
  }

  switch (t.squadState) {
    case "react": {
      // Orient done — commit to the SOP's standing drill.
      const next =
        sop.contact === "assault" ? "assault" :
        sop.contact === "suppress" ? "suppress" :
        sop.contact === "break" ? "break" : "hold";
      if (next === "break") enterBreak(w, t, members, threat, false);
      else {
        t.squadState = next;
        t.squadTimer = RECONSIDER + w.rng.next() * 0.6;
        if (next === "assault") assignElements(w, t, members, threat);
        runState(w, t, members, threat, enemyCount, eff, sop);
      }
      break;
    }
    case "hold":
    case "suppress":
    case "assault":
    case "break":
      t.squadTimer = RECONSIDER + w.rng.next() * 0.6;
      runState(w, t, members, threat, enemyCount, eff, sop);
      maybeRequestFires(w, t, members, eff, sop);
      break;
    default:
      t.squadState = "react";
      t.squadTimer = 0;
  }
}

const NON_COMBAT = new Set(["garrison", "moving", "idle", "assembling", "holding", "treating", "aiding", ""]);

function runState(w: World, t: Task, members: Unit[], threat: Vec2, enemyCount: number, eff: Eff, sop: SquadSOP) {
  switch (t.squadState) {
    case "hold":
      stampBaseOfFire(w, members, threat, sop, /*suppressEmphasis*/ false);
      break;
    case "suppress":
      stampBaseOfFire(w, members, threat, sop, /*suppressEmphasis*/ true);
      break;
    case "assault":
      stampAssault(w, t, members, threat, sop);
      break;
    case "break":
      stampBreak(w, t, members, threat, sop);
      break;
  }
}

// ───────────────────────────────────────────────────────────── state stamps

/** REACT TO CONTACT: everyone orients on the threat, gets into the nearest cover, and
 *  returns fire as the ROE allows while the leader sizes up the fight. */
function stampReact(w: World, members: Unit[], threat: Vec2, sop: SquadSOP) {
  for (const m of members) {
    if (!m.alive || !m.conscious) continue;
    m.brainState = "holding";
    m.orderType = undefined;
    m.orderTarget = null;
    m.rof = perManRof(m, sop, /*suppress*/ false, /*isAuto*/ AUTO_ROLES.has(m.role));
    seekCover(w, m, threat);
  }
}

/** HOLD / SUPPRESS: fight in place from cover. Automatic weapons build the base of fire
 *  (sustained suppression onto the enemy), riflemen engage PID'd targets. Holds the ground. */
function stampBaseOfFire(w: World, members: Unit[], threat: Vec2, sop: SquadSOP, suppressEmphasis: boolean) {
  for (const m of members) {
    if (!m.alive || !m.conscious) continue;
    const isAuto = AUTO_ROLES.has(m.role);
    const suppress = (isAuto || suppressEmphasis) && sop.roe !== "hold";
    m.brainState = "holding";
    m.orderType = undefined;
    m.rof = perManRof(m, sop, suppress, isAuto);
    // suppressive gunners hose the enemy's position; precise shooters pick targets
    m.orderTarget = m.rof === "suppress" ? { ...threat } : null;
    seekCover(w, m, threat);
  }
}

/** ASSAULT: base-of-fire element pins the enemy while the maneuver element fire-and-moves
 *  onto the objective. The per-man bound (auto-rifle base of fire, riflemen close) is run
 *  by friendlyBrain's assault path; here we set the split, the objective, and screening smoke. */
function stampAssault(w: World, t: Task, members: Unit[], threat: Vec2, sop: SquadSOP) {
  if (!t.bofIds || !t.mnvrIds) assignElements(w, t, members, threat);
  const bof = new Set(t.bofIds ?? []);
  const mnvr = new Set(t.mnvrIds ?? []);
  let screened = false;
  for (const m of members) {
    if (!m.alive || !m.conscious) continue;
    if (bof.has(m.id)) {
      m.brainState = "holding";
      m.orderType = undefined;
      m.rof = sop.roe === "hold" ? "free" : "suppress";
      m.orderTarget = { ...threat };
      seekCover(w, m, threat);
    } else if (mnvr.has(m.id)) {
      // close with the enemy; friendlyBrain runs the fire-and-maneuver bound per man
      m.brainState = "moving";
      m.orderType = "assault";
      m.orderTarget = { ...threat };
      m.rof = perManRof(m, sop, false, AUTO_ROLES.has(m.role)); // honor weapons-hold even while bounding
      // route around walls/terrain (walkTo falls back to A* when the lane is blocked)
      if (m.path.length === 0 && dist(m.pos, threat) > 3) w.sim.walkTo(m, threat);
      // screen the bound with smoke if it crosses open ground (throttled across the squad)
      if (!screened && exposedRun(w, m.pos, threat) && smokeIfNeeded(w, t, m, threat)) screened = true;
    } else {
      // SL + attachments: hold the center, self-defense, ready to consolidate casualties
      m.brainState = "holding";
      m.orderType = undefined;
      m.rof = perManRof(m, sop, false, false);
      m.orderTarget = null;
      seekCover(w, m, threat);
    }
  }
}

/** BREAK CONTACT: the team nearest the enemy lays a base of fire while the rest bound back
 *  to a rally point toward home; pop smoke between the squad and the enemy. Leapfrog each pass. */
function stampBreak(w: World, t: Task, members: Unit[], threat: Vec2, sop: SquadSOP) {
  // LEAPFROG the rally: set it on entry, and once the squad has closed on it (still in
  // contact), bound the rally another ~70 m back toward home. Without this the squad froze
  // at one rally and took fire forever — the break drill never actually disengaged.
  const live = members.filter((m) => m.alive && m.conscious);
  const c = centroidOf(live.length ? live : members);
  if (!t.rallyPt || dist(c, t.rallyPt) < 12) t.rallyPt = rallyPoint(w, members, threat);
  const rally = t.rallyPt;
  // base of fire = the men closest to the enemy (best placed to cover the withdrawal)
  const sorted = [...live].sort((a, b) => dist(a.pos, threat) - dist(b.pos, threat));
  const coverN = Math.max(1, Math.floor(sorted.length / 2));
  const base = new Set(sorted.slice(0, coverN).map((m) => m.id));
  let smoked = false;
  for (const m of live) {
    if (base.has(m.id)) {
      m.brainState = "holding";
      m.orderType = undefined;
      m.rof = sop.roe === "hold" ? "free" : "suppress";
      m.orderTarget = { ...threat };
      seekCover(w, m, threat);
      // screen between the squad and the enemy — only when crossing open ground, throttled
      if (!smoked && exposedRun(w, m.pos, threat) && smokeIfNeeded(w, t, m, threat)) smoked = true;
    } else {
      m.brainState = "withdrawing";
      m.orderType = "withdraw";
      m.orderTarget = { ...rally };
      m.rof = "free"; // fire as they peel if they can
      if (m.path.length === 0 && dist(m.pos, rally) > 4) w.sim.walkTo(m, rally);
    }
  }
}

/** The squad's JTAC/leader calls for fire when the SOP wants it (suppress) or the squad
 *  is pinned and losing ground — the World queues it for the commander's approval. A real FO
 *  obeys two hard rules, both enforced here so the AI never proposes a grid a commander would
 *  refuse: (1) PID — call fire only onto a CURRENTLY-OBSERVED enemy position, never a guessed
 *  grid; (2) DANGER CLOSE is not a default — never lay HE inside friendly troops' danger-close
 *  radius (which also stops calling fire onto an objective the maneuver element is assaulting). */
function maybeRequestFires(w: World, t: Task, members: Unit[], eff: Eff, sop: SquadSOP) {
  if (w.state.fireRequest) return; // one pending at a time
  // Want fires when the SOP calls for it (suppress) or the squad is pinned and losing ground.
  const wantFires = sop.contact === "suppress" || eff.effFrac < 0.78;
  if (!wantFires) return;
  // (1) PID: aim at an actually-observed enemy cluster — null means no eyes on, no fire mission.
  const aim = fireAimpoint(w.sim, members);
  if (!aim) return;
  const mortar = w.sim.mortars.find((m) => m.rounds > 0);
  if (!mortar) return;
  // (2) DANGER CLOSE: withhold if the aimpoint lands inside the weapon's danger-close radius of
  // ANY friendly (not just this squad — a second element could be in the beaten zone). The squad
  // keeps fighting with organic weapons / breaks contact rather than drop HE on itself.
  const blast = getWeapon(mortar.weaponId).blastRadius ?? 15;
  const safeDist = blast * 2.5; // matches CombatSim.isDangerClose — so an approved call is never "DANGER CLOSE"
  if (w.sim.playerUnits().some((u) => dist(u.pos, aim) < safeDist)) return;
  const cx = Math.floor(aim.x / w.terrain.cellSize);
  const cy = Math.floor(aim.y / w.terrain.cellSize);
  const reason = eff.effFrac < 0.8 ? `pinned, enemy fixed` : `enemy position fixed`;
  w.requestSquadFires(t, mortar.weaponId, cx, cy, reason);
}

function enterBreak(w: World, t: Task, members: Unit[], threat: Vec2, forced: boolean) {
  t.squadState = "break";
  t.squadTimer = RECONSIDER;
  t.rallyPt = rallyPoint(w, members, threat);
  w.log(`${t.label}: ${forced ? "combat-ineffective — " : ""}breaking contact to the ${w.bearingDesc(t.rallyPt)}.`, "radio");
  w.interrupt(`${t.label} breaking contact`);
  stampBreak(w, t, members, threat, t.sop ?? defaultSOP(t.missionType));
}

// ───────────────────────────────────────────────────────────── helpers

/** Per-man fire posture from the ROE. Under weapons-HOLD a man only opens up if he's
 *  actually being engaged (self-defense); otherwise tight/free fire freely (suppress for
 *  designated gunners). The civ-fire gate still vets every individual shot on top of this. */
function perManRof(m: Unit, sop: SquadSOP, suppress: boolean, _isAuto: boolean): Unit["rof"] {
  if (sop.roe === "hold") {
    const engaged = m.suppression > 0.2 || (m.shaken ?? 0) > 0;
    return engaged ? "free" : "hold";
  }
  return suppress ? "suppress" : "free";
}

/** Move a man into the nearest cover from the threat if he's caught in the open — but
 *  only when he isn't already moving on a route, so we never thrash his path.
 *  `threatDir` convention (matching combat.ts): a unit vector pointing FROM the man
 *  TOWARD the threat. friendlyBrain sets u.threatDir when he's actually shot at; before
 *  that we point it at the squad's threat centroid so men take cover proactively. */
function seekCover(w: World, u: Unit, threat: Vec2) {
  if (u.path.length > 0) return; // already moving somewhere — don't thrash his path
  const here = w.sim.terrain.coverAt(u.pos.x, u.pos.y);
  if (here >= 0.3) return; // already in decent cover — hold it and fight
  const td = u.threatDir ?? norm(sub(threat, u.pos)); // toward the threat (correct sign)
  const c = w.sim.findCover(u.pos, td, 24);
  if (!c) return; // no cover within reach — friendlyBrain drops him prone where he is
  // Relocate for a meaningful, reachable cover upgrade. NOTE (measured, scripts/covertune.ts +
  // balance.ts A/B): tightening this to <9 m cut KIA in short 18-min fights but REGRESSED the
  // 50-min deployment (KIA 0.83→1.08) — over many contacts men need to reach real terrain cover,
  // not hunker in marginal spots. The 24 m / +0.12 reach is the better-tuned long-run value.
  if (w.sim.terrain.coverAt(c.x, c.y) > here + 0.12 && dist(c, u.pos) > 2 && dist(c, u.pos) < 18) {
    w.sim.moveTo(u, c);
  }
}

interface Eff {
  effective: number;
  total: number;
  effFrac: number;
  slDown: boolean;
}

function effectiveness(w: World, members: Unit[], assigned: number): Eff {
  let effective = 0;
  for (const m of members) {
    if (m.alive && m.conscious && !m.evac && m.suppression < 0.85) effective++;
  }
  const total = Math.max(1, assigned);
  const sq = buildSquad(w, members);
  const sl = sq.slId ? w.sim.unit(sq.slId) : null;
  const slDown = !!sq.slId && (!sl || !sl.alive || !sl.conscious || sl.evac);
  return { effective, total, effFrac: effective / total, slDown };
}

function threatCentroid(sim: World["sim"], members: Unit[]): Vec2 {
  const seen = new Set<string>();
  let sx = 0, sy = 0, n = 0;
  for (const m of members) {
    for (const id of m.visibleEnemyIds) {
      if (seen.has(id)) continue;
      const e = sim.unit(id);
      if (e && e.alive && !e.evac) {
        seen.add(id);
        sx += e.pos.x; sy += e.pos.y; n++;
      }
    }
  }
  if (n > 0) return { x: sx / n, y: sy / n };
  // No one in sight (suppression only): project out along the average incoming direction.
  const c = centroidOf(members);
  let dx = 0, dy = 0, td = 0;
  for (const m of members) if (m.threatDir) { dx += m.threatDir.x; dy += m.threatDir.y; td++; }
  if (td > 0 && (dx || dy)) {
    const dir = norm({ x: dx, y: dy });
    return add(c, scale(dir, 120));
  }
  return add(c, { x: 0, y: -120 });
}

function visibleEnemyCount(sim: World["sim"], members: Unit[]): number {
  const seen = new Set<string>();
  for (const m of members) for (const id of m.visibleEnemyIds) {
    const e = sim.unit(id);
    if (e && e.alive && !e.evac) seen.add(id);
  }
  return seen.size;
}

/** Assign the base-of-fire and maneuver elements from the squad's two fire teams: the
 *  team with more automatic weapons in better cover with eyes on the enemy sets the base
 *  of fire; the other maneuvers. The SL + attachments are neither (they hold the center). */
function assignElements(w: World, t: Task, members: Unit[], threat: Vec2) {
  const sq = buildSquad(w, members);
  const teams = sq.teams.filter((tm) => tm.ids.length > 0);
  if (teams.length < 2) {
    // a single (or broken) team can't bound safely — everyone holds as base of fire
    t.bofIds = teams[0]?.ids ?? members.map((m) => m.id);
    t.mnvrIds = [];
    return;
  }
  const score = (ids: string[]) => {
    let s = 0;
    for (const id of ids) {
      const u = w.sim.unit(id);
      if (!u || !u.alive || !u.conscious) continue;
      if (AUTO_ROLES.has(u.role)) s += 2.5;
      s += w.sim.terrain.coverAt(u.pos.x, u.pos.y);
      s += 1 - Math.min(1, dist(u.pos, threat) / 300); // closer eyes-on scores higher
    }
    return s;
  };
  const a = score(teams[0].ids);
  const b = score(teams[1].ids);
  const bofTeam = a >= b ? teams[0] : teams[1];
  const mnvrTeam = a >= b ? teams[1] : teams[0];
  t.bofIds = bofTeam.ids.slice();
  t.mnvrIds = mnvrTeam.ids.slice();
}

/** A covered rally point ~70 m back, blending "away from the enemy" with "toward home". */
function rallyPoint(w: World, members: Unit[], threat: Vec2): Vec2 {
  const c = centroidOf(members);
  const home = w.copWorld();
  const away = norm(sub(c, threat));
  const toHome = norm(sub(home, c));
  let dir = norm(add(away, toHome));
  if (len(dir) < 0.1) dir = len(away) > 0.1 ? away : { x: 0, y: 1 };
  const cand = add(c, scale(dir, 70));
  const cover = w.sim.findCover(cand, { x: -dir.x, y: -dir.y }, 30);
  const pt = cover ?? cand;
  return w.terrain.passablePoint(pt.x, pt.y);
}

/** Does the straight run from a→b cross meaningfully open ground (worth screening with smoke)? */
function exposedRun(w: World, a: Vec2, b: Vec2): boolean {
  const d = dist(a, b);
  if (d < 12) return false;
  const steps = Math.min(8, Math.max(2, Math.floor(d / 10)));
  let open = 0;
  for (let i = 1; i < steps; i++) {
    const p = add(a, scale(sub(b, a), i / steps));
    if (w.sim.terrain.coverAt(p.x, p.y) < 0.2) open++;
  }
  return open >= Math.ceil((steps - 1) * 0.5);
}

/** A smoke aimpoint partway to the enemy — a screen between the maneuver run and the guns. */
function midScreen(from: Vec2, threat: Vec2): Vec2 {
  return add(from, scale(sub(threat, from), 0.55));
}

/** Pop ONE smoke for the squad, throttled on the World clock so a sustained drill doesn't
 *  burn the squad's whole smoke load (~67 s screen vs a ~1.2 s reconsider). Returns true if thrown. */
function smokeIfNeeded(w: World, t: Task, m: Unit, threat: Vec2): boolean {
  if (m.smokes <= 0) return false;
  const now = w.state.clock;
  if (now - (t.lastSmokeClock ?? -Infinity) < SMOKE_COOLDOWN_S) return false;
  w.sim.throwSmoke(m, midScreen(m.pos, threat));
  t.lastSmokeClock = now;
  return true;
}

/** The aimpoint for a call-for-fire: the centroid of the DENSEST cluster of currently-observed
 *  (PID'd) enemies — never a projected guess, and never the global centroid. On a two-sided /
 *  L-shaped contact the global centroid of the visible enemies lands BETWEEN the groups (often on
 *  the squad itself — the "nowhere near the enemy" bug); a densest-cluster centroid instead sits
 *  squarely on a real group of enemies. Returns null when no enemy is observed (→ no fire). */
function fireAimpoint(sim: World["sim"], members: Unit[]): Vec2 | null {
  const pts: Vec2[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (!m.alive) continue;
    for (const id of m.visibleEnemyIds) {
      if (seen.has(id)) continue;
      const e = sim.unit(id);
      if (e && e.alive && !e.evac) { seen.add(id); pts.push({ x: e.pos.x, y: e.pos.y }); }
    }
  }
  if (pts.length === 0) return null;
  if (pts.length === 1) return { ...pts[0] };
  const R = 35; // cluster radius (m) — roughly one enemy fire team / firing position
  let best: Vec2 | null = null;
  let bestCount = -1;
  for (let i = 0; i < pts.length; i++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = 0; j < pts.length; j++) {
      if (dist(pts[i], pts[j]) <= R) { sx += pts[j].x; sy += pts[j].y; n++; }
    }
    if (n > bestCount) { bestCount = n; best = { x: sx / n, y: sy / n }; } // first-max wins → deterministic
  }
  return best;
}
