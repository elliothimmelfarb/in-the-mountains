/**
 * Squad COHESION harness — turns "the movement looks bad" into hard numbers.
 *
 * The existing movement-diag measures success/failure (did the squad arrive, did it
 * grind the wire). This one measures the TEXTURE of the move while it is underway —
 * the things a viewer reads as "real" or "wrong":
 *
 *   - paceEff:   mean centroid speed / nominal technique speed while in the "moving"
 *                phase, outside the gate. 1.0 = moving at doctrinal pace; 0.3 = crawling.
 *   - paceP10:   10th-percentile of instantaneous centroid speed (the stalls/stutters).
 *   - throttle:  fraction of moving ticks where the navigator's paceScale < 0.95
 *                (how often the squad self-brakes), and its mean value when braking.
 *   - lenCV:     coefficient of variation of formation LENGTH (along-travel span). High
 *                = the accordion: the column stretches and concertinas. Real columns
 *                hold a near-constant length.
 *   - jitter:    mean per-member heading change (deg/s) while moving. High = dithering /
 *                turnstile / robotic wobble. Real infantry walk smooth arcs.
 *   - blocked:   mean fraction of members wall-blocked per tick (grinding the terrain).
 *   - reachT:    seconds until the point man first reaches the objective (-1 = never).
 *
 * Run: npx tsx scripts/cohesion.ts [seeds...]
 */
import { createWorld } from "../lib/sim/world";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11"];

const cs = 5;
const ARRIVE = 25;

// nominal pace for "patrol" technique (matches TECH_SPEED.patrol in combat.ts)
const NOMINAL = 1.5;

interface Row {
  seed: string;
  vilDist: number;
  paceEff: number;
  paceP10: number;
  throttleFrac: number;
  throttleMean: number;
  lenCV: number;
  jitter: number;
  blocked: number;
  reachT: number;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function run(seed: string): Row | null {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    return null;
  }
  const t = w.terrain;
  const cop = t.cop;
  const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  // village most opposite the gate, within 700 m (the reported worst case)
  let vil: any = null;
  let bs = -Infinity;
  for (const v of t.villages) {
    const ang = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
    let df = Math.abs(ang - gateAng);
    if (df > Math.PI) df = 2 * Math.PI - df;
    const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * cs;
    const score = df - dm / 800;
    if (score > bs && dm < 700) {
      bs = score;
      vil = v;
    }
  }
  if (!vil) vil = t.villages[0];
  const objW = t.cellCenter(vil.cx, vil.cy);
  const vilDist = Math.hypot(objW.x - t.cellCenter(cop.center.cx, cop.center.cy).x, objW.y - t.cellCenter(cop.center.cy, cop.center.cy).y);

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
  const ids: string[] = sq.memberIds.slice();
  const task = w.formPatrol(ids, [{ cx: vil.cx, cy: vil.cy }], "presence", "patrol");

  const speeds: number[] = []; // centroid instantaneous speed while moving outside gate
  const lengths: number[] = []; // formation along-travel span
  const headChanges: number[] = []; // per-member |dHeading|/dt
  let throttleTicks = 0;
  let movingTicks = 0;
  let throttleSum = 0;
  let blockedSum = 0;
  let reachT = -1;

  let prevCentroid: { x: number; y: number } | null = null;
  const prevFacing: Record<string, number> = {};

