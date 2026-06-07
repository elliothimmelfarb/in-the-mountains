/**
 * RESEARCH ARTIFACT (item 4 — elevation pathing). Renders the ACTUAL planner output for an
 * "Establish OP up the mountain" order against the real generated terrain, so the ring-the-spur
 * behaviour can be eyeballed and measured. NOT a game system — a one-shot diagnostic that bakes
 * a PNG + prints the route metrics. Reuses the minimal PNG encoder from scripts/trajectory-png.ts.
 *
 * Run: npx tsx docs/progress/2026-06-07-realism-research/tools/gen-oproute.ts [seed]
 */
import { createWorld } from "../../../../lib/sim/world";
import { Land } from "../../../../lib/sim/terrain";
import { findPath } from "../../../../lib/sim/path";
import { deflateSync } from "zlib";
import { writeFileSync } from "fs";

const seed = process.argv[2] || "korengal";
const out = `docs/progress/2026-06-07-realism-research/img/item4-oproute-${seed}.png`;

const w: any = createWorld(seed, 120);
const t = w.terrain;
const cs = t.cellSize;
const cop = t.cop;
const C = t.cellCenter(cop.center.cx, cop.center.cy);
const gateCell = cop.gateOutside ?? cop.gate ?? cop.center;
const gateW = t.cellCenter(gateCell.cx, gateCell.cy);

// Find a "nearby peak" worth an OP: the highest REACHABLE cell (gate component, so the squad can
// actually occupy it) in an annulus 250..560 m of the COP — a realistic "up the mountain" OP order.
const reach = t.reachableFromGate();
let peak: { cx: number; cy: number; e: number } | null = null;
for (let cy = 0; cy < t.size; cy++) {
  for (let cx = 0; cx < t.size; cx++) {
    const dm = Math.hypot(cx - cop.center.cx, cy - cop.center.cy) * cs;
    if (dm < 250 || dm > 560) continue;
    if (!reach[t.idx(cx, cy)]) continue; // must be genuinely occupiable
    const e = t.elev[t.idx(cx, cy)];
    if (!peak || e > peak.e) peak = { cx, cy, e };
  }
}
if (!peak) throw new Error("no reachable peak found in annulus");
const peakW = t.cellCenter(peak.cx, peak.cy);
const crow = Math.hypot(peakW.x - gateW.x, peakW.y - gateW.y);

// How much of the straight-line ascent is physically blocked (slope>1.25 cliff / river / wall)?
// This is WHY the planner can't honour "straight up": the direct line is not walkable.
let straightCells = 0, straightBlocked = 0, steepSum = 0;
{
  const n = Math.max(1, Math.ceil(crow / cs));
  for (let k = 1; k <= n; k++) {
    const wx = gateW.x + (peakW.x - gateW.x) * (k / n);
    const wy = gateW.y + (peakW.y - gateW.y) * (k / n);
    const cx = Math.floor(wx / cs), cy = Math.floor(wy / cs);
    if (!t.inBounds(cx, cy)) continue;
    straightCells++;
    steepSum += t.slope[t.idx(cx, cy)];
    if (!t.passableCell(cx, cy)) straightBlocked++;
  }
}

const routeLen = (pts: { x: number; y: number }[]) => {
  let L = 0, prev = gateW;
  for (const p of pts) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  return L;
};

// The route the squad actually plans for an "Establish OP" order: patrol movement → roadBias 0.55.
const patrolRoute = findPath(t, gateW, peakW, { roadBias: 0.55 });
// Counterfactual: the same order with NO road preference (isolates road bias vs slope cost).
const directIntent = findPath(t, gateW, peakW, { roadBias: 0 });

const Lpatrol = routeLen(patrolRoute);
const Ldirect = routeLen(directIntent);
const climb = peak.e - t.elev[t.idx(gateCell.cx, gateCell.cy)];

console.log(`seed=${seed}`);
console.log(`COP gate elev ${t.elev[t.idx(gateCell.cx, gateCell.cy)].toFixed(0)} m  →  peak elev ${peak.e.toFixed(0)} m  (climb ${climb.toFixed(0)} m)`);
console.log(`crow-flight gate→peak: ${crow.toFixed(0)} m`);
console.log(`PATROL route (roadBias .55): ${Lpatrol.toFixed(0)} m   detour ×${(Lpatrol / crow).toFixed(2)}   waypoints ${patrolRoute.length}`);
console.log(`NO-road route (roadBias 0):  ${Ldirect.toFixed(0)} m   detour ×${(Ldirect / crow).toFixed(2)}   waypoints ${directIntent.length}`);
const reachedPatrol = Math.hypot(patrolRoute[patrolRoute.length - 1].x - peakW.x, patrolRoute[patrolRoute.length - 1].y - peakW.y);
console.log(`patrol route endpoint ${reachedPatrol.toFixed(0)} m from OP (reached if < ~15)`);
console.log(`straight-line ascent: ${straightCells} cells, ${straightBlocked} blocked (${(100 * straightBlocked / Math.max(1, straightCells)).toFixed(0)}% impassable), mean slope ${(steepSum / Math.max(1, straightCells)).toFixed(2)} (rise/run)`);

