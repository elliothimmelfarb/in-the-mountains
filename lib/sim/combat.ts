import { RNG, clamp, clamp01, lerp, smoothstep } from "./rng";
import { Vec2, dist, sub, norm, scale, add, len, fromAngle, angle, angleDiff, segDist } from "./vec";
import { Terrain } from "./terrain";
import { Unit, unitHeight, eyeHeight, MoveTechnique } from "./entities";
import { findPath, walkable } from "./path";

// Issue 020 A/B kill-switch (read once): ITM_NOOBJCOVER=1 disables the directional cover-object
// occlusion in coverFor, so a same-seed balance bisect can isolate its combat effect on the shared tree.
const NO_OBJ_COVER = process.env.ITM_NOOBJCOVER === "1";

// Battery reserve below which the US lose their NODs at night (issue 021 logistics teeth). The World
// pushes supplies.batteries into sim.nvgPower each tick; below this the night-vision edge goes dark.
const NVG_MIN_BATTERIES = 8;

// Threat-weighted contact (issue 025 — CombatSim.threatening)
const THREAT_RECENT_S = 15; // a man who shot inside this window is still fighting
const THREAT_CLOSE_M = 125; // inside decisive small-arms range a visible enemy always holds contact
const THREAT_AWAY_MARGIN_M = 20; // his path must end this much farther away to count as breaking contact
import { steer } from "./steering";
import { getWeapon, Weapon } from "./weapons";
import { lineOfSight, detectionChance, LOSResult, SmokeScreen } from "./los";
import {
  Projectile,
  spawnProjectile,
  resolveDirectHit,
  applyDamage,
  blastDamageAt,
  silhouetteRadius,
} from "./ballistics";
import { insurgentBrain } from "./ai/insurgent";
import { runCellBrains } from "./ai/cell-combat";
import { civilianBrain } from "./ai/civilian";
import { friendlyBrain } from "./ai/friendly";

export type { MoveTechnique } from "./entities";

// Player-issued orders were removed in the squad-command overhaul: there is no
// individual-soldier control. All combat intent now comes from the squad-combat
// coordinator (ai/squad-combat.ts), which writes Unit fields the brains execute.

export type EffectKind =
  | "muzzle"
  | "impact"
  | "ricochet"
  | "blast"
  | "blood"
  | "frag_air"
  | "smoke_pop"
  | "flare"
  | "reload"; // a man swapping mags — audio-only (renderers ignore it); emitted once per reload

export interface Effect {
  id: number;
  kind: EffectKind;
  pos: Vec2;
  to?: Vec2;
  t: number;
  ttl: number;
  faction?: Unit["faction"];
  size?: number;
  facing?: number; // muzzle flash: shooter's heading (rad), for a directional flash cone
  ied?: boolean; // blast: a buried-charge initiation (a bigger, dirtier scar than a mortar)
  weapon?: string; // weapons.ts id of the system that produced this (muzzle/blast/reload) —
  //                  carries calibre identity to the audio mapper (an M2 is not an M4)
}

export type LogKind = "info" | "contact" | "casualty" | "kia" | "radio" | "support" | "objective";

export interface LogEntry {
  id: number;
  timeS: number;
  msg: string;
  kind: LogKind;
}

/** The things a man actually shouts in a fight — surfaced on the map as brief plates
 *  beside the figure (lib/render/callouts.ts). Sparse and weighty by construction:
 *  `say()` dedups per (squad, type) on the sim clock, so a running drill cannot bark. */
export type CalloutType =
  | "contact" // first spotter, with the true relative bearing ("contact left!")
  | "man_down" // a buddy saw him drop
  | "covering" // bounding overwatch half, on the pair swap
  | "moving" // bounding rush half, on the pair swap
  | "doc" // buddy-aid peel / calling the medic up
  | "on_me" // leader succession
  | "falling_back" // break contact / assault reverted
  | "head_count" // post-contact consolidation
  | "set"; // security in place (medic-scene buddy, element set)

/** A diegetic callout. Ephemeral presentation state like `sim.log` — NOT serialized;
 *  replay-stable because every emission derives from deterministic sim transitions
 *  and `say()` never draws from the rng (phrase variants are hash-picked). */
export interface Callout {
  id: number;
  timeS: number;
  type: CalloutType;
  unitId: string;
  squadId?: string;
  pos: Vec2; // snapshot at emission — the plate anchors here
  text: string;
}

/** Seconds before the same squad may repeat the same callout type. man_down repeats
 *  faster (each casualty matters); the bound pair ("covering!"/"moving!") is throttled
 *  hard — the swap fires every 3–5 s and announcing every one reads as bark soup
 *  (measured: 10/min on bal-4 before the 22 s window). */
const CALLOUT_DEDUP_S: Partial<Record<CalloutType, number>> = {
  man_down: 3,
  contact: 14,
  covering: 22,
  moving: 22,
};

const CALLOUT_TEXT: Record<CalloutType, string[]> = {
  contact: ["contact!"], // overridden with the bearing at the call site
  man_down: ["man down!", "he's hit!"],
  covering: ["covering!"],
  moving: ["moving!"],
  doc: ["doc! over here!"],
  on_me: ["on me!"],
  falling_back: ["falling back!"],
  head_count: ["head count!"],
  set: ["set!"],
};

export type FireMissionType =
  | "mortar60"
  | "mortar81"
  | "mortar120"
  | "cas_gun"
  | "cas_rocket"
  | " enemy_mortar"; // enemy indirect uses same pipeline

export interface FireMission {
  id: number;
  weaponId: string;
  target: Vec2;
  rounds: number;
  roundsLeft: number;
  etaS: number; // time until first round
  intervalS: number;
  nextRoundS: number;
  faction: Unit["faction"];
  status: "requested" | "inbound" | "firing" | "complete";
  label: string;
  dangerClose: boolean;
  spread: number; // meters
}

export interface RevealedEnemy {
  id: string;
  pos: Vec2;
  lastSeenS: number;
  confirmed: boolean; // currently in sight
}

/** A buried IED — command- or victim-detonated — that initiates a complex ambush
 *  when the patrol walks into the kill zone. The signature opener in the valley. */
export interface IED {
  id: string;
  pos: Vec2;
  triggerRadius: number; // m — a US/ANA man this close sets it off
  damage: number;
  blastRadius: number;
  armed: boolean;
  cellSquadId?: string; // the ambush element this initiates
  plantedAtS: number; // sim time it was laid (for the dud timeout)
}

/** An armed IED the patrol never walked onto goes "dud" after this long — and is
 *  culled the moment its ambush cell is gone — so charges never leak nor become
 *  invisible weeks-old phantom landmines. */
const IED_TTL_S = 600;

export type CombatOutcome = "ongoing" | "us_victory" | "us_withdraw" | "us_destroyed" | "stalemate";

export interface CombatResult {
  outcome: CombatOutcome;
  usKIA: string[];
  usWIA: string[];
  enemyKIA: number;
  civCasualties: number;
  durationS: number;
  ammoExpended: number;
  fireMissionsUsed: number;
}

// Movement base speeds (m/s) by technique.
const TECH_SPEED: Record<MoveTechnique, number> = {
  crawl: 0.5,
  concealed: 0.85, // slow, low, hugging cover
  tactical: 1.2, // deliberate bounding pace
  patrol: 1.5, // normal foot patrol
  traveling: 2.0, // moving with purpose
  rush: 4.2, // sprint
};

/** Postures that defeat the eye: slow, low movement that reads as near-static. */
function isStealthTechnique(t: MoveTechnique): boolean {
  return t === "concealed" || t === "crawl";
}

/** Roles that carry a thermal sight (CLU/LRAS3/thermal weapon sight) — the US
 *  overmatch in the valley: marksmen and snipers on thermal scopes, the JTAC on
 *  the LLDR, and the weapons-squad MG gunners behind tripod thermals/LRAS3. */
const THERMAL_ROLES = new Set(["marksman", "sniper", "jtac", "machinegunner"]);

/** Rough carried weight of a weapon SYSTEM on a foot patrol (kg). Crew-served guns
 *  (M2/Mk19/mortars) are emplaced or crew-hauled, so they're light per-man here. */
const WEAPON_KG: Record<string, number> = {
  carbine: 3.5, rifle: 4, lmg: 8, mmg: 12, dmr: 5.5, sniper: 7, gl: 1.5,
  rocket: 7, missile: 11, pistol: 1, hmg: 14, agl: 14, mortar: 6,
};

/** Reference fighting load (kg) above which load starts to bite into speed/fatigue. */
const REF_LOAD_KG = 25;

/** A unit's current combat load (kg) — the Korengal "every man a mule". US troops
 *  carry armor, water, ammo and the squad's heavy weapons; insurgents travel light.
 *  Ammo dominates the variable load and the man gets lighter as he shoots. */
export function combatLoadKg(u: Unit, w: Weapon): number {
  let kg = u.faction === "us" || u.faction === "ana" ? 22 : 8; // IOTV/plates/water vs a chest rig
  kg += WEAPON_KG[w.cls] ?? 4;
  kg += (u.ammo + u.reserveAmmo) * w.roundWeight;
  kg += (u.grenades ?? 0) * 0.4 + (u.smokes ?? 0) * 0.5 + (u.glRounds ?? 0) * 0.23;
  return kg;
}

const STANCE_SPEED: Record<Unit["stance"], number> = {
  stand: 1,
  crouch: 0.58,
  prone: 0.22,
};

// Closed-loop movement: a unit that can't advance freely toward its waypoint
// (wall-blocked / sliding) for this long re-plans a fresh route from where it
// stands. Objectives are kept reachable, so it always finds a way; a task-level
// no-progress timeout is the backstop against any freeze.
const STALL_WINDOW = 2; // seconds of continuous blocking before re-planning
const NB_BUCKET = 4; // meters per spatial-hash bucket (neighbor queries / separation)
// A tactical bound (moveTo) longer than this routes around solid obstacles instead of
// walking a raw straight line: the 7 m steering fan solves anything shorter, while a
// longer blocked line is exactly the stall-wipe/re-issue grind loop combat-grind.ts measures.
const BOUND_ROUTE_M = 15;

// --- natural-movement polish (deterministic; no per-tick RNG) ---
const ARRIVE_EASE = 4; // m — decelerate into the final waypoint within this distance
const PACE_MAX = 1.6; // upper bound on paceScale. <1 = the navigator easing (squad governor); >1 = a
// follower who has fallen behind his slot HUSTLING to close the interval (FM 3-21.8 "close it up").
// Capped so a spent man double-times to regain his place, never sprints — the cohesion lever that
// works WITHOUT slowing the point man (slowing the lead misses the objective on a hard climb — 031).
const SCAN_AMP = 0.3; // rad (~17°) — how far a halted man sweeps his sector while scanning
const MIN_BODY = 1.1; // m — closer than this two non-hostile bodies interpenetrate (de-overlap)
const MOVE_SLEW = 3.0; // rad/s (~172°/s) — facing turn-rate while marching
const HALT_SLEW = 1.4; // rad/s (~80°/s) — facing turn-rate while holding/scanning
const AIM_SLEW = 6.0; // rad/s (~344°/s) — facing whips onto an acquired threat
/** Per-man scan period (7–11 s) and phase — stable from the id, so replays stay bit-exact. */
function scanPeriod(id: string): number {
  return 7 + (RNG.hashString(id) % 1000) / 250;
}
function scanPhase(id: string): number {
  return (RNG.hashString(id + "p") % 1000) / 1000;
}

export interface CombatInit {
  terrain: Terrain;
  rng: RNG;
  units: Unit[];
  light: number; // 0..1
  weather: { visibilityM: number; wind: number; label: string; windX?: number; windY?: number };
  /** Origin label (which patrol / where) for the after-action. */
  context?: string;
  /** Available COP indirect assets (weapon ids) and rounds. */
  mortars?: { weaponId: string; rounds: number; copPos: Vec2 }[];
  casAvailable?: boolean;
  /** Persistent world: the sim never auto-resolves; the World manages lifecycle. */
  persistent?: boolean;
}

