/**
 * village-drill — per-village patrol-arrival drill for ONE seed: forms a real squad patrol to each
 * village (or one named village) and reports closest approach + arrival time. The drill companion
 * to reachability.ts: when its aggregate count moves, this names WHICH village and answers
 * slow-vs-stuck (a closing distance at window end = slow; a frozen one = stuck).
 * Run: [ITM_REACH_MAXS=2500] [ITM_NOTREADCAP=1] npx tsx scripts/village-drill.ts <seed> [village]
 */
import { createWorld } from "../lib/sim/world";
const SEED = process.argv[2] || "smoke-test";
const MAX_S = Number(process.env.ITM_REACH_MAXS ?? 1500);
const ARRIVE = 50;
const w: any = createWorld(SEED, 90);
for (const v of w.terrain.villages) {
  if (process.argv[3] && v.name !== process.argv[3]) continue;
  const ww: any = createWorld(SEED, 90);
  const sq = ww.platoon.squads.find((s: any) => s.id === "sq1");
  const objW = ww.terrain.cellCenter(v.cx, v.cy);
  const task = ww.formPatrol(sq.memberIds.slice(), [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
  let closest = Infinity, tArrive = -1;
  for (let k = 0; k < MAX_S * 10; k++) {
    ww.tick(0.1);
    const lead = ww.sim.unit(task.leadId);
    if (lead && lead.alive) {
      const d = Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y);
      if (d < closest) closest = d;
      if (closest < ARRIVE && tArrive < 0) { tArrive = k / 10; break; }
    }
    if (task.phase === "complete") break;
  }
  console.log(`${v.name.padEnd(12)} closest=${closest.toFixed(0).padStart(5)}m  ${tArrive >= 0 ? "ARRIVED @ " + tArrive.toFixed(0) + "s" : "MISS"}`);
}
