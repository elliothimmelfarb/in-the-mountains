// Combat-FX design plate — renders every combat cue faithfully (same palette/geometry as
// lib/render/combat-fx.ts) over dust-terrain tiles, so the visual language can be eyeballed
// WITHOUT a browser and reused as the ART_BIBLE legend + tutorial figure.
//
//   node scripts/fx-legend.mjs
import sharp from "sharp";
import { writeFileSync } from "node:fs";

// locked dust palette (ART_BIBLE §3)
const RUST = "#b5532a", AMBER = "#e0a72b", SHADOW = "#1c160e", INK = "#e8e5d4";
const BLOOD = "#9c2c20", US = "#4a86c6", DUST = "#9c8d63", TEAL = "#6fae9f";
const PANEL = "#14160f", LINE = "#2c3022";

const TW = 360, TH = 250, GAP = 16, COLS = 3, PAD = 24, TITLE_H = 64;
const ROWS = 2;
const W = PAD * 2 + COLS * TW + (COLS - 1) * GAP;
const H = TITLE_H + PAD + ROWS * TH + (ROWS - 1) * GAP + PAD;

// --- tiny SVG helpers ---------------------------------------------------------------
const P = [];
const add = (s) => P.push(s);
function dashRing(cx, cy, r, col, alpha, dash = "6 6", w = 1.6, off = 0) {
  add(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-opacity="${alpha}" stroke-width="${w}" stroke-dasharray="${dash}" stroke-dashoffset="${off}"/>`);
}
function ring(cx, cy, r, col, alpha, w = 2) {
  add(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-opacity="${alpha}" stroke-width="${w}"/>`);
}
function pip(cx, cy, col) {
  add(`<path d="M${cx - 6} ${cy}H${cx + 6}M${cx} ${cy - 6}V${cx === cx ? cy + 6 : cy}" stroke="${col}" stroke-width="1.3" stroke-linecap="round"/>`);
  add(`<circle cx="${cx}" cy="${cy}" r="1.6" fill="${col}"/>`);
}
function label(cx, y, text, sub) {
  add(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="13" font-weight="700" fill="${INK}" letter-spacing="0.4">${text}</text>`);
  if (sub) add(`<text x="${cx}" y="${y + 16}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="10.5" fill="#9a9a82">${sub}</text>`);
}
// annular crescent sector (same construction as drawSuppressionCues)
function crescent(cx, cy, ri, ro, ang, half, col, alpha) {
  const a0 = ang - half, a1 = ang + half;
  const x0o = cx + Math.cos(a0) * ro, y0o = cy + Math.sin(a0) * ro;
  const x1o = cx + Math.cos(a1) * ro, y1o = cy + Math.sin(a1) * ro;
  const x1i = cx + Math.cos(a1) * ri, y1i = cy + Math.sin(a1) * ri;
  const x0i = cx + Math.cos(a0) * ri, y0i = cy + Math.sin(a0) * ri;
  add(`<path d="M${x0o} ${y0o} A${ro} ${ro} 0 0 1 ${x1o} ${y1o} L${x1i} ${y1i} A${ri} ${ri} 0 0 0 ${x0i} ${y0i} Z" fill="${col}" fill-opacity="${alpha}" stroke="${col}" stroke-opacity="${Math.min(0.9, alpha + 0.25)}" stroke-width="1"/>`);
}
function soldier(cx, cy, facing, accent) {
  add(`<g transform="rotate(${(facing * 180) / Math.PI} ${cx} ${cy})">`);
  add(`<ellipse cx="${cx}" cy="${cy + 1}" rx="9" ry="8" fill="#181308" opacity="0.3"/>`);
  add(`<ellipse cx="${cx - 1}" cy="${cy}" rx="7" ry="5.5" fill="#4d5132" stroke="${SHADOW}" stroke-width="0.8"/>`);
  add(`<line x1="${cx - 5}" y1="${cy + 3}" x2="${cx + 8}" y2="${cy - 3}" stroke="#1d1b15" stroke-width="2"/>`);
  add(`<circle cx="${cx + 1}" cy="${cy}" r="3.4" fill="#565b39" stroke="${SHADOW}" stroke-width="0.7"/>`);
  add(`<rect x="${cx - 7}" y="${cy - 5}" width="4" height="2.4" rx="0.5" fill="${accent}"/>`);
  add(`</g>`);
}

// --- tile frame ---------------------------------------------------------------------
function tile(i, bg, drawFn, title, sub) {
  const col = i % COLS, row = Math.floor(i / COLS);
  const x = PAD + col * (TW + GAP);
  const y = TITLE_H + PAD + row * (TH + GAP);
  const cx = x + TW / 2, cy = y + TH / 2 - 14;
  add(`<rect x="${x}" y="${y}" width="${TW}" height="${TH}" rx="6" fill="${bg}" stroke="${LINE}" stroke-width="1.2"/>`);
  // subtle darker vignette base so cues read like they're on ground
  add(`<rect x="${x}" y="${y}" width="${TW}" height="${TH}" rx="6" fill="url(#vig)"/>`);
  drawFn(cx, cy);
  add(`<rect x="${x}" y="${y + TH - 38}" width="${TW}" height="38" rx="0" fill="${SHADOW}" opacity="0.55"/>`);
  label(cx, y + TH - 21, title, sub);
}

// ====================================================================================
add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,monospace">`);
add(`<defs><radialGradient id="vig" cx="0.5" cy="0.42" r="0.7"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/></radialGradient></defs>`);
add(`<rect width="${W}" height="${H}" fill="${PANEL}"/>`);
add(`<text x="${PAD}" y="38" font-size="22" font-weight="800" fill="${INK}" letter-spacing="1">COMBAT&#160;&#160;FX&#160;&#8212;&#160;VISUAL&#160;LANGUAGE</text>`);
add(`<text x="${W - PAD}" y="38" text-anchor="end" font-size="11" fill="#9a9a82">In the Mountains &#183; phase 1&#8211;2 &#183; one ink-and-dust vocabulary</text>`);
add(`<rect x="${PAD}" y="50" width="${W - PAD * 2}" height="1.5" fill="${LINE}"/>`);

// 1) INDIRECT INBOUND — beaten zone + ETA (enemy, rust)
tile(0, "#8a984e", (cx, cy) => {
  dashRing(cx, cy, 64, RUST, 0.45, "3 7", 1.1); // converging telegraph
  dashRing(cx, cy, 44, RUST, 0.85, "6 6", 1.6); // beaten zone
  pip(cx, cy, RUST);
  add(`<rect x="${cx - 16}" y="${cy - 44 - 16}" width="32" height="16" fill="${SHADOW}" opacity="0.7"/>`);
  add(`<text x="${cx}" y="${cy - 44 - 4}" text-anchor="middle" font-size="12" font-weight="700" fill="${RUST}">8s</text>`);
}, "INDIRECT INBOUND", "beaten zone sized to dispersion + ETA");

// 2) DANGER CLOSE — hazard ring + friendly halo
tile(1, "#847a4e", (cx, cy) => {
  const bars = 16, r = 46;
  for (let i = 0; i < bars; i++) {
    const a0 = (i / bars) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / bars / 2;
    const col = i % 2 === 0 ? AMBER : SHADOW;
    add(`<path d="M${cx + Math.cos(a0) * r} ${cy + Math.sin(a0) * r} A${r} ${r} 0 0 1 ${cx + Math.cos(a1) * r} ${cy + Math.sin(a1) * r}" fill="none" stroke="${col}" stroke-width="3.4"/>`);
  }
  pip(cx, cy, AMBER);
  // a friendly inside the radius gets an amber halo
  soldier(cx + 14, cy + 10, -0.5, US);
  ring(cx + 14, cy + 10, 12, AMBER, 0.8, 1.6);
}, "DANGER CLOSE", "our fires landing over our own men");

// 3) THREAT BEARING — crescent points back at the shooter
tile(2, "#527038", (cx, cy) => {
  soldier(cx, cy, -0.2, US);
  ring(cx, cy, 13, US, 0.5, 1.4);
  crescent(cx, cy, 16, 19.5, -2.4, 0.62, RUST, 0.62); // upper-left bearing
  // hint of the threat off that bearing
  add(`<line x1="${cx - 30}" y1="${cy - 26}" x2="${cx - 20}" y2="${cy - 18}" stroke="${RUST}" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/>`);
}, "UNDER FIRE", "rust crescent = bearing to the threat");

// 4) SUPPRESSED vs PINNED
tile(3, "#8e925c", (cx, cy) => {
  const lx = cx - 64, rx = cx + 64;
  // suppressed but fighting — amber partial arc
  soldier(lx, cy, 0.1, US);
  add(`<path d="M${lx + 16} ${cy} A16 16 0 1 1 ${lx + 16 - 0.01} ${cy}" fill="none" stroke="${AMBER}" stroke-width="1.6" stroke-opacity="0.55" stroke-dasharray="${2 * Math.PI * 16 * 0.6} 999"/>`);
  add(`<text x="${lx}" y="${cy + 34}" text-anchor="middle" font-size="10" fill="#9a9a82">taking fire</text>`);
  // pinned — closed rust pulsing ring
  soldier(rx, cy, 0.1, US);
  ring(rx, cy, 17, RUST, 0.85, 2.2);
  add(`<text x="${rx}" y="${cy + 34}" text-anchor="middle" font-size="10" fill="${RUST}">PINNED</text>`);
}, "SUPPRESSED vs PINNED", "open amber arc vs closed pulsing ring");

// 5) GRENADE IN THE AIR — lob arc
tile(4, "#9c927e", (cx, cy) => {
  const x0 = cx - 70, y0 = cy + 18, x1 = cx + 64, y1 = cy + 16;
  soldier(x0 - 6, y0, -0.3, US);
  // parabola
  let d = `M${x0} ${y0}`;
  for (let t = 0; t <= 1.001; t += 0.1) {
    const gx = x0 + (x1 - x0) * t;
    const h = 56 * 4 * t * (1 - t) * 0.5;
    d += ` L${gx} ${y0 - h - (y0 - y1) * t}`;
  }
  add(`<path d="${d}" fill="none" stroke="${DUST}" stroke-width="1" stroke-dasharray="2 4" opacity="0.5"/>`);
  // round mid-air + ground shadow
  const t = 0.55, gx = x0 + (x1 - x0) * t, gy = y0 - (y0 - y1) * t, h = 56 * 4 * t * (1 - t) * 0.5;
  add(`<ellipse cx="${gx}" cy="${gy}" rx="2.4" ry="1.4" fill="${SHADOW}" opacity="0.3"/>`);
  add(`<circle cx="${gx}" cy="${gy - h}" r="2.2" fill="#e6d296"/>`);
  // airburst
  add(`<circle cx="${x1}" cy="${y1}" r="9" fill="${AMBER}" opacity="0.35"/>`);
  add(`<circle cx="${x1}" cy="${y1}" r="4" fill="#fff2c8" opacity="0.8"/>`);
}, "GRENADE IN THE AIR", "lobbed round arcs to its airburst");

// 6) CASUALTY LADDER (next phase preview)
tile(5, "#7c8e4c", (cx, cy) => {
  const xs = [cx - 96, cx - 32, cx + 32, cx + 96];
  // WIA chevron
  add(`<path d="M${xs[0] - 5} ${cy - 8} L${xs[0]} ${cy - 13} L${xs[0] + 5} ${cy - 8}" fill="none" stroke="${RUST}" stroke-width="2" stroke-linecap="round"/>`);
  soldier(xs[0], cy + 2, 0, US);
  add(`<text x="${xs[0]}" y="${cy + 30}" text-anchor="middle" font-size="9.5" fill="#9a9a82">WIA</text>`);
  // down cross
  add(`<circle cx="${xs[1]}" cy="${cy}" r="10" fill="#34506b" stroke="${SHADOW}" stroke-width="0.8"/>`);
  add(`<text x="${xs[1]}" y="${cy + 4}" text-anchor="middle" font-size="14" font-weight="700" fill="${BLOOD}">&#10010;</text>`);
  add(`<text x="${xs[1]}" y="${cy + 30}" text-anchor="middle" font-size="9.5" fill="#9a9a82">DOWN</text>`);
  // bleeding — pool + pulse
  add(`<ellipse cx="${xs[2]}" cy="${cy + 4}" rx="11" ry="7" fill="${BLOOD}" opacity="0.5"/>`);
  add(`<circle cx="${xs[2]}" cy="${cy}" r="9" fill="#34506b" stroke="${SHADOW}" stroke-width="0.8"/>`);
  add(`<text x="${xs[2]}" y="${cy + 4}" text-anchor="middle" font-size="14" font-weight="700" fill="${BLOOD}">&#10010;</text>`);
  ring(xs[2], cy, 13, BLOOD, 0.6, 1.4);
  add(`<text x="${xs[2]}" y="${cy + 30}" text-anchor="middle" font-size="9.5" fill="${BLOOD}">BLEEDING</text>`);
  // buddy-aid teal link + KIA
  add(`<line x1="${xs[2] + 13}" y1="${cy}" x2="${xs[3] - 10}" y2="${cy}" stroke="${TEAL}" stroke-width="1.4" opacity="0.7"/>`);
  add(`<g stroke="rgba(120,120,120,0.5)" stroke-width="1.6"><line x1="${xs[3] - 7}" y1="${cy - 7}" x2="${xs[3] + 7}" y2="${cy + 7}"/><line x1="${xs[3] + 7}" y1="${cy - 7}" x2="${xs[3] - 7}" y2="${cy + 7}"/></g>`);
  add(`<text x="${xs[3]}" y="${cy + 30}" text-anchor="middle" font-size="9.5" fill="#9a9a82">KIA</text>`);
}, "CASUALTY LADDER", "WIA → down → bleeding+aid → KIA (phase 3)");

add(`</svg>`);

const svg = P.join("\n");
writeFileSync("docs/progress/2026-06-04-combat-visual/fx-legend.svg", svg);
const png = await sharp(Buffer.from(svg), { density: 200 }).png().toBuffer();
writeFileSync("docs/progress/2026-06-04-combat-visual/fx-legend.png", png);
console.log(`wrote fx-legend.svg + fx-legend.png (${W}x${H})`);
