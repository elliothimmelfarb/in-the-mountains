/**
 * terrain-roughness — Phase 1 front C ("terrain too smooth / abstract"): SHAPE statistics
 * of the generated valley vs the real-Korengal oracle (realism campaign CONTEXT.md, 2026-07-02).
 * The sim valley is 2.56 km wide with ~1230–1400 m relief vs the real 1200–1800 m over 2–3 km, so
 * everything here is a shape/texture statistic, not an absolute-size comparison.
 *
 * Per seed (+ MEAN over the survey seeds; `korengal` reported separately):
 *   slope pXX (ALL/WALL): slope-distribution percentiles (slope = |∇z| rise/run, 5 m forward
 *       difference — the exact field passability/classifyLand read). WALL = cells with
 *       |x − centerXAt(y)| > 13 cells (65 m), i.e. clear of carveFloodplain's flatten+feather
 *       (reaches 10.6 cells ≈ 53 m each side of the centerline), land ≠ River.
 *   band% / cliff%   : fraction of WALL cells with slope ∈ [0.58, 1.0] (sustained 30–45° — the
 *       real-Korengal signature band) and > 1.0 (cliff-ish).
 *   banded% / comps  : contiguity of the >1.0 wall cells — % sitting in 8-connected components
 *       ≥ 20 cells (real cliff BANDS) vs isolated speckle; count of such components.
 *   r100 raw p50/p90 : per 100×100 m window (20×20 cells), max−min elevation over WALL windows
 *       (≥90% wall cells). Oracle: a 100 m window on a sustained 35° wall holds ~70 m relief.
 *   r100 detr p50/p90: same window, PLANE-DETRENDED (residual after least-squares plane fit) —
 *       the texture WITHIN the wall once its mean tilt is removed. A smooth ramp scores ~0 no
 *       matter how steep; real cliff bands / scree chutes / outcrop score ~10–30 m.
 *   R3 / R9          : RMS of (elev − 3×3 mean) and (elev − 9×9 mean) over WALL cells — the
 *       high-frequency relief energy below ~15 m / ~45 m wavelength. RMS is dominated by the few
 *       sharpest spots (draw lips, bench edges), so md3/md9 = MEDIAN |elev − mean| give the
 *       TYPICAL wall-cell texture alongside.
 *   E5-15 / E15-45 / E45-135: band-pass energy via difference of box means (m3, m9, m27) — WHERE
 *       the fine energy lives. CONTEXT predicts fine roughness = fbm(70 m) × 7 m amp, 3 oct ⇒
 *       starved 5–25 m band; this confirms and quantifies it.
 *   NOTE: cells whose land is River/Structure/CompoundWall/Hesco are excluded from all wall/floor
 *       stats — buildings and the HESCO ring are elevation-STAMPED (terrain.ts:1024 baseE+2.2)
 *       and would contaminate the terrain-shape numbers with architecture.
 *   floor p50 / fR3  : floodplain (|dx| ≤ 9 cells, non-river) slope median + fine RMS — the
 *       "flat plate floor" check.
 *   slope-by-distance: mean WALL slope in 100 m bins of distance from the centerline — the
 *       cross-valley section shape (concave river-cut vs uniform vs convex-crested).
 * Plus: 3 cross-valley transects on seed `korengal` (rows y=128/256/384) written as CSV
 * (transect,y_m,x_m,elev_m) into the campaign baseline dir with a per-transect shape summary
 * (floor flat-run width; wall elevation-reversal density at 3 m hysteresis — a smooth power wall
 * reverses rarely, a benched/cliff-banded wall reverses often), and the render-side visibility
 * math (px per 5 m cell and px per relief wavelength at ppm 0.4→3.0, u_detailGain schedule) so
 * the generation-vs-render question is answered with numbers.
 *
 * Read-only on lib/**. Deterministic. Writes only the transect CSV (path printed).
 *
 * Run: npx tsx scripts/terrain-roughness.ts [N] [START]   (N survey seeds from survey-START,
 *   default 8 from 0; e.g. `… 8 40` = held-out survey-40..47. CSV is only written for START=0;
 *   override its path with ITM_TRANSECT_CSV=… so a post-change run can't clobber the baseline.)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const N = process.argv[2] ? Number(process.argv[2]) : 8;
const START = process.argv[3] ? Number(process.argv[3]) : 0;
const SURVEY = Array.from({ length: N }, (_, i) => "survey-" + (START + i));
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSV_PATH =
  process.env.ITM_TRANSECT_CSV ??
  resolve(REPO, "docs/progress/2026-07-02-realism-campaign/baseline/terrain-transects-korengal-HEAD.csv");

const WALL_DX = 13; // cells; carveFloodplain flatten+feather reaches 10.6 cells (53 m) each side
const MARGIN = 2; // skip map border + forward-difference edge artifacts
const PCTS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99];

function pct(sorted: Float32Array, p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "  — ");

interface SeedStats {
  seed: string;
  pAll: number[]; pWall: number[];
  bandPct: number; cliffPct: number; bandedPct: number; comps: number; maxBlobPct: number;
  r100raw50: number; r100raw90: number; r100detr50: number; r100detr90: number;
  R3: number; R9: number; md3: number; md9: number; E515: number; E1545: number; E45135: number;
  floorP50: number; floorP90: number; floorR3: number; floorMd3: number;
  rimP50: number; rimP90: number;
  relief: number; rowRelief: number;
  distBins: number[]; distBinN: number[];
}

// Elevation-STAMPED land classes (architecture, not terrain): HESCO stands baseE+2.2
// (terrain.ts:1024); qalat pads/walls bench+extrude. Exclude from terrain-shape stats.
const STAMPED = new Set<Land>([Land.River, Land.Structure, Land.CompoundWall, Land.Hesco]);

function analyse(seed: string): SeedStats {
  const t = createWorld(seed, 120).terrain;
  const size = t.size, cs = t.cellSize;
  const { elev, slope, land } = t;
  const idx = (x: number, y: number) => y * size + x;

  // Wall / floor masks
  const cxRow = new Float32Array(size);
  for (let y = 0; y < size; y++) cxRow[y] = t.centerXAt(y);
  const natural = (x: number, y: number) => !STAMPED.has(land[idx(x, y)] as Land);
  const isWall = (x: number, y: number) => Math.abs(x - cxRow[y]) > WALL_DX && natural(x, y);
  const isFloor = (x: number, y: number) => Math.abs(x - cxRow[y]) <= 9 && natural(x, y);

  // --- slope distributions ---
  const allS: number[] = [], wallS: number[] = [], floorS: number[] = [], rimS: number[] = [];
  let band = 0, cliff = 0, wallN = 0;
  for (let y = MARGIN; y < size - MARGIN; y++)
    for (let x = MARGIN; x < size - MARGIN; x++) {
      const s = slope[idx(x, y)];
      if ((land[idx(x, y)] as Land) !== Land.River) allS.push(s);
      const adx = Math.abs(x - cxRow[y]);
      if (adx >= 8 && adx <= 12 && natural(x, y)) rimS.push(s); // floodplain feather rim (seam check)
      if (isWall(x, y)) {
        wallS.push(s); wallN++;
        if (s >= 0.58 && s <= 1.0) band++;
        else if (s > 1.0) cliff++;
      } else if (isFloor(x, y)) floorS.push(s);
    }
  const allSorted = Float32Array.from(allS).sort();
  const wallSorted = Float32Array.from(wallS).sort();
  const floorSorted = Float32Array.from(floorS).sort();
  const rimSorted = Float32Array.from(rimS).sort();

  // --- cliff-band contiguity: 8-connected components of wall cells slope>1.0 ---
  const mask = new Uint8Array(size * size);
  for (let y = MARGIN; y < size - MARGIN; y++)
    for (let x = MARGIN; x < size - MARGIN; x++)
      if (isWall(x, y) && slope[idx(x, y)] > 1.0) mask[idx(x, y)] = 1;
  const seen = new Uint8Array(size * size);
  let comps = 0, bandedCells = 0, totalMask = 0, maxBlob = 0;
  const stack: number[] = [];
  for (let y = MARGIN; y < size - MARGIN; y++)
    for (let x = MARGIN; x < size - MARGIN; x++) {
      const i0 = idx(x, y);
      if (!mask[i0]) continue;
      totalMask++;
      if (seen[i0]) continue;
      // flood this component
      let compSize = 0;
      stack.length = 0; stack.push(i0); seen[i0] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        compSize++;
        const px = i % size, py = (i / size) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = idx(nx, ny);
            if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
      }
      if (compSize >= 20) { comps++; bandedCells += compSize; }
      if (compSize > maxBlob) maxBlob = compSize;
    }

  // --- box means via summed-area table (edge-clamped windows) ---
  const sat = new Float64Array((size + 1) * (size + 1));
  for (let y = 0; y < size; y++) {
    let rowSum = 0;
    for (let x = 0; x < size; x++) {
      rowSum += elev[idx(x, y)];
      sat[(y + 1) * (size + 1) + (x + 1)] = sat[y * (size + 1) + (x + 1)] + rowSum;
    }
  }
  const boxMean = (x: number, y: number, r: number) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(size - 1, x + r);
    const y0 = Math.max(0, y - r), y1 = Math.min(size - 1, y + r);
    const S = (xx: number, yy: number) => sat[yy * (size + 1) + xx];
    return (S(x1 + 1, y1 + 1) - S(x0, y1 + 1) - S(x1 + 1, y0) + S(x0, y0)) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };
  let s3 = 0, s9 = 0, e515 = 0, e1545 = 0, e45135 = 0, nRms = 0;
  let fs3 = 0, fN = 0;
  const a3: number[] = [], a9: number[] = [], fa3: number[] = [];
  for (let y = MARGIN; y < size - MARGIN; y++)
    for (let x = MARGIN; x < size - MARGIN; x++) {
      const e = elev[idx(x, y)];
      const m3 = boxMean(x, y, 1), m9 = boxMean(x, y, 4), m27 = boxMean(x, y, 13);
      if (isWall(x, y)) {
        s3 += (e - m3) ** 2; s9 += (e - m9) ** 2;
        a3.push(Math.abs(e - m3)); a9.push(Math.abs(e - m9));
        e515 += (e - m3) ** 2; e1545 += (m3 - m9) ** 2; e45135 += (m9 - m27) ** 2;
        nRms++;
      } else if (isFloor(x, y)) { fs3 += (e - m3) ** 2; fa3.push(Math.abs(e - m3)); fN++; }
    }
  const R3 = Math.sqrt(s3 / nRms), R9 = Math.sqrt(s9 / nRms);
  const md3 = pct(Float32Array.from(a3).sort(), 0.5), md9 = pct(Float32Array.from(a9).sort(), 0.5);
  const E515 = Math.sqrt(e515 / nRms), E1545 = Math.sqrt(e1545 / nRms), E45135 = Math.sqrt(e45135 / nRms);
  const floorR3 = Math.sqrt(fs3 / Math.max(1, fN));
  const floorMd3 = pct(Float32Array.from(fa3).sort(), 0.5);

  // --- 100 m × 100 m local relief, raw + plane-detrended, over WALL windows ---
  const W = 20, off = 6, nw = 25; // 25×25 windows covering x,y ∈ [6, 505]
  const raw: number[] = [], detr: number[] = [];
  const xc = Array.from({ length: W }, (_, i) => i - (W - 1) / 2);
  const sxx = W * xc.reduce((a, v) => a + v * v, 0); // Σ xc² over the full 20×20 grid
  for (let wy = 0; wy < nw; wy++)
    for (let wx = 0; wx < nw; wx++) {
      const x0 = off + wx * W, y0 = off + wy * W;
      let wallCells = 0, sum = 0, sbx = 0, sby = 0;
      let mn = Infinity, mx = -Infinity;
      for (let dy = 0; dy < W; dy++)
        for (let dx = 0; dx < W; dx++) {
          const x = x0 + dx, y = y0 + dy;
          if (isWall(x, y)) wallCells++;
          const e = elev[idx(x, y)];
          sum += e; sbx += e * xc[dx]; sby += e * xc[dy];
          if (e < mn) mn = e;
          if (e > mx) mx = e;
        }
      if (wallCells / (W * W) < 0.9) continue;
      raw.push(mx - mn);
      const mean = sum / (W * W), b = sbx / sxx, c = sby / sxx;
      let rmn = Infinity, rmx = -Infinity;
      for (let dy = 0; dy < W; dy++)
        for (let dx = 0; dx < W; dx++) {
          const r = elev[idx(x0 + dx, y0 + dy)] - (mean + b * xc[dx] + c * xc[dy]);
          if (r < rmn) rmn = r;
          if (r > rmx) rmx = r;
        }
      detr.push(rmx - rmn);
    }
  const rawSorted = Float32Array.from(raw).sort();
  const detrSorted = Float32Array.from(detr).sort();

  // --- overall relief + median row relief (crest above local floor) ---
  let mn = Infinity, mx = -Infinity;
  const rowRel: number[] = [];
  for (let y = MARGIN; y < size - MARGIN; y++) {
    let rmx = -Infinity;
    for (let x = MARGIN; x < size - MARGIN; x++) {
      const e = elev[idx(x, y)];
      if (e < mn) mn = e;
      if (e > mx) mx = e;
      if (e > rmx) rmx = e;
    }
    rowRel.push(rmx - t.floorElevAtRow(y));
  }
  const rowSorted = Float32Array.from(rowRel).sort();

  // --- mean wall slope by distance-from-centerline (100 m bins) ---
  const NB = 13; // 0–100 … 1200+
  const distBins = new Array(NB).fill(0), distBinN = new Array(NB).fill(0);
  for (let y = MARGIN; y < size - MARGIN; y++)
    for (let x = MARGIN; x < size - MARGIN; x++) {
      if (!isWall(x, y)) continue;
      const dM = Math.abs(x - cxRow[y]) * cs;
      const b = Math.min(NB - 1, Math.floor(dM / 100));
      distBins[b] += slope[idx(x, y)]; distBinN[b]++;
    }
  for (let b = 0; b < NB; b++) distBins[b] = distBinN[b] ? distBins[b] / distBinN[b] : NaN;

  return {
    seed,
    pAll: PCTS.map((p) => pct(allSorted, p)),
    pWall: PCTS.map((p) => pct(wallSorted, p)),
    bandPct: (100 * band) / wallN,
    cliffPct: (100 * cliff) / wallN,
    bandedPct: totalMask ? (100 * bandedCells) / totalMask : 0,
    comps,
    maxBlobPct: totalMask ? (100 * maxBlob) / totalMask : 0,
    r100raw50: pct(rawSorted, 0.5), r100raw90: pct(rawSorted, 0.9),
    r100detr50: pct(detrSorted, 0.5), r100detr90: pct(detrSorted, 0.9),
    R3, R9, md3, md9, E515, E1545, E45135,
    floorP50: pct(floorSorted, 0.5), floorP90: pct(floorSorted, 0.9), floorR3, floorMd3,
    rimP50: pct(rimSorted, 0.5), rimP90: pct(rimSorted, 0.9),
    relief: mx - mn, rowRelief: pct(rowSorted, 0.5),
    distBins, distBinN,
  };
}

// ---------------------------------------------------------------------------
console.log("terrain-roughness — valley SHAPE statistics vs real-Korengal oracle");
console.log(`seeds: ${SURVEY.join(", ")} + korengal (transects)  |  wall = |dx| > ${WALL_DX} cells (${WALL_DX * 5} m) from centerline\n`);

const rows: SeedStats[] = [];
for (const s of SURVEY) rows.push(analyse(s));
const kor = analyse("korengal");

const mean = (get: (r: SeedStats) => number) => rows.reduce((a, r) => a + get(r), 0) / rows.length;
const meanArr = (get: (r: SeedStats) => number[]) =>
  get(rows[0]).map((_, i) => mean((r) => get(r)[i]));

// TABLE 1 — slope distribution
console.log("TABLE 1 — slope distribution (rise/run; 0.58≈30°, 1.0=45°)");
console.log("seed        |  ALL p10  p25  p50  p75  p90  p99 | WALL p10  p25  p50  p75  p90  p99 | band30-45% cliff>1.0% banded% comps maxBlob%");
const t1 = (r: SeedStats) =>
  `${r.seed.padEnd(11)} |      ${r.pAll.map((v) => f(v)).join(" ")} |      ${r.pWall.map((v) => f(v)).join(" ")} |      ${f(r.bandPct, 1).padStart(5)}      ${f(r.cliffPct, 1).padStart(5)}   ${f(r.bandedPct, 1).padStart(5)}    ${String(r.comps).padStart(3)}    ${f(r.maxBlobPct, 1).padStart(5)}`;
for (const r of rows) console.log(t1(r));
console.log(t1({ ...rows[0], seed: "MEAN", pAll: meanArr((r) => r.pAll), pWall: meanArr((r) => r.pWall), bandPct: mean((r) => r.bandPct), cliffPct: mean((r) => r.cliffPct), bandedPct: mean((r) => r.bandedPct), comps: Math.round(mean((r) => r.comps)), maxBlobPct: mean((r) => r.maxBlobPct) }));
console.log(t1(kor));

// TABLE 2 — relief & roughness spectrum
console.log("\nTABLE 2 — relief + roughness (meters; md = median |dev|, robust vs RMS)");
console.log("seed        | relief rowRel50 | r100raw p50  p90 | r100detr p50  p90 |   R3   R9  md3  md9 | E5-15 E15-45 E45-135 | floor p50  p90   fR3  fmd3 |  rim p50  p90");
const t2 = (r: SeedStats) =>
  `${r.seed.padEnd(11)} | ${f(r.relief, 0).padStart(6)}   ${f(r.rowRelief, 0).padStart(5)}  |      ${f(r.r100raw50, 1).padStart(5)} ${f(r.r100raw90, 1).padStart(5)} |     ${f(r.r100detr50, 1).padStart(6)} ${f(r.r100detr90, 1).padStart(5)} | ${f(r.R3).padStart(4)} ${f(r.R9).padStart(4)} ${f(r.md3).padStart(4)} ${f(r.md9).padStart(4)} | ${f(r.E515).padStart(5)} ${f(r.E1545).padStart(6)} ${f(r.E45135).padStart(7)} |     ${f(r.floorP50).padStart(5)} ${f(r.floorP90).padStart(4)} ${f(r.floorR3).padStart(5)} ${f(r.floorMd3).padStart(5)} |     ${f(r.rimP50).padStart(5)} ${f(r.rimP90).padStart(4)}`;
for (const r of rows) console.log(t2(r));
console.log(t2({ ...rows[0], seed: "MEAN", relief: mean((r) => r.relief), rowRelief: mean((r) => r.rowRelief), r100raw50: mean((r) => r.r100raw50), r100raw90: mean((r) => r.r100raw90), r100detr50: mean((r) => r.r100detr50), r100detr90: mean((r) => r.r100detr90), R3: mean((r) => r.R3), R9: mean((r) => r.R9), md3: mean((r) => r.md3), md9: mean((r) => r.md9), E515: mean((r) => r.E515), E1545: mean((r) => r.E1545), E45135: mean((r) => r.E45135), floorP50: mean((r) => r.floorP50), floorP90: mean((r) => r.floorP90), floorR3: mean((r) => r.floorR3), floorMd3: mean((r) => r.floorMd3), rimP50: mean((r) => r.rimP50), rimP90: mean((r) => r.rimP90) }));
console.log(t2(kor));

// TABLE 3 — cross-valley section shape
console.log("\nTABLE 3 — mean WALL slope by distance from centerline (100 m bins; section shape)");
const bins = meanArr((r) => r.distBins.map((v) => (Number.isFinite(v) ? v : 0)));
const labels = Array.from({ length: 13 }, (_, b) => (b === 12 ? "1200+" : `${b * 100}-${b * 100 + 100}`));
console.log("dist m      | " + labels.map((l) => l.padStart(9)).join(""));
console.log("MEAN slope  | " + bins.map((v) => f(v).padStart(9)).join(""));
console.log("korengal    | " + kor.distBins.map((v) => f(v).padStart(9)).join(""));

// ORACLE reference block
console.log(`
ORACLE (real Korengal, CONTEXT.md): sustained 30–45° walls ⇒ WALL p25–p75 should sit in/around
[0.58, 1.0] and band30-45% should be the DOMINANT wall class; cliff bands + scree chutes ⇒ a real
>1.0 fraction organized in CONTIGUOUS bands (banded% high), not speckle; 100 m window on a 35°
wall ≈ 70 m raw relief; within-wall texture (cliff steps, chutes, outcrop) ⇒ plane-detrended
100 m relief ~10–30 m, NOT ~fbm-amp; relief/width: 1200–1800 m over 2000–3000 m horizontal
(gradient 0.4–0.9 rim-to-river; sim half-width is 1280 m).`);

// RENDER-SIDE visibility math
console.log("\nRENDER MATH — what relief wavelength is even visible on screen");
console.log("u_detailGain = clamp((ppm-1.0)/2, 0, 1)  (terrain-gl.ts:696); default camera ppm 0.4 (WorldView.tsx:104)");
console.log("ppm   px/5m-cell  detailGain |  px per wavelength:   15m    25m    35m    70m   100m   200m");
for (const ppm of [0.4, 0.7, 1.0, 1.5, 2.0, 3.0]) {
  const gain = Math.max(0, Math.min(1, (ppm - 1.0) / 2));
  const px = (w: number) => (w * ppm).toFixed(1).padStart(6);
  console.log(`${ppm.toFixed(1)}   ${(5 * ppm).toFixed(1).padStart(6)}      ${gain.toFixed(2)}    |                      ${px(15)} ${px(25)} ${px(35)} ${px(70)} ${px(100)} ${px(200)}`);
}
console.log(`A hillshade undulation needs ≳6 px per full wavelength (a resolvable light/dark pair) —
at the default ppm 0.4 that is λ ≥ 15 m: every wavelength the FIELD carries at 15 m+ renders fine
at play zoom (normals are 5 m forward differences of the same field, shaders.ts:48). u_detailGain
only gates the sub-cell MATERIAL tooth, which at 2 px/cell could not resolve anyway.`);

// Transect CSV (seed korengal) + per-transect shape summary
if (START === 0) {
  const t = createWorld("korengal", 120).terrain;
  const size = t.size, cs = t.cellSize;
  const lines = ["transect,y_m,x_m,elev_m"];
  console.log("\nTRANSECT SHAPE (korengal) — floor flat-run + wall reversal density (3 m hysteresis)");
  console.log("a smooth monotone power wall reverses ~0×/km; benched/cliff-banded rock reverses often");
  console.log("row   | floorFlat m | west: span m  rev/km  | east: span m  rev/km");
  // count 3 m-hysteresis elevation reversals along a run of cells
  const reversals = (xs: number[], y: number) => {
    if (!xs.length) return 0;
    let dir = 0, rev = 0;
    let mn = t.elev[y * size + xs[0]], mx = mn, ext = mn;
    for (const x of xs) {
      const e = t.elev[y * size + x];
      if (dir === 0) {
        if (e < mn) mn = e;
        if (e > mx) mx = e;
        if (e - mn >= 3) { dir = 1; ext = e; }
        else if (mx - e >= 3) { dir = -1; ext = e; }
        continue;
      }
      if (dir === 1) { if (e > ext) ext = e; else if (ext - e >= 3) { rev++; dir = -1; ext = e; } }
      else { if (e < ext) ext = e; else if (e - ext >= 3) { rev++; dir = 1; ext = e; } }
    }
    return rev;
  };
  for (const y of [128, 256, 384]) {
    for (let x = 0; x < size; x++) lines.push(`y${y},${y * cs},${x * cs},${t.elev[y * size + x].toFixed(2)}`);
    const cx = Math.round(t.centerXAt(y));
    // floor flat run: contiguous |cell-to-cell dz| < 0.5 m, measured from the BANKS outward
    // (start at cx±4 — outside the 2 m channel dip, which is not the plate)
    let w0 = cx - 4, w1 = cx + 4;
    while (w0 > 1 && Math.abs(t.elev[y * size + w0] - t.elev[y * size + w0 - 1]) < 0.5) w0--;
    while (w1 < size - 2 && Math.abs(t.elev[y * size + w1 + 1] - t.elev[y * size + w1]) < 0.5) w1++;
    const west = Array.from({ length: Math.max(0, cx - WALL_DX - MARGIN) }, (_, i) => MARGIN + i);
    const east = Array.from({ length: Math.max(0, size - MARGIN - (cx + WALL_DX + 1)) }, (_, i) => cx + WALL_DX + 1 + i);
    const wKm = (west.length * cs) / 1000, eKm = (east.length * cs) / 1000;
    console.log(
      `y=${String(y).padEnd(3)} |   ${String(Math.round((w1 - w0 + 1) * cs)).padStart(5)}     |       ${String(Math.round(west.length * cs)).padStart(5)}   ${f(reversals(west, y) / wKm, 1).padStart(5)}  |       ${String(Math.round(east.length * cs)).padStart(5)}   ${f(reversals(east, y) / eKm, 1).padStart(5)}`,
    );
  }
  mkdirSync(dirname(CSV_PATH), { recursive: true });
  writeFileSync(CSV_PATH, lines.join("\n") + "\n");
  console.log(`transects (korengal, rows y=128/256/384) → ${CSV_PATH}`);
}
