import { MoveTechnique } from "../entities";
import { Vec2 } from "../vec";
import {
  Supplies,
  VillageState,
  IntelReport,
  Directive,
  Metrics,
  Weather,
  FOBState,
  CampaignLogEntry,
} from "../campaign";

/** Patrol mission flavor (KLE and projects are their own task kinds). */
export type MissionType = "presence" | "recon" | "ambush" | "census" | "cordon" | "overwatch";

export const MISSION_LABEL: Record<MissionType, string> = {
  presence: "Presence Patrol",
  recon: "Reconnaissance",
  ambush: "Ambush / Interdiction",
  census: "Census",
  cordon: "Cordon & Search",
  overwatch: "Establish OP",
};

export type TaskKind = "patrol" | "kle" | "project" | "return" | "standto";

export interface Task {
  id: number;
  kind: TaskKind;
  label: string;
  memberIds: string[];
  technique: MoveTechnique;
  missionType?: MissionType;
  villageId?: string;
  projectId?: number;
  /** Objective waypoints (world meters), not counting the return leg. */
  route: Vec2[];
  legIndex: number;
  phase: "assembling" | "moving" | "onstation" | "returning" | "complete";
  timer: number; // seconds left in the current timed phase
  startedClock: number;
  /** Squad movement: the point man, whether the element has cleared the wire,
   *  a governor timer, and a no-progress backstop so a leg/return that can't be
   *  closed (a blocked objective) is force-advanced instead of freezing. */
  leadId?: string;
  exited?: boolean;
  holdTimer?: number;
  goalDist?: number; // best centroid→objective distance seen this leg
  noProgressS?: number; // seconds since that best improved
}

export type ProjectStage =
  | "awaiting_materials"
  | "awaiting_contractor"
  | "building"
  | "complete"
  | "sabotaged";

export interface Project {
  id: number;
  villageId: string;
  type: string;
  stage: ProjectStage;
  progress: number; // 0..1
  materialsDelivered: boolean;
  contractorOnSite: boolean;
  etaMaterials: number; // clock seconds
  etaContractor: number;
  buildSeconds: number; // total secured-build time required
  stalledS: number; // accumulated time stalled without security
}

export interface PendingEvent {
  id: string;
  kind: string;
  title: string;
  body: string;
  choices: { id: string; label: string; hint?: string }[];
  cx?: number;
  cy?: number;
}

export interface ResupplyRun {
  id: number;
  kind: "convoy" | "air";
  eta: number;
  frac: number;
}

export interface WorldState {
  seed: string;
  totalDays: number;
  clock: number; // game-seconds since 0600 day 1
  weather: Weather;
  nextWeatherAt: number;
  supplies: Supplies;
  cerp: number;
  villages: VillageState[];
  intel: IntelReport[];
  directives: Directive[];
  metrics: Metrics;
  log: CampaignLogEntry[];
  fob: FOBState;
  copCell: { cx: number; cy: number };
  enemyStrengthAbs: number;
  enemyHeat: number;
  tasks: Task[];
  projects: Project[];
  resupplies: ResupplyRun[];
  tourScore: number;
  ended: boolean;
  endReason?: string;
  // director bookkeeping
  nextActivityAt: number;
  nextIntelAt: number;
  nextEventAt: number;
  lastContactClock: number;
  // platoon org (members live on the sim units)
  platoon: { callsign: string; squads: { id: string; name: string; memberIds: string[] }[] };
}

export const DEPLOY_START = 6 * 3600; // 0600 on day 1
export const DAY = 86400;
export const MAX_ACTIVE_ENEMY = 26;

/** Shared, monotonically-increasing id counters across the world modules. */
export const Ids = { log: 0, intel: 0, dir: 0, task: 0, proj: 0, ev: 0 };

export function resetIds() {
  Ids.log = Ids.intel = Ids.dir = Ids.task = Ids.proj = Ids.ev = 0;
}
