import { RNG, clamp } from "../rng";
import { Terrain, DEFAULT_TERRAIN } from "../terrain";
import { makePlatoon, makeCivilian, Platoon, RosterMember, Unit, Role, resetIdCounter } from "../entities";
import { elderName } from "../names";
import { VillageState, rollWeather, attitudeToMetric, CERP_PROJECTS } from "../campaign";
import { World } from "./world";
import { WorldState, Ids, resetIds } from "./types";
import { buildRoutine, clampMap, crewEmplacements } from "./helpers";

/** Create a fresh deployment. */
export function createWorld(seed: string, totalDays = 90): World {
  resetIdCounter(0);
  resetIds();
  const rng = new RNG(seed);
  const terrain = new Terrain({ ...DEFAULT_TERRAIN, seed });
  const platoon = makePlatoon(rng.fork("platoon"), 0.45);

  const villages: VillageState[] = terrain.villages.map((v) => {
    const baseAtt = rng.int(-40, 25);
    return {
      id: v.id,
      name: v.name,
      cx: v.cx,
      cy: v.cy,
      population: v.population,
      attitude: baseAtt,
      cooperation: clamp(30 + baseAtt * 0.4 + rng.int(-10, 10), 0, 100),
      sympathy: clamp(40 - baseAtt * 0.4 + rng.int(-10, 20), 0, 100),
      projects: [],
      elder: elderName(rng),
      lastVisitedDay: -1,
      censusDone: false,
      wants: rng.pick(CERP_PROJECTS),
    };
  });

  const units: Unit[] = [];
  const copWorld = terrain.cellCenter(terrain.copCell.cx, terrain.copCell.cy);
  for (const m of platoon.members) {
    m.pos = { x: copWorld.x + rng.range(-22, 22), y: copWorld.y + rng.range(-22, 22) };
    m.brainState = "garrison";
    m.rof = "free";
    m.stance = "stand";
    units.push(m);
  }
  for (const v of villages) {
    const n = Math.min(12, Math.round(v.population / 26));
    const spread = (terrain.villages.find((tv) => tv.id === v.id)?.size ?? 4) + 2;
    for (let i = 0; i < n; i++) {
      const roles: Role[] = ["farmer", "herder", "villager", "child", "elder"];
      const role = rng.weighted(roles, [40, 20, 25, 12, 3]);
      const c = terrain.cellCenter(v.cx + rng.int(-spread, spread), v.cy + rng.int(-spread, spread));
      const civ = makeCivilian(rng.fork(`civ-${v.id}-${i}`), role, clampMap(terrain, c), v.id);
      civ.routine = buildRoutine(terrain, v, rng);
      units.push(civ);
    }
  }

  const enemyStrengthAbs = rng.int(40, 70);
  const state: WorldState = {
    seed,
    totalDays,
    clock: 0,
    weather: rollWeather(rng),
    nextWeatherAt: rng.range(4, 8) * 3600,
    supplies: {
      ammo_556: 22000, ammo_762: 8000, ammo_50: 1600, ammo_40mm: 260,
      mortar_60: 110, mortar_81: 70, grenades: 90, smoke: 70,
      water: 520, food: 480, fuel: 2200, medical: 36, batteries: 150, construction: 40,
    },
    cerp: 30000,
    villages,
    intel: [],
    directives: [],
    metrics: {
      stability: 40,
      attitude: attitudeToMetric(villages),
      enemyStrength: clamp(enemyStrengthAbs, 0, 100),
      combatPower: 92,
      higherConfidence: 60,
    },
    log: [],
    fob: {
      name: "COP Vimoto",
      hesco: 60,
      claymores: 12,
      emplacements: [
        { id: "cp-n", weaponId: "m240", cell: { cx: terrain.copCell.cx, cy: terrain.copCell.cy - 4 }, manned: true },
        { id: "cp-e", weaponId: "m2", cell: { cx: terrain.copCell.cx + 4, cy: terrain.copCell.cy }, manned: true },
        { id: "cp-s", weaponId: "m240", cell: { cx: terrain.copCell.cx, cy: terrain.copCell.cy + 4 }, manned: true },
        { id: "cp-mortar", weaponId: "mortar60", cell: { cx: terrain.copCell.cx - 2, cy: terrain.copCell.cy + 2 }, manned: true },
      ],
      observationPosts: [],
    },
    copCell: { ...terrain.copCell },
    enemyStrengthAbs,
    enemyHeat: 0.32,
    tasks: [],
    projects: [],
    resupplies: [],
    tourScore: 0,
    ended: false,
    nextActivityAt: rng.range(8, 18) * 60,
    nextIntelAt: rng.range(10, 30) * 60,
    nextEventAt: rng.range(40, 90) * 60,
    lastContactClock: -9999,
    platoon: { callsign: platoon.callsign, squads: platoon.squads },
  };

  crewEmplacements(state, platoon, terrain);

  const w = new World(terrain, rng, state, units, platoon);
  w.log(`Arrived at ${state.fob.name}. ${platoon.members.length} souls on the ground. The valley is quiet — for now.`, "info");
  issueInitialDirectives(w);
  return w;
}

/** Restore a saved deployment. */
export function loadWorld(data: { rngState: number; state: WorldState; units: Unit[] }): World {
  const state = data.state;
  const terrain = new Terrain({ ...DEFAULT_TERRAIN, seed: state.seed });
  const rng = new RNG(state.seed);
  rng.setState(data.rngState);

  let maxId = 0;
  for (const u of data.units) {
    const n = parseInt(u.id.split("-")[1] ?? "0", 36);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n + 1);
  }
  resetIdCounter(maxId);
  Ids.log = Math.max(0, ...state.log.map((l) => l.id + 1));
  Ids.intel = Math.max(0, ...state.intel.map((r) => r.id + 1));
  Ids.dir = Math.max(0, ...state.directives.map((d) => d.id + 1));
  Ids.task = Math.max(0, ...state.tasks.map((t) => t.id + 1));
  Ids.proj = Math.max(0, ...state.projects.map((p) => p.id + 1));

  const byId = new Map(data.units.map((u) => [u.id, u]));
  const members = state.platoon.squads
    .flatMap((s) => s.memberIds)
    .map((id) => byId.get(id))
    .filter((u): u is RosterMember => !!u) as RosterMember[];
  const platoon: Platoon = { callsign: state.platoon.callsign, members, squads: state.platoon.squads };
  return new World(terrain, rng, state, data.units, platoon);
}

function issueInitialDirectives(w: World) {
  const day = w.day;
  w.state.directives.push({
    id: Ids.dir++,
    title: "Establish Presence",
    desc: "Run security patrols and put boots in every village within two weeks. Show the flag.",
    kind: "presence",
    issuedDay: day,
    deadlineDay: day + 14,
    status: "active",
    progress: 0,
    reward: 12,
    penalty: 10,
  });
  w.state.directives.push({
    id: Ids.dir++,
    title: "Meet the Elders",
    desc: "Conduct a shura (KLE) with the village elders. Win hearts; gather atmospherics.",
    kind: "kle",
    issuedDay: day,
    deadlineDay: day + 21,
    status: "active",
    progress: 0,
    reward: 15,
    penalty: 8,
  });
}
