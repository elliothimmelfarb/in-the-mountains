/**
 * FIRE-MISSION QUALITY PROBE — does the squad-combat AI call for fire like a real JTAC/FO?
 *
 * Metricizes the complaint: "a squad called a mission much too close to them, nowhere
 * near the enemy." Drives N deployments into contact, intercepts every AI call-for-fire
 * at raise-time, and measures the aimpoint against ground truth:
 *
 *   d_friendly      m to the NEAREST live US/ANA soldier  (small = self-endangerment)
 *   d_enemy_seen    m to the nearest CURRENTLY-OBSERVED enemy (large = "nowhere near enemy")
 *   d_enemy_alive   m to the nearest living enemy (sanity)
 *   dangerClose%    requests whose aimpoint is inside the weapon's danger-close radius (blast*2.5)
 *   onFriendlies%   requests whose aimpoint is inside the LETHAL blast radius of a friendly
 *   projection%     requests with NO enemy visible to the squad (fired on a guessed grid)
 *   offTarget%      requests whose aimpoint is >60 m from the nearest observed enemy
 *
 * In approve mode it also auto-clears every request and counts US fratricide
 * (US soldiers wounded/killed with casualtyByFaction === "us").
 *
 * Columns: per-seed request count + the aggregate table at the end.
 * Run: npx tsx scripts/fire-mission-probe.ts [seeds=40] [minutes=45] [deny|approve]
 */
import { createWorld } from "../lib/sim/world";
import { getWeapon } from "../lib/sim/weapons";
import type { SquadSOP } from "../lib/sim/world/types";

const SEEDS = Number(process.argv[2] ?? 40);
const MINUTES = Number(process.argv[3] ?? 45);
const MODE = (process.argv[4] ?? "deny") as "deny" | "approve";
const PREFIX = process.argv[5] ?? "bal"; // seed family — use a different prefix for held-out valleys

interface Sample {
  seed: string;
  weaponId: string;
  squadState: string;
  dFriendly: number;
  dEnemySeen: number; // Infinity if none visible
  dEnemyAlive: number;
  blast: number;
  dcRadius: number;
  dangerClose: boolean;
  onFriendlies: boolean;
  projection: boolean;
}

const samples: Sample[] = [];
let usFratricide = 0;

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

