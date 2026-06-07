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
  let seriousWIA = 0, minorWIA = 0;

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
    seriousWIA += world.platoon.members.filter((m) => m.alive && (!m.conscious || m.hp < 40 || m.bleedRate > 0.3)).length;
    minorWIA += world.platoon.members.filter((m) => m.alive && m.conscious && m.hp >= 40 && m.bleedRate <= 0.3 && m.wounds.length > 0).length;
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
  console.log(`  Casualties: US KIA ${(usKIA / SEEDS).toFixed(2)} · US WIA ${(usWIA / SEEDS).toFixed(2)} (serious/ineffective ${(seriousWIA / SEEDS).toFixed(2)} · walking-wounded ${(minorWIA / SEEDS).toFixed(2)}) · enemy ${(enKIA / SEEDS).toFixed(2)} · civ ${(civCas / SEEDS).toFixed(2)}`);
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
    { label: "DENSE canopy, 200m", light: 0.5, terrEx: 1.0, veg: 0.97, range: 200 }, // naked eye blinded
  ];
  console.log("\n=== PERCEPTION: per-moment detect p / expected seconds-to-detect, by sensor ===");
  console.log("target: stationary, not firing, standing; observer optic 800 m, alert 0.7\n");
  const head = "  scene                  " + sensors.map((s) => s.name.padStart(11)).join("  ");
  console.log(head);
  for (const sc of scenes) {
    const exposure = sc.terrEx * (1 - sc.veg);
    const los = {
      // visible reflects the REAL naked-eye gate (exposure>0.04) so the dense-canopy
      // case actually blinds the naked eye and exercises the thermal-through-veg path.
      visible: exposure > 0.04, exposure, terrainBlocked: false, concealment: sc.veg, rangeM: sc.range,
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

  // (C) wound→kill escalation (review fix): a civ wounded then killed by our fire must
  // escalate to the FULL kill backlash, not stay frozen at the wound tier.
  const w3 = createWorld("coin-wk", 120);
  w3.state.nextActivityAt = Infinity;
  const civ = w3.sim.units.find((u) => u.faction === "civilian")!;
  const vil2 = w3.nearestVillage(civ.pos, 700)!;
  const a0 = vil2.attitude;
  civ.wounds = [{ region: "leg", severity: 0.4, bleeding: 0, treated: false, timeM: 0 }]; civ.casualtyByFaction = "us"; civ.bleedRate = 0;
  w3.tick(0.1); // reconcile counts the WOUND
  const aWound = vil2.attitude;
  civ.alive = false; // dies of wounds
  w3.tick(0.1); // reconcile ESCALATES to kill
  console.log(`  wound→kill: attitude ${a0} → ${aWound} (wound −${(a0 - aWound).toFixed(0)}) → ${vil2.attitude} (escalation −${(aWound - vil2.attitude).toFixed(0)}; total −${(a0 - vil2.attitude).toFixed(0)} should = full kill −14)`);
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

/** Probe 9 (fire-and-maneuver, #9): does a BUDDY (no medic present) now break to a
 *  downed man, drag him to cover and save him — the loop that completes #7? */
function rescueProbe() {
  const { CombatSim } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
  const weather = { visibilityM: 4000, wind: 0, label: "Clear" };
  console.log("\n=== #9 casualty drag: a buddy reaches & saves a downed man (NO medic) ===");
  for (const buddyDist of [8, 18]) {
    const w = createWorld(`rescue-${buddyDist}`, 90);
    const pool = w.platoon.members.filter((m) => m.role !== "medic");
    const cas = pool[0], buddy = pool[1];
    const sim = new CombatSim({ terrain: w.terrain, rng: w.rng, units: [cas, buddy], light: 1, weather, persistent: true });
    const g = flatGround(w.terrain);
    cas.pos = { x: g.x, y: g.y }; cas.alive = true; cas.hp = 50; cas.bleedRate = 1.3; cas.bleedTQable = 1.3; cas.conscious = false;
    cas.wounds = [{ region: "leg", severity: 0.6, bleeding: 1.3, treated: false, timeM: 0 }]; cas.path = []; cas.brainState = "holding";
    buddy.pos = { x: g.x + buddyDist, y: g.y }; buddy.alive = true; buddy.hp = 100; buddy.bleedRate = 0; buddy.conscious = true;
    buddy.path = []; buddy.brainState = "holding"; buddy.rof = "hold"; buddy.threatDir = { x: 0, y: 1 };
    for (let t = 0; t < 1800 && cas.alive; t++) sim.tick(0.1);
    const apart = Math.hypot(buddy.pos.x - cas.pos.x, buddy.pos.y - cas.pos.y);
    console.log(`  buddy ${String(buddyDist).padStart(2)}m away ⇒ casualty ${!cas.alive ? "DIED" : "LIVED hp " + cas.hp.toFixed(0)} · buddy closed to ${apart.toFixed(1)} m · final bleed ${cas.bleedRate.toFixed(2)}`);
  }
}

/** Probe (review fix): a pre-windDir save must not NaN-poison combat on load. */
function saveloadProbe() {
  const { loadWorld } = require("../lib/sim/world") as typeof import("../lib/sim/world");
  console.log("\n=== SAVE/LOAD (review blocker fix): pre-windDir save stays NaN-clean ===");
  const w = createWorld("probe-save", 90);
  w.state.enemyHeat = 0.85; w.state.nextActivityAt = 0;
  for (let t = 0; t < 3000; t++) w.tick(0.1); // run into a firefight, then save
  const data = w.serialize();
  delete (data.state.weather as { windDir?: number }).windDir; // simulate an OLD save (field absent)
  const w2 = loadWorld({ rngState: data.rngState, state: data.state, units: data.units });
  const wv = w2.windVector();
  let nanUnits = 0, nanProj = 0;
  for (let t = 0; t < 3000; t++) {
    w2.tick(0.1);
    for (const u of w2.sim.units) if (!Number.isFinite(u.pos.x) || !Number.isFinite(u.pos.y)) nanUnits++;
    for (const p of w2.sim.projectiles) if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.aimpoint.x)) nanProj++;
  }
  console.log(`  windVector after stripping windDir: (${wv.x.toFixed(2)}, ${wv.y.toFixed(2)}) finite=${Number.isFinite(wv.x) && Number.isFinite(wv.y)}`);
  console.log(`  3000 ticks post-load: NaN unit samples ${nanUnits}, NaN projectile samples ${nanProj}  ${nanUnits + nanProj === 0 ? "✓ CLEAN" : "✗ CORRUPTED"}`);
}

