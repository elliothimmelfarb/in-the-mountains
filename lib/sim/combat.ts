import { RNG, clamp, clamp01, lerp } from "./rng";
import { Vec2, dist, sub, norm, scale, add, len, fromAngle, angle } from "./vec";
import { Terrain } from "./terrain";
import { Unit, unitHeight, eyeHeight, MoveTechnique } from "./entities";
import { findPath, walkable, PathOptions } from "./path";
import { steer } from "./steering";
import { getWeapon, Weapon } from "./weapons";
import { lineOfSight, detectionChance, LOSResult, SmokeScreen } from "./los";
import {
  Projectile,
  spawnProjectile,
  resolveDirectHit,
  applyDamage,
  blastDamageAt,
} from "./ballistics";
import { insurgentBrain } from "./ai/insurgent";
import { civilianBrain } from "./ai/civilian";
import { friendlyBrain } from "./ai/friendly";

export type OrderType =
  | "move"
  | "assault"
  | "hold"
  | "engage"
  | "suppress"
  | "holdfire"
  | "weaponsfree"
  | "withdraw"
  | "smoke"
  | "frag"
  | "treat"
  | "regroup"
  | "halt";

export type { MoveTechnique } from "./entities";

export interface Order {
  type: OrderType;
  point?: Vec2;
  targetId?: string;
  technique?: MoveTechnique;
  rof?: Unit["rof"];
  /** Route the move along the terrain (A*) instead of a straight line. */
  pathfind?: boolean;
  /** 0..1 preference for concealment when pathfinding. */
  concealBias?: number;
}

export type EffectKind =
  | "muzzle"
  | "impact"
  | "ricochet"
  | "blast"
  | "blood"
  | "frag_air"
  | "smoke_pop"
  | "flare";

export interface Effect {
  id: number;
  kind: EffectKind;
  pos: Vec2;
  to?: Vec2;
  t: number;
  ttl: number;
  faction?: Unit["faction"];
  size?: number;
}

export type LogKind = "info" | "contact" | "casualty" | "kia" | "radio" | "support" | "objective";

