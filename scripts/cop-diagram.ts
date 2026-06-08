/**
 * Report diagrams for the COP overhaul:
 *   1) cop-sectors.png — an annotated top-down tactical diagram: the HESCO wire, the buildings,
 *      and every crew-served position's INTERLOCKING SECTOR OF FIRE, the wedge length scaled to
 *      its avenue score so you can SEE why the .50 sits on the longest open avenue and the Mk19
 *      over the worst dead ground. Plus the mortar pit and the registered FPF point.
 *   2) cop-avenues.png — a bar chart of each position's avenue reach + dead-space, colour-coded by
 *      the weapon the terrain analysis sited there: the data that drives the doctrine siting.
 *
 * Run: npx tsx scripts/cop-diagram.ts [seed]
 */
import sharp from "sharp";
import { createWorld } from "../lib/sim/world";

const seed = process.argv[2] ?? "valley-2533";
const w: any = createWorld(seed, 60);
const cop = w.terrain.cop;
const cs = w.terrain.cellSize;

const WEAPON_COLOR: Record<string, string> = { m2: "#e0a72b", m240: "#78aaeb", mk19: "#78d28c", rifle: "#8a93a3" };
const WEAPON_NAME: Record<string, string> = { m2: "M2 .50 cal", m240: "M240B", mk19: "Mk19 AGL", rifle: "Riflemen" };

