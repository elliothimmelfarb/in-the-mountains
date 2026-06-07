/**
 * RESEARCH ARTIFACT (item 2 — squad combat tactics). Drives deployments into contact and
 * samples, every in-contact tick, how many squad members are MANEUVERING (moving / bounding /
 * withdrawing / fragging) vs HOLDING (base of fire). Metricizes the complaint: "the whole squad
 * sits back on a base of fire and only one man moves." Mirrors scripts/fire-mission-probe.ts's
 * contact-driving. Read/measure only; prints a table. No game-system changes.
 *
 * Run: npx tsx docs/progress/2026-06-07-realism-research/tools/gen-combat-movers.ts [seeds] [minutes]
 */
import { createWorld } from "../../../../lib/sim/world";
import type { SquadSOP } from "../../../../lib/sim/world/types";

const SEEDS = Number(process.argv[2] ?? 16);
const MINUTES = Number(process.argv[3] ?? 35);
const HEAT = Number(process.argv[4] ?? 0.7); // enemy tempo: ~0.3 = a lighter contact, ~0.7 = a hot, overmatched fight

const MANEUVER = new Set(["moving", "withdrawing", "assaulting", "moving_assault", "fragging", "suppressed_halt"]);

function runSop(label: string, contact: "hold" | "suppress" | "assault") {
  let inContactSamples = 0;
  let maneuverManTicks = 0;
  let holdManTicks = 0;
  let liveManTicks = 0;
  const maneuverPerTick: number[] = [];
  const fixMovers: number[] = []; // men moving while the squad is FIXING (hold/suppress/assault), not breaking
  const stateCount: Record<string, number> = {};

  for (let run = 0; run < SEEDS; run++) {
    const seed = `movers-${run}`;
    const world: any = createWorld(seed, 90);
    const { terrain, state, sim } = world;
    state.enemyHeat = HEAT + (run % 5) * 0.02;
    const cop = terrain.copCell;
    const v = terrain.villages[run % terrain.villages.length];
    const sq = world.platoon.squads.find((s: any) => s.id === "sq1");
    const ids = [...sq.memberIds];
    const sop: SquadSOP = { movement: "patrol", contact, roe: "tight" };
    world.formPatrol(
      ids,
      [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
      "presence",
      "tactical",
      sop
    );
    state.nextActivityAt = 0;

    const ticks = MINUTES * 600;
    for (let tk = 0; tk < ticks && !state.ended; tk++) {
      world.tick(0.1);
      const task = state.tasks.find((x: any) => ids.includes(x.memberIds?.[0]) || x.label === sq.name);
      const t = state.tasks.find((x: any) => x.memberIds && x.memberIds.some((id: string) => ids.includes(id)));
      const tt = t ?? task;
      if (!tt) continue;
      const members = tt.memberIds.map((id: string) => sim.unit(id)).filter((u: any) => u && u.alive && u.conscious);
      if (!members.length) continue;
      const inContact = (tt.contactHold ?? 0) > 0 || members.some((m: any) => m.visibleEnemyIds.length > 0 || m.suppression > 0.2);
      if (!inContact) continue;
      // sample every 5 ticks (0.5 s) to decorrelate
      if (tk % 5 !== 0) continue;
      inContactSamples++;
      stateCount[tt.squadState ?? "?"] = (stateCount[tt.squadState ?? "?"] ?? 0) + 1;
      let mv = 0;
      for (const m of members) {
        liveManTicks++;
        const moving = MANEUVER.has(m.brainState) || (m.moving && m.path && m.path.length > 0);
        if (moving) { mv++; maneuverManTicks++; } else holdManTicks++;
      }
      maneuverPerTick.push(mv);
      const st = tt.squadState ?? "";
      if (st === "hold" || st === "suppress" || st === "assault") fixMovers.push(mv);
    }
  }
  maneuverPerTick.sort((a, b) => a - b);
  const mean = maneuverPerTick.reduce((a, b) => a + b, 0) / Math.max(1, maneuverPerTick.length);
  const p50 = maneuverPerTick[Math.floor(maneuverPerTick.length * 0.5)] ?? 0;
  const p90 = maneuverPerTick[Math.floor(maneuverPerTick.length * 0.9)] ?? 0;
  const anyMoving = maneuverPerTick.filter((n) => n > 0).length / Math.max(1, maneuverPerTick.length);
  console.log(`\n── contact SOP: ${label} ──`);
  console.log(`in-contact samples: ${inContactSamples}   live man-samples: ${liveManTicks}`);
  console.log(`MEAN men maneuvering at once: ${mean.toFixed(2)}   (median ${p50}, p90 ${p90})`);
  console.log(`fraction of maneuvering man-ticks: ${(100 * maneuverManTicks / Math.max(1, liveManTicks)).toFixed(1)}%   holding: ${(100 * holdManTicks / Math.max(1, liveManTicks)).toFixed(1)}%`);
  console.log(`fraction of in-contact ticks with ANY man moving: ${(100 * anyMoving).toFixed(1)}%`);
  const fixMean = fixMovers.reduce((a, b) => a + b, 0) / Math.max(1, fixMovers.length);
  console.log(`WHILE FIXING (hold/suppress/assault, not breaking): ${fixMovers.length} samples, MEAN men moving ${fixMean.toFixed(2)}  ← the "sit + few move" regime`);
  console.log(`squadState distribution: ${Object.entries(stateCount).map(([k, n]) => `${k}:${(100 * n / Math.max(1, inContactSamples)).toFixed(0)}%`).join("  ")}`);
}

console.log(`movers probe — ${SEEDS} seeds × ${MINUTES} min, default ROE tight`);
runSop("hold (the census/presence/cordon DEFAULT)", "hold");
runSop("suppress (the overwatch/ambush default)", "suppress");
runSop("assault (only if the player explicitly picks it)", "assault");
