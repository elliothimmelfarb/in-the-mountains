/**
 * RETURN-leg audit. Run a patrol out to a village, let it set up on station, then
 * watch the RETURN. Distinguish HOW the task closed:
 *   HOME-INSIDE : >=60% of pax genuinely inside the wire (real success)
 *   GAVEUP-OUT  : task flipped to complete via the noProgress backstop while the
 *                 centroid was still well OUTSIDE the wire (stranding masked as done)
 *   TIMEOUT     : never completed in the window
 * Also reports the closest the centroid got to the COP and how many men ended inside.
 *
 * Run: npx tsx scripts/return-audit.ts [seedPrefix] [count]
 */
import { createWorld } from "../lib/sim/world";

const cs = 5;
const prefix = process.argv[2] ?? "survey-";
const count = parseInt(process.argv[3] ?? "12", 10);
const MAX_S = 4000;

function centroid(w: any, ids: string[]) {
  let x = 0, y = 0, n = 0;
  for (const id of ids) { const u = w.sim.unit(id); if (u && u.alive) { x += u.pos.x; y += u.pos.y; n++; } }
  return n ? { x: x / n, y: y / n, n } : null;
}

let homeInside = 0, gaveUpOut = 0, timeout = 0, neverReached = 0;
for (let s = 0; s < count; s++) {
  const seed = `${prefix}${s}`;
  const w: any = createWorld(seed, 90);
  const t = w.terrain; const cop = t.cop;
  const copC = t.cellCenter(cop.center.cx, cop.center.cy);
  const wire = cop.radius * cs;
  // pick a mid-range reachable village (not the very farthest, which often is unreachable terrain)
  const vils = t.villages.slice().sort((a: any, b: any) =>
    Math.hypot(a.cx - cop.center.cx, a.cy - cop.center.cy) - Math.hypot(b.cx - cop.center.cy, b.cy - cop.center.cy));
  const v = vils[Math.min(vils.length - 1, Math.floor(vils.length / 2))];
  const sq = w.platoon.squads.find((q: any) => q.id === "sq1")!;
  const task = w.formPatrol(sq.memberIds.slice(), [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
  const ids = sq.memberIds.slice();

  let reachedStation = false;
  let closestReturn = Infinity;
  let finalInside = 0;
  let endPhase = "";
  let returningSeen = false;
  for (let k = 0; k < MAX_S * 10; k++) {
    w.tick(0.1);
    if (task.phase === "onstation") reachedStation = true;
    if (task.phase === "returning") {
      returningSeen = true;
      const c = centroid(w, ids);
      if (c) closestReturn = Math.min(closestReturn, Math.hypot(c.x - copC.x, c.y - copC.y));
    }
    if (task.phase === "complete") { endPhase = "complete"; break; }
    // shortcut: if on station forever, force timer down by skipping ahead — but dwell is bounded; just let it run
  }
  // count men inside at the end
  finalInside = ids.filter((id: string) => { const u = w.sim.unit(id); return u && u.alive && Math.hypot(u.pos.x - copC.x, u.pos.y - copC.y) < wire + 18; }).length;
  const aliveN = ids.filter((id: string) => { const u = w.sim.unit(id); return u && u.alive; }).length;

  let verdict: string;
  if (!reachedStation) { verdict = "NEVER-REACHED-OBJ"; neverReached++; }
  else if (endPhase !== "complete") { verdict = "TIMEOUT-RETURNING"; timeout++; }
  else if (finalInside >= Math.ceil(aliveN * 0.6)) { verdict = "HOME-INSIDE"; homeInside++; }
  else { verdict = "GAVEUP-OUT (completed, but " + finalInside + "/" + aliveN + " inside, closest=" + Math.round(closestReturn) + "m vs wire " + Math.round(wire) + ")"; gaveUpOut++; }

  console.log(seed.padEnd(11), "wire=" + Math.round(wire), "closestRet=" + (closestReturn === Infinity ? "-" : Math.round(closestReturn)),
    "inside=" + finalInside + "/" + aliveN, returningSeen ? "" : "(noReturnPhase)", " => " + verdict);
}
console.log(`\nHOME-INSIDE=${homeInside}  GAVEUP-OUT=${gaveUpOut}  TIMEOUT=${timeout}  NEVER-REACHED=${neverReached}  (n=${count})`);
