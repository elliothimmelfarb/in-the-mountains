import { RNG, clamp } from "./rng";

/**
 * Shared campaign data types and a few pure helpers. The live simulation itself
 * lives in `world.ts` (one continuous real-time clock); this module is just the
 * vocabulary they share — supplies, villages, intel, directives, weather.
 */

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
  construction: number; // building materials (HESCO, lumber, rebar, cement) for CERP work
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
  projects: string[]; // completed project labels
  elder: string;
  lastVisitedDay: number;
  censusDone: boolean;
  wants: string; // what would win them over (a project type)
}

export interface IntelReport {
  id: number;
  day: number;
  timeLabel: string;
  source: "SIGINT" | "HUMINT" | "PATROL" | "DRONE" | "HIGHER";
  text: string;
  reliability: number; // 0..1
  cx?: number;
  cy?: number;
}

export type DirectiveKind =
  | "presence"
  | "kle"
  | "census"
  | "interdict"
  | "construct"
  | "hold"
  | "casualty";

export interface Directive {
  id: number;
  title: string;
  desc: string;
  kind: DirectiveKind;
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
  timeLabel: string;
  msg: string;
  kind: string;
}

export interface Emplacement {
  id: string;
  weaponId: string;
  cell: { cx: number; cy: number };
  manned: boolean;
}

export interface FOBState {
  name: string;
  hesco: number; // 0..100 fortification
  emplacements: Emplacement[];
  observationPosts: { id: string; name: string; cell: { cx: number; cy: number } }[];
  claymores: number;
}

export interface Weather {
  label: string;
  visibilityM: number;
  wind: number; // prevailing wind SPEED (m/s)
  windDir: number; // prevailing (synoptic) wind direction, radians — blows toward this heading
  ceiling: number; // cloud ceiling (m) — affects air support
  airAvailable: boolean;
  precip: boolean;
}

const WEATHER_STATES = [
  { label: "Clear", vis: 4000, ceil: 6000, precip: false, w: 0.4 },
  { label: "Hazy", vis: 2600, ceil: 4000, precip: false, w: 0.2 },
  { label: "Overcast", vis: 2200, ceil: 1200, precip: false, w: 0.18 },
  { label: "Rain", vis: 1500, ceil: 700, precip: true, w: 0.12 },
  { label: "Fog", vis: 600, ceil: 300, precip: false, w: 0.06 },
  { label: "Snow", vis: 900, ceil: 500, precip: true, w: 0.04 },
];

export function rollWeather(rng: RNG): Weather {
  const choice = rng.weighted(WEATHER_STATES, WEATHER_STATES.map((s) => s.w));
  return {
    label: choice.label,
    visibilityM: choice.vis + rng.int(-200, 200),
    wind: rng.range(0, 8),
    windDir: rng.range(0, Math.PI * 2),
    ceiling: choice.ceil,
    airAvailable: choice.ceil > 600 && !(choice.precip && rng.chance(0.5)),
    precip: choice.precip,
  };
}

/** Weather's multiplier on ambient light (overcast/fog darken the valley). */
export function weatherLightMult(w: Weather): number {
  switch (w.label) {
    case "Overcast":
      return 0.8;
    case "Rain":
      return 0.7;
    case "Fog":
      return 0.6;
    case "Snow":
      return 0.85;
    default:
      return 1;
  }
}

export function attitudeToMetric(villages: VillageState[]): number {
  if (villages.length === 0) return 50;
  const avg = villages.reduce((a, v) => a + v.attitude, 0) / villages.length;
  return clamp((avg + 100) / 2, 0, 100);
}

export const CERP_PROJECTS = [
  "well",
  "school",
  "clinic",
  "road repair",
  "micro-hydro",
  "retaining wall",
  "culvert",
  "footbridge",
  "mosque repair",
];
