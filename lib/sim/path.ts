import { Terrain, Land } from "./terrain";
import { Vec2 } from "./vec";

/**
 * Terrain-aware foot pathfinding. Hierarchical A* (a fast coarse route across
 * the valley, repaired at full resolution only where it would clip a 5 m wall)
 * using the terrain's movement cost, with optional concealment / road / cover
 * biases so a "concealed" route threads forest and washes while a "traveling"
 * one takes the road. Patrols and infiltrating fighters both route through this,
 * so the ground genuinely shapes how everyone moves.
 */

export interface PathOptions {
  /** 0 = fastest route; up to ~0.8 = strongly prefer concealment (slower, covered). */
  concealBias?: number;
  /** Prefer staying off the skyline / hugging cover (used by the enemy). */
  coverBias?: number;
  /** 0..1 preference for roads & trails — fast movement uses the MSR when it can. */
  roadBias?: number;
  /** Cap on node expansions before giving up (returns straight-line fallback). */
  maxExpand?: number;
}

interface Node {
  i: number;
  g: number;
  f: number;
}

/** A tiny binary heap keyed on f. */
class Heap {
  private a: Node[] = [];
  get size() {
    return this.a.length;
  }
  push(n: Node) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && a[l].f < a[m].f) m = l;
        if (r < n && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Pathfinding is hierarchical, which is what makes it both correct and cheap:
 *  - a fast **coarse** A* (≈15 m nodes) finds the long route across the valley
 *    for next to nothing (a few thousand node expansions);
 *  - then string-pulling walks that route, and wherever a straight segment would
 *    clip a 5 m feature (a wall, a cliff lip) it splices in a short **fine** A*
 *    (full-resolution, but only over that ~15 m gap) to get cleanly around it.
 * So long-range stays coarse-cheap, and the only full-resolution work is the few
 * metres where it actually matters — no unit is ever handed a path it can't walk.
 */
const COARSE = 3; // ~15 m coarse nodes on the 5 m grid
const BARRIER_PENALTY = 10; // how hard a coarse node is charged for the walls/cliffs it contains

// Reusable A* scratch. At full resolution the working arrays are large (one
// entry per cell), so allocating + clearing them every call dominates the cost.
// Instead we keep them and stamp each cell with the call's "generation" — a
// stale stamp means the cell is unvisited, so no per-call clear is needed.
let SCRATCH_N = 0;
let gScratch = new Float64Array(0);
let cameScratch = new Int32Array(0);
let gGen = new Int32Array(0); // generation that last wrote gScratch[i]
let closedGen = new Int32Array(0); // generation that last closed i
let PF_GEN = 0;

function ensureScratch(n: number) {
  if (SCRATCH_N >= n) return;
  SCRATCH_N = n;
  gScratch = new Float64Array(n);
  cameScratch = new Int32Array(n);
  gGen = new Int32Array(n);
  closedGen = new Int32Array(n);
}

/**
 * Find a foot route from `start` to `goal` (world meters). Returns world-space
 * waypoints (excluding the start), or a single straight-line waypoint to the
 * goal if no route is found. Coarse global route + fine local repair.
 */
export function findPath(terrain: Terrain, start: Vec2, goal: Vec2, opts: PathOptions = {}): Vec2[] {
  const coarse = route(terrain, start, goal, COARSE, opts, 60000);
  if (!coarse) return [{ ...goal }]; // unreachable — best effort
  return stringPull(terrain, start, coarse, opts);
}

/**
 * A* at coarsening factor `f`, returning world-space node-center waypoints
 * (snapped onto passable ground) ending at `goal`, or null if unreachable
 * within the budget. Uses generation-stamped scratch — no per-call clear.
 */
function route(terrain: Terrain, start: Vec2, goal: Vec2, f: number, opts: PathOptions, maxExpand: number): Vec2[] | null {
  const cw = Math.ceil(terrain.size / f);
  const concealBias = opts.concealBias ?? 0;
  const coverBias = opts.coverBias ?? 0;
  const roadBias = opts.roadBias ?? 0;

  const toCoarse = (w: number) => Math.min(cw - 1, Math.max(0, Math.floor(w / (terrain.cellSize * f))));
  const sx = toCoarse(start.x);
  const sy = toCoarse(start.y);
  const gx = toCoarse(goal.x);
  const gy = toCoarse(goal.y);
  const startI = sy * cw + sx;
  const goalI = gy * cw + gx;
  if (startI === goalI) return [{ ...goal }];

  // Per-node cost, averaged over the f×f block. A node stays passable if ANY of it
  // is (so a node straddling a thin wall can't seal off a reachable goal) — but a
  // node carrying impassable cells (a HESCO/compound wall, a cliff) is charged a
  // steep barrier penalty proportional to how blocked it is. Without this, a 2-cell
  // wall is invisible at 15 m coarse nodes (each wall node still has ~7 passable
  // apron/interior cells), so A* would tunnel straight through a walled COP instead
  // of routing around it. The penalty is quadratic: a stray blocked cell barely
  // matters, but a half-wall node costs many times a clear one, so "around" wins
  // while a genuinely narrow lone passage is discouraged, never sealed.
  const nodeCost = (ci: number): number => {
    const x0 = (ci % cw) * f;
    const y0 = ((ci / cw) | 0) * f;
    let passable = 0;
    let inb = 0;
    let moveSum = 0;
    let concealSum = 0;
    let coverSum = 0;
    let roadCells = 0;
    for (let yy = 0; yy < f; yy++) {
      const fy = y0 + yy;
      if (fy >= terrain.size) continue;
      for (let xx = 0; xx < f; xx++) {
        const fx = x0 + xx;
        if (fx >= terrain.size) continue;
        inb++;
        if (!terrain.passableCell(fx, fy)) continue;
        passable++;
        const idx = terrain.idx(fx, fy);
        moveSum += clampMove(terrain, fx, fy);
        concealSum += terrain.conceal[idx];
        coverSum += terrain.cover[idx];
        const l = terrain.land[idx] as Land;
        if (l === Land.Road || l === Land.Trail || l === Land.Footbridge) roadCells++;
      }
    }
    if (passable === 0) return Infinity;
    let c = passable / moveSum; // = 1 / (avg move cost)
    const blockFrac = inb > 0 ? (inb - passable) / inb : 0;
    if (blockFrac > 0) c *= 1 + BARRIER_PENALTY * blockFrac * blockFrac;
    if (concealBias > 0) c *= 1 + concealBias * (1 - concealSum / passable);
    if (coverBias > 0) c *= 1 + coverBias * (1 - coverSum / passable);
    if (roadBias > 0) c *= roadCells > passable * 0.3 ? 1 - 0.62 * roadBias : 1 + 0.3 * roadBias;
    return c;
  };

  ensureScratch(cw * cw);
  const gen = ++PF_GEN;
  const gOf = (i: number) => (gGen[i] === gen ? gScratch[i] : Infinity);
  const open = new Heap();
  const h = (i: number) => {
    const dx = Math.abs((i % cw) - gx);
    const dy = Math.abs(((i / cw) | 0) - gy);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); // octile
  };
  gScratch[startI] = 0;
  gGen[startI] = gen;
  cameScratch[startI] = -1;
  open.push({ i: startI, g: 0, f: h(startI) });

  let expanded = 0;
  let found = false;
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closedGen[cur.i] === gen) continue;
    closedGen[cur.i] = gen;
    if (cur.i === goalI) {
      found = true;
      break;
    }
    if (++expanded > maxExpand) break;
    const cx = cur.i % cw;
    const cy = (cur.i / cw) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= cw) continue;
        const ni = ny * cw + nx;
        if (closedGen[ni] === gen) continue;
        const stepCost = nodeCost(ni);
        if (!isFinite(stepCost)) continue;
        if (dx !== 0 && dy !== 0) {
          if (!isFinite(nodeCost(cy * cw + nx)) && !isFinite(nodeCost(ny * cw + cx))) continue; // no corner-cut
        }
        const tentative = cur.g + stepCost * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (tentative < gOf(ni)) {
          gScratch[ni] = tentative;
          gGen[ni] = gen;
          cameScratch[ni] = cur.i;
          open.push({ i: ni, g: tentative, f: tentative + h(ni) });
        }
      }
    }
  }
  if (!found) return null;

  const cells: number[] = [];
  let ci = goalI;
  while (ci !== -1) {
    cells.push(ci);
    if (ci === startI) break;
    ci = cameScratch[ci];
  }
  cells.reverse();
  const pts: Vec2[] = cells.map((i) => {
    const ax = i % cw;
    const ay = (i / cw) | 0;
    const c = terrain.nearestPassable(Math.min(terrain.size - 1, ax * f + (f >> 1)), Math.min(terrain.size - 1, ay * f + (f >> 1)), f);
    return terrain.cellCenter(c.cx, c.cy);
  });
  pts.push({ ...goal });
  return pts;
}

