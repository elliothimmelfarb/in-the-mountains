/**
 * scratch-cop-men — top-down COP render WITH the settled garrison drawn, so we can SEE the
 * "soldiers too close together / stuck on buildings" the owner reported. Forks cop-render and
 * adds: a combat-free settle (director off), men dots coloured by brainState, a state
 * histogram, and a crowding number (peak men with another man within 3 m) in the title.
 *
 * Run: npx tsx scripts/scratch-cop-men.ts [seed] [out.png] [settleSeconds]
 */
import sharp from "sharp";
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const seed = process.argv[2] ?? "valley-2533";
const out = process.argv[3] ?? `/private/tmp/cop-men-${seed}.png`;
const SETTLE = Number(process.argv[4] ?? 1400);

const w: any = createWorld(seed, 60);
w.state.enemyStrengthAbs = 0; // no director — pure garrison
const t = w.terrain;
const cs = t.cellSize;
const cop = t.cop;
const R = cop.radius;
const c = cop.center;
const center = w.copWorld();
const wire = R * cs;

// settle the garrison (combat-free, cheap)
for (let k = 0; k < Math.round(SETTLE / 0.5); k++) w.tick(0.5);

const men = w.platoon.members.filter((m: any) => m.alive && Math.hypot(m.pos.x - center.x, m.pos.y - center.y) < wire + 8);

// crowding number + state histogram
let bunch = 0;
for (let i = 0; i < men.length; i++)
  for (let j = i + 1; j < men.length; j++)
    if (Math.hypot(men[i].pos.x - men[j].pos.x, men[i].pos.y - men[j].pos.y) < 3) { bunch++; break; }
const hist: Record<string, number> = {};
for (const m of men) hist[m.brainState ?? "?"] = (hist[m.brainState ?? "?"] ?? 0) + 1;
const histStr = Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
const hour = Math.floor((w.secondsOfDay ?? 0) / 3600);

const pad = 4;
const lo = { cx: c.cx - R - pad, cy: c.cy - R - pad };
const hi = { cx: c.cx + R + pad, cy: c.cy + R + pad };
const cols = hi.cx - lo.cx + 1;
const rows = hi.cy - lo.cy + 1;
const PX = 14;
const M = 30;
const W = cols * PX + M * 2;
const H = rows * PX + M * 2 + 40;
const toPx = (cx: number, cy: number) => ({ x: M + (cx - lo.cx + 0.5) * PX, y: M + (cy - lo.cy + 0.5) * PX });

const cells: string[] = [];
for (let cy = lo.cy; cy <= hi.cy; cy++)
  for (let cx = lo.cx; cx <= hi.cx; cx++) {
    if (!t.inBounds(cx, cy)) continue;
    const l = t.land[t.idx(cx, cy)] as Land;
    const px = M + (cx - lo.cx) * PX;
    const py = M + (cy - lo.cy) * PX;
    let fill = "#1c1f17";
    const d = Math.hypot(cx - c.cx, cy - c.cy);
    if (l === Land.Hesco) fill = "#7a6a44";
    else if (l === Land.Structure) fill = "#4a4a4a";
    else if (l === Land.CompoundWall) fill = "#5a4a3a";
    else if (l === Land.Cliff) fill = "#101010";
    else if (l === Land.River || l === Land.Ford) fill = "#2a4a6a";
    else if (d <= R) {
      const pass = t.passableCell(cx, cy);
      if (!pass) fill = "#332b22";
      else if (l === Land.Gravel || l === Land.Track || l === Land.Trail) fill = "#6b6450";
      else fill = "#3f4a34";
    } else if (l === Land.Gravel || l === Land.Track || l === Land.Trail) fill = "#46412f";
    cells.push(`<rect x="${px}" y="${py}" width="${PX}" height="${PX}" fill="${fill}" stroke="#0c0e08" stroke-width="0.4"/>`);
  }

const overlays: string[] = [];
for (const b of cop.buildings) {
  const p = toPx(b.cx, b.cy);
  overlays.push(`<text x="${p.x}" y="${p.y}" fill="#d8d2c0" font-size="7" font-family="monospace" text-anchor="middle" dominant-baseline="middle">${(b.label ?? b.kind).slice(0, 8)}</text>`);
}
const stateColor: Record<string, string> = {
  rest: "#5aa0ff", garrison: "#46c7d6", guard: "#e08a3a", detail: "#e8c84a",
  toc: "#b06ad6", chow: "#7ad67a", aid: "#ffffff", manning: "#ff5a5a", standto: "#ff5a5a", returning: "#999999",
};
for (const m of men) {
  const p = toPx(m.pos.x / cs - 0.5, m.pos.y / cs - 0.5);
  const col = stateColor[m.brainState ?? "?"] ?? "#dddddd";
  overlays.push(`<circle cx="${p.x}" cy="${p.y}" r="3" fill="${col}" stroke="#0c0e08" stroke-width="0.6"/>`);
}

const title = `COP ${seed} R=${R}c(${R * cs}m)  ${men.length} men  hour=${hour}:00  BUNCH(&lt;3m)=${bunch}`;
const legend = `${histStr}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0c0e08"/>
<text x="${W / 2}" y="18" fill="#cdd6c2" font-size="12" font-family="monospace" text-anchor="middle">${title}</text>
${cells.join("")}
${overlays.join("")}
<text x="${W / 2}" y="${H - 8}" fill="#8a9080" font-size="9" font-family="monospace" text-anchor="middle">${legend}</text>
</svg>`;

sharp(Buffer.from(svg), { density: 160 }).png().toFile(out)
  .then(() => console.log(`${seed}: ${men.length} men, hour ${hour}, BUNCH(<3m)=${bunch}  [${histStr}]  -> ${out}`))
  .catch((e) => { console.error(e); process.exit(1); });
