/**
 * encounter-probe — verification probe for the people-immersion "village wave":
 * the staged shura (the elder physically walks out and sits down before the KLE decides
 * anything), the named blood-debt ledger + first-light funeral, and attitude-keyed
 * children trailing a friendly patrol. Subjects under test: lib/sim/ai/civilian.ts
 * (SUMMONS branch, abort latch, kids-trailing, grieving clear-road), lib/sim/world/tasks.ts
 * (enterOnStation elder summons, onStationEffects elderMet gate / regret line),
 * lib/sim/world/world.ts (applyCivcasBacklash named grievance, tickFunerals, ensureElder),
 * lib/sim/world/create.ts (bound elder, households, loadWorld v8 defaults).
 *
 * MODE shura <seed>
 *   Dispatches a KLE to the village nearest the COP (director + world events suppressed so
 *   the scene is clean), ticks world.tick(0.1) and reads w.state.log / drainInterrupts.
 *   Columns: t_station (KLE on-station clock) · t_summon ("the elders are coming out", must
 *   land ON the on-station tick) · t_depart (the bound elder unit closes >2 m on his summons
 *   meet point, OR his movement order — pathGoal — flips to it, OR he was summoned already
 *   inside arrival range; <=300 s after on-station) · t_met (the "sits down" log <=1200 s, OR
 *   the honest "sends his regrets" path — reported as which, with min elder->meet and
 *   elder->SL distances so a regret is explainable) · gate_held (NO dwell event and
 *   NO elder ask while t.elderMet === false) · det (two same-seed runs, elder position
 *   fingerprint every 10 game-s — identical).
 *   ABORT VARIANT (fresh world, same seed): once the elder is en route, a staged ambush cell
 *   (leaderless: brainState "ambush", rof hold, iedInit, NO squadId) spawns ~95 m from him.
 *   Asserts the summons aborts LATCHED (summonsAborted true, summons cleared), he turns for
 *   home, and the KLE proceeds via the regret line.
 *
 * MODE funeral <seed>
 *   Kills a householded civilian — from the nearest village offering a >=2 kin pool (a tiny
 *   village of 2-person households with the elder inside one cannot express a gathering at
 *   all; skips are reported) — by direct manipulation, faithfully to reconcileCivilians
 *   (alive=false, hp=0, conscious=false, casualtyByFaction="us").
 *   Asserts: a NAMED grievance lands on his village ledger; the casualty log carries his name;
 *   at the NEXT first-light edge >=2 kin (householdId / elder) are summoned to the gather point
 *   (village center -> reachablePoint -> civSafePoint, the same snap tickFunerals uses) and
 *   >=2 arrive within 15 m inside the 20-min window; the "they bury <name>" log fires.
 *   SAVE ROUND-TRIP mid-gathering: serialize -> JSON round-trip -> loadWorld; the ledger
 *   survives (named, mourned) and the summoned units still carry their summons (resumes).
 *
 * MODE kids <seed>
 *   Picks the nearest village with a CURIOUS child (the trailing precondition) as the friendly
 *   (+40) and the nearest other village with a child as the hostile (-40) — a village with no
 *   children cannot express either signal — then runs identical presence patrols
 *   (SOP patrol/hold/tight) on an out-and-back sweep [village, +125 m beyond, village,
 *   midpoint-home], sequentially. (The sweep matters: a trailing kid paces a marching squad
 *   but can't CLOSE a pickup gap — the patrol turning back through its own tail is what
 *   realizes the <=12 m windows while genuinely moving.) trail = game-minutes of the patrol's
 *   MOVING phase with >=1 of that village's children within 12 m of any member.
 *   Asserts trail(+40) > 0 AND >= 3*trail(-40), and the hostile village's child-near-patrol
 *   minutes < 0.5 (the absence IS the read). Per-kid min-distance/pickup diagnostics printed.
 *
 * Exit 1 on any gate failure. Deterministic: seeded RNG only, no Date/Math.random.
 * Run: npx tsx scripts/encounter-probe.ts all survey-12
 *      npx tsx scripts/encounter-probe.ts shura survey-12
 *      npx tsx scripts/encounter-probe.ts funeral survey-12
 *      npx tsx scripts/encounter-probe.ts kids survey-12
 */
import { createWorld, loadWorld, World, RNG } from "../lib/sim/world";
import { makeInsurgent } from "../lib/sim/entities";
import type { Unit } from "../lib/sim/entities";
import type { VillageState } from "../lib/sim/campaign";