let _eid = 0;
let _lid = 0;
let _fmid = 0;
let _cid = 0;

/**
 * The tactical engagement simulator. Runs at a fixed timestep; advances every
 * unit's perception, AI, movement, fire, and morale, and resolves every round
 * fired through the ballistics + LOS + cover model.
 */
export class CombatSim {
  terrain: Terrain;
  rng: RNG;
  units: Unit[];
  projectiles: Projectile[] = [];
  smoke: SmokeScreen[] = [];
  ieds: IED[] = [];
  effects: Effect[] = [];
  log: LogEntry[] = [];
  callouts: Callout[] = [];
  // Last emission time per `${squadId}:${type}` — the sim-side spam guard.
  private calloutLast: Map<string, number> = new Map();
  fireMissions: FireMission[] = [];
  timeS = 0;
  light: number;
  weather: CombatInit["weather"];
  // Battery supply level, pushed each tick by the World (issue 021 logistics teeth). When it runs
  // critically low the US lose their NIGHT-VISION edge — dead batteries = no NODs, a real reason the
  // draining `supplies.batteries` matters. Defaults high so a standalone CombatSim keeps its NODs.
  nvgPower = 999;
  // Water/food supply factor (0.4..1), pushed each tick by the World (issue 021). A dehydrated,
  // underfed soldier shakes off fatigue slower even when stationary. Defaults 1 (standalone sim).
  hydration = 1;
  // People-immersion (pushed by the World each tick; empty for a standalone sim): per-village
  // mood (attitude −1..1) and reception (0..1 — how fast civilians RELAX around armed men;
  // rise logic untouched), plus the grieving householdIds. The civilian brain reads these —
  // the sim layer never touches WorldState directly.
  villageMood: Map<string, number> = new Map();
  villageReception: Map<string, number> = new Map();
  grieving: Set<string> = new Set();
  context: string;
  mortars: NonNullable<CombatInit["mortars"]>;
  casAvailable: boolean;
  casUsed = false;
  persistent: boolean;
  outcome: CombatOutcome = "ongoing";
  ammoExpended = 0;
  fireMissionsUsed = 0;
  lastActivityS = 0; // last time a round was fired or detonated (for lull detection)
  /** World positions where a friendly held fire for ROE (a civilian in the kill zone)
   *  since the last drain. The World turns these into a small COIN restraint reward for
   *  the nearest village — buying the valley's trust by NOT taking the shot. Capped. */
  restraintEvents: Vec2[] = [];
  // Living civilians, rebuilt each tick in buildSpatialGrid — civClear scans this, not all units.
  private civilians: Unit[] = [];
  revealed: Map<string, RevealedEnemy> = new Map();
  // index for quick lookup
  private byId: Map<string, Unit> = new Map();
  // Spatial hash of living bodies, rebuilt each tick, for O(1) neighbor queries
  // (local steering / separation). Bucket ≈ NB_BUCKET m; a 3×3 block covers the
  // separation radius. Keyed by a packed integer cell index.
  private grid: Map<number, Unit[]> = new Map();

  constructor(init: CombatInit) {
    this.terrain = init.terrain;
    this.rng = init.rng;
    this.units = init.units;
    this.light = init.light;
    this.weather = init.weather;
    this.context = init.context ?? "Contact";
    this.mortars = init.mortars ?? [];
    this.casAvailable = init.casAvailable ?? false;
    this.persistent = init.persistent ?? false;
    for (const u of this.units) this.byId.set(u.id, u);
  }

  // ---------------------------------------------------------------- accessors
  unit(id: string | null | undefined): Unit | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  /** Add a unit to the live world (enemy spawn, civilian pattern-of-life, etc). */
  addUnit(u: Unit) {
    if (this.byId.has(u.id)) return;
    this.units.push(u);
    this.byId.set(u.id, u);
  }

  /** Remove a unit from the world entirely (exfil off-map, despawn). */
  removeUnit(id: string) {
    const i = this.units.findIndex((u) => u.id === id);
    if (i >= 0) this.units.splice(i, 1);
    this.byId.delete(id);
    this.revealed.delete(id);
  }

  isHostile(a: Unit, b: Unit): boolean {
    if (!b.alive) return false;
    const aUS = a.faction === "us" || a.faction === "ana";
    const bUS = b.faction === "us" || b.faction === "ana";
    if (a.faction === "civilian" || b.faction === "civilian") return false;
    return aUS !== bUS;
  }

  playerUnits(): Unit[] {
    return this.units.filter((u) => (u.faction === "us" || u.faction === "ana") && u.alive && !u.evac);
  }

  livingEnemies(): Unit[] {
    return this.units.filter((u) => u.faction === "insurgent" && u.alive && !u.evac);
  }

  /**
   * Threat-weighted contact (issue 025): "contact" ends when the enemy BREAKS contact,
   * not when he finally clears your optics. A visible enemy holds the TIC latch
   * (squadState, the 1× speed clamp, the call-for-fire re-raise) only if he is still
   * part of a fight:
   *   - he fired inside the last THREAT_RECENT_S (covering fire, parting shots), or
   *   - he stands inside THREAT_CLOSE_M (decisive small-arms range — never ignorable), or
   *   - he is NOT clearly moving away (holding ground, closing, or unknown intent).
   * A runner beyond close range who has stopped shooting is intel, not contact — the
   * wounded straggler limping off at 250 m no longer pins the campaign clock for minutes.
   * Raw visibility stays untouched for perception/spotting/individual fire decisions.
   */
  threatening(e: Unit, ref: Vec2): boolean {
    if (e.lastFiredS !== undefined && this.timeS - e.lastFiredS < THREAT_RECENT_S) return true;
    const d = dist(e.pos, ref);
    if (d < THREAT_CLOSE_M) return true;
    // A man in exfil HAS broken contact (the cell brain's own decision) — he stays
    // non-threatening even while paused at a rally/peel point with an empty path
    // (held-out seeds showed pauses chaining 10 s contactHolds into minute-long latches).
    if (e.brainState === "exfil") return false;
    // Otherwise, clearly breaking contact = his movement order's endpoint is meaningfully
    // farther from us than he already is. Stationary or pathless men keep threat status —
    // a lull-and-renew ambusher waiting in LOS must hold the squad in the fight.
    const goal = e.path.length ? e.path[e.path.length - 1] : null;
    if (goal && dist(goal, ref) > d + THREAT_AWAY_MARGIN_M) return false;
    return true;
  }

  weaponOf(u: Unit): Weapon {
    return getWeapon(u.weaponId === "unarmed" ? "m9" : u.weaponId);
  }

  /** Effective wind vector (m/s, world frame) — set by the World's diurnal valley
   *  model; zero for a standalone CombatSim. Drives bullet drift and smoke drift. */
  windVec(): Vec2 {
    return { x: this.weather.windX ?? 0, y: this.weather.windY ?? 0 };
  }

  // ---------------------------------------------------------------- logging/fx
  addLog(msg: string, kind: LogKind = "info") {
    this.log.push({ id: _lid++, timeS: this.timeS, msg, kind });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  /** Emit a diegetic callout from this man. Dedups per (squad, type) on the sim clock —
   *  the bus itself enforces sparseness, so no caller can spam. Draws no rng (variant
   *  picked by a pure hash of unit + type + time) — replay-stable by construction. */
  say(u: Unit, type: CalloutType, opts: { text?: string } = {}) {
    const key = `${u.squadId ?? u.id}:${type}`;
    const windowS = CALLOUT_DEDUP_S[type] ?? 10;
    const last = this.calloutLast.get(key);
    if (last !== undefined && this.timeS - last < windowS) return;
    this.calloutLast.set(key, this.timeS);
    const variants = CALLOUT_TEXT[type];
    const text =
      opts.text ??
      variants[variants.length > 1 ? RNG.hashString(u.id + type + this.timeS.toFixed(1)) % variants.length : 0];
    this.callouts.push({
      id: _cid++,
      timeS: this.timeS,
      type,
      unitId: u.id,
      squadId: u.squadId,
      pos: { ...u.pos },
      text,
    });
    if (this.callouts.length > 64) this.callouts.splice(0, this.callouts.length - 64);
  }

  /** Nearest conscious same-faction man to a casualty — the buddy who shouts it. */
  private nearestWitness(victim: Unit, radius = 30): Unit | null {
    let best: Unit | null = null;
    let bd = radius;
    for (const o of this.units) {
      if (o === victim || !o.alive || !o.conscious || o.evac) continue;
      if (o.faction !== victim.faction) continue;
      const d = dist(o.pos, victim.pos);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  addEffect(kind: EffectKind, pos: Vec2, ttl: number, opts: Partial<Effect> = {}) {
    this.effects.push({ id: _eid++, kind, pos: { ...pos }, t: 0, ttl, ...opts });
  }

  techniqueOf(u: Unit): MoveTechnique {
    return u.technique ?? "traveling";
  }

  /** Living civilians (rebuilt once per tick) — for the squad's civilian-yield check. */
  liveCivilians(): Unit[] {
    return this.civilians;
  }

  // ---------------------------------------------------------------- main tick
  tick(dt: number) {
    if (this.outcome !== "ongoing") return;
    this.timeS += dt;

    // 1. timers, bleeding, suppression decay, fatigue recovery
    for (const u of this.units) this.updateTimers(u, dt);

    // 2. perception (throttled per unit)
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      u.perceptTimer -= dt;
      if (u.perceptTimer <= 0) {
        this.updatePerception(u);
        u.perceptTimer = 0.35 + this.rng.next() * 0.25;
      }
    }
    this.updateRevealed();

    // 3. AI / order execution — the enemy's group mind DECIDES first (cell leaders
    // stamp per-fighter intent, mirroring how squadFight runs before friendlyBrain
    // in the world tick), then each man's brain EXECUTES the same tick.
    runCellBrains(this, dt);
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      if (u.faction === "insurgent") insurgentBrain(this, u, dt);
      else if (u.faction === "civilian") civilianBrain(this, u, dt);
      else friendlyBrain(this, u, dt);
    }

    // 4. movement (rebuild the body grid first so steering can see neighbors)
    this.buildSpatialGrid();
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      this.moveUnit(u, dt);
    }
    // 4a. hard de-overlap for HALTED bodies. Local steering separation only runs for a man
    // who is path-following (inside moveUnit); two men settling onto a security perimeter,
    // or a soldier and a standing villager, otherwise interpenetrate and read as "stuck on
    // each other". Ease any overlapping non-hostile pair apart a little each tick (never a
    // teleport), onto passable ground only.
    this.resolveOverlaps();

    // 4b. buried IEDs — a patrol that walks into the kill zone sets one off
    this.stepIeds();

    // 5. firing (spawns projectiles)
    for (const u of this.units) {
      if (!u.alive || u.evac || u.conscious === false) continue;
      this.updateFiring(u, dt);
    }

    // 6. projectiles
    this.stepProjectiles(dt);

    // 7. fire missions (indirect / CAS)
    this.stepFireMissions(dt);

    // 8. morale
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      this.updateMorale(u, dt);
    }