/** Probe 10 (IED ambush, #10): a patrol walks onto a buried charge linked to a
 *  waiting cell — it detonates and the ambush springs. Activates the dead ied_team. */
function iedProbe() {
  const { CombatSim } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
  const { makeInsurgent } = require("../lib/sim/entities") as typeof import("../lib/sim/entities");
  const weather = { visibilityM: 4000, wind: 0, label: "Clear" };
  console.log("\n=== IED AMBUSH (#10): patrol walks onto a buried charge ===");
  const w = createWorld("ied-probe", 90);
  const sim = new CombatSim({ terrain: w.terrain, rng: w.rng, units: [], light: 1, weather, persistent: true });
  const g = flatGround(w.terrain);
  const killPt = { x: Math.min(w.terrain.worldSize - 30, g.x + 60), y: g.y };
  const squad = w.platoon.squads.find((s) => s.id === "sq1")!.memberIds.map((id) => w.platoon.members.find((m) => m.id === id)!);
  squad.forEach((u, i) => {
    u.pos = { x: g.x - i * 3, y: g.y }; u.alive = true; u.hp = 100; u.conscious = true; u.wounds = []; u.bleedRate = 0;
    u.technique = "patrol"; u.brainState = "moving"; u.rof = "hold"; sim.addUnit(u); sim.moveTo(u, killPt);
  });
  const cellId = "acm-ied-test";
  for (let i = 0; i < 4; i++) {
    const e = makeInsurgent(w.rng.fork("amb" + i), i === 0 ? "ied_team" : "fighter", { x: killPt.x + 18, y: killPt.y + 12 + i * 4 }, 0.6);
    e.squadId = cellId; e.brainState = "ambush"; e.rof = "hold"; e.stance = "prone"; e.iedInit = true; sim.addUnit(e);
  }
  sim.plantIED(killPt, cellId);
  let detonated = false, cellEngaged = false, detTick = -1, minDist = 999, cellEngagedTick = -1;
  for (let t = 0; t < 2500; t++) {
    sim.tick(0.1);
    // walk the squad onto the charge; once it blows, let the combat AI react (don't
    // force-march them into the kill zone, which would inflate casualties unrealistically)
    for (const u of squad) if (u.alive && u.conscious && !detonated) { sim.moveTo(u, killPt); minDist = Math.min(minDist, Math.hypot(u.pos.x - killPt.x, u.pos.y - killPt.y)); }
    if (!detonated && !sim.ieds.some((i) => i.armed)) { detonated = true; detTick = t; }
    const eng = sim.units.some((e) => e.faction === "insurgent" && e.squadId === cellId && e.alive && e.brainState === "engage");
    if (eng && cellEngagedTick < 0) cellEngagedTick = t;
    if (detonated && eng) cellEngaged = true;
  }
  const usCas = squad.filter((u) => !u.alive || u.wounds.length > 0).length;
  console.log(`  point man closest approach to charge: ${minDist.toFixed(1)} m (trigger 8 m) · cell engaged at ${cellEngagedTick >= 0 ? (cellEngagedTick / 10).toFixed(0) + "s" : "never"}`);
  console.log(`  IED detonated: ${detonated}${detTick >= 0 ? ` (at ${(detTick / 10).toFixed(0)}s)` : ""}`);
  console.log(`  ambush cell sprang hold→engage: ${cellEngaged} · US casualties in the kill zone: ${usCas}/${squad.length}`);
}

