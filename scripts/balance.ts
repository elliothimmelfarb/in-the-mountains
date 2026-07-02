/**
 * balance.ts — tactical firefight DIAGNOSTIC + no-stall GATE.  (charter: docs/wiki/Harnesses.md)
 *
 * Runs N continuous deployments and reports casualties. Two distinct roles, do NOT confuse them:
 *
 *   GATE   — no-NaN (a determinism invariant) and the no-stall watchdog (a frozen out-of-contact
 *            mover is a real bug). These are invariants; they block.
 *   PROBE  — the casualty figures (US KIA/WIA, enemy, civ). These are a DIAGNOSTIC, **not a target.**
 *
 * THE CASUALTY NUMBERS ARE NOT A GATE. There is no "WIA band" to defend. The "~8.58 historical WIA
 * band" that earlier work policed was the sim's OWN past output (it first appeared as the WIA of one
 * run when aspect-vegetation@0.05 shipped — terrain.ts:665), never a doctrine-anchored rate. Policing
 * a realism change back to it (a) flagged SAFER outcomes as defects [issue 026: 6.92 "below band"],
 * (b) set the stopping point for a realism win [027], and (c) reverted realism features [020, 022].
 * If a defensible change moves casualties, REPORT the new number and justify it from doctrine/design —
 * never engineer it back to a historical value.
 *
 * NOISE FLOOR. This script is deterministic per seed-PREFIX (seeds `${PREFIX}-0..N`), so re-running the
 * same prefix is identical. But each prefix is ONE 12-sample draw; the between-prefix σ of mean WIA
 * (measured 2026-06-26 across independent prefixes) is reported below. A casualty delta inside that σ
 * is NOISE, not a finding. For a real read, run several held-out prefixes and look at the spread:
 *   npx tsx scripts/balance.ts 12 50 bal   ·   ... balB   ·   ... balC   (compare the means)
 */
import { createWorld } from "../lib/sim/world";

// Between-prefix σ of mean US-WIA, measured 2026-06-26 across 4 independent 12×50 draws:
// {bal 7.08, balC 2.67, balD 5.00, balE 9.42} → mean 6.04, RANGE 2.67–9.42 (spread 6.75), σ≈2.5.
// The "~8.58 band" policed WIA deltas of ~1.0–1.5; the noise floor is ~2.5, i.e. the band was
// policing deltas HALF the size of its own sampling noise. Treat any WIA delta < ~σ as NOISE.
// (n=4 makes σ itself approximate; the RANGE is the hard fact. Re-measure if combat changes.)
const WIA_SIGMA_FLOOR = 2.5; // see docs/wiki/Harnesses.md

const N = Number(process.argv[2] ?? 12);
const MINUTES = Number(process.argv[3] ?? 50);
const PREFIX = process.argv[4] ?? "bal"; // seed prefix — pass a fresh one for a held-out A/B (Law 3)

let usKIA = 0, usWIA = 0, enKIA = 0, civ = 0, contacts = 0, stuck = 0;
let totalEnemySeen = 0;

for (let run = 0; run < N; run++) {
  const seed = `${PREFIX}-${run}`;
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.6 + (run % 5) * 0.06;

  // push a squad + medic out toward a village on a presence patrol
  const cop = terrain.copCell;
  const v = terrain.villages[run % terrain.villages.length];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  world.formPatrol(
    ids,
    [
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    "presence",
    "tactical"
  );
  state.nextActivityAt = 0; // first enemy activity ASAP

  let contact = false;
  let peakEnemy = 0;
  const ticks = MINUTES * 600;
  for (let t = 0; t < ticks && !state.ended; t++) {
    world.tick(0.1);
    if (world.inContact()) contact = true;
    peakEnemy = Math.max(peakEnemy, sim.livingEnemies().length);
    for (const u of sim.units) {
      if (Number.isNaN(u.pos.x)) {
        console.error("NaN!", seed, u.id);
        process.exit(1);
      }
    }
  }
  if (contact) contacts++;
  totalEnemySeen += peakEnemy;
  usKIA += world.platoon.members.filter((m) => !m.alive).length;
  usWIA += world.platoon.members.filter((m) => m.alive && m.wounds.length > 0).length;
  enKIA += world.platoon.members.reduce((a, m) => a + m.kills, 0);
  civ += sim.units.filter((u) => u.faction === "civilian" && (!u.alive || u.wounds.length > 0)).length;

  // True stall test: run 90 more game-seconds; a moving element that is out of
  // contact should make progress. If its centroid barely moves, it's frozen.
  // The centroid is of the LIVING, CONSCIOUS, not-evac'd members — what the comment
  // always claimed. The code used to track memberIds[0] alone, and that man can be a
  // KIA lying on the trail while the squad marches on (measured, balB-8 2026-07-02:
  // tracked man alive=false, nine live members all moving with paths up — the old
  // check asserted a corpse walks). A gate may only assert an invariant (charter);
  // "the element's living men advance" is the invariant.
  const movingTask = state.tasks.find((tk) => tk.phase === "moving" || tk.phase === "returning");
  const liveCentroid = (): { x: number; y: number; n: number } => {
    let x = 0, y = 0, n = 0;
    for (const id of movingTask!.memberIds) {
      const u = sim.unit(id);
      if (!u || !u.alive || !u.conscious || u.evac) continue;
      x += u.pos.x; y += u.pos.y; n++;
    }
    return n ? { x: x / n, y: y / n, n } : { x: 0, y: 0, n: 0 };
  };
  if (movingTask && !world.inContact()) {
    const before = liveCentroid();
    for (let t = 0; t < 900 && !state.ended; t++) world.tick(0.1);
    const after = liveCentroid();
    if (!world.inContact() && before.n > 0 && after.n > 0 && Math.hypot(after.x - before.x, after.y - before.y) < 4) stuck++;
  }
}

console.log(`Ran ${N} continuous deployments, ${MINUTES} game-min each (1 squad + medic patrol, heat ~0.6-0.9):`);
console.log(`  Contacts: ${contacts}/${N} runs saw a firefight · avg peak enemies on map ${(totalEnemySeen / N).toFixed(1)}`);
console.log(`  Avg US KIA: ${(usKIA / N).toFixed(2)} · Avg US WIA: ${(usWIA / N).toFixed(2)} · Avg enemy accounted: ${(enKIA / N).toFixed(2)} · Civ cas total: ${civ}`);
console.log(`  ↑ DIAGNOSTIC, not a target — no WIA band to defend. Deltas within the noise floor (between-prefix σ≈${Number.isFinite(WIA_SIGMA_FLOOR) ? WIA_SIGMA_FLOOR.toFixed(2) : "?"} WIA) are NOISE. See docs/wiki/Harnesses.md.`);
console.log(stuck === 0 ? "  ✓ No elements left stranded mid-route." : `  ⚠ ${stuck} runs left an element lingering (check task resume).`);