    // 9. effects aging
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.ttl);

    // 10. smoke dissipation + drift downwind (a screen streams with the valley wind)
    {
      const w = this.windVec();
      for (const s of this.smoke) {
        s.density -= dt * 0.012;
        // drift downwind, but a screen settles low and snags on terrain, so it lags
        // the free-air wind — it stays roughly useful for the bound it was popped for.
        s.x += w.x * dt * 0.55;
        s.y += w.y * dt * 0.55;
        s.radius += dt * 0.25; // a screen also spreads as it ages
      }
    }
    this.smoke = this.smoke.filter((s) => s.density > 0.04);

    // 11. end conditions
    this.checkOutcome();
  }

  private updateTimers(u: Unit, dt: number) {
    if (u.reloading > 0) {
      u.reloading -= dt;
      if (u.reloading <= 0) u.reloading = 0;
    }
    if (u.fireCooldown > 0) u.fireCooldown -= dt;
    if (u.roundTimer > 0) u.roundTimer -= dt;

    // suppression decays — softened (0.28 -> 0.16) so it ACCUMULATES under sustained
    // fire and LINGERS a beat after the last crack (real men stay down a few seconds).
    if (u.suppression > 0) u.suppression = Math.max(0, u.suppression - dt * 0.16);
    // acute buddy-down shock fades over a few seconds
    if (u.shaken && u.shaken > 0) u.shaken = Math.max(0, u.shaken - dt);

    // Bleeding & TCCC. A tourniquet/pressure stops the extremity arterial bleed —
    // a conscious man does it himself, an unconscious one needs a buddy within reach
    // (every soldier is a combat lifesaver, not just the medic). Internal/junctional
    // bleeding only clots slowly on its own; a medic or MEDEVAC is what saves those.
    if (u.alive && u.bleedRate > 0) {
      u.hp -= u.bleedRate * dt;
      let tq = u.bleedTQable ?? 0;
      if (tq > 0 && (u.conscious || this.consciousBuddyNear(u, 5))) {
        const stop = Math.min(tq, dt * (u.conscious ? 0.2 : 0.13));
        tq -= stop;
        u.bleedTQable = tq;
        u.bleedRate = Math.max(0, u.bleedRate - stop);
      }
      const internal = Math.max(0, u.bleedRate - tq);
      if (internal > 0) u.bleedRate = Math.max(tq, u.bleedRate - Math.min(internal, dt * 0.02));
      if (u.hp <= 0) {
        u.hp = 0;
        u.alive = false;
        u.conscious = false;
        this.onDeath(u, "wounds");
      } else if (u.hp < 18) {
        u.conscious = false;
      }
    }

    // fatigue recovers when stationary — slower when the patrol is short on water/food (issue 021),
    // and only for the US/ANA the COP actually supplies (the enemy isn't on our logistics).
    if (!u.moving && u.fatigue > 0) {
      const hyd = u.faction === "us" || u.faction === "ana" ? this.hydration : 1;
      u.fatigue = Math.max(0, u.fatigue - dt * 0.01 * hyd);
    }
  }

  /** Is a conscious, not-badly-bleeding friendly within `r` m to apply buddy aid (a
   *  tourniquet) to a casualty who can't help himself? Casualties are few, so the
   *  scan is bounded. */
  private consciousBuddyNear(u: Unit, r: number): boolean {
    for (const o of this.units) {
      if (o === u || !o.alive || !o.conscious || o.evac || o.faction !== u.faction) continue;
      if (o.bleedRate > 0.5) continue; // a fellow casualty can't work a tourniquet
      if (dist(o.pos, u.pos) <= r) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- perception
  private updatePerception(u: Unit) {
    if (u.faction === "civilian") {
      // civilians notice gunfire/units but don't "target"
      u.visibleEnemyIds = [];
      return;
    }
    const opticRange = this.weaponOf(u).opticRange * (0.6 + 0.4 * u.experience);
    // US/ANA fight at night on NODs — UNLESS the batteries are gone (issue 021): below the reserve
    // the night-vision goes dark and they're back to the naked eye, the real cost of neglecting resupply.
    const nvg = (u.faction === "us" || u.faction === "ana") && this.nvgPower > NVG_MIN_BATTERIES;
    const thermal = u.faction === "us" && THERMAL_ROLES.has(u.role); // CLU/LRAS3/thermal sights
    const visible: string[] = [];
    for (const e of this.units) {
      if (!this.isHostile(u, e) || e.evac) continue;
      const d = dist(u.pos, e.pos);
      if (d > Math.min(opticRange, this.weather.visibilityM) * 1.2) continue;
      const los = this.los(u, e);
      // A thermal observer can see heat through foliage, so it isn't gated by the
      // naked-eye visibility (which folds in vegetation); detectionChance re-decides.
      if (!los.visible && !thermal) continue;
      const stealthMove = e.moving && isStealthTechnique(this.techniqueOf(e));
      const p = detectionChance({
        los,
        light: this.light,
        observerNVG: nvg,
        targetMoving: e.moving,
        targetFiring: e.hasFired && e.fireCooldown > -0.5 && e.burstLeft >= 0 && e.roundTimer > -0.4,
        targetProne: e.stance === "prone",
        observerOpticRangeM: opticRange,
        alertness: clamp01(0.5 + u.experience * 0.4 + (u.suppression > 0 ? -0.2 : 0)),
        targetStealthMoving: stealthMove,
        targetStealth: e.stealth,
        observerThermal: thermal,
        thermalRangeM: 1400,
      });
      // accumulate detection over the throttle window
      if (this.rng.chance(p)) {
        visible.push(e.id);
        u.lastSeenEnemy[e.id] = { pos: { ...e.pos }, t: this.timeS };
      } else if (u.lastSeenEnemy[e.id]) {
        // keep stale memory
      }
    }
    u.visibleEnemyIds = visible;
  }

  private updateRevealed() {
    // anything a living US/ANA unit currently sees is confirmed to the player
    const nowConfirmed = new Set<string>();
    for (const u of this.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive && !u.evac) {
        for (const eid of u.visibleEnemyIds) {
          nowConfirmed.add(eid);
          const e = this.unit(eid);
          if (e) {
            this.revealed.set(eid, {
              id: eid,
              pos: { ...e.pos },
              lastSeenS: this.timeS,
              confirmed: true,
            });
          }
        }
      }
    }
    // decay older sightings to "suspected" then drop
    for (const [id, r] of this.revealed) {
      if (nowConfirmed.has(id)) continue;
      r.confirmed = false;
      if (this.timeS - r.lastSeenS > 25) this.revealed.delete(id);
      const e = this.unit(id);
      if (e && !e.alive) this.revealed.delete(id);
    }
  }

  los(observer: Unit, target: Unit): LOSResult {
    return lineOfSight(this.terrain, observer.pos, target.pos, {
      observerHeight: eyeHeight(observer),
      targetHeight: unitHeight(target),
      smoke: this.smoke,
    });
  }

  /** Whether `observer` can perceive (and thus acquire/engage) a target through this
   *  LOS — the naked eye when `los.visible`, plus a thermal-equipped observer who
   *  reads heat through foliage (but not terrain defilade). Keeps the detect → acquire
   *  → fire pipeline consistent, so a thermal-sight gunner can shoot what it sees. */
  canPerceive(observer: Unit, los: LOSResult): boolean {
    if (los.visible) return true;
    if (observer.faction !== "us" || !THERMAL_ROLES.has(observer.role)) return false;
    if (los.terrainBlocked || los.terrainExposure == null) return false;
    const tConc = clamp01(0.5 * (los.smokeConceal ?? 0) + 0.3 * (los.vegConceal ?? 0));
    return clamp01(los.terrainExposure * (1 - tConc)) > 0.04;
  }

  // ---------------------------------------------------------------- movement
  /**
   * Rebuild the per-tick spatial hash of living bodies. Bucketed at NB_BUCKET m so
   * a 3×3 block of buckets around a unit covers the steering separation radius. This
   * is what lets separation be O(neighbors) instead of O(units) per unit.
   */
  private buildSpatialGrid() {
    this.grid.clear();
    this.civilians.length = 0; // rebuilt here (once/tick, before firing) so civClear doesn't rescan all units
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      if (u.faction === "civilian") this.civilians.push(u);
      const key = this.bucketKey(u.pos.x, u.pos.y);
      const cell = this.grid.get(key);
      if (cell) cell.push(u);
      else this.grid.set(key, [u]);
    }
  }

  private bucketKey(x: number, y: number): number {
    const bx = Math.floor(x / NB_BUCKET) + 2048;
    const by = Math.floor(y / NB_BUCKET) + 2048;
    return by * 4096 + bx;
  }

  /**
   * Bodies near `u` that it should not walk through — everything it isn't hostile
   * to (friendlies, civilians, and, for the enemy, other fighters). We deliberately
   * do NOT separate from hostiles, so an assault can still close to contact instead
   * of being magnetically held off the objective.
   */
  private neighborsFor(u: Unit): Unit[] {
    const out: Unit[] = [];
    const bx = Math.floor(u.pos.x / NB_BUCKET) + 2048;
    const by = Math.floor(u.pos.y / NB_BUCKET) + 2048;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.grid.get((by + dy) * 4096 + (bx + dx));
        if (!cell) continue;
        for (const n of cell) {
          if (n === u) continue;
          if (this.isHostile(u, n)) continue;
          out.push(n);
        }
      }
    return out;
  }

  /**
   * Closed-loop path following. The unit walks its path toward `pathGoal`; the
   * wire is solid (it never steps through an impassable cell); and if it stops
   * making real progress it re-plans from where it stands, giving up only when
   * it genuinely can't get closer. This single mechanism keeps everyone —
   * patrols, the point man, garrison, men bounding to cover — un-stuck without
   * any per-situation special-casing.
   */
  moveUnit(u: Unit, dt: number) {
    if (!u.conscious) {
      this.halt(u, dt);
      return;
    }
    // Out of waypoints → the goal is reached (paths run to the goal). Drop it and
    // stop; whoever's driving this unit (squad steering, garrison) re-issues a
    // path next tick if it still needs to move. No per-tick re-plan here.
    if (u.path.length === 0) {
      u.pathGoal = null;
      this.halt(u, dt);
      return;
    }
    if (u.formationHold) {
      this.halt(u, dt);
      return;
    }

    const target = u.path[0];
    const toT = sub(target, u.pos);
    const d = len(toT);
    if (d < 1.2) {
      u.path.shift();
      if (u.path.length === 0) {
        u.moving = false;
        u.speed = 0;
        if (u.pathGoal && dist(u.pos, u.pathGoal) < 2.5) u.pathGoal = null; // arrived
      }
      return;
    }
    const goalDir = scale(toT, 1 / d);
    const tech = this.techniqueOf(u);
    let speed = TECH_SPEED[tech];
    speed *= STANCE_SPEED[u.stance];
    speed *= this.terrain.moveCostAt(u.pos.x, u.pos.y);
    speed *= 0.55 + 0.45 * u.fitnessMax;
    // Fatigue drag. A fully-spent man still loses a third of his pace, but no longer
    // crawls: the old 0.45 term, combined with fatigue saturating to 1.0 on any long
    // march (see the accrual block below), pinned patrols at ~0.55x speed for the whole
    // hump — the dominant cause of "physically reachable, never arrives". 0.32 keeps
    // fatigue a real drag without crippling a routine patrol. Combat fatigue still bites
    // (ballistics MOA, composure) because it still climbs to 1.0 on steep ground / rushes.
    speed *= 1 - u.fatigue * 0.32;
    speed *= 1 - u.suppression * 0.4;
    // Combat load: every man a mule. A heavy load (the SAW/240 gunner, the man
    // humping mortar rounds) drags the pace and burns him out faster; fitness offsets
    // some of it. Computed here (cheap), the same figure feeds the fatigue accrual.
    const overload = Math.max(0, combatLoadKg(u, this.weaponOf(u)) - REF_LOAD_KG);
    speed *= clamp(1 - overload * (0.006 * (1.3 - u.fitnessMax)), 0.5, 1);
    // leg wounds slow you
    if (u.wounds.some((w) => w.region === "leg" && !w.treated)) speed *= 0.5;
    // squad pace governor: the point man eases the throttle (never a dead stop) so the element stays
    // together (paceScale<1), AND a follower who has fallen behind his slot HUSTLES to close the
    // interval (paceScale>1, set in formation.ts driveFollower). The hustle is the cohesion lever that
    // does NOT slow the lead — slowing the lead misses the objective on a hard far-village climb (031).
    if (u.paceScale != null) speed *= Math.max(0, Math.min(PACE_MAX, u.paceScale));
    // Never-freeze floor: a PATROL must always read as MOVING (easing only — never a dead
    // stop on poor ground or fatigue, which is what pinned the squad at ~1/3 doctrinal pace).
    // Kept low for the stealth crawls so a man on his belly still creeps, not scoots — and lower
    // still for CIVILIANS, so a slow elder keeps the unhurried amble the civilian brain gives him
    // (per-person pace) instead of being clamped up to a soldier's marching floor.
    const floor = u.faction === "civilian" ? 0.12 : tech === "crawl" ? 0.2 : tech === "concealed" ? 0.35 : 0.5;
    speed = Math.max(floor, speed);
    // Arrival ease-in: flow into the LAST waypoint (slot / objective / cover) instead of
    // marching at full pace then snapping to a halt — a body decelerates onto its mark.
    if (u.path.length === 1) speed *= 0.45 + 0.55 * smoothstep(0.4, ARRIVE_EASE, d);

    // Local steering: round nearby obstacles and keep clear of other bodies. With a
    // clear lane ahead and no one crowding, this returns the goal heading unchanged,
    // so open-ground and combat movement are unaffected — it only bends the heading
    // where the ground (the HESCO ring, a draw) or the crowd (a choke) demands it.
    const dir = steer(this.terrain, u, goalDir, this.neighborsFor(u), speed).dir;

    // Face the assigned security sector if one is locked (flank/rear men scan outboard
    // while moving), else the way we're walking — but SLEW onto it at a bounded turn rate
    // rather than snapping. A body doesn't spin 700°/s; that instantaneous snap was the
    // dominant "robotic" tell (cohesion jitter peaked at 729°/s). Aim stays fast so a man
    // whips onto a threat the instant he acquires one.
    const targetFace = u.faceLock != null ? u.faceLock : angle(dir);
    const slew = (u.targetId ? AIM_SLEW : MOVE_SLEW) * dt;
    u.facing += clamp(angleDiff(u.facing, targetFace), -slew, slew);
    const stepLen = Math.min(d, speed * dt);
    const next = add(u.pos, scale(dir, stepLen));
    // The wire is solid: never step into an impassable cell (HESCO, compound
    // wall, cliff). Try to slide along it; a slide or a full block counts as
    // "not advancing freely" and feeds the watchdog (which re-routes / gives up).
    const cs = this.terrain.cellSize;
    let blocked = false;
    if (!this.terrain.passableCell(Math.floor(next.x / cs), Math.floor(next.y / cs))) {
      blocked = true;
      const slideX = add(u.pos, { x: dir.x * stepLen, y: 0 });
      const slideY = add(u.pos, { x: 0, y: dir.y * stepLen });
      if (this.terrain.passableCell(Math.floor(slideX.x / cs), Math.floor(slideX.y / cs))) u.pos = slideX;
      else if (this.terrain.passableCell(Math.floor(slideY.x / cs), Math.floor(slideY.y / cs))) u.pos = slideY;
      // else fully wedged — don't move this tick
    } else {
      u.pos = next;
    }
    u.moving = true;
    u.speed = blocked ? 0 : speed;

    // Fatigue from movement (steeper + higher + heavier = worse), NET of a recovery the
    // body does while walking easy ground. The gross accrual's flat-ground base is lower
    // (0.0012->0.0007) and its slope term higher (0.004->0.006) — so a routine march no
    // longer redlines, but a real climb still bites. The recovery-while-moving is gated by
    // EXERTION: on gentle ground it offsets accrual so fatigue PLATEAUS at a working level
    // instead of climbing to 1.0; on a steep pitch or a rush, exertion->1 cancels it, so
    // fatigue still saturates and combat fatigue (ballistics MOA, composure) stays honest.
    const slope = this.terrain.slopeAt(u.pos.x, u.pos.y);
    const alt = clamp01((this.terrain.elevAt(u.pos.x, u.pos.y) - 1500) / 1400);
    const exertion = clamp01(slope * 2.2 + (tech === "rush" ? 0.6 : 0));
    // Altitude makes EXERTION brutal (climbing/rushing thin-air), but ambling a flat track at
    // altitude is not itself draining. The old unconditional `alt*0.0016` term accrued even on a
    // benched, gentle Track, so a long patrol at altitude redlined fatigue to 1.0 and rode at a
    // permanent ~0.68x — a reachable far village then arrived only after the tactical window (the
    // SLOW failure). Gating the altitude penalty by exertion lets a flat-track patrol PLATEAU
    // (recovery still offsets it) while a climb at altitude still saturates as it should.
    u.fatigue = clamp01(
      u.fatigue +
        stepLen * (0.0007 + slope * 0.006 + alt * exertion * 0.004) * (tech === "rush" ? 2 : 1) * (1 + overload * 0.012) -
        dt * 0.001 * (1 - exertion)
    );

    this.watchStall(u, dt, blocked);
  }

  /** Stop moving but keep holding any locked security sector. A halted man finishes
   *  rotating onto his sector smoothly and then SCANS it (a slow deterministic sweep)
   *  instead of locking rigid like a turret — the scan freezes the instant he has a real
   *  threat to look at, so he never looks away from contact. */
  private halt(u: Unit, dt: number) {
    u.moving = false;
    u.speed = 0;
    u.blockedTimer = 0;
    if (!u.conscious) return;
    const alert = u.targetId != null || u.threatDir != null || u.suppression > 0.3;
    let targetFace = u.faceLock != null ? u.faceLock : u.facing;
    if (u.faceLock != null && !alert) {
      targetFace += SCAN_AMP * Math.sin(2 * Math.PI * (this.timeS / scanPeriod(u.id) + scanPhase(u.id)));
    }
    const slew = (alert ? AIM_SLEW : HALT_SLEW) * dt;
    u.facing += clamp(angleDiff(u.facing, targetFace), -slew, slew);
  }

  /**
   * Push any two interpenetrating, non-hostile, NOT-actively-moving bodies apart — the
   * separation that local steering can't provide because it only runs for a man following
   * a path. Eases each apart by a clamped step (so they settle over a few ticks, never
   * pop), and only into passable cells. Pure geometry → deterministic. This is what keeps
   * a settled security perimeter from collapsing into a pile and stops a soldier from
   * standing inside a halted civilian. Active movers are left to steer() (which already
   * separates them) and to the assault (which must be able to close on the enemy).
   */
  private resolveOverlaps() {
    const cs = this.terrain.cellSize;
    const MAX_PUSH = 0.25; // m/tick
    for (const u of this.units) {
      if (!u.alive || u.evac || !u.conscious) continue;
      if (u.moving && u.path.length > 0) continue; // a mover is steered, not shoved
      for (const nb of this.neighborsFor(u)) {
        if (nb.moving && nb.path.length > 0) continue;
        const dx = u.pos.x - nb.pos.x;
        const dy = u.pos.y - nb.pos.y;
        const d = Math.hypot(dx, dy);
        if (d >= MIN_BODY || d < 1e-4) continue;
        const push = Math.min(MAX_PUSH, 0.5 * (MIN_BODY - d));
        const np = { x: u.pos.x + (dx / d) * push, y: u.pos.y + (dy / d) * push };
        if (this.terrain.passableCell(Math.floor(np.x / cs), Math.floor(np.y / cs))) u.pos = np;
      }
    }
  }

  /**
   * The watchdog: a unit free to walk toward its waypoint is fine; one that's
   * wall-blocked or sliding without progress for a spell has its stale path and
   * goal dropped, so it stops instead of grinding. Whoever drives it re-issues a
   * fresh route next tick — the squad's point man via one A* (route-finding then
   * starts from where he's actually standing and goes around), a civilian/garrison
   * man via a cheap straight move. Crucially the watchdog itself runs no A*, so
   * dozens of idle/milling units never pile pathfinding onto every tick.
   */
  private watchStall(u: Unit, dt: number, blocked: boolean) {
    if (!blocked) {
      u.blockedTimer = 0;
      return;
    }
    u.blockedTimer = (u.blockedTimer ?? 0) + dt;
    if ((u.blockedTimer ?? 0) < STALL_WINDOW) return;
    u.blockedTimer = 0;
    u.path = [];
    u.pathGoal = null;
  }

  // ---------------------------------------------------------------- firing
  updateFiring(u: Unit, dt: number) {
    if (u.faction === "civilian") return;
    if (u.reloading > 0) return;

    const weapon = this.weaponOf(u);

    // continue an in-progress burst
    if (u.burstLeft > 0) {
      if (u.roundTimer <= 0) {
        this.fireRound(u, weapon);
        u.burstLeft--;
        u.roundTimer = 60 / weapon.cyclicRPM;
        if (u.burstLeft <= 0) {
          // Pause between bursts — longer if low composure, and LONGER STILL under suppression.
          // A man with rounds cracking past his head services his weapon less, not the same: he
          // fires and gets back down. (FM 3-21.8 — the whole purpose of suppressive fire is to cut
          // the enemy's rate of effective fire.) Capped at ×2.5 so he's slowed, never silenced.
          const suppFactor = Math.min(2.5, 1 + u.suppression * 1.5);
          u.fireCooldown = this.rng.range(0.5, 1.4) * (weapon.auto ? 1 : 1.6) * (2 - u.composure) * suppFactor;
          u.aimProgress = 0;
        }
      }
      return;
    }

    if (u.rof === "hold") return;
    if (u.fireCooldown > 0) return;

    // need a valid target or a suppress point
    const target = this.unit(u.targetId);
    let aimPos: Vec2 | null = null;
    let targetId: string | null = null;
    let los: LOSResult | null = null;

    if (u.rof === "suppress" && u.orderTarget) {
      aimPos = u.orderTarget;
      const r = dist(u.pos, aimPos);
      if (r > weapon.maxRange) return;
    } else if (target && target.alive && !target.evac) {
      los = this.los(u, target);
      const r = los.rangeM;
      if (!this.canPerceive(u, los) || r > weapon.maxRange) {
        u.targetId = null;
        return;
      }
      aimPos = target.pos;
      targetId = target.id;
    } else {
      u.targetId = null;
      return;
    }
    if (!aimPos) return;

    // ROE gate (belt-and-suspenders): a civilian — or the gun-target line — may have
    // shifted since this target was acquired. Holding fire with a civ in the kill zone is
    // the COIN moral core; record the restraint so the World can reward the village's trust.
    if (!this.civClear(u, aimPos, target ?? null)) {
      u.targetId = null;
      u.aimProgress = 0;
      // hesitate before re-checking (throttles the restraint signal and models the held breath)
      u.fireCooldown = Math.max(u.fireCooldown, this.rng.range(0.7, 1.4));
      if (this.restraintEvents.length < 64) this.restraintEvents.push({ ...u.pos });
      return;
    }

    // out of ammo for this weapon?
    if (u.ammo <= 0) {
      if (u.reserveAmmo > 0) {
        u.reloading = weapon.reload;
        u.ammo = Math.min(weapon.magSize, u.reserveAmmo);
        u.reserveAmmo -= u.ammo;
        // audible only — the mag-change clatter a teammate hears; renderers skip the kind
        this.addEffect("reload", u.pos, 0.3, { faction: u.faction, weapon: weapon.id });
        return;
      } else if (u.sidearmId) {
        u.weaponId = u.sidearmId;
        u.sidearmId = undefined;
        u.ammo = getWeapon(u.weaponId).magSize;
        u.reserveAmmo = u.ammo * 2;
        return;
      } else {
        return; // black on ammo
      }
    }

    // settle aim
    u.aimProgress = clamp01(u.aimProgress + dt / Math.max(0.2, weapon.aimTime));
    if (u.aimProgress < (weapon.cls === "sniper" || weapon.cls === "dmr" ? 0.85 : 0.4) && !u.moving) {
      return; // still settling for a deliberate shot
    }

    // Begin a burst — its LENGTH is the man's TEMPERAMENT, not just the weapon. We reshape the
    // SAME uniform draw (no extra rng call → the deterministic stream is preserved), in order:
    //  1. PERSONALITY — a disciplined shooter (high composure, low aggression) squeezes controlled
    //     bursts toward the low end of the weapon's band (US doctrine: 3-5 round bursts); a green or
    //     hot-blooded one sprays toward the top (the ragged insurgent "spray and pray"). Same band,
    //     reshaped by where on it the man sits.
    //  2. SUPPRESSION — over a threshold, incoming fire further shortens the burst: you fire and duck.
    //  3. SUPPRESS TASKING — a base-of-fire gunner ordered to rake overrides both (the assault drill
    //     RELIES on his volume to win fire superiority), then we clamp to ammo on hand.
    const [bmin, bmax] = weapon.burst;
    let burst = this.rng.int(bmin, bmax);
    const span = bmax - bmin;
    const discipline = clamp01(u.composure * 0.7 + (1 - u.aggression) * 0.3); // 1 = controlled
    if (span > 0) {
      const t = (burst - bmin) / span; // where the uniform draw fell, 0..1
      // gamma reshapes the SAME draw within the band. Kept MILD on purpose: US soldiers carry high
      // composure (they sit at the SHORT end of the band) and insurgents low, so an aggressive gamma
      // would asymmetrically cut US volume and raise enemy volume — a measured balance regression
      // (WIA +35%). Mild gamma keeps US effective; the ragged read comes mostly from the panic spray.
      const gamma = 0.45 + discipline * 1.9; // disc→0: bias toward bmax (spray); disc→1: toward bmin (taps)
      burst = Math.round(bmin + Math.pow(t, gamma) * span);
    }
    // PANIC SPRAY: a green/hot-blooded shooter (low discipline) doesn't just sit high in the
    // band — he mag-dumps a bit past it. Disciplined fire never over-sprays. Kept DELIBERATELY MODEST
    // (≤+40%): a bigger over-spray reads as more "personality" but raises enemy volume of fire enough
    // to push US casualties past the ±15% balance gate (measured: panic 0.5 → US WIA/KIA out of
    // tolerance). The same-weapon personality is therefore bounded on purpose; the visible read comes
    // from cross-faction weapon discipline + the composure-keyed cadence, both balance-safe. (Law 3/5.)
    if (discipline < 0.4 && weapon.auto) {
      burst = Math.round(burst * (1 + ((0.4 - discipline) / 0.4) * 0.4)); // up to +40% past the band
    }
    if (u.suppression > 0.35) {
      burst = Math.max(bmin, Math.round(burst * (1 - 0.5 * Math.min(1, (u.suppression - 0.35) / 0.65))));
    }
    if (u.rof === "suppress") burst = Math.min(weapon.magSize, Math.max(burst, Math.round(bmax * 1.2)));
    burst = Math.min(burst, u.ammo);
    u.burstLeft = burst;
    u.roundTimer = 0;
    u.facing = angle(sub(aimPos, u.pos));
    u._fireTarget = targetId; // remember for resolution
    u._fireLOS = los;
  }

  private fireRound(u: Unit, weapon: Weapon) {
    if (u.ammo <= 0) {
      u.burstLeft = 0;
      return;
    }
    const targetId = u._fireTarget ?? null;
    const target = this.unit(targetId);
    const aimPos = target ? target.pos : u.orderTarget;
    if (!aimPos) {
      u.burstLeft = 0;
      return;
    }
    const range = dist(u.pos, aimPos);
    const proj = spawnProjectile(u, weapon, aimPos, targetId, range, this.rng, this.windVec());
    proj._losAtFire = u._fireLOS ?? null;
    this.projectiles.push(proj);
    u.ammo--;
    u.hasFired = true;
    u.lastFiredS = this.timeS;
    this.ammoExpended++;
    this.lastActivityS = this.timeS;
    this.addEffect("muzzle", u.pos, 0.12, {
      faction: u.faction,
      size: weapon.cls === "hmg" || weapon.cls === "mmg" ? 1.6 : 1,
      weapon: weapon.id,
      // Cone along the ACTUAL gun line (sub(aimPos, u.pos)) — the same vector the round
      // launches on — NOT u.facing, which the move-code slews toward the travel direction
      // each tick, so a man firing on the move flashed where his feet went, not his target.
      facing: angle(sub(aimPos, u.pos)),
    });
  }

  // ---------------------------------------------------------------- projectiles
  private stepProjectiles(dt: number) {
    const survivors: Projectile[] = [];
    for (const p of this.projectiles) {
      p.age += dt;
      if (p.indirect) {
        p.timeToImpact -= dt;
        if (p.timeToImpact <= 0) {
          this.detonate(p, p.aimpoint);
          continue;
        }
        survivors.push(p);
        continue;
      }
      // direct fire: advance along velocity
      const stepLen = p.speed * dt;
      const before = p.traveled;
      p.traveled += stepLen;
      p.pos = add(p.origin, scale(norm(p.vel), p.traveled));

      // suppression to enemies near the round's flight this step
      this.suppressAlong(p, before, p.traveled);

      // reached the aimpoint plane?
      if (p.traveled >= p.distToAim) {
        const target = this.unit(p.targetId);
        if (target && target.alive && !target.evac) {
          const owner = this.unit(p.ownerId);
          const los = p._losAtFire ?? (owner ? this.los(owner, target) : lineOfSight(this.terrain, p.origin, target.pos));
          const cover = this.coverFor(target, p.origin);
          const outcome = resolveDirectHit(p, target, los, cover, this.rng);
          if (outcome.hit) {
            p.hit = true;
            this.addEffect("blood", target.pos, 0.5, { faction: target.faction });
            this.onHit(this.unit(p.ownerId), target, outcome.killed);
          } else {
            this.addEffect("impact", p.aimpoint, 0.35, { faction: p.faction });
          }
        } else {
          // Area/grazing round (suppressive MG, or a missed/dead aimpoint): the beaten
          // zone still bites. Sweep a NARROW terminal corridor for a hostile body the
          // round passes through — keeps area fire primarily a suppression tool, but
          // stops it being literally harmless to a fighter standing in the beaten zone.
          const owner = this.unit(p.ownerId);
          let struck: Unit | null = null;
          const grazeR = p.damageType === "ball" ? 1.1 : 0;
          if (owner && grazeR > 0) {
            for (const u of this.units) {
              if (!u.alive || u.evac || u.faction === "civilian" || !this.isHostile(owner, u)) continue;
              if (segDist(u.pos, p.origin, p.aimpoint) <= grazeR + silhouetteRadius(u, 0.6)) { struck = u; break; }
            }
          }
          if (struck && owner) {
            const los = this.los(owner, struck);
            const cover = this.coverFor(struck, p.origin);
            const outcome = resolveDirectHit(p, struck, los, cover, this.rng);
            if (outcome.hit) {
              p.hit = true;
              this.addEffect("blood", struck.pos, 0.5, { faction: struck.faction });
              this.onHit(owner, struck, outcome.killed);
            } else {
              this.addEffect("impact", p.aimpoint, 0.35, { faction: p.faction });
            }
          } else {
            this.addEffect("impact", p.aimpoint, 0.3, { faction: p.faction });
          }
        }
        // explosive direct rounds (RPG/AT4) detonate on arrival
        if (p.blastRadius > 0) this.detonate(p, p.aimpoint);
        continue;
      }
      // terrain intercept (round slams into a hill)
      if (this.terrain.elevAt(p.pos.x, p.pos.y) > this.terrain.elevAt(p.origin.x, p.origin.y) + 2 &&
          p.traveled > p.distToAim * 0.4 && this.rng.chance(0.02)) {
        this.addEffect("ricochet", p.pos, 0.3, { faction: p.faction });
        if (p.blastRadius > 0) this.detonate(p, p.pos);
        continue;
      }
      if (p.traveled > getWeapon(p.weaponId).maxRange) {
        continue; // spent
      }
      survivors.push(p);
    }
    this.projectiles = survivors;
  }

  private detonate(p: Projectile, at: Vec2, isIed = false) {
    const radius = p.blastRadius || 6;
    this.lastActivityS = this.timeS;
    this.addEffect("blast", at, 0.6, { faction: p.faction, size: radius / 8, ied: isIed, weapon: p.weaponId });
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
      const d = dist(u.pos, at);
      if (d > radius * 2.2) continue;
      // suppression in a wide ring
      if (d <= radius * 2.2) {
        this.addSuppression(u, p.suppression * (1 - d / (radius * 2.2)) * 1.6, at);
      }
      if (d <= radius) {
        // cover/terrain mask reduces frag
        const cover = this.terrain.coverAt(u.pos.x, u.pos.y);
        const dmg = blastDamageAt(d, radius, p.damage) * (1 - cover * 0.55);
        if (dmg <= 0) continue;
        const region = this.rng.weighted(
          ["leg", "arm", "chest", "head", "abdomen"] as const,
          [30, 26, 16, 10, 18]
        );
        const before = u.alive;
        const oc = applyDamage(u, dmg, p.damageType === "ball" ? "frag" : p.damageType, region, this.rng);
        this.addEffect("blood", u.pos, 0.5, { faction: u.faction });
        // Attribute the casualty to the firing faction (for civcas/COIN backlash).
        if (oc.effectiveDamage > 0 && p.faction !== "civilian") u.casualtyByFaction = p.faction;
        if (before && !u.alive) this.onDeath(u, "blast");
        else if (oc.effectiveDamage > 5) this.onWound(u);
      }
    }
  }

  private suppressAlong(p: Projectile, from: number, to: number) {
    // A supersonic round cracking past suppresses everyone near its FLIGHT PATH, not
    // just men within the bare bullet radius of two sparse points. We credit each unit
    // ONCE per step by its closest approach (perpendicular distance) to the segment the
    // round traversed this tick — geometrically exact (the crack is loudest at closest
    // approach), with no multi-count and no throttle-by-sample-count.
    //   Old model: samples=2 over an ~88 m M4 step (points ~44 m apart) gated at the 4 m
    //   bullet radius → almost the whole element got nothing. This catches the bow-wave.
    const owner = this.unit(p.ownerId);
    const dir = norm(p.vel);
    const a = add(p.origin, scale(dir, from)); // segment start this step
    const b = add(p.origin, scale(dir, to)); // segment end this step
    // Crack-thump zone: the bow-wave is felt well beyond the wound radius. Floor it so
    // even a tight-radius rifle round (M4 supp radius 4) throws a real corridor.
    const crackR = Math.max(7, p.suppressionRadius * 2.2);
    for (const u of this.units) {
      if (!u.alive || u.evac || u.faction === "civilian") continue;
      if (owner && !this.isHostile(owner, u)) continue;
      const d = segDist(u.pos, a, b); // closest approach of THIS round to this man this step
      if (d < crackR) {
        // Near-miss credits more than a far crack (linear falloff to the crack radius).
        this.addSuppression(u, p.suppression * (1 - d / crackR), p.origin);
      }
    }
  }

  addSuppression(u: Unit, amount: number, fromPos: Vec2) {
    // Intake is meaningful per round (0.12 -> 0.35) but a single near-miss event is
    // capped (0.13) so ONE round is a flinch, and it takes SUSTAINED volume to pin a
    // man — a passing burst RAMPS suppression over ~1-2 s instead of pinning in one tick.
    u.suppression = clamp01(u.suppression + Math.min(0.13, amount * 0.35));
    u.threatDir = norm(sub(fromPos, u.pos));
  }

  /** Hard cover protecting `target` from a round fired at `fromPos` (stance + microterrain + the
   *  DIRECTIONAL discrete cover objects — issue 020). */
  coverFor(target: Unit, fromPos: Vec2): number {
    let cover = this.terrain.coverAt(target.pos.x, target.pos.y);
    // prone behind microterrain adds cover
    if (target.stance === "prone") cover = clamp01(cover + 0.18);
    else if (target.stance === "crouch") cover = clamp01(cover + 0.08);
    // Directional object cover (issue 020): a boulder/outcrop sitting between the shooter and the
    // target adds hard cover FROM THIS BEARING only (a flanker still sees him exposed), scaled by
    // posture (a low rock hides a prone man more). This is the sub-cell cover the 5 m raster can't
    // represent — so open ground a soldier could only "stand and take it" on now has real, usable
    // cover, without the omnidirectional grind that reverted the 2026-06-09 stamp.
    if (NO_OBJ_COVER) return cover; // A/B kill-switch (ITM_NOOBJCOVER=1) for headless balance bisects
    const h = target.stance === "prone" ? 0.5 : target.stance === "crouch" ? 1.0 : 1.6;
    const objCov = this.terrain.coverOcclusion(fromPos, target.pos, h);
    return Math.max(cover, objCov);
  }

  // ---------------------------------------------------------------- hit hooks
  private onHit(shooter: Unit | undefined, target: Unit, killed: boolean) {
    if (killed) {
      this.onDeath(target, "gsw");
      if (shooter) shooter.kills++;
    } else {
      this.onWound(target);
    }
  }

  private onWound(u: Unit) {
    this.casualtyShock(u, false);
    if (u.faction === "us" || u.faction === "ana") {
      if (this.rng.chance(0.5))
        this.addLog(`${this.shortName(u)} is hit — "MAN DOWN!"`, "casualty");
      const witness = this.nearestWitness(u);
      if (witness) this.say(witness, "man_down");
    } else if (u.faction === "civilian") {
      this.addLog(`A civilian is wounded in the crossfire.`, "casualty");
    }
  }

  private onDeath(u: Unit, cause: string) {
    this.casualtyShock(u, true);
    if (u.faction === "us" || u.faction === "ana") {
      this.addLog(`${this.rankName(u)} is KIA (${cause}).`, "kia");
      const witness = this.nearestWitness(u);
      if (witness) this.say(witness, "man_down");
      if (u.isLeader) this.promoteSuccessor(u);
    } else if (u.faction === "civilian") {
      this.addLog(`A civilian has been killed.`, "kia");
    } else {
      this.addLog(`Enemy fighter down.`, "contact");
      this.revealed.delete(u.id);
      if (u.isLeader) this.promoteSuccessor(u);
    }
  }

  /**
   * Seeing a buddy hit beside you is a blow to the nerve, not just the radio log.
   * A casualty drops the composure of nearby friendlies (worse for a kill, worse
   * inside the same squad, worst when it's the leader who goes down), gives them a
   * few seconds of the shakes, and makes them flinch off their guns. Recovery is
   * quick when a leader is near (handled in updateMorale), so a single loss steadies
   * but a string of them can break an element — exactly how real squads come apart.
   */
  private casualtyShock(victim: Unit, killed: boolean) {
    if (victim.faction === "civilian") return;
    const base = killed ? 0.18 : 0.1;
    for (const o of this.units) {
      if (o === victim || !o.alive || !o.conscious || o.evac || o.faction !== victim.faction) continue;
      const d = dist(o.pos, victim.pos);
      const sameSquad = !!victim.squadId && o.squadId === victim.squadId;
      if (d > 20 && !sameSquad) continue;
      let amt = base * (d <= 20 ? 1 - d / 20 : 0) + (sameSquad ? base * 0.5 : 0);
      if (victim.isLeader) amt *= 1.5; // losing the man in charge hits hardest
      if (amt <= 0) continue;
      o.composure = clamp01(o.composure - amt);
      o.shaken = Math.max(o.shaken ?? 0, killed ? 3.5 : 2);
      o.suppression = clamp01(o.suppression + amt * 0.3); // the instinct to get small
      o.fireCooldown = Math.max(o.fireCooldown, killed ? 0.6 : 0.3); // a brief flinch off the gun
    }
  }

  /** A squad whose leader is down promotes its steadiest survivor, so it isn't left
   *  leaderless (which would strip the leadership composure bonus and squad C2). */
  private promoteSuccessor(victim: Unit) {
    if (!victim.squadId) return;
    const mates = this.units.filter(
      (o) => o.alive && o.conscious && !o.evac && o.faction === victim.faction && o.squadId === victim.squadId && o !== victim
    );
    if (mates.length === 0 || mates.some((o) => o.isLeader)) return; // still led
    let best = mates[0];
    const score = (u: Unit) => u.leadership + u.experience * 0.5;
    for (const o of mates) if (score(o) > score(best)) best = o;
    best.isLeader = true;
    best.leadership = Math.max(best.leadership, 0.5);
    if (best.faction === "us" || best.faction === "ana") {
      this.addLog(`${this.shortName(best)} takes charge — "On me!"`, "radio");
      this.say(best, "on_me");
    }
  }

  shortName(u: Unit): string {
    const parts = u.name.split(" ");
    return parts[parts.length - 1];
  }
  rankName(u: Unit): string {
    return `${u.rank ?? ""} ${this.shortName(u)}`.trim();
  }

  // ---------------------------------------------------------------- morale
  private updateMorale(u: Unit, dt: number) {
    if (u.faction === "civilian") return;
    // leadership presence
    let leaderBonus = 0;
    if (!u.isLeader) {
      for (const o of this.units) {
        if (o.alive && o.isLeader && o.faction === u.faction && o.squadId === u.squadId) {
          const d = dist(u.pos, o.pos);
          if (d < 45) leaderBonus = Math.max(leaderBonus, o.leadership * (1 - d / 45));
        }
      }
    }
    // cohesion: nearby living friends
    let friends = 0;
    for (const o of this.units) {
      if (o.alive && o.faction === u.faction && o !== u && dist(u.pos, o.pos) < 30) friends++;
    }
    const cohesion = clamp01(friends / 5);

    const target =
      u.composureMax * (0.55 + 0.25 * cohesion + 0.2 * leaderBonus) - u.suppression * 0.6 - u.fatigue * 0.15;
    const rate = u.suppression > 0.4 ? 0.5 : 0.2;
    u.composure = clamp(lerp(u.composure, clamp01(target), rate * dt), 0, 1);

    // panic behaviors handled in AI brains via composure thresholds
  }

  // ---------------------------------------------------------------- fire support
  /** Returns true if friendlies are within danger-close of the impact. */
  isDangerClose(target: Vec2, blastRadius: number): boolean {
    return this.playerUnits().some((u) => dist(u.pos, target) < blastRadius * 2.5);
  }

  requestFireMission(weaponId: string, target: Vec2, rounds: number): FireMission | null {
    const m = this.mortars.find((x) => x.weaponId === weaponId);
    if (!m || m.rounds <= 0) return null;
    const weapon = getWeapon(weaponId);
    const r = dist(m.copPos, target);
    if (r < (weapon.minRange ?? 0) || r > weapon.maxRange) {
      this.addLog(`${weapon.short}: target out of range.`, "support");
      return null;
    }
    const useRounds = Math.min(rounds, m.rounds);
    const fm: FireMission = {
      id: _fmid++,
      weaponId,
      target: { ...target },
      rounds: useRounds,
      roundsLeft: useRounds,
      etaS: this.rng.range(18, 32), // call, plot, fire
      intervalS: 60 / weapon.cyclicRPM + this.rng.range(0.5, 1.5),
      nextRoundS: 0,
      faction: "us",
      status: "requested",
      label: weapon.short,
      dangerClose: this.isDangerClose(target, weapon.blastRadius ?? 15),
      spread: 12 + r * 0.01,
    };
    m.rounds -= useRounds;
    this.fireMissions.push(fm);
    this.fireMissionsUsed++;
    this.addLog(
      `Fire mission: ${weapon.short}, ${useRounds} rounds${fm.dangerClose ? " — DANGER CLOSE" : ""}. Shot, over.`,
      "support"
    );
    return fm;
  }

  requestCAS(target: Vec2, kind: "cas_gun" | "cas_rocket"): FireMission | null {
    if (!this.casAvailable || this.casUsed) {
      this.addLog("No air on station.", "support");
      return null;
    }
    this.casUsed = true;
    const fm: FireMission = {
      id: _fmid++,
      weaponId: kind === "cas_gun" ? "m2" : "javelin",
      target: { ...target },
      rounds: kind === "cas_gun" ? 30 : 1,
      roundsLeft: kind === "cas_gun" ? 30 : 1,
      etaS: this.rng.range(40, 80),
      intervalS: 0.08,
      nextRoundS: 0,
      faction: "us",
      status: "requested",
      label: kind === "cas_gun" ? "GUN RUN" : "HELLFIRE",
      dangerClose: this.isDangerClose(target, 30),
      spread: kind === "cas_gun" ? 18 : 6,
    };
    this.fireMissions.push(fm);
    this.fireMissionsUsed++;
    this.addLog(`CAS inbound — ${fm.label}. Cleared hot.`, "support");
    return fm;
  }

  /** Enemy indirect (mortars/RPG barrage) — used by AI. Insurgent gunnery off a
   *  reverse slope is inaccurate: a large CEP, so it harasses and suppresses and
   *  only occasionally catches someone — not precision fire onto packed men. */
  enemyFireMission(weaponId: string, target: Vec2, rounds: number, etaS: number) {
    const weapon = getWeapon(weaponId);
    this.fireMissions.push({
      id: _fmid++,
      weaponId,
      target: { ...target },
      rounds,
      roundsLeft: rounds,
      etaS,
      intervalS: 60 / weapon.cyclicRPM + this.rng.range(1, 3),
      nextRoundS: 0,
      faction: "insurgent",
      status: "requested",
      label: weapon.short,
      dangerClose: false,
      spread: 38, // large CEP — unregistered, hand-laid tube
    });
  }

  /** Bury an IED in the kill zone, linked to the ambush cell it initiates. */
  plantIED(pos: Vec2, cellSquadId: string, opts: { triggerRadius?: number; damage?: number; blastRadius?: number } = {}): IED {
    const ied: IED = {
      id: `ied-${_fmid++}`,
      pos: { ...pos },
      // The triggerman detonates with the lead men well inside the lethal radius, so
      // the trigger sits INSIDE the blast (not at its edge).
      triggerRadius: opts.triggerRadius ?? 8,
      damage: opts.damage ?? 135, // a stacked-shell / pressure-cooker main charge
      blastRadius: opts.blastRadius ?? 14,
      armed: true,
      cellSquadId,
      plantedAtS: this.timeS,
    };
    this.ieds.push(ied);
    return ied;
  }

  /** Trigger any armed IED whose kill zone now holds a friendly: it detonates (a big
   *  command/victim blast) and initiates its linked ambush — the signature opener. */
  private stepIeds() {
    if (this.ieds.length === 0) return;
    for (const ied of this.ieds) {
      if (!ied.armed) continue;
      const inKill = this.units.some(
        (u) => u.alive && !u.evac && (u.faction === "us" || u.faction === "ana") && dist(u.pos, ied.pos) <= ied.triggerRadius
      );
      if (!inKill) continue;
      ied.armed = false;
      this.addLog(`IED! Command-detonated blast — CONTACT!`, "contact");
      // a big buried charge, attributed to the insurgents (frag → civcas-attributable)
      const p: Projectile = {
        id: `ied-${_eid}`, ownerId: "ied", faction: "insurgent", weaponId: "mortar82",
        origin: { ...ied.pos }, pos: { ...ied.pos }, vel: { x: 0, y: 0 }, speed: 0,
        aimpoint: { ...ied.pos }, targetId: null, traveled: 0, distToAim: 0,
        damage: ied.damage, damageType: "frag", penetration: 0.5, blastRadius: ied.blastRadius,
        suppressionRadius: ied.blastRadius * 2.4, suppression: 4, indirect: true, timeToImpact: 0,
        arcHeight: 0, alive: true, age: 0, tracer: false, hit: false,
      };
      this.detonate(p, ied.pos, true);
      // initiate the linked ambush: the cell springs from hold to engage at once
      if (ied.cellSquadId) {
        for (const e of this.units) {
          if (e.faction !== "insurgent" || e.squadId !== ied.cellSquadId || !e.alive) continue;
          e.iedInit = false; // the charge has gone — open up
          e.brainState = "engage";
          e.rof = "free";
          e.brainTimer = this.rng.range(8, 16);
          e.targetId = this.acquireTarget(e);
        }
      }
    }
    // Cull every tick: spent charges, duds the patrol never reached, and — crucially —
    // any armed charge whose ambush cell is gone (wiped or exfil'd), so a forgotten IED
    // never lingers as an invisible phantom landmine nor leaks onto the per-tick scan.
    this.ieds = this.ieds.filter((ied) => {
      if (!ied.armed) return false;
      if (this.timeS - ied.plantedAtS > IED_TTL_S) return false;
      if (ied.cellSquadId &&
          !this.units.some((e) => e.faction === "insurgent" && e.squadId === ied.cellSquadId && e.alive && !e.evac))
        return false;
      return true;
    });
  }

  private stepFireMissions(dt: number) {
    for (const fm of this.fireMissions) {
      if (fm.status === "complete") continue;
      if (fm.etaS > 0) {
        fm.etaS -= dt;
        if (fm.etaS <= 0) {
          fm.status = "firing";
          if (fm.faction === "us") this.addLog(`${fm.label}: splash, over.`, "support");
          else this.addLog(`Incoming! ${fm.label} rounds!`, "contact");
        }
        continue;
      }
      fm.status = "firing";
      fm.nextRoundS -= dt;
      if (fm.nextRoundS <= 0 && fm.roundsLeft > 0) {
        const weapon = getWeapon(fm.weaponId);
        const off = this.rng.inDisc(fm.target.x, fm.target.y, fm.spread);
        // FDC CHECK FIRE: never drop a friendly round into a friendly's lethal blast. If troops
        // maneuvered into the impact area after the mission was cleared (the dynamic case the
        // call-for-fire gate can't foresee), abort the remaining rounds. Enemy missions don't care.
        if (fm.faction === "us") {
          const lethal = (weapon.blastRadius ?? 12) * 1.3;
          if (this.playerUnits().some((u) => dist(u.pos, off) < lethal)) {
            this.addLog(`CHECK FIRE — friendlies in the impact area; mission aborted.`, "support");
            fm.status = "complete";
            fm.roundsLeft = 0;
            continue;
          }
        }
        // build a projectile that detonates immediately at the offset point
        const p: Projectile = {
          id: `fm${fm.id}-${fm.roundsLeft}`,
          ownerId: "fire_support",
          faction: fm.faction,
          weaponId: fm.weaponId,
          origin: { ...off },
          pos: { ...off },
          vel: { x: 0, y: 0 },
          speed: 0,
          aimpoint: { x: off.x, y: off.y },
          targetId: null,
          traveled: 0,
          distToAim: 0,
          damage: weapon.damage,
          damageType: weapon.damageType,
          penetration: weapon.penetration,
          blastRadius: weapon.blastRadius ?? 12,
          suppressionRadius: weapon.suppressionRadius,
          suppression: weapon.suppression,
          indirect: true,
          timeToImpact: 0.01,
          arcHeight: 200,
          alive: true,
          age: 0,
          tracer: false,
          hit: false,
        };
        this.detonate(p, p.aimpoint);
        fm.roundsLeft--;
        fm.nextRoundS = fm.intervalS;
        if (fm.roundsLeft <= 0) fm.status = "complete";
      }
    }
    this.fireMissions = this.fireMissions.filter((f) => f.status !== "complete" || f.roundsLeft > 0);
  }

  // ---------------------------------------------------------------- smoke/grenades
  throwSmoke(u: Unit, point: Vec2) {
    if (u.smokes <= 0) return;
    u.smokes--;
    const r = dist(u.pos, point);
    if (r > 40) {
      // can't throw that far; drop short
      point = add(u.pos, scale(norm(sub(point, u.pos)), 35));
    }
    this.smoke.push({ x: point.x, y: point.y, radius: 14, density: 0.85 });
    this.addEffect("smoke_pop", point, 1.2);
    this.addLog(`${this.shortName(u)} pops smoke.`, "info");
  }

  throwFrag(u: Unit, point: Vec2) {
    if (u.grenades <= 0) return;
    u.grenades--;
    const r = dist(u.pos, point);
    if (r > 40) point = add(u.pos, scale(norm(sub(point, u.pos)), 38));
    const off = this.rng.inDisc(point.x, point.y, 3);
    const p: Projectile = {
      id: `frag-${_eid}`,
      ownerId: u.id,
      faction: u.faction,
      weaponId: "m320",
      origin: { ...u.pos },
      pos: { ...off },
      vel: { x: 0, y: 0 },
      speed: 0,
      aimpoint: off,
      targetId: null,
      traveled: 0,
      distToAim: 0,
      damage: 55,
      damageType: "frag",
      penetration: 0.3,
      blastRadius: 6,
      suppressionRadius: 8,
      suppression: 2,
      indirect: true,
      timeToImpact: 1.4,
      arcHeight: 10,
      alive: true,
      age: 0,
      tracer: false,
      hit: false,
    };
    this.projectiles.push(p);
    this.addEffect("frag_air", point, 1.4);
  }

  // ---------------------------------------------------------------- medevac
  medevac(unitId: string): boolean {
    const u = this.unit(unitId);
    if (!u) return false;
    u.evac = true;
    u.path = [];
    this.addLog(`${this.shortName(u)} evacuated.`, "support");
    return true;
  }

  // ---------------------------------------------------------------- helpers for AI/UI
  isVisibleToPlayer(u: Unit): boolean {
    if (u.faction === "us" || u.faction === "ana") return true;
    if (u.faction === "civilian") {
      // visible if any friendly has LOS
      return this.playerUnits().some((p) => this.los(p, u).visible && dist(p.pos, u.pos) < 600);
    }
    return this.revealed.has(u.id);
  }

  /**
   * Order a TACTICAL BOUND to a point — the one mechanism every combat brain moves through
   * (cover seeks, shoot-and-scoot, exfil legs, assault bounds, buddy/medic dashes). Two
   * guarantees, applied at this single chokepoint so no caller can re-create the wall-grind
   * loop (2026-07-02 campaign, front A — scripts/combat-grind.ts is the regression watch):
   *  1. The goal is SNAPPED to ground the man can actually stand on/reach. The cover and
   *     exfil pickers could emit a point in a solid cell (walls/HESCO/cliff carry the top
   *     cover values; exfil was a raw beeline) — a man sent INTO one paced at the face or
   *     stall-wiped every 2 s forever while the brain re-issued the identical target
   *     (measured: 570 grind events, one fighter frozen 678 s, 42% of a seed's insurgent
   *     contact time blocked).
   *  2. Past the steering fan's reach (BOUND_ROUTE_M; the fan probes 7 m) the bound ROUTES
   *     like walkTo: straight when the lane is clear (the cheap common case), else the
   *     BUDGETED corridor A* (cheapFallback — never the whole-map search, so dozens of
   *     units under fire can't A*-storm a tick). Short bounds stay a single waypoint the
   *     fan and the watchdog already handle.
   */
  moveTo(u: Unit, point: Vec2) {
    const p = this.standableGoal(point);
    // Already standing on the reachable snap of the request (the true point may be inside
    // the rocks/a wall): NOTHING to walk. Leave the path empty so the caller's own arrival
    // logic fires (friendlyBrain's maybeReachedDest, the scoot->engage flip) — otherwise a
    // brain that re-issues "move to the objective" every tick against an unreachable true
    // point spins a man in place forever, holding his task in "moving".
    if (dist(u.pos, p) < 1.2) {
      u.path = [];
      u.pathGoal = null;
      this.resetStall(u);
      return;
    }
    u.path =
      dist(u.pos, p) <= BOUND_ROUTE_M || walkable(this.terrain, u.pos, p)
        ? [p]
        : findPath(this.terrain, u.pos, p, { cheapFallback: true });
    u.pathGoal = p;
    this.resetStall(u);
  }

  /** Clamp a requested goal into the map and snap it to ground a man can actually stand
   *  on/reach — the shared source-snap for every movement order (moveTo and walkTo). */
  private standableGoal(point: Vec2): Vec2 {
    const q = { x: clamp(point.x, 2, this.terrain.worldSize - 2), y: clamp(point.y, 2, this.terrain.worldSize - 2) };
    const cs = this.terrain.cellSize;
    return this.terrain.passableCell(Math.floor(q.x / cs), Math.floor(q.y / cs)) ? q : this.terrain.reachablePoint(q.x, q.y);
  }

  /**
   * Short-range move that respects solid obstacles. Walks a straight line when the
   * way is clear (cheap — the common case), and only routes around with A* when the
   * straight segment is actually blocked by the wire, a building or a wall. This is
   * the one mechanism that lets garrison soldiers move among now-solid buildings
   * (issue 004) and assembling patrols route to the muster yard around them (issue
   * 003) without any per-situation special-casing.
   */
  walkTo(u: Unit, point: Vec2) {
    // Same source-snap as moveTo (standableGoal): a jittered muster point or rally can land
    // inside a solid cell, and the walker then holds an impassable goal for the whole leg
    // (230 s of the residual impassable-goal time on combat-grind was exactly the assembly
    // muster). A passable request is untouched — the common case stays byte-identical.
    const p = this.standableGoal(point);
    // walkTo is for SHORT, LOCAL moves (garrison seats, mustering, falling back to cover) — never a
    // cross-valley objective — so it uses the cheap fallback: if the corridor can't find the route it
    // best-efforts instead of paying the whole-map free A*. Only the player's squads (steerSquad ->
    // pathTo, no cheapFallback) keep the full search for their objectives.
    u.path = walkable(this.terrain, u.pos, p) ? [p] : findPath(this.terrain, u.pos, p, { cheapFallback: true });
    u.pathGoal = p;
    this.resetStall(u);
  }

  /**
   * Civilian movement: as walkTo, but the goal is first snapped to REACHABLE passable ground
   * that is never inside the COP wire/apron. The reachable snap (issue 010) matters: with the river
   * a real obstacle, a goal across it is in a different component, and a plain nearestPassable snap
   * would re-land it across the water — making findPath re-fire its whole-map free A* every tick (a
   * measured ~470 ms civilian tick stall). reachablePoint keeps the goal in the gate component;
   * civSafePoint then keeps it off the wire.
   */
  civMoveTo(u: Unit, point: Vec2, roadBias = 0) {
    const r = this.terrain.reachablePoint(point.x, point.y);
    const p = this.terrain.civSafePoint(r.x, r.y);
    // A calm villager on a long errand (to another village's bazaar) prefers the road/track network
    // (roadBias > 0); a panicked one (roadBias 0) bolts straight for dead ground. Either way a
    // civilian uses the CHEAP fallback — a villager is flavour, not a soldier with an objective, so a
    // route the corridor can't cheaply find best-efforts instead of paying the whole-map free A*.
    const q = { x: clamp(p.x, 2, this.terrain.worldSize - 2), y: clamp(p.y, 2, this.terrain.worldSize - 2) };
    u.path = walkable(this.terrain, u.pos, q) ? [q] : findPath(this.terrain, u.pos, q, { roadBias, cheapFallback: true });
    u.pathGoal = q;
    this.resetStall(u);
  }

  /** Route a unit to a point following the terrain, honoring its move posture. */
  pathTo(u: Unit, point: Vec2, opts: { concealBias?: number; roadBias?: number; coverBias?: number; cheapFallback?: boolean } = {}) {
    const p = {
      x: clamp(point.x, 2, this.terrain.worldSize - 2),
      y: clamp(point.y, 2, this.terrain.worldSize - 2),
    };
    u.path = findPath(this.terrain, u.pos, p, {
      concealBias: opts.concealBias ?? this.defaultConcealBias(u),
      roadBias: opts.roadBias ?? 0,
      coverBias: opts.coverBias ?? 0,
      cheapFallback: opts.cheapFallback,
      // A deliberate squad march (no cheap fallback) switchbacks up a steep elevated objective
      // instead of ringing the spur (issue 019); local/cheap movers and generation never do.
      // ITM_NOSWITCH=1 is an A/B kill-switch for headless balance bisects (the shared tree bans
      // git-stash, so an env toggle is how a probe measures with-vs-without on identical seeds).
      switchback: !opts.cheapFallback && process.env.ITM_NOSWITCH !== "1",
    });
    u.orderTarget = p;
    u.pathGoal = p;
    this.resetStall(u);
  }

  /** A fresh order clears the stall watchdog so the new move starts clean. */
  private resetStall(u: Unit) {
    u.blockedTimer = 0;
  }

  private defaultConcealBias(u: Unit): number {
    const t = this.techniqueOf(u);
    return t === "concealed" ? 0.7 : t === "tactical" ? 0.3 : 0;
  }

  /** Pick the best currently-perceived enemy for `u` to engage. */
  acquireTarget(u: Unit): string | null {
    let best: string | null = null;
    let bestScore = -Infinity;
    const weapon = this.weaponOf(u);
    for (const eid of u.visibleEnemyIds) {
      const e = this.unit(eid);
      if (!e || !e.alive || e.evac) continue;
      const r = dist(u.pos, e.pos);
      if (r > weapon.maxRange) continue;
      const los = this.los(u, e);
      if (!this.canPerceive(u, los)) continue; // thermal can engage what it sees through foliage
      if (!this.civClear(u, e.pos, e)) continue; // ROE: don't take a target with civilians in the kill zone
      // Prefer close, exposed, and dangerous targets (MG/RPG gunners first).
      let threat = 1;
      const ew = this.weaponOf(e);
      if (ew.cls === "mmg" || ew.cls === "hmg" || ew.cls === "lmg") threat = 2.2;
      else if (ew.cls === "rocket") threat = 2.6;
      else if (ew.cls === "sniper" || ew.cls === "dmr") threat = 1.8;
      const inEff = r <= weapon.effRange ? 1.4 : 0.7;
      // Randomized weighting spreads fire across the element instead of every
      // gun converging on the single most-exposed man (which instakills).
      const spread = 0.45 + 0.55 * this.rng.next();
      const score = threat * inEff * (0.4 + 0.6 * los.exposure) * (1 - r / (weapon.maxRange + 1)) * spread;
      if (score > bestScore) {
        bestScore = score;
        best = eid;
      }
    }
    return best;
  }

  /** Nearest conscious wounded friendly to `u` (for medics). */
  nearestCasualty(u: Unit): Unit | null {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const o of this.units) {
      if (o === u || !o.alive || o.faction !== u.faction) continue;
      if (o.wounds.length === 0 || o.bleedRate <= 0) continue;
      const d = dist(u.pos, o.pos);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Nearest friendly casualty within `r` that still needs hands on him — out cold,
   *  or bleeding and not yet stabilized. (Buddy-aid target.) */
  nearestDownedNeedingHelp(u: Unit, r: number): Unit | null {
    let best: Unit | null = null;
    let bd = r;
    for (const o of this.units) {
      if (o === u || !o.alive || o.faction !== u.faction) continue;
      if (o.wounds.length === 0) continue;
      if (o.conscious && o.bleedRate <= 0.3) continue; // walking-wounded, fighting on
      const d = dist(u.pos, o.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** The nearest conscious, not-badly-hurt, non-medic friendly able to render aid to
   *  `cas` — so exactly ONE buddy peels off per casualty, not the whole squad. */
  nearestAbleBuddy(cas: Unit): Unit | null {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const o of this.units) {
      if (o === cas || !o.alive || !o.conscious || o.faction !== cas.faction) continue;
      if (o.role === "medic" || o.bleedRate > 0.5) continue; // medic has own logic; a casualty can't drag
      const d = dist(o.pos, cas.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** Drag a downed casualty toward the nearest cover; the buddy stays on him, pulling. */
  dragToCover(buddy: Unit, cas: Unit, dt: number) {
    const cover = this.findCover(cas.pos, buddy.threatDir, 25);
    if (!cover) return;
    const dir = norm(sub(cover, cas.pos));
    if (len(dir) < 0.1) return;
    const step = 0.7 * dt; // a slow drag, low and under fire
    const cs = this.terrain.cellSize;
    const next = add(cas.pos, scale(dir, step));
    if (this.terrain.passableCell(Math.floor(next.x / cs), Math.floor(next.y / cs))) {
      cas.pos = next;
      buddy.pos = add(next, scale(dir, -1)); // the buddy just behind, hauling
      buddy.moving = true;
      buddy.speed = 0.7;
    }
  }

  /** Find a nearby cell offering cover from a threat direction. */
  findCover(from: Vec2, threatDir: Vec2 | null, maxSearch = 40): Vec2 | null {
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    const step = this.terrain.cellSize;
    // A synthetic threat position down the threat bearing, so the directional object-cover query knows
    // which way the rounds come from (issue 020, part B: the soldier seeks a rock that covers him from
    // THIS threat — and goes prone behind it, so we evaluate at prone height for the best case).
    const threatPos = threatDir ? add(from, scale(threatDir, 60)) : null;
    for (let r = step; r <= maxSearch; r += step) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const pt = add(from, fromAngle(a, r));
        if (pt.x < 0 || pt.y < 0 || pt.x > this.terrain.worldSize || pt.y > this.terrain.worldSize) continue;
        // Only ground a man can STAND ON. The solid classes carry the TOP cover values
        // (Hesco .92, CompoundWall .86, Cliff .70, Structure .55 — COVER_CONCEAL), so
        // unfiltered, the best-scoring "cover" was routinely INSIDE the wall and the man
        // walked at the face and paced there (measured: 87 friendly loiters ≥15 s, 4.6%
        // of friendly in-contact time spent holding an impassable goal). Cover ADJACENT
        // to the wall is the real thing — the directional objCov below scores it.
        if (!this.terrain.passableCell(Math.floor(pt.x / step), Math.floor(pt.y / step))) continue;
        // The cover this point offers FROM THE THREAT: the better of the 5 m raster and a discrete
        // object that screens it from the threat bearing — so a man now moves to tuck behind a boulder
        // on open ground the raster called bare. (Disabled by the ITM_NOOBJCOVER A/B kill-switch.)
        const objCov = !NO_OBJ_COVER && threatPos ? this.terrain.coverOcclusion(threatPos, pt, 0.5) : 0;
        const cover = Math.max(this.terrain.coverAt(pt.x, pt.y), objCov);
        if (cover < 0.2) continue;
        let score = cover * 10 - r / step;
        // prefer cover between us and the threat
        if (threatDir) {
          const toCover = norm(sub(pt, from));
          score += (toCover.x * -threatDir.x + toCover.y * -threatDir.y) * 3;
        }
        if (score > bestScore) {
          bestScore = score;
          best = pt;
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- civilian ROE gate
  /**
   * The civilian-fire gate — the COIN spine. Returns FALSE (do NOT fire / reject this
   * target) when taking the shot would put a conscious civilian inside a weapon- and
   * ROE-scaled keep-out of either the aimpoint OR the gun→target line. This is the single
   * chokepoint every friendly shot passes: consulted in `acquireTarget` (so a fouled
   * target is never even selected) and again at burst-commit in `updateFiring`
   * (belt-and-suspenders, since the civilian or the line may have moved since acquisition).
   * Only US/ANA observe ROE; insurgents and civilians are never gated here.
   */
  civClear(shooter: Unit, aimPos: Vec2, target?: Unit | null): boolean {
    if (shooter.faction !== "us" && shooter.faction !== "ana") return true;
    const roe = shooter.roe ?? "tight";
    const weapon = this.weaponOf(shooter);
    const cls = weapon.cls;
    const area = cls === "lmg" || cls === "mmg" || cls === "hmg" || cls === "agl" || shooter.rof === "suppress";
    const blast = cls === "gl" || cls === "agl" || cls === "rocket" || cls === "missile" || cls === "mortar";
    // Keep-out radius around the aimpoint. `tight`/`hold` keep a generous bubble; `free`
    // shrinks to danger-close (a civ standing on the aimpoint) but is never zero.
    let guard = shooter.civGuard ?? (roe === "free" ? 4 : roe === "hold" ? 28 : 22);
    if (area) guard *= 1.6;
    if (blast) guard = Math.max(guard, 18);
    // Corridor half-width: how close to the gun→target line a civilian can be before the
    // shot is fouled. A burst/blast sprays wide; an aimed rifle shot is a tight lane.
    const corridor = area || blast ? guard * 0.7 : Math.max(2.5, guard * 0.35);
    const reach = dist(shooter.pos, aimPos);
    const dirx = aimPos.x - shooter.pos.x;
    const diry = aimPos.y - shooter.pos.y;

    for (const c of this.civilians) {
      if (!c.alive || !c.conscious || c.evac) continue;
      if (dist(c.pos, aimPos) <= guard) return false; // civilian at/around the impact point (any side)
      // The line-of-fire corridor test only applies DOWNRANGE: a civilian BEHIND the muzzle
      // is not in the beaten zone. (segDist clamps to the gun endpoint, so without this a civ
      // standing behind the soldier would falsely foul his shot and freeze his return fire.)
      const fwd = (c.pos.x - shooter.pos.x) * dirx + (c.pos.y - shooter.pos.y) * diry;
      if (fwd <= 0) continue; // behind the muzzle
      if (dist(shooter.pos, c.pos) > reach + guard) continue; // beyond the target
      if (segDist(c.pos, shooter.pos, aimPos) <= corridor) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- outcome
  private checkOutcome() {
    // In the persistent world the engagement never "ends" — the World layer
    // tracks contact lulls and the enemy lifecycle. Combat just keeps running.
    if (this.persistent) return;
    const us = this.units.filter((u) => (u.faction === "us" || u.faction === "ana") && u.alive && !u.evac && u.conscious);
    // an enemy still "in the fight" is conscious, on the map, and not already breaking contact
    const enemyEffective = this.units.filter(
      (e) => e.faction === "insurgent" && e.alive && e.conscious && !e.evac && e.brainState !== "exfil"
    );
    const pendingEnemyFire = this.fireMissions.some((f) => f.faction === "insurgent");
    if (us.length === 0) {
      this.outcome = "us_destroyed";
      this.addLog("All friendly elements down or evacuated.", "kia");
    } else if (enemyEffective.length === 0 && !pendingEnemyFire) {
      this.outcome = "us_victory";
      this.addLog("Contact broken. Enemy destroyed or withdrawn.", "objective");
    } else if (
      // Lull: nobody has fired for a while and no rounds are in the air — the
      // fight has petered out (enemy lost contact / can't get an angle).
      this.timeS - this.lastActivityS > 28 &&
      this.projectiles.length === 0 &&
      !pendingEnemyFire &&
      this.timeS > 20
    ) {
      this.outcome = "us_victory";
      this.addLog("The valley has gone quiet. Contact broken.", "objective");
    }
  }

  result(): CombatResult {
    const usKIA = this.units.filter((u) => (u.faction === "us" || u.faction === "ana") && !u.alive).map((u) => u.id);
    const usWIA = this.units
      .filter((u) => (u.faction === "us" || u.faction === "ana") && u.alive && u.wounds.length > 0)
      .map((u) => u.id);
    const enemyKIA = this.units.filter((u) => u.faction === "insurgent" && !u.alive).length;
    const civCasualties = this.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;
    return {
      outcome: this.outcome,
      usKIA,
      usWIA,
      enemyKIA,
      civCasualties,
      durationS: this.timeS,
      ammoExpended: this.ammoExpended,
      fireMissionsUsed: this.fireMissionsUsed,
    };
  }

  /** Player-initiated end (break contact) once safe. */
  withdraw() {
    this.outcome = "us_withdraw";
  }
}
