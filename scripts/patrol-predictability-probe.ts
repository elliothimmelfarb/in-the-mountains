/**
 * PATROL-PREDICTABILITY PROBE  (issue 037, direction 1 — the heat→IED instrument)
 *
 * The enemy-network wave gave the enemy a memory of where you walk (the decaying
 * patrol-heat grid, lib/sim/world/network.ts) and taught the IED emplacer to bury the
 * charge on the HOTTEST candidate cell ahead of a patrol (director.ts spawnIedAmbush).
 * The claim under test: PREDICTABLE patrolling measurably raises IED incidence — a
 * commander who walks the same routes every day pays a tax a route-varying commander
 * does not. Until this probe that claim was "proven to exist/persist/bias, not
 * quantified" (2026-07-16 wave report, honest residual #3).
 *
 * Two policies, same seeds — BOTH are the COIN gate's full "careful" commander
 * (campaign-loop's scheduleCareful, copied verbatim: sq1 rolling presence, sq2 KLE,
 * CERP funded + secured, resupply, tight ROE), differing in EXACTLY ONE decision:
 *   FIXED   — sq1's presence route is COP→midpoint→village on the SAME axis every
 *             visit (the gate's historical midRoute — the maximally-predictable
 *             commander the network wave punished).
 *   VARIED  — sq1's midpoint steps perpendicular off the axis, cycling {0,+1,−1}×240 m
 *             per visit to that village (240 m = 3 patrol-heat buckets — genuinely
 *             different ground, not jitter). The cheap "rotate your approach axes" a
 *             competent human commander does by default (FM 3-24 pattern-avoidance).
 * Running the FULL careful policy (not a stripped patrol-only loop) is deliberate,
 * for two reasons discovered the hard way: (a) it measures exactly the instrument
 * artifact the gate suffers, and (b) a no-COIN patrol loop lets the valley heat to
 * near-continuous contact, which degrades the adaptive stepper to always-fine and
 * costs ~50 s of wall PER GAME-HOUR (measured on survey-0) — COIN itself is what
 * keeps a careful tour affordable to simulate.
 *
 * What it measures per (seed, policy), all from public World surfaces (no sim edits):
 *   plants        IEDs buried (new ids appearing in sim.ieds)
 *   dets          IEDs detonated (new "IED!" contact entries in sim.log)
 *   hit-rate      dets / plants — THE predictability number: the emplacer sites on
 *                 past heat, so the charge only kills if past heat predicts the
 *                 present path
 *   blastCas      friendlies within 30 m of a vanished armed charge whose hp dropped
 *                 (or who died) on the detonation tick — blast attribution proxy;
 *                 follow-on ambush fire is excluded by the radius, overlapping fire
 *                 inside it is not
 *   KIA/WIA       platoon totals at end (ambush + IED + everything — the tour cost)
 *   heat top16    share of total patrol-heat in the 16 hottest of 1024 buckets at
 *                 end-of-tour — the instrument check that FIXED actually concentrates
 *                 heat and VARIED actually spreads it (if these are equal the policies
 *                 never differed and the comparison is void)
 *   endDay        tours can still end early (relief) — rates are reported per
 *                 patrol-day so a truncated tour doesn't masquerade as a safe one
 *
 * This is a PROBE, not a gate (docs/wiki/Harnesses.md): it asserts NOTHING about the
 * sim's output values — it prints them. The only hard failures are mechanical (NaN,
 * a policy that issued zero patrols, heat identical across policies).
 *
 * FINDING (2026-07-16, first full run — 3 gate seeds × 8 d × fixed/varied, dated claim;
 * re-measure after any director/IED/network change): the issue-037 hypothesis was
 * REFUTED. 6 IED plants, 0 detonations, 0 IED casualties across all 48 tour-days;
 * hot-seed KIA/day 5.14 (fixed) vs 5.00 (varied). The careful-tour killers are
 * position-reactive channels (spawnAmbushOnPatrol / harass build positions around the
 * LIVE patrol centroid — route hygiene cannot dodge them by construction); the
 * memory-based IED channel never connects because the emplacer guesses radially
 * 30–95 m ahead against an 8 m victim-trigger and the cell's ~104 s patience expires
 * first (→ issue 038). Evidence: docs/progress/2026-07-16-patrol-predictability/.
 *
 * Determinism: decisions key off the world's own clock/state + fixed counters — no
 * Math.random, no Date.now in policy logic (wall-clock only on stderr liveness).
 * Confound stated plainly: changing route geometry changes the whole downstream
 * tick-RNG trajectory (like any A/B on this engine), so per-seed deltas carry
 * trajectory noise on top of the siting effect; read the aggregate + hit-rate, not
 * one seed. The adaptive-dt scheme is campaign-loop's (DT=30 coarse, 2 s sub-steps
 * while a mobile patrol is in contact) so casualties are the fine-dt truth.
 *
 * Run:  npx tsx scripts/patrol-predictability-probe.ts [seeds] [days]
 *       (default 3 survey seeds × 8 game-days — the COIN gate's horizon;
 *        seeds arg: a count, or a comma-list of named seeds e.g. survey-40,survey-41)
 */
