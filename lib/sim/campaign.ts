import { RNG, clamp, clamp01 } from "./rng";
import { Terrain, DEFAULT_TERRAIN } from "./terrain";
import { makePlatoon, makeCivilian, Platoon, RosterMember, Unit, Role } from "./entities";
import { elderName } from "./names";
import { CombatResult } from "./combat";

export type Phase = "Dawn" | "Day" | "Dusk" | "Night";
export const PHASES: Phase[] = ["Dawn", "Day", "Dusk", "Night"];

/** 0..1 ambient light by phase (folded with weather). */
export const PHASE_LIGHT: Record<Phase, number> = { Dawn: 0.45, Day: 1, Dusk: 0.4, Night: 0.08 };

export interface Supplies {
  ammo_556: number;
  ammo_762: number;
  ammo_50: number;
  ammo_40mm: number;
  mortar_60: number;
  mortar_81: number;
  grenades: number;
  smoke: number;
  water: number; // man-days
  food: number; // man-days
  fuel: number; // liters
  medical: number; // trauma kits / IV
  batteries: number;
}

export interface VillageState {
  id: string;
  name: string;
  cx: number;
  cy: number;
  population: number;
  attitude: number; // -100 hostile .. +100 friendly
  cooperation: number; // 0..100 willingness to share intel
  sympathy: number; // 0..100 hidden insurgent support
  projects: string[];
  elder: string;
  lastVisitedDay: number;
  censusDone: boolean;
}

export interface IntelReport {
  id: number;
  day: number;
  phase: Phase;
  source: "SIGINT" | "HUMINT" | "PATROL" | "DRONE" | "HIGHER";
  text: string;
  reliability: number; // 0..1
  cx?: number;
  cy?: number;
}

export interface Directive {
  id: number;
  title: string;
  desc: string;
  kind: "presence" | "kle" | "census" | "interdict" | "construct" | "hold" | "casualty";
  issuedDay: number;
  deadlineDay: number;
  status: "active" | "complete" | "failed";
  progress: number; // 0..1
  reward: number; // higher-confidence delta
  penalty: number;
}

export interface Metrics {
  stability: number; // 0..100 valley stability
  attitude: number; // 0..100 mean village attitude (mapped)
  enemyStrength: number; // 0..100 estimated ACM strength in the valley
  combatPower: number; // 0..100 your men+materiel readiness
  higherConfidence: number; // 0..100 battalion's confidence in you
}

export interface CampaignLogEntry {
  id: number;
  day: number;
  phase: Phase;
  msg: string;
  kind: string;
}

export interface FOBState {
  name: string;
  hesco: number; // 0..100 fortification
  emplacements: { id: string; weaponId: string; cell: { cx: number; cy: number }; manned: boolean }[];
  observationPosts: { id: string; name: string; cell: { cx: number; cy: number } }[];
  claymores: number;
}

export interface CampaignState {
  seed: string;
  day: number;
  phaseIndex: number;
  totalDays: number;
  weather: Weather;
  platoon: Platoon;
  supplies: Supplies;
  cerp: number; // CERP funds ($)
  villages: VillageState[];
  intel: IntelReport[];
  directives: Directive[];
  metrics: Metrics;
  log: CampaignLogEntry[];
  fob: FOBState;
  enemyStrengthAbs: number; // absolute fighter pool in valley
  enemyHeat: number; // 0..1 current aggression/activity
  copCell: { cx: number; cy: number };
  civilians: Unit[]; // ambient population (for tactical seeding & atmospherics)
  tourScore: number;
  ended: boolean;
}

export interface Weather {
  label: string;
  visibilityM: number;
  wind: number;
  ceiling: number; // cloud ceiling (m) — affects air support
  airAvailable: boolean;
  precip: boolean;
}

let _logId = 0;
let _intelId = 0;
let _dirId = 0;

