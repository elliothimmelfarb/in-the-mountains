/**
 * Realism probe — pure, deterministic measurements of the combat model that turn
 * "does this feel right?" into hard numbers, isolated from the director/AI noise.
 *
 *   npx tsx scripts/realism-probe.ts            # all probes
 *   npx tsx scripts/realism-probe.ts ballistics # just one
 *
 * Probe 1 (ballistics): a fixed shooter fires K rounds at a target held at each
 * range band on flat ground (exposure ~1). We tally hit% AND mean *effective
 * terminal damage* per hit. This is the clean way to see whether a round does the
 * same wound at 500 m as at 50 m (it should not) and to prove a terminal-energy
 * change without a noisy firefight.
 */
import { createWorld } from "../lib/sim/world";
import { makeInsurgent } from "../lib/sim/entities";
import { getWeapon } from "../lib/sim/weapons";
import { lineOfSight } from "../lib/sim/los";
import { spawnProjectile, resolveDirectHit } from "../lib/sim/ballistics";
import type { Unit } from "../lib/sim/entities";

const which = process.argv[2] ?? "all";

function flatGround(terrain: ReturnType<typeof createWorld>["terrain"]) {
  // find a low-slope cell near the valley floor for a clean, level shot line
  let best = { x: terrain.worldSize / 2, y: terrain.worldSize / 2, s: 9 };
  for (let i = 0; i < 4000; i++) {
    const x = 40 + Math.random() * (terrain.worldSize - 80);
    const y = 40 + Math.random() * (terrain.worldSize - 80);
    const s = terrain.slopeAt(x, y);
    if (s < best.s) best = { x, y, s };
    if (best.s < 0.03) break;
  }
  return best;
}

function ballisticsProbe() {
  const world = createWorld("probe-ballistics", 90);
  const { terrain, sim } = world;
  const rng = world.rng;

  // a representative rifleman shooter (steady, prone, deliberate) and an unarmored target
  const shooter = world.platoon.members.find((m) => m.weaponId === "m4")!;
  const ranges = [25, 50, 100, 200, 300, 400, 500, 600, 700, 800];
  const K = 4000;

  console.log("=== BALLISTICS: hit% and mean terminal damage by range ===");
  console.log("shooter: M4, marksmanship", shooter.marksmanship.toFixed(2), "prone, settled aim; target: standing, unarmored, fully exposed, no cover\n");
  console.log("  range   hit%   mean-eff-dmg/hit   kill%(per shot)");

  const g = flatGround(terrain);
  for (const R of ranges) {
    // place shooter and target on the flattest line we can, R apart
    const sx = g.x, sy = g.y;
    const tx = Math.min(terrain.worldSize - 10, sx + R), ty = sy;
    shooter.pos = { x: sx, y: sy };
    shooter.stance = "prone";
    shooter.moving = false;
    shooter.suppression = 0;
    shooter.fatigue = 0;
    shooter.composure = 1;
    shooter.aimProgress = 1;

    let hits = 0, kills = 0, dmgSum = 0;
    for (let k = 0; k < K; k++) {
      const target = makeInsurgent(rng, "fighter", { x: tx, y: ty }, 0.3);
      target.stance = "stand";
      target.hp = 100;
      const los = lineOfSight(terrain, shooter.pos, target.pos, { observerHeight: 1.6, targetHeight: 1.75 });
      const proj = spawnProjectile(shooter, getWeapon("m4"), target.pos, target.id, R, rng);
      const cover = 0;
      const before = target.hp;
      const oc = resolveDirectHit(proj, target, los, cover, rng);
      if (oc.hit) {
        hits++;
        dmgSum += (before - target.hp);
        if (oc.killed) kills++;
      }
    }
    const hitPct = (100 * hits) / K;
    const meanDmg = hits ? dmgSum / hits : 0;
    const killPct = (100 * kills) / K;
    console.log(
      `  ${String(R).padStart(4)}m  ${hitPct.toFixed(1).padStart(5)}%  ${meanDmg.toFixed(1).padStart(12)}      ${killPct.toFixed(1).padStart(5)}%`
    );
  }
  console.log("\nNote: with the baseline model mean-eff-dmg/hit is ~flat across range (no terminal-energy falloff).");
}

