/**
 * trail-utility — do the trails BUY traversal? For each village, route to its highest
 * walkable shoulder in a 250–560 m uphill annulus (the ground the climbing trails serve) and
 * integrate the ANISOTROPIC travel time along the planner's route (terrain.dirSpeedAt — the
 * mover's real speed model). Reports per-seed means:
 *   time   : route travel time, seconds at road pace units (lower = the climb got cheaper)
 *   onPath%: fraction of route length on path landcover (Road/Track/Trail/Footbridge/Ford) —
 *            how much of the climb rides the network instead of bushwhacking
 *   reach  : fraction of village→shoulder routes whose endpoint lands within 20 m of the goal
 * Run in the HEAD worktree and the working tree with the same seeds; compare the means.
 * Run: npx tsx scripts/trail-utility.ts
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";
import { Land } from "../lib/sim/terrain";

const SEEDS = ["korengal", "korengal-2", "ridgeline", "restrepo", "kunar-3", "valley-7", "survey-2", "survey-9"];
const PATH_LANDS = new Set<Land>([Land.Road, Land.Track, Land.Trail, Land.Footbridge, Land.Ford]);

// FIXED ground-truth walking model, owned by the probe so both trees are judged identically:
// land speed × signed-grade penalty, with a constructed tread walking at its design grade
// (the benched-tread physics — see TREAD_GRADE_CAP in terrain.ts). Constants frozen here.
const ORACLE_MOVE: Partial<Record<Land, number>> = { [Land.Road]: 1, [Land.Track]: 0.96, [Land.Trail]: 0.92, [Land.Footbridge]: 0.85, [Land.Ford]: 0.5 };
const ORACLE_CAP: Partial<Record<Land, number>> = { [Land.Road]: 0.2, [Land.Track]: 0.38, [Land.Trail]: 0.35, [Land.Footbridge]: 0.08 };
function oracleSpeed(t: any, wx: number, wy: number, ux: number, uy: number): number {
  const h = t.cellSize as number;
  let S = (t.elevAt(wx + ux * h, wy + uy * h) - t.elevAt(wx, wy)) / h;
  const land = t.landAt(wx, wy) as Land;
  const cap = ORACLE_CAP[land];
  if (cap !== undefined && S > cap) S = cap;
  const m = ORACLE_MOVE[land] ?? landMoveFallback(t, wx, wy);
  const v = m * Math.min(1, Math.max(0, 1 - S * 0.62));
  return Math.min(1, Math.max(0.02, v));
}
// off-path ground: read the tree's own moveCostAt with slope factored OUT, i.e. recover the land
// multiplier — avoids duplicating the whole LAND_MOVE table while staying tree-independent for
// the lands that matter (paths, frozen above).
function landMoveFallback(t: any, wx: number, wy: number): number {
  const slope = t.slopeAt(wx, wy) as number;
  const denom = Math.min(1, Math.max(0, 1 - slope * 0.62));
  const mc = t.moveCostAt(wx, wy) as number;
  return denom > 0.02 ? Math.min(1, mc / denom) : mc;
}

let allT = 0, allP = 0, allR = 0, allN = 0;
console.log("seed".padEnd(12), "routes".padStart(7), "time".padStart(9), "onPath%".padStart(8), "reach".padStart(6));
for (const seed of SEEDS) {
  const t = createWorld(seed, 120).terrain as any;
  const size = t.size as number;
  const cs = t.cellSize as number;
  const rMin = Math.round(250 / cs), rMax = Math.round(560 / cs);
  let timeSum = 0, pathSum = 0, reached = 0, n = 0;
  for (const v of t.villages as { cx: number; cy: number }[]) {
    // highest walkable shoulder in the uphill annulus — same intent as the trail generator,
    // computed here independently so the probe doesn't trust the system under test
    const oE = t.elev[v.cy * size + v.cx];
    const upSide = Math.sign(v.cx - t.centerX[v.cy]) || 1;
    let bE = -Infinity, bx = -1, by = -1;
    for (let a = 0; a < 64; a++) {
      const ang = (a / 64) * Math.PI * 2;
      for (let r = rMin; r <= rMax; r += 2) {
        const x = Math.round(v.cx + Math.cos(ang) * r), y = Math.round(v.cy + Math.sin(ang) * r);
        if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
        if (Math.sign(x - t.centerX[y]) !== upSide) continue;
        const i = y * size + x;
        if (t.slope[i] >= 1.0) continue;
        const e = t.elev[i];
        if (e - oE < 80) continue;
        if (e > bE) { bE = e; bx = x; by = y; }
      }
    }
    if (bx < 0) continue;
    const from = t.cellCenter(v.cx, v.cy), to = t.cellCenter(bx, by);
    // mover-faithful: a deliberate squad march sets switchback (combat.ts:1741), and a
    // village→shoulder climb clears the tactical-climb gate — so route like the real mover
    const route = findPath(t, from, to, { switchback: true });
    if (route.length < 2) continue;
    n++;
    const end = route[route.length - 1];
    const arrived = Math.hypot(end.x - to.x, end.y - to.y) < 20;
    if (!arrived) continue; // a partial route's time is not a climb time — score arrived only
    reached++;
    let time = 0, pLen = 0, len = 0;
    let prev = from;
    for (const p of [...route]) {
      const L = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (L < 0.01) { prev = p; continue; }
      const ux = (p.x - prev.x) / L, uy = (p.y - prev.y) / L;
      const SUB = Math.max(1, Math.ceil(L / 5));
      for (let s = 0; s < SUB; s++) {
        const mx = prev.x + (p.x - prev.x) * ((s + 0.5) / SUB);
        const my = prev.y + (p.y - prev.y) * ((s + 0.5) / SUB);
        const sp = oracleSpeed(t, mx, my, ux, uy); // FIXED oracle — independent of the tree's model
        time += L / SUB / Math.max(0.02, sp);
        if (PATH_LANDS.has(t.landAt(mx, my))) pLen += L / SUB;
      }
      len += L;
      prev = p;
    }
    timeSum += time;
    pathSum += len ? (100 * pLen) / len : 0;
  }
  console.log(seed.padEnd(12), String(n).padStart(7), (reached ? timeSum / reached : 0).toFixed(0).padStart(9), (reached ? pathSum / reached : 0).toFixed(0).padStart(7) + "%", `${reached}/${n}`.padStart(6));
  allT += timeSum; allP += pathSum; allR += reached; allN += n;
}
console.log("".padEnd(12), "-".repeat(46));
console.log("MEAN".padEnd(12), String(allN).padStart(7), (allR ? allT / allR : 0).toFixed(0).padStart(9), (allR ? allP / allR : 0).toFixed(0).padStart(7) + "%", `${allR}/${allN}`.padStart(6));