/** Probe (#9b base of fire, review fix): on an ASSAULT order the automatic weapon sets
 *  a base of fire (rof→suppress, holds) while the rifleman bounds onto the objective.
 *  Tested by driving friendlyBrain directly with forced contact, so the result is
 *  deterministic and independent of terrain LOS. Previously DEAD code (the assault
 *  brainState was never assigned). */
function assaultProbe() {
  const { CombatSim } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
  const { friendlyBrain } = require("../lib/sim/ai/friendly") as typeof import("../lib/sim/ai/friendly");
  const { makeInsurgent } = require("../lib/sim/entities") as typeof import("../lib/sim/entities");
  const w = createWorld("assault-probe", 90);
  const sim = new CombatSim({ terrain: w.terrain, rng: w.rng, units: [], light: 1, weather: { visibilityM: 4000, wind: 0, label: "Clear" }, persistent: true });
  const spot = w.copWorld();
  const obj = { x: spot.x + 50, y: spot.y };
  const enemy = makeInsurgent(w.rng.fork("e"), "fighter", obj, 0.6); enemy.alive = true; sim.addUnit(enemy);
  const setup = (role: string) => {
    const u = w.platoon.members.find((m) => m.role === role)!;
    u.pos = { ...spot }; u.alive = true; u.hp = 100; u.conscious = true; u.composure = 0.8; u.suppression = 0; u.path = []; sim.addUnit(u);
    u.orderType = "assault"; u.brainState = "moving"; u.orderTarget = { ...obj }; u.targetId = enemy.id;
    return u;
  };
  const saw = setup("saw_gunner");
  const rifle = setup("rifleman");
  // drive the brain a few times with FORCED contact (set after any perception would run,
  // since we call the brain directly — no sim.tick to overwrite visibleEnemyIds)
  let sawSuppressTicks = 0, sawMoveOrders = 0, rifleMoveOrders = 0;
  for (let t = 0; t < 20; t++) {
    saw.visibleEnemyIds = [enemy.id]; rifle.visibleEnemyIds = [enemy.id];
    saw.path = []; rifle.path = [];
    friendlyBrain(sim, saw, 0.1);
    friendlyBrain(sim, rifle, 0.1);
    if (saw.rof === "suppress") sawSuppressTicks++;
    if (saw.path.length > 0 && saw.pathGoal && Math.hypot(saw.pathGoal.x - obj.x, saw.pathGoal.y - obj.y) < 5) sawMoveOrders++;
    if (rifle.path.length > 0 && rifle.pathGoal && Math.hypot(rifle.pathGoal.x - obj.x, rifle.pathGoal.y - obj.y) < 5) rifleMoveOrders++;
  }
  console.log("\n=== #9b BASE OF FIRE (assault, review fix): SAW suppresses & holds, rifleman bounds ===");
  console.log(`  SAW gunner (auto): rof→suppress on ${sawSuppressTicks}/20 ticks, bound-onto-objective orders ${sawMoveOrders}/20 (holds = low)`);
  console.log(`  rifleman: bound-onto-objective orders ${rifleMoveOrders}/20 (bounds = high)`);
  console.log(`  ⇒ ${sawSuppressTicks >= 18 && sawMoveOrders === 0 && rifleMoveOrders >= 18 ? "FIRE & MANEUVER works (was dead code)" : "FAILED"}`);
}

/**
 * Probe 12 (stance-mix, combat-realism wave): under fire, do soldiers fight LOW?
 * Runs the same sq1+medic presence patrol into a hot valley as the engagement probe,
 * and while in contact samples the STANCE of every living patrolman every 2 s,
 * tallying the fraction standing / crouch / prone. The prone-under-fire + posture-
 * down behaviour lives in friendlyBrain (lib/sim/ai/friendly.ts): `pinned` ⇒ prone,
 * `contact` ⇒ crouch-in-cover-else-prone. Before the wave the gates were never
 * reached, so the patrol fought standing up (baseline 73% standing / 0% prone).
 * Expect after: standing ~7-12%, crouch ~85-89%, prone ~2-4%.
 */
