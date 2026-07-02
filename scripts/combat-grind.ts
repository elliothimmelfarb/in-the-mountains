/**
 * combat-grind.ts — IN-COMBAT MOVEMENT probe (durable; born in the 2026-07-02 realism
 * campaign, front A — it filled the "no in-combat movement probe" measurement gap).
 *
 * Measures the wall-grind/loiter failure family: a combat brain orders a man to a point
 * (cover, scoot, exfil, objective) that he cannot reach — the goal sits in an impassable
 * cell, or the straight line to it is blocked deeper than the 7 m steering fan
 * (steering.ts PROBE=7) can solve. Untreated, that loops: blocked -> 2 s stall watchdog
 * wipes the path (combat.ts watchStall) -> the per-tick brain re-issues the SAME target
 * -> grind. The fix (2026-07-02) is the tactical-bound mechanism in CombatSim.moveTo
 * (snap goal to reachable ground at the source + route via budgeted corridor A* beyond
 * BOUND_ROUTE_M) plus passability pre-filtering in findCover; this probe is the regression
 * watch on that mechanism. HEAD baseline (pre-fix, verbatim):
 * docs/progress/2026-07-02-realism-campaign/baseline/combat-grind-HEAD.txt
 * (570 insurgent grind events, 42% of one seed's insurgent contact time blocked, 87
 * friendly loiters at impassable cover goals, 759 zombie post-contact exfil wipes).
 *
 * DETECTION (observed post-world.tick; brains run before movement inside sim.tick, so a
 * wipe is visible for exactly one tick as path=[] before the brain refills it):
 *   WIPE        prev.blockedTimer >= 1.85 && now blockedTimer==0 && path empty (and the
 *               unit is >2.5 m from its waypoint, so an arrival can't fake it).
 *   GRIND EVENT a wipe whose held waypoint is within 2 m of the unit's PREVIOUS wipe's
 *               waypoint, <= 8 s later — i.e. the AI re-issued the same unreachable line
 *               and it stalled out again. Chained events = one grind loop.
 *   grind secs  per chain: 2 s (the first stall) + the sum of wipe-to-wipe intervals.
 *   obstacle    ray-march from the unit toward its waypoint (0.25 m steps, 3.5 m) for the
 *               first impassable cell; classify by Land class / slope. Fallback: scan the
 *               8 neighbour cells (a steered sideways block).
 *   BLIND SPOT COVERED — a second failure mode blockedTimer can't see: findCover
 *               (combat.ts:1899) never checks passability of the point it returns, and the
 *               impassable classes carry the TOP cover values (Hesco .92 / CompoundWall .86
 *               / Cliff .70 / Structure .55 — terrain.ts:3454). A man sent INTO a wall cell
 *               can pace along the face (steering keeps him un-blocked → no wipe). So also:
 *   unreachGoalS  in-contact seconds holding a pathGoal that sits in an IMPASSABLE cell
 *               (attributed by faction:brainState/orderType so the emitting caller is named).
 *   LOITER      same (±2 m) pathGoal held ≥15 s in contact, never arrived (<3 m), AND net
 *               approach to the goal < 5 m over the whole hold — i.e. the man is PACING, not
 *               walking. (Progress-aware since the moveTo fix: in-combat moves are now real
 *               multi-waypoint routes, so "held one goal a while" is the signature of an
 *               honest long bound; only a hold with no closure is the failure.) Honest long
 *               holds are counted separately as walkHolds.
 *
 * Staging mirrors scripts/balance.ts EXACTLY (seeds bal-0..bal-5, heat 0.6+(run%5)*0.06,
 * sq1+medic presence patrol to village run%len, nextActivityAt=0, 50 game-min).
 * Deterministic: world RNG only — no Date.now, no Math.random.
 *
 * Run: npx tsx scripts/combat-grind.ts [nSeeds=6] [minutes=50] [prefix=bal]
 */
import { createWorld } from "../lib/sim/world";
import { Land, Terrain } from "../lib/sim/terrain";
import type { Unit } from "../lib/sim/entities";

