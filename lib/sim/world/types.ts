import { MoveTechnique, ROE } from "../entities";
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

// ===========================================================================
//  Squad SOP — the standing operating procedure (the entire UX↔AI contract).
//  You set it before the squad steps off; it locks while the squad is in contact.
//  Three settings, nothing else: how they MOVE, what they do ON CONTACT, and the
//  RULES OF ENGAGEMENT that govern the trigger.
// ===========================================================================

/** How the squad moves to its waypoints. */
export type MovementSOP = "stealth" | "patrol" | "fast";
/** The standing battle drill the squad AI runs the instant it makes contact. */
export type ContactSOP = "hold" | "assault" | "break" | "suppress";

export interface SquadSOP {
  movement: MovementSOP; // stealth = slow, hug cover; patrol = balanced; fast = road march
  contact: ContactSOP; // hold & return fire / assault through / break contact / suppress & call fires
  roe: ROE; // weapons hold / tight (civilian-safe, the COIN default) / free
}

export const MOVEMENT_SOP_LABEL: Record<MovementSOP, string> = {
  stealth: "Stealth",
  patrol: "Patrol",
  fast: "Fast",
};
export const CONTACT_SOP_LABEL: Record<ContactSOP, string> = {
  hold: "Hold & Return Fire",
  assault: "Assault",
  break: "Break Contact",
  suppress: "Suppress & Call Fires",
};
export const ROE_LABEL: Record<ROE, string> = {
  hold: "Weapons Hold",
  tight: "Tight",
  free: "Weapons Free",
};

/** Map the movement SOP to the underlying squad movement technique. */
export function sopTechnique(m: MovementSOP): MoveTechnique {
  return m === "stealth" ? "concealed" : m === "fast" ? "traveling" : "patrol";
}

/** Sensible default SOP seeded by the mission type (the player can override before step-off). */
export function defaultSOP(mission: MissionType | undefined): SquadSOP {
  switch (mission) {
    case "ambush":
      return { movement: "stealth", contact: "suppress", roe: "tight" };
    case "recon":
      return { movement: "stealth", contact: "break", roe: "tight" };
    case "overwatch":
      return { movement: "patrol", contact: "suppress", roe: "tight" };
    case "cordon":
      return { movement: "patrol", contact: "hold", roe: "tight" };
    case "census":
    case "presence":
    default:
      return { movement: "patrol", contact: "hold", roe: "tight" };
  }
}

export type TaskKind = "patrol" | "kle" | "project" | "secure" | "return" | "standto";