function stanceMixProbe() {
  const SEEDS = 12;
  const MINUTES = 18;
  let stand = 0, crouch = 0, prone = 0, samples = 0, contacts = 0;
  // separate tally restricted to the moments the man is actually under fire (suppression>0.18 or
  // sees an enemy) — the patrol-average dilutes with lulls, this is the honest "while shot at" read.
  let fStand = 0, fCrouch = 0, fProne = 0, fSamples = 0;
  for (let s = 0; s < SEEDS; s++) {
    const world = createWorld(`probe-stance-${s}`, 90);
    const { terrain, state, sim } = world;
    state.enemyHeat = 0.75;
    const cop = terrain.copCell;
    const v = terrain.villages[s % terrain.villages.length];
    const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
    const medic = world.platoon.members.find((m) => m.role === "medic");
    const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
    world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical");
    state.nextActivityAt = 0;
    let sawContact = false;
    const ticks = MINUTES * 600;
    for (let t = 0; t < ticks && !state.ended; t++) {
      world.tick(0.1);
      if (world.inContact()) sawContact = true;
      if (sawContact && world.inContact() && t % 20 === 0) {
        for (const id of ids) {
          const u = sim.unit(id);
          if (!u || !u.alive || !u.conscious) continue;
          if (u.stance === "stand") stand++; else if (u.stance === "crouch") crouch++; else prone++;
          samples++;
          const shotAt = u.suppression > 0.18 || u.visibleEnemyIds.length > 0;
          if (shotAt) {
            if (u.stance === "stand") fStand++; else if (u.stance === "crouch") fCrouch++; else fProne++;
            fSamples++;
          }
        }
      }
    }
    if (sawContact) contacts++;
  }
  const pct = (n: number, d: number) => (d ? (100 * n) / d : 0).toFixed(1).padStart(5);
  console.log("\n=== STANCE-MIX (combat-realism wave): friendly posture WHILE IN CONTACT ===");
  console.log(`  sq1+medic presence patrol, heat 0.75, ${SEEDS} seeds x ${MINUTES} game-min · contacts ${contacts}/${SEEDS}`);
  console.log(`  all-in-contact samples (${samples}):  stand ${pct(stand, samples)}%  crouch ${pct(crouch, samples)}%  prone ${pct(prone, samples)}%`);
  console.log(`  while under fire   (${fSamples}):  stand ${pct(fStand, fSamples)}%  crouch ${pct(fCrouch, fSamples)}%  prone ${pct(fProne, fSamples)}%`);
  console.log(`  baseline pre-wave: 73% standing / 0% prone — soldiers fought upright. After: men fight LOW.`);
}

/**
 * Probe 13 (shoot-and-scoot, #17): what fraction of enemy "engage" episodes lead to a
 * displacement (scoot)? An engage episode = a fighter entering brainState "engage";
 * a scoot = that fighter subsequently transitioning engage→scoot (insurgentBrain in
 * lib/sim/ai/insurgent.ts: the engage DWELL expires or pressure mounts ⇒ displacePosition
 * ⇒ brainState "scoot"). Baseline ~0.02% (displacePosition demanded cover that was almost
 * never within reach on the open high ground, so fighters rooted). Measured TWO ways:
 *  (A) IN-CONTEXT: the director's real contacts in a hot valley (the honest end-to-end read,
 *      diluted by fighters who die / exfil before their dwell ends).
 *  (B) ISOLATED: hand-built fighters held in engage on open ground vs a live patrol so the
 *      dwell can actually expire — the clean per-fighter scoot rate.
 */
