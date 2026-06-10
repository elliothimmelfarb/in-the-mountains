import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { Vec2, dist, sub, norm, add, scale, len } from "../vec";
import { displacePosition, exfilPoint } from "./insurgent";

/**
 * The CELL-COMBAT COORDINATOR — the enemy's group mind, the exact architectural
 * mirror of `ai/squad-combat.ts`: the cell LEADER DECIDES (throttled), and his
 * fighters EXECUTE through the same per-man fields `insurgentBrain` already honors.
 *
 * What a led cell does that an atomized one never could:
 *   - DISCIPLINED INITIATION — every man holds his trigger (`_cellHold`) until the
 *     leader springs the trap on the most casualty-producing weapon's kill zone,
 *     so the ambush opens as ONE volley with targets distributed across the L,
 *     not a ragged trickle off each man's private trigger radius.
 *   - FIRE-AND-MOVEMENT AS A GROUP — half the guns keep cracking while the other
 *     half displaces, swapped on the leader's clock: incoming fire never lapses
 *     and arrives from a new angle each minute.
 *   - A COORDINATED PEEL — the cell breaks as a drill, farthest man first, to a
 *     shared rally toward the draws, the rear pair covering, instead of
 *     evaporating in four directions.
 *   - CONTAGION — a man who breaks on his own shocks the mates who watch him run.
 *
 * Sacred constraints honored here: pre-contact members keep `brainState "ambush"`
 * and `hasFired false`, so the civilian melt-home tell (`ai/civilian.ts`) senses a
 * led cell exactly as before — if anything for longer, since nobody leaks early.
 * IED cells stay the CHARGE's to initiate (`stepIeds`); the coordinator only takes
 * over once the blast has flipped them to engage. Per-man fear still overrides the
 * plan: a pressed fighter scoots, a broken one runs — the cell is coordinated, not
 * choreographed. Leaderless cells (or a cell whose leader is down) fall through to
 * the unchanged per-fighter FSM.
 *
 * Determinism: decisions read sim state and draw from `sim.rng` inside the tick
 * (the same contract as every brain); per-member iteration is `units[]` order.
 * Cell state lives on the LEADER's unit fields and rides the save's unit spread;
 * `_cellHold` is transient and cleared on serialize.
 */

// A/B kill-switch (read once, the ITM_NOOBJCOVER precedent): ITM_NOCELL=1 disables the
// coordinator entirely, so a same-seed harness can isolate the group mind's combat effect.
const NO_CELL = process.env.ITM_NOCELL === "1";

const RECONSIDER_S = 1.4; // leader decision throttle (per-man execution is every tick)
const DISPLACE_PERIOD_S: [number, number] = [9, 15]; // half-cell bound swap clock
const PEEL_STEP_S = 2.5; // seconds between men peeling out of a breaking cell
const RALLY_DIST_M = 180; // the shared withdrawal rally, toward the draws/uphill
const CONTAGION_R = 60; // a fleeing mate is felt this far
const HOLD_TOPUP = 16; // brainTimer floor for the covering half (engage burns 2×dt)

export function runCellBrains(sim: CombatSim, dt: number) {
  if (NO_CELL) return;
  // Group living insurgents by squadId in units order — deterministic and cheap.
  const cells = new Map<string, Unit[]>();
  for (const u of sim.units) {
    if (u.faction !== "insurgent" || !u.alive || u.evac || !u.squadId) continue;
    let g = cells.get(u.squadId);
    if (!g) cells.set(u.squadId, (g = []));
    g.push(u);
  }
  for (const members of cells.values()) {
    const leader = members.find((m) => m.isLeader && m.conscious);
    if (!leader || members.length < 2) {
      // Unled (or down to one man): the old per-fighter FSM owns them — and no stale
      // hold flag may outlive the leader, or an ambusher would never fire again.
      for (const m of members) m._cellHold = false;
      continue;
    }
    cellFight(sim, leader, members, dt);
  }
}

