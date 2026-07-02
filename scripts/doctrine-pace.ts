/**
 * doctrine-pace — DOCTRINE PACE CHECK (durable probe; born in the 2026-07-02 realism campaign).
 *
 * Turns "movement feels off" into a number: for each seed, run ONE combat-free patrol
 * (squad-arrival.ts plumbing: enemyStrengthAbs=0, DT=0.25, snapped objective) to the
 * FARTHEST mover-reachable village (anti-corner-cut BFS flood from the gate), and compare
 * the squad's effective speed against the FM oracle:
 *
 *   FM 21-18 cross-country, day:  2.4 km/h
 *   FM 3-97.6 mountain factor:    +1 h per 300 m of ascent (Naismith-style)
 *   ⇒ FM-predicted kph = dist_km / (dist_km/2.4 + ascent_m/300)
 *
 * Clock starts when the task first leaves "assembling" (the yard→gate muster is not part
 * of the march); dist = point-man ground track (sampled every tick), ascent = sum of
 * positive elevation deltas sampled every ≥10 m of track (damps meander noise).
 * ratio ≈ 1.0 ⇒ doctrine-honest; >1 too fast; <1 too slow.
 *
 * Run: npx tsx scripts/doctrine-pace.ts [seedCount]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const cs = 5;
const ARRIVE = 50; // m — same arrival rule as reachability.ts / squad-arrival.ts
const DT = 0.25;
const CAP_S = 7200; // generous: 1.6 km at 0.6 kph is ~2.7 h... cap at 2 h and flag DNF

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["survey-0", "survey-1", "survey-2", "survey-3", "survey-5", "korengal", "valley-3", "ridge-11"];

/** Mover-faithful (anti-corner-cut) flood from the gate — copied from squad-arrival.ts. */
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
const REACH_CELLS = Math.ceil(ARRIVE / cs);
function reachable(t: any, seen: Uint8Array, vx: number, vy: number): boolean {
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++)
    for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
      const nx = vx + dx, ny = vy + dy;
      if (nx < 0 || ny < 0 || nx >= t.size || ny >= t.size) continue;
      if (seen[ny * t.size + nx]) return true;
    }
  return false;
}

/** Replicate tasks.ts::reachableObjective (copied from squad-arrival.ts). */
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

console.log(
  "seed".padEnd(10), "village".padEnd(12), "crow".padStart(6), "walked".padStart(7),
  "ascent".padStart(7), "desc".padStart(6), "time".padStart(7),
  "simKph".padStart(7), "fmKph".padStart(6), "ratio".padStart(6), "  note"
);

const ratios: number[] = [];
for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 90); } catch { continue; }
  const t = w.terrain;
  w.state.enemyStrengthAbs = 0; // combat-free — measure movement alone
  const seen = flood(t);
  const g0 = t.cop.gateOutside;

  // farthest mover-reachable village ⇒ longest honest march
  const cands = t.villages.filter((v: any) => reachable(t, seen, v.cx, v.cy));
  if (!cands.length) { console.log(seed.padEnd(10), "(no reachable village)"); continue; }
  const v = cands.sort((a: any, b: any) =>
    Math.hypot(b.cx - g0.cx, b.cy - g0.cy) - Math.hypot(a.cx - g0.cx, a.cy - g0.cy))[0];

  const snap = snapObjective(t, v.cx, v.cy);
  const objW = t.cellCenter(snap.cx, snap.cy);
  const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
  const task = w.formPatrol(sq.memberIds.slice(), [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
  const gateW = w.gateOutsideWorld();
  const crow = Math.hypot(objW.x - gateW.x, objW.y - gateW.y);

  let started = false, t0 = 0, tArr = -1;
  let walked = 0, ascent = 0, descent = 0;
  let prev: { x: number; y: number } | null = null;
  let elevRef = 0, distSinceElev = 0;
  let closest = Infinity;

  for (let k = 0; k < CAP_S / DT; k++) {
    w.tick(DT);
    const lead = w.sim.unit(task.leadId);
    if (!lead || !lead.alive) {
      if (started) break; // lead lost mid-march
      continue; // still assembling — leadId not in the sim yet
    }
    if (!started && task.phase !== "assembling") {
      started = true; t0 = k * DT;
      prev = { ...lead.pos };
      elevRef = t.elevAt(lead.pos.x, lead.pos.y);
    }
    if (started && prev) {
      const step = Math.hypot(lead.pos.x - prev.x, lead.pos.y - prev.y);
      walked += step;
      distSinceElev += step;
      prev = { ...lead.pos };
      if (distSinceElev >= 10) { // sample elevation every ≥10 m of track
        const e = t.elevAt(lead.pos.x, lead.pos.y);
        const de = e - elevRef;
        if (de > 0) ascent += de; else descent -= de;
        elevRef = e;
        distSinceElev = 0;
      }
      const d = Math.hypot(lead.pos.x - objW.x, lead.pos.y - objW.y);
      if (d < closest) closest = d;
      if (d < ARRIVE) { tArr = k * DT; break; }
    }
    if (task.phase === "complete") break;
  }

  const elapsed = (tArr >= 0 ? tArr : CAP_S) - t0;
  const h = elapsed / 3600;
  const km = walked / 1000;
  const simKph = h > 0 ? km / h : 0;
  const fmH = km / 2.4 + ascent / 300; // FM 21-18 + FM 3-97.6 ascent tax
  const fmKph = fmH > 0 ? km / fmH : 0;
  const ratio = fmKph > 0 ? simKph / fmKph : 0;
  const note = tArr >= 0 ? "arrived" : `DNF (closest ${Math.round(closest)}m)`;
  if (tArr >= 0) ratios.push(ratio);

  console.log(
    seed.padEnd(10), v.name.padEnd(12), `${Math.round(crow)}m`.padStart(6),
    `${Math.round(walked)}m`.padStart(7), `${Math.round(ascent)}m`.padStart(7),
    `${Math.round(descent)}m`.padStart(6), `${Math.round(elapsed)}s`.padStart(7),
    simKph.toFixed(2).padStart(7), fmKph.toFixed(2).padStart(6), ratio.toFixed(2).padStart(6),
    "  " + note
  );
}

if (ratios.length) {
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const sorted = ratios.slice().sort((a, b) => a - b);
  console.log(`\narrived ${ratios.length}/${SEEDS.length} — ratio sim/FM: mean ${mean.toFixed(2)}, min ${sorted[0].toFixed(2)}, max ${sorted[sorted.length - 1].toFixed(2)}  (1.0 = doctrine-honest; >1 too fast, <1 too slow)`);
}
