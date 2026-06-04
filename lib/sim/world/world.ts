import { RNG, clamp, clamp01, lerp, smoothstep } from "../rng";
import { Terrain } from "../terrain";
import { Vec2, dist } from "../vec";
import { Platoon, Unit, MoveTechnique } from "../entities";
import { CombatSim, CombatInit } from "../combat";
import {
  VillageState,
  IntelReport,
  Directive,
  rollWeather,
  weatherLightMult,
  attitudeToMetric,
} from "../campaign";
import {
  WorldState,
  Task,
  Project,
  PendingEvent,
  MissionType,
  MISSION_LABEL,
  DEPLOY_START,
  DAY,
  Ids,
} from "./types";
import { shortName, rankName, centroidOf } from "./helpers";
import { runDirector } from "./director";
import { tickTasks } from "./tasks";
import { tickGarrison } from "./garrison";
import { tickProjects, tickResupplies } from "./projects";
import { makeWorldEvent } from "./events";

/**
 * The single, always-running simulation of the valley. One continuous clock
 * drives the sun, the weather, your soldiers' fatigue, the enemy's tempo, the
 * slow grind of village projects and the firefights that erupt when any of it
 * collides. There are no turns and no phases — everything takes time.
 *
 * The class stays lean: it owns the clock, the unit-level CombatSim and the
 * order interface, and delegates the heavy subsystems (enemy director, tasks,
 * projects, events) to sibling modules that operate on this instance.
 */
export class World {
  terrain: Terrain;
  rng: RNG;
  sim: CombatSim;
  state: WorldState;
  platoon: Platoon;
  pendingEvent: PendingEvent | null = null;
  private interrupts: string[] = [];

  constructor(terrain: Terrain, rng: RNG, state: WorldState, units: Unit[], platoon: Platoon) {
    this.terrain = terrain;
    this.rng = rng;
    this.state = state;
    this.platoon = platoon;
    const copWorld = terrain.cellCenter(state.copCell.cx, state.copCell.cy);
    const mortars: NonNullable<CombatInit["mortars"]> = [];
    if (state.supplies.mortar_60 > 0)
      mortars.push({ weaponId: "mortar60", rounds: state.supplies.mortar_60, copPos: copWorld });
    if (state.supplies.mortar_81 > 0)
      mortars.push({ weaponId: "mortar81", rounds: state.supplies.mortar_81, copPos: copWorld });
    this.sim = new CombatSim({
      terrain,
      rng,
      units,
      light: 1,
      weather: { visibilityM: state.weather.visibilityM, wind: state.weather.wind, label: state.weather.label, windX: 0, windY: 0 },
      context: state.fob.name,
      mortars,
      casAvailable: state.weather.airAvailable,
      persistent: true,
    });
    this.refreshLight();
  }

  serialize(): { v: number; rngState: number; state: WorldState; units: Unit[] } {
    const units = this.sim.units.map((u) => ({ ...u, _fireLOS: null, _fireTarget: null }));
    return { v: 2, rngState: this.rng.getState(), state: this.state, units };
  }

