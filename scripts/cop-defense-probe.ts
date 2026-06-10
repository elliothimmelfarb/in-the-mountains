/**
 * cop-defense-probe — issue 021: does fob.hesco (COP fortification) MATTER when the outpost is
 * assaulted? A well-built wire should make a complex attack measurably less costly to the garrison;
 * a neglected one shouldn't. Before the combat-coupling, hesco is written + shown but combat ignores
 * it — so a hardened COP and a neglected one bleed identically. That IS the bug this probe pins.
 *
 * For each seed it stages a complex attack on the COP (director.spawnComplexAttack) with the garrison
 * standing to, runs ~8 game-min, and reports garrison KIA/WIA — once with hesco forced LOW (20) and
 * once FULL (100). A working coupling shows LOW measurably bloodier than FULL.
 *
 * Run: npx tsx scripts/cop-defense-probe.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { spawnComplexAttack } from "../lib/sim/world/director";

const N = Number(process.argv[2] ?? 10);
const SEEDS = Array.from({ length: N }, (_, i) => `survey-${i}`);
const MIN = 8;

function run(seed: string, hesco: number) {
  const w: any = createWorld(seed, 90);
  // stand the COP to, harden/neglect the wire, and put the enemy on the w01

  w.state.fob.hesco = hesco;
  w.state.enemyHeat = 0.85;
  // count garrison at start (the men inside the wire who will defend)
  const center = w.terrain.cellCenter(w.terrain.copCell.cx, w.terrain.copCell.cy);
  const garrisonIds = w.platoon.members
    .filter((m: any) => m.alive && Math.hypot(m.pos.x - center.x, m.pos.y - center.y) < (w.terrain.cop.radius + 6) * w.terrain.cellSize)
    .map((m: any) => m.id);
  spawnComplexAttack(w);
  const ticks = MIN * 600;
  for (let t = 0; t < ticks && !w.state.ended; t++) w.tick(0.1);
  const kia = w.platoon.members.filter((m: any) => garrisonIds.includes(m.id) && !m.alive).length;
  const wia = w.platoon.members.filter((m: any) => garrisonIds.includes(m.id) && m.alive && m.wounds.length > 0).length;
  const enemyDown = w.sim.units.filter((u: any) => u.faction === "insurgent" && !u.alive).length;
  return { n: garrisonIds.length, kia, wia, enemyDown };
}

console.log("seed         | garr | hesco20 KIA/WIA | hesco100 KIA/WIA | enemy20/100");
console.log("-------------|------|-----------------|------------------|-----------");
let lkia = 0, lwia = 0, hkia = 0, hwia = 0;
for (const s of SEEDS) {
  const lo = run(s, 20);
  const hi = run(s, 100);
  lkia += lo.kia; lwia += lo.wia; hkia += hi.kia; hwia += hi.wia;
  console.log(`${s.padEnd(12)} | ${String(lo.n).padStart(4)} |      ${lo.kia}/${lo.wia}        |       ${hi.kia}/${hi.wia}        | ${lo.enemyDown}/${hi.enemyDown}`);
}
const n = SEEDS.length;
console.log("-------------|------|-----------------|------------------|-----------");
console.log(`MEAN  LOW(hesco20) KIA ${(lkia/n).toFixed(2)} WIA ${(lwia/n).toFixed(2)}  |  FULL(hesco100) KIA ${(hkia/n).toFixed(2)} WIA ${(hwia/n).toFixed(2)}`);
console.log(`A neglected wire should bleed MORE than a hardened one. Delta WIA = ${((lwia-hwia)/n).toFixed(2)} (0 = hesco is combat-inert, the bug).`);