type Vec = { x: number; y: number };
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

let FAILS = 0;
function gate(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) FAILS++;
  return ok;
}
function note(msg: string) {
  console.log(`        ${msg}`);
}

/** Isolate the subject: no director spawns, no gate world-events (the dwell/summons machinery
 *  under test still runs; rollDwellEvent is part of the subject and stays live). */
function quiet(w: World) {
  w.state.enemyHeat = 0;
  w.state.nextActivityAt = 1e12;
  w.state.nextEventAt = 1e12;
}

function nearestVillages(w: World): VillageState[] {
  const cop = w.copWorld();
  return [...w.state.villages].sort(
    (a, b) => dist(w.terrain.cellCenter(a.cx, a.cy), cop) - dist(w.terrain.cellCenter(b.cx, b.cy), cop)
  );
}

/** Incremental log reader keyed on the monotonically-increasing entry id (robust to the
 *  600-entry cap splicing old entries off the front). */
function logScanner(w: World) {
  let last = w.state.log.length ? w.state.log[w.state.log.length - 1].id : -1;
  return () => {
    const fresh = w.state.log.filter((l) => l.id > last);
    if (fresh.length) last = fresh[fresh.length - 1].id;
    return fresh;
  };
}

/** The funeral gather point / civilian "home" — the SAME triple snap tickFunerals and the
 *  civilian brain use (village center -> reachablePoint -> civSafePoint), so the arrival
 *  oracle measures where people actually stop (Law 4). */
function gatherPoint(w: World, v: { cx: number; cy: number }): Vec {
  const c = w.terrain.cellCenter(v.cx, v.cy);
  const r = w.terrain.reachablePoint(c.x, c.y);
  return w.terrain.civSafePoint(r.x, r.y);
}

/** Staged (never-firing) ambush cell, the atmospherics-probe leaderless idiom: insurgents with
 *  brainState "ambush", rof hold, iedInit (holds fire for a charge that never comes), and NO
 *  squadId so the cell-combat brain never owns or moves them. Spawned ~95 m from the anchor on
 *  the side away from `awayFrom`, snapped to reachable ground but kept inside the 123 m
 *  staged-threat sensing radius (stagedThreat > 0.18 needs d < 150 * 0.82). */
function spawnStagedCell(w: World, anchor: Vec, awayFrom: Vec, salt: string): string[] {
  const rng = new RNG(`encounter-${salt}`);
  const dx = anchor.x - awayFrom.x;
  const dy = anchor.y - awayFrom.y;
  const baseAng = Math.atan2(dy, dx) || rng.range(0, Math.PI * 2);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const a = baseAng + rng.range(-0.3, 0.3);
    let pos: Vec | null = null;
    for (const r0 of [95, 80, 65, 50]) {
      const raw = { x: anchor.x + Math.cos(a) * r0, y: anchor.y + Math.sin(a) * r0 };
      const r = w.terrain.reachablePoint(raw.x, raw.y);
      if (dist(r, anchor) <= 115) {
        pos = { x: r.x, y: r.y };
        break;
      }
    }
    if (!pos) continue;
    const e = makeInsurgent(rng, "fighter", pos, 0.6);
    e.brainState = "ambush";
    e.rof = "hold";
    e.iedInit = true;
    e.stance = "prone";
    e.hasFired = false;
    w.sim.addUnit(e);
    ids.push(e.id);
  }
  return ids;
}

// ════════════════════════════════════════════════════════════════ MODE shura
interface ShuraRun {
  dispatched: boolean;
  village: string;
  tStation: number;
  tSummon: number;
  tDepart: number;
  tMet: number;
  metPath: "none" | "met" | "regret" | "flip-unlogged";
  gateViol: string[];
  fp: number; // elder per-10s position fingerprint hash
  // diagnostics: how close the elder ACTUALLY got (the regret path must be explainable)
  minDMeet: number; // min dist(elder, summons meet point)
  minDSL: number; // min dist(elder, squad leader) — onStationEffects' 6 m sit-down gate
  firstFireClock: number; // first clock any unit's hasFired latched (gunfire changes the scene)
  maxTier: number; // elder's max reactTier seen
  // abort bookkeeping
  abortSpawned: boolean;
  spawnClock: number;
  latchClock: number;
  turnedHomeClock: number; // first clock after the latch his pathGoal is the home snap
  dHome0: number;
  dHome120: number;
}

