/**
 * Village reachability — the fair, gameplay-true movement metric. The movement-diag
 * harness deliberately picks the ONE village most opposite the gate (an adversarial
 * worst case that, on rugged ground, can sit across a genuine cliff band). This
 * instead forms a patrol to EVERY village on each seed and reports how many the point
 * man actually reaches, with the route length — which is what a player experiences
 * sending patrols across the AO.
 *
 * arrive = point man got within 50 m of the village (objectives snap to the village
 * edge out of the walled qalat, so ~45 m IS "on the objective").
 *
 * Run: npx tsx scripts/reachability.ts [N]   (N survey seeds, else a documented set)
 */
import { createWorld } from "../lib/sim/world";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;
const ARRIVE = 50; // m
const MAX_S = 1500; // generous window — a far village around a cliff is a long march

let totalVil = 0;
let totalArrived = 0;
console.log("seed".padEnd(12), "villages".padStart(9), "arrived".padStart(8), "rate".padStart(6), "  worst-miss");

for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 90);
  } catch {
    continue;
  }
  const villages = w.terrain.villages.slice();
  let arrived = 0;
  let worstMiss = 0;
  let worstVil = "";
  for (const v of villages) {
    // fresh world per village so tasks don't interfere
    const ww: any = createWorld(seed, 90);
    const sq = ww.platoon.squads.find((s: any) => s.id === "sq1");
    const ids: string[] = sq.memberIds.slice();
    const objW = ww.terrain.cellCenter(v.cx, v.cy);
    const task = ww.formPatrol(ids, [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
    let closest = Infinity;
    for (let k = 0; k < MAX_S * 10; k++) {
      ww.tick(0.1);
      const lead = ww.sim.unit(task.leadId);
      if (lead && lead.alive) closest = Math.min(closest, Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y));
      if (closest < ARRIVE) break;
      if (task.phase === "complete") break;
    }
    if (closest < ARRIVE) arrived++;
    else if (closest > worstMiss) {
      worstMiss = closest;
      worstVil = v.name;
    }
  }
  totalVil += villages.length;
  totalArrived += arrived;
  const rate = Math.round((arrived / Math.max(1, villages.length)) * 100);
  console.log(
    seed.padEnd(12),
    String(villages.length).padStart(9),
    String(arrived).padStart(8),
    (rate + "%").padStart(6),
    worstMiss > 0 ? `  miss ${worstVil} by ${Math.round(worstMiss)}m` : "  all reached"
  );
}
console.log("\nTOTAL villages reached:", totalArrived, "/", totalVil, `(${Math.round((totalArrived / totalVil) * 100)}%)`);