  // ---------------------------------------------------------------- time of day
  get absSeconds() {
    return this.state.clock + DEPLOY_START;
  }
  get day() {
    return Math.floor(this.absSeconds / DAY) + 1;
  }
  get secondsOfDay() {
    return this.absSeconds % DAY;
  }
  clockLabel(): string {
    const s = this.secondsOfDay;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return `Day ${this.day} · ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  solarLight(): number {
    const h = this.secondsOfDay / 3600;
    const star = 0.05;
    if (h >= 7 && h < 17) return 1;
    if (h >= 5 && h < 7) return lerp(star, 1, smoothstep(5, 7, h));
    if (h >= 17 && h < 19.5) return lerp(1, star, smoothstep(17, 19.5, h));
    return star;
  }
  ambientLight(): number {
    return clamp01(this.solarLight() * weatherLightMult(this.state.weather));
  }
  isNight(): boolean {
    return this.solarLight() < 0.2;
  }
  private refreshLight() {
    this.sim.light = this.ambientLight();
  }

  /**
   * Effective wind vector (m/s, world frame): the prevailing synoptic wind plus the
   * valley's diurnal flow — anabatic up-valley (toward the head, −Y) by day,
   * katabatic down-valley (+Y) at night — so the daily wind pattern is learnable.
   * Drives bullet drift and smoke drift; read by the CombatSim each tick.
   */
  windVector(): Vec2 {
    const spd = this.state.weather.wind;
    const day = this.solarLight(); // 0..1
    const along = lerp(0.9, -0.9, day); // night +Y (down-valley), day −Y (up-valley)
    const dir = this.state.weather.windDir;
    return { x: Math.cos(dir) * 0.5 * spd, y: (Math.sin(dir) * 0.5 + along) * spd };
  }

  // ---------------------------------------------------------------- logging
  log(msg: string, kind = "info") {
    this.state.log.push({ id: Ids.log++, day: this.day, timeLabel: this.clockLabel(), msg, kind });
    if (this.state.log.length > 600) this.state.log.splice(0, this.state.log.length - 600);
  }
  addIntel(r: Omit<IntelReport, "id" | "day" | "timeLabel">) {
    this.state.intel.unshift({ ...r, id: Ids.intel++, day: this.day, timeLabel: this.clockLabel() });
    if (this.state.intel.length > 120) this.state.intel.length = 120;
  }
  interrupt(reason: string) {
    this.interrupts.push(reason);
  }
  drainInterrupts(): string[] {
    const i = this.interrupts;
    this.interrupts = [];
    return i;
  }

  // ---------------------------------------------------------------- master tick
  tick(dt: number) {
    if (this.state.ended) return;
    const prevNight = this.isNight();
    const prevContact = this.inContact();
    this.state.clock += dt;
    this.refreshLight();

    const wv = this.windVector();
    this.sim.weather = {
      visibilityM: this.state.weather.visibilityM,
      wind: this.state.weather.wind,
      label: this.state.weather.label,
      windX: wv.x,
      windY: wv.y,
    };
    this.sim.casAvailable = this.state.weather.airAvailable;

    this.tickSupplies(dt);
    this.tickSoldiers(dt);
    tickTasks(this, dt);
    tickGarrison(this, dt);
    tickProjects(this, dt);
    tickResupplies(this);
    this.tickWeather();
    this.tickIntel();
    runDirector(this, dt);
    this.tickEvents();
    this.tickMetrics(dt);

    this.sim.tick(dt);

    this.reconcileCasualties();
    this.reconcileCivilians();
    this.tickInsurgency(dt);
    this.cullEnemies();

    if (this.inContact()) this.state.lastContactClock = this.state.clock;
    if (!prevContact && this.inContact()) this.interrupt("TROOPS IN CONTACT");
    if (prevNight && !this.isNight()) this.interrupt("first light");

    this.checkTourEnd();
  }

  // ---------------------------------------------------------------- supplies
  private tickSupplies(dt: number) {
    const n = this.platoon.members.filter((m) => m.alive).length;
    const perDay = (rate: number) => (n * rate * dt) / DAY;
    this.state.supplies.water = Math.max(0, this.state.supplies.water - perDay(3.5));
    this.state.supplies.food = Math.max(0, this.state.supplies.food - perDay(2.6));
    this.state.supplies.batteries = Math.max(0, this.state.supplies.batteries - (n * 0.4 * dt) / DAY);
  }

  // ---------------------------------------------------------------- soldiers
  private tickSoldiers(dt: number) {
    const tasked = new Set<string>();
    for (const t of this.state.tasks) for (const id of t.memberIds) tasked.add(id);
    const nightRest = this.isNight() ? 1.8 : 1;
    for (const m of this.platoon.members) {
      if (!m.alive) continue;
      if (m.status === "wounded") {
        m.daysToRecover -= dt / DAY;
        if (m.daysToRecover <= 0) {
          m.status = "ready";
          m.hp = clamp(m.hp + 45, 30, 100);
          m.wounds = [];
          m.bleedRate = 0;
          m.evac = false;
          m.pos = { ...this.copWorld() };
          this.log(`${rankName(m)} is back on full duty.`, "info");
          this.interrupt(`${shortName(m)} returns to duty`);
        }
        continue;
      }
      const atBase = !tasked.has(m.id) && dist(m.pos, this.copWorld()) < 90;
      if (atBase) {
        m.rest = clamp01(m.rest + (2.0 / DAY) * dt * nightRest);
        m.fatigue = clamp01(m.fatigue - (3.0 / DAY) * dt);
        if (m.status === "rest" && m.rest > 0.9) m.status = "ready";
      } else if (tasked.has(m.id)) {
        m.rest = clamp01(m.rest - (1.2 / DAY) * dt);
      }
      const target = clamp01(0.45 + this.state.metrics.stability / 300 + (this.state.metrics.higherConfidence - 50) / 400);
      m.morale = clamp01(m.morale + (target - m.morale) * (0.25 / DAY) * dt);
    }
  }

  // ---------------------------------------------------------------- weather
  private tickWeather() {
    if (this.state.clock >= this.state.nextWeatherAt) {
      this.state.weather = rollWeather(this.rng);
      this.state.nextWeatherAt = this.state.clock + this.rng.range(4, 9) * 3600;
      this.log(`Weather: ${this.state.weather.label}, vis ${(this.state.weather.visibilityM / 1000).toFixed(1)} km, ${this.state.weather.airAvailable ? "air available" : "no air (weather)"}.`, "info");
    }
  }

  // ---------------------------------------------------------------- intel cadence
  private tickIntel() {
    if (this.state.clock < this.state.nextIntelAt) return;
    this.state.nextIntelAt = this.state.clock + (this.rng.range(8, 26) * 60) / (0.5 + this.state.enemyHeat);
    const roll = this.rng.next();
    if (roll < 0.5) {
      const v = this.rng.pick(this.state.villages);
      const lines = [
        `ICOM: "...the donkeys are loaded, move them after dark..."`,
        `ICOM: "...are the guests still in the upper house?..."`,
        `ICOM: "...wait until they reach the big rock, then..."`,
        `ICOM: "...the Americans came to ${v.name} today, count them..."`,
        `ICOM: "...we need more for the PK, send it down the draw..."`,
        `ICOM: "...do not fire until I say... be patient..."`,
      ];
      this.addIntel({ source: "SIGINT", text: this.rng.pick(lines), reliability: this.rng.range(0.3, 0.7), cx: v.cx, cy: v.cy });
    } else if (roll < 0.75) {
      const coop = this.state.villages.filter((v) => v.cooperation > 48);
      if (coop.length) {
        const v = this.rng.pick(coop);
        this.addIntel({
          source: "HUMINT",
          text: `A man from ${v.name} says fighters from outside the valley are staying near ${this.rng.pick(this.state.villages).name}.`,
          reliability: clamp01(v.cooperation / 130),
          cx: v.cx,
          cy: v.cy,
        });
      }
    } else if (this.isNight() && this.rng.chance(0.7)) {
      this.addIntel({ source: "DRONE", text: `ISR: thermal hits moving along a trail in the upper valley after curfew.`, reliability: 0.6 });
    }
  }

  // ---------------------------------------------------------------- events
  private tickEvents() {
    if (this.pendingEvent || this.state.clock < this.state.nextEventAt) return;
    this.state.nextEventAt = this.state.clock + this.rng.range(45, 110) * 60;
    if (!this.rng.chance(0.8)) return;
    this.pendingEvent = makeWorldEvent(this);
    if (this.pendingEvent) this.interrupt(this.pendingEvent.title);
  }

  // ---------------------------------------------------------------- metrics
  private tickMetrics(dt: number) {
    const m = this.state.metrics;
    m.attitude = attitudeToMetric(this.state.villages);
    m.enemyStrength = clamp(this.state.enemyStrengthAbs, 0, 100);
    const total = this.platoon.members.length;
    const ready = this.platoon.members.filter((x) => x.alive && (x.status === "ready" || x.status === "rest")).length;
    const ammoFrac = clamp01(this.state.supplies.ammo_556 / 22000);
    m.combatPower = clamp((ready / Math.max(1, total)) * 70 + ammoFrac * 30, 0, 100);
    const stabTarget = clamp(m.attitude * 0.5 + (100 - m.enemyStrength) * 0.35 + m.combatPower * 0.15, 0, 100);
    m.stability = clamp(m.stability + (stabTarget - m.stability) * (0.5 / DAY) * dt, 0, 100);
  }

  // ---------------------------------------------------------------- casualties / cull
  private reconcileCasualties() {
    for (const m of this.platoon.members) {
      if (!m.alive && m.status !== "kia") {
        m.status = "kia";
        m.hp = 0;
        this.log(`${rankName(m)} of ${m.homeState} was killed in action.`, "kia");
        this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence - 3, 0, 100);
        for (const o of this.platoon.members) if (o.alive) o.morale = clamp01(o.morale - 0.05);
        this.interrupt(`${shortName(m)} KIA`);
      } else if (m.alive && m.evac && m.status !== "wounded") {
        m.status = "wounded";
        m.daysToRecover = clamp(2 + m.wounds.reduce((a, w) => a + w.severity * 14, 0), 1, 45);
        this.log(`${rankName(m)} was evacuated (${m.wounds.map((w) => w.region).join(", ") || "wounded"}).`, "casualty");
        this.interrupt(`${shortName(m)} WIA / MEDEVAC`);
      }
    }
  }

  /**
   * Civilian casualties are the COIN catastrophe. A villager killed or wounded by
   * OUR fires hardens the nearest village (attitude down, sympathy up), mobilizes a
   * few fighters from the population (couples to tickInsurgency), and costs higher
   * confidence — and may trigger a solatia/complaint. The enemy killing locals does
   * the reverse, a small information-operations win for us. Reads the per-unit
   * attribution set at blast time; processed once per civilian.
   */
  private reconcileCivilians() {
    for (const u of this.sim.units) {
      if (u.faction !== "civilian") continue;
      const casualty = !u.alive || (u.wounds && u.wounds.length > 0);
      if (!casualty || u.casualtyCounted) continue;
      u.casualtyCounted = true;
      const killed = !u.alive;
      const by = u.casualtyByFaction;
      const vil = this.nearestVillage(u.pos, 700);
      if (by === "us" || by === "ana") {
        if (vil) {
          vil.attitude = clamp(vil.attitude - (killed ? 14 : 6), -100, 100);
          vil.sympathy = clamp(vil.sympathy + (killed ? 11 : 5), 0, 100);
          vil.cooperation = clamp(vil.cooperation - (killed ? 8 : 3), 0, 100);
        }
        this.state.enemyStrengthAbs = clamp(this.state.enemyStrengthAbs + (killed ? 2 : 0.5), 0, 100); // mobilization
        this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence - (killed ? 3 : 1), 0, 100);
        this.log(`CIVCAS — a civilian was ${killed ? "killed" : "wounded"}${vil ? ` near ${vil.name}` : ""}, attributed to our fires. The valley will not forget.`, "casualty");
        this.interrupt("CIVCAS incident");
      } else if (by === "insurgent") {
        if (vil) {
          vil.attitude = clamp(vil.attitude + (killed ? 3 : 1), -100, 100);
          vil.sympathy = clamp(vil.sympathy - (killed ? 2 : 1), 0, 100);
        }
        this.log(`A civilian was ${killed ? "killed" : "hurt"} by enemy fire${vil ? ` near ${vil.name}` : ""}.`, "casualty");
      }
    }
  }

  /**
   * The insurgency regenerates from the population — you cannot kill your way to
   * zero. Each day high-sympathy / hostile villages feed fighters, a thin
   * infiltration trickles in from the ratlines (scaled by heat), and pacified
   * (friendly) ground turns men away. CERP/KLE/restraint bend sympathy & attitude,
   * which bends this — the actual COIN lever. (cullEnemies still drains a fighter
   * per kill; the equilibrium of the two is the campaign.)
   */
  private tickInsurgency(dt: number) {
    let recruit = 0;
    let pacify = 0;
    for (const v of this.state.villages) {
      recruit += (v.sympathy / 100) * (v.attitude < 0 ? 1.0 : 0.55);
      if (v.attitude > 35) pacify += 0.35;
    }
    const infiltration = 0.4 * this.state.enemyHeat; // outside fighters via the draws
    const perDay = recruit + infiltration - pacify;
    this.state.enemyStrengthAbs = clamp(this.state.enemyStrengthAbs + (perDay * dt) / DAY, 0, 80);
  }

  private cullEnemies() {
    const gone: string[] = [];
    for (const u of this.sim.units) {
      if (u.faction !== "insurgent") continue;
      if (!u.alive) {
        gone.push(u.id);
        this.state.enemyStrengthAbs = clamp(this.state.enemyStrengthAbs - 1, 0, 100);
      } else if (u.evac) {
        gone.push(u.id);
      }
    }
    for (const id of gone) this.sim.removeUnit(id);
  }

  // ---------------------------------------------------------------- tour end
  private checkTourEnd() {
    if (this.state.ended) return;
    if (this.day > this.state.totalDays) {
      this.endTour("Relief in place complete. The tour is over — time to go home.");
    } else if (this.state.metrics.higherConfidence <= 0) {
      this.endTour("You have been relieved of command. Battalion has lost confidence in your leadership.");
    }
  }
  private endTour(reason: string) {
    this.state.ended = true;
    this.state.endReason = reason;
    this.state.tourScore = this.computeTourScore();
    this.log(reason, "objective");
  }
  computeTourScore(): number {
    const m = this.state.metrics;
    const kia = this.platoon.members.filter((x) => !x.alive).length;
    const base = m.stability * 0.3 + m.attitude * 0.25 + (100 - m.enemyStrength) * 0.2 + m.higherConfidence * 0.25;
    return Math.round(clamp(base - kia * 4, 0, 100));
  }

  // ===========================================================================
  //  Player orders
  // ===========================================================================
  formPatrol(memberIds: string[], routeCells: { cx: number; cy: number }[], missionType: MissionType, technique: MoveTechnique): Task | null {
    const ids = this.readyIds(memberIds);
    if (ids.length === 0 || routeCells.length === 0) return null;
    this.freeMembers(ids);
    const route = routeCells.map((c) => this.terrain.cellCenter(c.cx, c.cy));
    const t: Task = {
      id: Ids.task++,
      kind: "patrol",
      label: MISSION_LABEL[missionType],
      memberIds: ids,
      technique,
      missionType,
      route,
      legIndex: 0,
      phase: "assembling",
      timer: clamp(70 + ids.length * 7, 80, 300),
      startedClock: this.state.clock,
    };
    this.markAssembling(ids);
    this.state.tasks.push(t);
    this.log(`${t.label} ordered — ${ids.length} pax kitting up.`, "radio");
    return t;
  }

  conductKLE(memberIds: string[], villageId: string, technique: MoveTechnique): Task | null {
    const v = this.state.villages.find((x) => x.id === villageId);
    if (!v) return null;
    const ids = this.readyIds(memberIds);
    if (ids.length === 0) return null;
    this.freeMembers(ids);
    const t: Task = {
      id: Ids.task++,
      kind: "kle",
      label: `KLE — ${v.name}`,
      memberIds: ids,
      technique,
      route: [this.terrain.cellCenter(v.cx, v.cy)],
      villageId,
      legIndex: 0,
      phase: "assembling",
      timer: clamp(60 + ids.length * 6, 70, 240),
      startedClock: this.state.clock,
    };
    this.markAssembling(ids);
    this.state.tasks.push(t);
    this.log(`Key-leader engagement at ${v.name} ordered.`, "radio");
    return t;
  }

  startProject(villageId: string, type: string): Project | null {
    const v = this.state.villages.find((x) => x.id === villageId);
    if (!v) return null;
    if (this.state.cerp < 5000) return null;
    if (this.state.projects.some((p) => p.villageId === villageId && (p.stage === "building" || p.stage === "awaiting_materials" || p.stage === "awaiting_contractor"))) return null;
    if (v.projects.includes(type)) return null;
    this.state.cerp -= 5000;
    const p: Project = {
      id: Ids.proj++,
      villageId,
      type,
      stage: "awaiting_materials",
      progress: 0,
      materialsDelivered: false,
      contractorOnSite: false,
      etaMaterials: this.state.clock + this.rng.range(4, 10) * 3600,
      etaContractor: this.state.clock + this.rng.range(6, 18) * 3600,
      buildSeconds: this.rng.range(1.2, 2.6) * DAY,
      stalledS: 0,
    };
    this.state.projects.push(p);
    this.log(`CERP ${type} funded at ${v.name}. Materials and a contractor are inbound — it'll need security to build.`, "support");
    return p;
  }