import { createWorld, World } from "../lib/sim/world";
import type { VillageState } from "../lib/sim/campaign";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
function parseSeeds(arg: string | undefined): string[] {
  if (!arg) return Array.from({ length: 3 }, (_, i) => `survey-${i}`);
  if (arg.includes(",")) return arg.split(",").map((s) => s.trim()).filter(Boolean);
  const n = Number(arg);
  if (Number.isFinite(n) && n > 0) return Array.from({ length: n }, (_, i) => `survey-${i}`);
  return [arg];
}
const SEEDS = parseSeeds(argv[0]);
const DAYS = Number(argv[1] ?? 8);
// Optional 3rd arg: run a single policy ("fixed" | "varied") — for PARALLEL sweeps, one
// process per (seed, policy); the cross-policy comparison section only prints when both ran.
const POLICY_FILTER = argv[2] === "fixed" || argv[2] === "varied" ? argv[2] : null;

const DT = 30; // coarse strategic step (campaign-loop's)
const COMBAT_DT = 2; // faithful sub-step while a mobile patrol is in contact
const DAY = 86400;
/** Perpendicular offset of the varied policy's midpoint: 3 patrol-heat buckets (the heat
 *  grid is 32×32 over a 2560 m map → 80 m buckets), so successive visits genuinely walk
 *  different ground rather than jittering inside one bucket. */
const VARY_OFFSET_M = 240;
const BLAST_ATTR_RADIUS_M = 30; // ~2× default blastRadius(14) — tight blast attribution

type RoutePolicy = "fixed" | "varied";

// ---------------------------------------------------------------- helpers (campaign-loop's)
function patrolInContact(w: World): boolean {
  const patrolOut = w.state.tasks.some(
    (t) =>
      (t.phase === "moving" || t.phase === "onstation" || t.phase === "returning") &&
      t.kind !== "secure" &&
      t.memberIds.some((id) => {
        const u = w.sim.unit(id);
        return u && u.alive && !u.evac;
      })
  );
  return patrolOut && w.inContact();
}

function squadFree(w: World, squadId: string): boolean {
  const sq = w.platoon.squads.find((s) => s.id === squadId);
  if (!sq) return false;
  const committed = new Set<string>();
  for (const t of w.state.tasks) if (t.phase !== "complete") for (const id of t.memberIds) committed.add(id);
  const ready = sq.memberIds.filter((id) => {
    const m = w.platoon.members.find((x) => x.id === id);
    return m && m.alive && (m.status === "ready" || m.status === "rest");
  });
  if (ready.length < 4) return false;
  return !ready.some((id) => committed.has(id));
}

function readyMembers(w: World, squadId: string): string[] {
  const sq = w.platoon.squads.find((s) => s.id === squadId);
  if (!sq) return [];
  return sq.memberIds.filter((id) => {
    const m = w.platoon.members.find((x) => x.id === id);
    return m && m.alive && (m.status === "ready" || m.status === "rest");
  });
}