function runShuraScenario(seed: string, abort: boolean): ShuraRun {
  const out: ShuraRun = {
    dispatched: false,
    village: "",
    tStation: -1,
    tSummon: -1,
    tDepart: -1,
    tMet: -1,
    metPath: "none",
    gateViol: [],
    fp: 0,
    minDMeet: Infinity,
    minDSL: Infinity,
    firstFireClock: -1,
    maxTier: 0,
    abortSpawned: false,
    spawnClock: -1,
    latchClock: -1,
    turnedHomeClock: -1,
    dHome0: -1,
    dHome120: -1,
  };
  const w = createWorld(seed, 90);
  quiet(w);
  const v = nearestVillages(w)[0];
  out.village = v.name;
  const sq = w.platoon.squads.find((s) => s.id === "sq1")!;
  const task = w.conductKLE(sq.memberIds, v.id, "patrol"); // default KLE SOP: patrol / hold / tight
  if (!task) return out;
  out.dispatched = true;
  const taskId = task.id;
  const scan = logScanner(w);
  const home = gatherPoint(w, v);
  // The man onStationEffects measures the 6 m sit-down gate against (buildSquad slId — sq1's
  // squad_leader role) — tracked so a regret path is explainable with a number, not a shrug.
  const sl = w.platoon.members.find((m) => sq.memberIds.includes(m.id) && m.role === "squad_leader");
  const dt = 0.1;
  const steps = Math.round((4 * 3600) / dt); // 4 game-hour cap
  let meet: Vec | null = null;
  let dSummon = -1;
  let fpStr = "";
  let askViol = false;
  let dvViol = false;

  for (let i = 1; i <= steps; i++) {
    w.tick(dt);
    w.drainInterrupts();
    const clock = w.state.clock;
    const t = w.state.tasks.find((x) => x.id === taskId);
    const elder = w.sim.unit(v.elderUnitId);

    for (const l of scan()) {
      if (out.tSummon < 0 && l.msg.includes("the elders are coming out")) {
        out.tSummon = clock;
        if (elder && elder.summons) {
          meet = { x: elder.summons.x, y: elder.summons.y };
          dSummon = dist(elder.pos, meet);
          if (dSummon <= 2.5) out.tDepart = clock; // summoned already at the meet point
        }
      }
      if (out.metPath === "none" && l.msg.includes("sits down with")) {
        out.metPath = "met";
        out.tMet = clock;
      }
      if (out.metPath === "none" && l.msg.includes("sends his regrets")) {
        out.metPath = "regret";
        out.tMet = clock;
      }
    }
    if (out.tStation < 0 && t && t.phase === "onstation") out.tStation = clock;
    // "Departs for the meet": he CLOSES >2 m on it, OR his movement order (pathGoal — what the
    // SUMMONS branch's civMoveTo actually sets) is the meet, OR he was summoned already inside
    // arrival range (2.5 m) — a man whose door is 4 m from the meet point has no 2 m to close.
    if (out.tDepart < 0 && meet && elder) {
      const closed = dSummon - dist(elder.pos, meet) > 2;
      const ordered = !!elder.moving && !!elder.pathGoal && dist(elder.pathGoal, meet) < 10;
      const there = dist(elder.pos, meet) <= 2.5;
      if (closed || ordered || there) out.tDepart = clock;
    }
    if (meet && elder) out.minDMeet = Math.min(out.minDMeet, dist(elder.pos, meet));
    if (sl && elder && out.tStation >= 0) out.minDSL = Math.min(out.minDSL, dist(elder.pos, sl.pos));
    if (elder) out.maxTier = Math.max(out.maxTier, elder.reactTier ?? 0);
    if (out.firstFireClock < 0 && w.sim.units.some((u) => u.hasFired)) out.firstFireClock = clock;
    // backstop: elderMet flipped but neither log seen (should be impossible — both paths log)
    if (out.metPath === "none" && t && t.elderMet === true) {
      out.metPath = "flip-unlogged";
      out.tMet = clock;
    }

    // THE GATE: while the shura has not formed, nothing decides — no dwell event, no ask.
    if (t && t.phase === "onstation" && t.elderMet === false) {
      if (!dvViol && w.pendingEvent && w.pendingEvent.id.startsWith("dv-")) {
        dvViol = true;
        out.gateViol.push(`dwell event "${w.pendingEvent.kind}" at +${(clock - out.tStation).toFixed(0)}s with elderMet=false`);
      }
      if (!askViol && v.ask) {
        askViol = true;
        out.gateViol.push(`elder ask "${v.ask.kind}" raised at +${(clock - out.tStation).toFixed(0)}s with elderMet=false`);
      }
    }
    if (w.pendingEvent) w.pendingEvent = null; // headless: never wedge on a modal

    // ABORT VARIANT: elder en route -> staged cell ~95 m off him, away from the meet.
    if (abort && !out.abortSpawned && out.tDepart >= 0 && elder && elder.summons && t && t.elderMet === false) {
      spawnStagedCell(w, { ...elder.pos }, meet ?? w.terrain.cellCenter(v.cx, v.cy), `${seed}-abort`);
      out.abortSpawned = true;
      out.spawnClock = clock;
      out.dHome0 = dist(elder.pos, home);
    }
    if (out.abortSpawned && out.latchClock < 0 && elder && elder.summonsAborted && !elder.summons) out.latchClock = clock;
    // "He turns for home": his MOVEMENT ORDER flips to the home snap (civMoveTo(homePoint) —
    // the melt/clear-road branches). Checked on pathGoal because real gunfire later (the squad
    // engaging the cell under ROE tight) correctly pre-empts the walk with FLEE — gunfire always
    // wins; the turn itself is what the abort latch promises.
    if (out.latchClock >= 0 && out.turnedHomeClock < 0 && elder && elder.pathGoal && dist(elder.pathGoal, home) < 30)
      out.turnedHomeClock = clock;
    if (out.abortSpawned && out.dHome120 < 0 && clock >= out.spawnClock + 120 && elder) out.dHome120 = dist(elder.pos, home);

    if (i % 100 === 0) fpStr += elder ? `${elder.pos.x.toFixed(3)},${elder.pos.y.toFixed(3)};` : "x;";

    // fixed, state-driven exits (identical across same-seed runs)
    if (!abort && out.tMet >= 0 && clock > out.tMet + 30) break;
    if (abort && out.metPath !== "none" && out.dHome120 >= 0 && clock > out.spawnClock + 150) break;
    if (!t) break; // task completed / dissolved
  }
  out.fp = RNG.hashString(fpStr);
  return out;
}

