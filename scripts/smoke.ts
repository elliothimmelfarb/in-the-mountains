import { createCampaign, advancePhase } from "../lib/sim/campaign";
import { RNG } from "../lib/sim/rng";
import { newPatrolId, resolveMarch, buildEncounter, PatrolPlan } from "../lib/sim/patrol";
import { CombatSim } from "../lib/sim/combat";

function pct(n: number) {
  return Math.round(n) + "%";
}

const { state, terrain } = createCampaign("smoke-test", 120);
console.log("=== CAMPAIGN ===");
console.log("Terrain:", terrain.size, "cells,", Math.round(terrain.minElev), "-", Math.round(terrain.maxElev), "m");
console.log("COP cell:", terrain.copCell, "Villages:", terrain.villages.map((v) => v.name).join(", "));
console.log("Platoon:", state.platoon.members.length, "members in", state.platoon.squads.length, "squads");
console.log("Named features:", terrain.features.map((f) => `${f.name}(${f.elevation}m)`).join(", "));

// Advance a few phases
const rng = new RNG("smoke-adv");
for (let i = 0; i < 6; i++) advancePhase(state, rng);
console.log("\nAfter 6 phases: Day", state.day, state.weather.label, "Metrics:", {
  stability: pct(state.metrics.stability),
  attitude: pct(state.metrics.attitude),
  enemy: pct(state.metrics.enemyStrength),
  power: pct(state.metrics.combatPower),
  higher: pct(state.metrics.higherConfidence),
});
console.log("Intel reports:", state.intel.length, "| latest:", state.intel[0]?.text);

// Plan a patrol from the COP into the valley
const cop = terrain.copCell;
const target = terrain.villages[0];
const squad = state.platoon.squads.find((s) => s.id === "sq1")!;
const plan: PatrolPlan = {
  id: newPatrolId(),
  missionType: "presence",
  memberIds: squad.memberIds,
  route: [
    { cx: cop.cx, cy: cop.cy },
    { cx: Math.round((cop.cx + target.cx) / 2), cy: Math.round((cop.cy + target.cy) / 2) },
    { cx: target.cx, cy: target.cy },
  ],
  notes: "smoke test patrol",
};

// Force a contact for the test
const marchRng = new RNG("force-contact");
state.enemyHeat = 0.7;
let spec = resolveMarch(state, terrain, plan, marchRng);
let tries = 0;
while (!spec.occurred && tries < 50) {
  spec = resolveMarch(state, terrain, plan, new RNG("force-" + tries));
  tries++;
}
console.log("\n=== CONTACT ===");
console.log("Occurred:", spec.occurred, "| kind:", spec.kind, "| enemy:", spec.enemyCount, "| at", spec.cell);
console.log(spec.narrative);

if (spec.occurred) {
  const { init, meta } = buildEncounter(state, terrain, plan, spec, new RNG("enc"));
  console.log("Encounter units:", init.units.length, "(US:", init.units.filter((u) => u.faction === "us").length,
    "INS:", init.units.filter((u) => u.faction === "insurgent").length,
    "CIV:", init.units.filter((u) => u.faction === "civilian").length, ")");
  console.log("Light:", init.light.toFixed(2), "| mortars:", init.mortars?.map((m) => m.weaponId).join(",") || "none",
    "| CAS:", init.casAvailable, "| meta village:", meta.villageId);

  const sim = new CombatSim(init);
  // run up to 5 minutes of combat at 10 Hz
  const dt = 0.1;
  let ticks = 0;
  const maxTicks = 3000;
  let projPeak = 0;
  while (sim.outcome === "ongoing" && ticks < maxTicks) {
    sim.tick(dt);
    projPeak = Math.max(projPeak, sim.projectiles.length);
    ticks++;
    // sanity: detect NaN positions
    for (const u of sim.units) {
      if (Number.isNaN(u.pos.x) || Number.isNaN(u.pos.y)) {
        console.error("NaN position on", u.id, u.faction, u.role);
        process.exit(1);
      }
    }
  }
  const result = sim.result();
  console.log("\n=== COMBAT RESULT after", (ticks * dt).toFixed(0), "s ===");
  console.log("Outcome:", result.outcome);
  console.log("US KIA:", result.usKIA.length, "| US WIA:", result.usWIA.length, "| Enemy KIA:", result.enemyKIA,
    "| Civ casualties:", result.civCasualties);
  console.log("Ammo expended:", result.ammoExpended, "| fire missions:", result.fireMissionsUsed, "| peak projectiles:", projPeak);
  console.log("\nLast log lines:");
  for (const l of sim.log.slice(-10)) console.log(`  [${l.timeS.toFixed(0)}s] ${l.kind.toUpperCase()}: ${l.msg}`);
}
console.log("\nSMOKE OK");