for (let run = 0; run < SEEDS; run++) {
  const seed = `${PREFIX}-${run}`;
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.62 + (run % 5) * 0.06;

  const cop = terrain.copCell;
  const v = terrain.villages[run % terrain.villages.length];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  // Mix postures so we exercise both the "SOP wants fires" (suppress) path and the
  // "pinned, losing ground" path. Even runs suppress, odd runs hold.
  const sop: SquadSOP = { movement: "patrol", contact: run % 2 === 0 ? "suppress" : "hold", roe: "tight" };
  world.formPatrol(
    ids,
    [
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    "presence",
    "tactical",
    sop
  );
  state.nextActivityAt = 0;

  let seenReqClock = state.lastFireReqClock ?? -1e9;
  let reqs = 0;
  const ticks = MINUTES * 600;
  for (let t = 0; t < ticks && !state.ended; t++) {
    world.tick(0.1);
    const fr = state.fireRequest;
    if (fr && (state.lastFireReqClock ?? -1e9) > seenReqClock) {
      seenReqClock = state.lastFireReqClock ?? seenReqClock;
      reqs++;
      const aim = terrain.cellCenter(fr.cx, fr.cy);
      const task = state.tasks.find((tk) => tk.id === fr.taskId);
      const live = sim.playerUnits();
      const enemies = sim.livingEnemies();
      // enemies currently observed by the requesting squad
      const seenIds = new Set<string>();
      if (task) for (const mid of task.memberIds) {
        const m = sim.unit(mid);
        if (m) for (const eid of m.visibleEnemyIds) seenIds.add(eid);
      }
      const dFriendly = live.length ? Math.min(...live.map((u) => dist(aim, u.pos))) : Infinity;
      const dEnemyAlive = enemies.length ? Math.min(...enemies.map((e) => dist(aim, e.pos))) : Infinity;
      const seenEnemies = enemies.filter((e) => seenIds.has(e.id));
      const dEnemySeen = seenEnemies.length ? Math.min(...seenEnemies.map((e) => dist(aim, e.pos))) : Infinity;
      const weapon = getWeapon(fr.weaponId);
      const blast = weapon.blastRadius ?? 15;
      const dcRadius = blast * 2.5;
      samples.push({
        seed, weaponId: fr.weaponId, squadState: task?.squadState ?? "?",
        dFriendly, dEnemySeen, dEnemyAlive, blast, dcRadius,
        dangerClose: dFriendly < dcRadius,
        onFriendlies: dFriendly < blast,
        projection: seenIds.size === 0,
      });
      if (MODE === "approve") world.approveFireRequest();
      else world.denyFireRequest();
    }
  }
  if (MODE === "approve") {
    usFratricide += world.platoon.members.filter(
      (m) => (!m.alive || m.wounds.length > 0) && m.casualtyByFaction === "us"
    ).length;
  }
  // Cumulative aggregate after EVERY seed so an early kill still yields usable numbers.
  const cN = samples.length;
  const cdc = samples.filter((s) => s.dangerClose).length;
  const conF = samples.filter((s) => s.onFriendlies).length;
  const cproj = samples.filter((s) => s.projection).length;
  const coff = samples.filter((s) => !Number.isFinite(s.dEnemySeen) || s.dEnemySeen > 60).length;
  process.stdout.write(
    `${seed}: ${reqs} req${reqs === 1 ? "" : "s"}  | cum N=${cN} dc=${pct(cdc, cN)} onF=${pct(conF, cN)} proj=${pct(cproj, cN)} off=${pct(coff, cN)} medFr=${med(samples.map((s) => s.dFriendly)).toFixed(0)}m medEn=${med(samples.map((s) => s.dEnemySeen)).toFixed(0)}m${MODE === "approve" ? ` fratricide=${usFratricide}` : ""}\n`
  );
}

// ----------------------------------------------------------------- aggregate
function pct(n: number, d: number) { return d ? ((100 * n) / d).toFixed(0) + "%" : "—"; }
function med(xs: number[]) {
  const f = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return f.length ? f[Math.floor(f.length / 2)] : NaN;
}
function mean(xs: number[]) {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

const N = samples.length;
const dc = samples.filter((s) => s.dangerClose).length;
const onF = samples.filter((s) => s.onFriendlies).length;
const proj = samples.filter((s) => s.projection).length;
const off = samples.filter((s) => !Number.isFinite(s.dEnemySeen) || s.dEnemySeen > 60).length;
const noSeen = samples.filter((s) => !Number.isFinite(s.dEnemySeen)).length;
// Tick-robust "nowhere near the enemy": >60 m from the nearest LIVING enemy (any LOS). Immune to
// the ±1-tick perception artifact where PID existed at decision time but dropped by end-of-tick.
const offLive = samples.filter((s) => !Number.isFinite(s.dEnemyAlive) || s.dEnemyAlive > 60).length;

console.log("\n================ FIRE-MISSION QUALITY (HEAD) ================");
console.log(`mode=${MODE}  seeds=${SEEDS}  minutes=${MINUTES}  requests=${N}`);
if (N) {
  console.log(`d_friendly   median ${med(samples.map((s) => s.dFriendly)).toFixed(0)}m  mean ${mean(samples.map((s) => s.dFriendly)).toFixed(0)}m  min ${Math.min(...samples.map((s) => s.dFriendly)).toFixed(0)}m`);
  console.log(`d_enemy_seen median ${med(samples.map((s) => s.dEnemySeen)).toFixed(0)}m  mean ${mean(samples.map((s) => s.dEnemySeen)).toFixed(0)}m`);
  console.log(`d_enemy_live median ${med(samples.map((s) => s.dEnemyAlive)).toFixed(0)}m`);
  console.log(`dangerClose% ${pct(dc, N)}  (${dc}/${N})   aimpoint inside blast*2.5 of a friendly`);
  console.log(`onFriendlies%${pct(onF, N)}  (${onF}/${N})   aimpoint inside LETHAL blast of a friendly`);
  console.log(`projection%  ${pct(proj, N)}  (${proj}/${N})   no enemy visible to the squad`);
  console.log(`offTarget%   ${pct(off, N)}  (${off}/${N})   >60m from nearest observed enemy (incl. none-seen=${noSeen})`);
  console.log(`offLive%     ${pct(offLive, N)}  (${offLive}/${N})   >60m from nearest LIVING enemy (tick-robust)`);
  // posture breakdown
  const byState = new Map<string, number>();
  for (const s of samples) byState.set(s.squadState, (byState.get(s.squadState) ?? 0) + 1);
  console.log("by squadState:", [...byState.entries()].map(([k, v]) => `${k}:${v}`).join("  "));
  if (MODE === "approve") console.log(`US fratricide casualties: ${usFratricide}`);
}
console.log("============================================================");
