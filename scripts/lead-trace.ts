/**
 * Navigator motion trace — for ONE seed + village, tick the real world and sample the point
 * man every `STRIDE` s: distance-to-objective, instantaneous speed (m/s over the stride),
 * paceScale (the cohesion throttle), blockedTimer (wedged on terrain), and remaining route.
 * Separates the two failure modes a "set up short" verdict hides:
 *   THROTTLED — lead keeps moving but slow (paceScale low / terrain): a window/pace problem.
 *   STALLED   — lead speed ~0 for long stretches (wedged / re-path thrash): an execution bug.
 *
 * Run: npx tsx scripts/lead-trace.ts <seed> <villageIndexOrName>
 */
import { createWorld } from "../lib/sim/world";

const seed = process.argv[2] ?? "survey-0";
const vsel = process.argv[3] ?? "0";
const STRIDE = 100; // s between samples
const MAX_S = 1600;

const w: any = createWorld(seed, 90);
const t = w.terrain;
const villages = t.villages;
const v = /^\d+$/.test(vsel) ? villages[Number(vsel)] : villages.find((x: any) => x.name === vsel) ?? villages[0];
const objW = t.cellCenter(v.cx, v.cy);
const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
const task = w.formPatrol(sq.memberIds.slice(), [{ cx: v.cx, cy: v.cy }], "presence", "patrol");

console.log(`seed=${seed} village=${v.name} obj=(${v.cx},${v.cy}) crow=${Math.round(Math.hypot(objW.x - w.gateOutsideWorld().x, objW.y - w.gateOutsideWorld().y))}m`);
console.log("t(s)".padStart(5), "distObj".padStart(7), "spd(m/s)".padStart(8), "pace".padStart(5), "fatig".padStart(5), "mCost".padStart(5), "land".padStart(10), "blkT".padStart(5), "navRem".padStart(7), "phase".padStart(10));

let prev: any = null;
let lastClosest = Infinity;
for (let k = 0; k <= MAX_S * 10; k++) {
  w.tick(0.1);
  const lead = w.sim.unit(task.leadId);
  if (lead) lastClosest = Math.min(lastClosest, Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y));
  if (k % (STRIDE * 10) === 0) {
    const d = lead ? Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y) : NaN;
    const spd = lead && prev ? Math.hypot(lead.pos.x - prev.x, lead.pos.y - prev.y) / STRIDE : 0;
    let navRem = 0;
    if (lead && lead.path) { let p = lead.pos; for (const q of lead.path) { navRem += Math.hypot(q.x - p.x, q.y - p.y); p = q; } }
    const mc = lead ? t.moveCostAt(lead.pos.x, lead.pos.y) : 0;
    const land = lead ? (t as any).landAt(lead.pos.x, lead.pos.y) : "";
    const LAND_NAME = ["River","Marsh","DryWash","Cropland","Terrace","TerraceWall","Orchard","Meadow","Grass","Scrub","Forest","Scree","Boulders","Rock","Cliff","Compound","CompoundWall","Cemetery","Road","Trail","Footbridge","Hesco","Structure","Gravel","Track"];
    console.log(
      String(k / 10).padStart(5), `${Math.round(d)}`.padStart(7), spd.toFixed(2).padStart(8),
      (lead?.paceScale ?? 0).toFixed(2).padStart(5), (lead?.fatigue ?? 0).toFixed(2).padStart(5),
      mc.toFixed(2).padStart(5), String(LAND_NAME[land] ?? land).padStart(10),
      (lead?.blockedTimer ?? 0).toFixed(1).padStart(5),
      `${Math.round(navRem)}`.padStart(7), String(task.phase).padStart(10)
    );
    prev = lead ? { ...lead.pos } : null;
  }
  if (task.phase === "complete") break;
}
console.log(`closest approach: ${Math.round(lastClosest)}m  (ARRIVE=50m ⇒ ${lastClosest < 50 ? "ARRIVED" : "SHORT"})`);