// ---------------------------------------------------------------- route construction
/** The FIXED route: campaign-loop's exact midRoute geometry — COP→midpoint→village,
 *  the same axis every single visit. */
function fixedRoute(w: World, v: VillageState) {
  const cop = w.terrain.copCell;
  return [
    { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
    { cx: v.cx, cy: v.cy },
  ];
}

/** The VARIED route: same endpoints, but the midpoint steps perpendicular off the
 *  COP→village axis by {0,+1,−1}×VARY_OFFSET_M, cycling per visit to THAT village,
 *  snapped to passable ground. Deterministic — driven by a visit counter, no rng.
 *  (Identical math to campaign-loop's variedMidRoute — the two must not drift.) */
function variedRoute(w: World, v: VillageState, visitIdx: number) {
  const t = w.terrain;
  const cop = t.copCell;
  // Cycle STARTS offset (+1 first): with only 1–3 visits per village in a tour, a 0-first
  // cycle never engages — measured: a 2-day fixed-vs-varied smoke produced byte-identical
  // trajectories because every k was 0. Variety must exist from the first step-off.
  const k = [1, -1, 0][visitIdx % 3];
  if (k === 0) return fixedRoute(w, v);
  const ax = v.cx - cop.cx;
  const ay = v.cy - cop.cy;
  const alen = Math.hypot(ax, ay) || 1;
  const offCells = (VARY_OFFSET_M / t.cellSize) * k; // perpendicular, in cell units
  const snapped = t.nearestPassable(
    Math.max(2, Math.min(t.size - 3, Math.round((cop.cx + v.cx) / 2 + (-ay / alen) * offCells))),
    Math.max(2, Math.min(t.size - 3, Math.round((cop.cy + v.cy) / 2 + (ax / alen) * offCells)))
  );
  return [
    { cx: snapped.cx, cy: snapped.cy },
    { cx: v.cx, cy: v.cy },
  ];
}

// ---------------------------------------------------------------- the careful commander
/**
 * campaign-loop's POLICY A, copied verbatim (sq1 presence / sq2 KLE / CERP fund /
 * secure-build / resupply) with ONE seam: sq1's presence route comes from the probe's
 * route policy. Any future change to the gate's careful policy must be mirrored here
 * or the probe stops measuring the gate's commander.
 */
function scheduleCareful(w: World, policy: RoutePolicy, cursors: { village: number }, visitCounts: Map<string, number>, onPatrol: () => void) {
  const villages = w.state.villages;
  if (villages.length === 0) return;
  const daylight = !w.isNight();

  // 1st Squad: rolling presence patrol — THE route-policy seam.
  if (daylight && squadFree(w, "sq1")) {
    const v = villages[cursors.village % villages.length];
    cursors.village++;
    const visit = visitCounts.get(v.id) ?? 0;
    visitCounts.set(v.id, visit + 1);
    const route = policy === "fixed" ? fixedRoute(w, v) : variedRoute(w, v, visit);
    const t = w.formPatrol(readyMembers(w, "sq1"), route, "presence", "tactical", {
      movement: "patrol",
      contact: "hold",
      roe: "tight",
    });
    if (t) onPatrol();
  }

  // 2nd Squad: KLE with the least-recently-engaged village.
  if (daylight && squadFree(w, "sq2")) {
    const target = [...villages].sort((a, b) => a.lastVisitedDay - b.lastVisitedDay)[0];
    w.conductKLE(readyMembers(w, "sq2"), target.id, "tactical");
  }

  // CERP funding — one project in flight at a time, untried villages first.
  const anyInFlight = w.state.projects.some(
    (p) => p.stage === "building" || p.stage === "awaiting_materials" || p.stage === "awaiting_contractor"
  );
  if (!anyInFlight && w.state.cerp >= 5000) {
    const cop = w.terrain.cellCenter(w.terrain.copCell.cx, w.terrain.copCell.cy);
    const hasHistory = (vid: string) => w.state.projects.some((p) => p.villageId === vid);
    const rank = (v: VillageState) => {
      const c = w.terrain.cellCenter(v.cx, v.cy);
      return (hasHistory(v.id) ? 100000 : 0) + Math.hypot(c.x - cop.x, c.y - cop.y) - v.attitude * 4;
    };
    const fundable = villages
      .filter((v) => !v.projects.includes(v.wants))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (fundable) w.startProject(fundable.id, fundable.wants);
  }

  // Secure the in-flight project with a dedicated element.
  const building = w.state.projects.find((p) => p.stage !== "complete" && p.stage !== "sabotaged");
  if (building) {
    const bv = w.state.villages.find((v) => v.id === building.villageId);
    const alreadySecuring = w.state.tasks.some(
      (t) => t.kind === "secure" && t.secureVillageId === building.villageId && t.phase !== "complete"
    );
    if (bv && !alreadySecuring) {
      const sid = squadFree(w, "wpn") ? "wpn" : squadFree(w, "sq3") ? "sq3" : null;
      if (sid) {
        w.secureBuild(readyMembers(w, sid), bv.id, "tactical", { movement: "patrol", contact: "hold", roe: "tight" });
      }
    }
  }

  // Keep construction materials and ammo flowing.
  if (w.state.supplies.construction < 12 || w.state.supplies.ammo_556 < 8000) {
    w.requestResupply("convoy");
  }
}

// ---------------------------------------------------------------- heat statistics
/** Concentration of patrol heat EXCLUDING the COP's neighborhood (±2 buckets ≈ 160 m):
 *  the garrison milling inside the wire dominates the raw field (measured: heatMax ≈ 29k
 *  in the COP bucket vs route buckets in the hundreds), which would swamp the route-
 *  hygiene signal this stat exists to check. */
function heatStats(w: World) {
  const ph = w.state.patrolHeat;
  const HEAT_DIM = 32;
  const cop = w.terrain.copCell;
  const copBx = Math.floor((cop.cx / w.terrain.size) * HEAT_DIM);
  const copBy = Math.floor((cop.cy / w.terrain.size) * HEAT_DIM);
  const route: number[] = [];
  let total = 0;
  for (let i = 0; i < ph.length; i++) {
    const bx = i % HEAT_DIM;
    const by = Math.floor(i / HEAT_DIM);
    if (Math.abs(bx - copBx) <= 2 && Math.abs(by - copBy) <= 2) continue;
    route.push(ph[i]);
    total += ph[i];
  }
  route.sort((a, b) => b - a);
  let top16 = 0;
  for (let i = 0; i < 16 && i < route.length; i++) top16 += route[i];
  return { total, top16Share: total > 0 ? top16 / total : 0, max: route[0] ?? 0 };
}

// ---------------------------------------------------------------- one tour
interface Result {
  ended: boolean;
  nan: boolean;
  endDay: number;
  patrolDays: number; // exposure denominator: days the tour actually ran
  patrols: number;
  plants: number;
  dets: number;
  duds: number; // disappeared armed with no detonation logged (TTL / cell-gone culls)
  blastCas: number; // hp-drop-or-death within 30 m on the detonation tick
  blastKIA: number;
  kia: number;
  wia: number;
  contacts: number; // rising edges of inContact — context for the casualty totals
  heatTop16: number;
  heatMax: number;
  score: number;
}

function runTour(seed: string, policy: RoutePolicy): Result {
  const w = createWorld(seed, DAYS);
  const { state, sim } = w;

  let patrols = 0;
  let plants = 0;
  let dets = 0;
  let duds = 0;
  let blastCas = 0;
  let blastKIA = 0;
  let contacts = 0;
  let nan = false;

  // IED lifecycle tracking: id → position of every armed charge we've seen.
  const armed = new Map<string, { x: number; y: number }>();
  const seenIeds = new Set<string>();
  let lastSimLogId = -1;
  // pre-tick friendly snapshot for blast attribution
  let friendlySnap = new Map<string, { x: number; y: number; hp: number; alive: boolean }>();

  const snapFriendlies = () => {
    friendlySnap = new Map();
    for (const u of sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && !u.evac) {
        friendlySnap.set(u.id, { x: u.pos.x, y: u.pos.y, hp: u.hp, alive: u.alive });
      }
    }
  };
  snapFriendlies();
  for (const e of sim.log) lastSimLogId = Math.max(lastSimLogId, e.id);
  let wasInContact = w.inContact();

  /** Tick once and harvest IED lifecycle events — called for EVERY step, coarse or fine,
   *  so a detonation is always observed on the tick it happened (positions still fresh). */
  const tickAndObserve = (dt: number) => {
    w.tick(dt);

    // detonations since last observation (exact: one "IED!" contact log per detonation)
    let newDets = 0;
    for (const e of sim.log) {
      if (e.id > lastSimLogId) {
        if (e.kind === "contact" && e.msg.startsWith("IED!")) newDets++;
        lastSimLogId = Math.max(lastSimLogId, e.id);
      }
    }
    dets += newDets;

    // ied set diff: new ids = plants; vanished ids = detonated (this tick, if logged) or culled
    const nowIds = new Set<string>();
    for (const ied of sim.ieds) {
      nowIds.add(ied.id);
      if (!seenIeds.has(ied.id)) {
        seenIeds.add(ied.id);
        plants++;
      }
      armed.set(ied.id, { x: ied.pos.x, y: ied.pos.y });
    }
    const vanished: { x: number; y: number }[] = [];
    for (const [id, pos] of armed) {
      if (!nowIds.has(id)) {
        vanished.push(pos);
        armed.delete(id);
      }
    }
    if (newDets === 0) duds += vanished.length;
    else {
      // blast attribution: friendlies near a vanished charge whose hp dropped this tick
      duds += Math.max(0, vanished.length - newDets);
      for (const u of sim.units) {
        if (u.faction !== "us" && u.faction !== "ana") continue;
        const prev = friendlySnap.get(u.id);
        if (!prev) continue;
        const near = vanished.some((p) => Math.hypot(prev.x - p.x, prev.y - p.y) <= BLAST_ATTR_RADIUS_M);
        if (!near) continue;
        if (prev.alive && !u.alive) {
          blastCas++;
          blastKIA++;
        } else if (u.alive && u.hp < prev.hp - 0.5) {
          blastCas++;
        }
      }
    }

    const inC = w.inContact();
    if (inC && !wasInContact) contacts++;
    wasInContact = inC;
    snapFriendlies();

    if (!nan) {
      for (const u of sim.units) {
        if (Number.isNaN(u.pos.x) || Number.isNaN(u.pos.y)) {
          nan = true;
          break;
        }
      }
    }
  };

  // per-village visit counters drive the varied policy's axis rotation
  const visitCounts = new Map<string, number>();
  const cursors = { village: 0 };

  // liveness accounting: how much of the tour ran at the fine (2 s) step — the wall-cost driver
  let fineS = 0;
  let coarseS = 0;
  let lastDayReport = 0;
  const dayT0 = Date.now();

  let guard = 0;
  const GUARD_MAX = Math.ceil(((DAYS + 2) * DAY) / DT) + 1000;
  while (!state.ended && guard++ < GUARD_MAX) {
    // ---- the gate's careful commander; route geometry is the ONLY policy seam -----
    scheduleCareful(w, policy, cursors, visitCounts, () => patrols++);

    // ---- adaptive step (campaign-loop's faithful-combat scheme) -------------------
    if (patrolInContact(w)) {
      let acc = 0;
      while (acc < DT) {
        const step = Math.min(COMBAT_DT, DT - acc);
        tickAndObserve(step);
        fineS += step;
        acc += step;
        if (state.ended) break;
        if (!patrolInContact(w) && acc >= COMBAT_DT) {
          if (DT - acc > 0) {
            tickAndObserve(DT - acc);
            coarseS += DT - acc;
          }
          break;
        }
      }
    } else {
      tickAndObserve(DT);
      coarseS += DT;
    }

    const hour = Math.floor(state.clock / 3600);
    if (hour !== lastDayReport && hour % 6 === 0) {
      lastDayReport = hour;
      process.stderr.write(
        `    [${policy}] ${seed} h${hour}  wall ${((Date.now() - dayT0) / 1000).toFixed(0)}s  ` +
          `fine ${((100 * fineS) / Math.max(1, fineS + coarseS)) | 0}%  patrols ${patrols}  plants ${plants} dets ${dets}  contacts ${contacts}\n`
      );
    }
  }

  const hs = heatStats(w);
  return {
    ended: state.ended,
    nan,
    endDay: w.day,
    patrolDays: Math.max(1, Math.min(w.day, DAYS)),
    patrols,
    plants,
    dets,
    duds,
    blastCas,
    blastKIA,
    kia: w.platoon.members.filter((m) => !m.alive).length,
    wia: w.platoon.members.filter((m) => m.alive && m.wounds.length > 0).length,
    contacts,
    heatTop16: hs.top16Share,
    heatMax: hs.max,
    score: w.computeTourScore(),
  };
}

