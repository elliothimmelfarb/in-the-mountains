/**
 * DRILL-TIMELINE PROBE — fingerprints the squad-combat battle drill (Wave-1.3 baseline).
 *
 * Metricizes brief §3b "two squads assaulting the same objective move almost identically;
 * once a flank is found the assault simply closes": today's rigidity becomes a NUMBER so
 * that upcoming changes (pinned-revert, per-man bound hesitation) can PROVE divergence on
 * the same probe. Two squads (1st + 2nd) are dispatched to the SAME village objective with
 * SOP contact="assault" under high heat; per world-tick the probe records every
 * `t.squadState` transition (with game-time), every `t.boundPair` swap, and — for each
 * swap — each moving-pair member's step-off delay (first tick at/after the swap where he
 * is moving with a non-empty path, minus swap time). Moving-pair membership mirrors
 * stampAssault's split exactly (live mnvrIds sorted by distance to t.flankPt ?? t.threatPt,
 * half = ceil(n/2), boundPair ? far half : near half) — note the probe re-derives it from
 * POST-tick positions (stamp uses pre-sim.tick positions), so near-equidistant men can very
 * rarely be misattributed; irrelevant at baseline where all delays are ~0.
 *
 * Columns (one row per seed+squad, then a cross-squad row per seed, then MEAN):
 *   sq             which squad (1st/2nd)
 *   contacts       distinct combat episodes (entries into the squad state machine)
 *   stateSeq       compact transition fingerprint, episodes |-separated
 *                  (e.g. react>hold>assault | react>hold)
 *   cmt            assault commits (transitions INTO "assault")
 *   rvt            assault→suppress/hold reversions (baseline machine has no such edge → 0)
 *   flips          boundPair swaps observed while assaulting
 *   stepSpreadS    mean over flips of σ of intra-pair step-off delays (baseline ≈ 0)
 *   firstMoveGapS  mean over flips of (max−min) step-off delay within the moving pair
 *   seqMatch       cross-squad: do the two squads' stateSeq strings match? (baseline: mostly true)
 *   driftS         cross-squad: |Δ| between the squads' FIRST assault-commit times (if both committed)
 *
 * NO hard assertions yet — this is the baseline probe; rigidity is the expected reading
 * (rvt=0, stepSpread≈0, seqMatch mostly true). The GATES block at the end names the
 * thresholds future waves will assert on (rvt>0, stepSpread>0.25, seqMatch mostly false).
 * Exits 0 unless the probe itself errors. Deterministic: fixed 0.1 s dt loop, seeded
 * worlds, no Date/Math.random.
 *
 * Run:  npx tsx scripts/drill-timeline-probe.ts                      (6 seeds × 25 game-min)
 *       npx tsx scripts/drill-timeline-probe.ts 8 30                 (8 generated seeds × 30 min)
 *       npx tsx scripts/drill-timeline-probe.ts drill-3 drill-9 30   (named seeds × 30 min)
 */
import { createWorld } from "../lib/sim/world";
import type { World, Task, SquadSOP } from "../lib/sim/world";
import type { Unit } from "../lib/sim/entities";

// ─── args: non-numeric tokens are seed names; numerics are [count] [minutes] ───
const tokens = process.argv.slice(2);
const named = tokens.filter((t) => !Number.isFinite(Number(t)));
const nums = tokens.filter((t) => Number.isFinite(Number(t))).map(Number);
const MINUTES = named.length > 0 ? (nums[0] ?? 25) : (nums[1] ?? 25);
const SEEDS: string[] =
  named.length > 0 ? named : Array.from({ length: nums[0] ?? 6 }, (_, i) => `drill-${i}`);

const HEAT = 0.9; // high heat so ambushes spawn against both elements
const SOP: SquadSOP = { movement: "patrol", contact: "assault", roe: "tight" };
const COMBAT = new Set(["react", "hold", "suppress", "assault", "break"]);
const SQUADS: ReadonlyArray<readonly [string, string]> = [
  ["sq1", "1st"],
  ["sq2", "2nd"],
];

