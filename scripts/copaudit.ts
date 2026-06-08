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
 * A second DEFENSE AUDIT table turns the COP's fitness as a STRONGPOINT (ATP 3-21.8 ch.5)
 * into numbers — the dimensions the 2026-06-08 sectors-of-fire pass left on the table:
 *   gateOW    is the ECP gate approach covered by a fighting position's sector AND in its
 *             LOS? (Y) — doctrine: the entry control point must be overwatched by fire.
 *   secGap°   the largest perimeter azimuth arc covered by NO fighting position's sector
 *             (sweeping the wire) — an un-grazed avenue. interlocking fires want this ~0.
 *   mortFPF   can the mortar (from cop.mortarPit) actually range cop.fpf? (Y) — the 60mm
 *             min range is 70 m but the wire is only ~60 m, so a too-close FPF is unfirable.
 *   asltCov%  fraction of the just-outside-the-wire assault band within mortar range of the
 *             pit (so the watch's FPF can land wherever fighters mass). Want ~100%.
 *   hvtSep    min separation (m) between the TOC, the armory (ammo) and the aid station — a
 *             single 82 mm round (~24 m frag) shouldn't gut command + ammo + casualty care.
 *   mgSpread  angular separation (deg) of the M2 and M240 — heavies on the same avenue are
 *             redundant and leave the opposite frontage thin. Want them genuinely spread.
 *
 * Run: npx tsx scripts/copaudit.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { findPath, walkable } from "../lib/sim/path";
import { getWeapon } from "../lib/sim/weapons";
import { hasLOS } from "../lib/sim/los";

const TWO_PI = Math.PI * 2;
/** Is bearing `a` inside the arc swept CCW from `lo` to `hi` (wrap-aware)? */
function inArc(a: number, lo: number, hi: number): boolean {
  const norm = (x: number) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
  return norm(a - lo) <= norm(hi - lo);
}

/** The DEFENSE AUDIT — the COP as a strongpoint (ATP 3-21.8). Pure geometry + LOS over the seed. */
function defenseAudit(t: any, cop: any) {
  const cc = t.cellCenter(cop.center.cx, cop.center.cy);
  const fps = cop.fightingPositions;
  const wireM = cop.radius * cs;

  // A) gate overwatch — some FP's sector contains the gate approach AND it has LOS to it
  const goW = t.cellCenter(cop.gateOutside.cx, cop.gateOutside.cy);
  let gateOW = false;
  for (const f of fps) {
    const fpW = t.cellCenter(f.cx, f.cy);
    const bear = Math.atan2(goW.y - fpW.y, goW.x - fpW.x);
    if (inArc(bear, f.rightLimit, f.leftLimit) && hasLOS(t, fpW, goW)) { gateOW = true; break; }
  }

  // B) perimeter interlock — for each azimuth, is a point just outside the wire inside ANY
  //    fighting position's sector? Report the largest contiguous uncovered arc (deg).
  const N = 180;
  const covered: boolean[] = new Array(N).fill(false);
  for (let k = 0; k < N; k++) {
    const A = (k / N) * TWO_PI;
    const px = cc.x + Math.cos(A) * (wireM + 10);
    const py = cc.y + Math.sin(A) * (wireM + 10);
    for (const f of fps) {
      const fpW = t.cellCenter(f.cx, f.cy);
      const bear = Math.atan2(py - fpW.y, px - fpW.x);
      if (inArc(bear, f.rightLimit, f.leftLimit)) { covered[k] = true; break; }
    }
  }
  let maxRun = 0, run = 0;
  for (let k = 0; k < N * 2; k++) {
    if (!covered[k % N]) { run++; if (run > maxRun) maxRun = run; } else run = 0;
  }
  const secGapDeg = Math.round(Math.min(maxRun, N) * (360 / N));
  const secCovPct = Math.round((covered.filter(Boolean).length / N) * 100);

  // C) mortar can range the FPF, and what fraction of the assault band it can reach
  const pitW = t.cellCenter(cop.mortarPit.cx, cop.mortarPit.cy);
  const fpfW = t.cellCenter(cop.fpf.cx, cop.fpf.cy);
  const m = getWeapon("mortar60");
  const minR = m.minRange ?? 70, maxR = m.maxRange;
  const fpfDist = Math.hypot(fpfW.x - pitW.x, fpfW.y - pitW.y);
  const fpfRangeable = fpfDist >= minR && fpfDist <= maxR;
  let bandIn = 0;
  const BAND = 36;
  for (let k = 0; k < BAND; k++) {
    const A = (k / BAND) * TWO_PI;
    const bx = cc.x + Math.cos(A) * (wireM + 25);
    const by = cc.y + Math.sin(A) * (wireM + 25);
    const d = Math.hypot(bx - pitW.x, by - pitW.y);
    if (d >= minR && d <= maxR) bandIn++;
  }
  const assaultCovPct = Math.round((bandIn / BAND) * 100);

  // D) HVT blast separation — min pairwise distance among TOC / armory / aid
  const hvt = ["toc", "armory", "aid"].map((k) => cop.buildings.find((b: any) => b.kind === k)).filter(Boolean);
  let hvtSep = Infinity;
  for (let i = 0; i < hvt.length; i++)
    for (let j = i + 1; j < hvt.length; j++) {
      const a = t.cellCenter(hvt[i].cx, hvt[i].cy), b = t.cellCenter(hvt[j].cx, hvt[j].cy);
      hvtSep = Math.min(hvtSep, Math.hypot(a.x - b.x, a.y - b.y));
    }
  hvtSep = isFinite(hvtSep) ? Math.round(hvtSep) : 0;

  // E) heavy-gun spread — angular separation of the M2 and M240 facings (deg)
  const m2 = fps.find((f: any) => f.weapon === "m2");
  const m240 = fps.find((f: any) => f.weapon === "m240");
  let mgSpread = 0;
  if (m2 && m240) {
    let d = Math.abs(m2.facing - m240.facing);
    if (d > Math.PI) d = TWO_PI - d;
    mgSpread = Math.round((d * 180) / Math.PI);
  }

  // F) threat-avenue coverage — is the bearing to the NEAREST village (the most likely enemy
  //    avenue of approach) held by a CREW-SERVED weapon's sector? The siting picks avenues by
  //    terrain alone, ignoring where the enemy actually comes from — so the .50 can face the
  //    empty valley while the threat walks in from the qalats on a sector held by one rifleman.
  let nearest: any = null, nd = Infinity;
  for (const v of t.villages) {
    const d = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy);
    if (d < nd) { nd = d; nearest = v; }
  }
  let threatWeapon = "none";
  if (nearest) {
    const vW = t.cellCenter(nearest.cx, nearest.cy);
    let best: any = null;
    for (const f of fps) {
      const fpW = t.cellCenter(f.cx, f.cy);
      const bear = Math.atan2(vW.y - fpW.y, vW.x - fpW.x);
      if (inArc(bear, f.rightLimit, f.leftLimit)) {
        // prefer a crew-served covering weapon if more than one sector contains the bearing
        const rank = (w: string) => (w === "m2" ? 3 : w === "m240" ? 2 : w === "mk19" ? 1 : 0);
        if (!best || rank(f.weapon) > rank(best.weapon)) best = f;
      }
    }
    threatWeapon = best ? best.weapon : "none";
  }
  const threatCovered = threatWeapon === "m2" || threatWeapon === "m240" || threatWeapon === "mk19";

  return { gateOW, secGapDeg, secCovPct, fpfRangeable, fpfDist: Math.round(fpfDist), assaultCovPct, hvtSep, mgSpread, threatWeapon, threatCovered };
}

