import { createCampaign } from "../lib/sim/campaign";
import { RNG } from "../lib/sim/rng";
import { newPatrolId, resolveMarch, buildEncounter, PatrolPlan } from "../lib/sim/patrol";
import { CombatSim } from "../lib/sim/combat";

const N = Number(process.argv[2] ?? 24);
let usKIA = 0, usWIA = 0, enKIA = 0, civ = 0, stalls = 0, victories = 0, destroyed = 0, withdrew = 0;
let totalDur = 0;
const durList: number[] = [];

for (let run = 0; run < N; run++) {
  const seed = `bal-${run}`;
  const { state, terrain } = createCampaign(seed, 120);
  state.enemyHeat = 0.6 + (run % 5) * 0.08;
  const v = terrain.villages[run % terrain.villages.length];
  const cop = terrain.copCell;
  const sq = state.platoon.squads.find((s) => s.id === "sq1")!;
  const ids = sq.memberIds.slice();
  const medic = state.platoon.members.find((m) => m.role === "medic");
  if (medic) ids.push(medic.id);
  const plan: PatrolPlan = {
    id: newPatrolId(),
    missionType: "presence",
    memberIds: ids,
    route: [
      { cx: cop.cx, cy: cop.cy },
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    notes: "",
  };
  // force contact
  let spec = resolveMarch(state, terrain, plan, new RNG(`m-${run}`));
  let t = 0;
  while (!spec.occurred && t < 60) { spec = resolveMarch(state, terrain, plan, new RNG(`m-${run}-${t}`)); t++; }
  if (!spec.occurred) continue;
  const { init } = buildEncounter(state, terrain, plan, spec, new RNG(`enc-${run}`));
  const sim = new CombatSim(init);
  let ticks = 0;
  while (sim.outcome === "ongoing" && ticks < 6000) { sim.tick(0.1); ticks++; }
  if (sim.outcome === "ongoing") stalls++;
  const r = sim.result();
  if (r.outcome === "us_victory") victories++;
  if (r.outcome === "us_destroyed") destroyed++;
  if (r.outcome === "us_withdraw") withdrew++;
  usKIA += r.usKIA.length; usWIA += r.usWIA.length; enKIA += r.enemyKIA; civ += r.civCasualties;
  totalDur += r.durationS; durList.push(Math.round(r.durationS));
}

console.log(`Ran ${N} forced engagements (1 squad + medic vs ambush):`);
console.log(`  Outcomes: ${victories} broke contact, ${destroyed} element destroyed, ${withdrew} withdrew, ${stalls} STALLED (bad!)`);
console.log(`  Avg US KIA: ${(usKIA / N).toFixed(2)} · Avg US WIA: ${(usWIA / N).toFixed(2)} · Avg Enemy KIA: ${(enKIA / N).toFixed(2)} · Civ cas total: ${civ}`);
console.log(`  Avg engagement duration: ${(totalDur / N).toFixed(0)}s · range ${Math.min(...durList)}–${Math.max(...durList)}s`);
console.log(stalls === 0 ? "  ✓ No stalls — all engagements resolved." : `  ✗ ${stalls} stalls need attention.`);