function modeShura(seed: string) {
  console.log(`\n=== MODE shura · seed ${seed} ===`);
  console.log(`columns: t_station · t_summon · t_depart · t_met(path) · gate_held · det`);
  const a = runShuraScenario(seed, false);
  if (!gate("shura: KLE dispatched", a.dispatched, `village ${a.village}`)) return;
  const rel = (t: number) => (t < 0 ? "never" : `+${(t - a.tStation).toFixed(0)}s`);
  console.log(
    `  t_station=${a.tStation < 0 ? "never" : a.tStation.toFixed(0) + "s"} · t_summon=${rel(a.tSummon)} · t_depart=${rel(a.tDepart)} · t_met=${rel(a.tMet)} (path=${a.metPath})`
  );
  gate(
    "shura: summon log fires at on-station",
    a.tSummon >= 0 && a.tStation >= 0 && Math.abs(a.tSummon - a.tStation) <= 1,
    `t_station=${a.tStation.toFixed(0)}s, t_summon=${a.tSummon.toFixed(0)}s`
  );
  gate(
    "shura: elder departs for the meet <=300s",
    a.tDepart >= 0 && a.tDepart - a.tStation <= 300,
    a.tDepart < 0 ? "elder never closed on the meet point" : `departed ${rel(a.tDepart)} after on-station`
  );
  const metOk = a.metPath === "met" && a.tMet - a.tStation <= 1200;
  const regretOk = a.metPath === "regret";
  gate(
    "shura: meeting resolves (sits down <=1200s, or the honest regret path)",
    metOk || regretOk,
    a.metPath === "met"
      ? `THE ELDER SAT DOWN ${rel(a.tMet)} after on-station`
      : a.metPath === "regret"
        ? `REGRET PATH taken ${rel(a.tMet)} — the elder never reached the SL (honest: no sit-down on this seed)`
        : `neither path fired (metPath=${a.metPath})`
  );
  note(`elder closed to ${a.minDMeet === Infinity ? "?" : a.minDMeet.toFixed(1)} m of the meet point, ${a.minDSL === Infinity ? "?" : a.minDSL.toFixed(1)} m of the SL (sit-down gate is <6 m, tasks.ts onStationEffects); max reactTier ${a.maxTier}; first shot ${a.firstFireClock < 0 ? "never" : `@${a.firstFireClock.toFixed(0)}s`}`);
  gate("shura: decision gate held while elderMet=false", a.gateViol.length === 0, a.gateViol.length ? a.gateViol.join("; ") : "no dwell event, no elder ask before the meet");

  const b = runShuraScenario(seed, false);
  gate("shura: determinism (elder per-10s position fingerprint)", a.fp === b.fp, `run1=${a.fp} run2=${b.fp}`);

  console.log(`  -- abort variant (fresh world, same seed) --`);
  const ab = runShuraScenario(seed, true);
  gate("shura-abort: staged cell spawned while elder en route", ab.abortSpawned, ab.abortSpawned ? `at clock ${ab.spawnClock.toFixed(0)}s, elder ${ab.dHome0.toFixed(0)} m from home` : "elder was never en route with an active summons");
  gate(
    "shura-abort: summons aborts LATCHED (summonsAborted, summons cleared) <=30s",
    ab.latchClock >= 0 && ab.latchClock - ab.spawnClock <= 30,
    ab.latchClock < 0 ? "latch never fired" : `latched +${(ab.latchClock - ab.spawnClock).toFixed(1)}s after spawn`
  );
  gate(
    "shura-abort: elder turns for home (pathGoal flips to the home snap <=15s)",
    ab.turnedHomeClock >= 0 && ab.turnedHomeClock - ab.latchClock <= 15,
    ab.turnedHomeClock < 0 ? "his movement order never flipped to home" : `order flipped home +${(ab.turnedHomeClock - ab.latchClock).toFixed(1)}s after the latch`
  );
  note(`dist-to-home ${ab.dHome0.toFixed(0)} m at spawn -> ${ab.dHome120 < 0 ? "?" : ab.dHome120.toFixed(0)} m at +120 s; first shot ${ab.firstFireClock < 0 ? "never" : `@${ab.firstFireClock.toFixed(0)}s (clock)`}; elder max reactTier ${ab.maxTier} — gunfire (the squad engaging the staged cell under ROE tight) correctly pre-empts the walk home with FLEE`);
  gate("shura-abort: KLE proceeds via the regret line", ab.metPath === "regret", `metPath=${ab.metPath}${ab.tMet >= 0 ? `, +${(ab.tMet - ab.tStation).toFixed(0)}s after on-station` : ""}`);
}