// ---------------------------------------------------------------- run + report
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
function f(n: number, d = 2): string {
  return n.toFixed(d);
}

const POLICIES: RoutePolicy[] = POLICY_FILTER ? [POLICY_FILTER] : ["fixed", "varied"];
console.log(`\n=== PATROL-PREDICTABILITY PROBE — heat→IED tax, ${SEEDS.length} seeds × ${DAYS} game-days × ${POLICIES.join("+")} ===`);
console.log(`seeds: ${SEEDS.join(", ")}   (PROBE, not a gate — numbers reported, sim outputs not asserted)`);

const results: Record<RoutePolicy, Result[]> = { fixed: [], varied: [] };
for (const policy of POLICIES) {
  for (const seed of SEEDS) {
    const t0 = Date.now();
    const r = runTour(seed, policy);
    results[policy].push(r);
    process.stderr.write(
      `  [${policy}] ${seed}: ${((Date.now() - t0) / 1000).toFixed(1)}s  endDay ${r.endDay}  ` +
        `plants ${r.plants} dets ${r.dets}  KIA ${r.kia} WIA ${r.wia}  heatTop16 ${f(r.heatTop16)}\n`
    );
  }
}

for (const policy of POLICIES) {
  const rs = results[policy];
  console.log(`\n── ${policy.toUpperCase()} routes ──`);
  console.log(
    `  seed          end  patrols  plants  dets  hit%   duds  blastCas(KIA)  KIA  WIA  contacts  heatTop16  heatMax`
  );
  rs.forEach((r, i) => {
    console.log(
      `  ${SEEDS[i].padEnd(12)}  d${String(r.endDay).padEnd(2)} ${String(r.patrols).padStart(6)}  ${String(r.plants).padStart(6)}  ${String(r.dets).padStart(4)}  ` +
        `${f(r.plants ? (100 * r.dets) / r.plants : 0, 0).padStart(4)}  ${String(r.duds).padStart(5)}  ${String(r.blastCas).padStart(8)}(${r.blastKIA})     ${String(r.kia).padStart(3)}  ${String(r.wia).padStart(3)}  ` +
        `${String(r.contacts).padStart(8)}  ${f(r.heatTop16).padStart(9)}  ${f(r.heatMax, 0).padStart(7)}`
    );
  });
  const perDay = (sel: (r: Result) => number) => mean(rs.map((r) => sel(r) / r.patrolDays));
  console.log(
    `  MEAN/day: plants ${f(perDay((r) => r.plants))}  dets ${f(perDay((r) => r.dets))}  blastCas ${f(perDay((r) => r.blastCas))}  ` +
      `KIA ${f(perDay((r) => r.kia))}  WIA ${f(perDay((r) => r.wia))}   aggregate hit-rate ${f(
        (100 * rs.reduce((a, r) => a + r.dets, 0)) / Math.max(1, rs.reduce((a, r) => a + r.plants, 0)),
        0
      )}%   mean heatTop16 ${f(mean(rs.map((r) => r.heatTop16)))}`
  );
}

