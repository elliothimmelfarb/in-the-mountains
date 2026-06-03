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

/** How long an element holds on its objective, by task/mission. */
export function dwellFor(t: Task): number {
  if (t.kind === "kle") return 360;
  switch (t.missionType) {
    case "census":
      return 300;
    case "cordon":
      return 300;
    case "overwatch":
      return 900;
    case "ambush":
      return 1100;
    case "recon":
      return 150;
    default:
      return 180;
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
      target: clampMap(terrain, p),
      activity: rng.pick(["fields", "herding", "water", "market"]),
    });
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
  // Mortar pit, dug in toward the rear of the yard.
  emp.push({
    id: "cp-mortar",
    weaponId: "mortar60",
    cell: { cx: Math.round(cop.center.cx - cop.gateDir.x * 3), cy: Math.round(cop.center.cy - cop.gateDir.y * 3) },
    manned: true,
  });
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
