/**
 * tic-release-probe — issue 025: the TIC latch must release when the fight is decided.
 *
 * Marches sq1+medic out the gate, then forces the enemy DIRECTOR (the live-repro recipe:
 * nextActivityAt=now) until it stages a real fight cell — shared squadId + leader, so the
 * cell-combat brain breaks contact the way live fights do. Denies every call-for-fire and
 * measures how long the TIC latch outlives the DECIDED fight:
 *
 *   tDecided   first sim-s where every staged fighter is dead/evac or brainState "exfil",
 *              no insurgent round is in flight, and all squad suppression < 0.3
 *   lastShot   last sim-s an insurgent projectile spawned
 *   relSquad   seconds AFTER tDecided until t.squadState clears (releaseCombat ran —
 *              the consolidate beat can begin)
 *   relGlobal  seconds AFTER tDecided until world.inContact() goes false (the store's
 *              1× TIC speed latch reads this)
 *   cffAfter   call-for-fire requests RAISED after tDecided (each denied on sight)
 *   blockers   while release is pending: visible staged enemies (n, min dist m, states)
 *
 * Target (issue 025): release ≤25 s (contactHold 10 s + THREAT_RECENT_S 15 s) after
 * max(tDecided, lastShot) — a parting shot legitimately re-holds; never minutes.
 * Run: npx tsx scripts/tic-release-probe.ts [seedPrefix] [nSeeds] [maxMin]
 *      (TICDBG=1 prints per-attempt director staging; tune set "tic", held-out "tichold")
 */
import { createWorld } from "../lib/sim/world";
import type { World } from "../lib/sim/world";
import type { Unit } from "../lib/sim/entities";

const PREFIX = process.argv[2] ?? "tic";
const N_SEEDS = Number(process.argv[3] ?? 12);
const MAX_MIN = Number(process.argv[4] ?? 35);
const SIM_DT = 0.1;

/**
 * Mover-faithful staging (the issue-025 live repro): march sq1 out, then force the enemy
 * activity DIRECTOR (enemyHeat + nextActivityAt=now) until it stages a real fight cell —
 * shared squadId + a leader, so the cell-combat coordinator runs and the cell BREAKS the
 * way live fights do (a leaderless hand-spawned mob never collectively exfils). Non-fight
 * spawns (infiltration, complex attack on the COP) are evac'd so they can't hold the
 * global inContact() from somewhere else on the map.
 */
function stageFight(seed: string): { world: World; staged: string[] } | null {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.5;
  const cop = terrain.copCell;
  const v = terrain.villages[0];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  world.formPatrol(
    ids,
    [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
    "presence",
    "tactical",
  );
  // march until the patrol is genuinely outside the wire (assembling phase returns a
  // null centroid and the director won't target it) — cap 10 game-min
  const copW = terrain.cellCenter(cop.cx, cop.cy);
  for (let i = 0; i < 6000; i++) {
    world.tick(SIM_DT);
    const c = world.activePatrolCentroid();
    if (c && Math.hypot(c.x - copW.x, c.y - copW.y) > 130) break;
  }
  const known = new Set(sim.units.map((u) => u.id));
  for (let attempt = 0; attempt < 40; attempt++) {
    state.nextActivityAt = state.clock; // fire the director now
    for (let i = 0; i < 30; i++) world.tick(SIM_DT);
    const fresh = sim.units.filter((u) => u.faction === "insurgent" && !known.has(u.id));
    for (const u of fresh) known.add(u.id);
    const c = world.activePatrolCentroid();
    if (process.env.TICDBG)
      console.log(
        `  [${seed} a${attempt}] clock=${state.clock.toFixed(0)} night=${world.isNight()} fresh=${fresh.length}` +
          (fresh.length && c ? ` states=${[...new Set(fresh.map((u) => u.brainState))].join(",")} d=${fresh.map((u) => Math.hypot(u.pos.x - c.x, u.pos.y - c.y).toFixed(0)).join("/")}` : ` centroid=${c ? "ok" : "NULL"}`),
      );
    if (fresh.length === 0) continue;
    const isFight =
      c !== null &&
      fresh.some((u) => (u.brainState === "engage" || u.brainState === "ambush") && Math.hypot(u.pos.x - c.x, u.pos.y - c.y) < 450);
    if (!isFight) {
      for (const u of fresh) u.evac = true; // infiltrators / COP attackers: off the measurement
      continue;
    }
    // the fight cell is staged — freeze the director so nothing else spawns mid-measurement
    state.enemyHeat = 0;
    state.nextActivityAt = 1e9;
    return { world, staged: fresh.map((u) => u.id) };
  }
  return null;
}

interface Row {
  seed: string;
  tDecided: number | null;
  lastShot: number;
  relSquad: number | null;
  relGlobal: number | null;
  cffAfter: number;
  ticEdges: number; // rising edges of world.inContact() across the WHOLE run — flicker guard
  blockN: number;
  blockMinD: number | null;
  blockStates: string;
  endState: string;
}

function runSeed(seed: string): Row | null {
  const stagedFight = stageFight(seed);
  if (!stagedFight) return null;
  const { world, staged } = stagedFight;
  const { sim } = world;
  const task = world.state.tasks[0];
  const stagedSet = new Set(staged);
  let lastShot = -1;
  let tDecided: number | null = null;
  let relSquad: number | null = null;
  let relGlobal: number | null = null;
  let cffAfter = 0;
  let hadFireReq = false;
  let ticEdges = 0;
  let prevContact = false;
  const blockStates = new Map<string, number>();
  let blockN = 0;
  let blockMinD: number | null = null;
  let blockTicks = 0;

  const maxTicks = Math.round((MAX_MIN * 60) / SIM_DT);
  const knownProj = new Set<string>();
  for (let i = 0; i < maxTicks; i++) {
    world.tick(SIM_DT);
    const t = world.state.clock;

    for (const p of sim.projectiles) {
      if (knownProj.has(p.id)) continue;
      knownProj.add(p.id);
      if (p.faction === "insurgent") lastShot = t;
    }

    const fighters = staged.map((id) => sim.unit(id)).filter((u): u is Unit => !!u);
    const liveFighters = fighters.filter((u) => u.alive && !u.evac);
    const members = task.memberIds.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);

    const nowContact = world.inContact();
    if (nowContact && !prevContact) ticEdges++;
    prevContact = nowContact;

    if (tDecided === null) {
      const allBroken = liveFighters.every((u) => u.brainState === "exfil");
      const noEnemyRounds = !sim.projectiles.some((p) => p.faction === "insurgent");
      const calm = members.every((m) => m.suppression < 0.3);
      if (allBroken && noEnemyRounds && calm) {
        tDecided = t;
        // a request already pending at the decision tick is the FIGHT's ask, not a re-raise
        hadFireReq = !!world.state.fireRequest;
      }
    } else {
      // count CFF re-raises on the decided fight; deny like the live repro did
      if (world.state.fireRequest && !hadFireReq) cffAfter++;
      hadFireReq = !!world.state.fireRequest;
      if (world.state.fireRequest) world.denyFireRequest();

      if (relSquad === null && !task.squadState) relSquad = t - tDecided;
      if (relGlobal === null && !world.inContact()) relGlobal = t - tDecided;
      if (relSquad === null || relGlobal === null) {
        // what's holding it: staged enemies inside someone's visibleEnemyIds
        blockTicks++;
        const visIds = new Set<string>();
        for (const m of members) for (const id of m.visibleEnemyIds) if (stagedSet.has(id)) visIds.add(id);
        blockN = Math.max(blockN, visIds.size);
        for (const id of visIds) {
          const e = sim.unit(id);
          if (!e) continue;
          blockStates.set(e.brainState, (blockStates.get(e.brainState) ?? 0) + 1);
          const dmin = Math.min(...members.map((m) => Math.hypot(m.pos.x - e.pos.x, m.pos.y - e.pos.y)));
          blockMinD = blockMinD === null ? dmin : Math.min(blockMinD, dmin);
        }
      }
      if (relSquad !== null && relGlobal !== null && t - tDecided > 30) break; // both released; margin observed
    }
  }
  const live = staged.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
  const endState = `live:${live.length}(${[...new Set(live.map((u) => u.brainState))].join(",")})`;
  return {
    seed, tDecided, lastShot, relSquad, relGlobal, cffAfter, ticEdges, blockN, blockMinD,
    blockStates: [...blockStates.keys()].join(","), endState,
  };
}

