import { RNG, clamp01 } from "./rng";
import { Vec2 } from "./vec";
import { usName, usNickname, pashtunName, companyCallsign } from "./names";

export type Faction = "us" | "ana" | "insurgent" | "civilian";

export type Role =
  // US / ANA
  | "platoon_leader"
  | "platoon_sergeant"
  | "squad_leader"
  | "team_leader"
  | "rifleman"
  | "grenadier"
  | "saw_gunner"
  | "auto_rifleman"
  | "machinegunner"
  | "marksman"
  | "sniper"
  | "medic"
  | "rto"
  | "jtac"
  | "engineer"
  | "interpreter"
  // insurgent
  | "fighter"
  | "ied_team"
  | "rpg_gunner"
  | "mg_gunner"
  | "marksman_acm"
  | "spotter"
  | "commander"
  // civilian
  | "farmer"
  | "herder"
  | "elder"
  | "child"
  | "villager";

export type Stance = "stand" | "crouch" | "prone";

/**
 * How a unit moves when it has somewhere to be. Postures trade speed for
 * profile: a "rush" is fast but loud and exposed; "concealed" is slow, low, and
 * hugs cover so it routes through forest and washes and is hard to detect.
 */
export type MoveTechnique = "crawl" | "concealed" | "tactical" | "patrol" | "traveling" | "rush";

export const MOVE_TECHNIQUES: MoveTechnique[] = [
  "concealed",
  "tactical",
  "patrol",
  "traveling",
  "rush",
];

/**
 * Rules of engagement — a squad's standing fire policy and the civilian-fire
 * contract. Derived from the squad SOP onto each member every contact tick (like
 * `rof`), then read by the `civClear` gate in the firing path.
 *  - hold  = self-defense only: fire only at a PID'd shooter who just fired, and never
 *            with a civilian in the keep-out. No pre-emptive or suppressive fire.
 *  - tight = engage identified hostiles, but NEVER fire if a civilian is inside the
 *            (generous) keep-out of the target or the gun-target line. The COIN default.
 *  - free  = engage/suppress on contact; the keep-out shrinks to danger-close (a civ
 *            standing on the aimpoint). Never zero — civcas is never "allowed", just less guarded.
 */
export type ROE = "hold" | "tight" | "free";

export const TECHNIQUE_LABEL: Record<MoveTechnique, string> = {
  crawl: "Crawl",
  concealed: "Concealed",
  tactical: "Tactical",
  patrol: "Patrol",
  traveling: "Traveling",
  rush: "Rush",
};

export interface Wound {
  region: "head" | "chest" | "abdomen" | "arm" | "leg";
  severity: number; // 0..1
  bleeding: number; // hp/sec lost until treated
  treated: boolean;
  timeM: number; // game-minute it occurred
}

/** A single living thing in the simulation — soldier, fighter, or civilian. */
export interface Unit {
  id: string;
  faction: Faction;
  name: string;
  nickname?: string;
  rank?: string;
  role: Role;
  callsign?: string;

  // --- position / posture (tactical) ---
  pos: Vec2; // world meters
  facing: number; // radians
  stance: Stance;
  moving: boolean;
  speed: number; // current m/s
  path: Vec2[]; // waypoints being followed (world)
  pathGoal?: Vec2 | null; // the destination the path leads to (for self-correcting re-plan)
  technique?: MoveTechnique; // movement posture while following a path
  faceLock?: number | null; // locked facing (sector security) honored while moving
  formationHold?: boolean; // legacy hard pace-hold (combat still honors it; squad movement uses paceScale)
  paceScale?: number; // 0..1 speed multiplier — the point man eases off to keep the squad together (never a dead stop)
  // closed-loop movement: when a unit can't step freely toward its waypoint
  // (wall-blocked / sliding), it re-plans a fresh route from where it stands.
  blockedTimer?: number; // seconds of continuous blocked/sliding movement

