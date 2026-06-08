/**
 * op-route-probe — does a squad ordered to a mountain OP SWITCHBACK up the face, or RING the spur?
 *
 * Metricizes Workstream 4 (elevation pathing). For each seed it picks a FIXED objective — the
 * highest cell in a 250–560 m annulus that is passable under the STRICT (slope ≤ 1.25) cutoff, so
 * the SAME target is chosen before and after any change to the slope cutoff (the elevation field is
 * unchanged) — plans the real "Establish OP" route (patrol movement → roadBias 0.55) to it, and reports:
 *   detour   = route length / crow-flight  (lower = straighter; the plan's target band is ~1.2–1.6)
 *   reached  = did the route arrive (endpoint < ~20 m of the OP)
 *   switch   = # of switchback legs (heading reversals across the climb axis) — >0 means it zig-zags
 *   impass%  = fraction of the straight-line ascent that is impassable (context, not comparable
 *              across cutoff changes)
 *
 * Run: npx tsx scripts/op-route-probe.ts [seed1 seed2 ...]
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ["korengal", "korengal-2", "ridgeline", "restrepo", "kunar-3", "valley-7"];
const STRICT = 1.25; // the original foot-impassable cutoff — used for FIXED objective selection only

function run(seed: string) {
  const world = createWorld(seed, 120);
  const t = world.terrain;
  const cs = t.cellSize;
  const cop = t.cop;
  const gateCell = cop.gateOutside ?? cop.gate ?? cop.center;
  const gateW = t.cellCenter(gateCell.cx, gateCell.cy);

  // Fixed objective: the highest cell in the annulus REACHABLE from the gate under the STRICT cutoff.
  // Strict-reachable ⊆ soft-reachable (softening only adds passable cells), so the same cell is
  // reachable in both regimes — a fair before/after target. The flood honours the planner's
  // anti-corner-cut rule (no diagonal step when both orthogonal neighbours are blocked) — a loose
  // oracle would over-count and pick an unreachable peak (Law 4).
  // Strict-passable: passable under the soft cutoff AND slope ≤ the original strict cutoff. (A cell
  // that passableCell rejects for being a wall/river/cliff is rejected here too; the slope clause
  // makes the set regime-independent.)
  const strictPass = (cx: number, cy: number) => t.inBounds(cx, cy) && t.slope[t.idx(cx, cy)] <= STRICT && t.passableCell(cx, cy);
  const reach = new Uint8Array(t.size * t.size);
  {
    const stack: number[] = [];
    const g = t.idx(gateCell.cx, gateCell.cy);
    if (strictPass(gateCell.cx, gateCell.cy)) { reach[g] = 1; stack.push(g); }
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % t.size, y = (i / t.size) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!strictPass(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && !(strictPass(x + dx, y) && strictPass(x, y + dy))) continue; // anti-corner-cut
        const ni = t.idx(nx, ny);
        if (reach[ni]) continue;
        reach[ni] = 1; stack.push(ni);
      }
    }
  }
  let peak: { cx: number; cy: number; e: number } | null = null;
  for (let cy = 0; cy < t.size; cy++)
    for (let cx = 0; cx < t.size; cx++) {
      const dm = Math.hypot(cx - cop.center.cx, cy - cop.center.cy) * cs;
      if (dm < 250 || dm > 560) continue;
      if (!reach[t.idx(cx, cy)]) continue;
      const e = t.elev[t.idx(cx, cy)];
      if (!peak || e > peak.e) peak = { cx, cy, e };
    }
  if (!peak) return null;
  const peakW = t.cellCenter(peak.cx, peak.cy);
  const crow = Math.hypot(peakW.x - gateW.x, peakW.y - gateW.y);
  const climb = peak.e - t.elev[t.idx(gateCell.cx, gateCell.cy)];

  // impassable % of the straight-line ascent (context)
  let sCells = 0, sBlocked = 0, slopeSum = 0;
  const n = Math.max(1, Math.ceil(crow / cs));
  for (let k = 1; k <= n; k++) {
    const cx = Math.floor((gateW.x + (peakW.x - gateW.x) * (k / n)) / cs);
    const cy = Math.floor((gateW.y + (peakW.y - gateW.y) * (k / n)) / cs);
    if (!t.inBounds(cx, cy)) continue;
    sCells++; slopeSum += t.slope[t.idx(cx, cy)];
    if (!t.passableCell(cx, cy)) sBlocked++;
  }

  const route = findPath(t, gateW, peakW, { roadBias: 0.55 });
  let L = 0; let prev = gateW;
  for (const p of route) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  const end = route[route.length - 1];
  const reached = Math.hypot(end.x - peakW.x, end.y - peakW.y) < 20;

  // Switchback count: project each leg onto the cross-climb axis (perpendicular to gate→peak); a
  // sign change in that projection is a heading reversal across the climb line = one switchback leg.
  const ax = (peakW.x - gateW.x) / (crow || 1), ay = (peakW.y - gateW.y) / (crow || 1);
  const perpx = -ay, perpy = ax;
  let switches = 0, lastSign = 0; prev = gateW;
  for (const p of route) {
    const cross = (p.x - prev.x) * perpx + (p.y - prev.y) * perpy;
    const sign = cross > 3 ? 1 : cross < -3 ? -1 : 0;
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) switches++;
    if (sign !== 0) lastSign = sign;
    prev = p;
  }

  return { seed, climb, crow, L, detour: L / crow, reached, switches, impass: sBlocked / Math.max(1, sCells), meanSlope: slopeSum / Math.max(1, sCells), wp: route.length };
}

console.log("seed         | climb | crow  | route  | detour | reached | switch | impass% | meanSlope");
console.log("-------------|-------|-------|--------|--------|---------|--------|---------|----------");
const rows = [];
for (const s of SEEDS) {
  const r = run(s);
  if (!r) { console.log(`${s.padEnd(12)} | (no strict-passable peak in annulus)`); continue; }
  rows.push(r);
  console.log(
    `${r.seed.padEnd(12)} | ${String(Math.round(r.climb)).padStart(4)}m | ${String(Math.round(r.crow)).padStart(4)}m | ${String(Math.round(r.L)).padStart(5)}m | ${("×" + r.detour.toFixed(2)).padStart(6)} | ${(r.reached ? "yes" : "NO").padStart(7)} | ${String(r.switches).padStart(6)} | ${(100 * r.impass).toFixed(0).padStart(6)}% | ${r.meanSlope.toFixed(2)}`
  );
}
const mean = rows.reduce((a, r) => a + r.detour, 0) / Math.max(1, rows.length);
const worst = rows.reduce((a, r) => Math.max(a, r.detour), 0);
console.log(`\nmean detour ×${mean.toFixed(2)} · worst ×${worst.toFixed(2)} · reached ${rows.filter((r) => r.reached).length}/${rows.length}`);
