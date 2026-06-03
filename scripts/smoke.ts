import { createWorld } from "../lib/sim/world";
import { Land, LAND_COUNT } from "../lib/sim/terrain";

function pct(n: number) {
  return Math.round(n) + "%";
}

const world = createWorld("smoke-test", 90);
const { terrain, state, sim } = world;

console.log("=== WORLD ===");
console.log("Terrain:", terrain.size, "cells @", terrain.cellSize, "m =", terrain.worldSize, "m,", Math.round(terrain.minElev), "-", Math.round(terrain.maxElev), "m");
console.log("COP cell:", terrain.copCell, "Villages:", terrain.villages.map((v) => v.name).join(", "));
console.log("Platoon:", world.platoon.members.length, "in", world.platoon.squads.length, "squads · civilians:", sim.units.filter((u) => u.faction === "civilian").length);
console.log("Named features:", terrain.features.map((f) => `${f.name}(${f.elevation}m)`).join(", "));

// landcover histogram (proof of richer terrain)
const counts: Record<number, number> = {};
for (let i = 0; i < terrain.land.length; i++) counts[terrain.land[i]] = (counts[terrain.land[i]] ?? 0) + 1;
const present = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
console.log("Landcover classes present:", present.length, "/", LAND_COUNT);
console.log("  " + present.map((l) => `${Land[l]}:${((counts[l] / terrain.land.length) * 100).toFixed(1)}%`).join("  "));

// COP structure
const cl = terrain.cop;
console.log("\n=== COP LAYOUT ===");
console.log("Center:", cl.center, "· radius", cl.radius, "cells (" + cl.radius * terrain.cellSize + " m) · gate passable:", terrain.passableCell(cl.gate.cx, cl.gate.cy), "· wall sealed:", !terrain.passableCell(cl.center.cx, cl.center.cy + cl.radius) || !terrain.passableCell(cl.center.cx + cl.radius, cl.center.cy));
console.log("Buildings:", cl.buildings.map((b) => b.label).join(", "));
console.log("Fighting positions:", cl.fightingPositions.length, "(towers:", cl.fightingPositions.filter((f) => f.tower).length + ")", "· LZ:", cl.lz);

// form a patrol toward the first village, concealed
const cop = terrain.copCell;
const v = terrain.villages[0];
const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
const medic = world.platoon.members.find((m) => m.role === "medic");
const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
const route = [
  { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
  { cx: v.cx, cy: v.cy },
];
const task = world.formPatrol(ids, route, "presence", "tactical");
console.log("\n=== PATROL ===");
console.log("Task:", task?.label, "· pax", task?.memberIds.length, "· phase", task?.phase, "· route legs", task?.route.length);

// crank the heat and run the continuous world
state.enemyHeat = 0.75;
state.nextActivityAt = 0;
const dt = 0.1;
let ticks = 0;
const maxTicks = 18000; // 30 game-minutes
let projPeak = 0;
let everContact = false;
let enemiesSeen = 0;
let patrolMaxOut = 0; // farthest a patrol MAN gets from the COP center (proves the gate works)
const copC = terrain.cellCenter(cl.center.cx, cl.center.cy);
while (ticks < maxTicks && !state.ended) {
  world.tick(dt);
  projPeak = Math.max(projPeak, sim.projectiles.length);
  if (world.inContact()) everContact = true;
  enemiesSeen = Math.max(enemiesSeen, sim.livingEnemies().length);
  // Measure the point man (farthest member), not the centroid: a nearby objective
  // keeps the centroid inside the wire even when the patrol clearly egressed.
  for (const id of ids) {
    const u = sim.unit(id);
    if (u && u.alive) patrolMaxOut = Math.max(patrolMaxOut, Math.hypot(u.pos.x - copC.x, u.pos.y - copC.y));
  }
  for (const u of sim.units) {
    if (Number.isNaN(u.pos.x) || Number.isNaN(u.pos.y)) {
      console.error("NaN position on", u.id, u.faction, u.role);
      process.exit(1);
    }
  }
  ticks++;
}

const kia = world.platoon.members.filter((m) => !m.alive).length;
const wia = world.platoon.members.filter((m) => m.alive && m.status === "wounded").length;
const enemyKIA = world.platoon.members.reduce((a, m) => a + m.kills, 0);

console.log("\n=== AFTER", (ticks * dt / 60).toFixed(0), "GAME-MINUTES (", world.clockLabel(), ") ===");
console.log("Contact occurred:", everContact, "· peak enemies on map:", enemiesSeen, "· peak projectiles:", projPeak);
console.log("Patrol pushed", Math.round(patrolMaxOut), "m from the COP center (gate egress through the wire", patrolMaxOut > cl.radius * terrain.cellSize ? "OK" : "— STUCK?", ")");
console.log("US KIA:", kia, "· US WIA:", wia, "· enemy accounted:", enemyKIA);
console.log("Metrics:", {
  stability: pct(state.metrics.stability),
  attitude: pct(state.metrics.attitude),
  enemy: pct(state.metrics.enemyStrength),
  power: pct(state.metrics.combatPower),
  higher: pct(state.metrics.higherConfidence),
});
console.log("Intel reports:", state.intel.length, "| latest:", state.intel[0]?.text);
console.log("Tasks active:", state.tasks.length, "| ammo 5.56:", Math.round(state.supplies.ammo_556));
console.log("\nLog tail:");
for (const l of state.log.slice(-12)) console.log(`  [${l.timeLabel}] ${l.kind.toUpperCase()}: ${l.msg}`);

// save/load round-trip
const blob = world.serialize();
const json = JSON.stringify(blob);
console.log("\nSerialized save size:", (json.length / 1024).toFixed(1), "KB · units:", blob.units.length);

console.log("\nSMOKE OK");
