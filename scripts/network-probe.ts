/**
 * Road/path network probe — the hard metric for item 8 (remove village→water troughs;
 * add a connected tiered network). Two numbers per seed, headless, across a seed sweep:
 *
 *   troughCells: Land.Trail cells that are BENCHED into a trench — i.e. the cell's
 *                elevation sits more than TROUGH_M below the mean of its NON-path
 *                natural neighbours. The current per-village descendTrack(...Land.Trail)
 *                gouges a trench from each qalat to the river, so this is high today and
 *                must drop to ~0 once trails ride lightly on the surface (layPath).
 *                (Land.Road is excluded so the legitimate benched COP access road and the
 *                 valley MSR don't count; only the village foot trails are measured.)
 *
 *   netVil%:     fraction of villages whose centre is connected to the valley road over a
 *                flood fill restricted to network cells {Road, Trail, Footbridge, (Track)}.
 *                The village-MST network should push this to 100% on every seed.
 *
 * Run: npx tsx scripts/network-probe.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const TROUGH_M = 1.5; // m below natural neighbours to count a trail cell as a trench

// network landcover: anything a foot/vehicle route runs on. Track (24) may not exist yet
// on an un-migrated build — referenced numerically so this compiles either way.
const TRACK = 24;
function isNet(l: number): boolean {
  return l === Land.Road || l === Land.Trail || l === Land.Footbridge || l === TRACK;
}

function troughCells(t: any): number {
  const { size } = t;
  let n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = t.idx(x, y);
      const li = t.land[i] as number;
      if (li !== Land.Trail && li !== TRACK) continue; // foot trails + secondary tracks (not the MSR/COP ramp)
      const e = t.elev[i];
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = t.idx(x + dx, y + dy);
          const lj = t.land[j] as number;
          if (isNet(lj)) continue; // compare only against NATURAL ground
          sum += t.elev[j];
          cnt++;
        }
      if (cnt >= 3 && sum / cnt - e > TROUGH_M) n++;
    }
  }
  return n;
}

// flood fill over network cells from the valley-floor road; report villages connected.
function netVillages(t: any): { connected: number; total: number } {
  const { size } = t;
  const seen = new Uint8Array(size * size);
  const stack: number[] = [];
  // seed from every Road cell on the valley floor (the MSR backbone)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = t.idx(x, y);
      if ((t.land[i] as number) === Land.Road) {
        seen[i] = 1;
        stack.push(i);
      }
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % size;
    const y = (i / size) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = t.idx(nx, ny);
        if (seen[j]) continue;
        if (!isNet(t.land[j] as number)) continue;
        seen[j] = 1;
        stack.push(j);
      }
  }
  // a village is "connected" if any network cell within 'reach' of its centre is in the fill
  let connected = 0;
  const reach = 6;
  for (const v of t.villages) {
    let hit = false;
    for (let dy = -reach; dy <= reach && !hit; dy++)
      for (let dx = -reach; dx <= reach && !hit; dx++) {
        const nx = v.cx + dx;
        const ny = v.cy + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = t.idx(nx, ny);
        if (seen[j] && isNet(t.land[j] as number)) hit = true;
      }
    if (hit) connected++;
  }
  return { connected, total: t.villages.length };
}

console.log("seed".padEnd(12), "troughCells".padStart(12), "netVil".padStart(8), "rate".padStart(6));
let trSum = 0;
let conSum = 0;
let vilSum = 0;
for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    continue;
  }
  const t = w.terrain;
  const tr = troughCells(t);
  const nv = netVillages(t);
  trSum += tr;
  conSum += nv.connected;
  vilSum += nv.total;
  console.log(
    seed.padEnd(12),
    String(tr).padStart(12),
    `${nv.connected}/${nv.total}`.padStart(8),
    `${Math.round((nv.connected / Math.max(1, nv.total)) * 100)}%`.padStart(6)
  );
}
console.log("\nsummary over", SEEDS.length, "seeds:");
console.log("  total trough cells:", trSum, "(item 8: must drop to ~0)");
console.log("  villages network-connected:", conSum, "/", vilSum, `(${Math.round((conSum / Math.max(1, vilSum)) * 100)}%) — target 100%`);
