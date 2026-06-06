import { Terrain, Land, COARSE_F, COARSE_DIR8 } from "./terrain";
import { Vec2 } from "./vec";

/**
 * Terrain-aware foot pathfinding. Two-stage and corridor-constrained:
 *   1. a cheap COARSE A* (~15 m nodes) lays the global line across the valley;
 *   2. a full-resolution A* run INSIDE A CORRIDOR around that line produces the path a
 *      unit actually walks — so it honours every 5 m feature (it crosses the wash at the
 *      real ford, threads the ECP gate, slips through a qalat gap) and is always genuinely
 *      walkable, while the corridor keeps the search cheap and makes a looping/spiralling
 *      path impossible. If the corridor can't reach the goal it widens; if the goal is
 *      truly walled off it walks as close as the ground allows.
 * Movement cost carries optional concealment / road / cover biases, so a "concealed" route
 * threads forest and washes while a "traveling" one takes the road. Patrols and infiltrating
 * fighters both route through this, so the ground genuinely shapes how everyone moves.
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
  /** Skip the expensive whole-map free-A* fallback (used by low-stakes movers — civilians,
   *  infiltrators — so a cross-river errand best-efforts cheaply instead of paying a ~200k-expansion
   *  search; the player's squads leave this off so their objectives are always found). */
  cheapFallback?: boolean;
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
 * Why corridor-constrained full-resolution instead of plain hierarchical repair: a coarse
 * node is "passable" if ANY of its 5 m cells is, so the coarse line is OPTIMISTIC — it will
 * happily cut across a node that a thin wash bank or wall actually seals. Trusting that line
 * and only "repairing" the clipped bits is what made patrols spiral the COP: a fine A* asked
 * to honour a coarse waypoint stranded across a barrier would detour hundreds of metres (a
 * long, cheap trail loop can cost less than a short scramble), so the squad orbited instead
 * of taking the real descent. Running the WHOLE fine path inside a corridor around the coarse
 * line fixes both failure modes at once: full resolution means the path is genuinely walkable
 * (no clipping), and the corridor bound means it physically cannot wander off to loop. The
 * coarse line only has to point the right general way; the corridor pass finds the true route.
 */
// ~15 m coarse nodes on the 5 m grid: COARSE_F, imported from terrain.ts. NB: used only
// INSIDE functions (not at module top-level) so terrain.ts can import findPath without a
// load-time circular-dependency crash (terrain → path → terrain reads COARSE_F lazily).
const BARRIER_PENALTY = 16; // how hard a coarse node is charged for the walls/cliffs it contains
const FINE_CLIP_MARGIN = 10; // cells (~50 m) of slack around a fine repair — room for a local
// detour around a wash bank or wall corner, but far too tight to loop the COP ring. This is
// what keeps the fine repair honest: it physically cannot wander, so it can never reintroduce
// the "spiral the outpost" path that an unbounded cost-minimizing fine A* would (a long detour
// on cheap trail can cost less than a short scramble over a rough bank to a fixed waypoint).

/** A fine-cell bounding box, used to confine a fine A* repair to the local region. */
interface ClipRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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

// Corridor radii (cells) tried in turn. We start tight (cheap, hugs the coarse line) and
// widen only if the full-resolution pass can't get through — so a route that needs to
// swing wide to reach the real crossing (a far bench descent) still finds it, while the
// common case stays a narrow, fast search.
const CORRIDOR_RADII = [7, 15, 30];

/**
 * Find a foot route from `start` to `goal` (world meters). Two stages:
 *  1. a cheap COARSE A* gives the global line across the valley (it may be optimistic —
 *     it can cut a corner a 5 m wall actually blocks);
 *  2. a full-resolution A* CONFINED TO A CORRIDOR around that line produces the path the
 *     unit actually walks. Full-res means it honours every 5 m detail — it crosses the
 *     wash at the real ford, threads the ECP gate, slips through a qalat gap — so the
 *     route is always genuinely walkable. The corridor makes it cheap (a thin band, not
 *     the whole map) AND makes looping impossible (it physically can't wander off to
 *     spiral the outpost). We widen the corridor only if the tight one can't get through.
 * Returns world-space waypoints (excluding the start); a straight shot if truly unreachable.
 */