/** After loading a saved campaign, push the module id counters past existing ids
 *  so freshly generated log/intel/directive entries don't collide. */
export function reseedCounters(state: CampaignState) {
  _logId = Math.max(_logId, ...state.log.map((l) => l.id + 1), 0);
  _intelId = Math.max(_intelId, ...state.intel.map((r) => r.id + 1), 0);
  _dirId = Math.max(_dirId, ...state.directives.map((d) => d.id + 1), 0);
}

function rollWeather(rng: RNG, prev?: Weather): Weather {
  const states = [
    { label: "Clear", vis: 4000, ceil: 6000, precip: false, w: 0.4 },
    { label: "Hazy", vis: 2600, ceil: 4000, precip: false, w: 0.2 },
    { label: "Overcast", vis: 2200, ceil: 1200, precip: false, w: 0.18 },
    { label: "Rain", vis: 1500, ceil: 700, precip: true, w: 0.12 },
    { label: "Fog", vis: 600, ceil: 300, precip: false, w: 0.06 },
    { label: "Snow", vis: 900, ceil: 500, precip: true, w: 0.04 },
  ];
  const choice = rng.weighted(states, states.map((s) => s.w));
  return {
    label: choice.label,
    visibilityM: choice.vis + rng.int(-200, 200),
    wind: rng.range(0, 8),
    ceiling: choice.ceil,
    airAvailable: choice.ceil > 600 && !(choice.precip && rng.chance(0.5)),
    precip: choice.precip,
  };
}

const CERP_PROJECTS = [
  "well", "school", "clinic", "road repair", "micro-hydro", "retaining wall", "culvert", "mosque repair",
];

export function createCampaign(seed: string, totalDays = 120): { state: CampaignState; terrain: Terrain } {
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
    };
  });

  // Ambient civilians for atmospherics / tactical seeding.
  const civilians: Unit[] = [];
  for (const v of villages) {
    const n = Math.min(10, Math.round(v.population / 30));
    const spread = terrain.villages.find((tv) => tv.id === v.id)?.size ?? 3;
    for (let i = 0; i < n; i++) {
      const roles: Role[] = ["farmer", "herder", "villager", "child", "elder"];
      const role = rng.weighted(roles, [40, 20, 25, 12, 3]);
      const c = terrain.cellCenter(v.cx + rng.int(-spread, spread), v.cy + rng.int(-spread, spread));
      civilians.push(makeCivilian(rng.fork(`civ-${v.id}-${i}`), role, c, v.id));
    }
  }

  const enemyStrengthAbs = rng.int(40, 70);

  const state: CampaignState = {
    seed,
    day: 1,
    phaseIndex: 1, // start at Day
    totalDays,
    weather: rollWeather(rng),
    platoon,
    supplies: {
      ammo_556: 18000,
      ammo_762: 6000,
      ammo_50: 1200,
      ammo_40mm: 220,
      mortar_60: 90,
      mortar_81: 60,
      grenades: 80,
      smoke: 60,
      water: 240,
      food: 240,
      fuel: 1800,
      medical: 30,
      batteries: 120,
    },
    cerp: 25000,
    villages,
    intel: [],
    directives: [],
    metrics: {
      stability: 40,
      attitude: attitudeToMetric(villages),
      enemyStrength: clamp(enemyStrengthAbs, 0, 100),
      combatPower: 90,
      higherConfidence: 60,
    },
    log: [],
    fob: {
      name: "COP Vimoto",
      hesco: 60,
      claymores: 12,
      emplacements: [
        { id: "cp-n", weaponId: "m240", cell: { cx: terrain.copCell.cx, cy: terrain.copCell.cy - 2 }, manned: true },
        { id: "cp-e", weaponId: "m2", cell: { cx: terrain.copCell.cx + 2, cy: terrain.copCell.cy }, manned: true },
        { id: "cp-s", weaponId: "m240", cell: { cx: terrain.copCell.cx, cy: terrain.copCell.cy + 2 }, manned: true },
        { id: "cp-mortar", weaponId: "mortar60", cell: { cx: terrain.copCell.cx - 1, cy: terrain.copCell.cy + 1 }, manned: true },
      ],
      observationPosts: [],
    },
    enemyStrengthAbs,
    enemyHeat: 0.35,
    copCell: { ...terrain.copCell },
    civilians,
    tourScore: 0,
    ended: false,
  };

  // Position the platoon at the COP.
  const copWorld = terrain.cellCenter(terrain.copCell.cx, terrain.copCell.cy);
  for (const m of platoon.members) {
    m.pos = { x: copWorld.x + rng.range(-15, 15), y: copWorld.y + rng.range(-15, 15) };
  }

  pushLog(state, `Arrived at ${state.fob.name}. ${platoon.members.length} souls on the ground. The valley is quiet — for now.`, "info");
  issueInitialDirectives(state, rng);
  generatePhaseIntel(state, rng);
  return { state, terrain };
}

