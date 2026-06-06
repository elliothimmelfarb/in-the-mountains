/**
 * Completeness probe for stranding vectors NOT covered by terrain-audit / squad-arrival
 * (which only test presence patrols gate->village->gate).
 *
 * VECTOR A — civilian inter-village errands. buildRoutine() gives ~50% of villagers a
 *   market node at ANOTHER village, snapped via civSafePoint -> nearestPassable (NOT
 *   nearestReachable). civMoveTo -> findPath then returns a BEST-EFFORT path to the
 *   nearest reachable cell when the goal is in a different component. We measure, per
 *   civilian: is the snapped market target in the SAME 8-connected (anti-corner-cut)
 *   component as the civilian's home/start? and how far short does the real findPath end?
 *
 * VECTOR B — a NON-VILLAGE objective across the river with NO nearby ford. The task's
 *   reachableObjective -> nearestReachable snaps such a point back to the squad's bank,
 *   so the squad never aims across. We confirm the snap actually moves the point to the
 *   gate's component, and measure the residual findPath shortfall to the SNAPPED point
 *   (should be ~0). We also report the RAW (unsnapped) shortfall to show what the snap
 *   is protecting against.
 *
 * Run: npx tsx scripts/strand-vectors.ts [N]   (N seeds, default 30)
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath } from "../lib/sim/path";

const SEEDS = Array.from({ length: Number(process.argv[2] ?? 30) }, (_, i) => "survey-" + i);
const ARRIVE = 50; // m — "arrived" threshold used by the harness/game

/** 8-connected component labels honouring the SAME anti-corner-cut rule the mover uses. */
function components(t: any): Int32Array {
  const size = t.size;
  const comp = new Int32Array(size * size).fill(-1);
  let count = 0;
  for (let s = 0; s < size * size; s++) {
    const sx = s % size, sy = (s / size) | 0;
    if (comp[s] !== -1 || !t.passableCell(sx, sy)) continue;
    const id = count++;
    comp[s] = id;
    const st = [s];
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
          if (comp[j] !== -1) continue;
          comp[j] = id;
          st.push(j);
        }
    }
  }
  return comp;
}

function compAt(t: any, comp: Int32Array, p: { x: number; y: number }): number {
  const cx = Math.floor(p.x / t.cellSize), cy = Math.floor(p.y / t.cellSize);
  if (!t.inBounds(cx, cy)) return -1;
  return comp[t.idx(cx, cy)];
}
function nearestPassableComp(t: any, comp: Int32Array, cx: number, cy: number): number {
  const p = t.nearestPassable(cx, cy);
  return comp[t.idx(p.cx, p.cy)];
}
function whichBank(t: any, p: { x: number; y: number }): string {
  const cy = Math.floor(p.y / t.cellSize);
  const cx = Math.floor(p.x / t.cellSize);
  const river = Math.round(t.centerXAt(cy));
  return cx < river ? "W" : "E";
}

console.log("=== VECTOR A: civilian inter-village errands ===");
console.log(
  "seed".padEnd(11),
  "civs".padStart(5),
  "mktNodes".padStart(9),
  "xRiver".padStart(7),
  "diffComp".padStart(9),
  "pathStrand".padStart(11),
  "worstShortM".padStart(12)
);

const A = { civs: 0, mkt: 0, xRiver: 0, diffComp: 0, strand: 0, worstShort: 0 };

for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t = w.terrain;
  const comp = components(t);
  const sim = w.sim;
  const civs = sim.units.filter((u: any) => u.faction === "civilian" && u.alive);

  let mkt = 0, xRiver = 0, diffComp = 0, strand = 0, worstShort = 0;
  for (const u of civs) {
    if (!u.routine) continue;
    const homeComp = compAt(t, comp, u.pos);
    const homeBank = whichBank(t, u.pos);
    for (const node of u.routine) {
      // market node = an errand far enough to be a real inter-village hop (>160m, the
      // threshold civilianBrain uses to apply road bias)
      const far = Math.hypot(node.target.x - u.pos.x, node.target.y - u.pos.y) > 160;
      if (!far) continue;
      mkt++;
      const tgtBank = whichBank(t, node.target);
      const tgtComp = compAt(t, comp, node.target);
      if (tgtBank !== homeBank) xRiver++;
      const reallyDiff = tgtComp !== -1 && homeComp !== -1 && tgtComp !== homeComp;
      if (reallyDiff) diffComp++;
      // The REAL path the civilian would walk (civMoveTo with road bias for a far errand).
      // civSafePoint snaps the goal first (as the game does), then findPath.
      const goal = t.civSafePoint(node.target.x, node.target.y);
      const route = findPath(t, u.pos, goal, { roadBias: 0.4 });
      const end = route[route.length - 1];
      const short = Math.hypot(end.x - goal.x, end.y - goal.y);
      if (short > ARRIVE) { strand++; worstShort = Math.max(worstShort, short); }
    }
  }
  A.civs += civs.length; A.mkt += mkt; A.xRiver += xRiver; A.diffComp += diffComp;
  A.strand += strand; A.worstShort = Math.max(A.worstShort, worstShort);
  console.log(
    seed.padEnd(11),
    String(civs.length).padStart(5),
    String(mkt).padStart(9),
    String(xRiver).padStart(7),
    String(diffComp).padStart(9),
    String(strand).padStart(11),
    (worstShort ? Math.round(worstShort) + "m" : "-").padStart(12)
  );
}
console.log("-".repeat(72));
console.log(`civilians: ${A.civs}  far-errand nodes: ${A.mkt}  cross-river: ${A.xRiver}  diff-component: ${A.diffComp}`);
console.log(`PATH-STRANDED far errands (ends >${ARRIVE}m short): ${A.strand}/${A.mkt}  worst short: ${Math.round(A.worstShort)}m`);