export function findPath(terrain: Terrain, start: Vec2, goal: Vec2, opts: PathOptions = {}): Vec2[] {
  // Is the expensive free, unclipped A* fallback even worth running? It's only correct to pay for
  // when a route actually exists. If the START is in the main (gate) component but the GOAL is NOT,
  // the goal is genuinely unreachable — running a 300k-expansion free A* would explore nearly the
  // whole map, fail, AND get re-fired every tick by a caller chasing an unreachable seat/flee point
  // (a measured 179 ms tick spike). In that case we skip straight to the bounded best-effort. Far
  // ford-detour goals (the reason the free pass exists) ARE in the gate component, so they keep it.
  const worthFreeSearch = (): boolean => {
    if (opts.cheapFallback) return false; // low-stakes mover — never pay the whole-map search
    const reach = terrain.reachableFromGate();
    const sc = terrain.nearestPassable(Math.floor(start.x / terrain.cellSize), Math.floor(start.y / terrain.cellSize), 6);
    const gc = terrain.nearestPassable(Math.floor(goal.x / terrain.cellSize), Math.floor(goal.y / terrain.cellSize), 6);
    const startInMain = !!reach[terrain.idx(sc.cx, sc.cy)];
    const goalInMain = !!reach[terrain.idx(gc.cx, gc.cy)];
    // Run the whole-map free search ONLY when a route can plausibly exist — i.e. BOTH endpoints are
    // in the connected valley (the gate component). This is the cap the verification workflow demanded:
    // a unit that itself sits outside the main component (a mis-spawned civilian in a walled pocket)
    // must NOT trigger a 300k-expansion search every tick. Far ford-detour goals keep it (both in main).
    return goalInMain && startInMain;
  };
  // A low-stakes mover (civilian/infiltrator) routes on a budget: a hard cross-valley route that the
  // cheap passes can't find just best-efforts, rather than paying the squad-grade search every errand
  // (the per-tick civilian stall). The player's squads leave cheapFallback off and get the full budget.
  const cheap = !!opts.cheapFallback;
  const coarseBudget = cheap ? 14000 : 60000;
  const fineBudget = cheap ? 12000 : 40000;
  const beBudget = cheap ? 12000 : 60000;
  const radii = cheap ? [7] : CORRIDOR_RADII;
  const coarse = route(terrain, start, goal, COARSE_F, opts, coarseBudget);
  if (!coarse) {
    // The coarse pass couldn't reach the goal. That no longer means "unreachable": with the river
    // a real barrier, the coarse line can dead-end at the channel when the only crossing is a thin
    // ford the coarse graph misses. So try a FREE full-resolution A* first — it honours the actual
    // fords and finds the genuine (often long, ford-detouring) route if one exists.
    if (worthFreeSearch()) {
      const free = route(terrain, start, goal, 1, opts, 300000);
      if (free) return stringPull(terrain, start, free, opts);
    }
    // Truly unreachable: a bounded free best-effort A* advances to the nearest cell we can reach
    // (never a degenerate single straight waypoint into a cliff — that "arrived" 1.4 km short).
    const be = route(terrain, start, goal, 1, opts, beBudget, undefined, approachClip(terrain, start, goal), true);
    return be ? stringPull(terrain, start, be, opts) : [{ ...goal }];
  }
  for (const R of radii) {
    const gen = rasterizeCorridor(terrain, start, coarse, R);
    const fine = route(terrain, start, goal, 1, opts, fineBudget, gen);
    if (fine) return stringPull(terrain, start, fine, opts); // smooth the walkable fine path
  }
  // Every corridor failed. The dominant cause (verified — scripts/corridor-shortfall.ts) is a
  // route that must detour FAR off the coarse line to reach a real river crossing (a ford up or
  // down the valley): the genuine route runs many multiples of the crow distance and swings well
  // outside even the widest corridor, so the corridor-confined fine pass gives up short. Before
  // settling for best-effort, run a FREE, UNCLIPPED full-resolution A* with a generous budget. It
  // honours every 5 m feature (so it's genuinely walkable) and is bounded only by the map, so it
  // finds the true route to a distant ford if one exists — exactly the routes the corridor can't
  // contain. This is the correctness backstop; the corridor stays the cheap common-case path. Gated
  // by worthFreeSearch() so an unreachable goal never triggers a whole-map search every tick.
  if (worthFreeSearch()) {
    const free = route(terrain, start, goal, 1, opts, 300000);
    if (free) return stringPull(terrain, start, free, opts);
  }
  // Genuinely unreachable at fine resolution (walled off / sealed pocket / across a barrier with
  // no crossing). DON'T fall back to a corridor-constrained best-effort: confined to the OPTIMISTIC
  // coarse line it returns a valley-circling, partially-unwalkable blow-up (movement RC#1). Instead
  // a FREE best-effort A* in a box around start→goal finds the genuinely nearest reachable cell with
  // a non-looping, fully walkable path, and the unit advances to it and holds — "get as close as the
  // ground allows, then stop."
  const best = route(terrain, start, goal, 1, opts, beBudget, undefined, approachClip(terrain, start, goal), true);
  if (best) return stringPull(terrain, start, best, opts);
  return stringPull(terrain, start, coarse, opts);
}

