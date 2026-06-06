/**
 * COP interior CONNECTIVITY audit — the metric copaudit.ts was missing.
 *
 * copaudit measures interior open% (how much of the yard is passable) but NOT whether
 * that open space is a single connected yard. valley-2533 showed the gap: 8 buildings
 * packed into a small (R=17) wire seal off interior pockets — passable cells fully
 * enclosed by building footprints — and a garrison man funneled into one grinds on the
 * walls forever because his seat is in a different component.
 *
 * Per seed we report:
 *   R         COP wire radius (cells)            — small R is where packing bites
 *   pockets   interior passable cells NOT reachable from the gate (sealed man-traps). 0 = good
 *   frag      1 - (largest interior component / total interior passable). 0 = one clean yard
 *   minGap    smallest centre-to-edge gap between any two building footprints (m).
 *             <5 m means no walkable street between them
 *   seatBad   garrison seats (TOC/aid/dfac/barracks doorways) NOT in the gate component
 *   grind     building-grind ticks over a 600 s garrison sim (the lived symptom)
 *
 * Run: npx tsx scripts/copinterior.ts [N]   (N => survey-0..N-1; else a named set incl valley-2533)
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath, walkable } from "../lib/sim/path";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["valley-2533", "smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;

function interiorConn(t: any, cop: any) {
  const R = cop.radius;
  const c = cop.center;
  const size = t.size;
  // gather interior passable cells
  const inInterior = (x: number, y: number) => Math.hypot(x - c.cx, y - c.cy) <= R - 1 && t.inBounds(x, y);
  const passList: number[] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const x = c.cx + dx;
      const y = c.cy + dy;
      if (!inInterior(x, y)) continue;
      if (t.passableCell(x, y)) passList.push(y * size + x);
    }
  const passSet = new Set(passList);
  // gate-reachable mask (whole map gate component)
  const reach = t.reachableFromGate();
  let pockets = 0;
  for (const idx of passList) if (!reach[idx]) pockets++;
  // largest interior connected component (flood within interior passable)
  const seen = new Set<number>();
  let largest = 0;
  for (const start of passList) {
    if (seen.has(start)) continue;
    let count = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      count++;
      const cx = cur % size;
      const cy = (cur / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          const ni = ny * size + nx;
          if (!passSet.has(ni) || seen.has(ni)) continue;
          // 8-conn but no corner-cut through two diagonal blocks
          if (dx !== 0 && dy !== 0 && !passSet.has(cy * size + nx) && !passSet.has(ny * size + cx)) continue;
          seen.add(ni);
          stack.push(ni);
        }
    }
    if (count > largest) largest = count;
  }
  const frag = passList.length ? 1 - largest / passList.length : 0;
  return { pockets, frag, totalPass: passList.length };
}

function minBuildingGap(cop: any): number {
  let m = Infinity;
  const bs = cop.buildings;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      // gap between axis-aligned rects (edge to edge), in cells; negative => overlap
      const gx = Math.abs(a.cx - b.cx) - (a.hw + b.hw);
      const gy = Math.abs(a.cy - b.cy) - (a.hh + b.hh);
      const gap = Math.max(gx, gy); // separated if EITHER axis clears
      if (gap < m) m = gap;
    }
  return m * cs;
}

// AUTHORITATIVE reachability: can the planner the garrison actually uses (findPath) get
// from the muster to each building seat / fighting position? This is the ground-truth
// metric — a seat that findPath can't reach is a man who grinds on a wall forever.
// (reachableFromGate is 8-connected and corner-cuts; findPath forbids corner-cuts, so it
// is stricter and is what movement experiences.)
function reachFails(t: any, cop: any): { seats: number; seatLabels: string[]; fps: number } {
  const muW = t.cellCenter(cop.muster.cx, cop.muster.cy);
  const arrives = (p: any) => {
    const r = findPath(t, muW, p);
    const e = r[r.length - 1];
    if (!e || Math.hypot(e.x - p.x, e.y - p.y) >= cs * 2) return false; // best-effort ended short
    // Reject findPath's degenerate single-waypoint fallback ([goal] straight through a wall): a real
    // route is multi-point, or — for an adjacent goal — straight-walkable. Without this the oracle is
    // FOOLED into "reachable" for a goal in a disconnected pocket (its [goal] endpoint sits AT p).
    return r.length > 1 || walkable(t, muW, p);
  };
  let seatsBadN = 0;
  const labels: string[] = [];
  for (const b of cop.buildings) {
    if (b.kind === "motorpool") continue;
    if (!arrives(t.buildingSeat(b))) {
      seatsBadN++;
      labels.push(b.label ?? b.kind);
    }
  }
  let fpsBad = 0;
  for (const f of cop.fightingPositions) if (!arrives(t.cellCenter(f.cx, f.cy))) fpsBad++;
  return { seats: seatsBadN, seatLabels: labels, fps: fpsBad };
}

function grindSim(seed: string): number {
  const w: any = createWorld(seed, 60);
  const t = w.terrain;
  const cop = t.cop;
  const center = w.copWorld();
  const wire = cop.radius * cs;
  const adjStruct = (px: number, py: number) => {
    const cx = Math.floor(px / cs);
    const cy = Math.floor(py / cs);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (t.inBounds(cx + dx, cy + dy) && (t.land[t.idx(cx + dx, cy + dy)] as Land) === Land.Structure) return true;
    return false;
  };
  let grind = 0;
  const dt = 0.2;
  for (let k = 0; k < 3000; k++) {
    w.tick(dt);
    for (const m of w.platoon.members) {
      if (!m.alive || m.status === "wounded" || m.evac) continue;
      const u = w.sim.unit(m.id);
      if (!u) continue;
      if (Math.hypot(u.pos.x - center.x, u.pos.y - center.y) > wire + 10) continue;
      if (u.moving === true && u.speed < 0.02 && adjStruct(u.pos.x, u.pos.y)) grind++;
    }
  }
  return grind;
}

// seatBad / fpBad are the AUTHORITATIVE pass/fail (findPath muster->target). pockets/frag/
// minGap are secondary diagnostics; grind is the lived symptom.
console.log(
  "seed".padEnd(12),
  "R".padStart(4),
  "seatBad".padStart(8),
  "fpBad".padStart(6),
  "pockets".padStart(8),
  "frag".padStart(6),
  "minGap".padStart(7),
  "grind".padStart(7)
);
let anyUnreach = 0;
let anyGrind = 0;
let totSeatBad = 0;
let totFpBad = 0;
for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    continue;
  }
  const t = w.terrain;
  const cop = t.cop;
  const { pockets, frag } = interiorConn(t, cop);
  const gap = minBuildingGap(cop);
  const rf = reachFails(t, cop);
  const grind = grindSim(seed);
  if (rf.seats > 0 || rf.fps > 0) anyUnreach++;
  totSeatBad += rf.seats;
  totFpBad += rf.fps;
  if (grind > 50) anyGrind++;
  console.log(
    seed.padEnd(12),
    String(cop.radius).padStart(4),
    String(rf.seats).padStart(8),
    String(rf.fps).padStart(6),
    String(pockets).padStart(8),
    frag.toFixed(2).padStart(6),
    (gap.toFixed(0) + "m").padStart(7),
    String(grind).padStart(7),
    rf.seatLabels.length ? "  [" + rf.seatLabels.join(",") + "]" : ""
  );
}
console.log(`\nseeds with an unreachable seat or fighting position: ${anyUnreach}/${SEEDS.length}  (MUST be 0)`);
console.log(`total unreachable seats: ${totSeatBad}, fighting positions: ${totFpBad}  (MUST be 0)`);
console.log(`seeds with >50 building-grind ticks/600s: ${anyGrind}/${SEEDS.length}`);
