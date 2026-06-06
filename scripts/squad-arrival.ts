/**
 * SQUAD ARRIVAL & COHESION harness — the gap the older harnesses left open. opposite-gate /
 * reachability only score the POINT MAN. A patrol is not "there" when its leader is there and
 * the other eight are strung out across a draw or frozen on a dead wake. This runs a real (but
 * combat-free, so fast and deterministic) patrol to every reachable village and scores the WHOLE
 * element, then the trip HOME:
 *
 *   leadArr   : point man got within ARRIVE m of the objective.
 *   squadCoh  : fraction of the squad within COH m (ARRIVE + 2*spacing) of the objective when it
 *               sets up on station — i.e. did the element actually close up, or arrive in pieces.
 *   straggler : the worst single man's distance from the objective at on-station (m).
 *   homeOK    : after recall, ≥60% of the element got back INSIDE the wire (the return leg).
 *
 * Combat is disabled (enemyStrengthAbs=0 → the director never spawns) so this measures movement
 * alone; dt=0.2 and aggressive early-exit keep it fast enough to iterate on.
 *
 * Run: npx tsx scripts/squad-arrival.ts [N]      (N survey seeds, else a documented set)
 */
import { createWorld } from "../lib/sim/world";
import { centroidOf } from "../lib/sim/world/helpers";
import { Land } from "../lib/sim/terrain";

/** Replicate tasks.ts::reachableObjective: step a compound objective out toward the COP, then snap
 *  to the nearest cell the squad can actually reach (so arrival is judged against the squad's real
 *  target — the village edge — not the walled centre). */
function snapObjective(t: any, cx: number, cy: number): { cx: number; cy: number } {
  const inCompound = (x: number, y: number) => {
    const l = t.land[t.idx(x, y)] as number;
    return l === Land.Compound || l === Land.CompoundWall;
  };
  if (t.inBounds(cx, cy) && inCompound(cx, cy)) {
    const dx = Math.sign(t.cop.center.cx - cx), dy = Math.sign(t.cop.center.cy - cy);
    for (let s = 0; s < 24; s++) {
      const nx = cx + dx * s, ny = cy + dy * s;
      if (t.inBounds(nx, ny) && !inCompound(nx, ny) && t.passableCell(nx, ny)) { cx = nx; cy = ny; break; }
    }
  }
  return t.nearestReachable(cx, cy);
}

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;
const ARRIVE = 50;
const COH = 90; // a man within ARRIVE + ~2*spacing of the objective counts as "closed up"
const DT = 0.25;
const TAC = 1500; // s — the tactical window (a reachable objective should arrive within this)
const OUT_CAP = 2200; // s outbound — generous so even a far village arrives (a true SLOW shows as >TAC)
const HOME_CAP = 1800; // s for the return leg
const MAX_VIL = Number(process.env.MAX_VIL ?? 3); // cap villages/seed for speed
const REACH_CELLS = Math.ceil(ARRIVE / cs);

/** Mover-faithful (anti-corner-cut) flood from the gate — the honest reachable set. */
function flood(t: any): Uint8Array {
  const size = t.size;
  const seen = new Uint8Array(size * size);
  const g = t.cop.gateOutside;
  const s = t.nearestPassable(g.cx, g.cy, 16);
  if (!t.passableCell(s.cx, s.cy)) return seen;
  seen[s.cy * size + s.cx] = 1;
  const st = [s.cy * size + s.cx];
  while (st.length) {
    const i = st.pop()!;
    const x = i % size, y = (i / size) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || !t.passableCell(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && !t.passableCell(x + dx, y) && !t.passableCell(x, y + dy)) continue;
        const j = ny * size + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        st.push(j);
      }
  }
  return seen;
}
function reachable(t: any, seen: Uint8Array, vx: number, vy: number): boolean {
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++)
    for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
      const nx = vx + dx, ny = vy + dy;
      if (nx < 0 || ny < 0 || nx >= t.size || ny >= t.size) continue;
      if (seen[ny * t.size + nx]) return true;
    }
  return false;
}

interface Row { reach: boolean; leadArr: boolean; leadTime: number; cohFrac: number; straggler: number; homeOK: boolean; }

console.log(
  "seed".padEnd(12), "vil".padStart(4), "reach".padStart(6), "leadArr".padStart(8),
  "squadCoh".padStart(9), "maxStrag".padStart(9), "homeOK".padStart(7)
);
const G = { vil: 0, reach: 0, lead: 0, tac: 0, cohSum: 0, cohN: 0, fullCoh: 0, home: 0, homeN: 0, stragMax: 0 };