const rows: Row[] = [];
for (let s = 0; s < N_SEEDS; s++) {
  const r = runSeed(`${PREFIX}-${s}`);
  if (r) rows.push(r);
  else console.log(`${PREFIX}-${s}: no fight staged in 40 director attempts — skipped`);
}

const f = (v: number | null) => (v === null ? "NEVER" : v.toFixed(0));
console.log("seed        tDecided lastShot relSquad relGlobal cff edges blockN minD  states      end");
for (const r of rows) {
  console.log(
    `${r.seed.padEnd(11)} ${f(r.tDecided).padStart(8)} ${r.lastShot.toFixed(0).padStart(8)} ${f(r.relSquad).padStart(8)} ${f(r.relGlobal).padStart(9)} ${String(r.cffAfter).padStart(3)} ${String(r.ticEdges).padStart(5)} ${String(r.blockN).padStart(6)} ${(r.blockMinD === null ? "-" : r.blockMinD.toFixed(0)).padStart(4)}  ${r.blockStates.padEnd(11)} ${r.endState}`,
  );
}
const decided = rows.filter((r) => r.tDecided !== null);
// score from the LAST hostile shot if it landed after tDecided — a parting shot while
// fleeing legitimately re-holds contact for THREAT_RECENT_S; that's behavior, not bug
const adj = (r: Row, rel: number | null) =>
  rel === null ? MAX_MIN * 60 : Math.max(0, rel - Math.max(0, r.lastShot - (r.tDecided ?? 0)));
const sq = decided.map((r) => adj(r, r.relSquad));
const gl = decided.map((r) => adj(r, r.relGlobal));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const TARGET = 25; // s — contactHold 10 s + ~15 s margin (issue 025)
console.log(`\ndecided fights: ${decided.length}/${rows.length}`);
console.log(`relSquad  mean ${mean(sq).toFixed(0)} s  max ${Math.max(...sq).toFixed(0)} s  >target(${TARGET}s): ${sq.filter((x) => x > TARGET).length}/${sq.length}`);
console.log(`relGlobal mean ${mean(gl).toFixed(0)} s  max ${Math.max(...gl).toFixed(0)} s  >target(${TARGET}s): ${gl.filter((x) => x > TARGET).length}/${gl.length}`);
console.log(`CFF re-raises after decided: ${rows.reduce((a, r) => a + r.cffAfter, 0)}`);
console.log(`TIC rising edges/fight (flicker guard): mean ${mean(rows.map((r) => r.ticEdges)).toFixed(1)}  max ${Math.max(...rows.map((r) => r.ticEdges))}`);
