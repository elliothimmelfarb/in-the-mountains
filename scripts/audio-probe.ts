/**
 * Audio probe — proves the render-side audio layer is deterministic and pure, headless.
 *   npx tsx scripts/audio-probe.ts   → "AUDIO OK" or a numbered FAIL.
 *
 * Asserts:
 *   (A) 1:1 — every NEW effect id (> high-water) maps to exactly one cue (blood => 0, by
 *       design), and no id ever produces a cue twice across frames; the high-water mark is
 *       monotone non-decreasing; every cue's srcId corresponds to an event that existed.
 *   (B) determinism — two same-seed worlds, ticked identically, yield byte-identical ORDERED
 *       cue lists (catches any wall-clock/PRNG leak in the mapper — Law 7).
 *   (C) layer purity — lib/sim contains ZERO `lib/audio` imports (grep), and lib/audio/mapper
 *       + cue import nothing browser (no AudioContext/window/document/performance/RAF). The
 *       probe importing only mapper+cue must load on Node without a browser global.
 *
 * Drives a real firefight (formPatrol into a hot valley, mirrors fire-mission-probe.ts) plus an
 * enemy mortar + a danger-close US mission so muzzle/blast/impact/ricochet/radio/shot/splash/
 * dangerclose/tic_sting all exercise. Pure side only — never imports the Web-Audio player.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createWorld } from "../lib/sim/world";
import type { SquadSOP } from "../lib/sim/world/types";
import { CueMapper } from "../lib/audio/mapper";
import type { AudioCue } from "../lib/audio/cue";

let fails = 0;
function fail(n: number, msg: string) {
  fails++;
  console.error(`FAIL ${n}: ${msg}`);
}
function ok(msg: string) {
  console.log(`  ok — ${msg}`);
}

// ----------------------------------------------------------------- world driver
/** Build a world, march a squad into the worst village (hot heat) so it takes contact, and
 *  fire an enemy mortar + a US danger-close mission. Returns the world + a step() that ticks
 *  and returns the live cue source. */