async function main() {
// ---------- diagram 1: sectors of fire ----------
{
  const W = 1040, H = 780;
  const cxp = W / 2, cyp = H / 2 + 14;
  const R = cop.radius; // cells
  const view = R + 17; // cells from center shown to each side
  const sc = (H - 150) / (2 * view); // px per cell
  const X = (cx: number) => cxp + (cx - cop.center.cx) * sc;
  const Y = (cy: number) => cyp + (cy - cop.center.cy) * sc;
  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="#13150e"/>`);
  el.push(`<text x="28" y="44" fill="#e8e5d4" font-family="monospace" font-size="24" font-weight="bold">COP SECTORS OF FIRE — sited by terrain (seed ${seed})</text>`);
  el.push(`<text x="28" y="70" fill="#9a9788" font-family="monospace" font-size="14">Each crew-served weapon takes the avenue the ground gives it · wedge length ∝ how far it grazes before dead space</text>`);

  // wire ring (HESCO)
  el.push(`<circle cx="${cxp}" cy="${cyp}" r="${R * sc}" fill="none" stroke="#9a8a60" stroke-width="9" stroke-opacity="0.55"/>`);
  el.push(`<circle cx="${cxp}" cy="${cyp}" r="${R * sc}" fill="none" stroke="#5a4f34" stroke-width="9" stroke-dasharray="3 7" stroke-opacity="0.6"/>`);

  // gate gap marker
  const ga = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  el.push(`<circle cx="${cxp + Math.cos(ga) * R * sc}" cy="${cyp + Math.sin(ga) * R * sc}" r="11" fill="#13150e" stroke="#e0a72b" stroke-width="2"/>`);
  el.push(`<text x="${cxp + Math.cos(ga) * (R + 2.2) * sc}" y="${cyp + Math.sin(ga) * (R + 2.2) * sc + 4}" fill="#e0a72b" font-family="monospace" font-size="12" text-anchor="middle">ECP</text>`);

  // buildings
  for (const b of cop.buildings) {
    const x = X(b.cx - b.hw), y = Y(b.cy - b.hh), bw = (b.hw * 2 + 1) * sc, bh = (b.hh * 2 + 1) * sc;
    el.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#3a3c34" stroke="#23251e" stroke-width="1" rx="2"/>`);
  }

  // sector wedges + positions
  const maxAv = Math.max(120, ...cop.fightingPositions.map((f: any) => f.avenueScore));
  for (const f of cop.fightingPositions) {
    const col = WEAPON_COLOR[f.weapon];
    const px = X(f.cx), py = Y(f.cy);
    if (f.weapon !== "rifle") {
      const reach = Math.min(1.0, 0.45 + 0.55 * (f.avenueScore / maxAv)) * R * sc; // longer avenue → longer wedge, capped to stay in frame
      const x1 = px + Math.cos(f.rightLimit) * reach, y1 = py + Math.sin(f.rightLimit) * reach;
      const x2 = px + Math.cos(f.leftLimit) * reach, y2 = py + Math.sin(f.leftLimit) * reach;
      const large = (f.leftLimit - f.rightLimit) > Math.PI ? 1 : 0;
      el.push(`<path d="M ${px} ${py} L ${x1} ${y1} A ${reach} ${reach} 0 ${large} 1 ${x2} ${y2} Z" fill="${col}" fill-opacity="0.13" stroke="${col}" stroke-opacity="0.6" stroke-width="1.5"/>`);
    }
    const isTower = f.tower;
    el.push(`<circle cx="${px}" cy="${py}" r="${isTower ? 7 : 5}" fill="${col}" stroke="#13150e" stroke-width="1.5"/>`);
    if (f.weapon !== "rifle") {
      // label offset outward, clear of the wire
      const lx = px + Math.cos(f.facing) * 40, ly = py + Math.sin(f.facing) * 40;
      el.push(`<text x="${lx}" y="${ly}" fill="${col}" font-family="monospace" font-size="13" font-weight="bold" text-anchor="middle">${WEAPON_NAME[f.weapon]}</text>`);
      el.push(`<text x="${lx}" y="${ly + 15}" fill="#9a9788" font-family="monospace" font-size="11" text-anchor="middle">${Math.round(f.avenueScore)} m · ${Math.round(f.deadSpaceFrac * 100)}% dead</text>`);
    }
  }

  // mortar pit
  const mp = { x: X(cop.mortarPit.cx), y: Y(cop.mortarPit.cy) };
  el.push(`<circle cx="${mp.x}" cy="${mp.y}" r="9" fill="none" stroke="#c8b48a" stroke-width="2.5" stroke-dasharray="3 3"/>`);
  el.push(`<text x="${mp.x}" y="${mp.y + 3}" fill="#c8b48a" font-family="monospace" font-size="10" text-anchor="middle">▲</text>`);
  el.push(`<text x="${mp.x}" y="${mp.y - 14}" fill="#c8b48a" font-family="monospace" font-size="11" text-anchor="middle">MORTAR PIT</text>`);

  // FPF point
  const fp = { x: X(cop.fpf.cx), y: Y(cop.fpf.cy) };
  el.push(`<text x="${fp.x}" y="${fp.y + 5}" fill="#d0473a" font-family="monospace" font-size="18" text-anchor="middle" font-weight="bold">✕</text>`);
  el.push(`<text x="${fp.x}" y="${fp.y - 12}" fill="#d0473a" font-family="monospace" font-size="11" text-anchor="middle">FPF</text>`);

  // legend
  const lx0 = 30, ly0 = H - 44;
  const items = [["m2", "M2 .50 — longest avenue"], ["m240", "M240B — next-longest"], ["mk19", "Mk19 — worst dead space"], ["rifle", "riflemen fill the rest"]];
  items.forEach(([k, t], i) => {
    const x = lx0 + i * 250;
    el.push(`<rect x="${x}" y="${ly0 - 11}" width="13" height="13" fill="${WEAPON_COLOR[k]}" rx="2"/>`);
    el.push(`<text x="${x + 20}" y="${ly0}" fill="#c9c6b6" font-family="monospace" font-size="12">${t}</text>`);
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${el.join("")}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile("docs/progress/2026-06-08-cop-overhaul/after/cop-sectors.png");
  console.log("wrote cop-sectors.png");
}

// ---------- diagram 2: avenue / dead-space bars ----------
{
  const fps = [...cop.fightingPositions].sort((a: any, b: any) => b.avenueScore - a.avenueScore);
  const W = 1040, H = 120 + fps.length * 54;
  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="#13150e"/>`);
  el.push(`<text x="28" y="44" fill="#e8e5d4" font-family="monospace" font-size="24" font-weight="bold">WHY THE GUNS SIT WHERE THEY DO (seed ${seed})</text>`);
  el.push(`<text x="28" y="70" fill="#9a9788" font-family="monospace" font-size="14">A terrain LOS sweep scores each position; the .50 takes the longest reach, the Mk19 the worst dead ground.</text>`);
  const x0 = 230, barW = 620;
  const maxAv = Math.max(...fps.map((f: any) => f.avenueScore), 100);
  fps.forEach((f: any, i: number) => {
    const y = 100 + i * 54;
    const col = WEAPON_COLOR[f.weapon];
    el.push(`<text x="28" y="${y + 14}" fill="${col}" font-family="monospace" font-size="14" font-weight="bold">${(WEAPON_NAME[f.weapon] || f.weapon)}</text>`);
    el.push(`<text x="28" y="${y + 30}" fill="#73706a" font-family="monospace" font-size="11">${f.id}${f.tower ? " · tower" : ""}</text>`);
    // avenue bar
    const aw = (f.avenueScore / maxAv) * barW;
    el.push(`<rect x="${x0}" y="${y}" width="${barW}" height="16" fill="#23251e"/>`);
    el.push(`<rect x="${x0}" y="${y}" width="${aw}" height="16" fill="${col}"/>`);
    el.push(`<text x="${x0 + barW + 8}" y="${y + 13}" fill="#c9c6b6" font-family="monospace" font-size="12">${Math.round(f.avenueScore)} m reach</text>`);
    // dead-space bar
    const dw = f.deadSpaceFrac * barW;
    el.push(`<rect x="${x0}" y="${y + 22}" width="${barW}" height="10" fill="#23251e"/>`);
    el.push(`<rect x="${x0}" y="${y + 22}" width="${dw}" height="10" fill="#6b4a44"/>`);
    el.push(`<text x="${x0 + barW + 8}" y="${y + 31}" fill="#9a8a86" font-family="monospace" font-size="11">${Math.round(f.deadSpaceFrac * 100)}% dead space</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${el.join("")}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile("docs/progress/2026-06-08-cop-overhaul/after/cop-avenues.png");
  console.log("wrote cop-avenues.png");
}
}
main();
