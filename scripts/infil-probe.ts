/**
 * VECTOR C: enemy INFILTRATION pathing (spawnInfiltration). Fighters stage at a draw
 * mouth (map side +/-0.4) and pathTo (villageCenter + 20..60m jitter) with concealBias
 * 0.7 — NOT snapped via nearestReachable. Measure how often that path strands >50m short
 * (goal across the river from staging, or in a walled qalat pocket). This is the enemy
 * analogue of the civilian gap; lower stakes (infiltrators engage on sighting) but it
 * shows the same missing-snap weakness. Deterministic via the world RNG fork the director
 * uses for jitter is not reproducible here, so we sample the jitter band uniformly.
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";

const SEEDS = Array.from({ length: Number(process.argv[2] ?? 30) }, (_, i) => "survey-" + i);
const ARRIVE = 50;

let total = 0, strand = 0, worst = 0;
for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t = w.terrain;
  // replicate drawStaging: pick, per village, the nearest draw-mouth staging point
  for (const v of t.villages) {
    const targetPt = t.cellCenter(v.cx, v.cy);
    let staging: any = null, bestD = Infinity;
    for (const d of t.drawChannels ?? []) {
      const cx = t.size / 2 + d.side * t.size * 0.4;
      const p = t.cellCenter(Math.round(Math.max(4, Math.min(t.size - 4, cx))), Math.round(Math.max(4, Math.min(t.size - 4, d.y))));
      const dd = Math.hypot(p.x - targetPt.x, p.y - targetPt.y);
      if (dd < bestD) { bestD = dd; staging = p; }
    }
    if (!staging) continue;
    // sample several jittered goals in the 20..60m ring (as the director does)
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const rad = 20 + (k % 3) * 20;
      const goal = { x: targetPt.x + Math.cos(ang) * rad, y: targetPt.y + Math.sin(ang) * rad };
      const cgx = Math.floor(goal.x / t.cellSize), cgy = Math.floor(goal.y / t.cellSize);
      if (!t.inBounds(cgx, cgy)) continue;
      total++;
      const route = findPath(t, staging, goal, { concealBias: 0.7 });
      const end = route[route.length - 1];
      const short = Math.hypot(end.x - goal.x, end.y - goal.y);
      if (short > ARRIVE) { strand++; worst = Math.max(worst, short); }
    }
  }
}
console.log(`infiltration goals sampled: ${total}`);
console.log(`  STRANDED (>${ARRIVE}m short): ${strand} (${Math.round((strand / total) * 100)}%)  worst ${Math.round(worst)}m`);