/**
 * Probe 2 (engagement): run real scripted contacts (squad presence patrol into a
 * hot valley) across seeds and dump the human-factor telemetry that AI / morale /
 * perception / fires changes move — averaged so it's a stable baseline.
 */
function engagementProbe() {
  const SEEDS = 10;
  const MINUTES = 18;
  let firstDetTickSum = 0, firstDetCount = 0;
  let peakSuppSum = 0, meanSuppSum = 0, suppSamples = 0;
  let usKIA = 0, usWIA = 0, enKIA = 0, civCas = 0, contacts = 0;
  let roundsUS = 0, roundsEnemy = 0, fmUsed = 0;
  let minCompSum = 0, minCompCount = 0, successions = 0;

  for (let s = 0; s < SEEDS; s++) {
    const world = createWorld(`probe-eng-${s}`, 90);
    const { terrain, state, sim } = world;
    state.enemyHeat = 0.7;
    const cop = terrain.copCell;
    const v = terrain.villages[s % terrain.villages.length];
    const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
    const medic = world.platoon.members.find((m) => m.role === "medic");
    const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
    world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical");
    state.nextActivityAt = 0;

    // who is a leader at the start (to detect battlefield succession)
    const wasLeader = new Set(ids.filter((id) => sim.unit(id)?.isLeader));

    let firstDet = -1, sawContact = false, minComp = 1;
    const ammo0 = sim.ammoExpended;
    const ticks = MINUTES * 600;
    for (let t = 0; t < ticks && !state.ended; t++) {
      world.tick(0.1);
      if (world.inContact()) sawContact = true;
      // first tick any patrol member confirms an enemy
      if (firstDet < 0) {
        for (const id of ids) {
          const u = sim.unit(id);
          if (u && u.alive && u.visibleEnemyIds.length > 0) { firstDet = t; break; }
        }
      }
      // suppression + composure telemetry on the patrol, sampled every 2 s while in contact
      if (sawContact && t % 20 === 0) {
        let peak = 0, sum = 0, n = 0;
        for (const id of ids) {
          const u = sim.unit(id);
          if (u && u.alive) { peak = Math.max(peak, u.suppression); sum += u.suppression; n++; minComp = Math.min(minComp, u.composure); }
        }
        if (n) { peakSuppSum += peak; meanSuppSum += sum / n; suppSamples++; }
      }
    }
    // any patrolman now leading who wasn't before = a battlefield promotion
    for (const id of ids) { const u = sim.unit(id); if (u && u.alive && u.isLeader && !wasLeader.has(id)) successions++; }
    if (sawContact) { minCompSum += minComp; minCompCount++; }
    if (sawContact) contacts++;
    if (firstDet >= 0) { firstDetTickSum += firstDet; firstDetCount++; }
    usKIA += world.platoon.members.filter((m) => !m.alive).length;
    usWIA += world.platoon.members.filter((m) => m.alive && m.wounds.length > 0).length;
    enKIA += world.platoon.members.reduce((a, m) => a + m.kills, 0);
    civCas += sim.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;
    roundsUS += sim.ammoExpended - ammo0; // (enemy + US both counted in ammoExpended; close enough for a trend)
    fmUsed += sim.fireMissionsUsed;
    void roundsEnemy;
  }

  console.log("\n=== ENGAGEMENT telemetry (avg over", SEEDS, "seeds,", MINUTES, "game-min, sq1+medic presence patrol, heat 0.7) ===");
  console.log(`  Contacts: ${contacts}/${SEEDS}`);
  console.log(`  Time to first detection: ${firstDetCount ? (firstDetTickSum / firstDetCount / 600).toFixed(2) : "n/a"} game-min (over ${firstDetCount} contacts)`);
  console.log(`  Suppression on patrol while in contact: mean ${(meanSuppSum / Math.max(1, suppSamples)).toFixed(3)} · peak-of-element ${(peakSuppSum / Math.max(1, suppSamples)).toFixed(3)}`);
  console.log(`  Lowest patrol composure during contact (avg of run-mins): ${(minCompSum / Math.max(1, minCompCount)).toFixed(3)} · NCO successions: ${successions}`);
  console.log(`  Casualties: US KIA ${(usKIA / SEEDS).toFixed(2)} · US WIA ${(usWIA / SEEDS).toFixed(2)} · enemy ${(enKIA / SEEDS).toFixed(2)} · civ ${(civCas / SEEDS).toFixed(2)}`);
  console.log(`  Rounds expended (both sides): ${(roundsUS / SEEDS).toFixed(0)}/contact-run · fire missions ${(fmUsed / SEEDS).toFixed(2)}`);
}

