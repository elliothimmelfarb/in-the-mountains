import type { World } from "../world/world";
import { Task, SquadSOP, defaultSOP } from "../world/types";
import { buildSquad } from "../world/formation";
import { centroidOf } from "../world/helpers";
import { Unit } from "../entities";
import { getWeapon } from "../weapons";
import { dist, Vec2, norm, sub, add, scale, len } from "../vec";
import { clamp, lerp } from "../rng";
import { findPath } from "../path";

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
    t.flankPt = undefined;
    t.boundPair = undefined;
    t.boundUntil = undefined;
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
      // React to contact = get down, orient, return fire in the SOP's FIXING posture. The maneuver
      // decision comes a beat LATER (the hold/suppress case upgrades to assault once the leader has
      // read the fight) — a squad doesn't launch an assault in the first second of contact, and
      // deferring it is also what lets the SOP bite: at first contact effFrac≈1 so every SOP would
      // commit, but mid-fight (partly suppressed) the SOP's commit threshold actually differentiates.
      if (sop.contact === "break") enterBreak(w, t, members, threat, false);
      else {
        t.fixSince = w.state.clock; // start the SOP-keyed develop-the-situation timer
        commitDrill(w, t, members, threat, sop.contact === "suppress" ? "suppress" : "hold", enemyCount, eff, sop);
      }
      break;
    }
    case "hold":
    case "suppress": {
      // Keep reading the fight: the instant fire superiority is achievable AND a covered flank opens,
      // commit the maneuver element — without waiting for a player order. A squad that just sits until
      // told to maneuver has failed the most basic infantry standard.
      const next = chooseDrill(w, t, members, threat, enemyCount, eff, sop);
      if (next === "assault") {
        commitDrill(w, t, members, threat, "assault", enemyCount, eff, sop);
        w.log(`${t.label}: fire superiority gained — maneuvering on the ${w.bearingDesc(t.flankPt ?? threat)} flank.`, "radio");
      } else {
        t.squadTimer = RECONSIDER + w.rng.next() * 0.6;
        runState(w, t, members, threat, enemyCount, eff, sop);
        maybeRequestFires(w, t, members, eff, sop);
      }
      break;
    }
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

/**
 * The squad-leader's drill decision. SOP sets the AGGRESSION (how readily he commits the maneuver
 * element); the tactical picture decides whether he actually can. Order of preference:
 *   assault-via-flank  — fire superiority is achievable AND a covered flank exists (and two fire
 *                        teams to bound with). The doctrinal answer when you're winning the firefight.
 *   suppress / hold    — fix the enemy (call fires under suppress); set conditions for a later flank.
 *   break              — only if the SOP orders it (the automatic break-safety handles ineffective).
 * Stores the chosen covered-flank objective on t.flankPt as a side effect.
 */
function chooseDrill(w: World, t: Task, members: Unit[], threat: Vec2, enemyCount: number, eff: Eff, sop: SquadSOP): "assault" | "suppress" | "hold" | "break" {
  if (sop.contact === "break") return "break";
  const fixing = sop.contact === "suppress" ? "suppress" : "hold";
  // SOP LEVER (robust to the bimodal effFrac problem): the squad must FIX and develop the situation
  // for an SOP-keyed time before it may commit the assault. Assault commits at once; hold develops
  // first; suppress develops longest (and meanwhile calls fires) — so many contacts resolve before
  // the cautious SOPs ever assault. That is what makes Hold ≠ Assault, not cosmetic.
  if (w.state.clock - (t.fixSince ?? w.state.clock) < developTime(sop)) return fixing;
  // The DECISION is otherwise cheap (no path search): commit when the squad can gain fire superiority
  // and has two fire teams to bound with. Covered-flank vs frontal route is decided at commit.
  const sq = buildSquad(w, members);
  const twoTeams = sq.teams.filter((tm) => tm.ids.length > 0).length >= 2;
  if (twoTeams && assessFireSuperiority(members, enemyCount, eff)) return "assault";
  return fixing;
}

/** SOP-keyed "develop the situation" delay before the squad may commit a maneuver (game-seconds).
 *  Assault closes immediately; hold fixes and reads the fight first; suppress prefers to keep fixing
 *  and call fires, committing the assault only in a long, decisive contact. */
function developTime(sop: SquadSOP): number {
  return sop.contact === "assault" ? 0 : sop.contact === "suppress" ? 18 : 7; // hold = 7 s
}