  // --- innate attributes (0..1) ---
  marksmanship: number;
  composureMax: number;
  leadership: number;
  medical: number;
  fitnessMax: number;
  stealth: number;
  experience: number; // deployments / time in valley
  aggression: number; // willingness to push (insurgent/AI)

  // --- dynamic state ---
  hp: number; // 0..100
  alive: boolean;
  conscious: boolean;
  composure: number; // 0..1 morale-in-the-moment
  suppression: number; // 0..1, decays
  shaken?: number; // seconds of acute shock after a buddy is hit nearby (shaky hands, flinch)
  fatigue: number; // 0..1, accrues with movement/altitude
  wounds: Wound[];
  bleedRate: number; // total hp/sec
  bleedTQable?: number; // portion of bleedRate from extremity arterial bleeds — a
  // tourniquet/pressure (self or any buddy) stops it; the rest is internal/junctional
  // and needs a medic or surgery (the golden hour).

  // --- weapons & load ---
  weaponId: string;
  sidearmId?: string;
  ammo: number; // rounds loaded
  reserveAmmo: number; // rounds in reserve mags
  grenades: number; // hand frags
  glRounds: number; // 40mm HE for grenadiers (M320)
  smokes: number;
  reloading: number; // seconds remaining
  fireCooldown: number; // seconds between bursts
  aimProgress: number; // 0..1 settle on current target
  burstLeft: number; // rounds remaining in the current burst
  roundTimer: number; // seconds until next round in burst (cyclic rate)

  // --- organization ---
  squadId?: string;
  isLeader: boolean;

  // --- AI / perception ---
  targetId?: string | null;
  orderType?: string;
  orderTarget?: Vec2 | null;
  rof: "free" | "hold" | "suppress"; // fire posture (mechanical gate): set by the squad-combat AI each tick
  roe?: ROE; // standing rules of engagement (derived from the squad SOP); gates the civilian-fire check
  civGuard?: number; // meters — no-fire keep-out around a visible civilian, derived from roe + weapon class
  boundDelayUntil?: number; // assault-bound hesitation: this man steps off when the clock passes (nerve)
  brainState: string; // AI state label
  brainTimer: number; // seconds in state / until reconsider
  lastSeenEnemy: Record<string, { pos: Vec2; t: number }>; // enemyId -> last known
  perceptTimer: number; // throttle for LOS scans
  visibleEnemyIds: string[]; // currently perceived enemies
  threatDir: Vec2 | null; // direction of most recent incoming fire (for cover)
  iedInit?: boolean; // ambusher holding fire until the IED initiates (won't auto-trigger)

  // --- enemy cell coordination (ai/cell-combat.ts) ---
  // Cell-level state lives on the cell LEADER's unit, so it rides serialize()'s
  // whole-unit spread with no new save surface. A leaderless cell runs the old
  // per-fighter FSM unchanged.
  cellState?: "engage" | "break"; // the leader's read of the fight once the trap is sprung
  cellTimer?: number; // leader: seconds until the cell reconsiders
  cellBound?: number; // leader: which half of the cell is displacing (0/1)
  cellBoundUntil?: number; // leader: sim clock when the displacing half swaps
  cellRally?: Vec2 | null; // leader: shared withdrawal rally (toward the draws, uphill)
  cellPeelNextS?: number; // leader: sim clock when the next man peels out
  fledShock?: boolean; // this fighter's individual rout already shocked his mates (one-shot)
  /** Transient, re-stamped every tick by the coordinator (cleared on serialize):
   *  hold your trigger — the LEADER springs this ambush, not your own kill zone. */
  _cellHold?: boolean;

  /** Latched once a buddy has shouted for this casualty — one "doc!" per man down. */
  docCalled?: boolean;
  evac: boolean; // removed from the field (MEDEVAC'd / fled off-map)
  spawnAtM?: number; // reinforcement schedule (game minutes)
  hasFired: boolean;