/**
 * A generous fine-cell box around the start→goal segment for the unreachable-goal
 * best-effort approach: wide enough to swing around a barrier to the true nearest
 * approach, but bounded so the search stays cheap and physically cannot wander off to
 * circle the whole valley (which is exactly what the old corridor-constrained fallback did).
 */
function approachClip(terrain: Terrain, a: Vec2, b: Vec2): ClipRect {
  const cs = terrain.cellSize;
  const ax = a.x / cs, ay = a.y / cs, bx = b.x / cs, by = b.y / cs;
  const M = 40; // cells (~200 m) of slack around the segment
  return {
    x0: Math.max(0, Math.floor(Math.min(ax, bx)) - M),
    y0: Math.max(0, Math.floor(Math.min(ay, by)) - M),
    x1: Math.min(terrain.size - 1, Math.ceil(Math.max(ax, bx)) + M),
    y1: Math.min(terrain.size - 1, Math.ceil(Math.max(ay, by)) + M),
  };
}

// Generation-stamped corridor membership: cell i is in the current corridor iff
// corridorStamp[i] === the gen returned by the matching rasterizeCorridor call.
let corridorStamp = new Int32Array(0);
let CORRIDOR_GEN = 0;

/** Stamp the band of cells within `R` (Chebyshev) of the polyline start→pts into the
 *  corridor scratch, and return the generation id identifying that band. */
function rasterizeCorridor(terrain: Terrain, start: Vec2, pts: Vec2[], R: number): number {
  const size = terrain.size;
  if (corridorStamp.length < size * size) corridorStamp = new Int32Array(size * size);
  const gen = ++CORRIDOR_GEN;
  const cs = terrain.cellSize;
  const stampBox = (cx: number, cy: number) => {
    for (let yy = Math.max(0, cy - R); yy <= Math.min(size - 1, cy + R); yy++)
      for (let xx = Math.max(0, cx - R); xx <= Math.min(size - 1, cx + R); xx++) corridorStamp[yy * size + xx] = gen;
  };
  let prev = start;
  for (const p of pts) {
    const ax = prev.x / cs, ay = prev.y / cs, bx = p.x / cs, by = p.y / cs;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampBox(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t));
    }
    prev = p;
  }
  return gen;
}

/**
 * A* at coarsening factor `f`, returning world-space node-center waypoints
 * (snapped onto passable ground) ending at `goal`, or null if unreachable
 * within the budget. Uses generation-stamped scratch — no per-call clear.
 */