console.log("\n=== VECTOR B: non-village objective across the river, no nearby ford ===");
console.log(
  "seed".padEnd(11),
  "probes".padStart(7),
  "rawDiffC".padStart(9),
  "rawShort".padStart(9),
  "snapDiffC".padStart(10),
  "snapShort".padStart(10)
);
const B = { probes: 0, rawDiff: 0, rawStrand: 0, snapDiff: 0, snapStrand: 0, worstSnap: 0 };

for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t = w.terrain;
  const size = t.size;
  const comp = components(t);
  const gateW = w.gateOutsideWorld();
  const gateComp = compAt(t, comp, gateW);

  // Probe points: dry valley-floor cells on the OPPOSITE bank from the gate, at least
  // ~120 cells (>=2 ford-spacings) up/down the valley from the gate row so the nearest
  // ford is a long detour — exactly the "point across the river, no nearby ford" case.
  const gx = t.cop.gateOutside.cx, gy = t.cop.gateOutside.cy;
  let probes = 0, rawDiff = 0, rawStrand = 0, snapDiff = 0, snapStrand = 0, worstSnap = 0;
  for (let dyc = -100; dyc <= 100; dyc += 25) {
    const py = gy + dyc;
    if (py < 4 || py >= size - 4) continue;
    const river = Math.round(t.centerXAt(py));
    const gateBank = gx < river ? -1 : +1;
    const farBank = -gateBank; // opposite side
    // step ~14 cells onto the far bank's dry floor
    let px = river + farBank * 14;
    if (px < 4 || px >= size - 4) continue;
    const passable = t.nearestPassable(px, py);
    px = passable.cx; const ppy = passable.cy;
    const rawComp = comp[t.idx(px, ppy)];
    if (rawComp === -1) continue;
    probes++;
    const rawW = t.cellCenter(px, ppy);
    // RAW: route straight at the unsnapped far-bank point (what an un-protected caller does)
    const rawRoute = findPath(t, gateW, rawW, { roadBias: 0.25 });
    const rawEnd = rawRoute[rawRoute.length - 1];
    const rawShortM = Math.hypot(rawEnd.x - rawW.x, rawEnd.y - rawW.y);
    if (rawComp !== gateComp) rawDiff++;
    if (rawShortM > ARRIVE) rawStrand++;
    // SNAPPED: the game's protection — nearestReachable then route
    const snap = t.nearestReachable(px, ppy);
    const snapW = t.cellCenter(snap.cx, snap.cy);
    const snapComp = comp[t.idx(snap.cx, snap.cy)];
    const snapRoute = findPath(t, gateW, snapW, { roadBias: 0.25 });
    const snapEnd = snapRoute[snapRoute.length - 1];
    const snapShortM = Math.hypot(snapEnd.x - snapW.x, snapEnd.y - snapW.y);
    if (snapComp !== gateComp) snapDiff++;
    if (snapShortM > ARRIVE) { snapStrand++; worstSnap = Math.max(worstSnap, snapShortM); }
  }
  B.probes += probes; B.rawDiff += rawDiff; B.rawStrand += rawStrand;
  B.snapDiff += snapDiff; B.snapStrand += snapStrand; B.worstSnap = Math.max(B.worstSnap, worstSnap);
  console.log(
    seed.padEnd(11),
    String(probes).padStart(7),
    String(rawDiff).padStart(9),
    String(rawStrand).padStart(9),
    String(snapDiff).padStart(10),
    String(snapStrand).padStart(10)
  );
}
console.log("-".repeat(72));
console.log(`far-bank probes: ${B.probes}`);
console.log(`  RAW (unsnapped): diff-component ${B.rawDiff}/${B.probes}, findPath-strands ${B.rawStrand}/${B.probes}`);
console.log(`  SNAPPED (nearestReachable, as the squad task does): diff-component ${B.snapDiff}/${B.probes}, findPath-strands ${B.snapStrand}/${B.probes}, worst ${Math.round(B.worstSnap)}m`);