// ---------------------------------------------------------------- the read
if (POLICY_FILTER) {
  // single-policy run (parallel-sweep mode): tables above are the output; the
  // cross-policy comparison is computed by whoever merges the sweep's logs.
  const rs = results[POLICY_FILTER];
  const fail = rs.some((r) => r.nan) || rs.some((r) => r.patrols === 0);
  console.log(`\n${fail ? "PROBE MECHANICAL FAILURE" : "PROBE OK (single-policy run — compare against the paired run)"}\n`);
  process.exit(fail ? 1 : 0);
}
const F = results.fixed;
const V = results.varied;
const sum = (rs: Result[], sel: (r: Result) => number) => rs.reduce((a, r) => a + sel(r), 0);
const hitF = sum(F, (r) => r.dets) / Math.max(1, sum(F, (r) => r.plants));
const hitV = sum(V, (r) => r.dets) / Math.max(1, sum(V, (r) => r.plants));
const detDayF = mean(F.map((r) => r.dets / r.patrolDays));
const detDayV = mean(V.map((r) => r.dets / r.patrolDays));
const casF = mean(F.map((r) => (r.kia + r.wia) / r.patrolDays));
const casV = mean(V.map((r) => (r.kia + r.wia) / r.patrolDays));
const heatF = mean(F.map((r) => r.heatTop16));
const heatV = mean(V.map((r) => r.heatTop16));

