/**
 * CORRIDOR / BEST-EFFORT SHORTFALL probe.
 *
 * For each FAR reachable objective (same sampling as terrain-audit), compare three things:
 *   bfs   : free 8-connected passableCell flood from gate reaches within ARRIVE m (PHYSICAL truth).
 *   freeA*: a FREE full-resolution A* (no corridor, no clip, big budget) end-gap to the objective.
 *           This is the "router could find it if it weren't corridor/budget-limited" oracle.
 *   findP : the real findPath() end-gap.
 *
 * Verdict (only for bfs-reachable targets):
 *   CORRIDOR  : freeA* arrives (<=ARRIVE) but findPath is short (>ARRIVE)  ← the corridor/best-effort
 *               shortfall this assignment is about: goal is reachable, free fine A* proves it, yet the
 *               corridor-confined pass + best-effort fallback hand back a short route.
 *   BUDGET    : freeA* itself is short even at a generous budget — distinguishes "router can't reach
 *               within ANY full-res search" (budget/expansion) from corridor confinement.
 *   OK        : findPath arrives.
 *   BFS-only  : bfs reachable but freeA* short for some other reason (diagnostic).
 *
 * Also dumps, for CORRIDOR cases, the coarse vs free path lengths so we can see the coarse line
 * cutting a wall the corridor can't escape.
 *
 * Run: npx tsx scripts/corridor-shortfall.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";
import { Terrain } from "../lib/sim/terrain";
import { Vec2 } from "../lib/sim/vec";

const SEEDS = Array.from({ length: Number(process.argv[2] ?? 20) }, (_, i) => "survey-" + i);
const cs = 5;
const ARRIVE = 50;
const REACH_CELLS = Math.ceil(ARRIVE / cs);

function flood(t: Terrain, fx: number, fy: number): Uint8Array {
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
function reach(t: Terrain, seen: Uint8Array, vx: number, vy: number): boolean {
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++) for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
    const nx = vx + dx, ny = vy + dy;
    if (nx < 0 || ny < 0 || nx >= t.size || ny >= t.size) continue;
    if (seen[ny * t.size + nx]) return true;
  }
  return false;
}

/** Free full-resolution A* (no corridor, no clip), big budget — the oracle. Returns end-gap (m)
 *  and path length, or {gap:Infinity} if it can't even start. Plain Dijkstra-ish A* on passable cells. */
function freeAstar(t: Terrain, start: Vec2, goal: Vec2, maxExpand: number): { gap: number; len: number; expanded: number } {
  const size = t.size;
  const sx = Math.max(0, Math.min(size - 1, Math.floor(start.x / cs)));
  const sy = Math.max(0, Math.min(size - 1, Math.floor(start.y / cs)));
  const gx = Math.max(0, Math.min(size - 1, Math.floor(goal.x / cs)));
  const gy = Math.max(0, Math.min(size - 1, Math.floor(goal.y / cs)));
  const sSnap = t.nearestPassable(sx, sy, 12);
  const startI = sSnap.cy * size + sSnap.cx;
  const goalI = gy * size + gx;
  const g = new Float64Array(size * size).fill(Infinity);
  const came = new Int32Array(size * size).fill(-1);
  const closed = new Uint8Array(size * size);
  const h = (i: number) => { const x = i % size, y = (i / size) | 0; const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)); };
  // simple binary heap
  const heap: { i: number; f: number }[] = [];
  const push = (i: number, f: number) => { heap.push({ i, f }); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break;[heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  g[startI] = 0; push(startI, h(startI));
  let expanded = 0, bestI = startI, bestH = h(startI), found = false;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const cur = pop();
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    if (cur.i === goalI) { found = true; bestI = goalI; break; }
    const hc = h(cur.i); if (hc < bestH) { bestH = hc; bestI = cur.i; }
    if (++expanded > maxExpand) break;
    const cx = cur.i % size, cy = (cur.i / size) | 0;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (!t.passableCell(nx, ny)) continue;
      const ni = ny * size + nx;
      if (closed[ni]) continue;
      const step = (dx && dy) ? Math.SQRT2 : 1;
      const tent = g[cur.i] + step;
      if (tent < g[ni]) { g[ni] = tent; came[ni] = cur.i; push(ni, tent + h(ni)); }
    }
  }
  const endX = bestI % size, endY = (bestI / size) | 0;
  const gap = Math.hypot((endX + 0.5) * cs - goal.x, (endY + 0.5) * cs - goal.y);
  return { gap: found ? 0 : gap, len: g[bestI] * cs, expanded };
}