/** Adopt a drill: stamp it, and for an assault assign the base-of-fire / maneuver split, find the
 *  covered flank to route to (frontal fallback if none), and start the bounding-overwatch clock so
 *  only one buddy pair moves at a time. The flank search runs ONCE here, not every reconsider. */
function commitDrill(w: World, t: Task, members: Unit[], threat: Vec2, drill: "assault" | "suppress" | "hold", enemyCount: number, eff: Eff, sop: SquadSOP) {
  t.squadState = drill;
  t.squadTimer = RECONSIDER + w.rng.next() * 0.6;
  if (drill === "assault") {
    assignElements(w, t, members, threat);
    // Prefer a covered flank; null → stampAssault routes frontally (the fallback when no flank exists).
    t.flankPt = findCoveredFlank(w, members, threat, aggressionOf(sop)) ?? undefined;
    t.boundPair = 0;
    t.boundUntil = w.state.clock + w.rng.range(3, 5);
  }
  runState(w, t, members, threat, enemyCount, eff, sop);
}

/** SOP → maneuver aggression (how readily the leader commits the assault). assault commits eagerly;
 *  suppress prefers to fix and call fires; hold sits between (it will still flank when clearly ahead). */
function aggressionOf(sop: SquadSOP): number {
  return sop.contact === "assault" ? 1.0 : sop.contact === "suppress" ? 0.35 : 0.6;
}

/** Can the squad gain the fire superiority an assault needs? Requires an organic automatic weapon up
 *  (to generate the base of fire's suppression), a PID'd enemy to assault, at least parity in effective
 *  shooters, and that the squad isn't itself pinned. (The SOP lever lives in the develop-timer, not
 *  here — so a squad never assaults out of a position it can't actually move from.) */
function assessFireSuperiority(members: Unit[], enemyCount: number, eff: Eff): boolean {
  if (enemyCount === 0) return false; // no observed enemy → nothing to assault (no PID)
  const haveAuto = members.some((m) => m.alive && m.conscious && AUTO_ROLES.has(m.role) && m.suppression < 0.7);
  if (!haveAuto) return false;
  const force = eff.effective / Math.max(1, enemyCount);
  return force >= 1.0 && eff.effFrac >= 0.6;
}

/**
 * Find a COVERED flank objective, or null. Probes a point off each side of the enemy (perpendicular
 * to the approach axis), routes to it with the cover-biased planner, and accepts the side whose route
 * is MEANINGFULLY more covered than the straight line to the threat (and clears an absolute cover
 * floor, so "more cover than bare dirt" doesn't qualify). The gate is SOP-keyed: hold needs a clearly
 * better flank; assault accepts a modest one. Returns the chosen flank point.
 */
function findCoveredFlank(w: World, members: Unit[], threat: Vec2, aggression: number): Vec2 | null {
  const terrain = w.sim.terrain;
  const live = members.filter((m) => m.alive && m.conscious);
  const c = centroidOf(live.length ? live : members);
  const toT = sub(threat, c);
  const d = len(toT);
  if (d < 25 || d > 320) return null; // too close (frontal anyway) / beyond a practical assault
  const approach = norm(toT);
  const perp = { x: -approach.y, y: approach.x };
  const straight = meanCoverLine(terrain, c, threat);
  // Accept a flank whose cover-biased route is meaningfully more covered than the straight line. The
  // gate is RELATIVE (not an absolute floor) so it still finds the best available approach on the
  // coarse 5 m cover raster; WS3's discrete cover objects will make the absolute gain much larger.
  const gate = lerp(1.25, 1.06, aggression); // hold ~1.15×, assault 1.06× the straight-line cover
  let best: Vec2 | null = null;
  let bestCover = Math.max(0.04, straight * gate);
  // Sample both sides at two offsets and pick the most-covered cover-biased route (≤4 path queries,
  // run ONCE per assault commit — never per reconsider).
  for (const s of [1, -1]) {
    for (const frac of [0.55, 0.8]) {
      const sideDist = clamp(d * frac, 30, 80);
      const raw = add(threat, scale(perp, s * sideDist));
      const flankPt = terrain.passablePoint(raw.x, raw.y);
      const path = findPath(terrain, c, flankPt, { coverBias: 0.85, cheapFallback: true });
      if (!path.length) continue;
      const routeCover = meanCoverPath(terrain, c, path);
      if (routeCover > bestCover) {
        bestCover = routeCover;
        best = flankPt;
      }
    }
  }
  return best;
}