/**
 * Probe 3 (perception): the per-moment detection probability for an observer
 * acquiring a target, isolated by synthesizing the LOS result directly (chosen
 * range / exposure / concealment) so the only variables are the sensor and the
 * light. Proves the thermal channel (#2): naked eye vs NVG vs thermal across
 * day/dusk/night and through vegetation. Reports p AND expected seconds-to-detect
 * at the ~0.45 s perception cadence.
 */
function perceptionProbe() {
  // Lazy import so a model lacking thermal params still runs (extra args ignored).
  const { detectionChance } = require("../lib/sim/los") as typeof import("../lib/sim/los");
  const CADENCE = 0.475; // mean perception throttle (s)
  const sensors: { name: string; nvg: boolean; thermal: boolean }[] = [
    { name: "naked eye", nvg: false, thermal: false },
    { name: "NVG", nvg: true, thermal: false },
    { name: "thermal", nvg: false, thermal: true },
  ];
  // Faithful LOS shape: terrainExposure (geometric) and vegConceal (foliage) are
  // what the real lineOfSight emits, and what thermal needs to see through leaves.
  const scenes = [
    { label: "day,  open,   400m", light: 1.0, terrEx: 1.0, veg: 0.0, range: 400 },
    { label: "day,  forest, 300m", light: 1.0, terrEx: 1.0, veg: 0.7, range: 300 },
    { label: "dusk, open,   400m", light: 0.35, terrEx: 1.0, veg: 0.0, range: 400 },
    { label: "night,open,   300m", light: 0.05, terrEx: 1.0, veg: 0.0, range: 300 },
    { label: "night,forest, 250m", light: 0.05, terrEx: 1.0, veg: 0.7, range: 250 },
  ];
  console.log("\n=== PERCEPTION: per-moment detect p / expected seconds-to-detect, by sensor ===");
  console.log("target: stationary, not firing, standing; observer optic 800 m, alert 0.7\n");
  const head = "  scene                  " + sensors.map((s) => s.name.padStart(11)).join("  ");
  console.log(head);
  for (const sc of scenes) {
    const conceal = 1 - Math.exp(-(-Math.log(1 - sc.veg))); // = sc.veg, kept explicit
    const exposure = sc.terrEx * (1 - sc.veg);
    const los = {
      visible: true, exposure, terrainBlocked: false, concealment: conceal, rangeM: sc.range,
      terrainExposure: sc.terrEx, vegConceal: sc.veg, smokeConceal: 0,
    };
    const cells = sensors.map((sn) => {
      const p = detectionChance({
        los, light: sc.light, observerNVG: sn.nvg, targetMoving: false, targetFiring: false,
        targetProne: false, observerOpticRangeM: 800, alertness: 0.7,
        // thermal fields are passed even if the baseline model ignores them
        ...( { observerThermal: sn.thermal, thermalRangeM: 1200 } as object ),
      });
      const ttd = p > 1e-4 ? (CADENCE / p).toFixed(1) + "s" : "  —";
      return `${(100 * p).toFixed(0).padStart(3)}% ${ttd.padStart(6)}`;
    });
    console.log("  " + sc.label.padEnd(22) + cells.join("  "));
  }
}

