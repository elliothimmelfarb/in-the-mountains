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
  /** Wedge-wait: when a follower is genuinely BLOCKED (stuck on a building / the wire / broken
   *  ground) and trailing, the point man takes a knee and HOLDS until this world-clock, then a
   *  cooldown before he can hold again — so a stuck man can't string the file out, and can't
   *  freeze the patrol either. Both on the world clock; transient (persisted with state). */
  wedgeHoldUntil?: number;
  wedgeCooldownUntil?: number;
  wedgeHeldTotal?: number; // s of wedge-halt spent THIS leg (budget cap; reset each waypoint)
  lastSmokeClock?: number; // world clock of the squad's last smoke pop (throttle)
  /** Throttle clock (seconds) for the on-station dwell event-roll. A long realistic dwell is
   *  patient hours the player WARPS through; this rolls occasionally for a moment that pulls him
   *  back — a cache find, a biometric hit, a grievance, a squirter. Persisted so a save mid-dwell
   *  doesn't reset the cadence. */
  dwellEventClock?: number;
  /** The kind of the last dwell event fired on this dwell, so the roll never repeats it
   *  back-to-back (a long census drawing the same grievance twice reads as a bug). */
  lastDwellEventKind?: string;
  /** KLE only: has the summoned elder physically sat down with the squad leader yet?
   *  false = the shura hasn't formed — the attitude drip, the ask-roll and the dwell
   *  events all WAIT (the player watches the meeting happen before deciding anything).
   *  A 15-game-minute no-show flips it with "the elder sends his regrets" (a tell).
   *  Undefined for every other task kind; loadWorld defaults in-flight legacy KLEs. */
  elderMet?: boolean;
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

// ===========================================================================
//  The persistent enemy ORDER OF BATTLE (v10 — lib/sim/world/network.ts).
//  The insurgency stops being a weather system (a scalar + a memoryless director)
//  and becomes an ORGANIZATION: named cells with home areas and physical munitions
//  caches. The director SPENDS cells; exfiltrated fighters flow BACK into their cell;
//  killing a named leader forces succession; a won-over village gives its cell up
//  (HUMINT). `enemyStrengthAbs` is now the DERIVED SUM of living cell strengths, so
//  every existing reader keeps working unchanged.
// ===========================================================================

export interface EnemyCell {
  id: string;
  leaderName: string; // Afghan name; survives between activities, renamed on succession
  leaderAlive: boolean; // false during the succession pause after the named leader is killed
  homeCx: number; // reachability-snapped home area (a draw / spur near its villages)
  homeCy: number;
  strength: number; // fighters this cell can field; Σ over living cells === enemyStrengthAbs
  aggression: number; // 0..1 personality — weights ambush/complex vs harass in the director roll
  iedSkill: number; // 0..1 — grows on successful IED activity, weights future IED choice
  grudge: number; // 0..1 — rises when the cell takes KIA; lifts its tempo vs the player
  villageIds: string[]; // recruiting/intimidation base (drives this cell's regen share)
  intelLevel: 0 | 1 | 2 | 3; // what the PLAYER has learned: unknown → named → located → mapped
  lastActivityClock: number;
  /** Clock at which the new leader takes over after the named one is killed (leaderAlive=false
   *  until then). Undefined = no succession pending. The cell stages nothing while it's set. */
  successionAt?: number;
  /** Strength collapsed below the break floor: the cell is out of the fight (survivors merged
   *  into the nearest living cell or dissolved). Excluded from the derived-strength sum. */
  broken?: boolean;
}

export interface EnemyCache {
  id: string;
  cx: number;
  cy: number;
  munitions: number; // IED/ambush activity near it spends from here
  found: boolean; // revealed to the player (event / HUMINT)
  destroyed: boolean; // seized or blown — permanently out
  cellId: string; // owner cell
}

export interface EnemyNetwork {
  cells: EnemyCell[];
  caches: EnemyCache[];
}

/** The baseline the weekly Commander's Assessment (BUB) measures its "since last week" deltas
 *  against — a small per-village snapshot plus higher's confidence, stamped with the game-day it
 *  was taken. Rewritten each time an assessment fires (lib/sim/world/assessment.ts). Persisted
 *  whole by serialize(); loadWorld presence-defaults it. NOT ground truth about the enemy — the
 *  assessment reads the network only through the intel-gated `enemyPicture` helper. */
export interface BubSnapshot {
  day: number;
  higherConfidence: number;
  villages: Record<string, { attitude: number; kept: number; broken: number; grievances: number; projects: number }>;
}

/** Coarse patrol-heat grid resolution (HEAT_DIM² buckets over the whole map). The enemy learns
 *  WHERE you habitually patrol — high-heat road/trail cells become preferred IED ground, so
 *  predictable patrolling is physically dangerous and route variety is a real decision. */
export const HEAT_DIM = 32;

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
  // v9: the relief EVIDENCE FILE (issue 035). Battalion relieves over a pattern it can NAME,
  // so every higher-confidence dock is attributed by cause: "casualties" (friendly KIA),
  // "civcas" (civilian casualties, incl. the failed protect-the-population directive),
  // "directives" (deadline failures). Read at review time for the pattern test and to
  // compose the attributed relief reason. Persisted whole; defaulted zeroed in loadWorld.
  confLedger: { casualties: number; civcas: number; directives: number };
  // Unique day numbers on which friendly KIA occurred — one catastrophic ambush is a single
  // entry however many men it cost; casualties across separate days are a PATTERN.
  kiaDays: number[];
  // higherConfidence at the moment the relief watch opened (-1 = no watch). A commander
  // visibly climbing out of the hole gets the review extended, not a relief.
  reliefWatchConf: number;
  // platoon org (members live on the sim units)
  platoon: { callsign: string; squads: { id: string; name: string; memberIds: string[] }[] };
  // v10: the persistent enemy ORDER OF BATTLE (lib/sim/world/network.ts). enemyStrengthAbs above
  // is the DERIVED SUM of living cell strengths; patrolHeat is a HEAT_DIM² coarse decaying grid of
  // where the player habitually patrols (drives IED site selection). Both persisted whole by
  // serialize(); loadWorld regenerates the network (and zeroes the heat) for pre-v10 saves.
  network: EnemyNetwork;
  patrolHeat: number[];
  // v10 HUD wave: the weekly Commander's Assessment (BUB). `bubSnapshot` is the baseline the next
  // assessment measures deltas from (null before the first snapshot is taken); `nextBubDay` is the
  // game-day the next BUB is due (it fires on the first tick past 0700 that day, when not in
  // contact). Both persisted whole by serialize(); loadWorld presence-defaults them for old saves.
  bubSnapshot: BubSnapshot | null;
  nextBubDay: number;
}

export const DEPLOY_START = 6 * 3600; // 0600 on day 1
export const DAY = 86400;
export const MAX_ACTIVE_ENEMY = 26;

/** Shared, monotonically-increasing id counters across the world modules. */
export const Ids = { log: 0, intel: 0, dir: 0, task: 0, proj: 0, ev: 0 };

export function resetIds() {
  Ids.log = Ids.intel = Ids.dir = Ids.task = Ids.proj = Ids.ev = 0;
}