  // --- civilian ---
  villageId?: string;
  routine?: CivRoutineNode[];
  /** Kinship (people-immersion): which 2-4-person household this villager belongs to.
   *  A casualty's household grieves BY NAME (the grievance ledger on VillageState),
   *  gathers at first light to bury its dead, and treats the next patrol differently. */
  householdId?: string;
  /** Civic summons (world-issued): walk to a point and hold until the sim clock —
   *  the elder coming out to the shura (faceId = the squad leader he sits with), a
   *  household standing at a grave. Below FLEE and the melt in precedence: a staged
   *  threat ABORTS it (latched via summonsAborted), gunfire always wins. While active,
   *  un-fired US/ANA are excluded from this unit's proximity-threat inputs — the elder
   *  must be able to walk INTO the 9 m shura ring without his own FLEE tier firing. */
  summons?: { x: number; y: number; untilS: number; faceId?: string } | null;
  summonsAborted?: boolean;
  panic?: number; // 0..1
  reactTier?: number; // graduated reaction to armed men: 0 oblivious / 1 wary / 2 clear-road / 3 flee
  tierHoldS?: number; // seconds since the tier last needed to fall a step (rising-instant, falling-slow)

  // --- transient firing scratch (set during a burst, not persisted) ---
  _fireTarget?: string | null;
  _fireLOS?: import("./los").LOSResult | null;

  // --- bookkeeping for the strategic layer ---
  daysInCountry: number;
  kills: number;
  woundedCount: number;
  /** Which faction's fire caused this unit's casualty — for civcas attribution (COIN). */
  casualtyByFaction?: Faction;
  /** Set once this civilian casualty has been counted in COIN backlash (serialized,
   *  so a save/load never double-counts it). */
  casualtyCounted?: boolean;
  /** Set once the KILL tier has been counted — so a civ wounded then killed by our
   *  fire escalates the backlash to the full kill magnitude exactly once. */
  casualtyKilledCounted?: boolean;
}

export interface CivRoutineNode {
  phase: "dawn" | "day" | "dusk" | "night";
  target: Vec2;
  activity: string;
}

let _id = 0;
function uid(prefix: string): string {
  return `${prefix}-${(_id++).toString(36)}`;
}

export function resetIdCounter(n = 0) {
  _id = n;
}

const US_RANKS_NCO = ["SGT", "SSG"];

interface UnitOverrides extends Partial<Unit> {}

