/**
 * Per-village blame harness — for ONE seed, dump everything about each village objective so
 * a "set up short / stuck" failure resolves into a cause, not a guess:
 *
 *   fineBFS : 8-connected passableCell flood from the gate reaches within ARRIVE m (physical).
 *   route   : findPath(gateOutside → village): #waypoints, length, end-gap to the objective,
 *             ratio vs crow. endGap > ARRIVE means the ROUTER gave up short (best-effort).
 *   sim     : real continuous world — closest the point man got, when, final task phase, and
 *             the navigator's remaining route length at the end (0 ⇒ he walked his whole plan
 *             and it ended short; >0 ⇒ he stalled mid-plan / the stall backstop fired).
 *
 * Verdict apportions blame: UNREACHABLE (fineBFS false) · ROUTER (route ends short though
 * fineBFS true) · EXEC (router route is fine but the squad never followed it close) ·
 * SLOW (arrived, but only late) · OK.
 *
 * Run: npx tsx scripts/why-short.ts <seed>
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";

const seed = process.argv[2] ?? "survey-0";
const cs = 5;
const ARRIVE = 50;
const REACH_CELLS = Math.ceil(ARRIVE / cs);
const MAX_S = 1500;

function flood(t: any, fx: number, fy: number): Uint8Array {
  const size = t.size;
  const seen = new Uint8Array(size * size);
  const s = t.nearestPassable(fx, fy, 12);
  if (!t.passableCell(s.cx, s.cy)) return seen;
  seen[s.cy * size + s.cx] = 1;
  const st = [s.cy * size + s.cx];
  while (st.length) {
    const i = st.pop()!;
    const x = i % size, y = (i / size) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (seen[j] || !t.passableCell(nx, ny)) continue;
      seen[j] = 1; st.push(j);
    }
  }
  return seen;
}
function reach(t: any, seen: Uint8Array, vx: number, vy: number): boolean {
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++) for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
    const nx = vx + dx, ny = vy + dy;
    if (nx < 0 || ny < 0 || nx >= t.size || ny >= t.size) continue;
    if (seen[ny * t.size + nx]) return true;
  }
  return false;
}
function routeLen(pts: any[], start: any): number {
  let L = 0, p = start;
  for (const q of pts) { L += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return L;
}

const base = createWorld(seed, 90);
const t0 = base.terrain;
const cop = t0.cop;
const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
const seen = flood(t0, cop.gateOutside.cx, cop.gateOutside.cy);
const floodN = seen.reduce((a, b) => a + b, 0);
console.log(`seed=${seed}  COP=(${cop.center.cx},${cop.center.cy})  gateDir=(${cop.gateDir.x.toFixed(2)},${cop.gateDir.y.toFixed(2)})  flood=${floodN} cells (${Math.round(100*floodN/(t0.size*t0.size))}% of map)`);
console.log("village".padEnd(12), "bearing".padStart(7), "crowM".padStart(6), "fineBFS".padStart(7), "wpts".padStart(4), "routeM".padStart(7), "endGap".padStart(7), "ratio".padStart(6), "closeM".padStart(7), "atS".padStart(5), "phase".padStart(10), "navRem".padStart(7), "  verdict");

for (const v of t0.villages) {
  const bearing = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
  let diff = Math.abs(bearing - gateAng); if (diff > Math.PI) diff = 2*Math.PI - diff;
  const deg = Math.round((diff * 180) / Math.PI);
  const objW = t0.cellCenter(v.cx, v.cy);
  const crow = Math.hypot(objW.x - base.gateOutsideWorld().x, objW.y - base.gateOutsideWorld().y);
  const fineBFS = reach(t0, seen, v.cx, v.cy);
  const route = findPath(t0, base.gateOutsideWorld(), objW, { roadBias: 0.25 });
  const rEnd = route[route.length - 1];
  const endGap = rEnd ? Math.hypot(rEnd.x - objW.x, rEnd.y - objW.y) : Infinity;
  const rLen = routeLen(route, base.gateOutsideWorld());

  const ww: any = createWorld(seed, 90);
  const sq = ww.platoon.squads.find((s: any) => s.id === "sq1");
  const task = ww.formPatrol(sq.memberIds.slice(), [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
  let closest = Infinity, atS = -1;
  for (let k = 0; k < MAX_S * 10; k++) {
    ww.tick(0.1);
    const lead = ww.sim.unit(task.leadId);
    if (lead && lead.alive) { const d = Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y); if (d < closest) { closest = d; atS = k/10; } }
    if (closest < ARRIVE) break;
    if (task.phase === "complete") break;
  }
  const lead = ww.sim.unit(task.leadId);
  let navRem = 0;
  if (lead && lead.path) { let p = lead.pos; for (const q of lead.path) { navRem += Math.hypot(q.x - p.x, q.y - p.y); p = q; } }

  const arrived = closest < ARRIVE;
  const verdict = !fineBFS ? "UNREACHABLE" : arrived ? (atS > 1000 ? "SLOW" : "OK") : endGap > ARRIVE ? "ROUTER (route ends short)" : "EXEC (route ok, squad short)";
  console.log(
    v.name.padEnd(12), `${deg}°`.padStart(7), `${Math.round(crow)}`.padStart(6),
    (fineBFS ? "yes" : "NO").padStart(7), String(route.length).padStart(4),
    `${Math.round(rLen)}`.padStart(7), `${Math.round(endGap)}`.padStart(7), (rLen/Math.max(1,crow)).toFixed(2).padStart(6),
    `${Math.round(closest)}`.padStart(7), (atS>=0?Math.round(atS):"-").toString().padStart(5),
    task.phase.padStart(10), `${Math.round(navRem)}`.padStart(7), "  " + verdict
  );
}