export interface Task {
  id: number;
  kind: TaskKind;
  label: string;
  memberIds: string[];
  technique: MoveTechnique;
  /** The squad's standing operating procedure (movement / on-contact drill / ROE).
   *  Set before step-off, locked while the squad is in contact. The combat AI reads it. */
  sop?: SquadSOP;
  missionType?: MissionType;
  villageId?: string;
  projectId?: number;
  /** A "secure" task: the village whose CERP project site this element holds. */
  secureVillageId?: string;
  /** Squad-combat coordinator state (transient combat bookkeeping; persisted so a
   *  firefight survives a save/load mid-contact). Set/cleared by ai/squad-combat.ts. */
  squadState?: string; // react | suppress_hold | assault | break_contact | go_firm
  squadTimer?: number; // min-dwell / reconsider hysteresis
  contactHold?: number; // seconds the squad stays "in contact" after the last round/sighting (anti-flicker)
  bofIds?: string[]; // base-of-fire element this contact
  mnvrIds?: string[]; // maneuver element this contact
  rallyPt?: Vec2; // break-contact / casualty-collection rally point
  threatPt?: Vec2; // the squad's current threat centroid (for the map's base-of-fire/maneuver overlay)
  /** The covered FLANK objective the squad-leader AI routes the maneuver element to (not the
   *  threat centroid — a frontal rush is doctrinally wrong). Surfaced to the map overlay. */
  flankPt?: Vec2;
  /** Bounding overwatch: which buddy pair of the maneuver element is moving (0/1) and the world
   *  clock the current bound expires — so only one element moves at a time (3–5 s rushes). */
  boundPair?: number;
  boundUntil?: number;
  /** World clock the squad entered its current FIXING posture — the SOP-keyed "develop the
   *  situation" timer. An aggressive SOP commits the assault immediately; a cautious one fixes and
   *  develops first (and many contacts end before it commits), so the SOP is a real behavioral lever. */
  fixSince?: number;
  /** Pinned-revert bookkeeping (squad-combat): when the current assault committed, when its
   *  maneuver element became majority-pinned, which flank sign it used (a re-commit prefers
   *  the OTHER side), and when the squad last reverted (a re-develop floor so an aggressive
   *  SOP can't flip-flop assault↔suppress on consecutive reconsiders). */
  assaultSince?: number;
  mnvrPinnedSince?: number;
  lastFlankSide?: number;
  revertedAt?: number;
  /** Post-contact CONSOLIDATE & REORGANIZE (FM 3-21.8): until this world-clock the element
   *  holds a tight ring, the SL walks the line team to team (consolidateStep), and rifle
   *  ammo is cross-levelled onto the guns once (aceDone). Cleared the instant contact
   *  resumes; the march/exfil resumes when it expires. */
  consolidateUntil?: number;
  consolidateStep?: number;
  aceDone?: boolean;
  /** Point-man caution: the held beat at a choke mouth (raised fist) and its per-choke
   *  cooldown, both on the world clock. */
  chokeHoldUntil?: number;
  chokeCooldownUntil?: number;
  lastSmokeClock?: number; // world clock of the squad's last smoke pop (throttle)
  /** Throttle clock (seconds) for the on-station dwell event-roll. A long realistic dwell is
   *  patient hours the player WARPS through; this rolls occasionally for a moment that pulls him
   *  back — a cache find, a biometric hit, a grievance, a squirter. Persisted so a save mid-dwell
   *  doesn't reset the cadence. */
  dwellEventClock?: number;
  /** The kind of the last dwell event fired on this dwell, so the roll never repeats it
   *  back-to-back (a long census drawing the same grievance twice reads as a bug). */
  lastDwellEventKind?: string;
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
  arrivedHoldS?: number; // seconds the point man has held on the objective waiting for the element to close up
  homeFileS?: number; // seconds the element has been filing back in through the gate (return-leg budget)
  /** Breadcrumb of where the point man has actually walked (newest last), so the
   *  rest of the squad moves in trace along his real route rather than chasing
   *  rigid geometric slots; reset when the navigator changes. */
  trail?: Vec2[];
  trailLeadId?: string;
  /** Cached security-halt sector bearing per member (memberId → outward facing), so a
   *  perimeter isn't reshuffled every time contact flickers and the men re-occupy. */
  ringSlots?: Record<string, number>;
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

/** A squad's call for fire — under hands-off combat the JTAC/squad leader AI requests
 *  indirect/CAS and the COMMANDER (player) approves or denies it (keeping a human in the
 *  civilian-casualty loop). One pending request at a time; it auto-expires if ignored. */
export interface FireRequest {
  squadId: string;
  taskId: number;
  label: string;
  weaponId: string; // proposed asset (mortar60 / mortar81 / cas_gun)
  cx: number;
  cy: number; // proposed grid (the JTAC's call)
  reason: string;
  expires: number; // clock seconds — clears if the commander never answers
  /** True for a COP/garrison Final-Protective-Fire request: it has no maneuver Task, so the
   *  validator must NOT expire it on the missing-task check (only on timeout). */
  copBound?: boolean;
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
  /** A pending AI call-for-fire awaiting the commander's approval (null when none). */
  fireRequest?: FireRequest | null;
  lastFireReqClock?: number; // throttle: clock of the last request raised
  tourScore: number;
  ended: boolean;
  endReason?: string;
  // director bookkeeping
  nextActivityAt: number;
  nextIntelAt: number;
  nextEventAt: number;
  lastContactClock: number;
  // COIN strategic clock (v6): the next battalion CERP disbursement, the next directive
  // issuance, and the running civilian-casualty count attributed to our fires. All three are
  // persisted by serialize() (it dumps `state` whole) and defaulted in loadWorld for old saves.
  nextCerpStipendAt: number;
  nextDirectiveAt: number;
  civCasualties: number;
  // Relief-of-command is a SUSTAINED-failure trigger, not a single bad day: a battalion relieves
  // a commander over a trend (a formal review), not one catastrophic firefight. This is the clock
  // at which higherConfidence first fell to/under the critical floor; relief fires only if it
  // stays under continuously through the review window. -1 = confidence is healthy (no watch).
  // Persisted by serialize() (dumps `state` whole); defaulted to -1 in loadWorld for old saves.
  reliefWatchClock: number;
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