// issue 012 — interior connectivity. seatReach: can the planner the garrison uses (findPath) actually
// reach every building seat / fighting position from the muster? (Rejecting findPath's degenerate
// straight-into-the-wall fallback, which otherwise reads a sealed-off post as "reachable".) pockets:
// passable interior cells unreachable from the gate (man-traps). Both MUST be 0.
function interiorReach(t: any, cop: any): { seatBad: number; fpBad: number; pockets: number } {
  const muW = t.cellCenter(cop.muster.cx, cop.muster.cy);
  const arrives = (p: any) => {
    const r = findPath(t, muW, p);
    const e = r[r.length - 1];
    if (!e || Math.hypot(e.x - p.x, e.y - p.y) >= cs * 2) return false;
    return r.length > 1 || walkable(t, muW, p);
  };
  let seatBad = 0;
  for (const b of cop.buildings) if (b.kind !== "motorpool" && !arrives(t.buildingSeat(b))) seatBad++;
  let fpBad = 0;
  for (const f of cop.fightingPositions) if (!arrives(t.cellCenter(f.cx, f.cy))) fpBad++;
  const reach = t.reachableFromGate();
  const R = cop.radius;
  let pockets = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (Math.hypot(dx, dy) > R - 1) continue;
      const x = cop.center.cx + dx;
      const y = cop.center.cy + dy;
      if (t.inBounds(x, y) && t.passableCell(x, y) && !reach[t.idx(x, y)]) pockets++;
    }
  return { seatBad, fpBad, pockets };
}

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
  "seatBad".padStart(8),
  "pockets".padStart(8),
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
let interiorBadSeeds = 0; // issue 012 — seeds with an unreachable post or a sealed interior pocket
const defRows: Array<{ seed: string } & ReturnType<typeof defenseAudit>> = [];

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

  // --- 011: interior connectivity. The HARD invariant is that every garrison post (building seat +
  // fighting position) is reachable from the muster — that is the "stuck on a building" bug. `pockets`
  // is a secondary diagnostic: a tiny unreachable sliver behind a building is harmless (no path leads
  // INTO it), so it is reported but does not fail the seed.
  const ic = interiorReach(t, cop);
  if (ic.seatBad > 0 || ic.fpBad > 0) interiorBadSeeds++;

  defRows.push({ seed, ...defenseAudit(t, cop) });

  console.log(
    seed.padEnd(12),
    (egress ? "PASS" : "BLOCK").padStart(7),
    String(ringPct).padStart(6),
    String(gateVilDeg + "°").padStart(9),
    (realPortal ? "Y" : "N").padStart(7),
    String(openPct).padStart(6),
    solid.padStart(7),
    String(ic.seatBad + ic.fpBad).padStart(8),
    String(ic.pockets).padStart(8),
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
console.log("  seeds with an unreachable garrison post:", interiorBadSeeds, "/", n, "(issue 012 — must be 0)");

// ---------------------------------------------------------------------------------------------
// DEFENSE AUDIT — the COP as a strongpoint (ATP 3-21.8). Thresholds: gateOW=Y, secGap≤25°,
// mortFPF=Y, asltCov≥90%, hvtSep≥24 m (82 mm frag), mgSpread≥45°.
console.log("\nDEFENSE AUDIT — the COP as a strongpoint (ATP 3-21.8):");
console.log(
  "seed".padEnd(12),
  "gateOW".padStart(7),
  "secGap°".padStart(8),
  "secCov%".padStart(8),
  "mortFPF".padStart(8),
  "fpfDist".padStart(8),
  "asltCov%".padStart(9),
  "hvtSep".padStart(7),
  "mgSpread".padStart(9),
  "threat".padStart(7)
);
let gateOWbad = 0, secGapBad = 0, mortBad = 0, asltSum = 0, hvtBad = 0, mgBad = 0, secGapSum = 0, hvtSum = 0, mgSum = 0, threatBad = 0;
for (const r of defRows) {
  if (!r.gateOW) gateOWbad++;
  if (r.secGapDeg > 25) secGapBad++;
  if (!r.fpfRangeable) mortBad++;
  if (r.hvtSep < 30) hvtBad++;
  if (r.mgSpread < 45) mgBad++;
  if (!r.threatCovered) threatBad++;
  asltSum += r.assaultCovPct;
  secGapSum += r.secGapDeg;
  hvtSum += r.hvtSep;
  mgSum += r.mgSpread;
  console.log(
    r.seed.padEnd(12),
    (r.gateOW ? "Y" : "no").padStart(7),
    String(r.secGapDeg + "°").padStart(8),
    String(r.secCovPct).padStart(8),
    (r.fpfRangeable ? "Y" : "NO").padStart(8),
    String(r.fpfDist + "m").padStart(8),
    String(r.assaultCovPct).padStart(9),
    String(r.hvtSep + "m").padStart(7),
    String(r.mgSpread + "°").padStart(9),
    r.threatWeapon.padStart(7)
  );
}
console.log("\ndefense summary over", n, "seeds:");
console.log("  [1] gate NOT overwatched by fire:", gateOWbad, "/", n, "(must be 0 — ATP 3-21.8 ECP overwatch)");
console.log("  [2] perimeter sector gap >25°:", secGapBad, "/", n, `(avg gap ${Math.round(secGapSum / n)}° — interlocking fires want ~0)`);
console.log("  [3] FPF NOT rangeable by the mortar:", mortBad, "/", n, `(must be 0; avg assault-band coverage ${Math.round(asltSum / n)}% — the watch requests unfirable fire)`);
console.log("  [4] HVT separation <30 m (82mm frag margin):", hvtBad, "/", n, `(avg ${Math.round(hvtSum / n)} m — disperse C2/ammo/aid)`);
console.log("  [5] threat avenue (nearest village) NOT held by a heavy gun:", threatBad, "/", n, "(weight the M2/M240/Mk19 toward the danger)");
console.log("  (diagnostic) heavy guns clustered <45° apart:", mgBad, "/", n, `(avg ${Math.round(mgSum / n)}° — already well spread)`);