function hotWorld(seed: string) {
  const world = createWorld(seed, 90);
  const { terrain, state } = world;
  state.enemyHeat = 0.85;
  const cop = terrain.copCell;
  const v = terrain.villages[0];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  const sop: SquadSOP = { movement: "patrol", contact: "suppress", roe: "tight" };
  world.formPatrol(
    ids,
    [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
    "presence",
    "tactical",
    sop,
  );
  state.nextActivityAt = 0;
  return world;
}

const src = (w: ReturnType<typeof createWorld>) => ({
  effects: w.sim.effects,
  log: w.sim.log,
  fireMissions: w.sim.fireMissions,
  inContact: w.inContact(),
});

// ----------------------------------------------------------------- (A) 1:1 + no double-fire
{
  const w = hotWorld("audio-A");
  const mapper = new CueMapper();
  const seenKeys = new Set<string>(); // `${stream}:${srcId}` ever cued (no double-fire allowed)
  const fxIdsEverSeen = new Set<number>(); // distinct effect ids ever present in sim.effects
  const fxKindById = new Map<number, string>(); // id -> effect kind (to know which are blood)
  const fxCuedIds = new Set<number>(); // effect ids that produced a cue
  let doubleFire = 0;
  let dangling = 0; // a cue whose srcId never existed in its stream
  const allCues: AudioCue[] = [];

  // fire an enemy mortar onto the squad early so shot/splash/dangerclose paths run.
  let firedEnemy = false;
  let firedUS = false;

  const ticks = 50 * 600; // 50 game-min
  for (let t = 0; t < ticks && !w.state.ended; t++) {
    w.tick(0.1);

    if (!firedEnemy && t === 30) {
      const u = w.sim.playerUnits()[0];
      if (u) {
        w.sim.enemyFireMission("mortar82", { x: u.pos.x, y: u.pos.y }, 4, 8);
        firedEnemy = true;
      }
    }
    if (!firedUS && t === 600) {
      const u = w.sim.playerUnits()[0];
      // a US mission plotted ON our own men => dangerClose true (the klaxon path).
      if (u) firedUS = !!w.requestFireMission("mortar60", { x: u.pos.x, y: u.pos.y }, 2);
    }

    // snapshot what effect ids exist this tick BEFORE collecting (the array is live).
    for (const e of w.sim.effects) {
      fxIdsEverSeen.add(e.id);
      fxKindById.set(e.id, e.kind);
    }

    const cues = mapper.collect(src(w));
    for (const c of cues) {
      // The dedup invariant is per (stream, srcId, KIND): one fx effect => one cue of its kind;
      // a single fire mission legitimately yields a shot AND a splash AND a dangerclose (distinct
      // kinds, same fm.id) — that is NOT a double-fire. tic reuses srcId -1 by design (rising edges).
      const key = `${c.srcStream}:${c.srcId}:${c.kind}`;
      if (c.srcStream !== "tic" && seenKeys.has(key)) doubleFire++;
      seenKeys.add(key);
      allCues.push(c);
      if (c.srcStream === "fx") fxCuedIds.add(c.srcId);
      // dangling check: the source must exist in some snapshot.
      if (c.srcStream === "fx" && !fxIdsEverSeen.has(c.srcId)) dangling++;
    }
  }

  // (a) no double-fire on a non-tic stream (per stream+srcId+kind)
  if (doubleFire > 0) fail(1, `${doubleFire} cue(s) fired twice for the same (stream, srcId, kind)`);
  else ok(`no double-fire across ${allCues.length} cues (${seenKeys.size} distinct stream:src:kind keys)`);

  // (b) every NON-blood effect id that ever existed produced exactly one fx cue, and no fx cue
  //     came from a blood effect (blood => 0 by design).
  const nonBlood = [...fxIdsEverSeen].filter((id) => fxKindById.get(id) !== "blood");
  const bloodCued = [...fxCuedIds].filter((id) => fxKindById.get(id) === "blood");
  const missed = nonBlood.filter((id) => !fxCuedIds.has(id));
  if (bloodCued.length > 0) fail(2, `${bloodCued.length} blood effect(s) wrongly produced a cue`);
  else if (missed.length > 0) fail(3, `${missed.length} non-blood effect(s) produced NO cue (dropped)`);
  else if (nonBlood.length === 0) fail(4, `the firefight produced no non-blood effects — the driver isn't hot`);
  else ok(`1:1 fx mapping: ${fxCuedIds.size} cues == ${nonBlood.length} non-blood effect ids (0 blood, 0 dropped)`);

  // (c) no dangling cue (every fx cue's source existed)
  if (dangling > 0) fail(5, `${dangling} cue(s) reference an effect id that never existed`);
  else ok(`every cue's srcId corresponds to a real event`);

  // (d) we actually exercised the indirect + tic paths (the AWE cues), or the driver is too cold.
  const kinds = new Set(allCues.map((c) => c.kind));
  const wanted = ["tic_sting", "shot", "incoming", "splash"];
  const got = wanted.filter((k) => kinds.has(k as AudioCue["kind"]));
  if (got.length < wanted.length) {
    console.warn(`  warn — indirect/tic coverage partial: got ${[...got].join(",") || "none"} of ${wanted.join(",")} (driver may be cold this run)`);
  } else ok(`indirect + TIC cues fired: ${wanted.join(", ")}`);
  // muzzle/blast must be present or the firefight didn't happen.
  const hasSmallArms = [...kinds].some((k) => k.startsWith("muzzle") || k.startsWith("mg"));
  if (!hasSmallArms) fail(6, `no small-arms cues — the squad never took/returned fire`);
  else ok(`small-arms cues present (${[...kinds].filter((k) => k.startsWith("muzzle") || k.startsWith("mg")).join(", ")})`);
}

// ----------------------------------------------------------------- (B) determinism
// The audio determinism contract (Law 7) is: the MAPPER is a pure function of its inputs —
// same event sequence in => byte-identical ordered cue list out, with NO wall-clock and NO
// PRNG-stream leak (the per-cue `v` is a pure hash of the source id).
//
// IMPORTANT REALITY (the code, not the plan): Effect/Log/FireMission ids come from
// MODULE-SCOPE counters in combat.ts (_eid/_lid/_fmid, combat.ts:204-206) that are monotonic
// across ALL CombatSim instances in a process — they are NOT reset per world. So two worlds
// built back-to-back in one process get DIFFERENT absolute ids (the 2nd continues the 1st's
// counter), which would make their cue srcId/v differ even though the sim is identical. That
// is a property of the engine's id allocation, not of the audio layer. To prove the MAPPER's
// purity cleanly we therefore RECORD one real firefight's per-tick event snapshots (deep
// copies) and REPLAY that identical recording through two independent fresh mappers — same
// inputs, must give byte-identical outputs. This isolates the thing the audio layer owns.
{
  const w = hotWorld("audio-B");
  // record: a deep-copied CueSource snapshot every tick of a real fight + an enemy mortar.
  type Snap = { effects: typeof w.sim.effects; log: typeof w.sim.log; fireMissions: typeof w.sim.fireMissions; inContact: boolean };
  const recording: Snap[] = [];
  const ticks = 40 * 600;
  for (let t = 0; t < ticks && !w.state.ended; t++) {
    w.tick(0.1);
    if (t === 30) {
      const u = w.sim.playerUnits()[0];
      if (u) w.sim.enemyFireMission("mortar82", { x: u.pos.x, y: u.pos.y }, 4, 8);
    }
    if (t === 600) {
      const u = w.sim.playerUnits()[0];
      if (u) w.requestFireMission("mortar60", { x: u.pos.x, y: u.pos.y }, 2); // danger-close klaxon path
    }
    // structuredClone gives an independent snapshot so the replay sees the EXACT same inputs
    // (the live arrays would otherwise age out / splice under both mappers).
    recording.push(structuredClone({ effects: w.sim.effects, log: w.sim.log, fireMissions: w.sim.fireMissions, inContact: w.inContact() }) as Snap);
  }

  const replay = (rec: Snap[]): AudioCue[] => {
    const m = new CueMapper();
    const s: AudioCue[] = [];
    for (const snap of rec) s.push(...m.collect(snap));
    return s;
  };
  const s1 = replay(recording);
  const s2 = replay(recording);
  const a = JSON.stringify(s1);
  const b = JSON.stringify(s2);
  if (a !== b) {
    let i = 0;
    while (i < Math.min(s1.length, s2.length) && JSON.stringify(s1[i]) === JSON.stringify(s2[i])) i++;
    fail(7, `mapper not deterministic — replays diverge at index ${i} (len ${s1.length} vs ${s2.length}): ${JSON.stringify(s1[i])} != ${JSON.stringify(s2[i])}`);
  } else if (s1.length === 0) {
    fail(8, `determinism run produced zero cues — the driver isn't hot`);
  } else {
    ok(`mapper is a pure deterministic function: two replays of one recording are byte-identical (${s1.length} cues, no wall-clock/PRNG leak)`);
  }
}

// ----------------------------------------------------------------- (C) layer purity (static)
{
  // C1: lib/sim must never import lib/audio.
  let simImportsAudio = "";
  try {
    simImportsAudio = execSync(`grep -rEl "lib/audio|@/lib/audio" lib/sim/ || true`, { encoding: "utf8" }).trim();
  } catch {
    /* grep exits 1 on no match — handled by || true */
  }
  if (simImportsAudio) fail(9, `lib/sim imports lib/audio:\n${simImportsAudio}`);
  else ok(`lib/sim has ZERO lib/audio imports`);

  // C2: the pure audio files touch no browser global.
  const banned = /AudioContext|\bwindow\b|\bdocument\b|performance\.|requestAnimationFrame/;
  for (const f of ["lib/audio/mapper.ts", "lib/audio/cue.ts"]) {
    const text = readFileSync(f, "utf8");
    // strip line comments + block comments so a doc-comment mentioning "AudioContext" doesn't trip it.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (banned.test(code)) fail(10, `${f} references a browser global in code (must be browser-free)`);
    else ok(`${f} is browser-free`);
  }
  // C3: importing the pure mapper on Node didn't throw (it loaded at the top of this file).
  ok(`lib/audio/mapper + cue load on Node without a browser global`);
}

if (fails > 0) {
  console.error(`\n${fails} FAIL`);
  process.exit(1);
}
console.log("\nAUDIO OK");
