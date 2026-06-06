/**
 * FOLLOWER STRANDING harness. The cohesion harness measures the centroid; the
 * point-man arrival is checked by movement-diag. NEITHER checks per-follower
 * outcomes. This one runs a patrol to onstation and reports, for EACH man:
 *   - did he ever get within ARRIVE of the objective while the squad was on station
 *   - his distance from the squad centroid at onstation (straggler gap)
 *   - peak time spent with blockedTimer>6 (wedged / re-pathing to rejoin)
 *   - whether he was left inside the wire after t.exited
 *
 * Reports the WORST follower per seed and the global worst cases.
 *
 * Run: npx tsx scripts/follower-strand.ts [seeds...]
 */
import { createWorld } from "../lib/sim/world";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11",
     "alpha-1", "bravo-2", "charlie-3", "delta-4", "echo-5", "foxtrot-6", "golf-7", "hotel-8",
     "india-9", "juliet-10", "kilo-11", "lima-12", "mike-13", "november-14", "oscar-15"];

const ARRIVE = 25;

interface Per {
  id: string;
  role: string;
  arrivedObj: boolean;        // ever within ARRIVE of objective
  gapAtStation: number;       // dist from centroid when squad reaches onstation/return
  maxWedgeS: number;          // longest continuous stretch with blockedTimer>6
  insideWireAfterExit: number; // ticks spent inside wire after t.exited became true
}

function run(seed: string) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { return null; }
  const t = w.terrain;
  const cop = t.cop;
  const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  let vil: any = null, bs = -Infinity;
  for (const v of t.villages) {
    const ang = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
    let df = Math.abs(ang - gateAng); if (df > Math.PI) df = 2 * Math.PI - df;
    const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * 5;
    const score = df - dm / 800;
    if (score > bs && dm < 700) { bs = score; vil = v; }
  }
  if (!vil) vil = t.villages[0];
  const objW = t.cellCenter(vil.cx, vil.cy);

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
  const ids: string[] = sq.memberIds.slice();
  const task = w.formPatrol(ids, [{ cx: vil.cx, cy: vil.cy }], "presence", "patrol");

  const wire = cop.radius * t.cellSize;
  const copW = w.copWorld();

  const per: Record<string, Per> = {};
  for (const id of ids) {
    const u = w.sim.unit(id);
    per[id] = { id, role: u?.role ?? "?", arrivedObj: false, gapAtStation: -1, maxWedgeS: 0, insideWireAfterExit: 0 };
  }
  const wedgeRun: Record<string, number> = {};

  let reachedStation = false;
  let stationCentroid: { x: number; y: number } | null = null;

  for (let k = 0; k < 16000; k++) {
    w.tick(0.1);
    const members = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    if (members.length === 0) break;

    for (const u of members) {
      const p = per[u.id];
      if (Math.hypot(u.pos.x - objW.x, u.pos.y - objW.y) < ARRIVE) p.arrivedObj = true;
      // wedge tracking
      const bt = u.blockedTimer ?? 0;
      if (bt > 6) { wedgeRun[u.id] = (wedgeRun[u.id] ?? 0) + 0.1; p.maxWedgeS = Math.max(p.maxWedgeS, wedgeRun[u.id]); }
      else wedgeRun[u.id] = 0;
      // inside-wire-after-exit
      if (task?.exited && task.phase === "moving" && Math.hypot(u.pos.x - copW.x, u.pos.y - copW.y) < wire - 6) {
        p.insideWireAfterExit++;
      }
    }

    if (!reachedStation && task && (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete")) {
      reachedStation = true;
      const cen = members.reduce((a: any, u: any) => ({ x: a.x + u.pos.x, y: a.y + u.pos.y }), { x: 0, y: 0 });
      cen.x /= members.length; cen.y /= members.length;
      stationCentroid = cen;
      for (const u of members) per[u.id].gapAtStation = Math.hypot(u.pos.x - cen.x, u.pos.y - cen.y);
      break;
    }
  }

  return { seed, per: Object.values(per), reachedStation, objDist: Math.hypot(objW.x - copW.x, objW.y - copW.y) };
}

const rows: any[] = [];
console.log(
  "seed".padEnd(12), "objDist".padStart(8), "station?".padStart(8),
  "worstGap".padStart(9), "worstRole".padStart(12), "noArrive".padStart(9), "maxWedge".padStart(9), "wireStuck".padStart(10)
);
for (const seed of SEEDS) {
  const r = run(seed);
  if (!r) continue;
  rows.push(r);
  // worst straggler: largest gap at station
  let worst = r.per[0];
  for (const p of r.per) if (p.gapAtStation > worst.gapAtStation) worst = p;
  const noArrive = r.per.filter((p: Per) => !p.arrivedObj).length;
  const maxWedge = Math.max(...r.per.map((p: Per) => p.maxWedgeS));
  const wireStuck = Math.max(...r.per.map((p: Per) => p.insideWireAfterExit)) * 0.1; // seconds
  console.log(
    seed.padEnd(12),
    (Math.round(r.objDist) + "m").padStart(8),
    (r.reachedStation ? "yes" : "NO").padStart(8),
    (Math.round(worst.gapAtStation) + "m").padStart(9),
    worst.role.padStart(12),
    (noArrive + "/" + r.per.length).padStart(9),
    (maxWedge.toFixed(1) + "s").padStart(9),
    (wireStuck.toFixed(1) + "s").padStart(10)
  );
}
