/**
 * logistics-probe — issue 021 (logistics teeth): do low supplies actually BITE? Before this pass,
 * water/batteries/medical drained to a floor with zero consequence. Now (bounded clamps):
 *   - batteries → the US night-vision edge (combat.ts: nvg gated on supplies.batteries)
 *   - water/food → rest + fatigue recovery rate (world.ts tickSoldiers)
 *   - medical → wound-recovery time (world.ts)
 *
 * It measures each as a FULL-vs-DEPLETED delta. A neglected resupply must measurably hurt; a stocked
 * COP must not. Bounded so a degenerate value never zeroes recovery.
 *
 * Run: npx tsx scripts/logistics-probe.ts
 */
import { createWorld } from "../lib/sim/world";
import { detectionChance, lineOfSight, LOSResult } from "../lib/sim/los";

// --- 1. batteries -> NODs: the night detection advantage NVG buys, by range -----------------------
function nvgEdge() {
  const flat = (r: number): LOSResult => ({ visible: true, exposure: 1, terrainExposure: 1, terrainBlocked: false, concealment: 0, vegConceal: 0, smokeConceal: 0, rangeM: r } as any);
  console.log("[1] batteries → NODs — night (light 0.05) detect chance vs a non-firing mover:");
  console.log("    range |  NVG (batt OK) | naked-eye (batt DEAD) | edge");
  for (const r of [50, 100, 150, 200]) {
    const base: any = { los: flat(r), light: 0.05, targetMoving: true, targetFiring: false, targetProne: false, observerOpticRangeM: 300, alertness: 0.6 };
    const nvg = detectionChance({ ...base, observerNVG: true });
    const naked = detectionChance({ ...base, observerNVG: false });
    console.log(`    ${String(r).padStart(4)}m |  ${nvg.toFixed(3)}        |  ${naked.toFixed(3)}                | ${(nvg / Math.max(1e-4, naked)).toFixed(1)}x`);
  }
  // end-to-end gate: the sim's nvgPower follows supplies.batteries, and NVG dies below the reserve
  const w: any = createWorld("survey-2", 90);
  w.state.supplies.batteries = 2; w.tick(0.1);
  console.log(`    end-to-end: supplies.batteries=2 → sim.nvgPower=${w.sim.nvgPower} (NODs ${w.sim.nvgPower > 8 ? "ON" : "DARK — naked eye"})`);
}

// --- 2. water/food -> fatigue recovery; 3. medical -> wound recovery -------------------------------
// Tick a soldier at base for 2 game-hours under FULL vs DEPLETED supplies; measure recovery.
function recoveryDelta() {
  const HOURS = 2;
  function fatigueRecovered(water: number, food: number) {
    const w: any = createWorld("survey-2", 90);
    const m = w.platoon.members.find((x: any) => x.alive)!;
    m.fatigue = 0.6; m.moving = false; m.pos = { ...w.copWorld() };
    w.state.supplies.water = water; w.state.supplies.food = food;
    const f0 = m.fatigue;
    // SHORT window — stationary fatigue recovery (combat.ts) is fast (~0.01/s), so measure the RATE
    // before it saturates: 40 game-seconds. Keep the man stationary and the supplies pinned.
    for (let t = 0; t < 400; t++) { m.moving = false; w.tick(0.1); w.state.supplies.water = water; w.state.supplies.food = food; }
    return f0 - m.fatigue; // fatigue burned off in 40 s
  }
  function woundDaysHealed(medical: number) {
    const w: any = createWorld("survey-2", 90);
    const m = w.platoon.members.find((x: any) => x.alive)!;
    m.status = "wounded"; m.daysToRecover = 5;
    w.state.supplies.medical = medical;
    const d0 = m.daysToRecover;
    for (let t = 0; t < HOURS * 36000; t++) { w.tick(0.1); w.state.supplies.medical = medical; if (m.status !== "wounded") break; }
    return d0 - m.daysToRecover; // days of recovery accrued in 2 h
  }
  const fFull = fatigueRecovered(520, 480), fLow = fatigueRecovered(20, 20);
  const mFull = woundDaysHealed(36), mLow = woundDaysHealed(1);
  console.log(`\n[2] water/food → fatigue recovery (40 s stationary): FULL ${fFull.toFixed(3)}  vs  DEPLETED ${fLow.toFixed(3)}  (${(fLow / Math.max(1e-4, fFull) * 100).toFixed(0)}% — a dehydrated soldier shakes off fatigue slower)`);
  console.log(`[3] medical → wound recovery (2 h): FULL ${mFull.toFixed(3)} days  vs  DEPLETED ${mLow.toFixed(3)} days  (${(mLow / mFull * 100).toFixed(0)}% — wounds heal slower without supplies)`);
}

nvgEdge();
recoveryDelta();
console.log("\nAll three couplings are BOUNDED clamps (recovery never reaches 0). A stocked COP ≈ full rate.");
