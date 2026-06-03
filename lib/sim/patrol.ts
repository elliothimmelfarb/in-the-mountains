import { RNG, clamp, clamp01 } from "./rng";
import { Terrain, Land } from "./terrain";
import { Vec2, dist, sub, norm, scale, add, fromAngle, angle } from "./vec";
import { Unit, Role, makeInsurgent, makeCivilian } from "./entities";
import { CampaignState, ambientLight, currentPhase } from "./campaign";
import { CombatInit } from "./combat";
import { getWeapon } from "./weapons";
import { lineOfSight } from "./los";

export type MissionType =
  | "presence"
  | "recon"
  | "ambush"
  | "kle"
  | "census"
  | "cordon_search"
  | "resupply_escort"
  | "overwatch";

export const MISSION_LABEL: Record<MissionType, string> = {
  presence: "Presence Patrol",
  recon: "Reconnaissance",
  ambush: "Ambush",
  kle: "Key Leader Engagement",
  census: "Census",
  cordon_search: "Cordon & Search",
  resupply_escort: "Resupply Escort",
  overwatch: "Overwatch / OP",
};

export interface PatrolPlan {
  id: string;
  missionType: MissionType;
  memberIds: string[];
  route: { cx: number; cy: number }[]; // waypoints in cells
  targetVillageId?: string;
  notes: string;
}

export interface ContactSpec {
  occurred: boolean;
  cell: { cx: number; cy: number };
  enemyInitiated: boolean;
  kind: "ambush" | "ied" | "sniper" | "complex" | "meeting_engagement" | "harass";
  enemyCount: number;
  narrative: string;
}

let _pid = 0;
export function newPatrolId(): string {
  return `patrol-${_pid++}`;
}

/** Clone a persistent roster member / unit into a fresh tactical combatant. */
export function cloneForCombat(src: Unit, opts: { fatigue?: number; composure?: number } = {}): Unit {
  const u: Unit = structuredClone(src);
  u.suppression = 0;
  u.burstLeft = 0;
  u.roundTimer = 0;
  u.fireCooldown = 0;
  u.reloading = 0;
  u.aimProgress = 0;
  u.path = [];
  u.moving = false;
  u.speed = 0;
  u.targetId = null;
  u.brainState = "idle";
  u.brainTimer = 0;
  u.visibleEnemyIds = [];
  u.lastSeenEnemy = {};
  u.threatDir = null;
  u.evac = false;
  u.hasFired = false;
  u.stance = "stand";
  if (opts.fatigue !== undefined) u.fatigue = clamp01(opts.fatigue);
  if (opts.composure !== undefined) u.composure = clamp01(opts.composure);
  // top off ammo from loadout
  const w = getWeapon(u.weaponId === "unarmed" ? "m9" : u.weaponId);
  u.ammo = w.magSize;
  return u;
}

/** Probability the patrol makes contact along a leg near a given cell. */
export function contactProbabilityAt(
  state: CampaignState,
  terrain: Terrain,
  cell: { cx: number; cy: number },
  missionType: MissionType
): number {
  const land = terrain.land[terrain.idx(cell.cx, cell.cy)] as Land;
  let p = 0.04 + state.enemyHeat * 0.16;
  // terrain danger: draws/forest, choke points, near hostile villages
  if (land === Land.Forest || land === Land.Scrub) p += 0.05;
  if (land === Land.Village) p += 0.04;
  const slope = terrain.slope[terrain.idx(cell.cx, cell.cy)];
  if (slope > 0.5) p += 0.03; // canalized in steep ground
  // distance from COP — deeper is more dangerous
  const d = Math.hypot(cell.cx - state.copCell.cx, cell.cy - state.copCell.cy);
  p += clamp01(d / terrain.size) * 0.12;
  // nearby village hostility
  let nearHostile = 0;
  for (const v of state.villages) {
    const vd = Math.hypot(cell.cx - v.cx, cell.cy - v.cy);
    if (vd < 18) nearHostile = Math.max(nearHostile, clamp01((-v.attitude) / 100) * (1 - vd / 18));
  }
  p += nearHostile * 0.14;
  // intel hotspots
  for (const r of state.intel.slice(0, 12)) {
    if (r.cx === undefined || r.cy === undefined) continue;
    const id = Math.hypot(cell.cx - r.cx, cell.cy - r.cy);
    if (id < 14) p += r.reliability * 0.06 * (1 - id / 14);
  }
  // mission modifiers
  if (missionType === "ambush" || missionType === "overwatch") p += 0.05; // you're hunting them
  if (missionType === "recon") p -= 0.02;
  if (currentPhase(state) === "Night") p += 0.03;
  return clamp01(p);
}

