/**
 * COP generation audit — one harness that turns every documented generation issue
 * (docs/issues/001..005) plus the villager-into-the-wire bug into hard numbers,
 * across a seed sweep, headless, in a couple of seconds.
 *
 * Columns (per seed):
 *   egress    issue 001 — is gateOutside on a passable cell? (PASS/BLOCK)
 *   ring%     issue 001 — fraction of the 360° around the wall with a passable cell
 *             in the R+1..R+5 perimeter-track band (a true "ring road" is ~100%)
 *   gate→vil  issue 002 — angle (deg) between the gate axis and the bearing to the
 *             NEAREST village (smaller is more realistic; >90° = gate faces away)
 *   portal    issue 005 — does findPath(muster → gateOutside) return a real coarse
 *             route (not the straight-line fallback)? (Y/N)
 *   open%     issue 003/004 — interior passable, non-structure fraction
 *   solid?    issue 004 — are interior Structure cells impassable? (Y once fixed)
 *   vilGap    village/COP separation — meters between the COP wire (radius R) and the
 *             NEAREST village footprint (radius v.size). NEGATIVE = the footprints
 *             overlap: a village intersects the outpost (must be impossible).
 *   vil∩      direct cross-check — count of village-CORE cells (Compound / CompoundWall
 *             / Cemetery) sitting inside the COP wire + clearance band. Must be 0.
 *   wireHits  villager bug — over a short civilian-only sim, the number of
 *             civilian-ticks spent wall-blocked against the HESCO (blockedTimer>0
 *             while adjacent to a Hesco cell). Should be ~0.
 *
 * Run: npx tsx scripts/copaudit.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath } from "../lib/sim/path";

const SEEDS = process.argv[2]
  ? Array.from({ length: Number(process.argv[2]) }, (_, i) => "survey-" + i)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "delta-5", "bravo-2"];

const cs = 5;

function adjHesco(t: any, cx: number, cy: number): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (t.inBounds(x, y) && (t.land[t.idx(x, y)] as Land) === Land.Hesco) return true;
    }
  return false;
}

console.log(
  "seed".padEnd(12),
  "egress".padStart(7),
  "ring%".padStart(6),
  "gate→vil".padStart(9),
  "portal".padStart(7),
  "open%".padStart(6),
  "solid?".padStart(7),
  "vilGap".padStart(7),
  "vil∩".padStart(5),
  "wireHits".padStart(9)
);

let egressBlocked = 0;
let ringSum = 0;
let gateAwaySum = 0;
let portalFail = 0;
let wireSum = 0;
let overlapSeeds = 0; // seeds where a village footprint overlaps the COP wire
let coreHitSeeds = 0; // seeds with village-core cells inside the COP clearance band

for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    continue;
  }
  const t = w.terrain;
  const cop = t.cop;
  const R = cop.radius;

  // --- 001: gate egress passability ---
  const egress = t.passableCell(cop.gateOutside.cx, cop.gateOutside.cy);
  if (!egress) egressBlocked++;

  // --- 001: perimeter-ring continuity (R+1..R+5 band) ---
  let open = 0;
  const STEPS = 180;
  for (let k = 0; k < STEPS; k++) {
    const a = (k / STEPS) * Math.PI * 2;
    let any = false;
    for (let band = 1; band <= 5 && !any; band++) {
      const x = Math.round(cop.center.cx + Math.cos(a) * (R + band));
      const y = Math.round(cop.center.cy + Math.sin(a) * (R + band));
      if (t.inBounds(x, y) && t.passableCell(x, y)) any = true;
    }
    if (any) open++;
  }
  const ringPct = Math.round((open / STEPS) * 100);
  ringSum += ringPct;

  // --- village/COP footprint separation (the "village intersects the COP" bug) ---
  // Geometric gap (meters) between the COP wire edge (radius R) and the nearest
  // village footprint edge (radius v.size). Negative => overlap.
  let minGapCells = Infinity;
  for (const v of t.villages) {
    const d = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy);
    const gap = d - R - v.size;
    if (gap < minGapCells) minGapCells = gap;
  }
  const vilGapM = t.villages.length ? Math.round(minGapCells * cs) : 0;
  if (t.villages.length && minGapCells < 0) overlapSeeds++;
  // Direct cross-check: any village-core cell (Compound/Wall/Cemetery) inside the
  // wire + a clearance band is a real, rendered intersection — independent of the
  // geometric gap (catches asymmetric footprints the radius model misses).
  const CLEAR = 6;
  let coreHits = 0;
  const Rb = R + CLEAR;
  for (let dy = -Rb; dy <= Rb; dy++)
    for (let dx = -Rb; dx <= Rb; dx++) {
      if (Math.hypot(dx, dy) > Rb) continue;
      const x = cop.center.cx + dx;
      const y = cop.center.cy + dy;
      if (!t.inBounds(x, y)) continue;
      const l = t.land[t.idx(x, y)] as Land;
      if (l === Land.Compound || l === Land.CompoundWall || l === Land.Cemetery) coreHits++;
    }
  if (coreHits > 0) coreHitSeeds++;

  // --- 002: gate bearing vs nearest village ---
  const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  let nearest: any = null;
  let nd = Infinity;
  for (const v of t.villages) {
    const d = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy);
    if (d < nd) {
      nd = d;
      nearest = v;
    }
  }
  let gateVilDeg = 0;
  if (nearest) {
    const bear = Math.atan2(nearest.cy - cop.center.cy, nearest.cx - cop.center.cx);
    let diff = Math.abs(bear - gateAng);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    gateVilDeg = Math.round((diff * 180) / Math.PI);
  }
  if (gateVilDeg > 90) gateAwaySum++;

  // --- 005: gate coarse-portal connectivity ---
  // Probe a point OUTSIDE the wire on the far side from the gate, so the route is
  // forced through/around the gate (not a colinear straight shot). The fallback
  // (coarse route null) is a single straight waypoint that is NOT walkable straight
  // because the wire is in the way — that's a genuine coarse disconnection.
  const muster = t.cellCenter(cop.muster.cx, cop.muster.cy);
  const far = t.nearestPassable(
    Math.round(cop.center.cx - cop.gateDir.x * (R + 8)),
    Math.round(cop.center.cy - cop.gateDir.y * (R + 8)),
    10
  );
  const farW = t.cellCenter(far.cx, far.cy);
  const path = findPath(t, muster, farW);
  const last = path[path.length - 1];
  const reachedFar = Math.hypot(last.x - farW.x, last.y - farW.y) < cs * 3;
  const realPortal = path.length > 1 && reachedFar;
  if (!realPortal) portalFail++;

  // --- 003/004: interior open fraction & structure solidity ---
  let interior = 0;
  let interiorOpen = 0;
  let structCells = 0;
  let structImpassable = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (Math.hypot(dx, dy) > R - 2.6) continue;
      const x = cop.center.cx + dx;
      const y = cop.center.cy + dy;
      if (!t.inBounds(x, y)) continue;
      const l = t.land[t.idx(x, y)] as Land;
      interior++;
      if (l !== Land.Structure && t.passableCell(x, y)) interiorOpen++;
      if (l === Land.Structure) {
        structCells++;
        if (!t.passableCell(x, y)) structImpassable++;
      }
    }
  const openPct = Math.round((interiorOpen / Math.max(1, interior)) * 100);
  const solid = structCells > 0 && structImpassable === structCells ? "Y" : structCells === 0 ? "-" : "N";

  // --- villager-into-the-wire: sim only the civilians, count wall-blocked ticks at the HESCO ---
  let wireHits = 0;
  const civIds: string[] = w.sim.units.filter((u: any) => u.faction === "civilian").map((u: any) => u.id);
  for (let k = 0; k < 3000; k++) {
    w.tick(0.1);
    for (const id of civIds) {
      const u = w.sim.unit(id);
      if (!u || !u.alive) continue;
      const cx = Math.floor(u.pos.x / cs);
      const cy = Math.floor(u.pos.y / cs);
      if ((u.blockedTimer ?? 0) > 0 && adjHesco(t, cx, cy)) wireHits++;
    }
  }
  wireSum += wireHits;

  console.log(
    seed.padEnd(12),
    (egress ? "PASS" : "BLOCK").padStart(7),
    String(ringPct).padStart(6),
    String(gateVilDeg + "°").padStart(9),
    (realPortal ? "Y" : "N").padStart(7),
    String(openPct).padStart(6),
    solid.padStart(7),
    String(vilGapM + "m").padStart(7),
    String(coreHits).padStart(5),
    String(wireHits).padStart(9)
  );
}

const n = SEEDS.length;
console.log("\nsummary over", n, "seeds:");
console.log("  egress blocked:   ", egressBlocked, "/", n, "(issue 001)");
console.log("  avg perimeter ring open%:", Math.round(ringSum / n), "(issue 001)");
console.log("  gate faces >90° from nearest village:", gateAwaySum, "/", n, "(issue 002)");
console.log("  gate portal disconnected:", portalFail, "/", n, "(issue 005)");
console.log("  village/COP footprint OVERLAP:", overlapSeeds, "/", n, "(item: village intersects COP — must be 0)");
console.log("  seeds with village-core cells in COP clearance:", coreHitSeeds, "/", n, "(must be 0)");
console.log("  total civilian wire-pin ticks:", wireSum, "(villager bug)");