// ─── per-squad trace ───
interface FlipWatch {
  swapClock: number; // game clock when the boundPair flip was observed
  pending: Set<string>; // moving-pair members not yet seen stepping off
  delays: number[]; // resolved step-off delays (s)
}
interface Trace {
  taskId: number;
  sq: string;
  prev: string; // last combat state ("" = out of combat)
  prevBound?: number; // last boundPair while assaulting (undefined outside assault)
  episodes: string[][]; // state sequences, one array per contact episode
  events: { t: number; s: string }[]; // timestamped transitions (timeline detail)
  cmt: number;
  rvt: number;
  flips: number;
  firstCommit?: number;
  watch?: FlipWatch;
  spreads: number[]; // per-flip σ of step-off delays (flips with ≥2 resolved members)
  gaps: number[]; // per-flip max−min step-off delay
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Mirror stampAssault's moving-pair split (squad-combat.ts): live mnvr members sorted by
 *  distance to the flank objective (t.flankPt ?? threat), half = ceil(n/2); boundPair=0
 *  moves the NEAR half, boundPair=1 the FAR half. */
function movingPairIds(w: World, task: Task, bp: number): string[] {
  const live = (task.mnvrIds ?? [])
    .map((id) => w.sim.unit(id))
    .filter((u): u is Unit => !!u && u.alive && u.conscious);
  if (live.length === 0) return [];
  const ref = task.flankPt ?? task.threatPt ?? live[0].pos;
  live.sort(
    (a, b) =>
      Math.hypot(a.pos.x - ref.x, a.pos.y - ref.y) - Math.hypot(b.pos.x - ref.x, b.pos.y - ref.y)
  );
  const half = Math.ceil(live.length / 2);
  return (bp ? live.slice(half) : live.slice(0, half)).map((u) => u.id);
}

function closeFlip(tr: Trace): void {
  const wch = tr.watch;
  if (!wch) return;
  if (wch.delays.length >= 2) {
    const m = avg(wch.delays);
    tr.spreads.push(Math.sqrt(avg(wch.delays.map((d) => (d - m) ** 2))));
    tr.gaps.push(Math.max(...wch.delays) - Math.min(...wch.delays));
  }
  tr.watch = undefined;
}

function observe(w: World, tr: Trace, task: Task, clock: number): void {
  const raw = task.squadState ?? "";
  const cur = COMBAT.has(raw) ? raw : "";

  if (cur !== tr.prev) {
    if (cur) {
      if (!tr.prev) tr.episodes.push([]); // entering combat → new episode
      tr.episodes[tr.episodes.length - 1].push(cur);
      tr.events.push({ t: clock, s: cur });
      if (cur === "assault") {
        tr.cmt++;
        tr.firstCommit ??= clock;
      }
      if (tr.prev === "assault" && (cur === "hold" || cur === "suppress")) tr.rvt++;
    } else {
      closeFlip(tr); // contact broke — finalize any in-flight bound watch
    }
    tr.prev = cur;
  }

  // boundPair swap detection (assault only; the commit tick sets boundPair=0 from
  // undefined and is NOT a flip — prevBound is reset to undefined outside assault)
  if (cur === "assault") {
    const bp = task.boundPair;
    if (tr.prevBound !== undefined && bp !== undefined && bp !== tr.prevBound) {
      tr.flips++;
      closeFlip(tr);
      tr.watch = { swapClock: clock, pending: new Set(movingPairIds(w, task, bp)), delays: [] };
    }
    tr.prevBound = bp;
  } else {
    tr.prevBound = undefined;
  }

  // resolve step-offs: first tick at/after the swap where a moving-pair member is
  // moving with a non-empty path → delay = clock − swapClock (0 at the swap tick itself)
  const wch = tr.watch;
  if (wch) {
    for (const id of [...wch.pending]) {
      const u = w.sim.unit(id);
      if (!u || !u.alive || !u.conscious) {
        wch.pending.delete(id); // casualty mid-bound — drop from the pair
        continue;
      }
      if (u.moving && u.path.length > 0) {
        wch.delays.push(clock - wch.swapClock);
        wch.pending.delete(id);
      }
    }
    if (wch.pending.size === 0) closeFlip(tr);
  }
}

interface SeedResult {
  seed: string;
  traces: Trace[];
  seqMatch?: boolean; // undefined when neither squad saw combat
  driftS?: number; // |Δ| first assault-commit times, when both committed
}

function runSeed(seed: string): SeedResult {
  const world = createWorld(seed, 90);
  const { terrain, state } = world;
  state.enemyHeat = HEAT;
  const cop = terrain.copCell;
  const v = terrain.villages[Math.abs(hash(seed)) % terrain.villages.length];
  const mid = { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) };

