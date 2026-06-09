/**
 * cover-probe — issue 020: is there MORE discrete cover on the map for a soldier to use, and is the
 * cover the combat sees the SAME object the renderer draws?
 *
 * Before this pass, cover was a single landcover-averaged scalar per 5 m cell and the drawn rocks were
 * a cosmetic overlay decoupled from it — so an open slope (Grass/Meadow/Scrub) offered ~nothing to get
 * behind (cover ≈ 0.05–0.12) and the boulders you could see weren't real cover. Now boulders/outcrops
 * are sim OBJECTS (terrain.coverObjects) that stamp the cover field AND are what decoration.ts draws.
 *
 * Columns (per seed):
 *   objs      : # discrete cover objects (the source of truth the renderer reads)
 *   onOpen    : of those, how many sit on OPEN slopes (Grass/Meadow/Scrub/Terrace) — the NEW cover the
 *               owner asked for ("more on the map to use for cover"); these add cover where there was none
 *   openCov%  : of sampled OPEN-slope cells, the fraction with usable hard cover (≥0.4) within 20 m —
 *               i.e. a soldier caught on that slope can reach something to get behind. Was ~0 before.
 *   meanReach : mean metres from a sampled open-slope cell to the nearest usable-cover (≥0.4) cell
 *               (capped at 60). Lower = more cover to maneuver to.
 *   drawn=sim : OK iff every coverObject's cell carries its stamped cover (the drawn rock IS the cover)
 *
 * Run: npx tsx scripts/cover-probe.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const N = process.argv[2] ? Number(process.argv[2]) : 0;
const SEEDS = N ? Array.from({ length: N }, (_, i) => "survey-" + i) : ["korengal", "korengal-2", "ridgeline", "restrepo", "kunar-3", "valley-7", "survey-2", "survey-9"];
const OPEN = new Set<Land>([Land.Grass, Land.Meadow, Land.Scrub, Land.Terrace]);
const USABLE = 0.4; // hard-cover that actually stops rounds / lets a man fight from behind it

function analyse(seed: string) {
  const t = createWorld(seed, 120).terrain;
  const size = t.size, cs = t.cellSize;
  const objs = t.coverObjects;
  let onOpen = 0;
  for (const o of objs) {
    const l = t.land[t.idx(Math.floor(o.x / cs), Math.floor(o.y / cs))] as Land;
    if (OPEN.has(l)) onOpen++;
  }
  // drawn=sim integrity: every object's cell carries cover >= its stamped value (within fp tol)
  let drawnSimOk = true;
  for (const o of objs) {
    const i = t.idx(Math.floor(o.x / cs), Math.floor(o.y / cs));
    if (t.cover[i] + 1e-6 < o.cover) { drawnSimOk = false; break; }
  }
  // open-slope cover availability
  const R = 4; // 20 m search
  let sampled = 0, withCover = 0, reachSum = 0;
  for (let cy = 2; cy < size - 2; cy += 3)
    for (let cx = 2; cx < size - 2; cx += 3) {
      const l = t.land[t.idx(cx, cy)] as Land;
      const slope = t.slope[t.idx(cx, cy)];
      if (!OPEN.has(l) || slope < 0.12) continue; // a slope a firefight could happen on
      sampled++;
      let best = 999;
      for (let dy = -12; dy <= 12; dy++)
        for (let dx = -12; dx <= 12; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (t.cover[t.idx(nx, ny)] >= USABLE) {
            const d = Math.hypot(dx, dy);
            if (d < best) best = d;
          }
        }
      if (best * cs <= R * cs) withCover++;
      reachSum += Math.min(60, best * cs);
    }
  return {
    seed, objs: objs.length, onOpen,
    openCovPct: sampled ? (100 * withCover) / sampled : 0,
    meanReach: sampled ? reachSum / sampled : 0,
    drawnSimOk,
  };
}

console.log("seed".padEnd(12), "objs".padStart(7), "onOpen".padStart(7), "openCov%".padStart(9), "meanReach".padStart(10), "drawn=sim".padStart(10));
const agg = { objs: 0, onOpen: 0, openCovPct: 0, meanReach: 0 };
let allOk = true;
for (const seed of SEEDS) {
  const r = analyse(seed);
  if (!r.drawnSimOk) allOk = false;
  console.log(r.seed.padEnd(12), String(r.objs).padStart(7), String(r.onOpen).padStart(7), (r.openCovPct.toFixed(0) + "%").padStart(9), (r.meanReach.toFixed(0) + "m").padStart(10), (r.drawnSimOk ? "OK" : "FAIL").padStart(10));
  agg.objs += r.objs; agg.onOpen += r.onOpen; agg.openCovPct += r.openCovPct; agg.meanReach += r.meanReach;
}
const m = SEEDS.length;
console.log("".padEnd(12), "-".repeat(56));
console.log("MEAN".padEnd(12), (agg.objs / m).toFixed(0).padStart(7), (agg.onOpen / m).toFixed(0).padStart(7), ((agg.openCovPct / m).toFixed(0) + "%").padStart(9), ((agg.meanReach / m).toFixed(0) + "m").padStart(10), (allOk ? "OK" : "FAIL").padStart(10));