function shootScootProbe() {
  console.log("\n=== SHOOT-AND-SCOOT (#17): fraction of enemy engage episodes that displace ===");

  // (A) in-context: count engage-entries and engage→scoot transitions across real contacts.
  {
    const SEEDS = 10, MINUTES = 20;
    let engageEntries = 0, scoots = 0;
    for (let s = 0; s < SEEDS; s++) {
      const world = createWorld(`probe-scoot-${s}`, 90);
      const { terrain, state, sim } = world;
      state.enemyHeat = 0.8;
      const cop = terrain.copCell;
      const v = terrain.villages[s % terrain.villages.length];
      const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
      const medic = world.platoon.members.find((m) => m.role === "medic");
      const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
      world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical");
      state.nextActivityAt = 0;
      const prev = new Map<string, string>(); // unit id → last brainState seen
      for (let t = 0; t < MINUTES * 600 && !state.ended; t++) {
        world.tick(0.1);
        for (const u of sim.units) {
          if (u.faction !== "insurgent") continue;
          const was = prev.get(u.id);
          if (u.brainState === "engage" && was !== "engage") engageEntries++;
          if (u.brainState === "scoot" && was === "engage") scoots++;
          prev.set(u.id, u.brainState);
        }
      }
    }
    const rate = engageEntries ? (100 * scoots) / engageEntries : 0;
    console.log(`  (A) IN-CONTEXT (${SEEDS} seeds x ${MINUTES} min, real director contacts):`);
    console.log(`      engage episodes ${engageEntries} · scoots ${scoots} ⇒ ${rate.toFixed(1)}% displace  (baseline ~0.02%)`);
  }

  // (B) isolated: fighters parked in engage on open ground vs a stationary patrol element so the
  //     dwell can run to completion. This is the clean per-fighter scoot rate (no early death/exfil).
  {
    const { CombatSim } = require("../lib/sim/combat") as typeof import("../lib/sim/combat");
    const SEEDS = 12;
    let engageEntries = 0, scoots = 0;
    for (let s = 0; s < SEEDS; s++) {
      const w = createWorld(`probe-scoot-iso-${s}`, 90);
      const sim = new CombatSim({ terrain: w.terrain, rng: w.rng, units: [], light: 1, weather: { visibilityM: 4000, wind: 0, label: "Clear" }, persistent: true });
      // DETERMINISTIC anchor: the COP world point (seeded, no Math.random — flatGround() uses
      // Math.random and would make this probe non-reproducible). Snap to passable ground.
      const cw = w.copWorld();
      const gc = w.terrain.nearestPassable(Math.floor(cw.x / w.terrain.cellSize), Math.floor(cw.y / w.terrain.cellSize));
      const g = w.terrain.cellCenter(gc.cx, gc.cy);
      // a US fire team to draw fire / be a target, well out of decisive range so the fight persists
      const us = w.platoon.squads.find((sd) => sd.id === "sq1")!.memberIds
        .map((id) => w.platoon.members.find((m) => m.id === id)!).slice(0, 4);
      us.forEach((u, i) => {
        u.pos = { x: g.x + i * 3, y: g.y }; u.alive = true; u.hp = 100; u.conscious = true; u.wounds = [];
        u.bleedRate = 0; u.brainState = "holding"; u.rof = "free"; u.path = []; sim.addUnit(u);
      });
      // 6 fighters parked in engage ~150 m off, on open ground (cover scarce ⇒ tests the lateral scoot)
      const fighters: Unit[] = [];
      for (let i = 0; i < 6; i++) {
        const fe = makeInsurgent(w.rng.fork("sc" + i), "fighter", { x: g.x + 150, y: g.y - 60 + i * 20 }, 0.6);
        fe.brainState = "engage"; fe.rof = "free"; fe.aggression = 0.5; fe.brainTimer = w.rng.range(14, 26);
        fe.targetId = us[i % us.length].id; fe.threatDir = { x: -1, y: 0 }; sim.addUnit(fe); fighters.push(fe);
      }
      const prev = new Map<string, string>(fighters.map((f) => [f.id, "engage"] as const));
      // count the initial engage entry for each fighter
      engageEntries += fighters.length;
      for (let t = 0; t < 60 * 600; t++) { // up to 60 s — plenty for a 14-26 s dwell to expire
        sim.tick(0.1);
        for (const f of fighters) {
          const was = prev.get(f.id);
          if (f.brainState === "engage" && was !== "engage") engageEntries++;
          if (f.brainState === "scoot" && was === "engage") scoots++;
          prev.set(f.id, f.brainState);
        }
      }
    }
    const rate = engageEntries ? (100 * scoots) / engageEntries : 0;
    console.log(`  (B) ISOLATED (${SEEDS} seeds, fighters held in engage on open ground vs a fire team):`);
    console.log(`      engage episodes ${engageEntries} · scoots ${scoots} ⇒ ${rate.toFixed(1)}% displace  (isolation target ~80%)`);
  }
}

/** Shared geometry math for an enemy cell against a kill-zone focus. */
function cellGeometry(terrain: ReturnType<typeof createWorld>["terrain"], mem: Unit[], focus: { x: number; y: number }) {
  const cellElev = mem.reduce((a, u) => a + terrain.elevAt(u.pos.x, u.pos.y), 0) / mem.length;
  const elevAdv = cellElev - terrain.elevAt(focus.x, focus.y);
  const meanRange = mem.reduce((a, u) => a + Math.hypot(u.pos.x - focus.x, u.pos.y - focus.y), 0) / mem.length;
  let pairSum = 0, pairN = 0, mass = 0;
  for (let i = 0; i < mem.length; i++) {
    let near = false;
    for (let j = 0; j < mem.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(mem[i].pos.x - mem[j].pos.x, mem[i].pos.y - mem[j].pos.y);
      if (i < j) { pairSum += d; pairN++; }
      if (d <= 40) near = true;
    }
    if (near) mass++;
  }
  return { elevAdv, meanRange, pairMean: pairN ? pairSum / pairN : 0, mass, size: mem.length };
}