/** Probe 4 (wind): lateral bullet drift vs range for a fixed crosswind. */
function windProbe() {
  const world = createWorld("probe-wind", 90);
  const { terrain } = world;
  const rng = world.rng;
  const shooter = world.platoon.members.find((m) => m.weaponId === "m4")!;
  shooter.stance = "prone"; shooter.suppression = 0; shooter.fatigue = 0; shooter.composure = 1; shooter.aimProgress = 1;
  const g = flatGround(terrain);
  shooter.pos = { x: g.x, y: g.y };
  const crossWind = { x: 0, y: 6 }; // 6 m/s pure crosswind (shots fired along +X)
  console.log("\n=== WIND: mean lateral bullet drift for a 6 m/s full-value crosswind (M4) ===");
  console.log("  range   mean lateral drift (m)");
  for (const R of [100, 300, 500, 800]) {
    const tx = Math.min(terrain.worldSize - 10, g.x + R);
    let sum = 0; const K = 3000;
    for (let k = 0; k < K; k++) {
      const proj = spawnProjectile(shooter, getWeapon("m4"), { x: tx, y: g.y }, "t", R, rng, crossWind);
      // lateral (y) component of aimpoint relative to the true target line; gaussian averages to 0
      sum += proj.aimpoint.y - g.y;
    }
    console.log(`  ${String(R).padStart(4)}m   ${(sum / K).toFixed(2)}`);
  }
}

/** Probe 5 (enemy indirect, #4): proves the formerly-dead enemyFireMission pipeline
 *  now fires — a hot valley harasses the COP with mortars from defilade. */
function indirectProbe() {
  const SEEDS = 8, MIN = 45;
  let totalFM = 0, totalRounds = 0, runsWithIndirect = 0, usKIA = 0, civCas = 0;
  for (let s = 0; s < SEEDS; s++) {
    const world = createWorld(`probe-ind-${s}`, 90);
    const { state, sim } = world;
    state.enemyHeat = 0.8;
    state.nextActivityAt = 0;
    const seen = new Set<number>();
    let any = false;
    for (let t = 0; t < MIN * 600 && !state.ended; t++) {
      world.tick(0.1);
      for (const fm of sim.fireMissions) {
        if (fm.faction === "insurgent" && !seen.has(fm.id)) { seen.add(fm.id); totalFM++; totalRounds += fm.rounds; any = true; }
      }
      for (const u of sim.units) if (Number.isNaN(u.pos.x)) { console.error("NaN!", s); process.exit(1); }
    }
    if (any) runsWithIndirect++;
    usKIA += world.platoon.members.filter((m) => !m.alive).length;
    civCas += sim.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;
  }
  console.log("\n=== ENEMY INDIRECT (#4): hot valley (heat 0.8), 8 seeds x 45 min, COP-focused ===");
  console.log(`  enemy fire missions launched: ${totalFM} (${totalRounds} rounds) · ${runsWithIndirect}/${SEEDS} runs saw indirect`);
  console.log(`  collateral over the runs: US KIA ${(usKIA / SEEDS).toFixed(2)}/run · civ cas ${(civCas / SEEDS).toFixed(2)}/run · (baseline pre-#4: 0 enemy FM — pipeline was dead)`);
}

/** Probe 6 (COIN, #5 regen + #6 civcas): proves the insurgency regenerates from the
 *  population (you can't kill your way out, but pacifying works) and that civilian
 *  casualties by our fires harden the valley. */
