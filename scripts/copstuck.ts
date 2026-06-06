/**
 * COP building-stuck audit. Turns "one squad is getting stuck on buildings in the COP"
 * into a hard number, headless, per seed.
 *
 * Method: create the world, let the platoon live in the COP (garrison + director), and
 * every tick measure, for each soldier inside the wire:
 *   - GRIND tick: the integrator could not advance freely (u.moving && u.speed≈0, i.e.
 *     blocked this tick) AND the soldier is adjacent to a solid building (Land.Structure).
 *     This is the exact signature of a man grinding against a b-hut wall.
 *   - net displacement over the run (to catch a man pinned in place).
 *
 * We attribute every grind to the soldier's squad, his brainState (what garrison ordered),
 * and the nearest building, then print the worst offenders and a per-squad / per-building
 * tally. A clean COP is ~0 grind ticks; a "stuck squad" lights up one squad's row.
 *
 * Run: npx tsx scripts/copstuck.ts [seed] [seconds]
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const seed = process.argv[2] ?? "valley-2533";
const SECONDS = Number(process.argv[3] ?? 1200);
const dt = 0.2;
const TICKS = Math.round(SECONDS / dt);

const w: any = createWorld(seed, 60);
const t = w.terrain;
const cop = t.cop;
const cs = t.cellSize;
const center = w.copWorld();
const wire = cop.radius * cs;

// member id -> squad id
const squadOf = new Map<string, string>();
for (const sq of w.platoon.squads) for (const id of sq.memberIds) squadOf.set(id, sq.id);

function adjStructure(px: number, py: number): boolean {
  const cx = Math.floor(px / cs);
  const cy = Math.floor(py / cs);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (t.inBounds(x, y) && (t.land[t.idx(x, y)] as Land) === Land.Structure) return true;
    }
  return false;
}
function nearestBuilding(px: number, py: number): string {
  let best = "?";
  let bd = Infinity;
  for (const b of cop.buildings) {
    const bx = (b.cx + 0.5) * cs;
    const by = (b.cy + 0.5) * cs;
    const d = Math.hypot(px - bx, py - by);
    if (d < bd) {
      bd = d;
      best = b.label ?? b.kind;
    }
  }
  return best;
}

type Rec = {
  id: string;
  squad: string;
  grind: number; // grind ticks
  maxRun: number; // longest consecutive grind streak (ticks)
  run: number;
  states: Record<string, number>;
  bld: Record<string, number>;
  start: { x: number; y: number };
  travelled: number;
  last: { x: number; y: number };
  net: number;
};
const rec = new Map<string, Rec>();
for (const m of w.platoon.members) {
  rec.set(m.id, {
    id: m.id,
    squad: squadOf.get(m.id) ?? "hq/wpn",
    grind: 0,
    maxRun: 0,
    run: 0,
    states: {},
    bld: {},
    start: { ...m.pos },
    travelled: 0,
    last: { ...m.pos },
    net: 0,
  });
}

for (let k = 0; k < TICKS; k++) {
  w.tick(dt);
  for (const m of w.platoon.members) {
    if (!m.alive || m.status === "wounded" || m.evac) continue;
    const u = w.sim.unit(m.id);
    if (!u) continue;
    const r = rec.get(m.id)!;
    r.travelled += Math.hypot(u.pos.x - r.last.x, u.pos.y - r.last.y);
    r.last = { x: u.pos.x, y: u.pos.y };
    // inside the wire only (this is the COP-stuck question)
    if (Math.hypot(u.pos.x - center.x, u.pos.y - center.y) > wire + 10) continue;
    const blockedThisTick = u.moving === true && u.speed < 0.02;
    if (blockedThisTick && adjStructure(u.pos.x, u.pos.y)) {
      r.grind++;
      r.run++;
      if (r.run > r.maxRun) r.maxRun = r.run;
      r.states[m.brainState ?? "?"] = (r.states[m.brainState ?? "?"] ?? 0) + 1;
      const b = nearestBuilding(u.pos.x, u.pos.y);
      r.bld[b] = (r.bld[b] ?? 0) + 1;
    } else {
      r.run = 0;
    }
  }
}

for (const r of rec.values()) r.net = Math.hypot(r.last.x - r.start.x, r.last.y - r.start.y);

// ---- report ----
const all = [...rec.values()];
const offenders = all.filter((r) => r.grind > 0).sort((a, b) => b.grind - a.grind);
const totalGrind = all.reduce((s, r) => s + r.grind, 0);

console.log(`\nseed=${seed}  ${SECONDS}s  (${TICKS} ticks, dt=${dt})`);
console.log(`COP radius ${cop.radius} cells (${wire} m), ${cop.buildings.length} buildings, ${w.platoon.members.length} men`);
console.log(`TOTAL building-grind ticks: ${totalGrind}   (${(totalGrind / TICKS).toFixed(1)} man-ticks/tick avg)`);

// per squad
const bySquad = new Map<string, number>();
for (const r of all) bySquad.set(r.squad, (bySquad.get(r.squad) ?? 0) + r.grind);
console.log("\nper squad grind:");
for (const [sq, g] of [...bySquad.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${sq.padEnd(8)} ${String(g).padStart(7)} grind ticks (${(g / TICKS).toFixed(2)} avg men grinding)`);
}

// per building
const byBld = new Map<string, number>();
for (const r of all) for (const [b, g] of Object.entries(r.bld)) byBld.set(b, (byBld.get(b) ?? 0) + g);
console.log("\nper building grind:");
for (const [b, g] of [...byBld.entries()].sort((a, b2) => b2[1] - a[1])) {
  console.log(`  ${b.padEnd(14)} ${String(g).padStart(7)}`);
}

console.log("\nworst offenders (top 12):");
console.log("  id".padEnd(20), "squad".padEnd(8), "grind".padStart(7), "maxRun_s".padStart(9), "net_m".padStart(7), "travel_m".padStart(9), "states");
for (const r of offenders.slice(0, 12)) {
  const states = Object.entries(r.states)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}:${n}`)
    .join(",");
  console.log(
    ("  " + r.id).padEnd(20),
    r.squad.padEnd(8),
    String(r.grind).padStart(7),
    (r.maxRun * dt).toFixed(0).padStart(9),
    r.net.toFixed(1).padStart(7),
    r.travelled.toFixed(0).padStart(9),
    states
  );
}
console.log(`\noffenders: ${offenders.length}/${all.length} men ground against a building at some point`);
