/**
 * Top-down render of a COP interior — buildings, the walkable yard, and (in RED) the
 * SEALED interior pockets: passable cells fully enclosed by building footprints that a
 * garrison man can be funneled into and never escape. The clearest picture of the
 * "stuck on buildings" bug. Also marks the muster, gate, garrison seats and fighting
 * positions, and prints pocket/grind counts in the title.
 *
 * Run: npx tsx scripts/cop-render.ts [seed] [out.png]
 */
import sharp from "sharp";
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const seed = process.argv[2] ?? "valley-2533";
const out = process.argv[3] ?? `docs/progress/2026-06-06-cop-interior/cop-${seed}.png`;

const w: any = createWorld(seed, 60);
const t = w.terrain;
const cs = t.cellSize;
const cop = t.cop;
const R = cop.radius;
const c = cop.center;

// view window: the wire + a little apron
const pad = 4;
const lo = { cx: c.cx - R - pad, cy: c.cy - R - pad };
const hi = { cx: c.cx + R + pad, cy: c.cy + R + pad };
const cols = hi.cx - lo.cx + 1;
const rows = hi.cy - lo.cy + 1;
const PX = 14; // px per cell
const M = 30;
const W = cols * PX + M * 2;
const H = rows * PX + M * 2 + 30;

const reach = t.reachableFromGate();
function isPocket(cx: number, cy: number): boolean {
  if (Math.hypot(cx - c.cx, cy - c.cy) > R - 1) return false;
  if (!t.passableCell(cx, cy)) return false;
  return !reach[t.idx(cx, cy)];
}

let pockets = 0;
const cells: string[] = [];
for (let cy = lo.cy; cy <= hi.cy; cy++)
  for (let cx = lo.cx; cx <= hi.cx; cx++) {
    if (!t.inBounds(cx, cy)) continue;
    const l = t.land[t.idx(cx, cy)] as Land;
    const px = M + (cx - lo.cx) * PX;
    const py = M + (cy - lo.cy) * PX;
    let fill = "#1c1f17"; // outside / natural
    const d = Math.hypot(cx - c.cx, cy - c.cy);
    if (l === Land.Hesco) fill = "#7a6a44";
    else if (l === Land.Structure) fill = "#4a4a4a";
    else if (l === Land.CompoundWall) fill = "#5a4a3a";
    else if (l === Land.Cliff) fill = "#101010";
    else if (l === Land.River || l === Land.Ford) fill = "#2a4a6a";
    else if (d <= R) {
      // interior ground
      const pass = t.passableCell(cx, cy);
      if (!pass) fill = "#332b22"; // impassable interior (slope etc.)
      else if (l === Land.Gravel || l === Land.Track || l === Land.Trail) fill = "#6b6450";
      else fill = "#3f4a34"; // grass yard
    } else {
      // apron outside wire
      if (l === Land.Gravel || l === Land.Track || l === Land.Trail) fill = "#46412f";
    }
    if (isPocket(cx, cy)) {
      fill = "#c0392b";
      pockets++;
    }
    cells.push(`<rect x="${px}" y="${py}" width="${PX}" height="${PX}" fill="${fill}" stroke="#0c0e08" stroke-width="0.4"/>`);
  }

// overlays
const overlays: string[] = [];
const toPx = (cx: number, cy: number) => ({ x: M + (cx - lo.cx + 0.5) * PX, y: M + (cy - lo.cy + 0.5) * PX });
// building labels
for (const b of cop.buildings) {
  const p = toPx(b.cx, b.cy);
  overlays.push(`<text x="${p.x}" y="${p.y}" fill="#d8d2c0" font-size="8" font-family="monospace" text-anchor="middle" dominant-baseline="middle">${(b.label ?? b.kind).slice(0, 8)}</text>`);
}
// muster (cyan ring)
{
  const p = toPx(cop.muster.cx, cop.muster.cy);
  overlays.push(`<circle cx="${p.x}" cy="${p.y}" r="6" fill="none" stroke="#46c7d6" stroke-width="2"/>`);
  overlays.push(`<text x="${p.x}" y="${p.y - 9}" fill="#46c7d6" font-size="8" font-family="monospace" text-anchor="middle">muster</text>`);
}
// gate (yellow)
{
  const p = toPx(cop.gate.cx, cop.gate.cy);
  overlays.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="none" stroke="#e8c84a" stroke-width="2"/>`);
}
// garrison seats (white dots)
for (const b of cop.buildings) {
  if (b.kind === "motorpool") continue;
  const s = t.buildingSeat(b);
  const p = toPx(s.x / cs - 0.5, s.y / cs - 0.5);
  overlays.push(`<circle cx="${p.x}" cy="${p.y}" r="2.2" fill="#ffffff"/>`);
}
// fighting positions (orange ticks pointing out)
for (const f of cop.fightingPositions) {
  const p = toPx(f.cx, f.cy);
  overlays.push(`<circle cx="${p.x}" cy="${p.y}" r="2.4" fill="#e08a3a"/>`);
}

const title = `COP ${seed}  R=${R}cells(${R * cs}m)  buildings=${cop.buildings.length}  SEALED POCKET CELLS=${pockets}`;
const legend = `RED=sealed pocket (man-trap)  gray=building  tan=HESCO  cyan=muster  yellow=gate  white=seat  orange=fighting pos`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0c0e08"/>
<text x="${W / 2}" y="18" fill="#cdd6c2" font-size="12" font-family="monospace" text-anchor="middle">${title}</text>
${cells.join("")}
${overlays.join("")}
<text x="${W / 2}" y="${H - 8}" fill="#8a9080" font-size="9" font-family="monospace" text-anchor="middle">${legend}</text>
</svg>`;

sharp(Buffer.from(svg), { density: 160 })
  .png()
  .toFile(out)
  .then(() => console.log(`rendered ${out}  (sealed pocket cells=${pockets})`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
