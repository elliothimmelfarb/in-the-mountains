/**
 * enemy-network-probe.ts — the acceptance gate for the enemy-NETWORK wave (the persistent order of
 * battle: cells, caches, patrol-heat adaptation, exfil deposit, leader succession, village HUMINT,
 * cell-break end state). Headless, seeded, exits NON-ZERO on any failed assert.
 *
 * These are INVARIANT / DESIGN-ORACLE checks (per docs/wiki/Harnesses.md — a gate may only assert an
 * invariant or a doctrine/design oracle, never the sim's own past output). What it proves:
 *
 *   1. Determinism        — two identical same-seed runs serialize BYTE-IDENTICAL.
 *   2. Cells persist       — every director-spawned fighter belongs to one of the CREATED cells, and
 *                            the cell roster (ids) is unchanged after 3+ activities.
 *   3. Conservation        — Σ living cell strengths === enemyStrengthAbs (the derived scalar) exactly.
 *   4. Exfil conservation  — a fielded fighter is never OFF his cell's books (roster model), so a
 *                            safe exfil is NET-ZERO and a KIA is exactly −1. (The original "+1
 *                            deposit" double-counted the man and printed strength to the 80-cap
 *                            inside one hot game-day — measured 64→80 d1.)
 *   5. Cache economics     — an IED ambush spends a real cache; with every cache destroyed a cell can
 *                            no longer emplace an IED (falls back to a small-arms ambush).
 *   6. Succession          — killing the named-leader unit forces a new leaderName + reduced strength
 *                            + an intel emission naming the change, within the succession window.
 *   7. Intel truthiness    — a located report about an intelLevel ≥ 2 cell lands within the noise
 *                            radius of the TRUE home.
 *   8. Save round-trip     — serialize → loadWorld mid-activity restores cells/caches/patrolHeat and
 *                            re-serializes byte-identical.
 *
 * Run: npx tsx scripts/enemy-network-probe.ts
 */
import { createWorld, loadWorld } from "../lib/sim/world";
import { spawnIedAmbush } from "../lib/sim/world/director";
import {
  networkTotal,
  deriveEnemyStrength,
  emitNetworkHumint,
  nearestLivingCache,
  advanceNetwork,
} from "../lib/sim/world/network";
import { makeInsurgent } from "../lib/sim/entities";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// Build a valley with a squad pushed out on a presence patrol and the enemy hot — the standard
// combat/spawn driver (mirrors balance.ts / smoke.ts).
function armed(seed: string, heat = 0.75) {
  const w = createWorld(seed, 90);
  const { terrain } = w;
  const cop = terrain.copCell;
  const v = terrain.villages[0];
  const sq = w.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = w.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  w.formPatrol(ids, [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }], "presence", "tactical");
  w.state.enemyHeat = heat;
  w.state.nextActivityAt = 0;
  return w;
}

// ---------------------------------------------------------------- 1. Determinism
{
  const run = () => {
    const w = armed("net-determinism");
    for (let t = 0; t < 6000 && !w.state.ended; t++) w.tick(0.1);
    return JSON.stringify(w.serialize());
  };
  const a = run();
  const b = run();
  check("1. same-seed determinism → byte-identical serialize", a === b, `${a.length} vs ${b.length} chars`);
}

// ---------------------------------------------------------------- 2. Cells persist
{
  const w = armed("net-persist");
  const created = new Set(w.state.network.cells.map((c) => c.id));
  const createdIdsSorted = [...created].sort().join(",");
  const seenCellIds = new Set<string>();
  const activitySquads = new Set<string>(); // each director activity mints a fresh acm-<clock> squadId
  let strayCellId = false;
  for (let t = 0; t < 40000 && !w.state.ended && activitySquads.size < 5; t++) {
    w.tick(0.1);
    for (const u of w.sim.units) {
      if (u.faction !== "insurgent") continue;
      if (u.squadId && u.squadId.startsWith("acm-")) activitySquads.add(u.squadId);
      if (u.cellId) {
        seenCellIds.add(u.cellId);
        if (!created.has(u.cellId)) strayCellId = true;
      }
    }
  }
  const rosterStable = w.state.network.cells.map((c) => c.id).sort().join(",") === createdIdsSorted;
  check(
    "2. director spends the CREATED cells (≥3 activities, no stray cellIds)",
    activitySquads.size >= 3 && !strayCellId && seenCellIds.size >= 1 && rosterStable,
    `activities=${activitySquads.size}, cellIds seen=${seenCellIds.size}/${created.size}, stray=${strayCellId}, rosterStable=${rosterStable}`,
  );
}