  // Both squads, SAME objective, SAME route, SAME SOP — the §3b complaint, made measurable.
  const traces: Trace[] = [];
  for (const [sid, label] of SQUADS) {
    const sq = world.platoon.squads.find((s) => s.id === sid);
    if (!sq) throw new Error(`squad ${sid} missing on seed ${seed}`);
    const task = world.formPatrol(
      sq.memberIds.slice(),
      [mid, { cx: v.cx, cy: v.cy }],
      "presence",
      "tactical",
      { ...SOP }
    );
    if (!task) throw new Error(`formPatrol failed for ${sid} on seed ${seed}`);
    traces.push({
      taskId: task.id, sq: label, prev: "", episodes: [], events: [],
      cmt: 0, rvt: 0, flips: 0, spreads: [], gaps: [],
    });
  }
  state.nextActivityAt = 0; // first enemy activity ASAP

  const ticks = MINUTES * 600;
  for (let i = 0; i < ticks && !state.ended; i++) {
    world.tick(0.1);
    const clock = state.clock;
    for (const tr of traces) {
      const task = state.tasks.find((t) => t.id === tr.taskId);
      if (!task) {
        // task completed/removed — close out any combat bookkeeping
        if (tr.prev) tr.prev = "";
        closeFlip(tr);
        tr.prevBound = undefined;
        continue;
      }
      observe(world, tr, task, clock);
    }
  }
  for (const tr of traces) closeFlip(tr);

  const [a, b] = traces;
  const seqOf = (tr: Trace) => tr.episodes.map((e) => e.join(">")).join(" | ");
  const bothEmpty = a.episodes.length === 0 && b.episodes.length === 0;
  return {
    seed,
    traces,
    seqMatch: bothEmpty ? undefined : seqOf(a) === seqOf(b),
    driftS:
      a.firstCommit !== undefined && b.firstCommit !== undefined
        ? Math.abs(a.firstCommit - b.firstCommit)
        : undefined,
  };
}

// ─── run + print ───
console.log(
  `\n=== DRILL TIMELINE PROBE (${SEEDS.length} seeds × ${MINUTES} game-min · 1st+2nd sqd → SAME village · SOP patrol/assault/tight · heat ${HEAT}) ===`
);
console.log(
  `legend: contacts=combat episodes · cmt=assault commits · rvt=assault→hold/suppress reversions · flips=boundPair swaps`
);
console.log(
  `        stepSpreadS=mean σ of intra-pair step-off delays · firstMoveGapS=mean max−min per flip · driftS=|Δ| first commit times\n`
);

const hdr =
  `${"seed".padEnd(12)}${"sq".padEnd(5)}${"contacts".padEnd(10)}${"stateSeq".padEnd(40)}` +
  `${"cmt".padEnd(5)}${"rvt".padEnd(5)}${"flips".padEnd(7)}${"stepSpreadS".padEnd(13)}firstMoveGapS`;
console.log(hdr);
console.log("-".repeat(hdr.length));