function cellFight(sim: CombatSim, leader: Unit, members: Unit[], dt: number) {
  // CONTAGION — watch for a mate breaking on his own (not a coordinated peel): the
  // sight of him running is a blow to everyone near enough to see it. One-shot.
  for (const m of members) {
    if (m.brainState === "exfil" && !m.fledShock) {
      m.fledShock = true;
      if (leader.cellState !== "break") {
        for (const o of members) {
          if (o === m || !o.conscious) continue;
          if (dist(o.pos, m.pos) > CONTAGION_R) continue;
          o.composure = Math.max(0, o.composure - 0.08);
          o.shaken = Math.max(o.shaken ?? 0, 1.5);
        }
      }
    }
  }

  const triggered =
    leader.cellState === "engage" ||
    leader.cellState === "break" ||
    members.some((m) => m.hasFired || m.brainState === "engage" || m.brainState === "scoot");

  if (!triggered) {
    holdAndWatchTrigger(sim, leader, members);
    return;
  }

  // Once the fight is on, the hold flag means nothing — never leave it latched.
  for (const m of members) m._cellHold = false;
  if (!leader.cellState) leader.cellState = "engage";

  // Leader decisions are throttled; per-man brains fill the gaps every tick.
  leader.cellTimer = (leader.cellTimer ?? 0) - dt;
  if (leader.cellTimer > 0) return;
  leader.cellTimer = RECONSIDER_S;

  if (leader.cellState === "break") {
    runPeel(sim, leader, members);
    return;
  }

  // Cell-level break decision — the inputs a leader actually weighs: a rout
  // spreading (two mates already running), his own nerve, air pressure, or the
  // cell shot down to ineffective.
  const fled = members.filter((m) => m.brainState === "exfil").length;
  const effective = members.filter((m) => m.conscious && m.suppression < 0.85).length;
  const mustBreak =
    fled >= 2 ||
    leader.brainState === "exfil" || // the leader running IS the order
    leader.composure < 0.3 ||
    effective <= Math.floor(members.length / 2) ||
    (sim.casUsed && sim.rng.chance(0.15));
  if (mustBreak) {
    enterBreak(sim, leader, members);
    return;
  }

  // FIRE AND MOVEMENT AS A GROUP: half displaces, half covers, on the leader's clock.
  runGroupDisplace(sim, leader, members);
}

/** Pre-trigger ambush discipline: stamp the hold, and spring the trap as one volley
 *  when the kill zone fills for the cell's BASE weapon — or patience runs out. */
function holdAndWatchTrigger(sim: CombatSim, leader: Unit, members: Unit[]) {
  // An IED cell is the charge's to initiate (stepIeds) — exactly as before.
  if (members.some((m) => m.iedInit)) {
    for (const m of members) m._cellHold = false;
    return;
  }
  const waiting = members.filter((m) => m.brainState === "ambush");
  for (const m of waiting) m._cellHold = true;
  if (waiting.length === 0) return;

  // The initiating gun: the most casualty-producing weapon in the cell (the PKM if
  // they have one), per doctrine. Its kill zone, not each man's, springs the trap.
  let initiator = leader;
  let bestScore = -Infinity;
  for (const m of members) {
    if (!m.conscious) continue;
    const wpn = sim.weaponOf(m);
    const score = (wpn.cls === "mmg" || wpn.cls === "lmg" ? 1000 : 0) + wpn.effRange;
    if (score > bestScore) {
      bestScore = score;
      initiator = m;
    }
  }
  const killZone = sim.weaponOf(initiator).effRange * 0.55;

  // The cell shares eyes: any member's sighting feeds the leader's trigger.
  const targets = unionVisibleTargets(sim, members);
  const zoneFilled = targets.some((e) => dist(initiator.pos, e.pos) <= killZone);
  // Patience is the leader's now — keyed to the same per-man clocks the old FSM used,
  // so a led ambush waits no longer than its most impatient man used to.
  const minTimer = Math.min(...waiting.map((m) => m.brainTimer));
  const patienceUp = minTimer <= -8 && targets.length > 0;
  const compromised = minTimer <= -22 && targets.length === 0;

  if (zoneFilled || patienceUp) {
    // SPRING THE TRAP — the whole cell opens up the same tick, targets distributed
    // across the firing line so the volley works the column, not one man.
    targets.sort((a, b) => (a.id < b.id ? -1 : 1));
    let ti = 0;
    for (const m of members) {
      m._cellHold = false;
      if (!m.conscious || m.brainState !== "ambush") continue;
      m.brainState = "engage";
      m.rof = "free";
      // Distribute the volley across the line — but only ever hand a man a target HE
      // can see (a stamped target with no LOS sat silent until his own re-acquire at
      // dwell end — measured: a 10 s p90 tail on the volley). No sight picture yet →
      // his own acquire (null = he opens up the moment one walks into view).
      const mine = targets.filter((e) => m.visibleEnemyIds.includes(e.id));
      m.targetId = mine.length ? mine[ti++ % mine.length].id : sim.acquireTarget(m);
      m.brainTimer = sim.rng.range(14, 26);
    }
    sim.addLog("CONTACT! Massed fire — a coordinated ambush from the high ground!", "contact");
    leader.cellState = "engage";
    // Let the cell FIGHT from its prepared positions for a full dwell before the first
    // group displace — without this the (cellBoundUntil ?? 0) clock expired instantly
    // and half the cell was sent scooting BEFORE ITS FIRST SHOT (measured: a man's
    // first round delayed 64 s; the volley opened as a half-volley).
    leader.cellTimer = RECONSIDER_S;
    leader.cellBoundUntil = sim.timeS + sim.rng.range(DISPLACE_PERIOD_S[0], DISPLACE_PERIOD_S[1]);
  } else if (compromised) {
    // Nobody came. Melt away as a group, quietly, the way they staged.
    enterBreak(sim, leader, members);
  }
}

