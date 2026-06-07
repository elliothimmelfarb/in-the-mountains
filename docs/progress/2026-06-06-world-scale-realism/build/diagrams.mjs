// Report tooling — generate the math-only scale diagrams for the world-scale realism report.
// Pure functions of the render formulas + measured geometry (no research dependency).
// Writes .svg (for inlining into the HTML) and a full-size .png (for self-review).
// Run from repo root:  node docs/progress/2026-06-06-world-scale-realism/build/diagrams.mjs
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const DIR = "docs/progress/2026-06-06-world-scale-realism/diagrams";
import { mkdirSync } from "node:fs";
mkdirSync(DIR, { recursive: true });

// theme
const BG = "#161812", INK = "#e8e4d8", SUB = "#9a9686", AMBER = "#d8a657",
  RED = "#c8553d", GREEN = "#6f8f4e", BLUE = "#5a86a8", GRID = "#2c2f26";
const FF = "font-family='ui-monospace,Menlo,Consolas,monospace'";

const figurePx = (ppm) => Math.max(15, Math.min(40, ppm * 7));

async function emit(name, w, h, body) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>
<rect width='${w}' height='${h}' fill='${BG}'/>${body}</svg>`;
  writeFileSync(`${DIR}/${name}.svg`, svg);
  await sharp(Buffer.from(svg)).png().toFile(`${DIR}/${name}.png`);
  console.log("wrote", name);
}
const T = (x, y, s, opts = {}) =>
  `<text x='${x}' y='${y}' ${FF} font-size='${opts.size || 14}' fill='${opts.fill || INK}' text-anchor='${opts.anchor || "start"}' ${opts.weight ? `font-weight='${opts.weight}'` : ""} ${opts.style ? `font-style='${opts.style}'` : ""}>${s}</text>`;

// ============ DIAGRAM 1 — footprints, all at one true scale ============
async function d1() {
  const W = 760, H = 580, S = 2.6; // px per meter (diagram scale)
  const cx = 300, cy = 335;
  const copR = 85 * S;                  // COP radius 85 m
  const figR = (21.4 / 2) * S;          // soldier as drawn at default zoom (21.4 m wide)
  const qalat = 30 * S;                 // a 30 m family compound (square)
  const realR = (0.6 / 2) * S;          // real soldier 0.6 m
  let b = "";
  b += T(W / 2, 30, "TO SCALE: A SOLDIER AND HIS OUTPOST", { size: 19, weight: 700, anchor: "middle", fill: AMBER });
  b += T(W / 2, 51, "every shape below drawn at one consistent scale — 2.6 px = 1 metre", { size: 12.5, anchor: "middle", fill: SUB, style: "italic" });
  // COP
  b += `<circle cx='${cx}' cy='${cy}' r='${copR}' fill='none' stroke='${INK}' stroke-width='2' stroke-dasharray='3 4'/>`;
  b += T(cx, cy - copR - 8, "COMBAT OUTPOST — 170 m across", { size: 13, anchor: "middle", fill: INK });
  // qalat compound (top-right inside)
  b += `<rect x='${cx + 30}' y='${cy - 70}' width='${qalat}' height='${qalat}' fill='${GREEN}' opacity='0.35' stroke='${GREEN}' stroke-width='1.5'/>`;
  b += T(cx + 30 + qalat / 2, cy - 78, "qalat 30 m", { size: 11, anchor: "middle", fill: GREEN });
  // soldier as drawn (default zoom) — red disc
  const sdx = cx - 70, sdy = cy + 40;
  b += `<circle cx='${sdx}' cy='${sdy}' r='${figR}' fill='${RED}' opacity='0.45' stroke='${RED}' stroke-width='1.5'/>`;
  b += T(sdx, sdy + figR + 16, "soldier AS DRAWN", { size: 11.5, anchor: "middle", fill: RED, weight: 700 });
  b += T(sdx, sdy + figR + 31, "(default zoom): 21 m", { size: 11.5, anchor: "middle", fill: RED });
  // real soldier dot
  const rdx = cx + 8, rdy = cy + 55;
  b += `<circle cx='${rdx}' cy='${rdy}' r='${Math.max(realR, 1)}' fill='${INK}'/>`;
  // leader line + callout for the real soldier
  b += `<line x1='${rdx}' y1='${rdy}' x2='${cx + 150}' y2='${cy + 150}' stroke='${SUB}' stroke-width='1'/>`;
  b += T(cx + 156, cy + 150, "real soldier: 0.6 m", { size: 12, fill: INK });
  b += T(cx + 156, cy + 167, "(the speck — 1.7 px here)", { size: 11, fill: SUB });
  // scale bar 100 m
  const sbx = 60, sby = H - 40, sb = 100 * S;
  b += `<line x1='${sbx}' y1='${sby}' x2='${sbx + sb}' y2='${sby}' stroke='${INK}' stroke-width='2'/>`;
  b += `<line x1='${sbx}' y1='${sby - 5}' x2='${sbx}' y2='${sby + 5}' stroke='${INK}' stroke-width='2'/>`;
  b += `<line x1='${sbx + sb}' y1='${sby - 5}' x2='${sbx + sb}' y2='${sby + 5}' stroke='${INK}' stroke-width='2'/>`;
  b += T(sbx + sb / 2, sby - 9, "100 m", { size: 12, anchor: "middle", fill: INK });
  // takeaway panel
  b += `<rect x='${W - 320}' y='${cy - 110}' width='300' height='150' fill='#1d2018' stroke='${GRID}' rx='6'/>`;
  b += T(W - 305, cy - 85, "THE MISMATCH", { size: 13, fill: AMBER, weight: 700 });
  b += T(W - 305, cy - 62, "Drawn soldier : 21 m", { size: 12.5, fill: RED });
  b += T(W - 305, cy - 43, "Real soldier  : 0.6 m", { size: 12.5, fill: INK });
  b += T(W - 305, cy - 20, "→ 36× too large at the", { size: 12.5, fill: SUB });
  b += T(W - 305, cy - 4, "   default zoom.", { size: 12.5, fill: SUB });
  b += T(W - 305, cy + 22, "A man is painted as wide", { size: 12, fill: SUB });
  b += T(W - 305, cy + 38, "as 2/3 of a compound.", { size: 12, fill: SUB });
  await emit("d1-footprints", W, H, b);
}

// ============ DIAGRAM 2 — squad dispersion: real vs rendered ============
async function d2() {
  const W = 760, H = 420, ppm = 0.7, K = 11;    // show the ppm-0.7 screen, magnified K× for the eye
  const stepPx = 5.5 * ppm * K;                 // 5.5 m dispersion on screen, magnified
  const figPx = figurePx(ppm) * K;              // figure diameter on screen, magnified
  const realPx = 0.6 * ppm * K;                 // real soldier on screen, magnified
  const x0 = 120, n = 9;
  let b = "";
  b += T(W / 2, 32, "SQUAD DISPERSION — GROUND TRUTH vs WHAT YOU SEE", { size: 17, weight: 700, anchor: "middle", fill: AMBER });
  b += T(W / 2, 53, `the model's real 5.5 m spacing, drawn at default zoom — magnified ${K}× so the eye can read it`, { size: 11.5, anchor: "middle", fill: SUB, style: "italic" });
  // lane A — ground truth
  let ay = 150;
  b += T(40, ay - 40, "GROUND TRUTH", { size: 13, fill: GREEN, weight: 700 });
  b += T(40, ay - 24, "9 men · 5.5 m apart", { size: 11.5, fill: SUB });
  for (let i = 0; i < n; i++) b += `<circle cx='${x0 + i * stepPx}' cy='${ay}' r='${Math.max(realPx / 2, 2)}' fill='${GREEN}'/>`;
  // span bar
  b += `<line x1='${x0}' y1='${ay + 26}' x2='${x0 + (n - 1) * stepPx}' y2='${ay + 26}' stroke='${SUB}' stroke-width='1'/>`;
  b += T(x0 + (n - 1) * stepPx / 2, ay + 41, "44 m of front — nine distinct soldiers", { size: 11.5, anchor: "middle", fill: SUB });
  // lane B — as rendered
  let by = 300;
  b += T(40, by - 56, "AS RENDERED", { size: 13, fill: RED, weight: 700 });
  b += T(40, by - 40, "default zoom (ppm 0.7)", { size: 11.5, fill: SUB });
  for (let i = 0; i < n; i++) b += `<circle cx='${x0 + i * stepPx}' cy='${by}' r='${figPx / 2}' fill='${RED}' opacity='0.30' stroke='${RED}' stroke-width='1'/>`;
  b += T(x0 + (n - 1) * stepPx / 2, by + figPx / 2 + 22, "figure (15 px) is 4× the 3.85 px gap → the nine men fuse into one blob", { size: 11.5, anchor: "middle", fill: RED });
  await emit("d2-dispersion", W, H, b);
}