// ---------------------------------------------------------------- 3. Conservation
{
  const w = armed("net-conserve");
  let worst = 0;
  for (let t = 0; t < 8000 && !w.state.ended; t++) {
    w.tick(0.1);
    if (t % 200 === 0) worst = Math.max(worst, Math.abs(networkTotal(w) - w.state.enemyStrengthAbs));
  }
  check("3. Σ cell strengths === enemyStrengthAbs (derived)", worst < 1e-6, `max drift ${worst.toExponential(2)}`);
}

// ---------------------------------------------------------------- 4. Exfil conservation
{
  const w = armed("net-exfil");
  for (let t = 0; t < 500; t++) w.tick(0.1); // settle
  const cell = w.state.network.cells.find((c) => !c.broken)!;
  const home = w.terrain.cellCenter(cell.homeCx, cell.homeCy);
  // A fielded fighter EXFILS home: he never left the roster, so strength must NOT move.
  const f = makeInsurgent(w.rng.fork("probe-exfil"), "fighter", home, 0.5);
  f.cellId = cell.id;
  f.evac = true; // he broke contact and reached the draws
  w.sim.addUnit(f);
  const before = cell.strength;
  w.tick(0.1); // cullEnemies removes the evac'd unit — roster unchanged
  const dExfil = cell.strength - before;
  // A second fielded fighter is KILLED: exactly −1 off the books.
  const k = makeInsurgent(w.rng.fork("probe-kia"), "fighter", home, 0.5);
  k.cellId = cell.id;
  k.alive = false;
  w.sim.addUnit(k);
  const beforeKia = cell.strength;
  w.tick(0.1);
  const dKia = cell.strength - beforeKia;
  // Tolerance: the same tick runs the per-cell recruit integrator, which accrues a tiny
  // fractional regen — allow it, reject anything near a whole fighter.
  check(
    "4. exfil is net-zero, KIA is exactly −1 (roster conservation)",
    Math.abs(dExfil) < 0.05 && dKia < -0.95 && dKia > -1.05,
    `Δexfil ${dExfil.toFixed(3)} Δkia ${dKia.toFixed(3)}`
  );
}

// ---------------------------------------------------------------- 5. Cache economics
{
  // 5a — a staged IED spends a real cache (deterministic: place a cache under the patrol and fire one).
  const w = armed("net-cache");
  for (let t = 0; t < 1500 && !w.activePatrolCentroid(); t++) w.tick(0.1);
  const patrol = w.activePatrolCentroid();
  const cell = w.state.network.cells.find((c) => !c.broken)!;
  let spent = false;
  if (patrol) {
    const cache = w.state.network.caches.find((c) => c.cellId === cell.id) ?? w.state.network.caches[0];
    // Move a live cache right onto the patrol so it is in IED range, and top it up.
    cache.cx = Math.floor(patrol.x / w.terrain.cellSize);
    cache.cy = Math.floor(patrol.y / w.terrain.cellSize);
    cache.munitions = 4;
    cache.destroyed = false;
    const before = cache.munitions;
    spawnIedAmbush(w, cell);
    spent = cache.munitions === before - 1;
  }
  check("5a. an IED ambush spends a munitions cache", spent, patrol ? "cache munitions decremented by 1" : "no patrol formed");

  // 5b — with every cache destroyed, the cell can no longer emplace an IED (falls back).
  const w2 = armed("net-cache2");
  for (let t = 0; t < 1500 && !w2.activePatrolCentroid(); t++) w2.tick(0.1);
  const patrol2 = w2.activePatrolCentroid();
  for (const c of w2.state.network.caches) c.destroyed = true;
  const cell2 = w2.state.network.cells.find((c) => !c.broken)!;
  const iedsBefore = w2.sim.ieds.length;
  const noCacheInRange = patrol2 ? nearestLivingCache(w2, patrol2, 1e9) === null : true;
  spawnIedAmbush(w2, cell2);
  const plantedNone = w2.sim.ieds.length === iedsBefore && !w2.sim.units.some((u) => u.faction === "insurgent" && u.iedInit);
  check("5b. no living cache → no IED emplaced (cell falls back)", noCacheInRange && plantedNone, `caches all destroyed, ieds Δ=${w2.sim.ieds.length - iedsBefore}`);
}

