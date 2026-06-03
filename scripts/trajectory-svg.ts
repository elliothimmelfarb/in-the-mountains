/**
 * Render a top-down SVG of a squad's ACTUAL movement around the COP, straight from
 * the headless sim — the clearest possible picture of the movement fix. It forms the
 * reported scenario (a patrol from inside the COP to a village on the far side of the
 * gate), records every soldier's position over the whole march, and draws:
 *   - the HESCO wall ring + the single gate
 *   - the graded perimeter track
 *   - each soldier's traced path (the point man bold), out the gate and around the wire
 *   - muster (start) and the 360° security set-up on the objective (end)
 *
 * Run: npx tsx scripts/trajectory-svg.ts <seed> <out.svg>
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const seed = process.argv[2] || "korengal";
const out = process.argv[3] || "docs/progress/movement-trajectory.svg";

const w: any = createWorld(seed, 120);
const t = w.terrain;
const cop = t.cop;
const cs = t.cellSize;
const C = t.cellCenter(cop.center.cx, cop.center.cy);
const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);

// village on the far side of the gate (the worst case the player hit)
let vil: any = null,
  bs = -1e9;
for (const v of w.state.villages) {
  const ang = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
  let df = Math.abs(ang - gateAng);
  if (df > Math.PI) df = 2 * Math.PI - df;
  const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * cs;
  const score = df - dm / 700;
  if (score > bs && dm < 650) {
    bs = score;
    vil = v;
  }
}
const objW = t.cellCenter(vil.cx, vil.cy);
const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
const ids: string[] = sq.memberIds.slice();
const task = w.formPatrol(ids, [{ cx: vil.cx, cy: vil.cy }], "presence", "patrol");

// record trajectories
const tracks: Record<string, { x: number; y: number }[]> = {};
for (const id of ids) tracks[id] = [];
let onStationAt = -1;
for (let k = 0; k < 12000; k++) {
  w.tick(0.1);
  if (k % 10 === 0) {
    for (const id of ids) {
      const u = w.sim.unit(id);
      if (u && u.alive) tracks[id].push({ x: u.pos.x, y: u.pos.y });
    }
  }
  if (onStationAt < 0 && task && (task.phase === "onstation" || task.phase === "returning")) onStationAt = Math.round(k * 0.1);
  if (task && (task.phase === "onstation" || task.phase === "returning")) break;
}

// view window: bound the COP + village + all tracks, padded
let minX = Math.min(C.x, objW.x),
  maxX = Math.max(C.x, objW.x),
  minY = Math.min(C.y, objW.y),
  maxY = Math.max(C.y, objW.y);
for (const id of ids)
  for (const p of tracks[id]) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
const pad = 40;
minX -= pad;
maxX += pad;
minY -= pad;
maxY += pad;
const Wd = maxX - minX,
  Ht = maxY - minY;
const SCALE = 2.0; // px per meter
const sx = (x: number) => ((x - minX) * SCALE).toFixed(1);
const sy = (y: number) => ((y - minY) * SCALE).toFixed(1);

// collect wall + trail cells in-window
const wallRects: string[] = [];
const trailRects: string[] = [];
const c0x = Math.floor(minX / cs),
  c1x = Math.ceil(maxX / cs),
  c0y = Math.floor(minY / cs),
  c1y = Math.ceil(maxY / cs);
for (let cy = c0y; cy <= c1y; cy++)
  for (let cx = c0x; cx <= c1x; cx++) {
    if (!t.inBounds(cx, cy)) continue;
    const l = t.land[t.idx(cx, cy)] as Land;
    const px = sx(cx * cs),
      py = sy(cy * cs),
      s = (cs * SCALE).toFixed(1);
    if (l === Land.Hesco) wallRects.push(`<rect x="${px}" y="${py}" width="${s}" height="${s}" fill="#b8860b" opacity="0.9"/>`);
    else if (l === Land.Trail) trailRects.push(`<rect x="${px}" y="${py}" width="${s}" height="${s}" fill="#6b5b3e" opacity="0.5"/>`);
  }

const PALETTE = ["#ff4136", "#0074d9", "#2ecc40", "#ff851b", "#b10dc9", "#39cccc", "#f012be", "#85144b", "#3d9970"];
const polylines: string[] = [];
ids.forEach((id, i) => {
  const tr = tracks[id];
  if (tr.length < 2) return;
  const nav = id === task.leadId;
  const pts = tr.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ");
  polylines.push(
    `<polyline points="${pts}" fill="none" stroke="${nav ? "#fff" : PALETTE[i % PALETTE.length]}" stroke-width="${nav ? 3.2 : 1.8}" opacity="${nav ? 1 : 0.85}" stroke-linejoin="round" stroke-linecap="round"/>`
  );
});
// end positions (security set-up)
const endDots = ids
  .map((id, i) => {
    const u = w.sim.unit(id);
    if (!u) return "";
    return `<circle cx="${sx(u.pos.x)}" cy="${sy(u.pos.y)}" r="${id === task.leadId ? 4.5 : 3.5}" fill="${id === task.leadId ? "#fff" : PALETTE[i % PALETTE.length]}" stroke="#000" stroke-width="0.6"/>`;
  })
  .join("");

const muster = t.cellCenter(cop.muster.cx, cop.muster.cy);
const gate = t.cellCenter(cop.gate.cx, cop.gate.cy);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(Wd * SCALE).toFixed(0)} ${(Ht * SCALE).toFixed(0)}" font-family="ui-monospace,monospace">
<rect x="0" y="0" width="100%" height="100%" fill="#1a1d17"/>
${trailRects.join("\n")}
${wallRects.join("\n")}
<circle cx="${sx(objW.x)}" cy="${sy(objW.y)}" r="${(45 * SCALE).toFixed(0)}" fill="#2ecc40" opacity="0.08"/>
<circle cx="${sx(objW.x)}" cy="${sy(objW.y)}" r="6" fill="#2ecc40"/>
<text x="${sx(objW.x)}" y="${(+sy(objW.y) - 12).toFixed(1)}" fill="#2ecc40" font-size="13" text-anchor="middle">${vil.name} (objective)</text>
<circle cx="${sx(gate.x)}" cy="${sy(gate.y)}" r="5" fill="#ffdc00"/>
<text x="${sx(gate.x)}" y="${(+sy(gate.y) - 9).toFixed(1)}" fill="#ffdc00" font-size="12" text-anchor="middle">ECP gate</text>
<text x="${sx(muster.x)}" y="${sy(muster.y)}" fill="#aaa" font-size="11" text-anchor="middle">muster</text>
${polylines.join("\n")}
${endDots}
<text x="12" y="22" fill="#fff" font-size="15">${seed}: 1st Squad — COP → ${vil.name} (${Math.round(Math.hypot(objW.x - C.x, objW.y - C.y))} m, opposite the gate)</text>
<text x="12" y="40" fill="#9c9" font-size="12">white = point man · colored = each soldier's traced path · on-station ${onStationAt}s after step-off</text>
</svg>`;

import { writeFileSync } from "fs";
writeFileSync(out, svg);
console.log(`wrote ${out}  (${ids.length} tracks, onStation=${onStationAt}s, village=${Math.round(Math.hypot(objW.x - C.x, objW.y - C.y))}m)`);
