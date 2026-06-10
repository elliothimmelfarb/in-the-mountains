import { createWorld } from "../lib/sim/world";

const N = Number(process.argv[2] ?? 12);
const MINUTES = Number(process.argv[3] ?? 50);
const PREFIX = process.argv[4] ?? "bal"; // seed prefix — pass a fresh one for a held-out A/B (Law 3)

let usKIA = 0, usWIA = 0, enKIA = 0, civ = 0, contacts = 0, stuck = 0;
let totalEnemySeen = 0;

for (let run = 0; run < N; run++) {
  const seed = `${PREFIX}-${run}`;
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.6 + (run % 5) * 0.06;

  // push a squad + medic out toward a village on a presence patrol
  const cop = terrain.copCell;
  const v = terrain.villages[run % terrain.villages.length];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  world.formPatrol(
    ids,
    [
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    "presence",
    "tactical"
  );
  state.nextActivityAt = 0; // first enemy activity ASAP

  let contact = false;
  let peakEnemy = 0;
  const ticks = MINUTES * 600;
  for (let t = 0; t < ticks && !state.ended; t++) {
    world.tick(0.1);
    if (world.inContact()) contact = true;
    peakEnemy = Math.max(peakEnemy, sim.livingEnemies().length);
    for (const u of sim.units) {
      if (Number.isNaN(u.pos.x)) {
        console.error("NaN!", seed, u.id);
        process.exit(1);
      }
    }
  }
  if (contact) contacts++;
  totalEnemySeen += peakEnemy;
  usKIA += world.platoon.members.filter((m) => !m.alive).length;
  usWIA += world.platoon.members.filter((m) => m.alive && m.wounds.length > 0).length;
  enKIA += world.platoon.members.reduce((a, m) => a + m.kills, 0);
  civ += sim.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;

  // True stall test: run 90 more game-seconds; a moving element that is out of
  // contact should make progress. If its centroid barely moves, it's frozen.
  const movingTask = state.tasks.find((tk) => tk.phase === "moving" || tk.phase === "returning");
  if (movingTask && !world.inContact()) {
    const before = sim.unit(movingTask.memberIds[0])?.pos ?? { x: 0, y: 0 };
    const bx = before.x, by = before.y;
    for (let t = 0; t < 900 && !state.ended; t++) world.tick(0.1);
    const after = sim.unit(movingTask.memberIds[0])?.pos ?? { x: bx, y: by };
    if (!world.inContact() && Math.hypot(after.x - bx, after.y - by) < 4) stuck++;
  }
}

console.log(`Ran ${N} continuous deployments, ${MINUTES} game-min each (1 squad + medic patrol, heat ~0.6-0.9):`);
console.log(`  Contacts: ${contacts}/${N} runs saw a firefight · avg peak enemies on map ${(totalEnemySeen / N).toFixed(1)}`);
console.log(`  Avg US KIA: ${(usKIA / N).toFixed(2)} · Avg US WIA: ${(usWIA / N).toFixed(2)} · Avg enemy accounted: ${(enKIA / N).toFixed(2)} · Civ cas total: ${civ}`);
console.log(stuck === 0 ? "  ✓ No elements left stranded mid-route." : `  ⚠ ${stuck} runs left an element lingering (check task resume).`);