// ============ DIAGRAM 3 — the clamp never lets a soldier look real ============
async function d3() {
  const W = 760, H = 420, mL = 70, mR = 40, mT = 70, mB = 70;
  const pw = W - mL - mR, ph = H - mT - mB;
  const ppms = [0.3, 0.5, 0.7, 1.0, 2.0, 4.0, 8.0];
  const fig = ppms.map((p) => ({ ppm: p, m: figurePx(p) / p }));
  const xmin = Math.log10(0.3), xmax = Math.log10(8);
  const ymin = Math.log10(0.5), ymax = Math.log10(60);
  const X = (ppm) => mL + (Math.log10(ppm) - xmin) / (xmax - xmin) * pw;
  const Y = (m) => mT + (1 - (Math.log10(m) - ymin) / (ymax - ymin)) * ph;
  let b = "";
  b += T(W / 2, 30, "THE CLAMP NEVER LETS A SOLDIER LOOK REAL", { size: 17, weight: 700, anchor: "middle", fill: AMBER });
  b += T(W / 2, 50, "ground width of the drawn soldier figure vs. zoom — it floors at 5 m and never reaches the 0.6 m truth", { size: 11.5, anchor: "middle", fill: SUB, style: "italic" });
  // gridlines + y labels
  for (const m of [1, 2, 5, 10, 20, 50]) { b += `<line x1='${mL}' y1='${Y(m)}' x2='${W - mR}' y2='${Y(m)}' stroke='${GRID}' stroke-width='1'/>`; b += T(mL - 8, Y(m) + 4, m + " m", { size: 11, anchor: "end", fill: SUB }); }
  for (const p of ppms) b += T(X(p), H - mB + 18, p + "", { size: 11, anchor: "middle", fill: SUB });
  b += T(W / 2, H - 14, "camera zoom  (pixels per metre →)", { size: 12, anchor: "middle", fill: SUB });
  // shaded gap between curve and reality
  let area = `M ${X(fig[0].ppm)} ${Y(fig[0].m)} `;
  for (const f of fig) area += `L ${X(f.ppm)} ${Y(f.m)} `;
  for (let i = fig.length - 1; i >= 0; i--) area += `L ${X(fig[i].ppm)} ${Y(0.6)} `;
  area += "Z";
  b += `<path d='${area}' fill='${RED}' opacity='0.12'/>`;
  // reality line
  b += `<line x1='${mL}' y1='${Y(0.6)}' x2='${W - mR}' y2='${Y(0.6)}' stroke='${GREEN}' stroke-width='2' stroke-dasharray='5 4'/>`;
  b += T(W - mR, Y(0.6) - 7, "a real soldier: 0.6 m", { size: 11.5, anchor: "end", fill: GREEN });
  // figure curve
  let poly = fig.map((f) => `${X(f.ppm)},${Y(f.m)}`).join(" ");
  b += `<polyline points='${poly}' fill='none' stroke='${RED}' stroke-width='2.5'/>`;
  for (const f of fig) {
    b += `<circle cx='${X(f.ppm)}' cy='${Y(f.m)}' r='3.5' fill='${RED}'/>`;
    const first = f.ppm === 0.3;
    b += T(X(f.ppm) + (first ? 9 : 0), Y(f.m) + (first ? 4 : -9), f.m.toFixed(0) + "m", { size: 10.5, anchor: first ? "start" : "middle", fill: INK });
  }
  // default-zoom marker
  b += `<line x1='${X(0.7)}' y1='${mT}' x2='${X(0.7)}' y2='${H - mB}' stroke='${AMBER}' stroke-width='1' stroke-dasharray='2 3'/>`;
  b += T(X(0.7) + 5, mT + 14, "default zoom", { size: 11, fill: AMBER });
  await emit("d3-clamp-curve", W, H, b);
}

