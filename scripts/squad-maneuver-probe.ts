/**
 * squad-maneuver-probe — does the squad LEADER autonomously commit a maneuver fire team and
 * flank, or does the whole squad sit on a base of fire while one man shuffles?
 *
 * Metricizes Workstream 2 (soldier-scale realism). Drives deployments into contact and samples,
 * every in-contact tick, for each contact SOP (hold / suppress / assault):
 *   - squadState distribution — how much in-contact time is spent assaulting vs holding vs breaking
 *   - MEAN men maneuvering while FIXING (hold/suppress/assault states, not break) — the "sit + a
 *     couple shuffle" metric; the WS2 target is a fire team (~3–4) bounding when it commits
 *   - bounding discipline — of the ticks the maneuver element is moving, the fraction where only
 *     one buddy pair (≤ half the maneuver team) is moving at once (real bounding overwatch)
 *   - flank-cover ratio — mean cover along the maneuver team's actual route ÷ mean cover along the
 *     straight line to the threat centroid; > 1 means it found a COVERED flank, not a frontal rush
 *
 * SOP-as-lever: on HEAD hold≈suppress≈assault (cosmetic) and the squad NEVER autonomously flanks.
 * The WS2 win is assault > hold on maneuver, hold STILL flanks autonomously when clearly favorable,
 * and flank-cover ratio > 1.
 *
 * Run: npx tsx scripts/squad-maneuver-probe.ts [seeds] [minutes] [heat]
 */
import { createWorld } from "../lib/sim/world";
import type { SquadSOP } from "../lib/sim/world";
import type { Unit } from "../lib/sim/entities";
import type { Vec2 } from "../lib/sim/vec";

type CoverTerrain = { coverAt(x: number, y: number): number };

const SEEDS = Number(process.argv[2] ?? 10);
const MINUTES = Number(process.argv[3] ?? 22);
const HEAT = Number(process.argv[4] ?? 0.45); // 0.3 light, 0.45 even, 0.7 hot/overmatched

const MANEUVER = new Set(["moving", "withdrawing", "assaulting", "moving_assault", "fragging", "suppressed_halt"]);
const FIXING = new Set(["hold", "suppress", "assault"]);
// Only these are real squad-combat states — exclude the post-contact patrol-resume tail (squadState
// undefined while contactHold lingers), which would otherwise count the whole squad WALKING as
// "maneuvering" and pollute the metric.
const COMBAT = new Set(["react", "hold", "suppress", "assault", "break"]);

function coverAlong(terrain: CoverTerrain, a: Vec2, b: Vec2): number {
  const steps = 8;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const p = { x: a.x + (b.x - a.x) * (i / steps), y: a.y + (b.y - a.y) * (i / steps) };
    sum += terrain.coverAt(p.x, p.y);
  }
  return sum / (steps + 1);
}
function coverAlongPath(terrain: CoverTerrain, start: Vec2, path: Vec2[]): number {
  if (!path || path.length === 0) return terrain.coverAt(start.x, start.y);
  let sum = 0, segs = 0, from = start;
  for (const wp of path) { sum += coverAlong(terrain, from, wp); segs++; from = wp; }
  return sum / Math.max(1, segs);
}