const N = Number(process.argv[2] ?? 6);
const MINUTES = Number(process.argv[3] ?? 50);
const PREFIX = process.argv[4] ?? "bal";
const SIM_DT = 0.1;
const CONTACT_HOLD = 10; // s a unit stays "in contact" after last seeing/taking fire
const SAME_TARGET_M = 2; // re-issued waypoint within this of the last wipe's = same line
const CHAIN_WINDOW_S = 8; // max gap between same-target wipes to count as one loop

// ---------------------------------------------------------------- obstacle classing
const HARD_LAND = new Set([Land.Cliff, Land.CompoundWall, Land.Hesco, Land.Structure, Land.River]);

function classAt(terrain: Terrain, cx: number, cy: number): string {
  const cs = terrain.cellSize;
  const wx = (cx + 0.5) * cs;
  const wy = (cy + 0.5) * cs;
  const l = terrain.landAt(wx, wy);
  if (HARD_LAND.has(l)) return Land[l];
  const s = terrain.slopeAt(wx, wy);
  if (s > 1.4) return "SteepSlope>1.4";
  return "SteepBand1.25-1.4";
}

/** What is the unit actually grinding against? First impassable cell toward the waypoint,
 *  else the nearest impassable neighbour (a steered sideways block). */
function classifyBlock(terrain: Terrain, pos: { x: number; y: number }, w: { x: number; y: number }): string {
  const cs = terrain.cellSize;
  const dx = w.x - pos.x;
  const dy = w.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6) {
    for (let s = 0.25; s <= 3.5; s += 0.25) {
      const cx = Math.floor((pos.x + (dx / d) * s) / cs);
      const cy = Math.floor((pos.y + (dy / d) * s) / cs);
      if (!terrain.passableCell(cx, cy)) return classAt(terrain, cx, cy);
    }
  }
  const ux = Math.floor(pos.x / cs);
  const uy = Math.floor(pos.y / cs);
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      if (!terrain.passableCell(ux + ox, uy + oy)) return classAt(terrain, ux + ox, uy + oy) + "(flank)";
    }
  return "unresolved";
}

function blockCell(terrain: Terrain, pos: { x: number; y: number }, w: { x: number; y: number }): string {
  const cs = terrain.cellSize;
  const dx = w.x - pos.x;
  const dy = w.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6)
    for (let s = 0.25; s <= 3.5; s += 0.25) {
      const cx = Math.floor((pos.x + (dx / d) * s) / cs);
      const cy = Math.floor((pos.y + (dy / d) * s) / cs);
      if (!terrain.passableCell(cx, cy)) return `(${cx},${cy})`;
    }
  return "(side)";
}

// ---------------------------------------------------------------- per-unit tracker
interface UT {
  faction: "friendly" | "insurgent";
  // previous-tick snapshot
  bt: number;
  pathLen: number;
  w0x: number;
  w0y: number;
  x: number;
  y: number;
  bs: string;
  ot: string;
  // contact latch + accumulators
  contactUntil: number;
  contactS: number;
  blockedS: number; // in-contact blocked seconds
  grindS: number;
  wipes: number; // in-contact wipes
  wipesOut: number; // out-of-contact wipes (patrol-march wedges — different front)
  grindEvents: number;
  chainLen: number;
  maxChain: number;
  lastWipeT: number;
  lastWipeX: number;
  lastWipeY: number;
  // bound bookkeeping (in-contact path lifecycles)
  bounding: boolean;
  boundT: number;
  boundGx: number;
  boundGy: number;
  boundWiped: boolean;
  // blind-spot signals: impassable goals & same-goal loiter (no wipe needed)
  unreachGoalS: number;
  goalHoldS: number;
  holdGx: number;
  holdGy: number;
  holdLastT: number;
  holdD0: number; // distance-to-goal when the hold streak opened (progress discrimination)
  loiters: number;
  walkHolds: number; // honest long holds: same goal ≥15 s but with real net approach
  maxLoiterS: number;
  log: string[];
}

function newUT(f: UT["faction"]): UT {
  return {
    faction: f, bt: 0, pathLen: 0, w0x: 0, w0y: 0, x: 0, y: 0, bs: "", ot: "",
    contactUntil: -1, contactS: 0, blockedS: 0, grindS: 0, wipes: 0, wipesOut: 0,
    grindEvents: 0, chainLen: 0, maxChain: 0, lastWipeT: -1e9, lastWipeX: 1e9, lastWipeY: 1e9,
    bounding: false, boundT: 0, boundGx: 0, boundGy: 0, boundWiped: false,
    unreachGoalS: 0, goalHoldS: 0, holdGx: 1e9, holdGy: 1e9, holdLastT: -1e9, holdD0: 0,
    loiters: 0, walkHolds: 0, maxLoiterS: 0, log: [],
  };
}