function routeEnd(route: Vec2[], goal: Vec2): number {
  const e = route[route.length - 1];
  return e ? Math.hypot(e.x - goal.x, e.y - goal.y) : Infinity;
}
function routeLen(pts: Vec2[], start: Vec2): number {
  let L = 0, p = start;
  for (const q of pts) { L += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return L;
}

const tally = { far: 0, ok: 0, corridor: 0, budget: 0, bfsOnly: 0, miss: 0 };
const corridorCases: string[] = [];

for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t: Terrain = w.terrain;
  const size = t.size;
  const seen = flood(t, t.cop.gateOutside.cx, t.cop.gateOutside.cy);
  const gateW: Vec2 = w.gateOutsideWorld();
  const gx = t.cop.gateOutside.cx, gy = t.cop.gateOutside.cy;

  for (let s = 0; s < 40; s++) {
    const ang = (s / 40) * Math.PI * 2;
    const rad = 60 + ((s * 37) % 120);
    const tx = Math.round(gx + Math.cos(ang) * rad);
    const ty = Math.round(gy + Math.sin(ang) * rad);
    if (tx < 2 || ty < 2 || tx >= size - 2 || ty >= size - 2) continue;
    if (!reach(t, seen, tx, ty)) continue;
    tally.far++;
    const objW = t.cellCenter(tx, ty);
    const fp = findPath(t, gateW, objW, { roadBias: 0.25 });
    const fpGap = routeEnd(fp, objW);
    if (fpGap <= ARRIVE) { tally.ok++; continue; }
    tally.miss++;
    // findPath came up short. Is it corridor-confinement or a true budget/expansion limit?
    const free = freeAstar(t, gateW, objW, 400000); // very generous budget
    if (free.gap <= ARRIVE) {
      tally.corridor++;
      if (corridorCases.length < 24) {
        const crow = Math.hypot(objW.x - gateW.x, objW.y - gateW.y);
        corridorCases.push(
          `${seed} obj(${tx},${ty}) crow=${Math.round(crow)}m  findPgap=${Math.round(fpGap)}m  freeA*gap=${Math.round(free.gap)}m  freeLen=${Math.round(free.len)}m (${(free.len / Math.max(1, crow)).toFixed(1)}x)  fpLen=${Math.round(routeLen(fp, gateW))}m  freeExp=${free.expanded}`
        );
      }
    } else {
      // freeA* also short even at 400k expansions — budget/expansion or genuinely walled (but bfs said reachable!)
      const free2 = freeAstar(t, gateW, objW, 4000000);
      if (free2.gap <= ARRIVE) tally.budget++;
      else tally.bfsOnly++;
    }
  }
}

console.log("=".repeat(80));
console.log(`seeds=${SEEDS.length}  far reachable objectives sampled: ${tally.far}`);
console.log(`  OK (findPath arrives):              ${tally.ok}`);
console.log(`  findPath MISS:                      ${tally.miss}  (${Math.round(100 * tally.miss / Math.max(1, tally.far))}%)`);
console.log(`    └ CORRIDOR shortfall (freeA* arrives @400k, findPath short): ${tally.corridor}  ← THE BUG CLASS`);
console.log(`    └ BUDGET (freeA* arrives only @4M):                          ${tally.budget}`);
console.log(`    └ BFS-only (freeA* short even @4M; bfs/flood disagree):      ${tally.bfsOnly}`);
console.log("-".repeat(80));
console.log("CORRIDOR shortfall cases (freeA* proves reachable, findPath gives up short):");
for (const c of corridorCases) console.log("  " + c);