/**
 * String-pull the coarse route into clean waypoints. Where a straight shortcut
 * is clear we take it; where even the next coarse point can't be reached in a
 * straight line (a wall between them) we splice in a short full-resolution route
 * around it. Fine A* therefore only ever runs over a ~15 m gap — cheap.
 */
function stringPull(terrain: Terrain, start: Vec2, pts: Vec2[], opts: PathOptions): Vec2[] {
  if (pts.length === 0) return [{ ...start }];
  const out: Vec2[] = [];
  const WINDOW = 24;
  let anchor = start;
  let i = 0;
  while (i < pts.length) {
    const hi = Math.min(pts.length - 1, i + WINDOW);
    let j = hi;
    while (j > i && !walkable(terrain, anchor, pts[j])) j--;
    if (j > i) {
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
      continue;
    }
    // can't reach the immediate next coarse point straight
    if (walkable(terrain, anchor, pts[i])) {
      out.push(pts[i]);
      anchor = pts[i];
      i++;
      continue;
    }
    const fine = route(terrain, anchor, pts[i], 1, opts, 6000);
    if (fine) {
      for (const p of fine) out.push(p);
      anchor = out[out.length - 1];
    } else {
      out.push(pts[i]); // best effort
      anchor = pts[i];
    }
    i++;
  }
  return out;
}

/** Is the straight segment between a and b passable on foot the whole way. */
export function walkable(terrain: Terrain, a: Vec2, b: Vec2): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const step = terrain.cellSize;
  const n = Math.max(1, Math.ceil(d / step));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const wx = a.x + dx * t;
    const wy = a.y + dy * t;
    const cx = Math.floor(wx / terrain.cellSize);
    const cy = Math.floor(wy / terrain.cellSize);
    if (!terrain.passableCell(cx, cy)) return false;
  }
  return true;
}

function clampMove(terrain: Terrain, cx: number, cy: number): number {
  return Math.max(0.1, terrain.moveCostAt((cx + 0.5) * terrain.cellSize, (cy + 0.5) * terrain.cellSize));
}
