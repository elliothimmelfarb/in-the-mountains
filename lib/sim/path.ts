import { Terrain } from "./terrain";
import { Vec2 } from "./vec";

/**
 * Terrain-aware foot pathfinding. A* on a coarsened grid using the terrain's
 * movement cost, with an optional concealment bias so "concealed" movement
 * threads forest, orchards, dry washes and draws instead of crossing open
 * ground. Patrols and infiltrating fighters both route through this, so the
 * ground genuinely shapes how everyone moves.
 */

export interface PathOptions {
  /** 0 = fastest route; up to ~0.8 = strongly prefer concealment (slower, covered). */
  concealBias?: number;
  /** Prefer staying off the skyline / hugging cover (used by the enemy). */
  coverBias?: number;
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

/** Coarsening factor: pathfinding nodes are ~15 m so A* stays cheap on a 5 m grid. */
function coarseFactor(t: Terrain): number {
  return Math.max(1, Math.round(15 / t.cellSize));
}

/**
 * Find a foot route from `start` to `goal` (world meters). Returns simplified
 * world-space waypoints (excluding the start), or a single straight-line
 * waypoint to the goal if no route is found within the expansion budget.
 */
export function findPath(terrain: Terrain, start: Vec2, goal: Vec2, opts: PathOptions = {}): Vec2[] {
  const f = coarseFactor(terrain);
  const cw = Math.ceil(terrain.size / f); // coarse grid width
  const concealBias = opts.concealBias ?? 0;
  const coverBias = opts.coverBias ?? 0;
  const maxExpand = opts.maxExpand ?? 26000;

  const toCoarse = (w: number) => Math.min(cw - 1, Math.max(0, Math.floor(w / (terrain.cellSize * f))));
  const sx = toCoarse(start.x);
  const sy = toCoarse(start.y);
  const gx = toCoarse(goal.x);
  const gy = toCoarse(goal.y);
  const startI = sy * cw + sx;
  const goalI = gy * cw + gx;
  if (startI === goalI) return [{ ...goal }];

  // Per coarse-node terrain stats (sampled at the cell nearest the node center).
  const nodeCost = (ci: number): number => {
    const cxn = ci % cw;
    const cyn = (ci / cw) | 0;
    const fineX = Math.min(terrain.size - 1, cxn * f + (f >> 1));
    const fineY = Math.min(terrain.size - 1, cyn * f + (f >> 1));
    if (!terrain.passableCell(fineX, fineY)) return Infinity;
    const idx = terrain.idx(fineX, fineY);
    const move = clampMove(terrain, fineX, fineY);
    let c = 1 / move; // base step cost (higher where slow)
    if (concealBias > 0) c *= 1 + concealBias * (1 - terrain.conceal[idx]);
    if (coverBias > 0) c *= 1 + coverBias * (1 - terrain.cover[idx]);
    return c;
  };

  const g = new Float64Array(cw * cw).fill(Infinity);
  const came = new Int32Array(cw * cw).fill(-1);
  const closed = new Uint8Array(cw * cw);
  const open = new Heap();
  const h = (i: number) => {
    const ax = i % cw;
    const ay = (i / cw) | 0;
    const dx = Math.abs(ax - gx);
    const dy = Math.abs(ay - gy);
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); // octile
  };
  g[startI] = 0;
  open.push({ i: startI, g: 0, f: h(startI) });

  let expanded = 0;
  let found = false;
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
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
        if (closed[ni]) continue;
        const stepCost = nodeCost(ni);
        if (!isFinite(stepCost)) continue;
        // discourage corner-cutting through impassable diagonals
        if (dx !== 0 && dy !== 0) {
          if (!isFinite(nodeCost(cy * cw + nx)) && !isFinite(nodeCost(ny * cw + cx))) continue;
        }
        const diag = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        const tentative = cur.g + stepCost * diag;
        if (tentative < g[ni]) {
          g[ni] = tentative;
          came[ni] = cur.i;
          open.push({ i: ni, g: tentative, f: tentative + h(ni) });
        }
      }
    }
  }

  if (!found) {
    // best-effort: head straight for the goal (combat AI / movement will cope)
    return [{ ...goal }];
  }

  // reconstruct
  const cells: number[] = [];
  let ci = goalI;
  while (ci !== -1) {
    cells.push(ci);
    if (ci === startI) break;
    ci = came[ci];
  }
  cells.reverse();

  // to world waypoints at coarse-node centers
  const pts: Vec2[] = cells.map((i) => {
    const ax = i % cw;
    const ay = (i / cw) | 0;
    return { x: (ax * f + f / 2) * terrain.cellSize, y: (ay * f + f / 2) * terrain.cellSize };
  });
  pts.push({ ...goal });

  return simplify(terrain, start, pts);
}

/** Drop intermediate waypoints we can walk straight through (string-pulling). */
function simplify(terrain: Terrain, start: Vec2, pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts;
  const out: Vec2[] = [];
  let anchor = start;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    // find the farthest point reachable in a straight passable line from anchor
    for (; j > i; j--) {
      if (walkable(terrain, anchor, pts[j])) break;
    }
    if (j <= i) j = i;
    out.push(pts[j]);
    anchor = pts[j];
    if (j >= pts.length - 1) break;
    i = j + 1;
  }
  return out;
}

/** Is the straight segment between a and b passable on foot the whole way. */
function walkable(terrain: Terrain, a: Vec2, b: Vec2): boolean {
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
