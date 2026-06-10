import { RNG, clamp } from "../rng";
import { Terrain, DEFAULT_TERRAIN } from "../terrain";
import { makePlatoon, makeCivilian, Platoon, RosterMember, Unit, Role, resetIdCounter } from "../entities";
import { elderName } from "../names";
import { VillageState, rollWeather, attitudeToMetric, CERP_PROJECTS } from "../campaign";
import { World } from "./world";
import { WorldState, Ids, resetIds, defaultSOP, DAY } from "./types";
import { buildRoutine, crewEmplacements, buildEmplacements } from "./helpers";

/**
 * Build *only* the valley terrain for a seed — the single heaviest phase of a deploy
 * (a 512² heightmap + landcover + river/road network; ~200 ms). Exposed so the UI can
 * stage generation across visible loading phases and pre-warm the renderer, then hand the
 * finished terrain straight to `createWorld` instead of building it twice. Headless callers
 * never need this — they just call `createWorld(seed, days)` and let it build its own.
 */
export function createTerrain(seed: string): Terrain {
  return new Terrain({ ...DEFAULT_TERRAIN, seed });
}

/**
 * Create a fresh deployment.
 *
 * `prebuiltTerrain` (optional) lets the deploy UI reuse a terrain it already built+rendered
 * for the loading screen. It MUST have been built from the same `seed` (via `createTerrain`):
 * the terrain carries its own independent RNG, so reusing a same-seed terrain leaves every
 * outer-`rng` draw below in the exact same order — the resulting World is byte-identical to
 * the no-arg path. A mismatched-seed terrain would silently break the determinism contract.
 */