/** March the route phase-by-leg and decide if/where contact happens. */
export function resolveMarch(
  state: CampaignState,
  terrain: Terrain,
  plan: PatrolPlan,
  rng: RNG
): ContactSpec {
  const route = plan.route;
  let cum = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    const steps = Math.max(1, Math.round(segLen));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cell = { cx: Math.round(a.cx + (b.cx - a.cx) * t), cy: Math.round(a.cy + (b.cy - a.cy) * t) };
      // sample contact every ~2 cells to keep rolls coarse
      cum += 1;
      if (cum < 2) continue;
      cum = 0;
      const p = contactProbabilityAt(state, terrain, cell, plan.missionType) * 0.5;
      if (rng.chance(p)) {
        return buildContactSpec(state, terrain, cell, plan, rng);
      }
    }
  }
  return {
    occurred: false,
    cell: route[route.length - 1] ?? state.copCell,
    enemyInitiated: false,
    kind: "harass",
    enemyCount: 0,
    narrative: "Patrol completed without contact.",
  };
}

function buildContactSpec(
  state: CampaignState,
  terrain: Terrain,
  cell: { cx: number; cy: number },
  plan: PatrolPlan,
  rng: RNG
): ContactSpec {
  const usInitiated = plan.missionType === "ambush" || plan.missionType === "overwatch";
  const enemyInitiated = !usInitiated || rng.chance(0.3); // even on an ambush they sometimes get the drop
  let kind: ContactSpec["kind"];
  if (usInitiated && !enemyInitiated) kind = "meeting_engagement";
  else {
    kind = rng.weighted(
      ["ambush", "complex", "sniper", "ied", "harass"],
      [40, 18, 16, 12, 14]
    );
  }
  const baseN = 3 + state.enemyHeat * 8 + state.enemyStrengthAbs * 0.05;
  let enemyCount = Math.round(clamp(baseN + rng.gauss(0, 2), 2, 18));
  if (kind === "sniper" || kind === "harass") enemyCount = Math.max(2, Math.round(enemyCount * 0.4));
  if (kind === "complex") enemyCount = Math.round(enemyCount * 1.25);
  enemyCount = Math.min(enemyCount, state.enemyStrengthAbs);

  const narrative = narrativeFor(kind, terrain, cell);
  return { occurred: true, cell, enemyInitiated, kind, enemyCount, narrative };
}

function narrativeFor(kind: ContactSpec["kind"], terrain: Terrain, cell: { cx: number; cy: number }): string {
  const nearestVil = terrain.villages
    .map((v) => ({ v, d: Math.hypot(v.cx - cell.cx, v.cy - cell.cy) }))
    .sort((a, b) => a.d - b.d)[0]?.v;
  const where = nearestVil ? `near ${nearestVil.name}` : "in the open valley";
  switch (kind) {
    case "ambush":
      return `The lead element is taking effective fire from the high ground ${where}. CONTACT FRONT.`;
    case "complex":
      return `Complex ambush ${where} — RPG and PKM from multiple positions. The whole valley lit up.`;
    case "sniper":
      return `A single accurate shooter is engaging the patrol ${where}. Everyone's down behind cover.`;
    case "ied":
      return `IED strike ${where}, followed by small-arms fire. Check for casualties.`;
    case "meeting_engagement":
      return `Your overwatch spots fighters moving along the trail ${where}, unaware. Weapons tight — wait for it.`;
    case "harass":
      return `Harassing fire from distance ${where}. Probing your reaction.`;
  }
}

