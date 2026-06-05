/**
 * FAST static structural audit of the valley — no sim, just terrain generation +
 * BFS + the real findPath. Runs across many seeds in seconds, so it sweeps for the
 * STRUCTURAL causes of stranded soldiers before we ever pay for a continuous-sim run:
 *
 *   bankCliff%  : of all cells ADJACENT to a river cell, the fraction that are
 *                 impassable (cliff/steep/wall). High = the river runs in an incised
 *                 channel walled by cliffs — a squad that descends to the water at a
 *                 non-crossing point can be unable to climb the far (or near) bank.
 *   riverTraps  : passable river cells whose ONLY passable neighbours are also river
 *                 — a man who steps in there can wade but never climb out except back
 *                 the way he came. The literal "stuck in the river" cell.
 *   crossings   : Footbridge + Ford cells (the legitimate ways across the channel).
 *   maxGapM     : the longest stretch of river (m, along the valley) with NO crossing
 *                 — how far a squad might have to detour to find a way over.
 *   banksSplit  : YES if the east and west banks are in DIFFERENT 8-connected passable
 *                 components (i.e. you genuinely cannot walk from one side to the other)
 *                 — the hard "can't cross" failure.
 *   vilUnreach  : villages with no passable cell within ARRIVE m reachable from the gate.
 *   nullRoutes  : villages findPath can't return a real route to (ends > ARRIVE short).
 *   farUnreach  : of FAR sampled objectives (random reachable-looking cells), how many
 *                 the router gives up short on.
 *
 * Run: npx tsx scripts/terrain-audit.ts [N]      (N seeds, default a documented set)
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath } from "../lib/sim/path";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;
const ARRIVE = 50;
const REACH_CELLS = Math.ceil(ARRIVE / cs);

function isRiver(t: any, x: number, y: number): boolean {
  return (t.land[t.idx(x, y)] as number) === Land.River;
}
function isCrossing(t: any, x: number, y: number): boolean {
  const l = t.land[t.idx(x, y)] as number;
  return l === Land.Footbridge || l === (Land as any).Ford;
}

/** 8-connected passable flood from a cell; returns component id array (-1 = impassable). */
function components(t: any): { comp: Int32Array; count: number } {
  const size = t.size;
  const comp = new Int32Array(size * size).fill(-1);
  let count = 0;
  for (let s = 0; s < size * size; s++) {
    const sx = s % size, sy = (s / size) | 0;
    if (comp[s] !== -1 || !t.passableCell(sx, sy)) continue;
    const id = count++;
    comp[s] = id;
    const st = [s];
    while (st.length) {
      const i = st.pop()!;
      const x = i % size, y = (i / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (comp[j] !== -1 || !t.passableCell(nx, ny)) continue;
          comp[j] = id;
          st.push(j);
        }
    }
  }
  return { comp, count };
}

function floodFromGate(t: any): Uint8Array {
  const size = t.size;
  const seen = new Uint8Array(size * size);
  const g = t.cop.gateOutside;
  const s = t.nearestPassable(g.cx, g.cy, 12);
  if (!t.passableCell(s.cx, s.cy)) return seen;
  seen[s.cy * size + s.cx] = 1;
  const st = [s.cy * size + s.cx];
  while (st.length) {
    const i = st.pop()!;
    const x = i % size, y = (i / size) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (seen[j] || !t.passableCell(nx, ny)) continue;
        seen[j] = 1;
        st.push(j);
      }
  }
  return seen;
}
function reachWithin(t: any, seen: Uint8Array, vx: number, vy: number): boolean {
  for (let dy = -REACH_CELLS; dy <= REACH_CELLS; dy++)
    for (let dx = -REACH_CELLS; dx <= REACH_CELLS; dx++) {
      const nx = vx + dx, ny = vy + dy;
      if (nx < 0 || ny < 0 || nx >= t.size || ny >= t.size) continue;
      if (seen[ny * t.size + nx]) return true;
    }
  return false;
}

console.log(
  "seed".padEnd(12),
  "bankCliff%".padStart(10),
  "riverTrap".padStart(9),
  "cross".padStart(6),
  "maxGapM".padStart(8),
  "banksSplit".padStart(11),
  "vilUnreach".padStart(11),
  "nullRt".padStart(7),
  "farMiss".padStart(8)
);

const G = { seeds: 0, bankAdj: 0, bankCliff: 0, trap: 0, cross: 0, split: 0, vil: 0, vilUn: 0, nullR: 0, far: 0, farMiss: 0, maxGap: 0 };