  requestResupply(kind: "convoy" | "air"): boolean {
    if (this.state.resupplies.length > 0) return false;
    const eta = this.state.clock + (kind === "convoy" ? this.rng.range(3, 6) : this.rng.range(1, 3)) * 3600;
    this.state.resupplies.push({ id: Ids.task++, kind, eta, frac: kind === "convoy" ? 1 : 0.6 });
    this.log(`Resupply requested (${kind === "convoy" ? "ground convoy" : "air"}). ETA ~${Math.round((eta - this.state.clock) / 3600)} h.`, "support");
    return true;
  }

  recall(taskId: number) {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (t.phase !== "returning" && t.phase !== "complete") {
      t.phase = "returning";
      t.exited = true;
      for (const id of t.memberIds) {
        const m = this.sim.unit(id);
        if (m) {
          m.technique = t.technique;
          m.faceLock = null;
          m.formationHold = false;
          m.path = [];
        }
      }
      this.log(`${t.label}: recalled to ${this.state.fob.name}.`, "radio");
    }
  }

  private readyIds(memberIds: string[]): string[] {
    return memberIds.filter((id) => {
      const m = this.platoon.members.find((x) => x.id === id);
      return m && m.alive && (m.status === "ready" || m.status === "rest");
    });
  }
  private markAssembling(ids: string[]) {
    for (const id of ids) {
      const m = this.platoon.members.find((x) => x.id === id);
      if (m) m.brainState = "assembling";
    }
  }
  freeMembers(ids: string[]) {
    for (const t of this.state.tasks) t.memberIds = t.memberIds.filter((id) => !ids.includes(id));
    this.state.tasks = this.state.tasks.filter((t) => t.memberIds.length > 0 || t.phase === "assembling");
  }

