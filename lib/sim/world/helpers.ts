import { RNG, clamp } from "../rng";
import { Terrain } from "../terrain";
import { Vec2, add, fromAngle } from "../vec";
import { Unit, Role, Platoon, CivRoutineNode } from "../entities";
import { getWeapon } from "../weapons";
import { VillageState, Emplacement } from "../campaign";
import { Task, WorldState } from "./types";

export function shortName(u: Unit): string {
  return u.name.split(" ").pop() ?? u.name;
}

export function rankName(u: Unit): string {
  return `${u.rank ?? ""} ${shortName(u)}`.trim();
}

export function centroidOf(units: Unit[]): Vec2 {
  if (!units.length) return { x: 0, y: 0 };
  return {
    x: units.reduce((a, u) => a + u.pos.x, 0) / units.length,
    y: units.reduce((a, u) => a + u.pos.y, 0) / units.length,
  };
}

export function clampMap(t: Terrain, p: Vec2): Vec2 {
  return { x: clamp(p.x, 5, t.worldSize - 5), y: clamp(p.y, 5, t.worldSize - 5) };
}

/**
 * How long an element works on its objective, by task/mission, in GAME-seconds — raised from
 * the old minutes-long constants to the hours real operations take (FM 3-06.11, CALL biometrics,
 * Restrepo/Outpost accounts). The player WARPS through the patient hours; the dwell event-roll
 * (onStationEffects) pulls him back the instant something matters, so long-but-real reads as
 * tension, not a progress bar.
 *
 *   census / cordon — a half-day cordon-and-search, scaled by the village's `population`
 *                     (biometric enrollment is up to 30 min PER fighting-age person): ~2–8 h.
 *   KLE / shura     — 1–2 h per meeting (the real lever is the cumulative weekly cadence).
 *   overwatch       — a multi-hour OP (well under the 24 h patrol-base cap).
 *   ambush          — hours of waiting for a contact that lasts seconds.
 *   recon           — ≥ 1 h.
 *   presence        — ~1 h showing the flag (the COIN gold standard is 3×/day saturation,
 *                     many short patrols, not one long sit — kept modest on purpose).
 */
export function dwellFor(t: Task, population = 0): number {
  // census/cordon enrollment time scales with population, clamped to the 2–8 h band.
  const searchTime = clamp(population * 100, 2 * 3600, 8 * 3600);
  if (t.kind === "kle") return clamp(3600 + population * 8, 1 * 3600, 2 * 3600);
  switch (t.missionType) {
    case "census":
      return searchTime;
    case "cordon":
      return searchTime;
    case "overwatch":
      return 5 * 3600;
    case "ambush":
      return 4 * 3600;
    case "recon":
      return 4500; // 1.25 h
    default:
      return 3600; // presence — ~1 h
  }
}

export function enemyRoleFor(i: number, total: number, rng: RNG): Role {
  if (i === 0 && total >= 6) return "commander";
  const roll = rng.next();
  if (roll < 0.15) return "mg_gunner";
  if (roll < 0.3) return "rpg_gunner";
  if (roll < 0.42) return "marksman_acm";
  return "fighter";
}

export function buildRoutine(terrain: Terrain, v: VillageState, rng: RNG): CivRoutineNode[] {
  const home = terrain.cellCenter(v.cx, v.cy);
  const nodes: CivRoutineNode[] = [];
  for (let i = 0; i < 3; i++) {
    const p = add(home, fromAngle(rng.range(0, Math.PI * 2), rng.range(20, 110)));
    nodes.push({
      phase: "day",
      // Pattern-of-life waypoints sit on passable ground and never inside the COP
      // wire/apron, so villagers by an outpost work their fields instead of the wire.
      target: terrain.civSafePoint(p.x, p.y),
      activity: rng.pick(["fields", "herding", "water", "market"]),
    });
  }
  // Some villagers travel to ANOTHER village's bazaar — they walk the road/track network to
  // get there (civilianBrain routes with a road bias), so the new inter-village tracks read as
  // living routes rather than terrain decoration.
  if (terrain.villages.length > 1 && rng.chance(0.5)) {
    const others = terrain.villages.filter((o) => o.id !== v.id);
    const o = rng.pick(others);
    const oc = terrain.cellCenter(o.cx, o.cy);
    // The bazaar may be on the far bank — snap it to ground actually reachable over the network
    // (a real crossing), never a cell across the impassable river, so the errand never strands the
    // villager at the water (issue 010). civSafePoint then keeps it clear of the COP wire.
    const reach = terrain.reachablePoint(oc.x, oc.y);
    nodes.push({ phase: "day", target: terrain.civSafePoint(reach.x, reach.y), activity: "market" });
  }
  return nodes;
}

/** Crew-served weapons on the wall + the mortar pit, derived from the COP layout. */
export function buildEmplacements(terrain: Terrain): Emplacement[] {
  const cop = terrain.cop;
  const fps = cop.fightingPositions;
  const emp: Emplacement[] = [];
  // Two heavy guns on the best wall positions.
  (["m240", "m2"] as const).forEach((wid, i) => {
    const fp = fps[i];
    if (fp) emp.push({ id: `cp-${i}`, weaponId: wid, cell: { cx: fp.cx, cy: fp.cy }, manned: true });
  });
  // Mortar pit, dug in toward the rear of the yard (on passable ground).
  const mp = terrain.nearestPassable(
    Math.round(cop.center.cx - cop.gateDir.x * 3),
    Math.round(cop.center.cy - cop.gateDir.y * 3),
    4
  );
  emp.push({ id: "cp-mortar", weaponId: "mortar60", cell: { cx: mp.cx, cy: mp.cy }, manned: true });
  return emp;
}

/** Hand the weapons-squad gunners the crew-served guns on the perimeter. */
export function crewEmplacements(state: WorldState, platoon: Platoon, terrain: Terrain) {
  const gunners = platoon.members.filter((m) => m.role === "machinegunner");
  const mgEmp = state.fob.emplacements.filter((e) => e.weaponId === "m240" || e.weaponId === "m2");
  mgEmp.forEach((emp, i) => {
    const g = gunners[i];
    if (!g) return;
    g.weaponId = emp.weaponId;
    g.pos = terrain.cellCenter(emp.cell.cx, emp.cell.cy);
    g.ammo = getWeapon(emp.weaponId).magSize;
    g.reserveAmmo = 800;
    g.brainState = "manning";
  });
}
