import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
for (const seed of (process.argv.slice(2).length ? process.argv.slice(2) : ["survey-8", "survey-5", "survey-0"])) {
  const w: any = createWorld(seed, 60);
  const t = w.terrain;
  console.log(`\n=== ${seed} ===  netRepair=`, JSON.stringify(t.netRepair));
  // count land types of interest
  const size = t.size;
  let road = 0, track = 0, trail = 0;
  for (let i = 0; i < size * size; i++) { const l = t.land[i]; if (l === Land.Road) road++; else if (l === Land.Track) track++; else if (l === Land.Trail) trail++; }
  console.log(`  Road=${road} Track=${track} Trail=${trail}  villages=${t.villages.length}  cop=(${t.cop.center.cx},${t.cop.center.cy}) gateOut=(${t.cop.gateOutside.cx},${t.cop.gateOutside.cy})`);
  // re-flood network from Road (network-probe notion) and report per-village distance to nearest Road cell
  const seen = new Uint8Array(size * size); const stack: number[] = [];
  const isNet = (cx: number, cy: number) => { const l = t.land[t.idx(cx, cy)] as Land; return l === Land.Road || l === Land.Track || l === Land.Trail || l === Land.Footbridge; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((t.land[t.idx(x, y)] as Land) === Land.Road) { seen[t.idx(x, y)] = 1; stack.push(t.idx(x, y)); }
  while (stack.length) { const i = stack.pop()!; const x = i % size, y = (i / size) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue; const j = t.idx(nx, ny); if (seen[j] || !isNet(nx, ny)) continue; seen[j] = 1; stack.push(j); } }
  for (const v of t.villages) {
    let conn = false; for (let dy = -6; dy <= 6 && !conn; dy++) for (let dx = -6; dx <= 6 && !conn; dx++) { const nx = v.cx + dx, ny = v.cy + dy; if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue; if (seen[t.idx(nx, ny)]) conn = true; }
    // nearest passable approach and what land is around the village
    const ap = t.nearestPassable(v.cx, v.cy, 12);
    const apL = Land[t.land[t.idx(ap.cx, ap.cy)]] ?? t.land[t.idx(ap.cx, ap.cy)];
    console.log(`  ${v.name.padEnd(12)} (${v.cx},${v.cy}) conn=${conn ? "YES" : "no "}  approach=(${ap.cx},${ap.cy})[${apL}]`);
  }
}
