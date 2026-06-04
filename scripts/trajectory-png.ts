/**
 * Render a squad's ACTUAL march to a PNG (no external libs — minimal zlib PNG encoder),
 * so the movement can be eyeballed. Terrain shaded by passability/landcover; each
 * soldier's traced path drawn over it; the point/lead in white. Companion to the headless
 * metrics — this is the "does it look like a real patrol" check.
 * Run: npx tsx scripts/trajectory-png.ts <seed> <out.png>
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";
import { deflateSync } from "zlib";
import { writeFileSync } from "fs";

const seed = process.argv[2] || "korengal";
const out = process.argv[3] || `docs/visual-overhaul/after-${seed}.png`;

const w: any = createWorld(seed, 120);
const t = w.terrain;
const cop = t.cop;
const cs = t.cellSize;
const C = t.cellCenter(cop.center.cx, cop.center.cy);
const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
let vil: any = null, bs = -1e9;
for (const v of w.state.villages) {
  const ang = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
  let df = Math.abs(ang - gateAng); if (df > Math.PI) df = 2 * Math.PI - df;
  const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * cs;
  const score = df - dm / 700; if (score > bs && dm < 650) { bs = score; vil = v; }
}
const objW = t.cellCenter(vil.cx, vil.cy);
const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
const ids: string[] = sq.memberIds.slice();
const task = w.formPatrol(ids, [{ cx: vil.cx, cy: vil.cy }], "presence", "patrol");

const tracks: Record<string, { x: number; y: number }[]> = {};
for (const id of ids) tracks[id] = [];
for (let k = 0; k < 14000; k++) {
  w.tick(0.1);
  if (k % 8 === 0) for (const id of ids) { const u = w.sim.unit(id); if (u && u.alive) tracks[id].push({ x: u.pos.x, y: u.pos.y }); }
  if (task.phase === "onstation" || task.phase === "returning") break;
}

// view window: bound COP + objective + tracks
let minX = Math.min(C.x, objW.x), maxX = Math.max(C.x, objW.x), minY = Math.min(C.y, objW.y), maxY = Math.max(C.y, objW.y);
for (const id of ids) for (const p of tracks[id]) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
const pad = 50; minX -= pad; maxX += pad; minY -= pad; maxY += pad;
const SCALE = 1.4; // px per meter
const W = Math.round((maxX - minX) * SCALE), H = Math.round((maxY - minY) * SCALE);
const px = (x: number) => Math.round((x - minX) * SCALE);
const py = (y: number) => Math.round((y - minY) * SCALE);

const img = new Uint8Array(W * H * 3);
const set = (x: number, y: number, r: number, g: number, b: number) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b;
};
// terrain background
const col: Partial<Record<Land, [number, number, number]>> = {
  [Land.Hesco]: [150, 110, 40], [Land.Structure]: [90, 80, 70], [Land.CompoundWall]: [110, 90, 70], [Land.Compound]: [80, 72, 60],
  [Land.Cliff]: [60, 55, 52], [Land.Scree]: [95, 90, 84], [Land.Rock]: [80, 76, 72], [Land.River]: [40, 70, 110], [Land.DryWash]: [120, 110, 86],
  [Land.Road]: [110, 100, 80], [Land.Trail]: [98, 86, 60], [Land.Forest]: [40, 70, 45], [Land.Orchard]: [60, 90, 55], [Land.Cropland]: [110, 120, 70],
  [Land.Grass]: [88, 100, 64], [Land.Meadow]: [96, 110, 70], [Land.Gravel]: [120, 116, 105],
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const wx = minX + x / SCALE, wy = minY + y / SCALE;
  const cx = Math.floor(wx / cs), cy = Math.floor(wy / cs);
  let r = 30, g = 33, b = 27;
  if (t.inBounds(cx, cy)) {
    const l = t.land[t.idx(cx, cy)] as Land;
    const c = col[l]; if (c) { [r, g, b] = c; }
    if (!t.passableCell(cx, cy)) { r = (r * 0.5) | 0; g = (g * 0.5) | 0; b = (b * 0.5) | 0; } // darken impassable
  }
  set(x, y, r, g, b);
}
// objective ring + gate
const disc = (wx: number, wy: number, rad: number, r: number, g: number, b: number) => {
  const cx = px(wx), cy = py(wy), R = Math.round(rad * SCALE);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R) set(cx + dx, cy + dy, r, g, b);
};
disc(objW.x, objW.y, 6, 60, 220, 90);
const gate = t.cellCenter(cop.gate.cx, cop.gate.cy); disc(gate.x, gate.y, 4, 230, 210, 40);
// tracks
const PAL: [number, number, number][] = [[255, 80, 60], [60, 130, 230], [70, 210, 90], [255, 150, 40], [190, 60, 210], [70, 210, 210], [240, 40, 200], [150, 40, 90], [80, 170, 110]];
const line = (a: any, bp: any, r: number, g: number, b: number, thick: number) => {
  const x0 = px(a.x), y0 = py(a.y), x1 = px(bp.x), y1 = py(bp.y);
  const n = Math.max(1, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let s = 0; s <= n; s++) { const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n);
    for (let oy = -thick; oy <= thick; oy++) for (let ox = -thick; ox <= thick; ox++) set(x + ox, y + oy, r, g, b); }
};
ids.forEach((id, i) => {
  const tr = tracks[id]; if (tr.length < 2) return;
  const nav = id === task.leadId;
  const [r, g, b] = nav ? [255, 255, 255] : PAL[i % PAL.length];
  for (let s = 1; s < tr.length; s++) line(tr[s - 1], tr[s], r, g, b, nav ? 1 : 0);
});

// PNG encode (truecolor, no filter)
function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) { raw[y * (1 + width * 3)] = 0; rgb.subarray(y * width * 3, (y + 1) * width * 3).forEach((v, i) => (raw[y * (1 + width * 3) + 1 + i] = v)); }
  const idat = deflateSync(raw);
  const crcTable = (() => { const tbl: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; } return tbl; })();
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type); const cd = Buffer.concat([t, data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(cd)); return Buffer.concat([len, cd, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync(out, png(W, H, img));
console.log(`wrote ${out} (${W}x${H}, onStation phase=${task.phase})`);