console.log(`\n=== THE PREDICTABILITY TAX (fixed − varied, per patrol-day where noted) ===`);
console.log(`  heat concentration (top16 share):  fixed ${f(heatF)} vs varied ${f(heatV)}  ${heatF > heatV ? "(instrument OK: fixed concentrates)" : "(!! policies did NOT differ in heat — comparison void)"}`);
console.log(`  IED hit-rate:                      fixed ${f(100 * hitF, 0)}% vs varied ${f(100 * hitV, 0)}%   (${sum(F, (r) => r.dets)}/${sum(F, (r) => r.plants)} vs ${sum(V, (r) => r.dets)}/${sum(V, (r) => r.plants)})`);
console.log(`  detonations/day:                   fixed ${f(detDayF)} vs varied ${f(detDayV)}`);
console.log(`  blast casualties (30 m proxy):     fixed ${sum(F, (r) => r.blastCas)} (${sum(F, (r) => r.blastKIA)} KIA) vs varied ${sum(V, (r) => r.blastCas)} (${sum(V, (r) => r.blastKIA)} KIA)`);
console.log(`  total casualties/day (KIA+WIA):    fixed ${f(casF)} vs varied ${f(casV)}   (all causes — ambush fire included; trajectory noise applies)`);
console.log(`  early-ended tours (relief):        fixed ${F.filter((r) => r.endDay <= DAYS).length}/${F.length} vs varied ${V.filter((r) => r.endDay <= DAYS).length}/${V.length}`);
console.log(`  tour scores:                       fixed [${F.map((r) => r.score).join(", ")}] vs varied [${V.map((r) => r.score).join(", ")}]`);

// mechanical failures only (probe law: never assert the sim's own output values)
let hardFail = 0;
if ([...F, ...V].some((r) => r.nan)) {
  console.error("  !! NaN positions observed — mechanical failure");
  hardFail++;
}
if ([...F, ...V].some((r) => r.patrols === 0)) {
  console.error("  !! a run issued ZERO patrols — policy loop broken");
  hardFail++;
}
console.log(`\n${hardFail ? "PROBE MECHANICAL FAILURE" : "PROBE OK (numbers above are the finding — no gate asserted)"}\n`);
if (hardFail) process.exit(1);