// ═══════════════════════════════════════════════════════════════ MODE funeral
function modeFuneral(seed: string) {
  console.log(`\n=== MODE funeral · seed ${seed} ===`);
  const w = createWorld(seed, 90);
  quiet(w);

  // Pick the victim: the nearest village holding a householded, non-elder civilian whose kin
  // pool (other living household members + the elder if outside the household) is >=2 — the
  // smallest cohort that can express "the household gathers". A tiny village of 2-person
  // households with the elder inside one (seen on survey-41) makes a >=2 gathering structurally
  // impossible: that is cohort unavailability, not the mechanism — so the probe walks outward to
  // the nearest village where the behavior is measurable, and says so.
  let pick: { v: VillageState; victim: Unit; pool: number; hhN: number } | null = null;
  const skipped: string[] = [];
  for (const v of nearestVillages(w)) {
    const civs = w.sim.units.filter((u) => u.faction === "civilian" && u.villageId === v.id && u.alive);
    const hhSize = new Map<string, number>();
    for (const u of civs) if (u.householdId) hhSize.set(u.householdId, (hhSize.get(u.householdId) ?? 0) + 1);
    const elderUnit = w.sim.unit(v.elderUnitId);
    const kinPool = (u: Unit) =>
      (hhSize.get(u.householdId!) ?? 1) - 1 + (elderUnit && elderUnit.alive && elderUnit.householdId !== u.householdId ? 1 : 0);
    const cand = civs
      .filter((u) => u.householdId && u.id !== v.elderUnitId)
      .sort((x, y) => kinPool(y) - kinPool(x) || (x.id < y.id ? -1 : 1))[0];
    if (cand && kinPool(cand) >= 2) {
      pick = { v, victim: cand, pool: kinPool(cand), hhN: hhSize.get(cand.householdId!) ?? 1 };
      break;
    }
    skipped.push(`${v.name} (max kin pool ${cand ? kinPool(cand) : 0})`);
  }
  if (!gate("funeral: victim with a measurable (>=2) kin pool found", !!pick, pick ? `${pick.victim.name} (${pick.victim.householdId}, ${pick.hhN}-person household, kin pool ${pick.pool}) of ${pick.v.name}${skipped.length ? ` — skipped ${skipped.join(", ")}` : ""}` : `no village offers a >=2 kin pool on this seed (${skipped.join(", ")})`)) return;
  const { v, victim } = pick!;
  const hh = victim.householdId!;

  // 60 s warmup, then the civcas — faithfully to reconcileCivilians' read
  // (killed = !alive; attribution = casualtyByFaction).
  for (let i = 0; i < 600; i++) w.tick(0.1);
  const scan = logScanner(w);
  victim.hp = 0;
  victim.alive = false;
  victim.conscious = false;
  victim.casualtyByFaction = "us";
  w.tick(0.1); // reconcileCivilians fires here
  const killDay = w.day;
  const g = (v.grievances ?? []).find((x) => x.unitId === victim.id);
  gate(
    "funeral: NAMED grievance on the village ledger",
    !!g && g.name === victim.name && g.killed === true && !g.resolved,
    g ? `{name: ${g.name}, householdId: ${g.householdId}, day: ${g.day}, killed: ${g.killed}, resolved: ${g.resolved}}` : `no ledger entry for ${victim.name} on ${v.name}`
  );
  const killLogs = scan();
  gate(
    "funeral: casualty log carries his name",
    killLogs.some((l) => l.msg.includes(victim.name)),
    killLogs.length ? `"${killLogs.find((l) => l.msg.includes(victim.name))?.msg ?? killLogs[0].msg}"` : "no casualty log fired"
  );

  // March to the next first-light edge (the burial). dt=2 is the movement-faithful coarse
  // tick the atmospherics diurnal probe validated.
  let buried = false;
  let buryLabel = "";
  let lightAtBury = -1;
  const capSteps = Math.round((30 * 3600) / 2);
  for (let i = 0; i < capSteps && !buried; i++) {
    w.tick(2);
    w.drainInterrupts();
    if (w.pendingEvent) w.pendingEvent = null;
    for (const l of scan()) {
      if (l.msg.includes(`they bury ${victim.name}`)) {
        buried = true;
        buryLabel = l.timeLabel;
        lightAtBury = w.solarLight();
      }
    }
  }
  gate(
    "funeral: \"they bury\" log fires at the next first-light edge",
    buried && w.day === killDay + 1,
    buried ? `${buryLabel} (killed day ${killDay}; solar light ${lightAtBury.toFixed(2)} — the dawn edge)` : "bury log never fired within 30 game-hours"
  );
  if (!buried) return;
  gate("funeral: ledger entry marked mourned", g?.mourned === true, `mourned=${g?.mourned}`);

  const gp = gatherPoint(w, v);
  const summoned = w.sim.units.filter(
    (u) =>
      u.faction === "civilian" &&
      u.alive &&
      !!u.summons &&
      dist({ x: u.summons.x, y: u.summons.y }, gp) < 10 &&
      ((!!u.householdId && u.householdId === hh) || u.id === v.elderUnitId)
  );
  const summonedIds = summoned.map((u) => u.id);
  gate(
    "funeral: >=2 kin summoned to the grave",
    summoned.length >= 2,
    `${summoned.length} summoned: ${summoned.map((u) => `${u.name}${u.id === v.elderUnitId ? " (elder)" : ""}`).join(", ") || "none"}`
  );

  // The 20-minute gathering, dt=1; serialize mid-gathering at +300 s.
  let maxArr = 0;
  let blob: Parameters<typeof loadWorld>[0] | null = null;
  for (let s = 1; s <= 1200; s++) {
    w.tick(1);
    w.drainInterrupts();
    if (w.pendingEvent) w.pendingEvent = null;
    const arr = summonedIds.filter((id) => {
      const u = w.sim.unit(id);
      return !!u && u.alive && dist(u.pos, gp) < 15;
    }).length;
    maxArr = Math.max(maxArr, arr);
    if (s === 300) blob = JSON.parse(JSON.stringify(w.serialize()));
  }
  gate("funeral: >=2 kin arrive within 15 m during the 20-min window", maxArr >= 2, `peak ${maxArr}/${summonedIds.length} at the graveside`);

  // SAVE ROUND-TRIP mid-gathering.
  if (!blob) {
    gate("funeral: save round-trip", false, "no mid-gathering snapshot captured");
    return;
  }
  const w2 = loadWorld(blob);
  const v2 = w2.state.villages.find((x) => x.id === v.id)!;
  const g2 = (v2.grievances ?? []).find((x) => x.unitId === victim.id);
  gate(
    "funeral: ledger survives the save round-trip (named + mourned)",
    !!g2 && g2.name === victim.name && g2.mourned === true && !g2.resolved,
    g2 ? `{name: ${g2.name}, mourned: ${g2.mourned}, killed: ${g2.killed}, resolved: ${g2.resolved}}` : "ledger entry lost in round-trip"
  );
  const carrying = summonedIds.filter((id) => !!w2.sim.unit(id)?.summons).length;
  gate("funeral: summoned units still carry their summons after load", carrying === summonedIds.length, `${carrying}/${summonedIds.length} carry the summons`);
  let maxArr2 = 0;
  for (let s = 1; s <= 900; s++) {
    w2.tick(1);
    w2.drainInterrupts();
    if (w2.pendingEvent) w2.pendingEvent = null;
    const arr = summonedIds.filter((id) => {
      const u = w2.sim.unit(id);
      return !!u && u.alive && dist(u.pos, gp) < 15;
    }).length;
    maxArr2 = Math.max(maxArr2, arr);
  }
  gate("funeral: the gathering resumes after load (>=2 at the grave)", maxArr2 >= 2, `peak ${maxArr2}/${summonedIds.length} in the loaded world`);
}