/**
 * Probe 14 (enemy-geometry, #12 massing + high-ground): measures the SHAPE of an ambush cell —
 * the elevation advantage, the L-massing, and the engagement range — produced by the wave-changed
 * firingPositions/scoreFiringPoint (lib/sim/world/director.ts). Measured TWO ways:
 *
 *  (A) DETERMINISTIC: call the exported spawnRoadAmbush() — which lays a cell with the IDENTICAL
 *      firingPositions(focus, dir, count, 80, 260) machinery the wave rewrote (two-stage anchor →
 *      dense firing line; elevation-weighted, proximity-gated scoreFiringPoint) — against many real
 *      valley-floor focus points, one cell per seed, no director-rate lottery. This is the clean,
 *      reproducible read of the geometry code itself (the director's ambush rate is too sparse to
 *      sample the shape stably end-to-end — measured ~0.5 plain-ambush cells/seed).
 *
 *  (B) IN-CONTEXT: the real director's spawnAmbushOnPatrol against a moving patrol, accumulated over
 *      many seeds. Filters to AMBUSH-state cells only (brainState "ambush"), excludes IED cells
 *      (their own 30-120 m band) and far village/random-floor fallbacks (>400 m of the patrol — the
 *      verifier's noted artifact), so it isn't washed out by infiltration/harass spawns.
 *
 * Per cell, against the kill-zone focus: mean ELEVATION ADVANTAGE (baseline +2.41 m, expect
 * ~+20..+55), mean pairwise distance, fighters within 40 m of a cellmate (the L-massing; baseline
 * 0.00, expect >0), and mean engagement range (expect in the 80-260 m ambush band).
 */
