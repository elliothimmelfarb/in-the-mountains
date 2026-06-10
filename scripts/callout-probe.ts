/**
 * CALLOUT-BUS PROBE — metricizes "the diegetic callout bus is replay-stable, covers
 * casualties, and cannot spam" (`CombatSim.callouts` ring buffer + `say()` dedup in
 * lib/sim/combat.ts).
 *
 * Each seed runs the SAME deployment TWICE from scratch (two createWorld + identical
 * fixed-dt tick loops, balance.ts dispatch: sq1+medic presence patrol, heat 0.85,
 * first enemy activity ASAP). Callouts are drained INCREMENTALLY each tick by
 * high-water id (the bus is a cap-64 ring buffer — a read-once-at-the-end consumer
 * would lose history). Per tick we also record US/ANA casualty events (wounds.length
 * increase on a living man, or an alive flip) and whether a conscious same-faction
 * buddy stood within 30 m at that moment (witness-eligible — mirrors
 * CombatSim.nearestWitness exactly).
 *
 * Columns per seed (metrics from run A; run B exists for the determinism check):
 *   events   total callouts drained over the run
 *   perType  contact/man_down/covering/moving/doc/on_me/falling_back counts
 *            (head_count + set still count in `events` and the fingerprint)
 *   ctcMin   game-minutes in contact (any player unit suppression>0.18 or
 *            visibleEnemyIds.length>0)
 *   maxPM    max GLOBAL callouts in any 60 game-s window that overlaps contact —
 *            visibility column ONLY, not asserted (five squads shouting
 *            independently in a mass-casualty COP fight is correct behavior)
 *   sqPM     max callouts from ONE squadId in any 60 game-s window that overlaps
 *            contact — the asserted per-squad rate budget (≤ 8)
 *   cas      US/ANA casualty events seen
 *   elig     casualty events with a witness-eligible buddy (<30 m, conscious, same faction)
 *   mdCov%   fraction of witness-eligible casualty events with a man_down callout
 *            within ±3.5 game-s (the 3 s squad dedup means two casualties seconds
 *            apart legitimately share one shout — a ±1.5 s window mislabels those)
 *   dup      same (squadId,type) emissions closer than the sim dedup window
 *            (man_down 3 s / contact 14 s / covering+moving 22 s / all else 10 s)
 *            — 0 by construction
 *   det      OK if both runs yield identical FNV-1a fingerprints over the ordered
 *            stream `${timeS.toFixed(1)}|${type}|${squadId ?? ""}|${unitId}|${text}`
 *            (callout `id` is excluded on purpose: the id counter is module-global,
 *            so run B's ids are offset within one process — content must match)
 *
 * ASSERTS (exit 1, prints which): det OK on every seed · dup 0 total ·
 * aggregate mdCov ≥ 95% · sqPM ≤ 8 on every seed (maxPM reported, not asserted).
 *
 * Run: npx tsx scripts/callout-probe.ts [seeds...] [minutes]
 *      (defaults: bal-0..bal-4 × 25 game-min; a trailing numeric arg is minutes)
 */
import { createWorld } from "../lib/sim/world";
import type { Callout, CalloutType } from "../lib/sim/combat";
import type { Unit } from "../lib/sim/entities";

const DT = 0.1;
const HEAT = 0.85; // high enough to guarantee contact inside the window
const WITNESS_R = 30; // m — mirrors CombatSim.nearestWitness default radius
const COV_WINDOW_S = 3.5; // ±game-s a man_down may trail/lead its casualty (3 s squad dedup → clusters share one shout)
const SPAM_WINDOW_S = 60;
const SQUAD_PM_MAX = 8; // per-squad rate budget per contact-overlapping 60 s window

// Mirror of CALLOUT_DEDUP_S in lib/sim/combat.ts (man_down 3, contact 14, covering/moving 22, default 10).
const DEDUP_S: Record<CalloutType, number> = {
  contact: 14,
  man_down: 3,
  covering: 22,
  moving: 22,
  doc: 10,
  on_me: 10,
  falling_back: 10,
  head_count: 10,
  set: 10,
};

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
let MINUTES = 25;
if (argv.length && /^\d+(\.\d+)?$/.test(argv[argv.length - 1])) MINUTES = Number(argv.pop());
const SEEDS = argv.length ? argv : ["bal-0", "bal-1", "bal-2", "bal-3", "bal-4"];