// ============ DIAGRAM 4 — model vs real scorecard ============
async function d4() {
  const ORANGE = "#d98a3d";
  const CAT = { render: AMBER, sim: RED, org: ORANGE, match: GREEN };
  const rows = [
    { label: "Buildings drawn per village", model: "1 compound", real: "~90 houses", factor: 90, cat: "render+sim", c: RED },
    { label: "Soldier size on map (default zoom)", model: "≈21 m", real: "0.6 m", factor: 36, cat: "render", c: AMBER },
    { label: "Valley length (along-axis)", model: "2.56 km", real: "~9.7 km", factor: 3.8, cat: "sim", c: RED },
    { label: "Valley floor width (too WIDE)", model: "2.56 km", real: "~0.75 km", factor: 3.4, cat: "sim", c: RED },
    { label: "Weapons squad", model: "3", real: "9", factor: 3.0, cat: "org", c: ORANGE },
    { label: "COP wall extent (small OP)", model: "~220 m", real: "~85 m", factor: 2.6, cat: "sim", c: RED },
    { label: "Squad dispersion (in 1–10 m band)", model: "5.5 m", real: "~10 m", factor: 1.8, cat: "match", c: GREEN },
    { label: "Max engagement range", model: "620 m", real: "~800 m", factor: 1.3, cat: "match", c: GREEN },
    { label: "Platoon strength", model: "35", real: "39–42", factor: 1.2, cat: "org", c: ORANGE },
    { label: "Ridge crest elevation", model: "2,780 m", real: "2,854 m", factor: 1.03, cat: "match", c: GREEN },
    { label: "Valley floor elevation", model: "1,550 m", real: "~1,500 m", factor: 1.03, cat: "match", c: GREEN },
    { label: "Rifle squad size", model: "9", real: "9", factor: 1.0, cat: "match", c: GREEN },
  ];
  const W = 900, H = 560, x0 = 268, barW = 360, top = 96, rh = 33;
  const L = (f) => Math.log10(Math.max(f, 1)) / Math.log10(100) * barW;
  let b = "";
  b += T(W / 2, 32, "MODEL vs REALITY — THE SCALE SCORECARD", { size: 19, weight: 700, anchor: "middle", fill: AMBER });
  b += T(W / 2, 53, "how many times each dimension is off from the real Korengal — bars on a log scale", { size: 12.5, anchor: "middle", fill: SUB, style: "italic" });
  // authentic zone
  b += `<rect x='${x0}' y='${top - 8}' width='${L(1.3)}' height='${rows.length * rh + 6}' fill='${GREEN}' opacity='0.07'/>`;
  // gridlines
  for (const f of [1, 2, 5, 10, 50, 100]) { const x = x0 + L(f); b += `<line x1='${x}' y1='${top - 8}' x2='${x}' y2='${top + rows.length * rh}' stroke='${GRID}' stroke-width='1'/>`; b += T(x, top - 14, f + "×", { size: 10.5, anchor: "middle", fill: SUB }); }
  rows.forEach((r, i) => {
    const y = top + i * rh + rh / 2;
    b += T(x0 - 12, y + 4, r.label, { size: 12, anchor: "end", fill: INK });
    b += `<rect x='${x0}' y='${y - 7}' width='${Math.max(L(r.factor), 2)}' height='14' rx='3' fill='${r.c}' opacity='0.85'/>`;
    const tx = x0 + Math.max(L(r.factor), 2) + 8;
    const ftxt = r.cat === "match" ? "✓ authentic" : r.factor.toFixed(r.factor < 2 ? 2 : 1) + "× off";
    b += T(tx, y + 4, `${ftxt}   ·   ${r.model} → ${r.real}`, { size: 11, fill: r.cat === "match" ? GREEN : INK });
  });
  // legend
  let lx = x0, ly = H - 26;
  const leg = [["RENDER (cheap fix)", AMBER], ["SIM-GEOMETRY", RED], ["ORG", ORANGE], ["ALREADY AUTHENTIC", GREEN]];
  for (const [t, c] of leg) { b += `<rect x='${lx}' y='${ly - 9}' width='12' height='12' rx='2' fill='${c}'/>`; b += T(lx + 17, ly + 1, t, { size: 11, fill: SUB }); lx += 17 + t.length * 7.2 + 18; }
  await emit("d4-scorecard", W, H, b);
}

