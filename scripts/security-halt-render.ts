/**
 * Render a before/after diagram of the 360° security-halt ASSIGNMENT — the clearest proof of
 * the "stuck on each other" fix. Both panels start from the same strung-out squad file; the
 * lines are each man's straight path to his assigned ring slot.
 *
 *   BEFORE (raw member index, a=(i/n)·2π+0.4): roster order has no relation to where men are,
 *          so the lines CROSS the formation — a man on one side is sent to the far slot.
 *   AFTER  (bearing-optimal, rotate the ring against the men sorted by current bearing to
 *          minimise total angular travel): each man peels to his NEAREST sector — no crossings.
 *
 * Pure geometry (no simulation), so it isolates the assignment. Run:
 *   npx tsx scripts/security-halt-render.ts [seed] [out.png]
 */
import sharp from "sharp";
import { createWorld } from "../lib/sim/world";

const seed = process.argv[2] ?? "smoke-test";
const out = process.argv[3] ?? "docs/progress/2026-06-06-movement-realism/security-halt-before-after.png";
const R = 14;
const cs = 5;

const w: any = createWorld(seed, 60);
const t = w.terrain;
const cop = t.cop;
const axis = { x: cop.gateDir.x, y: cop.gateDir.y };
const perp = { x: -axis.y, y: axis.x };
const scn = t.nearestPassable(Math.round(cop.center.cx + axis.x * (cop.radius + 30)), Math.round(cop.center.cy + axis.y * (cop.radius + 30)), 26);
const stage = t.cellCenter(scn.cx, scn.cy);

const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
const ids: string[] = sq.memberIds.slice();
const men = ids.map((id) => w.sim.unit(id));
// place the squad in a strung-out file (same as the harness)
const start = men.map((u: any, i: number) => {
  const along = (i - (men.length - 1) / 2) * 5;
  const lat = (((i * 37) % 7) - 3) * 0.5;
  return { x: stage.x - axis.x * along + perp.x * lat, y: stage.y - axis.y * along + perp.y * lat };
});
const center = start.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
center.x /= men.length;
center.y /= men.length;
const n = men.length;

// BEFORE — raw index ring
const beforeSlots = start.map((_, i) => {
  const a = (i / n) * Math.PI * 2 + 0.4;
  return { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R };
});

// AFTER — bearing-optimal near-side assignment (the real holdSecurity algorithm)
const bm = start.map((p, i) => ({ i, a: Math.atan2(p.y - center.y, p.x - center.x) })).sort((p, q) => p.a - q.a);
const slotA = Array.from({ length: n }, (_, k) => (k / n) * Math.PI * 2);
let bestR = 0;
let bestCost = Infinity;
const adiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
for (let r = 0; r < n; r++) {
  let cost = 0;
  for (let i = 0; i < n; i++) cost += Math.abs(adiff(bm[i].a, slotA[(i + r) % n]));
  if (cost < bestCost) {
    bestCost = cost;
    bestR = r;
  }
}
const afterSlots: { x: number; y: number }[] = new Array(n);
for (let i = 0; i < n; i++) {
  const a = slotA[(i + bestR) % n];
  afterSlots[bm[i].i] = { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R };
}

// count crossings (segments start[i]→slot[i] that intersect)
function cross(p1: any, p2: any, p3: any, p4: any): boolean {
  const d = (a: any, b: any, c: any) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function crossings(slots: any[]): number {
  let c = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (cross(start[i], slots[i], start[j], slots[j])) c++;
  return c;
}
const beforeX = crossings(beforeSlots);
const afterX = crossings(afterSlots);

// ---- SVG ----
const PW = 360, PH = 360, GAP = 30, M = 30;
const W = PW * 2 + GAP;
const H = PH + 64;
// world→panel transform (center the perimeter)
const span = R * 2 + 70; // m visible
const sc = (PW - M * 2) / span;
const px = (wx: number, ox: number) => ox + (PW - M * 2) / 2 + (wx - center.x) * sc + M;
const py = (wy: number) => 40 + (PH - M * 2) / 2 + (wy - center.y) * sc + M;

function panel(slots: any[], ox: number, title: string, xCount: number, good: boolean) {
  let s = `<text x="${ox + PW / 2}" y="26" fill="#cdd6c2" font-size="15" font-family="monospace" text-anchor="middle">${title}</text>`;
  s += `<text x="${ox + PW / 2}" y="${H - 14}" fill="${good ? "#7fd17f" : "#e08a8a"}" font-size="13" font-family="monospace" text-anchor="middle">path crossings: ${xCount}</text>`;
  // perimeter circle
  s += `<circle cx="${px(center.x, ox)}" cy="${py(center.y)}" r="${R * sc}" fill="none" stroke="#3a4433" stroke-dasharray="4 4"/>`;
  s += `<circle cx="${px(center.x, ox)}" cy="${py(center.y)}" r="2.5" fill="#5a6650"/>`;
  // assignment lines (red = this man's path crosses another's)
  for (let i = 0; i < n; i++) {
    let crossed = false;
    for (let j = 0; j < n; j++) if (j !== i && cross(start[i], slots[i], start[j], slots[j])) { crossed = true; break; }
    s += `<line x1="${px(start[i].x, ox)}" y1="${py(start[i].y)}" x2="${px(slots[i].x, ox)}" y2="${py(slots[i].y)}" stroke="${crossed ? "#e0707088" : "#6a8a6a88"}" stroke-width="${crossed ? 2 : 1.3}"/>`;
  }
  // start positions (the file) — hollow gray
  for (let i = 0; i < n; i++) s += `<circle cx="${px(start[i].x, ox)}" cy="${py(start[i].y)}" r="3" fill="none" stroke="#8a8a7a" stroke-width="1.2"/>`;
  // slot positions (men, facing out) — filled, with an outward facing tick
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(slots[i].y - center.y, slots[i].x - center.x);
    const fx = px(slots[i].x, ox) + Math.cos(a) * 9, fy = py(slots[i].y) + Math.sin(a) * 9;
    s += `<line x1="${px(slots[i].x, ox)}" y1="${py(slots[i].y)}" x2="${fx}" y2="${fy}" stroke="#c8b86a" stroke-width="2"/>`;
    s += `<circle cx="${px(slots[i].x, ox)}" cy="${py(slots[i].y)}" r="4.5" fill="#3d5a3d" stroke="#9ec79e" stroke-width="1.3"/>`;
  }
  return s;
}

const beforePanel = panel(beforeSlots, 0, "BEFORE - raw member-index ring", beforeX, false);
const afterPanel = panel(afterSlots, PW + GAP, "AFTER - bearing-optimal near-side", afterX, true);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#14160f"/>
${beforePanel}${afterPanel}
<text x="${W / 2}" y="${H - 14}" fill="#5a6650" font-size="10" font-family="monospace" text-anchor="middle"> </text>
</svg>`;

sharp(Buffer.from(svg), { density: 200 })
  .png()
  .toFile(out)
  .then(() => console.log(`rendered ${out}  (before crossings=${beforeX}, after crossings=${afterX})`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