// ------------------------------------------------------------------ helpers
/** 32-bit FNV-1a, chainable so the whole callout stream folds into one hash. */
function fnv1a(str: string, h = 0x811c9dc5): number {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface CasEvent {
  timeS: number;
  unitId: string;
  eligible: boolean;
}

interface RunData {
  callouts: Callout[]; // drained copies, in emission order
  fingerprint: string;
  casEvents: CasEvent[];
  contactTicks: Uint8Array; // 1 per tick where any player unit is in contact
}

// ------------------------------------------------------------------ one deployment
function runOnce(seed: string): RunData {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = HEAT;

  // balance.ts dispatch pattern: sq1 + medic on a presence patrol toward a village.
  const cop = terrain.copCell;
  const v = terrain.villages[fnv1a(seed) % terrain.villages.length];
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

  const ticks = Math.round(MINUTES * 600);
  const callouts: Callout[] = [];
  let hiId = -1; // high-water mark — the incremental drain cursor
  const casEvents: CasEvent[] = [];
  const contactTicks = new Uint8Array(ticks);
  const prev = new Map<string, { wounds: number; alive: boolean }>();

  for (let k = 0; k < ticks && !state.ended; k++) {
    world.tick(DT);

    // Drain the ring buffer incrementally: ids are monotonic, so anything above the
    // high-water mark is new. Reading every tick means the cap-64 buffer never wraps
    // past us (the per-squad dedup makes 64 emissions per tick impossible anyway).
    for (const c of sim.callouts) {
      if (c.id > hiId) {
        hiId = c.id;
        callouts.push({ ...c, pos: { ...c.pos } });
      }
    }

    // Contact + casualty scan over every US/ANA body in the sim (the platoon roster
    // ARE the live sim units; this also covers ANA garrison partners).
    const friendlies: Unit[] = [];
    let contact = false;
    for (const u of sim.units) {
      if (u.faction !== "us" && u.faction !== "ana") continue;
      friendlies.push(u);
      if (u.alive && !u.evac && (u.suppression > 0.18 || u.visibleEnemyIds.length > 0)) contact = true;
    }
    if (contact) contactTicks[k] = 1;

    for (const u of friendlies) {
      const p = prev.get(u.id);
      if (p) {
        const died = p.alive && !u.alive;
        const wounded = u.wounds.length > p.wounds && (u.alive || died);
        if (died || wounded) {
          // Witness-eligible at this moment — exact mirror of nearestWitness:
          // alive, conscious, not evac'd, SAME faction, strictly within 30 m.
          let eligible = false;
          for (const o of friendlies) {
            if (o.id === u.id || !o.alive || !o.conscious || o.evac || o.faction !== u.faction) continue;
            if (Math.hypot(o.pos.x - u.pos.x, o.pos.y - u.pos.y) < WITNESS_R) {
              eligible = true;
              break;
            }
          }
          casEvents.push({ timeS: sim.timeS, unitId: u.id, eligible });
        }
      }
      prev.set(u.id, { wounds: u.wounds.length, alive: u.alive });
    }
  }

  let h = 0x811c9dc5;
  for (const c of callouts) h = fnv1a(`${c.timeS.toFixed(1)}|${c.type}|${c.squadId ?? ""}|${c.unitId}|${c.text}\n`, h);
  return { callouts, fingerprint: h.toString(16).padStart(8, "0"), casEvents, contactTicks };
}

// ------------------------------------------------------------------ metrics
/** Max callouts in any 60 game-s window that overlaps a contact tick. */
function maxPerMin(callouts: Callout[], contactTicks: Uint8Array): number {
  if (callouts.length === 0) return 0;
  const pre = new Uint32Array(contactTicks.length + 1);
  for (let i = 0; i < contactTicks.length; i++) pre[i + 1] = pre[i] + contactTicks[i];
  const times = callouts.map((c) => c.timeS); // emission order = time order
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (j < times.length && times[j] < times[i] + SPAM_WINDOW_S) j++;
    const a = Math.min(contactTicks.length, Math.max(0, Math.floor(times[i] / DT)));
    const b = Math.min(contactTicks.length, Math.ceil((times[i] + SPAM_WINDOW_S) / DT));
    if (b > a && pre[b] - pre[a] > 0) best = Math.max(best, j - i);
  }
  return best;
}

/** Max callouts from ONE squad in any 60 game-s window that overlaps contact — the
 *  asserted budget. Grouping key mirrors say(): `squadId ?? unitId`. */
function maxSquadPerMin(callouts: Callout[], contactTicks: Uint8Array): number {
  const bySquad = new Map<string, Callout[]>();
  for (const c of callouts) {
    const key = c.squadId ?? c.unitId;
    const arr = bySquad.get(key);
    if (arr) arr.push(c);
    else bySquad.set(key, [c]);
  }
  let best = 0;
  for (const arr of bySquad.values()) best = Math.max(best, maxPerMin(arr, contactTicks));
  return best;
}

/** Same (squadId,type) pairs emitted closer than the sim's dedup window — asserts the
 *  guard. Key mirrors say(): `${squadId ?? unitId}:${type}`. */
function dupViolations(callouts: Callout[]): number {
  const last = new Map<string, number>();
  let v = 0;
  for (const c of callouts) {
    const key = `${c.squadId ?? c.unitId}:${c.type}`;
    const l = last.get(key);
    if (l !== undefined && c.timeS - l < DEDUP_S[c.type] - 1e-6) v++;
    last.set(key, c.timeS);
  }
  return v;
}

interface Row {
  seed: string;
  events: number;
  perType: Record<CalloutType, number>;
  ctcMin: number;
  maxPM: number;
  maxSqPM: number;
  cas: number;
  elig: number;
  covered: number;
  dup: number;
  det: boolean;
}

