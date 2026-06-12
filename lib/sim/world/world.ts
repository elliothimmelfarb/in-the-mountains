import { RNG, clamp, clamp01, lerp, smoothstep } from "../rng";
import { Terrain } from "../terrain";
import { Vec2, dist } from "../vec";
import { Platoon, Unit, MoveTechnique } from "../entities";
import { CombatSim, CombatInit } from "../combat";
import {
  VillageState,
  VillageAsk,
  IntelReport,
  Directive,
  DirectiveKind,
  rollWeather,
  weatherLightMult,
  attitudeToMetric,
} from "../campaign";
import { DIRECTIVE_SPECS, advanceLiveDirectives } from "./directives";
import {
  WorldState,
  Task,
  Project,
  PendingEvent,
  MissionType,
  MISSION_LABEL,
  SquadSOP,
  defaultSOP,
  sopTechnique,
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
    // Indirect fire originates at the dug-in mortar PIT (rear defilade), not the COP centroid —
    // so range/min-range/dead-space are measured from the gun, as on a real outpost.
    const pit = terrain.cop.mortarPit;
    const mortarOrigin = terrain.cellCenter(pit.cx, pit.cy);
    const mortars: NonNullable<CombatInit["mortars"]> = [];
    if (state.supplies.mortar_60 > 0)
      mortars.push({ weaponId: "mortar60", rounds: state.supplies.mortar_60, copPos: mortarOrigin });
    if (state.supplies.mortar_81 > 0)
      mortars.push({ weaponId: "mortar81", rounds: state.supplies.mortar_81, copPos: mortarOrigin });
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

  serialize() {
    const units = this.sim.units.map((u) => ({ ...u, _fireLOS: null, _fireTarget: null, _cellHold: false }));
    return {
      v: 7,
      rngState: this.rng.getState(),
      state: this.state,
      units,
      // Combat collections that outlive a single tick: buried IEDs (armed for the whole
      // patrol), in-flight fire missions (rounds already paid for), active smoke screens, the
      // sim clock and the CAS-used latch. Without these a save mid-firefight silently loses
      // armed IEDs and paid mortar rounds and re-enables a spent CAS run.
      combat: {
        timeS: this.sim.timeS,
        casUsed: this.sim.casUsed,
        ieds: this.sim.ieds,
        fireMissions: this.sim.fireMissions,
        smoke: this.sim.smoke,
      },
    };
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
    // Logistics teeth (issue 021): push battery supply (the NODs gate) and the hydration factor (a
    // dehydrated/underfed soldier recovers fatigue slower, even stationary) into the sim each tick.
    this.sim.nvgPower = this.state.supplies.batteries;
    this.sim.hydration = this.hydrationFactor();
    // People-immersion: per-village mood/reception + the grieving households, pushed for the
    // civilian brains (the sim layer can't read WorldState). Reception scales how fast a
    // villager RELAXES around armed men — presence and good standing thaw it; absence, and
    // unresolved blood debts, chill it. Derived every tick, never persisted.
    this.sim.villageMood.clear();
    this.sim.villageReception.clear();
    this.sim.grieving.clear();
    for (const v of this.state.villages) {
      this.sim.villageMood.set(v.id, clamp(v.attitude / 100, -1, 1));
      const familiarity = clamp01(1 - Math.max(0, this.day - v.lastVisitedDay) / 10);
      let unresolved = 0;
      for (const g of v.grievances ?? []) {
        if (g.resolved) continue;
        unresolved++;
        if (g.householdId) this.sim.grieving.add(g.householdId);
      }
      this.sim.villageReception.set(
        v.id,
        clamp01(0.5 + v.attitude / 250 + familiarity * 0.25 - 0.25 * Math.min(1, unresolved))
      );
    }
  }

  /** Bounded water/food supply factor (0.4..1) for recovery rates — issue 021 logistics teeth. A
   *  stocked COP is ~1; a neglected one ramps DOWN to a floor (men still recover, just slower). */
  private hydrationFactor(): number {
    const sup = this.state.supplies;
    const n = Math.max(1, this.platoon.members.filter((m) => m.alive).length);
    return (
      clamp(0.55 + 0.45 * Math.min(1, sup.water / (n * 4)), 0.55, 1) *
      clamp(0.75 + 0.25 * Math.min(1, sup.food / (n * 4)), 0.75, 1)
    );
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
    const dir = this.state.weather.windDir ?? 0; // backfill for pre-windDir saves (no NaN)
    // Superpose the prevailing (synoptic) wind and the diurnal valley flow, then clamp
    // the total to the reported wind speed so the effective wind never exceeds it.
    let x = Math.cos(dir) * 0.5 * spd;
    let y = (Math.sin(dir) * 0.5 + along) * spd;
    const mag = Math.hypot(x, y);
    if (mag > spd && mag > 1e-6) {
      const k = spd / mag;
      x *= k;
      y *= k;
    }
    return { x, y };
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
    // expire an unanswered call-for-fire, or one whose squad has finished/broken contact.
    // A COP-bound FPF request has no maneuver task, so it only expires on timeout.
    if (this.state.fireRequest) {
      const fr = this.state.fireRequest;
      if (this.state.clock > fr.expires || (!fr.copBound && !this.state.tasks.some((t) => t.id === fr.taskId))) this.state.fireRequest = null;
    }
    tickGarrison(this, dt);
    this.tickCopDefense();
    tickProjects(this, dt);
    tickResupplies(this);
    this.tickWeather();
    this.tickIntel();
    runDirector(this, dt);
    this.tickEvents();
    this.tickMetrics(dt);
    // Strategic COIN economy / pressure (dt-exact integrators): the CERP stipend, directive
    // issuance + deadline enforcement, and elder-promise lapse — run after metrics so they read
    // the fresh attitude/enemy/confidence figures.
    this.tickCerp();
    this.tickDirectives();
    this.tickPromises();

    this.sim.tick(dt);

    this.reconcileCasualties();
    this.reconcileCivilians();
    this.tickRestraint();
    this.tickInsurgency(dt);
    this.cullEnemies();

    if (this.inContact()) this.state.lastContactClock = this.state.clock;
    if (!prevContact && this.inContact()) this.interrupt("TROOPS IN CONTACT");
    if (prevNight && !this.isNight()) {
      this.interrupt("first light");
      this.tickFunerals();
    }

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
    // Logistics teeth (issue 021): low supplies bite — but as BOUNDED clamps, so a degenerate value
    // can never zero recovery (men still rest/heal, just slower). Water/food gate rest + fatigue
    // recovery (a dehydrated, underfed soldier rests poorly); medical gates wound-recovery time.
    const hydration = this.hydrationFactor();
    const medFactor = clamp(0.5 + 0.5 * Math.min(1, this.state.supplies.medical / 12), 0.5, 1);
    for (const m of this.platoon.members) {
      if (!m.alive) continue;
      if (m.status === "wounded") {
        m.daysToRecover -= (dt / DAY) * medFactor; // low medical → wounds heal slower (issue 021)
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
        m.rest = clamp01(m.rest + (2.0 / DAY) * dt * nightRest * hydration);
        m.fatigue = clamp01(m.fatigue - (3.0 / DAY) * dt * hydration); // low water/food → slower fatigue recovery (issue 021)
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
      const wounded = !!u.wounds && u.wounds.length > 0;
      const killed = !u.alive;
      if (!wounded && !killed) continue;
      // Count the casualty once at its current tier; if a wounded civ later dies of
      // wounds, escalate to the full kill backlash exactly once (the worst COIN event
      // is no longer softened just because the man passed through a wounded state).
      if (!u.casualtyCounted) {
        u.casualtyCounted = true;
        if (killed) u.casualtyKilledCounted = true;
        this.applyCivcasBacklash(u, killed, false);
      } else if (killed && !u.casualtyKilledCounted) {
        u.casualtyKilledCounted = true;
        this.applyCivcasBacklash(u, true, true); // the wound→kill delta
      }
    }
  }

  /**
   * The other side of the civilian ledger: RESTRAINT. Every time a soldier held fire
   * because a civilian was in his kill zone (the squad-combat ROE gate), the village
   * notices — a small, slow gain in attitude and cooperation. It will never offset a
   * single civcas (which is an order of magnitude larger), but disciplined patrols that
   * eat fire rather than risk the qalat are how you actually buy the valley's trust.
   */
  private tickRestraint() {
    const evs = this.sim.restraintEvents;
    if (evs.length === 0) return;
    for (const pos of evs) {
      const vil = this.nearestVillage(pos, 500);
      if (!vil) continue;
      vil.attitude = clamp(vil.attitude + 0.015, -100, 100);
      vil.cooperation = clamp(vil.cooperation + 0.02, 0, 100);
      vil.sympathy = clamp(vil.sympathy - 0.01, 0, 100);
    }
    if (this.rng.chance(0.01 * evs.length)) {
      const vil = this.nearestVillage(evs[0], 500);
      if (vil) this.log(`A patrol held its fire with locals in the open near ${vil.name}. Word travels.`, "info");
    }
    this.sim.restraintEvents = [];
  }

  /** Apply a CIVCAS to the strategic state: `killed` selects the magnitude, and
   *  `delta` applies only the wound→kill escalation (a wounded civ that has died). */
  private applyCivcasBacklash(u: Unit, killed: boolean, delta: boolean) {
    const by = u.casualtyByFaction;
    const vil = this.nearestVillage(u.pos, 700);
    if (by === "us" || by === "ana") {
      // THE LEDGER GETS A NAME (people-immersion): he is not an attitude penalty — he
      // is a man with a household, and the village remembers him by name until solatia
      // settles the debt. Keyed on HIS village (the funeral happens at HIS home), with
      // the nearest village as the roadside fallback; a wound that later kills updates
      // the same entry (never two debts for one body).
      const gvil = (u.villageId && this.state.villages.find((x) => x.id === u.villageId)) || vil;
      if (gvil) {
        const ledger = (gvil.grievances ??= []);
        const prior = ledger.find((g) => g.unitId === u.id);
        if (prior) prior.killed = prior.killed || killed;
        else ledger.push({ unitId: u.id, name: u.name, householdId: u.householdId, day: this.day, killed, resolved: false });
        this.log(`${u.name} of ${gvil.name} was ${killed ? "killed" : "wounded"} by our fire. His household will remember.`, "casualty");
      }
      const att = delta ? 8 : killed ? 14 : 6;
      const symp = delta ? 6 : killed ? 11 : 5;
      const coop = delta ? 5 : killed ? 8 : 3;
      const str = delta ? 1.5 : killed ? 2 : 0.5;
      const conf = delta ? 2 : killed ? 3 : 1;
      if (vil) {
        vil.attitude = clamp(vil.attitude - att, -100, 100);
        vil.sympathy = clamp(vil.sympathy + symp, 0, 100);
        vil.cooperation = clamp(vil.cooperation - coop, 0, 100);
      }
      this.state.enemyStrengthAbs = clamp(this.state.enemyStrengthAbs + str, 0, 80); // mobilization (cap matches tickInsurgency)
      this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence - conf, 0, 100);
      // The strategic civcas ledger (drives the tour score's heaviest penalty). Count a fresh
      // casualty only — never the wound→kill escalation delta, which is the same body twice.
      if (!delta) this.state.civCasualties++;
      // A civilian casualty FAILS an active "protect the population" directive immediately.
      const cd = this.state.directives.find((x) => x.kind === "casualty" && x.status === "active");
      if (cd) {
        cd.status = "failed";
        this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence - cd.penalty, 0, 100);
        this.log(`Directive FAILED: "${cd.title}" — a civilian casualty. −${cd.penalty} higher confidence.`, "casualty");
        this.interrupt(`directive FAILED: ${cd.title}`);
      }
      this.log(
        delta
          ? `A wounded civilian${vil ? ` near ${vil.name}` : ""} has died of wounds attributed to our fires.`
          : `CIVCAS — a civilian was ${killed ? "killed" : "wounded"}${vil ? ` near ${vil.name}` : ""}, attributed to our fires. The valley will not forget.`,
        "casualty"
      );
      this.interrupt("CIVCAS incident");
    } else if (by === "insurgent") {
      if (vil) {
        vil.attitude = clamp(vil.attitude + (delta ? 2 : killed ? 3 : 1), -100, 100);
        vil.sympathy = clamp(vil.sympathy - (delta ? 1 : killed ? 2 : 1), 0, 100);
      }
      if (!delta) this.log(`A civilian was ${killed ? "killed" : "hurt"} by enemy fire${vil ? ` near ${vil.name}` : ""}.`, "casualty");
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
      // Unresolved named grievances FLOOR the village's effective sympathy — badal
      // recruits even where general sympathy was low. Capped at 36 so the ledger can
      // hurt but never dominate; paying solatia lifts the floor entry by entry.
      const unresolved = (v.grievances ?? []).reduce((a, g) => a + (g.resolved ? 0 : 1), 0);
      const sympEff = Math.max(v.sympathy, Math.min(36, 12 * unresolved));
      recruit += (sympEff / 100) * (v.attitude < 0 ? 1.0 : 0.55);
      if (v.attitude > 35) pacify += 0.35;
    }
    const infiltration = 0.4 * this.state.enemyHeat; // outside fighters via the draws
    const perDay = recruit + infiltration - pacify;
    this.state.enemyStrengthAbs = clamp(this.state.enemyStrengthAbs + (perDay * dt) / DAY, 0, 80);
  }

  /** The morning after (people-immersion): the village buries its dead at first light
   *  — within a day, at dawn, as practice demands. The household gathers with the
   *  elder at the family compound and stands for twenty minutes. Weight, not
   *  spectacle: one log line, a knot of still figures, and a player who watches
   *  learns which compound — and which faces — his fire cost him. */
  private tickFunerals() {
    for (const v of this.state.villages) {
      for (const g of v.grievances ?? []) {
        if (!g.killed || g.mourned || this.day <= g.day) continue;
        g.mourned = true;
        const vt = this.terrain.villages.find((x) => x.id === v.id);
        if (!vt) continue;
        const c = this.terrain.cellCenter(vt.cx, vt.cy);
        const r = this.terrain.reachablePoint(c.x, c.y);
        const at = this.terrain.civSafePoint(r.x, r.y);
        let n = 0;
        for (const u of this.sim.units) {
          if (u.faction !== "civilian" || !u.alive || !u.conscious) continue;
          const kin = (g.householdId && u.householdId === g.householdId) || u.id === v.elderUnitId;
          if (!kin) continue;
          u.summons = { x: at.x + ((n % 3) - 1) * 2, y: at.y + Math.floor(n / 3) * 2, untilS: this.sim.timeS + 1200 };
          u.summonsAborted = false;
          n++;
        }
        if (n > 0) this.log(`First light over ${v.name}: they bury ${g.name}.`, "info");
      }
    }
  }

  /** The village's elder as a LIVING AGENT. Repairs the binding when the bound elder
   *  is dead or missing: the village quietly puts forward another man (deterministic —
   *  first adult villager by id), and the succession is loggable, visible truth: kill
   *  a village's elder and a new face speaks for it at the next shura. */
  ensureElder(v: VillageState): Unit | null {
    const bound = v.elderUnitId ? this.sim.unit(v.elderUnitId) : undefined;
    if (bound && bound.alive && bound.conscious) return bound;
    const next =
      this.sim.units
        .filter((u) => u.faction === "civilian" && u.alive && u.conscious && u.villageId === v.id && u.role !== "child")
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
    if (next) {
      const succession = !!v.elderUnitId && v.elderUnitId !== next.id;
      next.role = "elder";
      v.elderUnitId = next.id;
      v.elder = next.name;
      if (succession) this.log(`${next.name} now speaks for ${v.name}.`, "info");
    }
    return next;
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
  /** Relief-of-command is a SUSTAINED-failure trigger, not a single bad day. Battalion relieves a
   *  commander over a TREND (a formal performance review), not one catastrophic firefight — and a
   *  coarse strategic step can over-march a patrol into a one-tick spike of casualties that the next
   *  day's stipend / completed directive / rising attitude recovers from. So confidence falling to
   *  the critical floor opens a REVIEW WATCH; relief fires only if it stays under continuously for
   *  the review window. Any recovery above the floor clears the watch. (FM 6-22: relief follows a
   *  documented pattern of lost trust, not an isolated event.) */
  private static readonly RELIEF_FLOOR = 5; // confidence at/under this opens the review watch
  private static readonly RELIEF_WINDOW = 3 * DAY; // must stay under continuously this long to relieve
  private checkTourEnd() {
    if (this.state.ended) return;
    if (this.day > this.state.totalDays) {
      this.endTour("Relief in place complete. The tour is over — time to go home.");
      return;
    }
    const conf = this.state.metrics.higherConfidence;
    if (conf <= World.RELIEF_FLOOR) {
      if (this.state.reliefWatchClock < 0) {
        this.state.reliefWatchClock = this.state.clock; // open the watch on first dip
        this.log("Battalion signals it is reviewing your command. Turn this around.", "casualty");
        this.interrupt("Battalion is reviewing your command");
      } else if (this.state.clock - this.state.reliefWatchClock >= World.RELIEF_WINDOW) {
        this.endTour("You have been relieved of command. Battalion has lost confidence in your leadership.");
      }
    } else if (this.state.reliefWatchClock >= 0) {
      this.state.reliefWatchClock = -1; // confidence recovered — review closed
    }
  }
  private endTour(reason: string) {
    this.state.ended = true;
    this.state.endReason = reason;
    this.state.tourScore = this.computeTourScore();
    this.log(reason, "objective");
  }
  /**
   * The end-of-tour score — and the COIN bar. "You can win every firefight and still lose the
   * valley," so enemy attrition is a SMALL term; the village heart (attitude), stability and
   * Higher's confidence dominate, with delivered projects / directives / kept promises as direct
   * rewards and civcas / broken promises / failed directives / KIA as heavy penalties. Body-count
   * play drives attrition (a weak lever here) while tanking attitude, civcas and confidence — so
   * careful COIN scores far higher. (Weights tuned empirically in scripts/campaign-loop.ts.)
   */
  computeTourScore(): number {
    const m = this.state.metrics;
    const kia = this.platoon.members.filter((x) => !x.alive).length;
    const projComplete = this.state.projects.filter((p) => p.stage === "complete").length;
    const dirComplete = this.state.directives.filter((d) => d.status === "complete").length;
    const dirFailed = this.state.directives.filter((d) => d.status === "failed").length;
    const kept = this.state.villages.reduce((a, v) => a + (v.keptPromises ?? 0), 0);
    const broken = this.state.villages.reduce((a, v) => a + (v.brokenPromises ?? 0), 0);
    const civcas = this.state.civCasualties ?? 0;
    // The valley's heart, measured DIRECTLY from raw village attitude (−100..100), not only the
    // compressed m.attitude = (avg+100)/2 metric that halves the signal. "You can win every firefight
    // and still lose the valley": a tour that wins the villages over (mean attitude rising toward/past
    // 0) must out-score one that leaves them hostile, even at equal kill counts. This direct term gives
    // the village swing real range around the operating point — the single biggest COIN lever (FM 3-24).
    const meanVillageAtt = this.state.villages.length
      ? this.state.villages.reduce((a, v) => a + v.attitude, 0) / this.state.villages.length
      : 0;
    const wonOver = this.state.villages.filter((v) => v.attitude > 0).length;
    const base =
      m.attitude * 0.20 + // the compressed metric still carries weight…
      meanVillageAtt * 0.30 + // …but the RAW village swing is the dominant lever
      m.stability * 0.20 +
      m.higherConfidence * 0.26 +
      (100 - m.enemyStrength) * 0.06; // attrition matters LITTLE on its own
    // Delivered COIN is the heart of the score: a completed CERP project (a clinic, a school, a
    // micro-hydro the population uses daily) and a village won over to our side are the central acts
    // of counterinsurgency (FM 3-24) — they must out-weigh the kill count decisively. A careful tour
    // that builds 2–3 projects and turns villages positive earns ~25–35 points HERE that a body-count
    // tour (0 projects, villages left hostile) cannot, which is what makes "COIN is the real game"
    // true in the score, not just the fiction.
    const coin = projComplete * 11 + dirComplete * 4 + kept * 3 + wonOver * 3;
    // KIA is NOT double-counted: every KIA already docks higherConfidence by 3 (reconcileCasualties),
    // which the higherConfidence base weight carries, and a catastrophic loss ends the tour outright (relief of
    // command). The direct term is therefore light — a per-man acknowledgement of permanent loss, not
    // a second full combat penalty — so a tour that did real COIN work isn't zeroed by attrition the
    // confidence term already reflects. (Civcas stays the heaviest line — a strategic defeat.)
    const penalties = kia * 1.5 + civcas * 8 + broken * 5 + dirFailed * 4;
    return Math.round(clamp(base + coin - penalties, 0, 100));
  }

  // ===========================================================================
  //  Player orders
  // ===========================================================================
  formPatrol(memberIds: string[], routeCells: { cx: number; cy: number }[], missionType: MissionType, technique: MoveTechnique, sop?: SquadSOP): Task | null {
    const ids = this.readyIds(memberIds);
    if (ids.length === 0 || routeCells.length === 0) return null;
    this.freeMembers(ids);
    const route = routeCells.map((c) => this.terrain.cellCenter(c.cx, c.cy));
    // The SOP is the squad's standing order. If the caller gave one it is authoritative
    // (and the movement technique follows from it); otherwise default it from the mission.
    const finalSop = sop ?? defaultSOP(missionType);
    const t: Task = {
      id: Ids.task++,
      kind: "patrol",
      label: MISSION_LABEL[missionType],
      memberIds: ids,
      technique: sop ? sopTechnique(sop.movement) : technique,
      sop: finalSop,
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

  conductKLE(memberIds: string[], villageId: string, technique: MoveTechnique, sop?: SquadSOP): Task | null {
    const v = this.state.villages.find((x) => x.id === villageId);
    if (!v) return null;
    const ids = this.readyIds(memberIds);
    if (ids.length === 0) return null;
    this.freeMembers(ids);
    // A KLE goes in with a friendly posture by default — weapons tight, no aggression.
    const finalSop: SquadSOP = sop ?? { movement: "patrol", contact: "hold", roe: "tight" };
    const t: Task = {
      id: Ids.task++,
      kind: "kle",
      label: `KLE — ${v.name}`,
      memberIds: ids,
      technique: sop ? sopTechnique(sop.movement) : technique,
      sop: finalSop,
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

  /**
   * Assign an element to SECURE a CERP project site: route there using the normal patrol
   * machinery (reachability-aware, no beeline), then hold an all-round overwatch on the village
   * so the build crew can work. This is the player+harness-drivable answer to "garrison this
   * build" — tickProjects' security gate counts a held secure element. The hold is open-ended (no
   * dwell timer): the element stays until recalled or the project completes/sabotages.
   */
  secureBuild(memberIds: string[], villageId: string, technique: MoveTechnique, sop?: SquadSOP): Task | null {
    const v = this.state.villages.find((x) => x.id === villageId);
    if (!v) return null;
    const ids = this.readyIds(memberIds);
    if (ids.length === 0) return null;
    this.freeMembers(ids);
    const finalSop: SquadSOP = sop ?? { movement: "patrol", contact: "hold", roe: "tight" };
    const proj = this.state.projects.find(
      (p) => p.villageId === villageId && p.stage !== "complete" && p.stage !== "sabotaged"
    );
    const t: Task = {
      id: Ids.task++,
      kind: "secure",
      label: `Secure — ${v.name}`,
      memberIds: ids,
      technique: sop ? sopTechnique(sop.movement) : technique,
      sop: finalSop,
      route: [this.terrain.cellCenter(v.cx, v.cy)],
      secureVillageId: villageId,
      projectId: proj?.id,
      missionType: "cordon", // reuse cordon move/posture defaults (tight, hold); the on-station hold ignores the dwell timer
      legIndex: 0,
      phase: "assembling",
      timer: clamp(60 + ids.length * 6, 70, 240),
      startedClock: this.state.clock,
    };
    this.markAssembling(ids);
    this.state.tasks.push(t);
    this.log(`Element ordered to secure the ${proj?.type ?? "project"} site at ${v.name}.`, "radio");
    return t;
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

  /**
   * Re-route an in-progress squad to a fresh waypoint chain (the same grease-pencil
   * gesture as the initial route). The leader re-paths from where he stands. If the
   * squad is in contact the new route is simply walked once the fight lulls. Returns
   * false if the task is gone/finished or the route is empty.
   */
  reroute(taskId: number, routeCells: { cx: number; cy: number }[]): boolean {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (!t || t.phase === "complete" || routeCells.length === 0) return false;
    t.route = routeCells.map((c) => this.terrain.cellCenter(c.cx, c.cy));
    t.legIndex = 0;
    t.goalDist = undefined;
    t.noProgressS = 0;
    const members = t.memberIds.map((id) => this.sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
    const inContact = (t.contactHold ?? 0) > 0 || members.some((m) => m.suppression > 0.3 || this.seesThreat(m));
    // Heading them out toward the new chain. If the squad is in contact we leave the combat
    // brains alone — the new waypoints are walked once the fight lulls (releaseCombat re-forms);
    // stomping paths/brainState mid-firefight would break the drill the coordinator is running.
    if (t.phase === "onstation" || t.phase === "returning") t.phase = "moving";
    if (!inContact) {
      for (const m of members) {
        m.faceLock = null;
        m.formationHold = false;
        m.paceScale = 1;
        m.path = [];
        if (m.brainState !== "garrison") m.brainState = "moving";
      }
    }
    this.log(`${t.label}: re-routing — new waypoints passed to the squad leader.`, "radio");
    return true;
  }

  /**
   * Edit a squad's standing SOP (movement / on-contact drill / ROE). LOCKED while the
   * squad is in contact — under "The Watch" you set the squad's orders before the fight
   * and live with them; you cannot reach into a firefight. Returns false if locked/absent.
   */
  setSOP(taskId: number, sop: SquadSOP): boolean {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (!t) return false;
    const members = t.memberIds.map((id) => this.sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
    // Locked through the whole sticky-contact window, not just the instant of raw contact —
    // otherwise the SOP could be edited in the lulls between bursts of the same firefight.
    const inContact = (t.contactHold ?? 0) > 0 || !!t.squadState || members.some((m) => m.suppression > 0.3 || this.seesThreat(m));
    if (inContact) return false;
    t.sop = sop;
    t.technique = sopTechnique(sop.movement);
    for (const m of members) {
      m.technique = t.technique;
      m.roe = sop.roe;
    }
    return true;
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

  // ---------------------------------------------------------------- AI calls for fire
  /** The squad-combat AI raises a call-for-fire; the commander (player) approves/denies.
   *  Throttled to one pending request, with a cooldown between requests. */
  requestSquadFires(t: Task, weaponId: string, cx: number, cy: number, reason: string) {
    if (this.state.fireRequest) return;
    if (this.state.clock < (this.state.lastFireReqClock ?? -1e9) + 45) return; // cooldown
    const lead = t.memberIds.map((id) => this.sim.unit(id)).find((u) => !!u && u.alive);
    this.state.fireRequest = {
      squadId: lead?.squadId ?? t.memberIds[0] ?? "",
      taskId: t.id,
      label: t.label,
      weaponId,
      cx,
      cy,
      reason,
      expires: this.state.clock + 35,
    };
    this.state.lastFireReqClock = this.state.clock;
    this.log(`${t.label}: ${reason} — call for fire pending your approval.`, "support");
    this.interrupt(`${t.label} requests fire support`);
  }
  /** Commander approves the pending call-for-fire (optionally adjusting the aimpoint). */
  approveFireRequest(override?: Vec2): boolean {
    const r = this.state.fireRequest;
    if (!r) return false;
    const target = override ?? this.terrain.cellCenter(r.cx, r.cy);
    if (r.weaponId === "cas_gun" || r.weaponId === "cas_rocket") this.requestCAS(target, r.weaponId as "cas_gun" | "cas_rocket");
    else this.requestFireMission(r.weaponId, target, 4);
    this.state.fireRequest = null;
    return true;
  }
  denyFireRequest() {
    if (this.state.fireRequest) this.log(`${this.state.fireRequest.label}: call for fire denied.`, "support");
    this.state.fireRequest = null;
  }

  /** The COP's own call-for-fire (FPF) — no maneuver task, routed through the same
   *  one-pending + cooldown + approve/deny loop as a squad's. */
  private requestCopFires(weaponId: string, cx: number, cy: number, reason: string) {
    if (this.state.fireRequest) return;
    if (this.state.clock < (this.state.lastFireReqClock ?? -1e9) + 45) return; // cooldown
    this.state.fireRequest = {
      squadId: "cop",
      taskId: -1,
      label: "COP / Wire",
      weaponId,
      cx,
      cy,
      reason,
      expires: this.state.clock + 35,
      copBound: true,
    };
    this.state.lastFireReqClock = this.state.clock;
    this.log(`COP / Wire: ${reason} — call for fire pending your approval.`, "support");
    this.interrupt("COP requests final protective fire");
  }

  /**
   * THE WATCH — fulfils the design pillar at the COP itself ("the hardest part of command
   * is watching"). When the outpost is under assault — fighters massing at the wire while
   * the garrison stands to — the TOC raises a Final Protective Fire request the player must
   * APPROVE or DENY (the store auto-pauses on a pending request). The FPF lands on the
   * assault as it forms, just outside the wire. It reuses the squad fire-request loop
   * verbatim (one pending, 45 s cooldown, human clears the fire — never auto-fires), so it
   * respects the 100%-AI-but-the-commander-approves-fires ROE. Deterministic: reads only
   * sim state, no rng, no wall clock.
   */
  private tickCopDefense() {
    const cop = this.terrain.cop;
    if (!cop) return;
    if (this.state.fireRequest) return; // a squad (or the COP) already has one pending
    if (this.state.clock < (this.state.lastFireReqClock ?? -1e9) + 45) return; // cooldown
    if ((this.state.supplies.mortar_60 ?? 0) <= 0) return; // no rounds, no FPF
    const center = this.copWorld();
    const wireM = cop.radius * this.terrain.cellSize;
    // Fighters massing at the wire = an assault (not a lone sniper at distance).
    // Don't hijack the fire-support slot from a forward squad: if a tasked element is in contact,
    // it owns the call-for-fire — the COP FPF is for when the OUTPOST ITSELF is the target.
    if (this.inContact() && this.state.tasks.some((t) => !!t.squadState || (t.contactHold ?? 0) > 0)) return;
    const assault: Vec2[] = [];
    for (const e of this.sim.livingEnemies()) {
      const d = dist(e.pos, center);
      if (d > wireM - 10 && d < wireM + 120) assault.push(e.pos);
    }
    if (assault.length < 3) return;
    // The garrison must actually be IN CONTACT at the wire (else this is a patrol's fight nearby,
    // not an assault on the outpost — and firing would waste rounds + starve the patrol's support).
    const defendersEngaged = this.platoon.members.filter(
      (m) =>
        m.alive && !m.evac && m.status !== "wounded" && dist(m.pos, center) < wireM + 35 &&
        (m.visibleEnemyIds.length > 0 || (m.suppression ?? 0) > 0.2)
    ).length;
    if (defendersEngaged < 2) return;
    // FPF aimpoint: the assault's centroid, pushed onto the wire line on its bearing.
    let ax = 0, ay = 0;
    for (const p of assault) { ax += p.x; ay += p.y; }
    ax /= assault.length;
    ay /= assault.length;
    const br = Math.atan2(ay - center.y, ax - center.x);
    const fdist = Math.max(wireM + 22, Math.min(dist({ x: ax, y: ay }, center), wireM + 110));
    const aim = { x: center.x + Math.cos(br) * fdist, y: center.y + Math.sin(br) * fdist };
    // The mortar fires from the PIT, which has a ~70 m minimum range (weapons.ts mortar60). If the
    // assault has closed inside that dead zone, push the aimpoint outward FROM THE PIT so the
    // approved fire actually lands instead of silently failing the range check (combat.ts).
    const pit = this.terrain.cellCenter(cop.mortarPit.cx, cop.mortarPit.cy);
    const MIN_R = 75; // 70 m min range + margin
    if (dist(pit, aim) < MIN_R) {
      const pb = Math.atan2(aim.y - pit.y, aim.x - pit.x);
      aim.x = pit.x + Math.cos(pb) * MIN_R;
      aim.y = pit.y + Math.sin(pb) * MIN_R;
    }
    const cx = Math.floor(aim.x / this.terrain.cellSize);
    const cy = Math.floor(aim.y / this.terrain.cellSize);
    this.requestCopFires("mortar60", cx, cy, `${assault.length} fighters in the wire — FPF, danger close`);
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
        if (u.suppression > 0.25 || this.seesThreat(u)) return true;
      }
    }
    // Rounds in the air hold contact only when they are the ENEMY's — our own parting
    // shots chasing a fleeing runner must not pin the campaign clock (issue 025).
    // p.faction, not a unit() lookup: the shooter may have been culled with rounds in flight.
    return this.sim.projectiles.some((p) => p.faction === "insurgent");
  }
  /** Does this man currently see an enemy who still counts as a FIGHT (issue 025)?
   *  Visibility alone is spotting; CombatSim.threatening decides whether the sighting
   *  holds contact. Shared by the global TIC latch and every squad-level latch. */
  seesThreat(u: Unit): boolean {
    for (const id of u.visibleEnemyIds) {
      const e = this.sim.unit(id);
      if (e && e.alive && !e.evac && this.sim.threatening(e, u.pos)) return true;
    }
    return false;
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

  // ---------------------------------------------------------------- CERP economy
  /** Battalion disburses a CERP stipend on a steady cadence (the managed-budget income side),
   *  scaled mildly by higher confidence — a commander Higher trusts gets more discretionary funds. */
  private tickCerp() {
    if (this.state.clock < this.state.nextCerpStipendAt) return;
    this.state.nextCerpStipendAt = this.state.clock + this.rng.range(6, 8) * DAY;
    const conf = this.state.metrics.higherConfidence;
    const stipend = Math.round(5000 + conf * 60); // 5k..11k per ~week
    this.state.cerp += stipend;
    this.log(`Battalion disburses $${stipend.toLocaleString()} in CERP funds.`, "support");
    this.interrupt("CERP stipend received");
  }

  // ---------------------------------------------------------------- directive lifecycle
  /** Directives are real: a steady issuance cadence AND deadline enforcement. A directive whose
   *  deadline elapses while still active FAILS — applying its penalty to higherConfidence, so
   *  neglect costs the player Higher's trust (the design-promised pressure from Higher). */
  private tickDirectives() {
    // advance the live progress of the metric-driven kinds every tick (cheap)
    this.advancePresence();
    this.advanceCensus();
    advanceLiveDirectives(this); // interdict / hold / casualty
    // (kle / construct are advanced by their producers — onStationEffects / tickProjects)

    // enforce deadlines
    for (const d of this.state.directives) {
      if (d.status !== "active") continue;
      if (this.day > d.deadlineDay) {
        d.status = "failed";
        this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence - d.penalty, 0, 100);
        this.log(`Directive FAILED: "${d.title}". Battalion is not pleased. −${d.penalty} higher confidence.`, "casualty");
        this.interrupt(`directive FAILED: ${d.title}`);
      }
    }

    // issuance cadence (~1 / 6–9 days), drawn from the AO state
    if (this.state.clock >= this.state.nextDirectiveAt) {
      this.state.nextDirectiveAt = this.state.clock + this.rng.range(6, 9) * DAY;
      this.issueDirective();
    }
  }

  /** Issue a fresh directive drawn from the current AO: enemy high → interdict; hostile village →
   *  hold; cash on hand → construct; always rotate census/presence/kle/casualty. Skips kinds
   *  already active so the player never has duplicate taskings of the same type. */
  private issueDirective() {
    const active = new Set(this.state.directives.filter((d) => d.status === "active").map((d) => d.kind));
    const pool: DirectiveKind[] = [];
    if (this.state.enemyStrengthAbs > 30 && !active.has("interdict")) pool.push("interdict");
    if (this.state.villages.some((v) => !v.censusDone) && !active.has("census")) pool.push("census");
    if (this.state.villages.some((v) => v.attitude < 0) && !active.has("hold")) pool.push("hold");
    if (this.state.cerp >= 5000 && !active.has("construct")) pool.push("construct");
    if (!active.has("kle")) pool.push("kle");
    if (!active.has("presence")) pool.push("presence");
    if (!active.has("casualty")) pool.push("casualty");
    if (pool.length === 0) return;
    const kind = this.rng.pick(pool);
    const day = this.day;
    const spec = DIRECTIVE_SPECS[kind](this);
    this.state.directives.push({
      id: Ids.dir++,
      kind,
      title: spec.title,
      desc: spec.desc,
      reward: spec.reward,
      penalty: spec.penalty,
      issuedDay: day,
      deadlineDay: day + spec.days,
      status: "active",
      progress: 0,
      startMetric: kind === "interdict" ? this.state.enemyStrengthAbs : undefined,
    });
    this.log(`New directive from Battalion: "${spec.title}" (by D${day + spec.days}).`, "objective");
    this.interrupt(`new directive: ${spec.title}`);
  }

  // ---------------------------------------------------------------- KLE asks / promises
  /** A shura yields an elder ASK — a concrete request the player can fulfill (or break). The
   *  follow-through (or a lapsed deadline) swings attitude up or DOWN: the broken-promises mechanic. */
  raiseElderAsk(v: VillageState) {
    if (v.ask) return;
    const kinds: VillageAsk["kind"][] = ["project", "security", "restraint", "prisoner"];
    const kind = this.rng.pick(kinds);
    const day = this.day;
    const deadlineDay = day + this.rng.int(5, 10);
    let desc = "";
    let projectType: string | undefined;
    if (kind === "project") {
      projectType = v.wants;
      desc = `${v.elder} asks you to build a ${projectType}.`;
    } else if (kind === "security") {
      desc = `${v.elder} asks for a security presence to keep the fighters out.`;
    } else if (kind === "restraint") {
      desc = `${v.elder} asks that patrols stop kicking in doors in his village.`;
    } else {
      desc = `${v.elder} asks you to release a detained kinsman.`;
    }
    v.ask = { kind, desc, projectType, issuedDay: day, deadlineDay, fulfilled: false };
    this.log(`At the shura, ${desc}`, "radio");
    this.interrupt(`${v.name}: elder makes a request`);
  }

  /** Mark a village's outstanding ask fulfilled — a kept promise (attitude up, cooperation up). */
  fulfillAsk(v: VillageState, reason: string) {
    if (!v.ask || v.ask.fulfilled) return;
    v.ask.fulfilled = true;
    v.keptPromises++;
    v.attitude = clamp(v.attitude + 10, -100, 100);
    v.cooperation = clamp(v.cooperation + 8, 0, 100);
    v.sympathy = clamp(v.sympathy - 5, 0, 100);
    this.state.metrics.higherConfidence = clamp(this.state.metrics.higherConfidence + 1, 0, 100);
    this.log(`Promise kept at ${v.name}: ${reason}. The elder will remember it.`, "objective");
    v.ask = null;
  }

  /** Lapsed-promise enforcement: an unfulfilled ask past its deadline is a BROKEN promise —
   *  attitude down (more than a kept one helps), sympathy up. Neglect bites. */
  private tickPromises() {
    for (const v of this.state.villages) {
      if (v.ask && !v.ask.fulfilled && this.day > v.ask.deadlineDay) {
        v.brokenPromises++;
        v.attitude = clamp(v.attitude - 12, -100, 100); // broken hurts MORE than kept helps
        v.sympathy = clamp(v.sympathy + 8, 0, 100);
        v.cooperation = clamp(v.cooperation - 6, 0, 100);
        this.log(`Promise BROKEN at ${v.name}: ${v.ask.desc} The elder feels betrayed.`, "casualty");
        this.interrupt(`${v.name}: broken promise`);
        v.ask = null;
      }
    }
  }
}