// ============ DIAGRAM 5 — valley shape: the map is one segment ============
async function d5() {
  const W = 860, H = 380, S = 0.066;          // px per metre
  const realL = 9700 * S, realW = 750 * S;    // real valley ~9.7 km x ~0.75 km floor
  const mod = 2560 * S;                        // model 2.56 km square
  const cy = 210, lx = 70;
  let b = "";
  b += T(W / 2, 32, "THE MAP IS ONE SEGMENT OF A LONG, NARROW VALLEY", { size: 18, weight: 700, anchor: "middle", fill: AMBER });
  b += T(W / 2, 53, "real Korengal floor (≈10:1 slot) vs the game's 2.56 km square, drawn to one scale", { size: 12.5, anchor: "middle", fill: SUB, style: "italic" });
  // real valley floor — long thin bar
  b += `<rect x='${lx}' y='${cy - realW / 2}' width='${realL}' height='${realW}' rx='6' fill='${GREEN}' opacity='0.16' stroke='${GREEN}' stroke-width='1.5'/>`;
  b += T(lx + realL, cy - realW / 2 - 9, "REAL KORENGAL: ~9.7 km × ~0.5–1.0 km", { size: 12, anchor: "end", fill: GREEN });
  // model square overlaid near the south end
  const mx = lx + 20;
  b += `<rect x='${mx}' y='${cy - mod / 2}' width='${mod}' height='${mod}' fill='${RED}' opacity='0.14' stroke='${RED}' stroke-width='2' stroke-dasharray='5 4'/>`;
  b += T(mx + mod / 2, cy - mod / 2 - 10, "GAME MAP", { size: 12.5, anchor: "middle", fill: RED, weight: 700 });
  b += T(mx + mod / 2, cy + mod / 2 + 18, "2.56 km square", { size: 11.5, anchor: "middle", fill: RED });
  // bracket: covered length
  b += `<line x1='${mx}' y1='${cy + mod / 2 + 30}' x2='${mx + mod}' y2='${cy + mod / 2 + 30}' stroke='${SUB}' stroke-width='1'/>`;
  b += T(mx + mod / 2, cy + mod / 2 + 45, "≈ 1 / 3.8 of the valley's length", { size: 11, anchor: "middle", fill: SUB });
  // scale bar 1 km
  const sbx = lx, sby = H - 30, sb = 1000 * S;
  b += `<line x1='${sbx}' y1='${sby}' x2='${sbx + sb}' y2='${sby}' stroke='${INK}' stroke-width='2'/>`;
  b += `<line x1='${sbx}' y1='${sby - 4}' x2='${sbx}' y2='${sby + 4}' stroke='${INK}' stroke-width='2'/>`;
  b += `<line x1='${sbx + sb}' y1='${sby - 4}' x2='${sbx + sb}' y2='${sby + 4}' stroke='${INK}' stroke-width='2'/>`;
  b += T(sbx + sb + 8, sby + 4, "1 km", { size: 11, fill: INK });
  b += T(W - 20, H - 14, "note: the model's floor gradient also runs the wrong way (real Korengal drains north)", { size: 10.5, anchor: "end", fill: SUB, style: "italic" });
  await emit("d5-valley-shape", W, H, b);
}

await d1(); await d2(); await d3(); await d4(); await d5();
console.log("DONE diagrams");
