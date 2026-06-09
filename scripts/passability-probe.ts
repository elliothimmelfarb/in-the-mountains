/**
 * passability-probe — is "most of the map" passable, are the impassable bits OBVIOUS (real cliff
 * bands, not salt-and-pepper noise), and how much of the impassable ground is a FAKE CLIFF that a
 * neighbourhood-aware slope test would recover?
 *
 * Metricizes the owner's terrain-realism asks (issue 014/019): "humans should traverse up steep
 * terrain", "impassable terrain should be obvious", "passable terrain should be most of the map".
 *
 * The mechanism it pins: passability is gated on a SINGLE-CELL forward-difference slope vs a hard
 * FOOT_MAX_SLOPE=1.25 (terrain.ts:2822). The heightmap adds high-frequency roughness (detailNoise
 * fbm ×7 m), so a climbable ~35° face gets speckled with isolated 5 m cells spiking past 51° — fake
 * cliffs that fragment the face and that a soldier would simply step around.
 *
 * Columns (per seed, over the whole 512² grid; flood honours the mover's anti-corner-cut rule):
 *   pass%      : fraction of ALL cells that are passableCell (owner wants this to be the majority)
 *   reach%     : fraction of ALL cells in the gate's reachable component (the USABLE map — passable
 *                AND connected to where the squad operates). pass% minus reach% = stranded pockets.
 *   slopeImp%  : of impassable cells, the fraction impassable PURELY by slope (not wall/water/bldg)
 *   speckle%   : of slope-impassable cells, the fraction that are isolated SPECKLE — ≥5 of their 8
 *                neighbours are passable. These are the fake cliffs (a real cliff has impassable
 *                neighbours; a speckle sits in a sea of walkable ground). HIGH = noisy, illegible.
 *   recover%   : of slope-impassable cells, the fraction a 3×3 MEAN-slope test (≤1.25) would reclaim
 *                — the headroom a neighbourhood-aware passability gains without touching real cliffs.
 *   comps      : # passable components ≥ 50 cells (fragmentation — 1 is ideal-ish for a valley floor)
 *   big%       : fraction of passable cells in the single LARGEST component (connectivity of walkable
 *                ground; low = the walkable map is shattered into islands)
 *
 * Run: npx tsx scripts/passability-probe.ts [N]   (N survey seeds, else a documented set)
 */
import { createWorld } from "../lib/sim/world";
import { Land, FOOT_MAX_SLOPE } from "../lib/sim/terrain";

const N = process.argv[2] ? Number(process.argv[2]) : 0;
const SEEDS = N
  ? Array.from({ length: N }, (_, i) => "survey-" + i)
  : ["korengal", "korengal-2", "ridgeline", "restrepo", "kunar-3", "valley-7", "survey-2", "survey-9"];

// Replicate passableCell's non-slope blockers so we can split "impassable by slope" from the rest.
const HARD_BLOCK = new Set<Land>([Land.Cliff, Land.CompoundWall, Land.Hesco, Land.Structure, Land.River]);

function analyse(seed: string) {
  const t = createWorld(seed, 120).terrain;
  const size = t.size;
  const n = size * size;
  const slope = t.slope;
  const land = t.land;
  const idx = (x: number, y: number) => y * size + x;

  // raw passability (mirror terrain.passableCell exactly)
  const pass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = land[i] as Land;
    pass[i] = !HARD_BLOCK.has(l) && slope[i] <= FOOT_MAX_SLOPE ? 1 : 0;
  }

  let passN = 0, impN = 0, slopeImp = 0, speckle = 0, recover = 0;
  // 3×3 mean slope for the recover / speckle tests
  const meanSlope = (x: number, y: number) => {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        s += slope[idx(nx, ny)]; c++;
      }
    return s / c;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = idx(x, y);
      if (pass[i]) { passN++; continue; }
      impN++;
      const l = land[i] as Land;
      const bySlope = !HARD_BLOCK.has(l) && slope[i] > FOOT_MAX_SLOPE;
      if (!bySlope) continue;
      slopeImp++;
      // speckle: ≥5 of 8 neighbours passable
      let openNb = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (pass[idx(nx, ny)]) openNb++;
        }
      if (openNb >= 5) speckle++;
      if (meanSlope(x, y) <= FOOT_MAX_SLOPE) recover++;
    }

  // gate-reachable component (the engine's own, anti-corner-cut)
  const reach = t.reachableFromGate();
  let reachN = 0;
  for (let i = 0; i < n; i++) if (reach[i]) reachN++;

  // passable component sizes (anti-corner-cut flood, matching the mover)
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || !pass[s]) continue;
    comp[s] = sizes.length;
    let cnt = 0;
    stack.length = 0; stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      cnt++;
      const x = k % size, y = (k / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (comp[j] !== -1 || !pass[j]) continue;
          if (dx !== 0 && dy !== 0 && !pass[idx(x + dx, y)] && !pass[idx(x, y + dy)]) continue; // no corner-cut
          comp[j] = comp[s]; stack.push(j);
        }
    }
    sizes.push(cnt);
  }
  const bigComps = sizes.filter((z) => z >= 50).length;
  const largest = sizes.length ? Math.max(...sizes) : 0;

  return {
    seed,
    passPct: (100 * passN) / n,
    reachPct: (100 * reachN) / n,
    slopeImpPct: impN ? (100 * slopeImp) / impN : 0,
    specklePct: slopeImp ? (100 * speckle) / slopeImp : 0,
    recoverPct: slopeImp ? (100 * recover) / slopeImp : 0,
    comps: bigComps,
    bigPct: passN ? (100 * largest) / passN : 0,
  };
}

console.log(
  "seed".padEnd(12),
  "pass%".padStart(7),
  "reach%".padStart(7),
  "slopeImp%".padStart(10),
  "speckle%".padStart(9),
  "recover%".padStart(9),
  "comps".padStart(6),
  "big%".padStart(7),
);
const agg = { passPct: 0, reachPct: 0, slopeImpPct: 0, specklePct: 0, recoverPct: 0, comps: 0, bigPct: 0 };
for (const seed of SEEDS) {
  const r = analyse(seed);
  console.log(
    r.seed.padEnd(12),
    r.passPct.toFixed(1).padStart(7),
    r.reachPct.toFixed(1).padStart(7),
    r.slopeImpPct.toFixed(0).padStart(9) + "%",
    r.specklePct.toFixed(0).padStart(8) + "%",
    r.recoverPct.toFixed(0).padStart(8) + "%",
    String(r.comps).padStart(6),
    r.bigPct.toFixed(1).padStart(6) + "%",
  );
  for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += (r as unknown as Record<string, number>)[k];
}
const m = SEEDS.length;
console.log("".padEnd(12), "-".repeat(64));
console.log(
  "MEAN".padEnd(12),
  (agg.passPct / m).toFixed(1).padStart(7),
  (agg.reachPct / m).toFixed(1).padStart(7),
  (agg.slopeImpPct / m).toFixed(0).padStart(9) + "%",
  (agg.specklePct / m).toFixed(0).padStart(8) + "%",
  (agg.recoverPct / m).toFixed(0).padStart(8) + "%",
  (agg.comps / m).toFixed(1).padStart(6),
  (agg.bigPct / m).toFixed(1).padStart(6) + "%",
);
