// Rasterize an SVG to a PNG "contact sheet" so an agent can SEE its asset and self-critique.
// Renders the asset at 32/64/128 px across cropland / scree / dark / forest backgrounds, plus a
// rotation strip for rotating sprites. Uses sharp (already in node_modules).
//
//   node scripts/svg2png.mjs <in.svg> <out.png> [--rot]
//   node scripts/svg2png.mjs --str '<svg…>' <out.png> [--rot]
import sharp from "sharp";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const rot = args.includes("--rot");
let svg, out;
if (args[0] === "--str") { svg = args[1]; out = args[2]; }
else { svg = readFileSync(args[0], "utf8"); out = args[1]; }

const BGS = { crop: "#8a984e", scree: "#9c927e", dark: "#14160f", forest: "#324c30" };
const SIZES = [32, 64, 128];
const pad = 12;

async function render(size) {
  return await sharp(Buffer.from(svg), { density: 384 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}
async function rotated(size, deg) {
  return await sharp(Buffer.from(svg), { density: 384 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}
function hex(h){ return { r: parseInt(h.slice(1,3),16), g: parseInt(h.slice(3,5),16), b: parseInt(h.slice(5,7),16) }; }

const cols = Object.entries(BGS); // 4 backgrounds (rows)
const rowH = 128 + pad * 2;
const colW = SIZES.reduce((a, s) => a + s + pad, pad) + 140; // 3 sizes + a label gutter
const W = colW;
const H = rowH * cols.length + (rot ? 160 : 0);

const sheet = sharp({ create: { width: W, height: H, channels: 4, background: { r: 12, g: 13, b: 10, alpha: 1 } } });
const comps = [];
let y = 0;
for (const [name, col] of cols) {
  const bg = hex(col);
  // background band
  comps.push({ input: { create: { width: W - 8, height: rowH - 8, channels: 4, background: { ...bg, alpha: 1 } } }, left: 4, top: y + 4 });
  let x = pad + 130;
  for (const s of SIZES) {
    comps.push({ input: await render(s), left: x, top: y + pad + (128 - s) });
    x += s + pad;
  }
  y += rowH;
}
if (rot) {
  const bg = hex(BGS.crop);
  comps.push({ input: { create: { width: W - 8, height: 150, channels: 4, background: { ...bg, alpha: 1 } } }, left: 4, top: y + 4 });
  let x = pad;
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    comps.push({ input: await rotated(96, deg), left: x, top: y + 20 });
    x += 96 + 6;
  }
}
await sheet.composite(comps).png().toFile(out);
console.log("wrote", out, `${W}x${H}`);