/** Mean cover sampled along the straight segment a→b. */
function meanCoverLine(terrain: World["sim"]["terrain"], a: Vec2, b: Vec2): number {
  const steps = 6;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const p = add(a, scale(sub(b, a), i / steps));
    sum += terrain.coverAt(p.x, p.y);
  }
  return sum / (steps + 1);
}

/** Mean cover along a multi-waypoint route from `start`. */
function meanCoverPath(terrain: World["sim"]["terrain"], start: Vec2, path: Vec2[]): number {
  if (!path.length) return terrain.coverAt(start.x, start.y);
  let sum = 0, segs = 0, from = start;
  for (const wp of path) {
    sum += meanCoverLine(terrain, from, wp);
    segs++;
    from = wp;
  }
  return sum / Math.max(1, segs);
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

/** ASSAULT: base-of-fire element pins the enemy while the maneuver element fire-and-moves onto a
 *  COVERED FLANK (not a frontal beeline at the centroid — a frontal rush is doctrinally wrong). The
 *  maneuver element bounds by buddy pairs — only ONE pair moves at a time while the other overwatches,
 *  swapping on a 3–5 s clock. The per-man bound (auto-rifle base of fire, riflemen close) is run by
 *  friendlyBrain's assault path; here we set the split, the flank objective, the bound, and smoke. */
function stampAssault(w: World, t: Task, members: Unit[], threat: Vec2, sop: SquadSOP) {
  if (!t.bofIds || !t.mnvrIds) assignElements(w, t, members, threat);
  const bof = new Set(t.bofIds ?? []);
  const mnvrIds = t.mnvrIds ?? [];
  const flankPt = t.flankPt ?? threat;

  // Bounding overwatch: which buddy pair of the maneuver element is rushing right now. Swap on a
  // 3–5 s clock so only one element is ever moving (the other lays overwatch on the objective).
  if ((t.boundUntil ?? 0) <= w.state.clock) {
    t.boundPair = 1 - (t.boundPair ?? 0);
    t.boundUntil = w.state.clock + w.rng.range(3, 5);
  }
  const liveMnvr = mnvrIds
    .map((id) => w.sim.unit(id))
    .filter((u): u is Unit => !!u && u.alive && u.conscious);
  const half = Math.ceil(liveMnvr.length / 2);
  // Sort by distance to the flank so the buddy pairs are spatially coherent (leaders/closest bound first).
  liveMnvr.sort((a, b) => dist(a.pos, flankPt) - dist(b.pos, flankPt));
  const movingPair = new Set((t.boundPair ? liveMnvr.slice(half) : liveMnvr.slice(0, half)).map((m) => m.id));

  let screened = false;
  for (const m of members) {
    if (!m.alive || !m.conscious) continue;
    if (bof.has(m.id)) {
      m.brainState = "holding";
      m.orderType = undefined;
      m.rof = sop.roe === "hold" ? "free" : "suppress";
      m.orderTarget = { ...threat };
      seekCover(w, m, threat);
    } else if (mnvrIds.includes(m.id)) {
      if (movingPair.has(m.id)) {
        // This buddy pair bounds — covered approach to the flank, then turn IN onto the enemy for
        // the final assault. friendlyBrain runs the per-man fire-and-move; the cover-biased pathTo
        // (not a beeline) is what makes the route an actual flank.
        const obj = dist(m.pos, flankPt) > 28 ? flankPt : threat;
        m.brainState = "moving";
        m.orderType = "assault";
        m.orderTarget = { ...obj };
        m.rof = perManRof(m, sop, false, AUTO_ROLES.has(m.role)); // honor weapons-hold even while bounding
        if (m.path.length === 0 && dist(m.pos, obj) > 3) {
          w.sim.pathTo(m, obj, { coverBias: 0.6, concealBias: 0.3, cheapFallback: true });
        }
        // screen the bound with smoke if it crosses open ground (throttled across the squad)
        if (!screened && exposedRun(w, m.pos, threat) && smokeIfNeeded(w, t, m, threat)) screened = true;
      } else {
        // The other pair OVERWATCHES — holds from cover and suppresses the objective so the moving
        // pair is covered. This is the bounding discipline: one element moves, one supports.
        m.brainState = "holding";
        m.orderType = undefined;
        m.rof = sop.roe === "hold" ? "free" : "suppress";
        m.orderTarget = { ...threat };
        m.path = [];
        m.moving = false;
        seekCover(w, m, threat);
      }
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
