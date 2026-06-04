// Extract authored SVG assets from a workflow output file into docs/visual-overhaul/assets/.
// Writes <id>.svg for each asset and merges {anchor,footprint,rotating,family} into _meta.json.
//   node scripts/extract-assets.mjs <workflow-output.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const f = process.argv[2];
if (!f) { console.error("usage: node scripts/extract-assets.mjs <output.json>"); process.exit(1); }
const dir = "docs/visual-overhaul/assets";
const metaPath = join(dir, "_meta.json");

const raw = JSON.parse(readFileSync(f, "utf8"));
const assets = (raw.result && raw.result.assets) || raw.assets || [];
if (!assets.length) { console.error("no assets found in", f); process.exit(1); }

let meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
let written = 0, bad = 0;
const ids = [];
for (const a of assets) {
  if (!a.id || !a.svg) { bad++; continue; }
  let svg = a.svg.trim();
  // sanity: must be an <svg> with a viewBox
  if (!/^<svg[\s>]/.test(svg) || !/viewBox/.test(svg)) { console.warn("  ! suspicious svg:", a.id); bad++; }
  writeFileSync(join(dir, a.id + ".svg"), svg + "\n");
  meta[a.id] = {
    anchor: a.anchor || [0.5, 0.5],
    footprint: a.footprint ?? null,
    rotating: !!a.rotating,
    family: a.family || null,
  };
  ids.push(a.id);
  written++;
}
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
console.log(`extracted ${written} assets (${bad} flagged) from ${f}`);
console.log("ids:", ids.join(", "));
