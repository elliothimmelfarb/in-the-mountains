/**
 * LIVE confirmation of the civilian inter-village stranding vector. Force every
 * civilian that HAS a far (>160m) routine node onto that errand, run the sim, and
 * after N minutes measure: did they arrive (within 50m of the goal) or are they
 * stalled at a barrier (path empty / no progress, still far from the goal)?
 *
 * Run: npx tsx scripts/civ-live.ts [seed] [minutes]
 */
import { createWorld } from "../lib/sim/world";

const seed = process.argv[2] ?? "survey-27";
const minutes = Number(process.argv[3] ?? 12);
const w: any = createWorld(seed, 60);
const t = w.terrain;
const sim = w.sim;
const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);

const civs = sim.units.filter((u: any) => u.faction === "civilian" && u.alive);
// pick each civ's FARTHEST routine node (the inter-village errand); assign it as goal
type Job = { u: any; goal: any; start: any };
const jobs: Job[] = [];
for (const u of civs) {
  if (!u.routine) continue;
  let best: any = null, bestD = 160;
  for (const node of u.routine) {
    const d = dist(node.target, u.pos);
    if (d > bestD) { bestD = d; best = node; }
  }
  if (!best) continue;
  const goal = t.civSafePoint(best.target.x, best.target.y);
  jobs.push({ u, goal, start: { ...u.pos } });
  // command it now (road bias, as civilianBrain does for far errands)
  sim.civMoveTo(u, best.target, 0.4);
}

const dt = 0.5;
const steps = Math.round((minutes * 60) / dt);
// track per-job min distance achieved + last-progress time
const minD = new Map<Job, number>();
const lastMoveAt = new Map<Job, number>();
for (const j of jobs) { minD.set(j, dist(j.u.pos, j.goal)); lastMoveAt.set(j, 0); }

for (let s = 0; s < steps; s++) {
  w.tick(dt);
  const tt = s * dt;
  for (const j of jobs) {
    if (!j.u.alive) continue;
    const d = dist(j.u.pos, j.goal);
    if (d < (minD.get(j) ?? Infinity) - 1) { minD.set(j, d); lastMoveAt.set(j, tt); }
    // re-issue the errand if the brain cleared the path (calm re-pick is random; we keep forcing it)
    if (j.u.path.length === 0 && d > 50 && j.u.panic < 0.2) {
      // only re-issue if it has actually been sitting still a while (let it finish a leg first)
      if (tt - (lastMoveAt.get(j) ?? 0) > 8) sim.civMoveTo(j.u, j.goal, 0.4);
    }
  }
}

let arrived = 0, stalled = 0;
let worstStall = 0;
const stallSamples: number[] = [];
for (const j of jobs) {
  const md = minD.get(j) ?? Infinity;
  if (md <= 50) arrived++;
  else { stalled++; stallSamples.push(Math.round(md)); worstStall = Math.max(worstStall, md); }
}
stallSamples.sort((a, b) => b - a);
console.log(`seed ${seed}  sim ${minutes} min  civilians on far errands: ${jobs.length}`);
console.log(`  ARRIVED (came within 50m of goal): ${arrived}`);
console.log(`  STALLED (never closer than 50m):   ${stalled}   worst min-gap ${Math.round(worstStall)}m`);
console.log(`  stalled min-gaps (m, desc): ${stallSamples.slice(0, 20).join(", ")}`);
