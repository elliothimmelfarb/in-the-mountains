// Render an SVG to a PNG at native size (full-page diagrams, not sprite sheets).
//   node docs/progress/2026-06-07-realism-research/tools/svgrender.mjs <in.svg> <out.png>
import sharp from "sharp";
import { readFileSync } from "node:fs";
const [, , inp, out] = process.argv;
const svg = readFileSync(inp, "utf8");
await sharp(Buffer.from(svg), { density: 192 }).png().toFile(out);
console.log("wrote", out);