function measure(seed: string): Row {
  const a = runOnce(seed);
  const b = runOnce(seed);

  const perType = {} as Record<CalloutType, number>;
  for (const t of Object.keys(DEDUP_S) as CalloutType[]) perType[t] = 0;
  for (const c of a.callouts) perType[c.type]++;

  const mdTimes = a.callouts.filter((c) => c.type === "man_down").map((c) => c.timeS);
  let covered = 0;
  let elig = 0;
  for (const e of a.casEvents) {
    if (!e.eligible) continue;
    elig++;
    if (mdTimes.some((t) => Math.abs(t - e.timeS) <= COV_WINDOW_S + 1e-6)) covered++;
  }

  let ctcTicks = 0;
  for (let i = 0; i < a.contactTicks.length; i++) ctcTicks += a.contactTicks[i];

  return {
    seed,
    events: a.callouts.length,
    perType,
    ctcMin: (ctcTicks * DT) / 60,
    maxPM: maxPerMin(a.callouts, a.contactTicks),
    maxSqPM: maxSquadPerMin(a.callouts, a.contactTicks),
    cas: a.casEvents.length,
    elig,
    covered,
    dup: dupViolations(a.callouts),
    det: a.fingerprint === b.fingerprint && a.callouts.length === b.callouts.length,
  };
}

// ------------------------------------------------------------------ run + report
console.log(`Callout-bus probe: ${SEEDS.length} seeds × 2 runs × ${MINUTES} game-min, sq1+medic patrol, heat ${HEAT}`);
console.log(
  "seed".padEnd(12),
  "events".padStart(6),
  "perType(c/md/cov/mov/doc/onme/fb)".padStart(33),
  "ctcMin".padStart(7),
  "maxPM".padStart(5),
  "sqPM".padStart(5),
  "cas".padStart(4),
  "elig".padStart(4),
  "mdCov%".padStart(7),
  "dup".padStart(4),
  "det".padStart(5)
);

const rows: Row[] = [];
for (const seed of SEEDS) {
  const r = measure(seed);
  rows.push(r);
  const pt = [r.perType.contact, r.perType.man_down, r.perType.covering, r.perType.moving, r.perType.doc, r.perType.on_me, r.perType.falling_back].join("/");
  console.log(
    seed.padEnd(12),
    String(r.events).padStart(6),
    pt.padStart(33),
    r.ctcMin.toFixed(1).padStart(7),
    String(r.maxPM).padStart(5),
    String(r.maxSqPM).padStart(5),
    String(r.cas).padStart(4),
    String(r.elig).padStart(4),
    (r.elig ? ((100 * r.covered) / r.elig).toFixed(0) + "%" : "-").padStart(7),
    String(r.dup).padStart(4),
    (r.det ? "OK" : "FAIL").padStart(5)
  );
}

const mean = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0) / Math.max(1, rows.length);
const totElig = rows.reduce((s, r) => s + r.elig, 0);
const totCov = rows.reduce((s, r) => s + r.covered, 0);
const aggCov = totElig ? totCov / totElig : 1;
console.log("-".repeat(108));
console.log(
  "MEAN".padEnd(12),
  mean((r) => r.events).toFixed(1).padStart(6),
  "".padStart(33),
  mean((r) => r.ctcMin).toFixed(1).padStart(7),
  mean((r) => r.maxPM).toFixed(1).padStart(5),
  mean((r) => r.maxSqPM).toFixed(1).padStart(5),
  mean((r) => r.cas).toFixed(1).padStart(4),
  mean((r) => r.elig).toFixed(1).padStart(4),
  (totElig ? (100 * aggCov).toFixed(0) + "%" : "-").padStart(7),
  mean((r) => r.dup).toFixed(1).padStart(4),
  ""
);
console.log(`aggregate man_down coverage: ${totCov}/${totElig} witness-eligible casualty events${totElig === 0 ? " (VACUOUS — no eligible casualties seen; raise heat/minutes)" : ""}`);

// ------------------------------------------------------------------ assertions
const failures: string[] = [];
for (const r of rows) {
  if (!r.det) failures.push(`DETERMINISM: seed ${r.seed} — two identical runs produced different callout streams`);
  if (r.maxSqPM > SQUAD_PM_MAX)
    failures.push(`SPAM: seed ${r.seed} — ${r.maxSqPM} callouts from one squad in a 60 s contact window (max ${SQUAD_PM_MAX})`);
}
const totDup = rows.reduce((s, r) => s + r.dup, 0);
if (totDup > 0) failures.push(`DEDUP: ${totDup} same-(squad,type) emissions inside their dedup window — the say() guard leaked`);
if (totElig > 0 && aggCov < 0.95) failures.push(`COVERAGE: aggregate man_down coverage ${(100 * aggCov).toFixed(1)}% < 95% (${totCov}/${totElig})`);

if (failures.length) {
  console.error("\nASSERTION FAILURES:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`✓ all assertions pass (det OK, dup 0, mdCov ≥ 95%, per-squad sqPM ≤ ${SQUAD_PM_MAX})`);
