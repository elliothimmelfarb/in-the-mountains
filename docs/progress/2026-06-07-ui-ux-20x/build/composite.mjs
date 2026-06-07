// Build the archive chapter hero (before/after HUD, vertical split) from the captured shots.
import sharp from "sharp";
const DIR = "docs/progress/2026-06-07-ui-ux-20x/shots";
const W = 1440, half = 452, gap = 6, H = half * 2 + gap;
function lab(text, color) {
  return Buffer.from(`<svg width="210" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="210" height="40" rx="3" fill="#0c0d0a" stroke="${color}" stroke-width="2"/><text x="105" y="27" font-family="monospace" font-size="20" font-weight="bold" fill="${color}" text-anchor="middle" letter-spacing="3">${text}</text></svg>`);
}
const after = await sharp(`${DIR}/hud-after.png`).resize(W, half, { fit: "cover", position: "top" }).toBuffer();
const before = await sharp(`${DIR}/hud-baseline.png`).resize(W, half, { fit: "cover", position: "top" }).toBuffer();
await sharp({ create: { width: W, height: H, channels: 4, background: { r: 12, g: 13, b: 10, alpha: 1 } } })
  .composite([
    { input: after, top: 0, left: 0 },
    { input: before, top: half + gap, left: 0 },
    { input: lab("AFTER", "#6fae54"), top: 14, left: 14 },
    { input: lab("BEFORE", "#b5532a"), top: half + gap + 14, left: 14 },
  ]).png().toFile("public/manual/archive/assets/2026-06-08-ui-ux.png");
console.log("wrote archive thumbnail");