function runSop(label: string, contact: "hold" | "suppress" | "assault") {
  let samples = 0;
  const maneuverPerTick: number[] = [];
  const fixMovers: number[] = [];
  const stateCount: Record<string, number> = {};
  let boundOneElem = 0, boundSamples = 0;
  let flankSet = 0, frontalSet = 0;
  const flankRatios: number[] = []; // route vs straight-line cover, flanking ticks only

  for (let run = 0; run < SEEDS; run++) {
    const world = createWorld(`mnvr-${run}`, 90);
    const { terrain, state, sim } = world;
    state.enemyHeat = HEAT + (run % 5) * 0.02;
    const cop = terrain.copCell;
    const v = terrain.villages[run % terrain.villages.length];
    const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
    const ids = [...sq.memberIds];
    const sop: SquadSOP = { movement: "patrol", contact, roe: "tight" };
    world.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical", sop);
    state.nextActivityAt = 0;

    const ticks = MINUTES * 600;
    for (let tk = 0; tk < ticks && !state.ended; tk++) {
      world.tick(0.1);
      const t = state.tasks.find((x) => x.memberIds && x.memberIds.some((id) => ids.includes(id)));
      if (!t) continue;
      const members = t.memberIds.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && u.conscious);
      if (!members.length) continue;
      const inContact = (t.contactHold ?? 0) > 0 || members.some((m) => m.visibleEnemyIds.length > 0 || m.suppression > 0.2);
      if (!inContact || tk % 5 !== 0) continue;
      samples++;
      const st = t.squadState ?? "?";
      stateCount[st] = (stateCount[st] ?? 0) + 1;
      if (!COMBAT.has(st)) continue; // skip the patrol-resume tail — only measure DURING the firefight
      let mv = 0;
      for (const m of members) if (MANEUVER.has(m.brainState) || (m.moving && m.path?.length > 0)) mv++;
      maneuverPerTick.push(mv);
      if (FIXING.has(st)) fixMovers.push(mv);

      // bounding discipline + flank cover (only meaningful while assaulting with a maneuver element)
      if (st === "assault" && t.mnvrIds && t.mnvrIds.length) {
        const mnvr = t.mnvrIds.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && u.conscious);
        const movingMnvr = mnvr.filter((m) => MANEUVER.has(m.brainState) && m.path?.length > 0);
        const flanking = !!t.flankPt;
        if (movingMnvr.length > 0) {
          boundSamples++;
          if (movingMnvr.length <= Math.ceil(mnvr.length / 2)) boundOneElem++;
          if (flanking) flankSet++; else frontalSet++;
          // flank-cover ratio only when the leader chose a covered flank (frontal fallback is ~1 by
          // construction and would just dilute the signal we care about)
          if (flanking) {
            const threat = t.threatPt ?? { x: 0, y: 0 };
            for (const m of movingMnvr) {
              const routeCover = coverAlongPath(terrain, m.pos, m.path);
              const straightCover = coverAlong(terrain, m.pos, threat);
              if (straightCover > 0.01) flankRatios.push(routeCover / straightCover);
            }
          }
        }
      }
    }
  }

  maneuverPerTick.sort((a, b) => a - b);
  const mean = maneuverPerTick.reduce((a, b) => a + b, 0) / Math.max(1, maneuverPerTick.length);
  const fixMean = fixMovers.reduce((a, b) => a + b, 0) / Math.max(1, fixMovers.length);
  const flankMean = flankRatios.reduce((a, b) => a + b, 0) / Math.max(1, flankRatios.length);
  const pct = (n: number) => ((100 * n) / Math.max(1, samples)).toFixed(0);
  console.log(`\n── SOP: ${label} ──`);
  console.log(`  in-contact samples ${samples}`);
  console.log(`  squadState: ${Object.entries(stateCount).map(([k, n]) => `${k} ${pct(n)}%`).join("  ")}`);
  console.log(`  MEAN men maneuvering: ${mean.toFixed(2)}   while FIXING (hold/suppress/assault): ${fixMean.toFixed(2)} (${fixMovers.length} samples)`);
  console.log(`  bounding discipline: ${boundSamples ? ((100 * boundOneElem) / boundSamples).toFixed(0) : "—"}% of maneuver-moving ticks had ≤1 buddy pair moving (${boundSamples} samples)`);
  const flankPct = flankSet + frontalSet ? (100 * flankSet) / (flankSet + frontalSet) : 0;
  console.log(`  assault routing: ${flankPct.toFixed(0)}% covered-flank · ${(100 - flankPct).toFixed(0)}% frontal fallback (${flankSet}/${frontalSet})`);
  console.log(`  flank-cover ratio (flanking only): ${flankRatios.length ? flankMean.toFixed(2) : "—"} (route ÷ straight-line cover; >1 = covered) [${flankRatios.length} samples]`);
}

console.log(`squad-maneuver-probe — ${SEEDS} seeds × ${MINUTES} min, heat ~${HEAT}, ROE tight`);
runSop("hold (census/presence/cordon DEFAULT)", "hold");
runSop("suppress (overwatch/ambush default)", "suppress");
runSop("assault (player-selected)", "assault");