for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { continue; }
  const t = w.terrain;
  const size = t.size;

  // --- river bank cliff fraction + river traps + crossings (Ford/Footbridge anywhere) ---
  let bankAdj = 0, bankCliff = 0, trap = 0, crossCells = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (isCrossing(t, x, y)) crossCells++; // fords overwrite river→ford, so count them map-wide
      if (!isRiver(t, x, y)) continue;
      // bank cells = non-river neighbours of this river cell
      let escapes = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (isRiver(t, nx, ny)) {
            if (t.passableCell(nx, ny)) escapes++; // an in-river move still counts as walkable
            continue;
          }
          bankAdj++;
          if (!t.passableCell(nx, ny)) bankCliff++;
          else escapes++;
        }
      // a passable river cell with no passable NON-river escape is a trap candidate; only
      // count it if it's actually passable (you can be standing there)
      if (t.passableCell(x, y)) {
        let dryEscape = false;
        for (let dy = -1; dy <= 1 && !dryEscape; dy++)
          for (let dx = -1; dx <= 1 && !dryEscape; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            if (!isRiver(t, nx, ny) && t.passableCell(nx, ny)) dryEscape = true;
          }
        if (!dryEscape) trap++;
      }
      void escapes;
    }

  // --- max crossing gap along the valley (rows with river but no crossing nearby) ---
  let gap = 0, maxGap = 0;
  for (let y = 0; y < size; y++) {
    let hasRiver = false, hasCross = false;
    for (let x = 0; x < size; x++) {
      if (isRiver(t, x, y)) { hasRiver = true; if (isCrossing(t, x, y)) hasCross = true; }
    }
    if (hasRiver && !hasCross) gap++;
    else { maxGap = Math.max(maxGap, gap); gap = 0; }
  }
  maxGap = Math.max(maxGap, gap);
  const maxGapM = maxGap * cs;

  // --- are the two banks the same passable component? sample a west cell and an east cell
  //     on the valley floor at mid-valley, step off the river to dry ground each way. ---
  const { comp } = components(t);
  const midY = Math.round(size / 2);
  const cxr = Math.round(t.centerXAt(midY));
  const dryWest = firstDry(t, cxr, midY, -1);
  const dryEast = firstDry(t, cxr, midY, +1);
  const banksSplit = dryWest && dryEast ? comp[dryWest.y * size + dryWest.x] !== comp[dryEast.y * size + dryEast.x] : false;

  // --- village reachability + null routes ---
  const seen = floodFromGate(t);
  let vilUn = 0, nullR = 0;
  const gateW = w.gateOutsideWorld();
  for (const v of t.villages) {
    if (!reachWithin(t, seen, v.cx, v.cy)) vilUn++;
    const objW = t.cellCenter(v.cx, v.cy);
    const route = findPath(t, gateW, objW, { roadBias: 0.25 });
    const end = route[route.length - 1];
    if (!end || Math.hypot(end.x - objW.x, end.y - objW.y) > ARRIVE) nullR++;
  }

  // --- FAR objectives: sample reachable-looking cells far from the gate, ask the router ---
  let far = 0, farMiss = 0;
  const gx = t.cop.gateOutside.cx, gy = t.cop.gateOutside.cy;
  for (let s = 0; s < 40; s++) {
    // deterministic pseudo-spread using the seed-stable RNG-free hash of s
    const ang = (s / 40) * Math.PI * 2;
    const rad = 60 + ((s * 37) % 120); // 60..180 cells out
    const tx = Math.round(gx + Math.cos(ang) * rad);
    const ty = Math.round(gy + Math.sin(ang) * rad);
    if (tx < 2 || ty < 2 || tx >= size - 2 || ty >= size - 2) continue;
    if (!reachWithin(t, seen, tx, ty)) continue; // only score physically-reachable targets
    far++;
    const objW = t.cellCenter(tx, ty);
    const route = findPath(t, gateW, objW, { roadBias: 0.25 });
    const end = route[route.length - 1];
    if (!end || Math.hypot(end.x - objW.x, end.y - objW.y) > ARRIVE) farMiss++;
  }

  const bankCliffPct = bankAdj > 0 ? Math.round((bankCliff / bankAdj) * 100) : 0;
  G.seeds++; G.bankAdj += bankAdj; G.bankCliff += bankCliff; G.trap += trap; G.cross += crossCells;
  G.split += banksSplit ? 1 : 0; G.vil += t.villages.length; G.vilUn += vilUn; G.nullR += nullR;
  G.far += far; G.farMiss += farMiss; G.maxGap = Math.max(G.maxGap, maxGapM);

  console.log(
    seed.padEnd(12),
    `${bankCliffPct}%`.padStart(10),
    String(trap).padStart(9),
    String(crossCells).padStart(6),
    String(maxGapM).padStart(8),
    (banksSplit ? "SPLIT" : "ok").padStart(11),
    `${vilUn}/${t.villages.length}`.padStart(11),
    String(nullR).padStart(7),
    `${farMiss}/${far}`.padStart(8)
  );
}

function firstDry(t: any, cx: number, cy: number, dir: number): { x: number; y: number } | null {
  for (let s = 1; s < 60; s++) {
    const x = cx + dir * s;
    if (x < 0 || x >= t.size) return null;
    if ((t.land[t.idx(x, cy)] as number) !== Land.River && t.passableCell(x, cy)) return { x, y: cy };
  }
  return null;
}

const pct = (a: number, b: number) => `${a}/${b} (${Math.round((a / Math.max(1, b)) * 100)}%)`;
console.log("-".repeat(96));
console.log("seeds audited:", G.seeds);
console.log("  river bank-cliff fraction:   ", `${Math.round((G.bankCliff / Math.max(1, G.bankAdj)) * 100)}%`, " ← high = incised channel walled by cliffs");
console.log("  river TRAP cells (total):    ", G.trap, " ← passable river cells with no dry escape (stuck-in-river)");
console.log("  crossing cells (total):      ", G.cross);
console.log("  worst crossing gap:          ", G.maxGap, "m");
console.log("  seeds with banks SPLIT:      ", pct(G.split, G.seeds), " ← genuinely can't walk across the valley");
console.log("  villages UNREACHABLE (BFS):  ", pct(G.vilUn, G.vil));
console.log("  router NULL routes to vil:   ", pct(G.nullR, G.vil));
console.log("  FAR reachable objectives missed by router:", pct(G.farMiss, G.far), " ← router gives up on physically-reachable far points");
