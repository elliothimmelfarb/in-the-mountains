/**
 * Movement diagnostic harness — reproduces the "squad ordered from inside the COP
 * to a nearby village on the far side of the gate" scenario the player reported,
 * and turns the fuzzy bug ("funny", "got stuck", "bumped the perimeter", "finished
 * without reaching the village") into hard numbers, across seeds.
 *
 * For each seed it forms a presence patrol from sq1 to the village whose bearing is
 * most OPPOSITE the gate (the worst case: the squad must file out the ECP and round
 * the whole HESCO ring through the narrow band between the wall and the hillside),
 * runs the continuous world, and reports:
 *   - arrived:  did the point man actually get within ARRIVE m of the objective?
 *   - bumpTicks: ticks where some squad member was wall-blocked/sliding (blockedTimer>0)
 *   - overlapPk: peak count of member pairs closer than 1.0 m (bodies interpenetrating)
 *   - finishAt:  squad-centroid distance from the objective at the moment the task
 *                left the "moving" phase (onstation/returning). If the task "completed"
 *                far from the objective, that's the dishonest-completion bug.
 *   - wallMin:   closest any moving member came to a HESCO cell while underway (sticking)
 *
 * Run: npx tsx scripts/movement-diag.ts
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const cs = 5;
const ARRIVE = 25; // m — "the point man reached the objective"
const SEEDS = ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11"];

function nearestWallDist(w: any, x: number, y: number): number {
  // distance (m) to the nearest impassable HESCO cell within a 12-cell window
  const t = w.terrain;
  const ccx = Math.floor(x / cs);
  const ccy = Math.floor(y / cs);
  let best = Infinity;
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const gx = ccx + dx;
      const gy = ccy + dy;
      if (!t.inBounds(gx, gy)) continue;
      if ((t.land[t.idx(gx, gy)] as Land) !== Land.Hesco) continue;
      const wx = (gx + 0.5) * cs;
      const wy = (gy + 0.5) * cs;
      const d = Math.hypot(wx - x, wy - y);
      if (d < best) best = d;
    }
  return best;
}

console.log("seed".padEnd(12), "gate→vil°".padStart(9), "vilDist".padStart(8), "arrived".padStart(8), "arrAt(s)".padStart(8), "bumpTk".padStart(7), "ovlpPk".padStart(7), "wallMin".padStart(8), "finishAt".padStart(9), "verdict");

for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    continue;
  }
  const t = w.terrain;
  const cop = t.cop;
  const copC = t.cellCenter(cop.center.cx, cop.center.cy);
  const gateDir = cop.gateDir as { x: number; y: number };
  const gateAng = Math.atan2(gateDir.y, gateDir.x);

  // village whose bearing from the COP is most opposite the gate
  let worst: any = null;
  let worstScore = -Infinity;
  for (const v of t.villages) {
    const bx = (v.cx - cop.center.cx);
    const by = (v.cy - cop.center.cy);
    const ang = Math.atan2(by, bx);
    let diff = Math.abs(ang - gateAng);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const distM = Math.hypot(bx, by) * cs;
    // prefer "opposite the gate" and "close to the COP" (the reported worst case)
    const score = diff - distM / 800;
    if (score > worstScore && distM < 700) {
      worstScore = score;
      worst = v;
    }
  }
  if (!worst) worst = t.villages[0];
  const objAng = (Math.atan2(worst.cy - cop.center.cy, worst.cx - cop.center.cx) - gateAng);
  const gateToVilDeg = Math.round(Math.abs(((objAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI);
  const vilDistM = Math.hypot((worst.cx - cop.center.cx) * cs, (worst.cy - cop.center.cy) * cs);
  const objW = t.cellCenter(worst.cx, worst.cy);

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1")!;
  const ids: string[] = sq.memberIds.slice();
  const task = w.formPatrol(ids, [{ cx: worst.cx, cy: worst.cy }], "presence", "patrol");

  let bumpTicks = 0;
  let overlapPeak = 0;
  let wallMin = Infinity;
  let arrivedAt = -1;
  let finishAt = -1;
  let leadMaxArrive = Infinity;
  let onStation = false; // did the task actually set up on the objective?

  for (let k = 0; k < 12000; k++) {
    // 1200 s
    w.tick(0.1);
    const tn = k * 0.1;
    const members = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    // point-man arrival
    for (const u of members) {
      const d = Math.hypot(u.pos.x - objW.x, u.pos.y - objW.y);
      leadMaxArrive = Math.min(leadMaxArrive, d);
      if (d < ARRIVE && arrivedAt < 0) arrivedAt = tn;
    }
    // bumped the wire this tick?
    for (const u of members) if ((u.blockedTimer ?? 0) > 0) bumpTicks++;
    // body overlaps
    let ov = 0;
    for (let a = 0; a < members.length; a++)
      for (let b = a + 1; b < members.length; b++)
        if (Math.hypot(members[a].pos.x - members[b].pos.x, members[a].pos.y - members[b].pos.y) < 1.0) ov++;
    overlapPeak = Math.max(overlapPeak, ov);
    // sticking to the wall while moving
    for (const u of members)
      if (u.moving) wallMin = Math.min(wallMin, nearestWallDist(w, u.pos.x, u.pos.y));
    if (task && (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete")) onStation = true;
    // moment the task left "moving"
    if (task && finishAt < 0 && task.phase !== "assembling" && task.phase !== "moving") {
      const cen = members.reduce((acc: any, u: any) => ({ x: acc.x + u.pos.x, y: acc.y + u.pos.y }), { x: 0, y: 0 });
      cen.x /= members.length;
      cen.y /= members.length;
      finishAt = Math.hypot(cen.x - objW.x, cen.y - objW.y);
    }
    if (task && task.phase === "complete") break;
  }

  // Success = the element set up on the objective AND the point man actually got to
  // the village edge (objectives snap out of the walled compound, so ~45 m to the
  // village centre IS "on the objective"). That separates a real arrival from a
  // patrol that gave up short.
  const reached = leadMaxArrive < 45;
  const ok = onStation && reached;
  const verdict = ok ? "OK" : onStation ? `SET UP SHORT (closest ${Math.round(leadMaxArrive)}m)` : `STUCK (closest ${Math.round(leadMaxArrive)}m)`;
  console.log(
    seed.padEnd(12),
    String(gateToVilDeg + "°").padStart(9),
    (Math.round(vilDistM) + "m").padStart(8),
    (ok ? "yes" : "NO").padStart(8),
    (arrivedAt >= 0 ? Math.round(arrivedAt) : "-").toString().padStart(8),
    String(bumpTicks).padStart(7),
    String(overlapPeak).padStart(7),
    (wallMin === Infinity ? "-" : Math.round(wallMin) + "m").padStart(8),
    (finishAt >= 0 ? Math.round(finishAt) + "m" : "-").padStart(9),
    verdict
  );
}