function enemyGeometryProbe() {
  const { spawnRoadAmbush } = require("../lib/sim/world/director") as typeof import("../lib/sim/world/director");
  console.log("\n=== ENEMY-GEOMETRY (#12 massing + high-ground): AMBUSH-cell shape ===");

  // (A) deterministic geometry of the exact firingPositions/scoreFiringPoint code (road-ambush caller,
  //     same 80-260 m band + two-stage massing). One cell per seed, measured vs its kill-zone focus.
  {
    const SEEDS = 40;
    let cells = 0, elevSum = 0, rangeSum = 0, pairSum = 0, massSum = 0, sizeSum = 0;
    for (let s = 0; s < SEEDS; s++) {
      const world = createWorld(`probe-geomA-${s}`, 90);
      const { terrain, state, sim } = world;
      state.enemyHeat = 0.8;
      const before = new Set(sim.units.filter((u) => u.faction === "insurgent").map((u) => u.id));
      spawnRoadAmbush(world);
      const mem = sim.units.filter((u) => u.faction === "insurgent" && u.alive && !before.has(u.id));
      if (mem.length < 3) continue;
      // the kill zone spawnRoadAmbush aimed at: a floor point at map-center on the chosen road row.
      // Reconstruct the focus from the cell's own centroid projected to the valley floor isn't needed —
      // we measure elevation advantage vs the LOWEST member's footprint area: use the cell centroid's
      // nearest valley-floor row. Simpler & faithful: the road focus is the cell's mean (x≈center); use it.
      const cx = mem.reduce((a, u) => a + u.pos.x, 0) / mem.length;
      const cy = mem.reduce((a, u) => a + u.pos.y, 0) / mem.length;
      // The true focus is on the road row (map-center column); approximate it as the floor point at the
      // cell's mean Y on the valley centerline — that's where the kill zone sat.
      const focus = { x: terrain.worldSize / 2, y: cy };
      void cx;
      const g = cellGeometry(terrain, mem, focus);
      cells++; elevSum += g.elevAdv; rangeSum += g.meanRange; pairSum += g.pairMean; massSum += g.mass; sizeSum += g.size;
    }
    const f = (x: number) => x.toFixed(2);
    const elevAdv = cells ? elevSum / cells : 0;
    console.log(`  (A) DETERMINISTIC firingPositions geometry (${SEEDS} road-ambush cells, vs kill-zone focus):`);
    console.log(`      cells ${cells} (mean ${cells ? f(sizeSum / cells) : "0"} fighters) · elev-adv ${elevAdv >= 0 ? "+" : ""}${f(elevAdv)} m · range ${cells ? f(rangeSum / cells) : "0"} m · pairwise ${cells ? f(pairSum / cells) : "0"} m · within-40m ${cells ? f(massSum / cells) : "0"}/cell`);
    console.log(`      baseline: elev +2.41 m · within-40m 0.00/cell. Expect: elev ~+20..+55, range 80-260, massing >0.`);
  }

  // (B) in-context director ambushes against a moving patrol (the honest end-to-end read, sparse).
  {
    const SEEDS = 40, MINUTES = 20;
    let cells = 0, elevSum = 0, rangeSum = 0, pairSum = 0, massSum = 0, sizeSum = 0;
    for (let s = 0; s < SEEDS; s++) {
      const world = createWorld(`probe-geomB-${s}`, 90);
      const { terrain, state, sim } = world;
      state.enemyHeat = 0.7; // best plain-ambush yield in the sweep (heat 0.7); high heat steals to IED
      const cop = terrain.copCell;
      const v = terrain.villages[s % terrain.villages.length];
      const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
      const ids = sq.memberIds;
      const task = world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical")!;
      // Keep the director shut until the patrol is MOVING: while assembling, activePatrolCentroid()
      // is null and spawnAmbushOnPatrol falls back to a far village/random point (measured: −35 m
      // "advantage", 1074 m range — not an ambush on the patrol).
      state.nextActivityAt = Infinity;
      let opened = false;
      const seenCells = new Set<string>();
      for (let t = 0; t < MINUTES * 600 && !state.ended; t++) {
        world.tick(0.1);
        if (!opened && (task.phase === "moving" || task.phase === "onstation")) { state.nextActivityAt = 0; opened = true; }
        const byCell = new Map<string, Unit[]>();
        for (const u of sim.units) {
          if (u.faction !== "insurgent" || !u.alive || u.brainState !== "ambush" || !u.squadId) continue;
          if (u.squadId.startsWith("acm-ied")) continue; // IED ambush is its own (30-120 m) band
          if (seenCells.has(u.squadId)) continue;
          const arr = byCell.get(u.squadId) ?? []; arr.push(u); byCell.set(u.squadId, arr);
        }
        const live = ids.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive);
        if (live.length === 0) continue;
        const pc = { x: live.reduce((a, u) => a + u.pos.x, 0) / live.length, y: live.reduce((a, u) => a + u.pos.y, 0) / live.length };
        for (const [cid, mem] of byCell) {
          if (mem.length < 3) continue;
          const g = cellGeometry(terrain, mem, pc);
          if (g.meanRange > 400) continue; // far fallback, not an ambush on this patrol — skip, don't mark seen
          seenCells.add(cid);
          cells++; elevSum += g.elevAdv; rangeSum += g.meanRange; pairSum += g.pairMean; massSum += g.mass; sizeSum += g.size;
        }
      }
    }
    const f = (x: number) => x.toFixed(2);
    const elevAdv = cells ? elevSum / cells : 0;
    console.log(`  (B) IN-CONTEXT director ambushes on a moving patrol (${SEEDS} seeds x ${MINUTES} min, heat 0.7):`);
    console.log(`      cells ${cells} (mean ${cells ? f(sizeSum / cells) : "0"} fighters) · elev-adv ${elevAdv >= 0 ? "+" : ""}${f(elevAdv)} m · range ${cells ? f(rangeSum / cells) : "0"} m · pairwise ${cells ? f(pairSum / cells) : "0"} m · within-40m ${cells ? f(massSum / cells) : "0"}/cell`);
  }
}

/**
 * Probe 15 (suppression-twosided): suppression is two-sided. Distinguishes FRIENDLY-side from
 * ENEMY-side suppression during real contacts, reporting mean + peak-of-element for EACH side and
 * the friendly pinned fraction (suppression>0.5). The patrol-AVERAGE on the friendly side reads
 * LOW by design — contacts here are short and sharp, so most patrol-seconds are lulls — which is
 * why a naive reader misreads "patrol-avg ~0" as "suppression didn't land". The honest reads are
 * the per-contact PEAK-of-element and the ENEMY-side suppression (the harass/ambush cells eat the
 * patrol's return fire). Suppression is the `u.suppression` field accumulated in combat.ts.
 */