function coinProbe() {
  console.log("\n=== COIN (#5 insurgent regen · #6 civcas backlash) ===");
  // (A) Regen lever: hostile vs pacified valley, director suppressed so enemyStrength
  //     moves ONLY via regeneration (no kills) — isolates the mechanism.
  for (const mode of ["hostile", "pacified"] as const) {
    const w = createWorld(`probe-coin-${mode}`, 120);
    w.state.nextActivityAt = Infinity; w.state.nextEventAt = Infinity; w.state.nextIntelAt = Infinity;
    w.state.nextWeatherAt = Infinity;
    for (const v of w.state.villages) {
      if (mode === "hostile") { v.attitude = -30; v.sympathy = 60; }
      else { v.attitude = 60; v.sympathy = 8; }
    }
    const start = w.state.enemyStrengthAbs;
    const DAYS = 14, dt = 6;
    for (let i = 0, n = Math.round((DAYS * 86400) / dt); i < n && !w.state.ended; i++) w.tick(dt);
    const end = w.state.enemyStrengthAbs;
    const tag = end > start + 1 ? "REGEN ↑" : end < start - 1 ? "DECAY ↓" : "flat";
    console.log(`  ${mode.padEnd(9)} valley: enemyStrength ${start.toFixed(0)} → ${end.toFixed(1)} over ${DAYS}d, no combat  [${tag}]`);
  }
  // (B) CIVCAS backlash: US mortars onto a populated village.
  const w = createWorld("probe-coin-civcas", 120);
  w.state.nextActivityAt = Infinity;
  const vil = w.state.villages[0];
  const b = { att: vil.attitude, sym: vil.sympathy, str: w.state.enemyStrengthAbs, hi: w.state.metrics.higherConfidence };
  w.requestFireMission("mortar81", w.terrain.cellCenter(vil.cx, vil.cy), 8);
  for (let i = 0; i < 1400 && !w.state.ended; i++) w.tick(0.1);
  const civCas = w.sim.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;
  console.log(`  CIVCAS test: 8 US mortar rounds on ${vil.name} → ${civCas} civ casualties`);
  console.log(`    ${vil.name}: attitude ${b.att}→${vil.attitude} · sympathy ${b.sym}→${vil.sympathy} · enemyStrength ${b.str.toFixed(0)}→${w.state.enemyStrengthAbs.toFixed(1)} · higherConf ${b.hi}→${w.state.metrics.higherConfidence}`);
}

/** Probe 7 (medical, #7): IDENTICAL wound, fate as a function only of the AID
 *  available — run on a bare CombatSim (no garrison to reposition the medic), with
 *  the post-wound state set by hand so it's a clean controlled experiment. Proves a
 *  buddy/self tourniquet saves an extremity (arterial) bleed, but only a medic saves
 *  an internal (junctional) one. */
function medicalProbe() {
  const { CombatSim } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
  const weather = { visibilityM: 4000, wind: 0, label: "Clear" };
  const scen = [
    { name: "extremity · conscious (self-TQ)", hp: 70, bleed: 1.3, tq: 1.3, conscious: true, buddy: false, medic: false },
    { name: "extremity · out cold, NO buddy", hp: 70, bleed: 1.3, tq: 1.3, conscious: false, buddy: false, medic: false },
    { name: "extremity · out cold, buddy near", hp: 70, bleed: 1.3, tq: 1.3, conscious: false, buddy: true, medic: false },
    { name: "internal · buddy only (no medic)", hp: 55, bleed: 1.1, tq: 0, conscious: false, buddy: true, medic: false },
    { name: "internal · medic on scene", hp: 55, bleed: 1.1, tq: 0, conscious: false, buddy: false, medic: true },
  ];
  console.log("\n=== MEDICAL (#7): identical wound, fate by aid available (2 min on the deck) ===");
  for (const s of scen) {
    const w = createWorld(`med-${s.name}`, 90);
    const pool = w.platoon.members.filter((m) => m.role !== "medic");
    const cas = pool[0], buddy = pool[1];
    const medic = w.platoon.members.find((m) => m.role === "medic")!;
    const sim = new CombatSim({ terrain: w.terrain, rng: w.rng, units: [cas, buddy, medic], light: 1, weather, persistent: true });
    const spot = { x: 1000, y: 1000 };
    cas.pos = { ...spot }; cas.alive = true; cas.hp = s.hp; cas.bleedRate = s.bleed; cas.bleedTQable = s.tq; cas.conscious = s.conscious;
    cas.wounds = [{ region: s.tq > 0 ? "leg" : "chest", severity: 0.5, bleeding: s.bleed, treated: false, timeM: 0 }];
    cas.path = []; cas.brainState = "holding"; cas.rof = "hold";
    buddy.pos = s.buddy ? { x: spot.x + 2, y: spot.y } : { x: 5, y: 5 }; buddy.bleedRate = 0; buddy.conscious = true; buddy.path = []; buddy.brainState = "holding"; buddy.rof = "hold";
    medic.pos = s.medic ? { x: spot.x + 2, y: spot.y } : { x: 5, y: 5 }; medic.bleedRate = 0; medic.conscious = true; medic.path = []; medic.brainState = s.medic ? "treating" : "holding"; medic.targetId = s.medic ? cas.id : null; medic.rof = "hold";
    for (let t = 0; t < 1200 && cas.alive; t++) sim.tick(0.1);
    console.log(`  ${s.name.padEnd(34)} ⇒ ${!cas.alive ? "DIED" : "LIVED hp " + cas.hp.toFixed(0)} · final bleed ${cas.bleedRate.toFixed(2)}`);
  }
}