interface SeedRow {
  seed: string;
  engagements: number;
  inContactF: number;
  inContactI: number;
  wipes: Record<string, number>;
  wipesOut: number;
  grind: Record<string, number>;
  grindUnits: Record<string, number>;
  grindSecs: Record<string, number[]>; // per grinding unit
  contactS: Record<string, number>;
  blockedS: Record<string, number>;
  boundsDone: number;
  boundsWiped: number;
  boundsOther: number;
  boundDur: number[];
  unreachGoalS: Record<string, number>;
  loiters: Record<string, number>;
  walkHolds: Record<string, number>;
  loiterSecs: Record<string, number[]>;
}

const obstacleTally = new Map<string, number>(); // ALL wipe-time obstacle classes (in contact)
const attribution = new Map<string, number>(); // grind re-issues by faction:brainState/orderType
const unreachAttr = new Map<string, number>(); // impassable-goal seconds by faction:brainState/orderType
const outWipeAttr = new Map<string, number>(); // OUT-of-contact wipes by faction:brainState
const outObstacle = new Map<string, number>(); // OUT-of-contact wipe obstacle classes
const rows: SeedRow[] = [];
let traceLog: string[] = [];
let traceKey = "";
let traceBest = 0;

for (let run = 0; run < N; run++) {
  const seed = `${PREFIX}-${run}`;
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.6 + (run % 5) * 0.06;

  const cop = terrain.copCell;
  const v = terrain.villages[run % terrain.villages.length];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  world.formPatrol(
    ids,
    [
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    "presence",
    "tactical"
  );
  state.nextActivityAt = 0;

  const track = new Map<string, UT>();
  const row: SeedRow = {
    seed, engagements: 0, inContactF: 0, inContactI: 0,
    wipes: { friendly: 0, insurgent: 0 }, wipesOut: 0,
    grind: { friendly: 0, insurgent: 0 }, grindUnits: { friendly: 0, insurgent: 0 },
    grindSecs: { friendly: [], insurgent: [] },
    contactS: { friendly: 0, insurgent: 0 }, blockedS: { friendly: 0, insurgent: 0 },
    boundsDone: 0, boundsWiped: 0, boundsOther: 0, boundDur: [],
    unreachGoalS: { friendly: 0, insurgent: 0 }, loiters: { friendly: 0, insurgent: 0 },
    walkHolds: { friendly: 0, insurgent: 0 },
    loiterSecs: { friendly: [], insurgent: [] },
  };
  const closeLoiter = (ut: UT, u: Unit, t: number) => {
    if (ut.goalHoldS >= 15) {
      const dEnd = Math.hypot(u.pos.x - ut.holdGx, u.pos.y - ut.holdGy);
      const approach = ut.holdD0 - dEnd; // net closure over the whole hold
      if (approach < 5) {
        ut.loiters++;
        ut.maxLoiterS = Math.max(ut.maxLoiterS, ut.goalHoldS);
        row.loiters[ut.faction]++;
        row.loiterSecs[ut.faction].push(ut.goalHoldS);
        const cs = terrain.cellSize;
        const gcx = Math.floor(ut.holdGx / cs);
        const gcy = Math.floor(ut.holdGy / cs);
        const imp = !terrain.passableCell(gcx, gcy);
        ut.log.push(
          `t=${t.toFixed(1)}s LOITER-END held goal=(${ut.holdGx.toFixed(1)},${ut.holdGy.toFixed(1)}) for ${ut.goalHoldS.toFixed(1)}s, ` +
            `approach ${approach.toFixed(1)}m (PACING) pos=(${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)}) d=${dEnd.toFixed(1)}m ` +
            `goalCell=${imp ? "IMPASSABLE " + classAt(terrain, gcx, gcy) : "passable"} bs=${u.brainState}/${u.orderType ?? "-"}`
        );
      } else {
        ut.walkHolds++;
        row.walkHolds[ut.faction]++;
      }
    }
    ut.goalHoldS = 0;
    ut.holdGx = 1e9;
    ut.holdGy = 1e9;
  };
  const everContact = new Set<string>();
  let wasContact = false;

  const ticks = MINUTES * 600;
  for (let ti = 0; ti < ticks && !state.ended; ti++) {
    world.tick(SIM_DT);
    const inC = world.inContact();
    if (inC && !wasContact) row.engagements++;
    wasContact = inC;
    const t = sim.timeS;

    for (const u of sim.units) {
      if (u.faction === "civilian") continue;
      if (!u.alive || !u.conscious || u.evac) continue;
      const fac: UT["faction"] = u.faction === "insurgent" ? "insurgent" : "friendly";
      let ut = track.get(u.id);
      if (!ut) {
        ut = newUT(fac);
        track.set(u.id, ut);
        // seed the snapshot so the first tick can't fake a transition
        ut.bt = u.blockedTimer ?? 0;
        ut.pathLen = u.path.length;
        if (u.path.length) {
          ut.w0x = u.path[0].x;
          ut.w0y = u.path[0].y;
        }
        ut.x = u.pos.x;
        ut.y = u.pos.y;
        continue;
      }

      const bt = u.blockedTimer ?? 0;
      const pathLen = u.path.length;
      const supp = u.suppression;
      const vis = u.visibleEnemyIds.length;
      if (vis > 0 || supp > 0.18) ut.contactUntil = t + CONTACT_HOLD;
      const inContact = t <= ut.contactUntil;
      if (inContact) {
        ut.contactS += SIM_DT;
        everContact.add(u.id);
      }
      if (bt > ut.bt && inContact) ut.blockedS += SIM_DT;

      // ---- blind-spot signals: impassable goal + same-goal loiter (no wipe required)
      const g = u.pathGoal;
      if (inContact && g && !terrain.passableCell(Math.floor(g.x / terrain.cellSize), Math.floor(g.y / terrain.cellSize))) {
        ut.unreachGoalS += SIM_DT;
        const ukey = `${fac}:${u.brainState ?? "?"}/${u.orderType ?? "-"}`;
        unreachAttr.set(ukey, (unreachAttr.get(ukey) ?? 0) + SIM_DT);
      }
      const holdActive = inContact && g != null && pathLen > 0 && Math.hypot(u.pos.x - g.x, u.pos.y - g.y) > 3;
      if (holdActive && Math.hypot(g!.x - ut.holdGx, g!.y - ut.holdGy) <= 2) {
        ut.goalHoldS += SIM_DT;
        ut.holdLastT = t;
      } else if (holdActive) {
        closeLoiter(ut, u, t); // a NEW goal — close any old streak first
        ut.holdGx = g!.x;
        ut.holdGy = g!.y;
        ut.goalHoldS = SIM_DT;
        ut.holdLastT = t;
        ut.holdD0 = Math.hypot(u.pos.x - g!.x, u.pos.y - g!.y);
      } else if (ut.goalHoldS > 0 && t - ut.holdLastT > 1.5) {
        // 1.5 s grace so a wipe + same-goal re-issue continues the SAME streak
        closeLoiter(ut, u, t);
      }

      // ---- WIPE: watchdog fired this tick (brain refills only NEXT tick)
      const distToPrevW = ut.pathLen > 0 ? Math.hypot(ut.w0x - u.pos.x, ut.w0y - u.pos.y) : 0;
      if (ut.bt >= 1.85 && bt === 0 && pathLen === 0 && ut.pathLen > 0 && distToPrevW > 2.5) {
        if (inContact) {
          row.wipes[fac]++;
          const cls = classifyBlock(terrain, u.pos, { x: ut.w0x, y: ut.w0y });
          obstacleTally.set(cls, (obstacleTally.get(cls) ?? 0) + 1);
          const sameAsLast =
            Math.hypot(ut.w0x - ut.lastWipeX, ut.w0y - ut.lastWipeY) <= SAME_TARGET_M &&
            t - ut.lastWipeT <= CHAIN_WINDOW_S;
          if (sameAsLast) {
            ut.grindEvents++;
            row.grind[fac]++;
            if (ut.chainLen === 1) ut.grindS += 2.0; // the chain's first stall
            ut.grindS += t - ut.lastWipeT;
            ut.chainLen++;
            ut.maxChain = Math.max(ut.maxChain, ut.chainLen);
            const key = `${fac}:${u.brainState ?? "?"}/${u.orderType ?? "-"}`;
            attribution.set(key, (attribution.get(key) ?? 0) + 1);
          } else {
            ut.chainLen = 1;
          }
          ut.log.push(
            `t=${t.toFixed(1)}s WIPE${sameAsLast ? " [GRIND: same target re-stalled]" : ""} pos=(${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)}) ` +
              `wp=(${ut.w0x.toFixed(1)},${ut.w0y.toFixed(1)}) d=${distToPrevW.toFixed(1)}m block=${cls} cell=${blockCell(terrain, u.pos, { x: ut.w0x, y: ut.w0y })} ` +
              `bs=${u.brainState}/${u.orderType ?? "-"} supp=${supp.toFixed(2)} vis=${vis}`
          );
        } else {
          row.wipesOut++;
          ut.chainLen = 1;
          const okey = `${fac}:${u.brainState ?? "?"}/${u.orderType ?? "-"}`;
          outWipeAttr.set(okey, (outWipeAttr.get(okey) ?? 0) + 1);
          const ocls = classifyBlock(terrain, u.pos, { x: ut.w0x, y: ut.w0y });
          outObstacle.set(ocls, (outObstacle.get(ocls) ?? 0) + 1);
        }
        ut.lastWipeT = t;
        ut.lastWipeX = ut.w0x;
        ut.lastWipeY = ut.w0y;
      }

      // ---- RE-ISSUE right after a wipe: who refilled the path, and with what?
      if (ut.pathLen === 0 && pathLen > 0 && t - ut.lastWipeT <= 0.35 && inContact) {
        const dSame = Math.hypot(u.path[0].x - ut.lastWipeX, u.path[0].y - ut.lastWipeY);
        ut.log.push(
          `t=${t.toFixed(1)}s RE-ISSUE pathLen=${pathLen}${pathLen === 1 ? " (straight moveTo)" : " (routed)"} ` +
            `wp=(${u.path[0].x.toFixed(1)},${u.path[0].y.toFixed(1)}) dist-to-wiped-target=${dSame.toFixed(2)}m ` +
            `bs=${u.brainState}/${u.orderType ?? "-"} supp=${supp.toFixed(2)} vis=${vis}`
        );
      }

      // ---- bound lifecycle (in-contact path lifetimes: do men actually reach cover?)
      if (inContact && !ut.bounding && ut.pathLen === 0 && pathLen > 0) {
        ut.bounding = true;
        ut.boundT = t;
        ut.boundGx = u.pathGoal?.x ?? u.path[pathLen - 1].x;
        ut.boundGy = u.pathGoal?.y ?? u.path[pathLen - 1].y;
        ut.boundWiped = false;
      } else if (ut.bounding && pathLen === 0 && ut.pathLen > 0) {
        const wipedNow = ut.bt >= 1.85 && bt === 0; // this tick's wipe
        const arr = Math.hypot(u.pos.x - ut.boundGx, u.pos.y - ut.boundGy);
        if (wipedNow) row.boundsWiped++;
        else if (arr < 3) {
          row.boundsDone++;
          row.boundDur.push(t - ut.boundT);
        } else row.boundsOther++;
        ut.bounding = false;
      } else if (ut.bounding && pathLen > 0 && u.pathGoal && Math.hypot(u.pathGoal.x - ut.boundGx, u.pathGoal.y - ut.boundGy) > 3) {
        // order replaced mid-bound — restart the lifecycle on the new goal
        ut.boundT = t;
        ut.boundGx = u.pathGoal.x;
        ut.boundGy = u.pathGoal.y;
      }

      // snapshot for next tick
      ut.bt = bt;
      ut.pathLen = pathLen;
      if (pathLen) {
        ut.w0x = u.path[0].x;
        ut.w0y = u.path[0].y;
      }
      ut.x = u.pos.x;
      ut.y = u.pos.y;
      ut.bs = u.brainState ?? "";
      ut.ot = (u.orderType as string) ?? "";
    }
  }

  // fold per-unit accumulators into the seed row
  for (const [id, ut] of track) {
    const uu = sim.unit(id);
    if (uu && ut.goalHoldS > 0) closeLoiter(ut, uu, sim.timeS); // close a still-open streak
    if (!everContact.has(id)) continue;
    if (ut.faction === "friendly") row.inContactF++;
    else row.inContactI++;
    row.contactS[ut.faction] += ut.contactS;
    row.blockedS[ut.faction] += ut.blockedS;
    row.unreachGoalS[ut.faction] += ut.unreachGoalS;
    if (ut.grindEvents > 0) {
      row.grindUnits[ut.faction]++;
      row.grindSecs[ut.faction].push(ut.grindS);
    }
    const score = ut.grindEvents * 100 + ut.loiters * 10 + ut.maxLoiterS;
    if (score > traceBest) {
      traceBest = score;
      traceKey =
        `${seed} unit=${id} (${ut.faction}) grindEvents=${ut.grindEvents} maxChain=${ut.maxChain} grindS=${ut.grindS.toFixed(1)} ` +
        `loiters=${ut.loiters} maxLoiter=${ut.maxLoiterS.toFixed(1)}s unreachGoalS=${ut.unreachGoalS.toFixed(1)}`;
      traceLog = ut.log.slice(0, 200);
    }
  }
  rows.push(row);
}

// ---------------------------------------------------------------- report
const f2 = (n: number) => n.toFixed(2);
const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + "%" : "—");
const stats = (a: number[]) =>
  a.length === 0 ? "—" : `${f2(a.reduce((s, x) => s + x, 0) / a.length)}/${f2(Math.max(...a))}`;