// ══════════════════════════════════════════════════════════════════ MODE kids
/** Replicates civilian.ts trait(id,"cur") — how many of a village's children CAN trail
 *  (curiosity > 0.5), so a 0-trail result is diagnosable as cohort vs mechanism. */
function curiousKids(w: World, vid: string): { total: number; curious: number } {
  let total = 0;
  let curious = 0;
  for (const u of w.sim.units) {
    if (u.faction !== "civilian" || u.role !== "child" || u.villageId !== vid) continue;
    total++;
    if ((RNG.hashString(u.id + "cur") % 100000) / 100000 > 0.5) curious++;
  }
  return { total, curious };
}

function modeKids(seed: string) {
  console.log(`\n=== MODE kids · seed ${seed} ===`);
  const w = createWorld(seed, 90);
  quiet(w);
  // The metric is undefined without children: the friendly village needs >=1 CURIOUS child
  // (trait(id,"cur")>0.5 is the trailing precondition, civilian.ts), the hostile one needs >=1
  // child for "the absence" to be a measurement rather than a vacancy. Both nearest villages on
  // survey-41 have zero children — cohort unavailability, not mechanism — so the probe picks the
  // nearest QUALIFYING pair and says so.
  const vs = nearestVillages(w);
  const A = vs.find((v) => curiousKids(w, v.id).curious >= 1);
  const B = vs.find((v) => v !== A && curiousKids(w, v.id).curious >= 1) ?? vs.find((v) => v !== A && curiousKids(w, v.id).total >= 1);
  if (!A || !B) {
    gate("kids: a measurable village pair exists", false, `no two villages with children near the COP on this seed (${vs.map((v) => `${v.name}:${curiousKids(w, v.id).total}`).join(", ")})`);
    return;
  }
  A.attitude = 40;
  B.attitude = -40;
  const ka = curiousKids(w, A.id);
  const kb = curiousKids(w, B.id);
  console.log(
    `  friendly ${A.name} (+40): ${ka.total} children (${ka.curious} curious) · hostile ${B.name} (-40): ${kb.total} children (${kb.curious} curious)`
  );

  // To 09:00 — full daylight, children out in the lanes.
  while (w.secondsOfDay < 9 * 3600) {
    w.tick(2);
    w.drainInterrupts();
    if (w.pendingEvent) w.pendingEvent = null;
  }

  const sq = w.platoon.squads.find((s) => s.id === "sq1")!;
  const cop = w.state.copCell;

  interface Pass {
    trailMin: number; // moving-phase minutes with >=1 of the village's kids within 12 m
    near12Other: number; // same metric outside the moving phase (onstation/returning) — diagnostic
    perKid: { name: string; curious: boolean; minD: number; pickupS: number }[];
  }
  const pass = (v: VillageState): Pass | null => {
    // An out-and-back sweep through the village lanes, then home: village -> ~125 m beyond ->
    // village -> midpoint. A trailing kid paces the squad (~1.1 vs ~1.1-1.3 m/s) but cannot CLOSE
    // a 20-30 m pickup gap on the march — the patrol turning at the far waypoint and walking back
    // THROUGH its tail is what realizes the <=12 m windows while genuinely moving. Identical route
    // shape for both villages.
    const len = Math.hypot(v.cx - cop.cx, v.cy - cop.cy) || 1;
    const ux = (v.cx - cop.cx) / len;
    const uy = (v.cy - cop.cy) / len;
    const cl = (n: number) => Math.max(2, Math.min(509, Math.round(n)));
    const t = w.formPatrol(
      sq.memberIds,
      [
        { cx: v.cx, cy: v.cy },
        { cx: cl(v.cx + ux * 25), cy: cl(v.cy + uy * 25) },
        { cx: v.cx, cy: v.cy },
        { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      ],
      "presence",
      "patrol",
      { movement: "patrol", contact: "hold", roe: "tight" }
    );
    if (!t) return null;
    const id = t.id;
    const kids = w.sim.units.filter((u) => u.faction === "civilian" && u.role === "child" && u.villageId === v.id);
    const diag = new Map(kids.map((k) => [k.id, { minD: Infinity, pickupS: 0 }]));
    let trailS = 0;
    let otherS = 0;
    let recalled = false;
    const cap = Math.round((3 * 3600) / 0.1);
    for (let i = 0; i < cap; i++) {
      w.tick(0.1);
      w.drainInterrupts();
      if (w.pendingEvent) w.pendingEvent = null;
      const tk = w.state.tasks.find((x) => x.id === id);
      if (!tk) break;
      const moving = tk.phase === "moving";
      const members = tk.memberIds.map((m) => w.sim.unit(m)).filter((u): u is Unit => !!u && u.alive);
      let near12 = false;
      for (const k of kids) {
        if (!k.alive) continue;
        let kd = Infinity;
        for (const m of members) kd = Math.min(kd, dist(k.pos, m.pos));
        const d = diag.get(k.id)!;
        d.minD = Math.min(d.minD, kd);
        if (moving && kd < 35) d.pickupS += 0.1; // inside the 35 m trailing trigger ring
        if (kd <= 12) near12 = true;
      }
      if (near12) {
        if (moving) trailS += 0.1;
        else otherS += 0.1;
      }
      if (tk.phase === "onstation" && !recalled) {
        recalled = true;
        w.recall(id); // the dwell isn't the subject — turn the patrol around
      }
    }
    return {
      trailMin: trailS / 60,
      near12Other: otherS / 60,
      perKid: kids.map((k) => {
        const d = diag.get(k.id)!;
        return {
          name: k.name,
          curious: (RNG.hashString(k.id + "cur") % 100000) / 100000 > 0.5,
          minD: d.minD,
          pickupS: d.pickupS,
        };
      }),
    };
  };

  const pA = pass(A);
  const pB = pass(B);
  if (!pA || !pB) {
    gate("kids: both patrols dispatched", false, `formPatrol returned null (A=${!!pA}, B=${!!pB})`);
    return;
  }
  const trailA = pA.trailMin;
  const trailB = pB.trailMin;
  console.log(`  trail(+40 ${A.name}) = ${trailA.toFixed(2)} min · trail(-40 ${B.name}) = ${trailB.toFixed(2)} min`);
  for (const [tag, p] of [[A.name, pA], [B.name, pB]] as const) {
    note(
      `${tag}: kids ${p.perKid.map((k) => `${k.name}${k.curious ? " (curious)" : ""} minD=${k.minD === Infinity ? "?" : k.minD.toFixed(0)}m pickup=${k.pickupS.toFixed(0)}s`).join(" · ") || "none"} · near12 outside moving=${p.near12Other.toFixed(2)} min`
    );
  }
  gate(
    "kids: friendly kids trail (>0) and >=3x hostile",
    trailA > 0 && (trailB === 0 || trailA >= 3 * trailB),
    `${trailA.toFixed(2)} vs ${trailB.toFixed(2)} min`
  );
  gate("kids: hostile-village children-near-patrol ~0 (<0.5 min)", trailB < 0.5, `${trailB.toFixed(2)} min — the absence is the read`);
}

// ═══════════════════════════════════════════════════════════════════ driver
const mode = process.argv[2] ?? "all";
const seed = process.argv[3] ?? "survey-12";
if (!["all", "shura", "funeral", "kids"].includes(mode)) {
  console.error(`unknown mode "${mode}" — use shura | funeral | kids | all`);
  process.exit(2);
}
if (mode === "shura" || mode === "all") modeShura(seed);
if (mode === "funeral" || mode === "all") modeFuneral(seed);
if (mode === "kids" || mode === "all") modeKids(seed);

console.log(`\n${FAILS === 0 ? "ENCOUNTER-PROBE OK" : `ENCOUNTER-PROBE FAIL — ${FAILS} gate(s) failed`}`);
process.exit(FAILS === 0 ? 0 : 1);
