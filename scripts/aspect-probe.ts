/**
 * aspect-probe — issue 007: does vegetation respect ASPECT? In reality shaded (pole/north-facing)
 * slopes hold moisture → forest; sun-facing slopes are dry → scrub. classifyLand had no aspect term,
 * so north- and south-facing slopes grew the SAME vegetation. This measures the correlation between a
 * cell being FOREST and its slope facing north (shaded), on real slopes (slope > 0.12).
 *
 * forestNorth%  = of FOREST cells on slopes, fraction facing north (shaded). >50% = aspect-aware.
 * scrubSouth%   = of SCRUB cells on slopes, fraction facing south (sunny). >50% = aspect-aware.
 * Before the fix both ≈ 50% (no aspect signal). After: forest skews north, scrub south.
 *
 * Run: npx tsx scripts/aspect-probe.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const N = Number(process.argv[2] ?? 10);
const SEEDS = Array.from({ length: N }, (_, i) => `survey-${i}`);

function run(seed: string) {
  const t = createWorld(seed, 90).terrain;
  const sz = t.size, cs = t.cellSize;
  let fN = 0, fAll = 0, sS = 0, sAll = 0;
  for (let y = 1; y < sz - 1; y++)
    for (let x = 1; x < sz - 1; x++) {
      const i = t.idx(x, y);
      const l = t.land[i] as Land;
      if (l !== Land.Forest && l !== Land.Scrub) continue;
      const e = t.elev[i];
      const dzdy = (t.elev[t.idx(x, y + 1)] - e) / cs; // >0 ⇒ slope descends toward -y (north) ⇒ north-facing
      const slope = t.slope[i];
      if (slope < 0.12) continue; // aspect only meaningful on real slopes
      const facesNorth = dzdy > 0;
      if (l === Land.Forest) { fAll++; if (facesNorth) fN++; }
      else { sAll++; if (!facesNorth) sS++; }
    }
  return { fN: fAll ? fN / fAll : 0, sS: sAll ? sS / sAll : 0, fAll, sAll };
}

console.log("seed         | forestNorth% | scrubSouth% | (50% = no aspect signal — the bug)");
console.log("-------------|--------------|-------------|");
let fSum = 0, sSum = 0;
for (const s of SEEDS) {
  const r = run(s);
  fSum += r.fN; sSum += r.sS;
  console.log(`${s.padEnd(12)} |     ${(100 * r.fN).toFixed(0).padStart(3)}%     |    ${(100 * r.sS).toFixed(0).padStart(3)}%    |`);
}
const n = SEEDS.length;
console.log("-------------|--------------|-------------|");
console.log(`MEAN forest-faces-north ${(100 * fSum / n).toFixed(1)}% · scrub-faces-south ${(100 * sSum / n).toFixed(1)}%  (want both > 50% = vegetation reads the sun)`);