function baseUnit(faction: Faction, role: Role, pos: Vec2, over: UnitOverrides = {}): Unit {
  return {
    id: uid(faction),
    faction,
    name: "Unknown",
    role,
    pos: { ...pos },
    facing: 0,
    stance: "stand",
    moving: false,
    speed: 0,
    path: [],
    marksmanship: 0.5,
    composureMax: 0.7,
    leadership: 0.3,
    medical: 0.1,
    fitnessMax: 0.7,
    stealth: 0.4,
    experience: 0.3,
    aggression: 0.4,
    hp: 100,
    alive: true,
    conscious: true,
    composure: 0.7,
    suppression: 0,
    fatigue: 0,
    wounds: [],
    bleedRate: 0,
    weaponId: "m4",
    ammo: 30,
    reserveAmmo: 180,
    grenades: 0,
    glRounds: 0,
    smokes: 0,
    reloading: 0,
    fireCooldown: 0,
    aimProgress: 0,
    burstLeft: 0,
    roundTimer: 0,
    isLeader: false,
    targetId: null,
    rof: "free",
    brainState: "idle",
    brainTimer: 0,
    lastSeenEnemy: {},
    perceptTimer: 0,
    visibleEnemyIds: [],
    threatDir: null,
    evac: false,
    hasFired: false,
    daysInCountry: 0,
    kills: 0,
    woundedCount: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  US platoon generation
// ---------------------------------------------------------------------------

export interface RosterMember extends Unit {
  // Strategic-layer fields layered on top of the tactical Unit.
  postStuck?: number; // seconds spent wedged trying to reach a garrison post (escalates the router)
  rest: number; // 0..1, drops with ops, recovers at the COP
  morale: number; // 0..1 longer-arc morale
  bio: string;
  homeState: string;
  status: "ready" | "wounded" | "kia" | "evacuated" | "rest";
  daysToRecover: number;
}

const HOME_STATES = [
  "Texas", "Ohio", "California", "Georgia", "Pennsylvania", "Michigan", "Florida",
  "New York", "Tennessee", "Arizona", "Wisconsin", "Oregon", "Kentucky", "Alabama",
  "Colorado", "Idaho", "Missouri", "Iowa", "Vermont", "Wyoming",
];

const BIO_FRAGMENTS = [
  "Joined out of high school. Wanted the GI Bill.",
  "Third-generation infantry. Grandfather was at Khe Sanh.",
  "Quiet. Reads paperbacks on guard. Dead shot.",
  "Class clown of the platoon. Keeps everyone loose.",
  "Has a baby back home he hasn't met.",
  "Reenlisted twice. This valley is his fourth deployment.",
  "Engaged. Calls home every chance the sat phone is up.",
  "Built like a linebacker, hauls the 240 like it's nothing.",
  "Gym rat. Sends most of his pay home to his mother.",
  "Wanted to be a cop. This is the detour.",
  "Knows every word to every country song ever recorded.",
  "Came over from supply. Asked to be on the line.",
];

function rankForRole(role: Role, rng: RNG): string {
  switch (role) {
    case "platoon_leader":
      return "1LT";
    case "platoon_sergeant":
      return "SFC";
    case "squad_leader":
      return "SSG";
    case "team_leader":
      return rng.pick(US_RANKS_NCO);
    case "medic":
      return rng.pick(["SPC", "SGT"]);
    case "rto":
    case "jtac":
      return rng.pick(["SPC", "SGT"]);
    case "sniper":
      return rng.pick(["SGT", "SSG"]);
    default:
      return rng.pick(["PFC", "SPC", "PV2", "SPC"]);
  }
}

function makeSoldier(rng: RNG, role: Role, pos: Vec2, squadId: string, exp: number): RosterMember {
  const nm = usName(rng);
  const weaponId =
    role === "saw_gunner" ? "m249"
    : role === "auto_rifleman" ? "m249"
    : role === "machinegunner" ? "m240"
    : role === "grenadier" ? "m4"
    : role === "marksman" ? "m110"
    : role === "sniper" ? "m24"
    : role === "medic" ? "m4"
    : "m4";
  const isLeader = role === "platoon_leader" || role === "platoon_sergeant" || role === "squad_leader" || role === "team_leader";
  const skillBoost = isLeader ? 0.12 : 0;
  const u = baseUnit("us", role, pos, {
    name: nm.full,
    nickname: rng.chance(0.3) ? usNickname(rng) : undefined,
    rank: rankForRole(role, rng),
    weaponId,
    sidearmId: isLeader || role === "medic" ? "m9" : undefined,
    squadId,
    isLeader,
    marksmanship: rng.gaussClamped(0.6 + skillBoost, 0.12, 0.25, 0.95),
    composureMax: rng.gaussClamped(0.72 + skillBoost + exp * 0.1, 0.1, 0.4, 0.98),
    leadership: isLeader ? rng.gaussClamped(0.7, 0.12, 0.4, 0.98) : rng.gaussClamped(0.35, 0.12, 0.05, 0.7),
    medical: role === "medic" ? rng.gaussClamped(0.85, 0.08, 0.6, 0.99) : rng.gaussClamped(0.2, 0.1, 0.05, 0.5),
    fitnessMax: rng.gaussClamped(0.75, 0.1, 0.45, 0.98),
    stealth: rng.gaussClamped(0.45, 0.12, 0.15, 0.85),
    experience: clamp01(exp + rng.gauss(0, 0.1)),
    aggression: rng.gaussClamped(0.5, 0.15, 0.1, 0.95),
    grenades: rng.int(1, 2),
    glRounds: role === "grenadier" ? rng.int(6, 9) : 0,
    smokes: role === "grenadier" ? rng.int(2, 3) : rng.int(0, 1),
    ammo: weaponId === "m249" ? 200 : weaponId === "m240" ? 100 : 30,
    reserveAmmo: weaponId === "m249" ? 600 : weaponId === "m240" ? 400 : 210,
  });
  const m: RosterMember = {
    ...u,
    composure: u.composureMax,
    rest: rng.range(0.8, 1),
    morale: rng.range(0.6, 0.85),
    bio: rng.pick(BIO_FRAGMENTS),
    homeState: rng.pick(HOME_STATES),
    status: "ready",
    daysToRecover: 0,
  };
  return m;
}

export interface Platoon {
  callsign: string;
  members: RosterMember[];
  squads: { id: string; name: string; memberIds: string[] }[];
}

/** Build a reinforced rifle platoon (~30) plus attachments, COP-garrison flavored. */
export function makePlatoon(rng: RNG, baseExperience = 0.4): Platoon {
  const callsign = companyCallsign(rng);
  const members: RosterMember[] = [];
  const squads: Platoon["squads"] = [];
  const origin: Vec2 = { x: 0, y: 0 };

  // HQ element
  members.push(makeSoldier(rng, "platoon_leader", origin, "hq", baseExperience + 0.15));
  members.push(makeSoldier(rng, "platoon_sergeant", origin, "hq", baseExperience + 0.25));
  members.push(makeSoldier(rng, "rto", origin, "hq", baseExperience));
  members.push(makeSoldier(rng, "jtac", origin, "hq", baseExperience + 0.1));
  members.push(makeSoldier(rng, "medic", origin, "hq", baseExperience + 0.05));
  squads.push({ id: "hq", name: "HQ", memberIds: members.map((m) => m.id) });

  // Three rifle squads (two fireteams each: TL, SAW, grenadier, rifleman)
  for (let s = 1; s <= 3; s++) {
    const sid = `sq${s}`;
    const sqMembers: string[] = [];
    const sl = makeSoldier(rng, "squad_leader", origin, sid, baseExperience + 0.2);
    members.push(sl);
    sqMembers.push(sl.id);
    for (let t = 0; t < 2; t++) {
      const roles: Role[] = ["team_leader", "saw_gunner", "grenadier", "rifleman"];
      for (const r of roles) {
        const sol = makeSoldier(rng, r, origin, sid, baseExperience + (r === "team_leader" ? 0.15 : 0));
        members.push(sol);
        sqMembers.push(sol.id);
      }
    }
    squads.push({ id: sid, name: `${s}${ordinal(s)} Squad`, memberIds: sqMembers });
  }

  // Weapons squad (FM/ATP 3-21.8): a weapons-squad leader, two M240 medium-MG
  // teams (gunner + assistant gunner), two ammo bearers, a grenadier (the squad's
  // HE/anti-armor punch) and the platoon marksman — 9 men. Built from existing
  // roles so every man has a real sprite + weapon. This restores the organic
  // weapons squad the platoon was missing (it was a 3-man stub), bringing the
  // platoon to ~41 (5 HQ + 27 rifle + 9 weapons), inside the doctrinal 39–42 band.
  // DETERMINISM NOTE: adding members advances the seeded ROSTER rng, so soldier
  // names/stats shift for a given seed — intended; terrain is seeded separately
  // and is unaffected. Re-baseline campaign expectations, not the valley.
  const wsid = "wpn";
  const ws: string[] = [];
  const wsl = makeSoldier(rng, "squad_leader", origin, wsid, baseExperience + 0.25);
  members.push(wsl);
  ws.push(wsl.id);
  const wpnRoles: Role[] = [
    "machinegunner", "rifleman", // M240 gun team A: gunner + assistant gunner
    "machinegunner", "rifleman", // M240 gun team B: gunner + assistant gunner
    "rifleman", "rifleman", //       two ammo bearers
    "grenadier", //                  HE / anti-armor
    "marksman", //                   platoon marksman (M110)
  ];
  for (const r of wpnRoles) {
    const sol = makeSoldier(rng, r, origin, wsid, baseExperience + (r === "machinegunner" ? 0.15 : r === "marksman" ? 0.25 : 0));
    members.push(sol);
    ws.push(sol.id);
  }
  squads.push({ id: wsid, name: "Weapons Sqd", memberIds: ws });

  return { callsign, members, squads };
}

function ordinal(n: number): string {
  return n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
}

// ---------------------------------------------------------------------------
//  Insurgent generation
// ---------------------------------------------------------------------------

export function makeInsurgent(rng: RNG, role: Role, pos: Vec2, heat: number): Unit {
  const weaponId =
    role === "rpg_gunner" ? "rpg7"
    : role === "mg_gunner" ? rng.pick(["pkm", "dshk", "rpk"])
    : role === "marksman_acm" ? rng.pick(["svd", "enfield"])
    : role === "commander" ? "akm"
    : "akm";
  const skill = clamp01(0.32 + heat * 0.3 + rng.gauss(0, 0.14));
  const u = baseUnit("insurgent", role, pos, {
    name: pashtunName(rng),
    weaponId,
    isLeader: role === "commander",
    marksmanship: clamp01(skill + (role === "marksman_acm" ? 0.2 : 0)),
    composureMax: clamp01(0.55 + heat * 0.25 + rng.gauss(0, 0.12)),
    leadership: role === "commander" ? rng.range(0.6, 0.9) : rng.range(0.1, 0.4),
    fitnessMax: rng.gaussClamped(0.82, 0.08, 0.6, 0.99), // hardened mountain fighters
    stealth: rng.gaussClamped(0.7, 0.1, 0.4, 0.97), // know the ground
    experience: clamp01(0.3 + heat * 0.4 + rng.gauss(0, 0.12)),
    aggression: clamp01(0.5 + heat * 0.3 + rng.gauss(0, 0.15)),
    ammo: weaponId === "pkm" || weaponId === "dshk" ? 100 : weaponId === "rpg7" ? 1 : 30,
    reserveAmmo: weaponId === "rpg7" ? 3 : weaponId === "pkm" || weaponId === "dshk" ? 200 : 90,
    grenades: rng.chance(0.3) ? 1 : 0,
  });
  u.composure = u.composureMax;
  return u;
}

// ---------------------------------------------------------------------------
//  Civilian generation
// ---------------------------------------------------------------------------

export function makeCivilian(rng: RNG, role: Role, pos: Vec2, villageId: string): Unit {
  const u = baseUnit("civilian", role, pos, {
    name: pashtunName(rng),
    weaponId: "unarmed",
    villageId,
    marksmanship: 0,
    composureMax: rng.range(0.4, 0.7),
    fitnessMax: role === "child" ? 0.5 : rng.range(0.5, 0.8),
    stealth: rng.range(0.3, 0.6),
    aggression: 0,
    ammo: 0,
    reserveAmmo: 0,
    panic: 0,
  });
  u.composure = u.composureMax;
  return u;
}

/** Effective standing height in meters for LOS, by stance and role. */
export function unitHeight(u: Unit): number {
  const base = u.role === "child" ? 1.2 : 1.75;
  switch (u.stance) {
    case "prone":
      return base * 0.28;
    case "crouch":
      return base * 0.62;
    default:
      return base;
  }
}

/** Eye height for LOS as an observer. */
export function eyeHeight(u: Unit): number {
  return unitHeight(u) - 0.12;
}