// ---------------------------------------------------------------------------
//  Encounter construction (CombatInit)
// ---------------------------------------------------------------------------

export interface EncounterMeta {
  villageId?: string;
  contactCell: { cx: number; cy: number };
}

export function buildEncounter(
  state: CampaignState,
  terrain: Terrain,
  plan: PatrolPlan,
  spec: ContactSpec,
  rng: RNG
): { init: CombatInit; meta: EncounterMeta } {
  const center = terrain.cellCenter(spec.cell.cx, spec.cell.cy);
  const units: Unit[] = [];

  // March fatigue scales with route length.
  const routeLen = plan.route.reduce(
    (a, _, i) => (i === 0 ? 0 : a + Math.hypot(plan.route[i].cx - plan.route[i - 1].cx, plan.route[i].cy - plan.route[i - 1].cy)),
    0
  );
  const fatigue = clamp01(routeLen / terrain.size + 0.1);

  // --- Patrol element ---
  const members = plan.memberIds
    .map((id) => state.platoon.members.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m && m.alive && m.status === "ready");

  // direction of travel at the contact point
  const dirOfTravel = directionAtCell(plan, spec.cell);
  // staggered column along the trail, centered on the contact cell — proper
  // dispersion so one burst doesn't catch the whole element.
  const spacing = 11;
  members.forEach((m, i) => {
    const along = (i - (members.length - 1) / 2) * spacing + rng.range(-2, 2);
    const lateral = (i % 2 === 0 ? 1 : -1) * (4 + rng.range(0, 3));
    const perp = { x: -dirOfTravel.y, y: dirOfTravel.x };
    const pos: Vec2 = add(add(center, scale(dirOfTravel, along)), scale(perp, lateral));
    const u = cloneForCombat(m, { fatigue, composure: clamp01(m.morale * 0.6 + m.rest * 0.4) });
    u.pos = clampToMap(terrain, pos);
    u.facing = angle(dirOfTravel);
    if (spec.enemyInitiated) {
      u.brainState = "moving";
      u.rof = "free";
    } else {
      // US-initiated: set in overwatch, holding fire
      u.brainState = "holding";
      u.rof = "hold";
      u.stance = "prone";
    }
    units.push(u);
  });

  // IED opener: wound someone in the lead before the fight starts.
  if (spec.kind === "ied" && units.length) {
    const lead = units[0];
    lead.hp = clamp(lead.hp - rng.range(20, 60), 1, 100);
    lead.wounds.push({ region: rng.pick(["leg", "leg", "arm"]), severity: rng.range(0.3, 0.7), bleeding: rng.range(1, 3), treated: false, timeM: 0 });
    lead.bleedRate += 2;
  }

  // --- Insurgents ---
  const enemyPositions = findAmbushPositions(terrain, center, dirOfTravel, spec.enemyCount, rng, spec.enemyInitiated);
  enemyPositions.forEach((pos, i) => {
    const role = enemyRoleFor(i, spec.enemyCount, spec.kind, rng);
    const e = makeInsurgent(rng.fork(`enemy-${spec.cell.cx}-${spec.cell.cy}-${i}`), role, clampToMap(terrain, pos), state.enemyHeat);
    e.facing = angle(sub(center, pos));
    if (spec.enemyInitiated) {
      e.brainState = "ambush";
      e.brainTimer = rng.range(0.5, 4);
      e.rof = "hold";
      e.stance = "prone";
    } else {
      // they're the ones moving into the kill zone
      e.brainState = "patrolling";
      e.rof = "free";
      e.path = [clampToMap(terrain, center)];
    }
    units.push(e);
  });

  // --- Civilians (atmospherics) ---
  const nearVil = terrain.villages
    .map((v) => ({ v, d: Math.hypot(v.cx - spec.cell.cx, v.cy - spec.cell.cy) }))
    .sort((a, b) => a.d - b.d)[0];
  const meta: EncounterMeta = { contactCell: spec.cell, villageId: nearVil && nearVil.d < 20 ? nearVil.v.id : undefined };
  if (nearVil && nearVil.d < 16) {
    const civN = rng.int(1, 4);
    for (let i = 0; i < civN; i++) {
      const roles: Role[] = ["farmer", "herder", "villager", "child"];
      const cpos = add(center, fromAngle(rng.range(0, Math.PI * 2), rng.range(20, 90)));
      const c = makeCivilian(rng.fork(`enc-civ-${i}`), rng.pick(roles), clampToMap(terrain, cpos), nearVil.v.id);
      c.panic = rng.range(0.1, 0.5);
      units.push(c);
    }
  }

  // --- Support availability ---
  const copWorld = terrain.cellCenter(state.copCell.cx, state.copCell.cy);
  const mortars: NonNullable<CombatInit["mortars"]> = [];
  const r60 = dist(copWorld, center);
  if (r60 <= getWeapon("mortar60").maxRange && state.supplies.mortar_60 > 0)
    mortars.push({ weaponId: "mortar60", rounds: state.supplies.mortar_60, copPos: copWorld });
  if (r60 <= getWeapon("mortar81").maxRange && state.supplies.mortar_81 > 0)
    mortars.push({ weaponId: "mortar81", rounds: state.supplies.mortar_81, copPos: copWorld });

  const init: CombatInit = {
    terrain,
    rng: rng.fork("combat"),
    units,
    light: ambientLight(state),
    weather: { visibilityM: state.weather.visibilityM, wind: state.weather.wind, label: state.weather.label },
    context: `${MISSION_LABEL[plan.missionType]} — ${spec.narrative}`,
    mortars,
    casAvailable: state.weather.airAvailable,
  };
  return { init, meta };
}