// ── render ────────────────────────────────────────────────────────────────
let minX = Math.min(gateW.x, peakW.x), maxX = Math.max(gateW.x, peakW.x);
let minY = Math.min(gateW.y, peakW.y), maxY = Math.max(gateW.y, peakW.y);
for (const p of [...patrolRoute, ...directIntent]) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
const pad = 70; minX -= pad; maxX += pad; minY -= pad; maxY += pad;
const SCALE = 1.5;
const W = Math.round((maxX - minX) * SCALE), H = Math.round((maxY - minY) * SCALE);
const px = (x: number) => Math.round((x - minX) * SCALE);
const py = (y: number) => Math.round((y - minY) * SCALE);
const img = new Uint8Array(W * H * 3);
const set = (x: number, y: number, r: number, g: number, b: number) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b;
};

// Background: elevation hillshade (so the mountain reads) tinted by a few landcover classes.
const eRange = Math.max(1, t.maxElev - t.minElev);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const wx = minX + x / SCALE, wy = minY + y / SCALE;
  const cx = Math.floor(wx / cs), cy = Math.floor(wy / cs);
  let r = 24, g = 26, b = 22;
  if (t.inBounds(cx, cy)) {
    const i = t.idx(cx, cy);
    const e = (t.elev[i] - t.minElev) / eRange; // 0..1
    // hillshade from slope toward a NW light
    const ex = t.elev[t.idx(Math.min(t.size - 1, cx + 1), cy)] - t.elev[i];
    const ey = t.elev[t.idx(cx, Math.min(t.size - 1, cy + 1))] - t.elev[i];
    const shade = Math.max(0, Math.min(1, 0.65 + (-(ex) - (ey)) / (cs * 0.9)));
    const base = 60 + e * 150; // higher = brighter
    r = Math.round(base * (0.55 + 0.45 * shade));
    g = Math.round((base * 0.92) * (0.55 + 0.45 * shade));
    b = Math.round((base * 0.66) * (0.55 + 0.45 * shade));
    const l = t.land[i] as Land;
    if (l === Land.Road || l === Land.Track) { r = 150; g = 130; b = 95; }
    else if (l === Land.Trail) { r = 128; g = 110; b = 78; }
    else if (l === Land.River) { r = 40; g = 70; b = 120; }
    else if (l === Land.Forest) { r = (r * 0.6) | 0; g = (g * 0.85) | 0; b = (b * 0.5) | 0; }
    if (!t.passableCell(cx, cy)) { r = (r * 0.4 + 60) | 0; g = (g * 0.35) | 0; b = (b * 0.35) | 0; } // cliffs reddish-dark
  }
  set(x, y, r, g, b);
}

const disc = (wx: number, wy: number, rad: number, r: number, g: number, b: number) => {
  const cx = px(wx), cy = py(wy), R = Math.round(rad * SCALE);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R) set(cx + dx, cy + dy, r, g, b);
};
const line = (a: any, bp: any, r: number, g: number, b: number, thick: number, dash = 0) => {
  const x0 = px(a.x), y0 = py(a.y), x1 = px(bp.x), y1 = py(bp.y);
  const n = Math.max(1, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let s = 0; s <= n; s++) {
    if (dash && Math.floor(s / dash) % 2 === 1) continue;
    const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n);
    for (let oy = -thick; oy <= thick; oy++) for (let ox = -thick; ox <= thick; ox++) set(x + ox, y + oy, r, g, b);
  }
};
const poly = (pts: any[], r: number, g: number, b: number, thick: number) => {
  let prev = gateW; for (const p of pts) { line(prev, p, r, g, b, thick); prev = p; }
};

// straight-line "what the player expected" (dashed white)
line(gateW, peakW, 245, 245, 245, 0, 5);
// no-road route (amber) and patrol route (cyan) — patrol on top
poly(directIntent, 240, 170, 40, 1);
poly(patrolRoute, 40, 210, 230, 2);
disc(gateW.x, gateW.y, 6, 250, 220, 40); // gate
disc(peakW.x, peakW.y, 7, 80, 240, 110);  // OP peak

// PNG encode (from scripts/trajectory-png.ts)
function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) { raw[y * (1 + width * 3)] = 0; rgb.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => (raw[y * (1 + width * 3) + 1 + i] = v)); }
  const idat = deflateSync(raw);
  const crcTable = (() => { const tbl: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; } return tbl; })();
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const ty = Buffer.from(type); const cd = Buffer.concat([ty, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(cd)); return Buffer.concat([len, cd, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync(out, png(W, H, img));
console.log(`wrote ${out} (${W}x${H})`);
