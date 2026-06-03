import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath } from "../lib/sim/path";

/**
 * Survey the COP knob + access-road corridor across many seeds, so the access
 * road can be redesigned for the full range of terrain (gentle bench vs. a high,
 * steep spur). Reports the knob's height above the valley floor, the natural
 * slope the road must cross, current bulldozed-ramp footprint, and whether the
 * gate is reachable from the valley road by foot pathing.
 */

const N = Number(process.argv[2] ?? 24);
const cellSize = 5;

function fmt(n: number, w = 6) {
  return String(n).padStart(w);
}

let bulldozedSum = 0;
let steepSeeds = 0;
console.log(
  "seed".padEnd(10),
  "knobUp",
  "relief",
  "prom%",
  "ctrDist",
  "natMaxS",
  "rampCells",
  "reach?"
);
for (let s = 0; s < N; s++) {
  const seed = "survey-" + s;
  const w = createWorld(seed, 60);
  const t = w.terrain;
  const size = t.size;
  const cop = t.cop;
  const go = cop.gateOutside;
  const cc = cop.center;
  const gateElev = t.elev[t.idx(go.cx, go.cy)];
  const valleyX = Math.round((t as any).centerX[go.cy]);
  const floorE = t.floorElevAtRow(go.cy);
  const knobUp = Math.round(gateElev - floorE);
  // How much the COP center commands its immediate surroundings: its rise above the
  // lowest ground within ~150 m, and the fraction of nearby cells below it.
  const ccE = t.elev[t.idx(cc.cx, cc.cy)];
  let localMin = Infinity;
  let lower = 0;
  let tot = 0;
  for (let dy = -30; dy <= 30; dy += 2)
    for (let dx = -30; dx <= 30; dx += 2) {
      const x = cc.cx + dx;
      const y = cc.cy + dy;
      if (!t.inBounds(x, y)) continue;
      const e = t.elev[t.idx(x, y)];
      localMin = Math.min(localMin, e);
      tot++;
      if (e < ccE) lower++;
    }
  const relief = Math.round(ccE - localMin);
  const promPct = Math.round((lower / Math.max(1, tot)) * 100);
  const valDist = Math.round(Math.abs(cc.cx - (t as any).centerX[cc.cy]) * cellSize);

  // Natural slope/impassability sampled in a band offset from the graded ramp
  // (so we read untouched ground), from the gate toward the valley centerline.
  let natMax = 0;
  let impass = 0;
  let nSamp = 0;
  const n = Math.max(1, Math.abs(go.cx - valleyX));
  for (let k = 0; k <= n; k++) {
    const x = Math.round(go.cx + ((valleyX - go.cx) * k) / n);
    for (const off of [-9, -7, 7, 9]) {
      const y = go.cy + off;
      if (!t.inBounds(x, y)) continue;
      const sl = t.slope[t.idx(x, y)];
      natMax = Math.max(natMax, sl);
      if (sl > 1.25) impass++;
      nSamp++;
    }
  }
  const impassPct = Math.round((impass / Math.max(1, nSamp)) * 100);

  // Current bulldozed ramp footprint: Road cells within the knob→valley window
  // that are NOT the valley-floor road (i.e. the access ramp).
  let rampCells = 0;
  const wx0 = Math.min(go.cx, valleyX) - 4;
  const wx1 = Math.max(go.cx, valleyX) + 4;
  for (let x = wx0; x <= wx1; x++)
    for (let y = go.cy - 5; y <= go.cy + 5; y++) {
      if (!t.inBounds(x, y)) continue;
      if (t.land[t.idx(x, y)] === Land.Road) rampCells++;
    }

  // Can a patrol actually path from just outside the gate to the valley road?
  const start = t.cellCenter(go.cx, go.cy);
  const goal = t.cellCenter(valleyX, go.cy);
  const path = findPath(t, start, goal, { roadBias: 0.4 });
  const last = path[path.length - 1];
  const reached = Math.hypot(last.x - goal.x, last.y - goal.y) < 30;

  if (natMax > 1.25) steepSeeds++;
  bulldozedSum += rampCells;
  console.log(
    seed.padEnd(10),
    fmt(knobUp),
    fmt(relief),
    fmt(promPct),
    fmt(valDist),
    fmt(+natMax.toFixed(2)),
    fmt(rampCells),
    "   " + (reached ? "Y" : "N")
  );
}
console.log("\nseeds with a genuinely steep (slope>1.25) natural corridor:", steepSeeds, "/", N);
console.log("avg bulldozed ramp cells/seed:", Math.round(bulldozedSum / N), "(=", Math.round((bulldozedSum / N) * cellSize * cellSize), "m^2 of trough)");