export function createWorld(seed: string, totalDays = 90, prebuiltTerrain?: Terrain): World {
  resetIdCounter(0);
  resetIds();
  const rng = new RNG(seed);
  const terrain = prebuiltTerrain ?? new Terrain({ ...DEFAULT_TERRAIN, seed });
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
      censusProgress: 0,
      wants: rng.pick(CERP_PROJECTS),
      ask: null,
      brokenPromises: 0,
      keptPromises: 0,
    };
  });

  const units: Unit[] = [];
  const cop = terrain.cop;
  const copWorld = terrain.cellCenter(cop.center.cx, cop.center.cy);
  // Seat billets at building yard-side doorways (structures are solid — issue 004).
  const bWorld = (kind: string, fallback: typeof copWorld) => {
    const b = cop.buildings.find((x) => x.kind === kind);
    return b ? terrain.buildingSeat(b) : fallback;
  };
  const toc = bWorld("toc", copWorld);
  const aid = bWorld("aid", copWorld);
  const barracks = cop.buildings.filter((b) => b.kind === "barracks").map((b) => terrain.buildingSeat(b));
  let bi = 0;
  for (const m of platoon.members) {
    // Start the platoon at believable billets inside the wire (garrison life
    // takes over once the clock runs).
    let home = copWorld;
    if (m.role === "platoon_leader" || m.role === "platoon_sergeant" || m.role === "rto" || m.role === "jtac") home = toc;
    else if (m.role === "medic") home = aid;
    else if (barracks.length) home = barracks[bi++ % barracks.length];
    // Buildings are solid now (issue 004) — start the billet at the building's
    // passable doorway/yard edge, not on the (impassable) roof.
    m.pos = terrain.passablePoint(home.x + rng.range(-7, 7), home.y + rng.range(-7, 7));
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
      const drawn = rng.weighted(roles, [40, 20, 25, 12, 3]);
      // The village ELDER is guaranteed and BOUND (people-immersion): the first man of
      // every village is its elder — a real agent the shura summons out to sit with the
      // squad leader — and VillageState.elder carries HIS name, not a fiction. (The
      // weighted draw above still burns, so the downstream rng stream shape is unchanged.)
      const role: Role = i === 0 ? "elder" : drawn;
      const c = terrain.cellCenter(v.cx + rng.int(-spread, spread), v.cy + rng.int(-spread, spread));
      // Spawn on REACHABLE passable ground that's never inside the wire. The reachable snap (issue
      // 010) is essential: a jittered cell can land in a tiny walled-qalat pocket disconnected from
      // the valley, and a villager born there is stranded forever AND re-fires findPath's whole-map
      // free A* on every errand (worthFreeSearch's out-of-component-start branch) — a per-tick stall.
      // reachablePoint puts every villager in the connected valley; civSafePoint keeps him off the wire.
      const r = terrain.reachablePoint(c.x, c.y);
      const civ = makeCivilian(rng.fork(`civ-${v.id}-${i}`), role, terrain.civSafePoint(r.x, r.y), v.id);
      civ.routine = buildRoutine(terrain, v, rng);
      if (i === 0) {
        v.elderUnitId = civ.id;
        v.elder = civ.name;
      }
      units.push(civ);
    }
    // HOUSEHOLDS (kinship): partition the village's civilians into 2-4-person
    // households on a FORKED stream, so the main stream's draw count is untouched.
    // A casualty's household grieves by name, buries its dead at first light, and
    // reads differently to the next patrol.
    {
      const hr = rng.fork(`hh-${v.id}`);
      const vciv = units.filter((x) => x.faction === "civilian" && x.villageId === v.id);
      let k = 0;
      for (let j = 0; j < vciv.length; ) {
        const size = Math.min(vciv.length - j, hr.int(2, 4));
        const hid = `hh-${v.id}-${k++}`;
        for (let s = 0; s < size; s++) vciv[j + s].householdId = hid;
        j += size;
      }
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
      emplacements: buildEmplacements(terrain),
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
    // COIN strategic clock (v6) — keep these two rng draws here, immediately after nextEventAt,
    // so the draw order stays stable within v6 (any reorder shifts every downstream draw).
    nextCerpStipendAt: rng.range(6, 8) * DAY,
    nextDirectiveAt: rng.range(5, 8) * DAY,
    civCasualties: 0,
    reliefWatchClock: -1, // confidence starts healthy; no relief watch running (constant — no rng draw)
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
export function loadWorld(data: {
  rngState: number;
  state: WorldState;
  units: Unit[];
  combat?: {
    timeS?: number;
    casUsed?: boolean;
    ieds?: World["sim"]["ieds"];
    fireMissions?: World["sim"]["fireMissions"];
    smoke?: World["sim"]["smoke"];
  };
}): World {
  const state = data.state;
  // Migration: pre-windDir saves (v<3) lack weather.windDir — default it so the wind
  // vector never produces NaN (which would silently corrupt combat).
  if (state.weather && state.weather.windDir === undefined) state.weather.windDir = 0;
  // v<4 saves predate squad SOP — default each task's SOP from its mission so the
  // combat AI and the civilian-fire gate have a policy to read.
  for (const t of state.tasks) if (!t.sop) t.sop = defaultSOP(t.missionType);
  // v6: COIN strategic fields. serialize() dumps `state` whole, so every new field is already
  // written — the only gap a load could leave is `undefined` on a pre-v6 save, so default them
  // all here (same-seed replay and the campaign save survive). Tasks' secureVillageId/projectId
  // and directives' startMetric stay undefined for old data (old saves have no secure tasks).
  if (state.nextCerpStipendAt === undefined) state.nextCerpStipendAt = state.clock + 7 * DAY;
  if (state.nextDirectiveAt === undefined) state.nextDirectiveAt = state.clock + 5 * DAY;
  if (state.civCasualties === undefined) state.civCasualties = 0;
  if (state.reliefWatchClock === undefined) state.reliefWatchClock = -1;
  for (const v of state.villages) {
    if (v.ask === undefined) v.ask = null;
    if (v.brokenPromises === undefined) v.brokenPromises = 0;
    if (v.keptPromises === undefined) v.keptPromises = 0;
    // v7: progressive census. A pre-v7 save only knew censusDone; map it to the new fraction so
    // an already-censused village stays complete and an un-censused one starts fresh.
    if (v.censusProgress === undefined) v.censusProgress = v.censusDone ? 1 : 0;
  }
  // v7: dwell-event throttle clock on tasks (defaults to 0 = roll-ready).
  for (const t of state.tasks) if (t.dwellEventClock === undefined) t.dwellEventClock = 0;
  // v8 (people-immersion): the blood-debt ledger + the elder as a living agent. Legacy
  // saves get an empty ledger and a backfilled elder binding (the first living elder
  // unit of the village, if any — otherwise ensureElder promotes one on demand); an
  // in-flight KLE from an old save never deadlocks on the unmet-elder gate.
  for (const v of state.villages) {
    if (v.grievances === undefined) v.grievances = [];
    if (v.elderUnitId === undefined) {
      const e = data.units.find((u) => u.faction === "civilian" && u.alive && u.role === "elder" && u.villageId === v.id);
      if (e) {
        v.elderUnitId = e.id;
        v.elder = e.name;
      }
    }
  }
  for (const t of state.tasks) {
    if (t.kind === "kle" && t.phase === "onstation" && t.elderMet === undefined) t.elderMet = true;
  }
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
  const world = new World(terrain, rng, state, data.units, platoon);
  // v5: restore combat collections that outlive a tick, so a mid-firefight save isn't lossy.
  if (data.combat) {
    const sim = world.sim;
    if (typeof data.combat.timeS === "number") sim.timeS = data.combat.timeS;
    sim.casUsed = !!data.combat.casUsed;
    if (data.combat.ieds) sim.ieds = data.combat.ieds;
    if (data.combat.fireMissions) sim.fireMissions = data.combat.fireMissions;
    if (data.combat.smoke) sim.smoke = data.combat.smoke;
  }
  return world;
}

function issueInitialDirectives(w: World) {
  const day = w.day;
  w.state.directives.push({
    id: Ids.dir++,
    title: "Establish Presence",
    desc: "Run security patrols and put boots in every village inside twelve days. Show the flag.",
    kind: "presence",
    issuedDay: day,
    // Higher wants presence established FAST after the RIP — a neglected AO blows this and the
    // penalty bites (it is one of the first ways the player feels pressure from battalion).
    deadlineDay: day + 12,
    status: "active",
    progress: 0,
    reward: 12,
    penalty: 10,
  });
  w.state.directives.push({
    id: Ids.dir++,
    title: "Meet the Elders",
    desc: "Conduct a shura (KLE) with the village elders within two weeks. Win hearts; gather atmospherics.",
    kind: "kle",
    issuedDay: day,
    deadlineDay: day + 14,
    status: "active",
    progress: 0,
    reward: 15,
    penalty: 8,
  });
}
