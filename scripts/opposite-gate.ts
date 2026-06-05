/**
 * Adversarial single-waypoint harness — the headline DoD metric for "ONE WAYPOINT,
 * ALWAYS". For each seed it forms a presence patrol from sq1 to EVERY village (the real
 * objectives a player sends patrols to), runs the CONTINUOUS world, and asks the only
 * honest question: did the point man actually arrive — AND was that village even
 * physically reachable on foot to begin with?
 *
 * Ground truth: an 8-connected BFS flood over passableCell from the gate-outside staging
 * cell. A village is "REACHABLE" if any passable cell within ARRIVE m of its centre is in
 * that flood. This is the physical ceiling — the most a perfect mover could ever reach.
 * The bug we are killing is the gap between REACHABLE and ARRIVED (a village you could
 * walk to but the squad doesn't). The bug we must NOT introduce is a false success
 * (arrived at a village the flood says is walled off — impossible, a metric error).
 *
 * Villages are bucketed by bearing relative to the gate (FRONT ≤60°, FLANK 60–120°,
 * REAR >120° = "diametrically opposite the gate", the adversarial worst case), and the
 * single most-opposite village is called out per seed. The summary reports, separately
 * for ALL and for REAR:  reachable, arrived, and arrived-among-reachable (→ target 100%).
 *
 * Run: npx tsx scripts/opposite-gate.ts [N]   (N survey seeds, else a documented set)
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;
const ARRIVE = 50; // m — objectives snap to the village edge, so ~45 m IS "on the objective"
const REACH_CELLS = Math.ceil(ARRIVE / cs); // a passable cell this close to the village counts
const MAX_S = 1500; // generous window — a far village around a cliff is a long march

/** 8-connected flood over passableCell from a seed cell. Returns the seen bitmap. */
function floodPassable(t: any, fromCx: number, fromCy: number): Uint8Array {
  const size = t.size;
  const seen = new Uint8Array(size * size);
  const start = t.nearestPassable(fromCx, fromCy, 12);
  const si = start.cy * size + start.cx;
  if (!t.passableCell(start.cx, start.cy)) return seen;
  seen[si] = 1;
  const stack = [si];
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % size;
    const y = (i / size) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (seen[j] || !t.passableCell(nx, ny)) continue;
        seen[j] = 1;
        stack.push(j);
      }
  }
  return seen;
}

/** Is any passable cell within REACH_CELLS of (vx,vy) in the flood — i.e. could a perfect
 *  mover physically get within ARRIVE m of the village from the gate. */
function reachable(t: any, seen: Uint8Array, vx: number, vy: number): boolean {
  const size = t.size;
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++)
    for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
      const nx = vx + dx;
      const ny = vy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (seen[ny * size + nx]) return true;
    }
  return false;
}

interface Row { reach: boolean; arrived: boolean; rear: boolean; miss: number; nullRoute: boolean; }

console.log(
  "seed".padEnd(12),
  "vil".padStart(4),
  "reach".padStart(6),
  "arr".padStart(4),
  "arr/reach".padStart(10),
  "REAR r/a".padStart(9),
  "falseOK".padStart(8),
  "  worst false-miss (reachable, not arrived)"
);

const G = { vil: 0, reach: 0, arr: 0, arrReach: 0, rearReach: 0, rearArr: 0, falseOK: 0, nullR: 0 };

for (const seed of SEEDS) {
  let base: any;
  try {
    base = createWorld(seed, 90);
  } catch {
    continue;
  }
  const t0 = base.terrain;
  const cop = t0.cop;
  const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  const goCell = t0.cop.gateOutside;
  const seen = floodPassable(t0, goCell.cx, goCell.cy);

  const rows: Row[] = [];
  let worstMissName = "";
  let worstMiss = 0;
  for (const v of t0.villages) {
    const bearing = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
    let diff = Math.abs(bearing - gateAng);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const rear = diff > (120 * Math.PI) / 180;
    const isReach = reachable(t0, seen, v.cx, v.cy);

    // Does the router even return a route (vs the unreachable best-effort)?
    const objW = t0.cellCenter(v.cx, v.cy);
    const route = findPath(t0, base.gateOutsideWorld(), objW, { roadBias: 0.25 });
    const routeEnd = route[route.length - 1];
    const nullRoute = !routeEnd || Math.hypot(routeEnd.x - objW.x, routeEnd.y - objW.y) > ARRIVE;

    // Real sim, fresh world per village so tasks don't interfere.
    const ww: any = createWorld(seed, 90);
    const sq = ww.platoon.squads.find((s: any) => s.id === "sq1");
    const ids: string[] = sq.memberIds.slice();
    const oW = ww.terrain.cellCenter(v.cx, v.cy);
    const task = ww.formPatrol(ids, [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
    let closest = Infinity;
    for (let k = 0; k < MAX_S * 10; k++) {
      ww.tick(0.1);
      const lead = ww.sim.unit(task.leadId);
      if (lead && lead.alive) closest = Math.min(closest, Math.hypot(lead.pos.x - oW.x, lead.pos.y - oW.y));
      if (closest < ARRIVE) break;
      if (task.phase === "complete") break;
    }
    const arrived = closest < ARRIVE;
    if (isReach && !arrived && closest - ARRIVE > worstMiss) {
      worstMiss = closest - ARRIVE;
      worstMissName = v.name;
    }
    rows.push({ reach: isReach, arrived, rear, miss: closest, nullRoute });
  }

  const vil = rows.length;
  const reachN = rows.filter((r) => r.reach).length;
  const arrN = rows.filter((r) => r.arrived).length;
  const arrReachN = rows.filter((r) => r.reach && r.arrived).length;
  const rearReachN = rows.filter((r) => r.rear && r.reach).length;
  const rearArrN = rows.filter((r) => r.rear && r.reach && r.arrived).length;
  const falseOK = rows.filter((r) => r.arrived && !r.reach).length;
  const nullR = rows.filter((r) => r.nullRoute).length;

  G.vil += vil; G.reach += reachN; G.arr += arrN; G.arrReach += arrReachN;
  G.rearReach += rearReachN; G.rearArr += rearArrN; G.falseOK += falseOK; G.nullR += nullR;

  console.log(
    seed.padEnd(12),
    String(vil).padStart(4),
    String(reachN).padStart(6),
    String(arrN).padStart(4),
    `${arrReachN}/${reachN}`.padStart(10),
    `${rearArrN}/${rearReachN}`.padStart(9),
    String(falseOK).padStart(8),
    worstMiss > 0 ? `  ${worstMissName} +${Math.round(worstMiss)}m` : "  (none)"
  );
}

const pct = (a: number, b: number) => `${a}/${b} (${Math.round((a / Math.max(1, b)) * 100)}%)`;
console.log("-".repeat(92));
console.log("TOTAL villages:", G.vil);
console.log("  BFS-reachable on foot:        ", pct(G.reach, G.vil), "  ← the physical ceiling");
console.log("  ARRIVED (real sim):           ", pct(G.arr, G.vil));
console.log("  ARRIVED among REACHABLE:      ", pct(G.arrReach, G.reach), "  ← DoD target 100%");
console.log("  REAR (opposite-gate) arr/reach:", pct(G.rearArr, G.rearReach), "  ← the adversarial bucket");
console.log("  false success (arr, !reach):  ", G.falseOK, "  (must be 0 — else a metric error)");
console.log("  router NULL routes (best-effort):", pct(G.nullR, G.vil));
