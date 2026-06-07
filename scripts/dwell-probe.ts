/**
 * dwell-probe — measures how long an element actually works on its objective, and whether
 * the census is PROGRESSIVE (driven by population) or fires INSTANTLY on arrival.
 *
 * Metricizes Workstream 1 (soldier-scale realism): the complaint that village/activity dwell
 * feels ~70× too short and the census completes the instant the squad walks up. We suppress
 * enemy activity (heat 0, nextActivityAt far) so we read the clean on-station dwell, not a TIC.
 *
 * The dwell is simply `task.timer` the moment the element enters the on-station phase (dwellFor
 * sets it there) — so we run only as far as on-station, NOT through the whole multi-hour dwell.
 * For census we then sample SAMPLE_S more game-seconds on station to prove the enrollment fraction
 * climbs with time (progressive) and censusDone has NOT already flipped (the old instant bug).
 *
 * Columns: mission | pop | dwell(s) | dwell | band | note
 * Run: npx tsx scripts/dwell-probe.ts
 */
import { createWorld } from "../lib/sim/world";
import type { MissionType } from "../lib/sim/world";

const MISSIONS: MissionType[] = ["presence", "recon", "ambush", "census", "cordon", "overwatch"];
const SAMPLE_S = 1800; // game-seconds sampled on-station to confirm census is progressive

// Target dwell bands (game-seconds), per the WS1 Definition of Done.
const BAND: Record<string, [number, number]> = {
  presence: [1800, 7200], //   ~1 h
  recon: [3600, 7200], //     >= 1 h
  ambush: [7200, 28800], //   hours
  census: [7200, 28800], //    2–8 h, population-driven
  cordon: [7200, 28800], //    2–8 h, population-driven
  overwatch: [10800, 86400], // 3 h .. 24 h cap
  kle: [3600, 7200], //        1–2 h
};

type Row = { mission: string; pop: number; dwell: number; note: string; pass: boolean };
const rows: Row[] = [];

function runMission(seed: string, mission: MissionType | "kle"): Row {
  const world = createWorld(seed, 90);
  const { terrain, state } = world;
  state.enemyHeat = 0;
  state.nextActivityAt = 1e12;
  const cop = terrain.copCell;
  const v = terrain.villages[0];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  if (mission === "kle") {
    world.conductKLE(sq.memberIds, v.id, "tactical");
  } else {
    world.formPatrol(
      sq.memberIds,
      [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
      mission,
      "tactical"
    );
  }
  const vil = () => state.villages.find((x) => x.id === v.id)!;
  const myTask = () => state.tasks.find((tk) => tk.memberIds.includes(sq.memberIds[0]));

  // March to the objective (cap 8 game-hours so nothing runs away), then capture the dwell timer.
  let dwell = 0;
  let reached = false;
  for (let i = 0; i < 8 * 3600 * 10; i++) {
    world.tick(0.1);
    if (world.pendingEvent) world.pendingEvent = null; // headless: don't wedge on a modal
    const t = myTask();
    if (!t) break;
    if (t.phase === "onstation") {
      dwell = t.timer;
      reached = true;
      break;
    }
  }

  const pop = vil().population;
  let note = "";
  let pass = true;
  if (!reached) {
    rows.push({ mission, pop, dwell: 0, note: "never reached station", pass: false });
    return rows[rows.length - 1];
  }
  const [lo, hi] = BAND[mission];
  pass = dwell >= lo && dwell <= hi;

  if (mission === "census") {
    // Census just entered station. It must NOT already be done, and the fraction must climb.
    const p0 = vil().censusProgress;
    const done0 = vil().censusDone;
    for (let i = 0; i < SAMPLE_S * 10; i++) {
      world.tick(0.1);
      if (world.pendingEvent) world.pendingEvent = null;
    }
    const p1 = vil().censusProgress;
    const progressive = !done0 && p1 > p0 && vil().censusProgress < 1;
    note = `progress ${p0.toFixed(2)}→${p1.toFixed(2)} (~${SAMPLE_S}s) ` + (progressive ? "PROGRESSIVE" : "NOT progressive/instant");
    pass = pass && progressive;
  }
  const row = { mission, pop, dwell, note, pass };
  rows.push(row);
  return row;
}

for (const m of MISSIONS) runMission(`dwell-${m}`, m);
runMission("dwell-kle", "kle");

console.log(`dwell-probe — on-station dwell band check (SAMPLE_S=${SAMPLE_S})\n`);
console.log("mission     | pop | dwell(s) | dwell  | band(h)      | P | note");
console.log("------------|-----|----------|--------|--------------|---|----------------------------------");
let allPass = true;
for (const r of rows) {
  const [lo, hi] = BAND[r.mission];
  const band = `${(lo / 3600).toFixed(1)}-${(hi / 3600).toFixed(1)}`;
  allPass = allPass && r.pass;
  console.log(
    `${r.mission.padEnd(11)} | ${String(r.pop).padStart(3)} | ${String(Math.round(r.dwell)).padStart(8)} | ${(r.dwell / 3600).toFixed(2).padStart(5)}h | ${band.padStart(12)} | ${r.pass ? "✓" : "✗"} | ${r.note}`
  );
}
console.log("\n" + (allPass ? "✓ ALL dwells in band; census progressive." : "✗ FAIL — a dwell is out of band or census not progressive."));
process.exit(allPass ? 0 : 1);