const results: SeedResult[] = [];
const allRows: Trace[] = [];
for (const seed of SEEDS) {
  const r = runSeed(seed);
  results.push(r);
  for (const tr of r.traces) {
    allRows.push(tr);
    const seq = tr.episodes.map((e) => e.join(">")).join(" | ") || "(no contact)";
    const spread = tr.spreads.length ? avg(tr.spreads).toFixed(2) : "-";
    const gap = tr.gaps.length ? avg(tr.gaps).toFixed(2) : "-";
    console.log(
      `${seed.padEnd(12)}${tr.sq.padEnd(5)}${String(tr.episodes.length).padEnd(10)}${seq.padEnd(40)}` +
        `${String(tr.cmt).padEnd(5)}${String(tr.rvt).padEnd(5)}${String(tr.flips).padEnd(7)}` +
        `${spread.padEnd(13)}${gap}`
    );
  }
  const sm = r.seqMatch === undefined ? "n/a (no contact)" : String(r.seqMatch);
  const dr = r.driftS !== undefined ? `${r.driftS.toFixed(1)}s` : "-";
  console.log(`${seed.padEnd(12)}${"--".padEnd(5)}seqMatch=${sm}  driftS=${dr}`);
  // timestamped transition timeline (the raw fingerprint behind stateSeq)
  for (const tr of r.traces) {
    if (tr.events.length === 0) continue;
    console.log(
      `${"".padEnd(12)}  ${tr.sq} tl: ${tr.events.map((e) => `${fmtClock(e.t)} ${e.s}`).join(" > ")}`
    );
  }
}

// MEAN row
const n = allRows.length;
const meanContacts = avg(allRows.map((t) => t.episodes.length));
const meanCmt = avg(allRows.map((t) => t.cmt));
const meanRvt = avg(allRows.map((t) => t.rvt));
const meanFlips = avg(allRows.map((t) => t.flips));
const allSpreads = allRows.flatMap((t) => t.spreads);
const allGaps = allRows.flatMap((t) => t.gaps);
const meanSpread = allSpreads.length ? avg(allSpreads) : 0;
const meanGap = allGaps.length ? avg(allGaps) : 0;
const comparable = results.filter((r) => r.seqMatch !== undefined);
const matches = comparable.filter((r) => r.seqMatch).length;
const drifts = results.filter((r) => r.driftS !== undefined).map((r) => r.driftS!);

console.log("-".repeat(hdr.length));
console.log(
  `${"MEAN".padEnd(12)}${"".padEnd(5)}${meanContacts.toFixed(2).padEnd(10)}${`(${n} squad-rows)`.padEnd(40)}` +
    `${meanCmt.toFixed(2).padEnd(5)}${meanRvt.toFixed(2).padEnd(5)}${meanFlips.toFixed(1).padEnd(7)}` +
    `${meanSpread.toFixed(2).padEnd(13)}${meanGap.toFixed(2)}`
);
console.log(
  `${"".padEnd(12)}${"".padEnd(5)}seqMatch ${matches}/${comparable.length} seeds  ·  driftS mean ${
    drifts.length ? avg(drifts).toFixed(1) + "s" : "-"
  } (${drifts.length} seeds with both committed)`
);

// GATES — informational only at baseline; future waves assert on these
console.log(`\nGATES (informational — NO assertions at baseline; rigidity is the expected reading):`);
console.log(
  `  rvt total        = ${allRows.reduce((a, t) => a + t.rvt, 0).toString().padEnd(6)} (pinned-revert fix gates on rvt > 0)`
);
console.log(
  `  mean stepSpreadS = ${meanSpread.toFixed(2).padEnd(6)} (per-man bound hesitation gates on stepSpread > 0.25)`
);
console.log(
  `  seqMatch         = ${`${matches}/${comparable.length}`.padEnd(6)} (divergence work expects mostly false)`
);
console.log("");
process.exit(0);