export function attitudeToMetric(villages: VillageState[]): number {
  if (villages.length === 0) return 50;
  const avg = villages.reduce((a, v) => a + v.attitude, 0) / villages.length;
  return clamp((avg + 100) / 2, 0, 100);
}

export function pushLog(state: CampaignState, msg: string, kind = "info") {
  state.log.push({ id: _logId++, day: state.day, phase: PHASES[state.phaseIndex], msg, kind });
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

export function addIntel(state: CampaignState, r: Omit<IntelReport, "id" | "day" | "phase">) {
  state.intel.unshift({ ...r, id: _intelId++, day: state.day, phase: PHASES[state.phaseIndex] });
  if (state.intel.length > 120) state.intel.length = 120;
}

function issueInitialDirectives(state: CampaignState, rng: RNG) {
  state.directives.push({
    id: _dirId++,
    title: "Establish Presence",
    desc: "Run security patrols in the valley. Show the flag. Battalion wants boots in every village within two weeks.",
    kind: "presence",
    issuedDay: 1,
    deadlineDay: 14,
    status: "active",
    progress: 0,
    reward: 12,
    penalty: 10,
  });
  state.directives.push({
    id: _dirId++,
    title: "Meet the Elders",
    desc: "Conduct a key leader engagement (shura) with at least two village elders. Win hearts; gather atmospherics.",
    kind: "kle",
    issuedDay: 1,
    deadlineDay: 21,
    status: "active",
    progress: 0,
    reward: 15,
    penalty: 8,
  });
  void rng;
}

export function currentPhase(state: CampaignState): Phase {
  return PHASES[state.phaseIndex];
}

export function ambientLight(state: CampaignState): number {
  const base = PHASE_LIGHT[currentPhase(state)];
  const w = state.weather;
  let mult = 1;
  if (w.label === "Overcast") mult = 0.8;
  else if (w.label === "Rain") mult = 0.7;
  else if (w.label === "Fog") mult = 0.6;
  else if (w.label === "Snow") mult = 0.85;
  return clamp01(base * mult);
}

/** Soldiers currently available (ready, rested) for a patrol. */
export function availableSoldiers(state: CampaignState): RosterMember[] {
  return state.platoon.members.filter((m) => m.status === "ready" && m.alive);
}

/** Advance one phase of the day: rest/recovery, attrition, events, enemy activity. */
export function advancePhase(state: CampaignState, rng: RNG): void {
  if (state.ended) return;
  state.phaseIndex++;
  if (state.phaseIndex >= 4) {
    state.phaseIndex = 0;
    state.day++;
    onNewDay(state, rng);
  }

  // Rest & recovery for soldiers at the COP.
  const atBase = state.platoon.members.filter((m) => m.status === "ready" || m.status === "rest");
  for (const m of atBase) {
    m.rest = clamp01(m.rest + (currentPhase(state) === "Night" ? 0.22 : 0.08));
    m.fatigue = clamp01(m.fatigue - 0.15);
    m.composure = clamp01(m.composure + 0.05);
    m.morale = clamp01(m.morale + (state.metrics.higherConfidence > 50 ? 0.01 : -0.01));
  }
  // Wounded recovery
  for (const m of state.platoon.members) {
    if (m.status === "wounded") {
      m.daysToRecover -= 0.25;
      if (m.daysToRecover <= 0) {
        m.status = "ready";
        m.hp = clamp(m.hp + 40, 30, 100);
        m.wounds = [];
        m.bleedRate = 0;
        pushLog(state, `${m.rank} ${lastName(m)} is back on full duty.`, "info");
      }
    }
  }

  // Daily-ish consumption (per phase fraction).
  consume(state, "water", state.platoon.members.length * 0.5);
  consume(state, "food", state.platoon.members.length * 0.5);
  consume(state, "batteries", 2);

  // Enemy activity & intel each phase.
  generatePhaseIntel(state, rng);
  updateEnemyHeat(state, rng);
  recomputeMetrics(state);
  checkDirectives(state);
  checkTourEnd(state);
}

function onNewDay(state: CampaignState, rng: RNG) {
  state.weather = rollWeather(rng, state.weather);
  pushLog(state, `Day ${state.day}. Weather: ${state.weather.label}, vis ${(state.weather.visibilityM / 1000).toFixed(1)}km, ${state.weather.airAvailable ? "air available" : "no air (weather)"}.`, "info");
  // morale drift over a long deployment (the grind)
  for (const m of state.platoon.members) {
    if (m.alive) m.morale = clamp01(m.morale - 0.004 + (state.metrics.stability > 55 ? 0.004 : 0));
  }
  // periodic new directive
  if (state.day % 18 === 0) issuePeriodicDirective(state, rng);
}

function issuePeriodicDirective(state: CampaignState, rng: RNG) {
  const options: Omit<Directive, "id" | "issuedDay" | "status" | "progress">[] = [
    {
      title: "Census the Valley",
      desc: "Complete a census of military-age males in at least three villages. Build the human-terrain picture.",
      kind: "census",
      deadlineDay: state.day + 20,
      reward: 14,
      penalty: 8,
    },
    {
      title: "Interdict the Rat Line",
      desc: "Insurgents are moving fighters and weapons through the upper draws. Set an ambush and disrupt the infiltration route.",
      kind: "interdict",
      deadlineDay: state.day + 16,
      reward: 18,
      penalty: 10,
    },
    {
      title: "Build the Road",
      desc: "Provide security for the road project linking the lower villages. Deliver a CERP construction project.",
      kind: "construct",
      deadlineDay: state.day + 24,
      reward: 16,
      penalty: 9,
    },
  ];
  const o = rng.pick(options);
  state.directives.push({ ...o, id: _dirId++, issuedDay: state.day, status: "active", progress: 0 });
  pushLog(state, `FRAGO from battalion: "${o.title}". ${o.desc}`, "objective");
}

function updateEnemyHeat(state: CampaignState, rng: RNG) {
  // Heat rises with low stability and hostile villages; falls when you hurt them.
  const hostility = state.villages.reduce((a, v) => a + (v.attitude < 0 ? 1 : 0), 0) / Math.max(1, state.villages.length);
  const target = clamp01(0.25 + hostility * 0.4 + (1 - state.metrics.stability / 100) * 0.4);
  state.enemyHeat = clamp01(state.enemyHeat + (target - state.enemyHeat) * 0.2 + rng.gauss(0, 0.04));
}

export function generatePhaseIntel(state: CampaignState, rng: RNG) {
  const phase = currentPhase(state);
  // SIGINT chatter scales with enemy heat; quality varies.
  if (rng.chance(0.35 + state.enemyHeat * 0.4)) {
    const v = rng.pick(state.villages);
    const lines = [
      `ICOM: "...the donkeys are loaded, move them after dark..."`,
      `ICOM: "...are the guests still in the upper house?..."`,
      `ICOM: "...wait until they reach the big rock, then..."`,
      `ICOM: "...the Americans came to ${v.name} today, count them..."`,
      `ICOM: "...we need more for the PK, send it down the draw..."`,
      `ICOM: "...do not fire until I say... be patient..."`,
    ];
    addIntel(state, { source: "SIGINT", text: rng.pick(lines), reliability: rng.range(0.3, 0.7), cx: v.cx, cy: v.cy });
  }
  // HUMINT from cooperative villages.
  const coop = state.villages.filter((v) => v.cooperation > 50);
  if (coop.length && rng.chance(0.25)) {
    const v = rng.pick(coop);
    addIntel(state, {
      source: "HUMINT",
      text: `A man from ${v.name} says fighters from outside the valley are staying near ${rng.pick(state.villages).name}. He wants a clinic.`,
      reliability: clamp01(v.cooperation / 130),
      cx: v.cx,
      cy: v.cy,
    });
  }
  // Night brings more movement.
  if (phase === "Night" && rng.chance(0.3)) {
    addIntel(state, { source: "DRONE", text: `ISR: thermal hits moving along a trail in the upper valley after curfew.`, reliability: 0.6 });
  }
}

export function consume(state: CampaignState, key: keyof Supplies, amount: number) {
  state.supplies[key] = Math.max(0, state.supplies[key] - amount);
}

export function recomputeMetrics(state: CampaignState) {
  const m = state.metrics;
  m.attitude = attitudeToMetric(state.villages);
  m.enemyStrength = clamp(state.enemyStrengthAbs, 0, 100);
  // combat power from living/ready troops and ammo
  const total = state.platoon.members.length;
  const ready = state.platoon.members.filter((x) => x.alive && x.status === "ready").length;
  const ammoFrac = clamp01(state.supplies.ammo_556 / 18000);
  m.combatPower = clamp((ready / Math.max(1, total)) * 70 + ammoFrac * 30, 0, 100);
  // stability is a slow blend of attitude, enemy strength, and your presence
  const stabTarget = clamp(m.attitude * 0.5 + (100 - m.enemyStrength) * 0.35 + m.combatPower * 0.15, 0, 100);
  m.stability = clamp(m.stability + (stabTarget - m.stability) * 0.15, 0, 100);
}

function checkDirectives(state: CampaignState) {
  for (const d of state.directives) {
    if (d.status !== "active") continue;
    if (state.day > d.deadlineDay) {
      d.status = "failed";
      state.metrics.higherConfidence = clamp(state.metrics.higherConfidence - d.penalty, 0, 100);
      pushLog(state, `Directive FAILED: "${d.title}". Battalion is not pleased.`, "objective");
    }
  }
}

export function completeDirective(state: CampaignState, id: number) {
  const d = state.directives.find((x) => x.id === id);
  if (!d || d.status !== "active") return;
  d.status = "complete";
  d.progress = 1;
  state.metrics.higherConfidence = clamp(state.metrics.higherConfidence + d.reward, 0, 100);
  pushLog(state, `Directive COMPLETE: "${d.title}". +${d.reward} higher confidence.`, "objective");
}

function checkTourEnd(state: CampaignState) {
  if (state.day > state.totalDays && !state.ended) {
    state.ended = true;
    state.tourScore = computeTourScore(state);
    pushLog(state, `The tour is over. Relief in place complete. Time to go home.`, "objective");
  }
  if (state.metrics.higherConfidence <= 0 && !state.ended) {
    state.ended = true;
    state.tourScore = computeTourScore(state);
    pushLog(state, `You have been relieved of command. Battalion has lost confidence in your leadership.`, "objective");
  }
}

export function computeTourScore(state: CampaignState): number {
  const m = state.metrics;
  const kia = state.platoon.members.filter((x) => !x.alive).length;
  const base = m.stability * 0.3 + m.attitude * 0.25 + (100 - m.enemyStrength) * 0.2 + m.higherConfidence * 0.25;
  const penalty = kia * 4;
  return Math.round(clamp(base - penalty, 0, 100));
}

/** Apply the result of a tactical engagement back into the campaign. */
export function applyCombatResult(
  state: CampaignState,
  rng: RNG,
  result: CombatResult,
  finalUnits: Unit[],
  ctx: { villageId?: string; ammoByCaliber?: Partial<Record<keyof Supplies, number>> }
) {
  // Casualties → roster
  for (const u of finalUnits) {
    if (u.faction !== "us" && u.faction !== "ana") continue;
    const m = state.platoon.members.find((x) => x.id === u.id);
    if (!m) continue;
    m.kills += u.kills;
    if (!u.alive) {
      m.status = "kia";
      m.alive = false;
      m.hp = 0;
      pushLog(state, `${m.rank} ${lastName(m)} of ${m.homeState} was killed in action. He was ${ageGuess(rng)}.`, "kia");
      state.metrics.higherConfidence = clamp(state.metrics.higherConfidence - 3, 0, 100);
      // morale shock across the platoon
      for (const o of state.platoon.members) if (o.alive) o.morale = clamp01(o.morale - 0.05);
    } else if (u.wounds.length > 0) {
      m.status = "wounded";
      m.hp = clamp(u.hp, 5, 100);
      m.wounds = u.wounds;
      m.daysToRecover = clamp(2 + u.wounds.reduce((a, w) => a + w.severity * 14, 0), 1, 45);
      pushLog(state, `${m.rank} ${lastName(m)} was wounded (${u.wounds.map((w) => w.region).join(", ")}) and evacuated.`, "casualty");
    } else {
      m.composure = u.composure;
      m.fatigue = u.fatigue;
    }
  }

  // Enemy attrition reduces the valley pool.
  state.enemyStrengthAbs = clamp(state.enemyStrengthAbs - result.enemyKIA, 0, 100);

  // Civilian casualties are catastrophic for the COIN fight.
  if (result.civCasualties > 0) {
    pushLog(state, `${result.civCasualties} civilian casualt${result.civCasualties === 1 ? "y" : "ies"} reported. Word will travel fast.`, "casualty");
    for (const v of state.villages) {
      v.attitude = clamp(v.attitude - 12 * result.civCasualties, -100, 100);
      v.sympathy = clamp(v.sympathy + 8 * result.civCasualties, 0, 100);
    }
    state.metrics.higherConfidence = clamp(state.metrics.higherConfidence - 4 * result.civCasualties, 0, 100);
    state.enemyHeat = clamp01(state.enemyHeat + 0.1 * result.civCasualties);
  }

  // Ammo expenditure.
  if (ctx.ammoByCaliber) {
    for (const k of Object.keys(ctx.ammoByCaliber) as (keyof Supplies)[]) {
      consume(state, k, ctx.ammoByCaliber[k] ?? 0);
    }
  } else {
    consume(state, "ammo_556", Math.round(result.ammoExpended * 0.7));
    consume(state, "ammo_762", Math.round(result.ammoExpended * 0.2));
  }
  consume(state, "mortar_60", Math.min(state.supplies.mortar_60, result.fireMissionsUsed * 6));

  // Hurting the enemy raises stability and elder cooperation slightly; a beating near a village shifts attitudes.
  if (result.enemyKIA > 0) {
    state.metrics.higherConfidence = clamp(state.metrics.higherConfidence + Math.min(6, result.enemyKIA), 0, 100);
  }
  recomputeMetrics(state);
}

function lastName(m: RosterMember): string {
  const p = m.name.split(" ");
  return p[p.length - 1];
}

function ageGuess(rng: RNG): string {
  return `${rng.int(19, 34)}`;
}
