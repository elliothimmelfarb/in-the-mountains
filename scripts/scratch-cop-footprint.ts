/**
 * scratch-cop-footprint — pin the COP-interior crowding mechanism the owner reported
 * ("soldiers stuck on buildings in the COP, too close together") with hard geometry.
 *
 * For each seed it dumps the FINAL stamped COP building footprints and reports:
 *   - every pair of SOLID buildings whose footprints overlap or touch (gap < MIN_GAP cells),
 *     so we know if the negative minGap copinterior reports is solid-on-solid (a real stuck
 *     hazard) or just the passable motorpool clipping a solid (cosmetic).
 *   - per SOLID building: its walkable APRON — the fraction of the cell ring one cell outside
 *     its footprint that is actually passable (not another building, wall, cliff). A man posted
 *     at the building needs an apron to stand/path on; a thin apron is where men brush + pile.
 *   - the yard packing: total solid footprint area vs the R-3 yard area (how jammed it is).
 *
 * Run: npx tsx scripts/scratch-cop-footprint.ts [seeds...]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["valley-2533", "survey-44", "survey-9", "survey-13", "survey-17", "korengal"];

const MIN_GAP = 2; // cells — spaceCopBuildings' target (>=10 m street)

function gap(a: any, b: any): number {
  return Math.max(Math.abs(a.cx - b.cx) - (a.hw + b.hw), Math.abs(a.cy - b.cy) - (a.hh + b.hh));
}

for (const seed of SEEDS) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { console.log(seed, "(gen failed)"); continue; }
  const t = w.terrain;
  const cop = t.cop;
  const R = cop.radius;
  const bs = cop.buildings as any[];
  const solids = bs.filter((b) => b.kind !== "motorpool");

  console.log(`\n===== ${seed}  R=${R}c (${R * 5}m)  ${bs.length} buildings (${solids.length} solid) =====`);

  // 1) Overlapping pairs — classify solid-solid vs motorpool-involved.
  let solidSolid = 0, mpInvolved = 0;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const g = gap(bs[i], bs[j]);
      if (g >= MIN_GAP) continue;
      const isMp = bs[i].kind === "motorpool" || bs[j].kind === "motorpool";
      if (isMp) mpInvolved++; else solidSolid++;
      console.log(
        `  ${g < 0 ? "OVERLAP" : "tight  "} gap=${g.toFixed(0)}c  ${bs[i].label.padEnd(11)} <-> ${bs[j].label.padEnd(11)}` +
        `${isMp ? "  (motorpool: passable, cosmetic)" : "  *** SOLID-SOLID ***"}`
      );
    }

  // 2) Per-solid-building apron: ring one cell outside the footprint; fraction passable.
  console.log("  apron (passable ring just outside each solid footprint):");
  for (const b of solids) {
    let ring = 0, open = 0;
    const x0 = b.cx - b.hw - 1, x1 = b.cx + b.hw + 1, y0 = b.cy - b.hh - 1, y1 = b.cy + b.hh + 1;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const onRing = x === x0 || x === x1 || y === y0 || y === y1;
        if (!onRing) continue;
        ring++;
        if (t.inBounds?.(x, y) === false) continue;
        if (t.passableCell(x, y)) open++;
      }
    const frac = ring ? Math.round((100 * open) / ring) : 0;
    console.log(`    ${b.label.padEnd(12)} hw×hh=${b.hw}×${b.hh}  apron ${String(frac).padStart(3)}% passable  (${open}/${ring})`);
  }

  // 3) Packing: solid footprint area vs the R-3 yard.
  let area = 0;
  for (const b of solids) area += (2 * b.hw + 1) * (2 * b.hh + 1);
  const yard = Math.PI * (R - 3) * (R - 3);
  console.log(`  packing: solid footprint ${area}c² vs R-3 yard ${yard.toFixed(0)}c²  = ${Math.round((100 * area) / yard)}% covered`);
  console.log(`  summary: solid-solid overlaps=${solidSolid}  motorpool-involved=${mpInvolved}`);
}
