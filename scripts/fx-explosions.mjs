// Detonation-sequence plate — renders the layered explosion over its life using the SAME
// math as lib/render/draw.ts drawEffects(), so the spectacle can be eyeballed without a
// browser. Verifies the blast reads flash → dirty fireball → tan dust dome → smoke rim, and
// that ground-HE vs airburst vs bullet-impact are distinguishable.
//
//   node scripts/fx-explosions.mjs
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const INK = "#e8e5d4", SHADOW = "#1c160e", LINE = "#2c3022", PANEL = "#14160f";
const TW = 210, TH = 210, GAP = 12, PAD = 22, TITLE_H = 58;
const P = [];
const add = (s) => P.push(s);
const circ = (cx, cy, r, fill, a) => add(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${a}"/>`);
const cring = (cx, cy, r, col, a, w) => add(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-opacity="${a}" stroke-width="${w}"/>`);

// faithful blast layering (ppm folded into R); k = 0..1 life
function blast(cx, cy, R, k) {
  const f = 1 - k;
  if (k < 0.22) circ(cx, cy, Math.max(3, R * 0.5 * (0.5 + k)), "#fff2d6", 0.95 * (1 - k / 0.22));
  circ(cx, cy, Math.max(4, R * (0.35 + k * 0.7)), "#c97036", 0.55 * f); // dirty fireball
  const dome = Math.max(6, R * (0.7 + k * 1.1));
  circ(cx, cy, dome, "#9c8d63", 0.4 * f); // tan dust dome
  cring(cx, cy, dome * 1.04, "#221a12", 0.5 * f, 2); // smoke rim
}
function fragAir(cx, cy, s, k) {
  const f = 1 - k;
  if (k < 0.3) circ(cx, cy, Math.max(3, s * 0.4), "#ffecb4", 0.9 * (1 - k / 0.3));
  const ring = Math.max(4, s * (0.3 + k));
  circ(cx, cy, ring * 0.8, "#9c8d63", 0.22 * f);
  cring(cx, cy, ring, "#ffd696", 0.7 * f, 1.6);
}
function impact(cx, cy, s, k, id) {
  const f = 1 - k;
  circ(cx, cy, s, "#9c8d63", 0.5 * f);
  for (let i = 0; i < 3; i++) {
    const a = id * 2.4 + i * 2.1, d = s * (0.9 + i * 0.55) * (0.5 + k);
    add(`<rect x="${cx + Math.cos(a) * d - 0.6}" y="${cy + Math.sin(a) * d - 0.6}" width="1.6" height="1.6" fill="#786c54" fill-opacity="${0.5 * f}"/>`);
  }
}
function muzzleStar(cx, cy, s, f) {
  circ(cx, cy, s * 0.42, "#ffeec8", 0.95 * f);
  let d = "";
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = i % 2 === 0 ? s : s * 0.4; d += (i ? "L" : "M") + (cx + Math.cos(a) * r) + " " + (cy + Math.sin(a) * r); }
  add(`<path d="${d}Z" fill="#ffcc6c" fill-opacity="${0.8 * f}"/>`);
}

const tiles = [];
const RGE = 46; // a ~15m mortar at tactical zoom
for (const k of [0.06, 0.22, 0.45, 0.75]) tiles.push({ bg: "#847a4e", fn: (cx, cy) => blast(cx, cy, RGE, k), t: "GROUND HE", s: `k=${k}` });
tiles.push({ bg: "#8a984e", fn: (cx, cy) => fragAir(cx, cy, 30, 0.4), t: "AIRBURST", s: "thrown frag / GL" });
tiles.push({ bg: "#9c927e", fn: (cx, cy) => impact(cx, cy, 9, 0.4, 7), t: "BULLET IMPACT", s: "tan dust + spall" });
tiles.push({ bg: "#324c30", fn: (cx, cy) => muzzleStar(cx, cy, 11, 0.85), t: "MUZZLE FLASH", s: "punchy, strobes" });
tiles.push({ bg: "#8e925c", fn: (cx, cy) => { for (let i = 0; i < 3; i++) { const a = 7 * 1.7 + i * 2.3; circ(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6, 0.8, "#6e1812", 0.6); } circ(cx, cy, 4, "#7c1c16", 0.6); }, t: "BLOOD", s: "spatter, capped" });

const COLS = 4, ROWS = Math.ceil(tiles.length / COLS);
const W = PAD * 2 + COLS * TW + (COLS - 1) * GAP;
const H = TITLE_H + PAD + ROWS * TH + (ROWS - 1) * GAP + PAD;

add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,monospace">`);
add(`<rect width="${W}" height="${H}" fill="${PANEL}"/>`);
add(`<text x="${PAD}" y="36" font-size="20" font-weight="800" fill="${INK}" letter-spacing="1">DETONATION SEQUENCE &amp; STRIKES</text>`);
add(`<rect x="${PAD}" y="46" width="${W - PAD * 2}" height="1.5" fill="${LINE}"/>`);
tiles.forEach((tile, i) => {
  const col = i % COLS, row = Math.floor(i / COLS);
  const x = PAD + col * (TW + GAP), y = TITLE_H + PAD + row * (TH + GAP);
  add(`<rect x="${x}" y="${y}" width="${TW}" height="${TH}" rx="6" fill="${tile.bg}" stroke="${LINE}"/>`);
  tile.fn(x + TW / 2, y + TH / 2 - 12);
  add(`<rect x="${x}" y="${y + TH - 34}" width="${TW}" height="34" fill="${SHADOW}" opacity="0.55"/>`);
  add(`<text x="${x + TW / 2}" y="${y + TH - 18}" text-anchor="middle" font-size="12" font-weight="700" fill="${INK}">${tile.t}</text>`);
  add(`<text x="${x + TW / 2}" y="${y + TH - 5}" text-anchor="middle" font-size="10" fill="#9a9a82">${tile.s}</text>`);
});
add(`</svg>`);

const svg = P.join("\n");
writeFileSync("docs/progress/2026-06-04-combat-visual/fx-explosions.svg", svg);
writeFileSync("docs/progress/2026-06-04-combat-visual/fx-explosions.png", await sharp(Buffer.from(svg), { density: 220 }).png().toBuffer());
console.log(`wrote fx-explosions.svg + .png (${W}x${H})`);