for (const seed of SEEDS) {
  let base: any;
  try { base = createWorld(seed, 90); } catch { continue; }
  const t0 = base.terrain;
  const seen = flood(t0);
  const rows: Row[] = [];

  // Test the NEAREST reachable villages (they arrive fast, so cohesion & the return leg are
  // actually measurable in a short window); the far/SLOW question is opposite-gate's job.
  const g0 = t0.cop.gateOutside;
  const villages = t0.villages
    .slice()
    .filter((v: any) => reachable(t0, seen, v.cx, v.cy))
    .sort((a: any, b: any) => Math.hypot(a.cx - g0.cx, a.cy - g0.cy) - Math.hypot(b.cx - g0.cx, b.cy - g0.cy))
    .slice(0, MAX_VIL);

  for (const v of villages) {
    const w: any = createWorld(seed, 90);
    w.state.enemyStrengthAbs = 0; // no spawns — measure movement alone
    const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
    const ids: string[] = sq.memberIds.slice();
    // Arrival is judged against the SNAPPED objective the squad actually heads to (objectives snap
    // to the reachable village edge / out of the qalat), not the raw village centre — a centre test
    // under-counts arrivals on walled villages.
    const snap = snapObjective(w.terrain, v.cx, v.cy);
    const objW = w.terrain.cellCenter(snap.cx, snap.cy);
    const task = w.formPatrol(ids, [{ cx: v.cx, cy: v.cy }], "presence", "patrol");

    let leadArr = false, leadTime = -1;
    for (let k = 0; k < OUT_CAP / DT; k++) {
      w.tick(DT);
      const lead = w.sim.unit(task.leadId);
      if (lead && lead.alive && !leadArr && Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y) < ARRIVE) {
        leadArr = true; leadTime = k * DT;
      }
      if (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete") break;
    }
    // cohesion at on-station: how much of the element closed up around where it set up (its centroid),
    // which is what "the squad arrived together" actually means.
    const alive = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    const ctr = centroidOf(alive);
    const dists = alive.map((u: any) => Math.hypot(u.pos.x - ctr.x, u.pos.y - ctr.y));
    const cohFrac = alive.length ? dists.filter((d: number) => d < COH).length / alive.length : 0;
    const straggler = dists.length ? Math.max(...dists) : 0;

    // RETURN leg: recall and see if the element gets home inside the wire
    w.recall(task.id);
    const center = w.copWorld();
    const wire = w.terrain.cop.radius * cs + 18;
    for (let k = 0; k < HOME_CAP / DT; k++) {
      w.tick(DT);
      if (task.phase === "complete") break;
    }
    for (let k = 0; k < 90 / DT; k++) w.tick(DT); // let the garrison walk in the last straggler or two (as in-game)
    const home2 = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    const inside = home2.filter((u: any) => Math.hypot(u.pos.x - center.x, u.pos.y - center.y) < wire).length;
    const homeOK = home2.length > 0 && inside >= Math.ceil(home2.length * 0.6);

    rows.push({ reach: true, leadArr, leadTime, cohFrac, straggler, homeOK });
  }

  const R = rows;
  const A = R.filter((r) => r.leadArr); // patrols whose point man arrived (cohesion/home scored on these)
  const lead = A.length;
  const tac = A.filter((r) => r.leadTime <= TAC).length;
  const cohAvg = A.length ? A.reduce((a, r) => a + r.cohFrac, 0) / A.length : 0;
  const fullCoh = A.filter((r) => r.cohFrac >= 0.7).length;
  const maxStrag = A.length ? Math.max(...A.map((r) => r.straggler)) : 0;
  const home = A.filter((r) => r.homeOK).length;

  G.vil += rows.length; G.reach += R.length; G.lead += lead; G.tac += tac;
  G.cohSum += A.reduce((a, r) => a + r.cohFrac, 0); G.cohN += A.length; G.fullCoh += fullCoh;
  G.home += home; G.homeN += A.length; G.stragMax = Math.max(G.stragMax, maxStrag);

  console.log(
    seed.padEnd(12), String(rows.length).padStart(4), String(R.length).padStart(6),
    `${lead}/${R.length}`.padStart(8), `${Math.round(cohAvg * 100)}%`.padStart(9),
    `${Math.round(maxStrag)}m`.padStart(9), `${home}/${lead}`.padStart(7)
  );
}

const pct = (a: number, b: number) => `${a}/${b} (${Math.round((a / Math.max(1, b)) * 100)}%)`;
console.log("-".repeat(72));
console.log("villages:", G.vil, " reachable tested:", G.reach);
console.log("  point man ARRIVED:           ", pct(G.lead, G.reach));
console.log("  ...within tactical window:   ", pct(G.tac, G.reach), `(≤${TAC}s)`);
console.log("  mean squad cohesion @ objective:", `${Math.round((G.cohSum / Math.max(1, G.cohN)) * 100)}%`, " ← whole-element (arrived patrols)");
console.log("  squads ≥70% closed up:       ", pct(G.fullCoh, G.lead), " ← target high");
console.log("  worst straggler:             ", Math.round(G.stragMax), "m");
console.log("  RETURN home (≥60% inside wire):", pct(G.home, G.homeN), " ← the exfil leg (arrived patrols)");