/** Probe 8 (load, #8): combat load (kg) by role, and the speed/fatigue cost of being
 *  a mule — a heavy gunner over the same ground as a rifleman. */
function loadProbe() {
  const { CombatSim, combatLoadKg } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
  const { getWeapon } = require("../lib/sim/weapons") as typeof import("../lib/sim/weapons");
  const w = createWorld("probe-load", 90);
  console.log("\n=== LOAD (#8): combat load by role (kg) ===");
  const sample = [
    ["rifleman (M4)", w.platoon.members.find((m) => m.role === "rifleman")],
    ["SAW gunner (M249)", w.platoon.members.find((m) => m.role === "saw_gunner")],
    ["240 gunner (M240)", w.platoon.members.find((m) => m.role === "machinegunner")],
    ["grenadier (M4+203)", w.platoon.members.find((m) => m.role === "grenadier")],
  ] as const;
  for (const [label, m] of sample) {
    if (!m) continue;
    console.log(`  ${label.padEnd(20)} ${combatLoadKg(m, getWeapon(m.weaponId)).toFixed(1)} kg`);
  }

  // Movement cost: rifleman vs 240 gunner over IDENTICAL ground & fitness (load is the
  // only variable). Walk 'traveling' for 150 s from the same flat start.
  console.log("\n  movement over the same ground (fitness fixed 0.75, traveling, 150 s):");
  const g = flatGround(w.terrain);
  const target = { x: Math.min(w.terrain.worldSize - 20, g.x + 320), y: g.y };
  for (const role of ["rifleman", "machinegunner"] as const) {
    const w2 = createWorld("probe-load", 90);
    const sim = new CombatSim({ terrain: w2.terrain, rng: w2.rng, units: [], light: 1, weather: { visibilityM: 4000, wind: 0, label: "Clear" }, persistent: true });
    const u = w2.platoon.members.find((m) => m.role === role)!;
    u.fitnessMax = 0.75; u.fatigue = 0; u.pos = { x: g.x, y: g.y }; u.technique = "traveling"; u.brainState = "moving"; u.stance = "stand";
    sim.addUnit(u);
    sim.moveTo(u, target);
    u.brainState = "moving"; u.rof = "hold";
    for (let t = 0; t < 1500; t++) { sim.tick(0.1); if (u.path.length === 0) sim.moveTo(u, target); }
    const dist = Math.hypot(u.pos.x - g.x, u.pos.y - g.y);
    console.log(`    ${role.padEnd(14)} load ${combatLoadKg(u, getWeapon(u.weaponId)).toFixed(0)}kg → covered ${dist.toFixed(0)} m, fatigue ${u.fatigue.toFixed(2)}`);
  }
}

if (which === "all" || which === "ballistics") ballisticsProbe();
if (which === "all" || which === "engagement") engagementProbe();
if (which === "all" || which === "perception") perceptionProbe();
if (which === "all" || which === "wind") windProbe();
if (which === "all" || which === "indirect") indirectProbe();
if (which === "all" || which === "coin") coinProbe();
if (which === "all" || which === "medical") medicalProbe();
if (which === "all" || which === "load") loadProbe();
