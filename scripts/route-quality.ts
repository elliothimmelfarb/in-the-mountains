/**
 * Route-quality harness — the core optimization target for the pathfinder rebuild.
 * For every village objective in many seeds, route gateOutside -> village and measure:
 *   - ratio:  route length / crow-flies distance. ~1.2-1.6 is a sane terrain detour;
 *             >2.5 means the path is looping/backtracking (the bench-edge bug).
 *   - rev:    number of "reversals" — waypoints where the path turns >120° back on
 *             itself (a real route almost never reverses; loops reverse repeatedly).
 *   - maxExc: max excursion in distance-from-goal AFTER getting closer (a route that
 *             gets within X of the goal then moves M further away has a M-excursion;
 *             healthy routes are monotone-ish so this is small).
 * Run: npx tsx scripts/route-quality.ts [seeds...]
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";
import { Vec2 } from "../lib/sim/vec";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "alpha-1", "bravo-2", "delta-4"];

function quality(route: Vec2[], start: Vec2, goal: Vec2) {
  let len = 0;
  let prev = start;
  for (const p of route) { len += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  const crow = Math.hypot(goal.x - start.x, goal.y - start.y);
  // reversals: angle between consecutive segments > 120deg
  let rev = 0;
  const pts = [start, ...route];
  for (let i = 2; i < pts.length; i++) {
    const a = { x: pts[i - 1].x - pts[i - 2].x, y: pts[i - 1].y - pts[i - 2].y };
    const b = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
    const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
    if (la < 1e-3 || lb < 1e-3) continue;
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    if (cos < Math.cos((120 * Math.PI) / 180)) rev++;
  }
  // max excursion away from goal after a closer approach
  let minSoFar = Infinity, maxExc = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - goal.x, p.y - goal.y);
    minSoFar = Math.min(minSoFar, d);
    maxExc = Math.max(maxExc, d - minSoFar);
  }
  return { len, crow, ratio: len / Math.max(1, crow), rev, maxExc };
}

console.log("seed".padEnd(12), "objs".padStart(5), "meanRatio".padStart(10), "maxRatio".padStart(9), "loopy(>2.5)".padStart(11), "meanRev".padStart(8), "meanExc".padStart(8));
let gObjs = 0, gLoopy = 0; const gRatios: number[] = []; const gRev: number[] = []; const gExc: number[] = [];
for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t = w.terrain;
  const gateOut = w.gateOutsideWorld();
  const ratios: number[] = [], revs: number[] = [], excs: number[] = [];
  let loopy = 0;
  for (const v of t.villages) {
    const goal = t.cellCenter(v.cx, v.cy);
    const snapped = (() => { const c = t.nearestPassable(v.cx, v.cy); return t.cellCenter(c.cx, c.cy); })();
    const route = findPath(t, gateOut, snapped, { roadBias: 0.25 });
    const q = quality(route, gateOut, snapped);
    if (q.crow < 60) continue; // skip trivially-close
    ratios.push(q.ratio); revs.push(q.rev); excs.push(q.maxExc);
    if (q.ratio > 2.5) loopy++;
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
  gObjs += ratios.length; gLoopy += loopy; gRatios.push(...ratios); gRev.push(...revs); gExc.push(...excs);
  console.log(
    seed.padEnd(12),
    String(ratios.length).padStart(5),
    mean(ratios).toFixed(2).padStart(10),
    max(ratios).toFixed(2).padStart(9),
    String(loopy).padStart(11),
    mean(revs).toFixed(1).padStart(8),
    (Math.round(mean(excs)) + "m").padStart(8)
  );
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log("-".repeat(72));
console.log(
  "ALL".padEnd(12),
  String(gObjs).padStart(5),
  mean(gRatios).toFixed(2).padStart(10),
  Math.max(...gRatios).toFixed(2).padStart(9),
  `${gLoopy} (${Math.round((gLoopy / Math.max(1, gObjs)) * 100)}%)`.padStart(11),
  mean(gRev).toFixed(1).padStart(8),
  (Math.round(mean(gExc)) + "m").padStart(8)
);