console.log(`combat-grind probe — ${N} deployments (${PREFIX}-0..${N - 1}), ${MINUTES} game-min each, balance.ts staging`);
console.log(`GRIND EVENT = stall-wipe re-issued to the same (±${SAME_TARGET_M} m) target that then stalls out again (≤${CHAIN_WINDOW_S} s)`);
console.log("");
console.log(
  "seed    | engmts | inContact F/I | wipes F/I | grind F/I | grindUnits F/I | grindS mean/max F | grindS mean/max I | blocked%ofContact F/I | wipesOutOfContact"
);
const tot = {
  eng: 0, icF: 0, icI: 0, wF: 0, wI: 0, gF: 0, gI: 0, guF: 0, guI: 0,
  gsF: [] as number[], gsI: [] as number[], cF: 0, cI: 0, bF: 0, bI: 0, wo: 0,
  bd: 0, bw: 0, bo: 0, bdur: [] as number[],
  ugF: 0, ugI: 0, loF: 0, loI: 0, whF: 0, whI: 0, losF: [] as number[], losI: [] as number[],
};
for (const r of rows) {
  console.log(
    `${r.seed.padEnd(7)} | ${String(r.engagements).padStart(6)} | ${String(r.inContactF).padStart(6)}/${String(r.inContactI).padEnd(6)} | ` +
      `${String(r.wipes.friendly).padStart(4)}/${String(r.wipes.insurgent).padEnd(4)} | ${String(r.grind.friendly).padStart(4)}/${String(r.grind.insurgent).padEnd(4)} | ` +
      `${String(r.grindUnits.friendly).padStart(6)}/${String(r.grindUnits.insurgent).padEnd(7)} | ${stats(r.grindSecs.friendly).padEnd(17)} | ${stats(r.grindSecs.insurgent).padEnd(17)} | ` +
      `${pct(r.blockedS.friendly, r.contactS.friendly).padStart(8)}/${pct(r.blockedS.insurgent, r.contactS.insurgent).padEnd(8)} | ${r.wipesOut}`
  );
  tot.eng += r.engagements; tot.icF += r.inContactF; tot.icI += r.inContactI;
  tot.wF += r.wipes.friendly; tot.wI += r.wipes.insurgent;
  tot.gF += r.grind.friendly; tot.gI += r.grind.insurgent;
  tot.guF += r.grindUnits.friendly; tot.guI += r.grindUnits.insurgent;
  tot.gsF.push(...r.grindSecs.friendly); tot.gsI.push(...r.grindSecs.insurgent);
  tot.cF += r.contactS.friendly; tot.cI += r.contactS.insurgent;
  tot.bF += r.blockedS.friendly; tot.bI += r.blockedS.insurgent;
  tot.wo += r.wipesOut; tot.bd += r.boundsDone; tot.bw += r.boundsWiped; tot.bo += r.boundsOther;
  tot.bdur.push(...r.boundDur);
  tot.ugF += r.unreachGoalS.friendly; tot.ugI += r.unreachGoalS.insurgent;
  tot.loF += r.loiters.friendly; tot.loI += r.loiters.insurgent;
  tot.whF += r.walkHolds.friendly; tot.whI += r.walkHolds.insurgent;
  tot.losF.push(...r.loiterSecs.friendly); tot.losI.push(...r.loiterSecs.insurgent);
}
console.log(
  `ALL     | ${String(tot.eng).padStart(6)} | ${String(tot.icF).padStart(6)}/${String(tot.icI).padEnd(6)} | ` +
    `${String(tot.wF).padStart(4)}/${String(tot.wI).padEnd(4)} | ${String(tot.gF).padStart(4)}/${String(tot.gI).padEnd(4)} | ` +
    `${String(tot.guF).padStart(6)}/${String(tot.guI).padEnd(7)} | ${stats(tot.gsF).padEnd(17)} | ${stats(tot.gsI).padEnd(17)} | ` +
    `${pct(tot.bF, tot.cF).padStart(8)}/${pct(tot.bI, tot.cI).padEnd(8)} | ${tot.wo}`
);
console.log("");
console.log(`grind time as % of in-contact time: friendly ${pct(tot.gsF.reduce((s, x) => s + x, 0), tot.cF)} · insurgent ${pct(tot.gsI.reduce((s, x) => s + x, 0), tot.cI)}`);
console.log(`grind events per engagement (ALL): ${tot.eng ? f2((tot.gF + tot.gI) / tot.eng) : "—"} (friendly ${tot.eng ? f2(tot.gF / tot.eng) : "—"})`);
console.log("");
console.log("blind-spot signals (a man sent at an unreachable point who paces instead of wedging):");
console.log(`  time holding a pathGoal in an IMPASSABLE cell, % of in-contact time: friendly ${pct(tot.ugF, tot.cF)} (${tot.ugF.toFixed(0)}s) · insurgent ${pct(tot.ugI, tot.cI)} (${tot.ugI.toFixed(0)}s)`);
for (const [k, s] of [...unreachAttr.entries()].sort((a, b) => b[1] - a[1])) console.log(`    [impassable-goal attribution] ${k.padEnd(36)} ${s.toFixed(0)}s`);
console.log(`  LOITER events (same goal ≥15 s, net approach <5 m — PACING): friendly ${tot.loF} · insurgent ${tot.loI} · loiter secs mean/max F ${stats(tot.losF)} · I ${stats(tot.losI)}`);
console.log(`  walkHolds (same goal ≥15 s but really closing — honest long bounds): friendly ${tot.whF} · insurgent ${tot.whI}`);
console.log("");
console.log("in-contact bound lifecycles (path issued while in contact):");
const bTot = tot.bd + tot.bw + tot.bo;
console.log(
  `  started ${bTot} · completed(arrived<3m) ${tot.bd} (${pct(tot.bd, bTot)}) · ended-in-stall-wipe ${tot.bw} (${pct(tot.bw, bTot)}) · other(order overwritten/abandoned) ${tot.bo}`
);
console.log(`  completed-bound duration mean/max: ${stats(tot.bdur)} s`);
console.log("");
console.log("obstacle classes at in-contact stall-wipes (what they grind on):");
for (const [cls, n] of [...obstacleTally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${cls.padEnd(28)} ${n}`);
console.log("");
console.log("grind-event attribution (faction:brainState/orderType at the re-stalled wipe):");
for (const [k, n] of [...attribution.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n}`);
console.log("");
console.log("OUT-of-contact wipes — attribution + obstacle (the same loop after contact decays):");
for (const [k, n] of [...outWipeAttr.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n}`);
for (const [cls, n] of [...outObstacle.entries()].sort((a, b) => b[1] - a[1])) console.log(`  [obstacle] ${cls.padEnd(28)} ${n}`);
console.log("");
console.log("──────────────────────────────────────────────────────────────────────");
console.log(`TRACE — worst grinder: ${traceKey || "none (no grind events anywhere)"}`);
for (const line of traceLog) console.log("  " + line);