/** Half the cell bounds to new firing positions while the other half keeps the guns
 *  working — swapped on the leader's clock. Incoming fire never lapses. */
function runGroupDisplace(sim: CombatSim, leader: Unit, members: Unit[]) {
  if ((leader.cellBoundUntil ?? 0) > sim.timeS) return;
  leader.cellBound = 1 - (leader.cellBound ?? 0);
  leader.cellBoundUntil = sim.timeS + sim.rng.range(DISPLACE_PERIOD_S[0], DISPLACE_PERIOD_S[1]);

  // A man who hasn't fired his first shot yet doesn't displace — you scoot OFF a
  // position you've burned, not off one you never used.
  const engaged = members.filter((m) => m.conscious && m.brainState === "engage" && m.hasFired);
  if (engaged.length < 2) return;
  const half = Math.ceil(engaged.length / 2);
  const movers = leader.cellBound ? engaged.slice(half) : engaged.slice(0, half);
  const coverers = leader.cellBound ? engaged.slice(0, half) : engaged.slice(half);

  for (const m of movers) {
    const spot = displacePosition(sim, m);
    if (!spot) continue;
    sim.moveTo(m, spot);
    m.brainState = "scoot";
    m.rof = "hold";
    m.brainTimer = sim.rng.range(2, 4);
  }
  for (const m of coverers) {
    // Keep the base of fire on the gun through the bound — don't let his own dwell
    // clock pull him off mid-swap (engage burns the timer at 2×dt; 16 ≈ 8 s real).
    m.brainTimer = Math.max(m.brainTimer, HOLD_TOPUP);
  }
}

/** The cell breaks as a DRILL: a shared rally toward the draws, farthest man first,
 *  the rear pair covering until the rest are moving. */
function enterBreak(sim: CombatSim, leader: Unit, members: Unit[]) {
  leader.cellState = "break";
  leader.cellPeelNextS = sim.timeS;
  const far = exfilPoint(sim, leader);
  const dir = norm(sub(far, leader.pos));
  const raw = len(dir) > 0.1 ? add(leader.pos, scale(dir, RALLY_DIST_M)) : far;
  leader.cellRally = sim.terrain.passablePoint(raw.x, raw.y);
  if (sim.rng.chance(0.4)) sim.addLog("ICOM: enemy element breaking contact together.", "radio");
  runPeel(sim, leader, members);
}

function runPeel(sim: CombatSim, leader: Unit, members: Unit[]) {
  const rally = leader.cellRally;
  if (!rally) return;
  if ((leader.cellPeelNextS ?? 0) > sim.timeS) return;

  // The Australian peel, inverted for an exfil: the man FARTHEST from the threat
  // steps out first, one per beat, so the men nearest the enemy — still in "engage",
  // still working their guns — are by construction the rear guard, and the last to
  // go. (A peeled man's exfil brain still fires as he moves if he has eyes on.)
  const threat = nearestThreatPos(sim, leader);
  const staying = members.filter((m) => m.conscious && m.brainState !== "exfil");
  if (staying.length === 0) return;
  staying.sort((a, b) => dist(b.pos, threat) - dist(a.pos, threat) || (a.id < b.id ? -1 : 1));

  const next = staying[0];
  next.brainState = "exfil";
  next.rof = "hold";
  next.fledShock = true; // an ordered peel is not a rout — no contagion
  sim.moveTo(next, rally);
  leader.cellPeelNextS = sim.timeS + PEEL_STEP_S;
}

function unionVisibleTargets(sim: CombatSim, members: Unit[]): Unit[] {
  const seen = new Set<string>();
  const out: Unit[] = [];
  for (const m of members) {
    for (const id of m.visibleEnemyIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = sim.unit(id);
      if (e && e.alive && !e.evac && (e.faction === "us" || e.faction === "ana")) out.push(e);
    }
  }
  return out;
}

function nearestThreatPos(sim: CombatSim, u: Unit): Vec2 {
  let best: Vec2 = add(u.pos, u.threatDir ? scale(u.threatDir, 100) : { x: 0, y: 100 });
  let bd = Infinity;
  for (const o of sim.units) {
    if ((o.faction !== "us" && o.faction !== "ana") || !o.alive || o.evac) continue;
    const d = dist(o.pos, u.pos);
    if (d < bd) {
      bd = d;
      best = o.pos;
    }
  }
  return best;
}