// ---------------------------------------------------------------- 6. Succession
{
  const w = armed("net-succession");
  for (let t = 0; t < 300; t++) w.tick(0.1);
  const cell = w.state.network.cells.find((c) => !c.broken)!;
  const oldName = cell.leaderName;
  // Inject the cell's named leader, then kill him.
  const leader = makeInsurgent(w.rng.fork("probe-leader"), "commander", w.terrain.cellCenter(cell.homeCx, cell.homeCy), 0.6);
  leader.cellId = cell.id;
  leader.isCellLeader = true;
  w.sim.addUnit(leader);
  leader.alive = false; // KIA
  w.tick(0.1); // cullEnemies registers the leader's death → beginSuccession
  const wentLeaderless = !cell.leaderAlive && cell.successionAt !== undefined;
  const strengthAtDeath = cell.strength;
  // Jump past the succession window and resolve it (the mechanism advanceNetwork runs each tick).
  w.state.clock = (cell.successionAt ?? w.state.clock) + 1;
  const intelBefore = w.state.intel.length;
  advanceNetwork(w);
  const renamed = cell.leaderAlive && cell.leaderName !== oldName;
  const weaker = cell.strength <= strengthAtDeath + 1e-6 && cell.strength <= strengthAtDeath * 0.7 + 1e-6;
  const named = w.state.intel.slice(0, w.state.intel.length - intelBefore).some((r) => r.text.includes(cell.leaderName) || r.text.includes(oldName));
  check("6. leader KIA → succession (new name, −30% strength, intel emission)", wentLeaderless && renamed && weaker && named, `leaderless=${wentLeaderless}, renamed=${renamed}(${oldName}→${cell.leaderName}), weaker=${weaker}, intel=${named}`);
}

// ---------------------------------------------------------------- 7. Intel truthiness
{
  const w = armed("net-intel");
  // Win a village over so it will give up its cell; drive the HUMINT ladder to a LOCATED report.
  const v = w.state.villages[0];
  v.attitude = 60;
  v.cooperation = 80;
  let located: { cx?: number; cy?: number } | null = null;
  let cellHome: { cx: number; cy: number } | null = null;
  for (let k = 0; k < 8 && !located; k++) {
    const before = w.state.intel.length;
    emitNetworkHumint(w);
    const emitted = w.state.intel.length > before ? w.state.intel[0] : null;
    // find the cell this village belongs to
    const cell = w.state.network.cells.find((c) => c.villageIds.includes(v.id)) ?? null;
    if (cell && cell.intelLevel >= 2 && emitted && emitted.cx !== undefined && emitted.cy !== undefined) {
      located = emitted;
      cellHome = { cx: cell.homeCx, cy: cell.homeCy };
    }
  }
  let within = false;
  if (located && cellHome && located.cx !== undefined && located.cy !== undefined) {
    const a = w.terrain.cellCenter(located.cx, located.cy);
    const b = w.terrain.cellCenter(cellHome.cx, cellHome.cy);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    within = d <= 155; // the located noise radius (≤150 m + a cell of rounding)
  }
  check("7. located intel (intelLevel≥2) lands within noise radius of the true home", within, located ? "report near true home" : "no located report produced");
}

// ---------------------------------------------------------------- 8. Save round-trip mid-activity
{
  const w = armed("net-roundtrip");
  for (let t = 0; t < 3500 && !w.state.ended; t++) w.tick(0.1); // mid-tour: spawns out, heat warmed
  const json = JSON.stringify(w.serialize());
  const loaded = loadWorld(JSON.parse(json));
  const netEqual = JSON.stringify(loaded.state.network) === JSON.stringify(w.state.network);
  const heatEqual = JSON.stringify(loaded.state.patrolHeat) === JSON.stringify(w.state.patrolHeat);
  // The SAVE is stable through load — a second round-trip is byte-identical to the first (loadWorld
  // normalizes pre-v10 undefined→default fields once, e.g. grievances:[], which is a pre-existing
  // load behavior unrelated to the network; so we assert idempotency of load, not equality with the
  // in-memory pre-save object).
  const once = JSON.stringify(loaded.serialize());
  const twice = JSON.stringify(loadWorld(JSON.parse(once)).serialize());
  check("8. serialize → loadWorld restores network/heat (save round-trips stably)", netEqual && heatEqual && once === twice, `net=${netEqual}, heat=${heatEqual}, idempotent=${once === twice}`);
}

// ---------------------------------------------------------------- legacy migration (bonus invariant)
{
  // A pre-v10 save (no network / no patrolHeat) must regenerate a deterministic network on load.
  const w = createWorld("net-legacy", 90);
  const blob = w.serialize() as unknown as { state: Record<string, unknown> };
  delete blob.state.network;
  delete blob.state.patrolHeat;
  const a = loadWorld(JSON.parse(JSON.stringify(blob)));
  const b = loadWorld(JSON.parse(JSON.stringify(blob)));
  const regenerated = a.state.network.cells.length > 0 && a.state.patrolHeat.length > 0;
  const deterministic = JSON.stringify(a.state.network) === JSON.stringify(b.state.network);
  // conservation holds after regen too (sum ≈ the save's scalar; derive re-syncs).
  deriveEnemyStrength(a);
  const conserved = Math.abs(networkTotal(a) - a.state.enemyStrengthAbs) < 1e-6;
  check("9. pre-v10 save regenerates a deterministic network on load", regenerated && deterministic && conserved, `cells=${a.state.network.cells.length}, deterministic=${deterministic}, conserved=${conserved}`);
}

console.log(failures === 0 ? "\nNETWORK PROBE OK" : `\nNETWORK PROBE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