  for (let k = 0; k < 12000; k++) {
    w.tick(0.1);
    const tn = k * 0.1;
    const members = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    if (members.length === 0) break;
    const cen = members.reduce((a: any, u: any) => ({ x: a.x + u.pos.x, y: a.y + u.pos.y }), { x: 0, y: 0 });
    cen.x /= members.length;
    cen.y /= members.length;

    // point-man arrival
    for (const u of members) {
      if (Math.hypot(u.pos.x - objW.x, u.pos.y - objW.y) < ARRIVE && reachT < 0) reachT = tn;
    }

    // Only score the "moving" phase, and only once the element is outside the wire
    // (the gate file-out is its own behavior). t.exited gates that.
    const scoring = task && task.phase === "moving" && task.exited;
    if (scoring) {
      movingTicks++;
      // centroid speed
      if (prevCentroid) {
        const v = Math.hypot(cen.x - prevCentroid.x, cen.y - prevCentroid.y) / 0.1;
        speeds.push(v);
      }
      // navigator throttle
      const nav = w.sim.unit(task.leadId);
      const ps = nav?.paceScale ?? 1;
      if (ps < 0.95) {
        throttleTicks++;
        throttleSum += ps;
      }
      // formation length: project members onto travel axis
      const nav2 = w.sim.unit(task.leadId);
      let axis = { x: 1, y: 0 };
      if (nav2) axis = { x: Math.cos(nav2.facing), y: Math.sin(nav2.facing) };
      let lo = Infinity;
      let hi = -Infinity;
      for (const u of members) {
        const proj = (u.pos.x - cen.x) * axis.x + (u.pos.y - cen.y) * axis.y;
        lo = Math.min(lo, proj);
        hi = Math.max(hi, proj);
      }
      lengths.push(hi - lo);
      // blocked fraction
      let blk = 0;
      for (const u of members) if ((u.blockedTimer ?? 0) > 0) blk++;
      blockedSum += blk / members.length;
      // heading jitter
      for (const u of members) {
        if (prevFacing[u.id] !== undefined && u.moving) {
          let dh = Math.abs(u.facing - prevFacing[u.id]);
          if (dh > Math.PI) dh = Math.PI * 2 - dh;
          headChanges.push((dh * 180) / Math.PI / 0.1);
        }
        prevFacing[u.id] = u.facing;
      }
    }
    prevCentroid = cen;

    if (task && (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete")) break;
  }

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const lenMean = mean(lengths);
  const lenSD = lengths.length ? Math.sqrt(mean(lengths.map((l) => (l - lenMean) ** 2))) : 0;

  return {
    seed,
    vilDist,
    paceEff: mean(speeds) / NOMINAL,
    paceP10: pct(speeds, 0.1),
    throttleFrac: movingTicks ? throttleTicks / movingTicks : 0,
    throttleMean: throttleTicks ? throttleSum / throttleTicks : 1,
    lenCV: lenMean ? lenSD / lenMean : 0,
    jitter: mean(headChanges),
    blocked: movingTicks ? blockedSum / movingTicks : 0,
    reachT,
  };
}

console.log(
  "seed".padEnd(12),
  "vilDist".padStart(8),
  "paceEff".padStart(8),
  "paceP10".padStart(8),
  "throt%".padStart(7),
  "throtX".padStart(7),
  "lenCV".padStart(6),
  "jit°/s".padStart(7),
  "blkd%".padStart(6),
  "reach(s)".padStart(8)
);
const rows: Row[] = [];
for (const seed of SEEDS) {
  const r = run(seed);
  if (!r) continue;
  rows.push(r);
  console.log(
    seed.padEnd(12),
    (Math.round(r.vilDist) + "m").padStart(8),
    r.paceEff.toFixed(2).padStart(8),
    r.paceP10.toFixed(2).padStart(8),
    (Math.round(r.throttleFrac * 100) + "%").padStart(7),
    r.throttleMean.toFixed(2).padStart(7),
    r.lenCV.toFixed(2).padStart(6),
    r.jitter.toFixed(0).padStart(7),
    (Math.round(r.blocked * 100) + "%").padStart(6),
    (r.reachT >= 0 ? Math.round(r.reachT) : "-").toString().padStart(8)
  );
}
const m = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
console.log("-".repeat(86));
console.log(
  "MEAN".padEnd(12),
  "".padStart(8),
  m((r) => r.paceEff).toFixed(2).padStart(8),
  m((r) => r.paceP10).toFixed(2).padStart(8),
  (Math.round(m((r) => r.throttleFrac) * 100) + "%").padStart(7),
  m((r) => r.throttleMean).toFixed(2).padStart(7),
  m((r) => r.lenCV).toFixed(2).padStart(6),
  m((r) => r.jitter).toFixed(0).padStart(7),
  (Math.round(m((r) => r.blocked) * 100) + "%").padStart(6),
  ""
);