  // ---------------------------------------------------------------- fire support
  requestFireMission(weaponId: string, target: Vec2, rounds: number) {
    const fm = this.sim.requestFireMission(weaponId, target, rounds);
    if (fm) {
      if (weaponId === "mortar60") this.state.supplies.mortar_60 = Math.max(0, this.state.supplies.mortar_60 - rounds);
      if (weaponId === "mortar81") this.state.supplies.mortar_81 = Math.max(0, this.state.supplies.mortar_81 - rounds);
    }
    return fm;
  }
  requestCAS(target: Vec2, kind: "cas_gun" | "cas_rocket") {
    return this.sim.requestCAS(target, kind);
  }
  medevac(unitId: string) {
    return this.sim.medevac(unitId);
  }

  // ---------------------------------------------------------------- queries
  copWorld(): Vec2 {
    return this.terrain.cellCenter(this.state.copCell.cx, this.state.copCell.cy);
  }
  /** The yard / formation area where elements muster before stepping off. */
  musterWorld(): Vec2 {
    const m = this.terrain.cop.muster;
    return this.terrain.cellCenter(m.cx, m.cy);
  }
  /** The staging point just outside the entry-control point. */
  gateOutsideWorld(): Vec2 {
    const g = this.terrain.cop.gateOutside;
    return this.terrain.cellCenter(g.cx, g.cy);
  }
  inContact(): boolean {
    for (const u of this.sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive && !u.evac) {
        if (u.visibleEnemyIds.length > 0 || u.suppression > 0.25) return true;
      }
    }
    return this.sim.projectiles.length > 0;
  }
  secondsSinceContact(): number {
    return this.state.clock - this.state.lastContactClock;
  }
  activePatrolCentroid(): Vec2 | null {
    const patrols = this.state.tasks.filter((t) => t.phase === "moving" || t.phase === "onstation" || t.phase === "returning");
    for (const t of patrols) {
      const members = t.memberIds.map((id) => this.sim.unit(id)).filter((u): u is Unit => !!u && u.alive);
      if (members.length) return centroidOf(members);
    }
    return null;
  }
  nearestVillage(p: Vec2, maxM: number): VillageState | null {
    let best: VillageState | null = null;
    let bd = maxM;
    for (const v of this.state.villages) {
      const d = dist(p, this.terrain.cellCenter(v.cx, v.cy));
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }
  hostileVillageWorld(): Vec2 | null {
    const hostile = this.state.villages.filter((v) => v.attitude < 0);
    if (!hostile.length) return null;
    const v = this.rng.pick(hostile);
    return this.terrain.cellCenter(v.cx, v.cy);
  }
  bearingDesc(p: Vec2): string {
    const c = this.copWorld();
    const dy = p.y - c.y;
    const dx = p.x - c.x;
    if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "upper" : "lower";
    return dx < 0 ? "western" : "eastern";
  }

  // ---------------------------------------------------------------- directives
  advanceDirective(kind: Directive["kind"], delta: number) {
    const d = this.state.directives.find((x) => x.kind === kind && x.status === "active");
    if (!d) return;
    d.progress = clamp01(d.progress + delta);
    if (d.progress >= 1) this.completeDirective(d);
  }
  advancePresence() {
    const d = this.state.directives.find((x) => x.kind === "presence" && x.status === "active");
    if (!d) return;
    const ever = this.state.villages.filter((v) => v.lastVisitedDay >= 0).length;
    d.progress = clamp01(ever / Math.max(1, this.state.villages.length));
    if (d.progress >= 1) this.completeDirective(d);
  }
  advanceCensus() {
    const d = this.state.directives.find((x) => x.kind === "census" && x.status === "active");
    if (!d) return;
    const done = this.state.villages.filter((v) => v.censusDone).length;
    d.progress = clamp01(done / 3);
    if (d.progress >= 1) this.completeDirective(d);
  }
  completeDirective(d: Directive) {
    if (d.status !== "active") return;
    d.status = "complete";
    d.progress = 1;
    this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence + d.reward, 0, 100);
    this.log(`Directive COMPLETE: "${d.title}". +${d.reward} higher confidence.`, "objective");
    this.interrupt(`directive complete: ${d.title}`);
  }
}
