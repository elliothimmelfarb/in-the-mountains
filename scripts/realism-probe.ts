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

    let firstDet = -1, sawContact = false;
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
      // suppression telemetry on the patrol, sampled every 2 s while in contact
      if (sawContact && t % 20 === 0) {
        let peak = 0, sum = 0, n = 0;
        for (const id of ids) {
          const u = sim.unit(id);
          if (u && u.alive) { peak = Math.max(peak, u.suppression); sum += u.suppression; n++; }
        }
        if (n) { peakSuppSum += peak; meanSuppSum += sum / n; suppSamples++; }
      }
    }
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
  const scenes = [
    { label: "day,  open,   400m", light: 1.0, exposure: 1.0, conceal: 0.0, range: 400 },
    { label: "day,  forest, 300m", light: 1.0, exposure: 0.55, conceal: 0.7, range: 300 },
    { label: "dusk, open,   400m", light: 0.35, exposure: 1.0, conceal: 0.0, range: 400 },
    { label: "night,open,   300m", light: 0.05, exposure: 1.0, conceal: 0.0, range: 300 },
    { label: "night,forest, 250m", light: 0.05, exposure: 0.6, conceal: 0.7, range: 250 },
  ];
  console.log("\n=== PERCEPTION: per-moment detect p / expected seconds-to-detect, by sensor ===");
  console.log("target: stationary, not firing, standing; observer optic 800 m, alert 0.7\n");
  const head = "  scene                  " + sensors.map((s) => s.name.padStart(11)).join("  ");
  console.log(head);
  for (const sc of scenes) {
    const los = { visible: true, exposure: sc.exposure, terrainBlocked: false, concealment: sc.conceal, rangeM: sc.range };
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

if (which === "all" || which === "ballistics") ballisticsProbe();
if (which === "all" || which === "engagement") engagementProbe();
if (which === "all" || which === "perception") perceptionProbe();
if (which === "all" || which === "wind") windProbe();
