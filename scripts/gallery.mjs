// Build public/_dev/assets.json from a directory of .svg files (+ optional _meta.json).
// Usage: node scripts/gallery.mjs <svgDir> [outJson]
//   _meta.json (optional, in svgDir): { "asset-id": { "anchor":[0.5,0.5], "footprint":1.4, "rotating":true }, ... }
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const svgDir = process.argv[2];
const out = process.argv[3] || "public/_dev/assets.json";
if (!svgDir) { console.error("usage: node scripts/gallery.mjs <svgDir> [outJson]"); process.exit(1); }

let meta = {};
const metaPath = join(svgDir, "_meta.json");
if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8"));

const files = readdirSync(svgDir).filter((f) => f.endsWith(".svg")).sort();
const list = files.map((f) => {
  const id = basename(f, ".svg");
  const svg = readFileSync(join(svgDir, f), "utf8").trim();
  const m = meta[id] || {};
  return {
    id,
    svg,
    anchor: m.anchor || [0.5, 0.5],
    footprint: m.footprint ?? null,
    rotating: !!m.rotating,
    family: m.family || null,
  };
});
writeFileSync(out, JSON.stringify(list, null, 0));
console.log(`wrote ${out} with ${list.length} assets from ${svgDir}`);