export interface LogEntry {
  id: number;
  timeS: number;
  msg: string;
  kind: LogKind;
}

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
}

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
  fireMissions: FireMission[] = [];
  timeS = 0;
  light: number;
  weather: CombatInit["weather"];
  context: string;
  mortars: NonNullable<CombatInit["mortars"]>;
  casAvailable: boolean;
  casUsed = false;
  persistent: boolean;
  outcome: CombatOutcome = "ongoing";
  ammoExpended = 0;
  fireMissionsUsed = 0;
  lastActivityS = 0; // last time a round was fired or detonated (for lull detection)
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

  addEffect(kind: EffectKind, pos: Vec2, ttl: number, opts: Partial<Effect> = {}) {
    this.effects.push({ id: _eid++, kind, pos: { ...pos }, t: 0, ttl, ...opts });
  }

  // ---------------------------------------------------------------- orders
  issueOrder(unitIds: string[], order: Order) {
    for (const id of unitIds) {
      const u = this.unit(id);
      if (!u || !u.alive || u.faction === "insurgent" || u.faction === "civilian") continue;
      this.applyOrder(u, order);
    }
  }

  private applyOrder(u: Unit, order: Order) {
    u.orderType = order.type;
    u.brainTimer = 0;
    // Any explicit order breaks the squad's formation locks.
    u.faceLock = null;
    u.formationHold = false;
    u.paceScale = 1;
    this.resetStall(u);
    switch (order.type) {
      case "move":
      case "assault":
      case "withdraw":
        if (order.point) {
          u.orderTarget = { ...order.point };
          u.pathGoal = { ...order.point };
          u.path = order.pathfind
            ? findPath(this.terrain, u.pos, order.point, this.pathOptsFor(u, order))
            : [{ ...order.point }];
          u.brainState = order.type === "withdraw" ? "withdrawing" : "moving";
        }
        if (order.type === "assault") u.rof = "free";
        break;
      case "hold":
        u.orderTarget = order.point ? { ...order.point } : { ...u.pos };
        u.pathGoal = order.point ? { ...order.point } : null;
        u.path = order.point ? [{ ...order.point }] : [];
        u.brainState = "holding";
        break;
      case "engage":
        u.targetId = order.targetId ?? u.targetId;
        u.orderTarget = order.point ? { ...order.point } : null;
        u.rof = "free";
        u.brainState = "engaging";
        break;
      case "suppress":
        u.orderTarget = order.point ? { ...order.point } : null;
        u.rof = "suppress";
        u.brainState = "suppressing";
        break;
      case "holdfire":
        u.rof = "hold";
        break;
      case "weaponsfree":
        u.rof = "free";
        break;
      case "smoke":
        if (order.point) this.throwSmoke(u, order.point);
        break;
      case "frag":
        if (order.point) u.orderTarget = { ...order.point };
        u.brainState = "fragging";
        break;
      case "treat":
        u.targetId = order.targetId ?? null;
        u.brainState = "treating";
        break;
      case "regroup":
        u.brainState = "regroup";
        if (order.point) u.path = [{ ...order.point }];
        break;
      case "halt":
        u.path = [];
        u.orderTarget = null;
        u.pathGoal = null;
        u.brainState = "holding";
        break;
    }
    if (order.rof) u.rof = order.rof;
    if (order.technique) u.technique = order.technique;
  }

  techniqueOf(u: Unit): MoveTechnique {
    return u.technique ?? "traveling";
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

    // 3. AI / order execution
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

    // suppression decays
    if (u.suppression > 0) u.suppression = Math.max(0, u.suppression - dt * 0.28);
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

    // fatigue recovers when stationary
    if (!u.moving && u.fatigue > 0) u.fatigue = Math.max(0, u.fatigue - dt * 0.01);
  }

  /** Is a conscious, not-badly-bleeding friendly within `r` m to apply buddy aid (a
   *  tourniquet) to a casualty who can't help himself? Casualties are few, so the
   *  scan is bounded. */
  private consciousBuddyNear(u: Unit, r: number): boolean {
    for (const o of this.units) {
      if (o === u || !o.alive || !o.conscious || o.faction !== u.faction) continue;
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
    const nvg = (u.faction === "us" || u.faction === "ana"); // US have NODs at night
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

  // ---------------------------------------------------------------- movement
  /**
   * Rebuild the per-tick spatial hash of living bodies. Bucketed at NB_BUCKET m so
   * a 3×3 block of buckets around a unit covers the steering separation radius. This
   * is what lets separation be O(neighbors) instead of O(units) per unit.
   */
  private buildSpatialGrid() {
    this.grid.clear();
    for (const u of this.units) {
      if (!u.alive || u.evac) continue;
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
      this.halt(u);
      return;
    }
    // Out of waypoints → the goal is reached (paths run to the goal). Drop it and
    // stop; whoever's driving this unit (squad steering, garrison) re-issues a
    // path next tick if it still needs to move. No per-tick re-plan here.
    if (u.path.length === 0) {
      u.pathGoal = null;
      this.halt(u);
      return;
    }
    if (u.formationHold) {
      this.halt(u);
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
    speed *= 1 - u.fatigue * 0.45;
    speed *= 1 - u.suppression * 0.4;
    // Combat load: every man a mule. A heavy load (the SAW/240 gunner, the man
    // humping mortar rounds) drags the pace and burns him out faster; fitness offsets
    // some of it. Computed here (cheap), the same figure feeds the fatigue accrual.
    const overload = Math.max(0, combatLoadKg(u, this.weaponOf(u)) - REF_LOAD_KG);
    speed *= clamp(1 - overload * (0.006 * (1.3 - u.fitnessMax)), 0.5, 1);
    // leg wounds slow you
    if (u.wounds.some((w) => w.region === "leg" && !w.treated)) speed *= 0.5;
    // squad pace governor: the point man eases the throttle (never a dead stop) so
    // the element stays together — read as a smooth slowdown, not a freeze.
    if (u.paceScale != null) speed *= Math.max(0, Math.min(1, u.paceScale));
    speed = Math.max(0.15, speed);

    // Local steering: round nearby obstacles and keep clear of other bodies. With a
    // clear lane ahead and no one crowding, this returns the goal heading unchanged,
    // so open-ground and combat movement are unaffected — it only bends the heading
    // where the ground (the HESCO ring, a draw) or the crowd (a choke) demands it.
    const dir = steer(this.terrain, u, goalDir, this.neighborsFor(u), speed).dir;

    // Walk the steered heading, but face the assigned security sector if one is
    // locked (flank/rear men scan outboard while moving).
    u.facing = u.faceLock != null ? u.faceLock : angle(dir);
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

    // fatigue from movement (steeper + higher + heavier = worse)
    const slope = this.terrain.slopeAt(u.pos.x, u.pos.y);
    const alt = clamp01((this.terrain.elevAt(u.pos.x, u.pos.y) - 1500) / 1400);
    u.fatigue = clamp01(
      u.fatigue + stepLen * (0.0012 + slope * 0.004 + alt * 0.0016) * (tech === "rush" ? 2 : 1) * (1 + overload * 0.012)
    );

    this.watchStall(u, dt, blocked);
  }

  /** Stop moving but keep holding any locked security sector. */
  private halt(u: Unit) {
    u.moving = false;
    u.speed = 0;
    u.blockedTimer = 0;
    if (u.faceLock != null && u.conscious) u.facing = u.faceLock;
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
          // pause between bursts (longer if low composure)
          u.fireCooldown = this.rng.range(0.5, 1.4) * (weapon.auto ? 1 : 1.6) * (2 - u.composure);
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
      if (!los.visible || r > weapon.maxRange) {
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

    // out of ammo for this weapon?
    if (u.ammo <= 0) {
      if (u.reserveAmmo > 0) {
        u.reloading = weapon.reload;
        u.ammo = Math.min(weapon.magSize, u.reserveAmmo);
        u.reserveAmmo -= u.ammo;
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

    // begin a burst
    const [bmin, bmax] = weapon.burst;
    let burst = this.rng.int(bmin, bmax);
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
    this.ammoExpended++;
    this.lastActivityS = this.timeS;
    this.addEffect("muzzle", u.pos, 0.12, {
      faction: u.faction,
      size: weapon.cls === "hmg" || weapon.cls === "mmg" ? 1.6 : 1,
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
          this.addEffect("impact", p.aimpoint, 0.3, { faction: p.faction });
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

  private detonate(p: Projectile, at: Vec2) {
    const radius = p.blastRadius || 6;
    this.lastActivityS = this.timeS;
    this.addEffect("blast", at, 0.6, { faction: p.faction, size: radius / 8 });
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
        let dmg = blastDamageAt(d, radius, p.damage) * (1 - cover * 0.55);
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
    // sample a couple of points along this step and suppress nearby enemies of shooter
    const owner = this.unit(p.ownerId);
    const samples = 2;
    for (let i = 0; i < samples; i++) {
      const t = from + ((to - from) * (i + 0.5)) / samples;
      const pt = add(p.origin, scale(norm(p.vel), t));
      for (const u of this.units) {
        if (!u.alive || u.evac || u.faction === "civilian") continue;
        if (owner && !this.isHostile(owner, u)) continue;
        const d = dist(u.pos, pt);
        if (d < p.suppressionRadius) {
          this.addSuppression(u, p.suppression * (1 - d / p.suppressionRadius) * 0.5, p.origin);
        }
      }
    }
  }

  addSuppression(u: Unit, amount: number, fromPos: Vec2) {
    u.suppression = clamp01(u.suppression + amount * 0.12);
    u.threatDir = norm(sub(fromPos, u.pos));
  }

  /** Hard cover protecting `target` from incoming rounds (stance + microterrain). */
  coverFor(target: Unit, _fromPos: Vec2): number {
    let cover = this.terrain.coverAt(target.pos.x, target.pos.y);
    // prone behind microterrain adds cover
    if (target.stance === "prone") cover = clamp01(cover + 0.18);
    else if (target.stance === "crouch") cover = clamp01(cover + 0.08);
    return cover;
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
    } else if (u.faction === "civilian") {
      this.addLog(`A civilian is wounded in the crossfire.`, "casualty");
    }
  }

  private onDeath(u: Unit, cause: string) {
    this.casualtyShock(u, true);
    if (u.faction === "us" || u.faction === "ana") {
      this.addLog(`${this.rankName(u)} is KIA (${cause}).`, "kia");
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
    if (best.faction === "us" || best.faction === "ana")
      this.addLog(`${this.shortName(best)} takes charge — "On me!"`, "radio");
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
    };
    this.ieds.push(ied);
    return ied;
  }

  /** Trigger any armed IED whose kill zone now holds a friendly: it detonates (a big
   *  command/victim blast) and initiates its linked ambush — the signature opener. */
  private stepIeds() {
    let fired = false;
    for (const ied of this.ieds) {
      if (!ied.armed) continue;
      const inKill = this.units.some(
        (u) => u.alive && !u.evac && (u.faction === "us" || u.faction === "ana") && dist(u.pos, ied.pos) <= ied.triggerRadius
      );
      if (!inKill) continue;
      ied.armed = false;
      fired = true;
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
      this.detonate(p, ied.pos);
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
    if (fired) this.ieds = this.ieds.filter((i) => i.armed);
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

  /** Order a unit to walk to a point (straight-line; the mover re-plans if blocked). */
  moveTo(u: Unit, point: Vec2) {
    const p = { x: clamp(point.x, 0, this.terrain.worldSize), y: clamp(point.y, 0, this.terrain.worldSize) };
    u.path = [p];
    u.pathGoal = p;
    this.resetStall(u);
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
    const p = { x: clamp(point.x, 2, this.terrain.worldSize - 2), y: clamp(point.y, 2, this.terrain.worldSize - 2) };
    u.path = walkable(this.terrain, u.pos, p) ? [p] : findPath(this.terrain, u.pos, p);
    u.pathGoal = p;
    this.resetStall(u);
  }

  /**
   * Civilian movement: as walkTo, but the goal is first snapped to passable ground
   * that is never inside the COP wire/apron, so villagers by an outpost never have a
   * goal across the HESCO (the "villagers wander into the wire" bug).
   */
  civMoveTo(u: Unit, point: Vec2) {
    this.walkTo(u, this.terrain.civSafePoint(point.x, point.y));
  }

  /** Route a unit to a point following the terrain, honoring its move posture. */
  pathTo(u: Unit, point: Vec2, opts: { concealBias?: number; roadBias?: number; coverBias?: number } = {}) {
    const p = {
      x: clamp(point.x, 2, this.terrain.worldSize - 2),
      y: clamp(point.y, 2, this.terrain.worldSize - 2),
    };
    u.path = findPath(this.terrain, u.pos, p, {
      concealBias: opts.concealBias ?? this.defaultConcealBias(u),
      roadBias: opts.roadBias ?? 0,
      coverBias: opts.coverBias ?? 0,
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

  private pathOptsFor(u: Unit, order: Order): PathOptions {
    return { concealBias: order.concealBias ?? this.defaultConcealBias(u) };
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
      if (!los.visible) continue;
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
    for (let r = step; r <= maxSearch; r += step) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const pt = add(from, fromAngle(a, r));
        if (pt.x < 0 || pt.y < 0 || pt.x > this.terrain.worldSize || pt.y > this.terrain.worldSize) continue;
        const cover = this.terrain.coverAt(pt.x, pt.y);
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