function suppressionTwosidedProbe() {
  const SEEDS = 12, MINUTES = 20;
  // friendly side: 2 s-sampled means/peaks (diluted by lulls) + a per-TICK running peak (the honest
  // "how suppressed did a man ever get this contact" read — spikes are sharp and miss a 2 s grid).
  let fMeanSum = 0, fPeakSum = 0, fSamp = 0, fPinned = 0, fPinDen = 0;
  let fRunPeakSum = 0, fRunPeakN = 0; // per-seed all-time max friendly suppression, averaged over seeds
  let fEverPinnedSeeds = 0;           // seeds in which ≥1 patrolman ever exceeded supp 0.5
  // enemy side
  let eMeanSum = 0, ePeakSum = 0, eSamp = 0, eRunPeakSum = 0, eRunPeakN = 0;
  let contacts = 0;
  for (let s = 0; s < SEEDS; s++) {
    const world = createWorld(`probe-supp2-${s}`, 90);
    const { terrain, state, sim } = world;
    state.enemyHeat = 0.8;
    const cop = terrain.copCell;
    const v = terrain.villages[s % terrain.villages.length];
    const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
    const medic = world.platoon.members.find((m) => m.role === "medic");
    const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
    world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical");
    state.nextActivityAt = 0;
    let sawContact = false, fRunPeak = 0, eRunPeak = 0, fEverPinned = false;
    for (let t = 0; t < MINUTES * 600 && !state.ended; t++) {
      world.tick(0.1);
      if (world.inContact()) sawContact = true;
      if (!sawContact) continue;
      // per-TICK running peak (every tick, not the 2 s grid) — the true max either side reached.
      for (const id of ids) {
        const u = sim.unit(id);
        if (u && u.alive) { if (u.suppression > fRunPeak) fRunPeak = u.suppression; if (u.suppression > 0.5) fEverPinned = true; }
      }
      for (const u of sim.units) if (u.faction === "insurgent" && u.alive && u.suppression > eRunPeak) eRunPeak = u.suppression;
      if (t % 20 !== 0) continue;
      // friendly element (2 s-sampled mean + peak-of-element)
      {
        let peak = 0, sum = 0, n = 0;
        for (const id of ids) {
          const u = sim.unit(id);
          if (!u || !u.alive) continue;
          peak = Math.max(peak, u.suppression); sum += u.suppression; n++;
          if (u.suppression > 0.5) fPinned++; fPinDen++;
        }
        if (n) { fMeanSum += sum / n; fPeakSum += peak; fSamp++; }
      }
      // enemy element
      {
        let peak = 0, sum = 0, n = 0;
        for (const u of sim.units) {
          if (u.faction !== "insurgent" || !u.alive || !u.conscious) continue;
          peak = Math.max(peak, u.suppression); sum += u.suppression; n++;
        }
        if (n) { eMeanSum += sum / n; ePeakSum += peak; eSamp++; }
      }
    }
    if (sawContact) { contacts++; fRunPeakSum += fRunPeak; fRunPeakN++; eRunPeakSum += eRunPeak; eRunPeakN++; if (fEverPinned) fEverPinnedSeeds++; }
  }
  const f3 = (x: number) => x.toFixed(3);
  console.log("\n=== SUPPRESSION (two-sided): friendly vs enemy, mean + peak ===");
  console.log(`  sq1+medic presence patrol, heat 0.8, ${SEEDS} seeds x ${MINUTES} min · contacts ${contacts}/${SEEDS}`);
  console.log(`  FRIENDLY: patrol-avg ${f3(fMeanSum / Math.max(1, fSamp))} (LOW BY DESIGN — short sharp contacts, mostly lulls)`);
  console.log(`            per-contact max (per-tick) ${f3(fRunPeakSum / Math.max(1, fRunPeakN))} · 2 s-sampled peak-of-element ${f3(fPeakSum / Math.max(1, fSamp))}`);
  console.log(`            pinned: ${(100 * fPinned / Math.max(1, fPinDen)).toFixed(1)}% of man-samples · ${fEverPinnedSeeds}/${contacts} contacts had a man pinned (supp>0.5)   <-- honest friendly reads`);
  console.log(`  ENEMY:    element-avg ${f3(eMeanSum / Math.max(1, eSamp))} · 2 s-sampled peak-of-element ${f3(ePeakSum / Math.max(1, eSamp))} · per-contact max (per-tick) ${f3(eRunPeakSum / Math.max(1, eRunPeakN))}   <-- the patrol's return fire suppresses BOTH sides`);
}

if (which === "all" || which === "ballistics") ballisticsProbe();
if (which === "all" || which === "engagement") engagementProbe();
if (which === "all" || which === "perception") perceptionProbe();
if (which === "all" || which === "saveload") saveloadProbe();
if (which === "all" || which === "ied") iedProbe();
if (which === "all" || which === "assault") assaultProbe();
if (which === "all" || which === "wind") windProbe();
if (which === "all" || which === "indirect") indirectProbe();
if (which === "all" || which === "coin") coinProbe();
if (which === "all" || which === "medical") medicalProbe();
if (which === "all" || which === "load") loadProbe();
if (which === "all" || which === "rescue") rescueProbe();
if (which === "all" || which === "stance-mix") stanceMixProbe();
if (which === "all" || which === "shoot-and-scoot") shootScootProbe();
if (which === "all" || which === "enemy-geometry") enemyGeometryProbe();
if (which === "all" || which === "suppression-twosided") suppressionTwosidedProbe();
