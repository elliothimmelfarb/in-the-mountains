/**
 * footpath-probe — how MUCH of the map is footpath/trail/track/road, are the paths SCALED right
 * (a goat trail is a thin thread, not a highway), and do they MOLD to the terrain (run at a walkable
 * grade, not straight up a fall line)? Metricizes the owner's ask: "more footpaths, scaled correctly,
 * molding to the terrain authentically."
 *
 * Columns (per seed):
 *   trailC / trackC / roadC : count of cells of each path landcover
 *   path%   : fraction of ALL cells that are any path (Road|Track|Trail|Footbridge|Ford) — "more"
 *   segs    : connected path components (≥4 cells) — a rough count of distinct paths/footpaths
 *   trGrade : mean TERRAIN slope magnitude at trail cells. NOTE: this is the slope of the GROUND
 *             the trail crosses, not the walking grade — a switchback traversing a steep face
 *             scores high here even when its tread is gentle. HIGH trGrade + LOW alongGr is the
 *             signature of a real switchback network (trails going UP steep hills, at a walkable
 *             grade); high alongGr is the actual pathology (a path stamped up a fall line).
 *   trSteep%: fraction of trail cells whose ground slope exceeds 0.5 (≈27°) — how much of the
 *             network dares the steep band (rises when trails climb the walls; see trGrade note).
 *   alongGr : length-weighted mean |rise/run| ALONG each trail centerline (terrain.trailLines) —
 *             the grade a human walking the path experiences. A real foot-trail holds this low by
 *             switchbacking (alpine trail standards ~0.10-0.20; goat trails steeper). THE
 *             authenticity number.
 *   along>45%: fraction of trail centerline LENGTH steeper along-track than 0.45 (~24°, beyond a
 *             sustained walkable grade) — the unwalkable-trail residual. Lower = more authentic.
 *
 * Run: npx tsx scripts/footpath-probe.ts [N]   (N survey seeds, else a documented set)
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const N = process.argv[2] ? Number(process.argv[2]) : 0;
const SEEDS = N
  ? Array.from({ length: N }, (_, i) => "survey-" + i)
  : ["korengal", "korengal-2", "ridgeline", "restrepo", "kunar-3", "valley-7", "survey-2", "survey-9"];

const PATH_LANDS = new Set<Land>([Land.Road, Land.Track, Land.Trail, Land.Footbridge, Land.Ford]);

function analyse(seed: string) {
  const t = createWorld(seed, 120).terrain;
  const size = t.size;
  const n = size * size;
  const land = t.land;
  const slope = t.slope;
  const idx = (x: number, y: number) => y * size + x;

  let trailC = 0, trackC = 0, roadC = 0, pathC = 0;
  let trGradeSum = 0, trSteep = 0;
  const isPath = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = land[i] as Land;
    if (l === Land.Trail) { trailC++; trGradeSum += slope[i]; if (slope[i] > 0.5) trSteep++; }
    else if (l === Land.Track) trackC++;
    else if (l === Land.Road) roadC++;
    if (PATH_LANDS.has(l)) { pathC++; isPath[i] = 1; }
  }

  // connected path components ≥4 cells (8-connected) — rough "# of distinct footpaths/roads"
  const comp = new Int32Array(n).fill(-1);
  let segs = 0;
  const st: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || !isPath[s]) continue;
    let cnt = 0;
    comp[s] = segs; st.length = 0; st.push(s);
    while (st.length) {
      const k = st.pop()!; cnt++;
      const x = k % size, y = (k / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (comp[j] !== -1 || !isPath[j]) continue;
          comp[j] = segs; st.push(j);
        }
    }
    if (cnt >= 4) segs++; else comp[s] = -2;
  }

  // along-track grade over the captured trail centerlines — the grade a walker experiences
  let wLen = 0, gLenSum = 0, steepLen = 0;
  for (const tl of t.trailLines) {
    if (tl.kind !== "trail") continue;
    for (let i = 0; i + 1 < tl.pts.length; i++) {
      const a = tl.pts[i], b = tl.pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.5) continue;
      const g = Math.abs(t.elevAt(b.x, b.y) - t.elevAt(a.x, a.y)) / L;
      gLenSum += g * L;
      wLen += L;
      if (g > 0.45) steepLen += L;
    }
  }

  return {
    seed, trailC, trackC, roadC,
    pathPct: (100 * pathC) / n,
    segs,
    trGrade: trailC ? trGradeSum / trailC : 0,
    trSteepPct: trailC ? (100 * trSteep) / trailC : 0,
    alongGr: wLen ? gLenSum / wLen : 0,
    alongSteepPct: wLen ? (100 * steepLen) / wLen : 0,
  };
}

console.log(
  "seed".padEnd(12), "trail".padStart(6), "track".padStart(6), "road".padStart(6),
  "path%".padStart(7), "segs".padStart(6), "trGrade".padStart(8), "trSteep%".padStart(9),
  "alongGr".padStart(8), "along>45%".padStart(10),
);
const agg = { trailC: 0, trackC: 0, roadC: 0, pathPct: 0, segs: 0, trGrade: 0, trSteepPct: 0, alongGr: 0, alongSteepPct: 0 };
for (const seed of SEEDS) {
  const r = analyse(seed);
  console.log(
    r.seed.padEnd(12),
    String(r.trailC).padStart(6), String(r.trackC).padStart(6), String(r.roadC).padStart(6),
    r.pathPct.toFixed(2).padStart(7), String(r.segs).padStart(6),
    r.trGrade.toFixed(2).padStart(8), (r.trSteepPct.toFixed(0) + "%").padStart(9),
    r.alongGr.toFixed(3).padStart(8), (r.alongSteepPct.toFixed(0) + "%").padStart(10),
  );
  for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += (r as unknown as Record<string, number>)[k];
}
const m = SEEDS.length;
console.log("".padEnd(12), "-".repeat(84));
console.log(
  "MEAN".padEnd(12),
  (agg.trailC / m).toFixed(0).padStart(6), (agg.trackC / m).toFixed(0).padStart(6), (agg.roadC / m).toFixed(0).padStart(6),
  (agg.pathPct / m).toFixed(2).padStart(7), (agg.segs / m).toFixed(1).padStart(6),
  (agg.trGrade / m).toFixed(2).padStart(8), ((agg.trSteepPct / m).toFixed(0) + "%").padStart(9),
  (agg.alongGr / m).toFixed(3).padStart(8), ((agg.alongSteepPct / m).toFixed(0) + "%").padStart(10),
);