function enemyRoleFor(i: number, total: number, kind: ContactSpec["kind"], rng: RNG): Role {
  if (i === 0 && total >= 6) return "commander";
  if (kind === "sniper") return rng.chance(0.7) ? "marksman_acm" : "fighter";
  const roll = rng.next();
  if (roll < 0.15) return "mg_gunner";
  if (roll < 0.3) return "rpg_gunner";
  if (roll < 0.4) return "marksman_acm";
  return "fighter";
}

/** Find good ambush firing positions overlooking the kill zone. */
function findAmbushPositions(
  terrain: Terrain,
  killZone: Vec2,
  dirOfTravel: Vec2,
  count: number,
  rng: RNG,
  enemyInitiated: boolean
): Vec2[] {
  const positions: Vec2[] = [];
  const minR = enemyInitiated ? 80 : 140;
  const maxR = enemyInitiated ? 320 : 420;
  // Prefer the uphill side and concealment with LOS to the kill zone.
  const candidates: { p: Vec2; score: number }[] = [];
  for (let tries = 0; tries < 600 && candidates.length < count * 8; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(minR, maxR);
    const p = add(killZone, fromAngle(a, r));
    if (p.x < 20 || p.y < 20 || p.x > terrain.worldSize - 20 || p.y > terrain.worldSize - 20) continue;
    const conceal = terrain.concealAt(p.x, p.y);
    const cover = terrain.coverAt(p.x, p.y);
    const elevAdv = terrain.elevAt(p.x, p.y) - terrain.elevAt(killZone.x, killZone.y);
    const los = lineOfSight(terrain, p, killZone, { observerHeight: 1.2, targetHeight: 1.7 });
    if (!los.visible) continue;
    const score = elevAdv * 0.02 + conceal * 3 + cover * 2 + los.exposure * 2 + rng.range(0, 1);
    candidates.push({ p, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  // spread chosen positions out a little
  for (const c of candidates) {
    if (positions.length >= count) break;
    if (positions.some((q) => dist(q, c.p) < 12)) continue;
    positions.push(c.p);
  }
  // fallback: if terrain gave us too few, jitter around the best
  while (positions.length < count && positions.length > 0) {
    const base = positions[rng.int(0, positions.length - 1)];
    positions.push(add(base, fromAngle(rng.range(0, Math.PI * 2), rng.range(8, 25))));
  }
  while (positions.length < count) {
    positions.push(add(killZone, fromAngle(rng.range(0, Math.PI * 2), rng.range(minR, maxR))));
  }
  return positions;
}

function directionAtCell(plan: PatrolPlan, cell: { cx: number; cy: number }): Vec2 {
  // find the leg closest to the cell and return its direction
  let best = { x: 0, y: -1 };
  let bd = Infinity;
  for (let i = 0; i < plan.route.length - 1; i++) {
    const a = plan.route[i];
    const b = plan.route[i + 1];
    const mid = { cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 };
    const d = Math.hypot(mid.cx - cell.cx, mid.cy - cell.cy);
    if (d < bd) {
      bd = d;
      const dir = norm({ x: b.cx - a.cx, y: b.cy - a.cy });
      if (dir.x !== 0 || dir.y !== 0) best = dir;
    }
  }
  return best;
}

function clampToMap(terrain: Terrain, p: Vec2): Vec2 {
  return { x: clamp(p.x, 5, terrain.worldSize - 5), y: clamp(p.y, 5, terrain.worldSize - 5) };
}

// ---------------------------------------------------------------------------
//  COP base-defense encounter
// ---------------------------------------------------------------------------

export function buildBaseDefense(
  state: CampaignState,
  terrain: Terrain,
  rng: RNG
): { init: CombatInit; meta: EncounterMeta } {
  const copWorld = terrain.cellCenter(state.copCell.cx, state.copCell.cy);
  const units: Unit[] = [];

  // Defenders: everyone ready, manning the perimeter & emplacements.
  const defenders = state.platoon.members.filter((m) => m.alive && m.status === "ready");
  defenders.forEach((m, i) => {
    const a = (i / Math.max(1, defenders.length)) * Math.PI * 2;
    const pos = add(copWorld, fromAngle(a, rng.range(8, 22)));
    const u = cloneForCombat(m, { fatigue: 0.1, composure: clamp01(m.morale * 0.7 + 0.3) });
    u.pos = clampToMap(terrain, pos);
    u.stance = "crouch";
    u.brainState = "holding";
    u.facing = a;
    units.push(u);
  });
  // Man the crew-served weapons.
  state.fob.emplacements.forEach((emp, i) => {
    if (defenders[i]) {
      // give a defender the crew-served weapon
      const gunner = units[i];
      if (gunner) {
        gunner.weaponId = emp.weaponId;
        gunner.pos = terrain.cellCenter(emp.cell.cx, emp.cell.cy);
        gunner.ammo = getWeapon(emp.weaponId).magSize;
        gunner.reserveAmmo = 800;
      }
    }
  });

  // Attackers come off the ridgelines.
  const count = Math.round(clamp(6 + state.enemyHeat * 12 + state.enemyStrengthAbs * 0.08, 4, 24));
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(250, 500);
    const pos = add(copWorld, fromAngle(a, r));
    const role = enemyRoleFor(i, count, "complex", rng);
    const e = makeInsurgent(rng.fork(`def-${i}`), role, clampToMap(terrain, pos), Math.min(1, state.enemyHeat + 0.2));
    e.brainState = "engage";
    e.rof = "free";
    e.facing = angle(sub(copWorld, pos));
    units.push(e);
  }

  const init: CombatInit = {
    terrain,
    rng: rng.fork("defense"),
    units,
    light: ambientLight(state),
    weather: { visibilityM: state.weather.visibilityM, wind: state.weather.wind, label: state.weather.label },
    context: `Attack on ${state.fob.name}`,
    mortars: state.supplies.mortar_60 > 0 ? [{ weaponId: "mortar60", rounds: state.supplies.mortar_60, copPos: copWorld }] : [],
    casAvailable: state.weather.airAvailable,
  };
  return { init, meta: { contactCell: state.copCell } };
}