function route(
  terrain: Terrain,
  start: Vec2,
  goal: Vec2,
  f: number,
  opts: PathOptions,
  maxExpand: number,
  corrGen?: number,
  clip?: ClipRect,
  bestEffort = false
): Vec2[] | null {
  const cw = Math.ceil(terrain.size / f);
  // Corridor constraint only applies at full resolution (f === 1, cw === size); the cells
  // and the stamp are 1:1 there. A coarse pass ignores it.
  const useCorridor = corrGen !== undefined && f === 1 && corridorStamp.length === cw * cw ? corrGen : undefined;
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
    let riverCells = 0; // impassable deep channel inside this coarse node
    let crossCells = 0; // a real crossing (ford / footbridge) inside this coarse node
    for (let yy = 0; yy < f; yy++) {
      const fy = y0 + yy;
      if (fy >= terrain.size) continue;
      for (let xx = 0; xx < f; xx++) {
        const fx = x0 + xx;
        if (fx >= terrain.size) continue;
        inb++;
        const idx = terrain.idx(fx, fy);
        const l = terrain.land[idx] as Land;
        if (l === Land.River) riverCells++;
        else if (l === Land.Ford || l === Land.Footbridge) crossCells++;
        if (!terrain.passableCell(fx, fy)) continue;
        passable++;
        moveSum += clampMove(terrain, fx, fy);
        concealSum += terrain.conceal[idx];
        coverSum += terrain.cover[idx];
        if (l === Land.Road || l === Land.Trail || l === Land.Footbridge || l === Land.Track || l === Land.Ford) roadCells++;
      }
    }
    if (passable === 0) return Infinity;
    // The river is a REAL barrier at coarse scale too (issue 010). A coarse node "open if ANY
    // subcell is passable" used to let the global line cut the channel through a single dry bank
    // cell — cheaper than detouring to a ford — and the fine pass (river truly impassable) then
    // could not follow it, stranding the route short (the corridor-shortfall bug). A node the
    // channel runs THROUGH (river-dominated) with no ford/footbridge in it is therefore
    // impassable, so the coarse line is forced to cross only at real crossings. The channel is
    // ~3 cells wide, so a node the crossing threads carries ≥3 river cells; bank-walking nodes
    // sit a column inland (the floodplain is several coarse nodes wide) and keep enough river-free
    // cells to stay open, so this blocks crossing-without-a-ford without walling the riverside.
    if (riverCells >= 3 && crossCells === 0) return Infinity;
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
  let bestI = startI; // closest-to-goal cell expanded so far (for best-effort fallback)
  let bestH = h(startI);
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closedGen[cur.i] === gen) continue;
    closedGen[cur.i] = gen;
    if (cur.i === goalI) {
      found = true;
      break;
    }
    const hc = h(cur.i);
    if (hc < bestH) {
      bestH = hc;
      bestI = cur.i;
    }
    if (++expanded > maxExpand) break;
    const cx = cur.i % cw;
    const cy = (cur.i / cw) | 0;
    for (let d = 0; d < 8; d++) {
      const dx = COARSE_DIR8[d][0];
      const dy = COARSE_DIR8[d][1];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cw || ny >= cw) continue;
      const ni = ny * cw + nx;
      // Corridor constraint: at full resolution, never leave the stamped band around the
      // coarse line. This is what keeps the fine search cheap and makes looping impossible.
      if (useCorridor !== undefined && corridorStamp[ni] !== useCorridor) continue;
      // Bounded repair: a clipped fine A* can't leave its window, so it can never loop.
      if (clip && (nx < clip.x0 || ny < clip.y0 || nx > clip.x1 || ny > clip.y1)) continue;
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
  // Not reached. Either give up (null) or, in best-effort mode, return the route to the
  // closest cell we got to — so a unit ordered somewhere it can't fully reach (a walled
  // courtyard, a goal across an uncrossable draw) still walks up to the nearest approach
  // and stops there, instead of falling back to a route that clips terrain.
  const endI = found ? goalI : bestEffort && bestI !== startI ? bestI : -1;
  if (endI === -1) return null;

  const cells: number[] = [];
  let ci = endI;
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
  if (found) pts.push({ ...goal });
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
    // Repair the blocked segment with a fine A*, but CONFINED to a window around it.
    // With the honest coarse graph, consecutive waypoints are genuinely connected, so
    // the real crossing is always inside this window — and the clip makes it impossible
    // for the repair to wander off and loop the outpost (the old failure mode).
    const fine = route(terrain, anchor, pts[i], 1, opts, 6000, undefined, fineClip(terrain, anchor, pts[i]));
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

/** Fine-cell window around the segment a→b, padded by FINE_CLIP_MARGIN, for a bounded repair. */
function fineClip(terrain: Terrain, a: Vec2, b: Vec2): ClipRect {
  const cs = terrain.cellSize;
  const ax = a.x / cs, ay = a.y / cs, bx = b.x / cs, by = b.y / cs;
  const M = FINE_CLIP_MARGIN;
  return {
    x0: Math.max(0, Math.floor(Math.min(ax, bx)) - M),
    y0: Math.max(0, Math.floor(Math.min(ay, by)) - M),
    x1: Math.min(terrain.size - 1, Math.ceil(Math.max(ax, bx)) + M),
    y1: Math.min(terrain.size - 1, Math.ceil(Math.max(ay, by)) + M),
  };
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
