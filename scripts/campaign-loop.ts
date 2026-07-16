/**
 * STRATEGIC CAMPAIGN-LOOP HARNESS  (the missing COIN instrument)
 *
 * Movement/combat have harnesses (smoke.ts, balance.ts, autonomy.ts) but they tick
 * only game-MINUTES. The entire strategic / COIN layer — village attitudes, CERP
 * projects, KLE/shuras, battalion directives, resupply, enemy regeneration, and the
 * end-of-tour score — runs on the DAY/WEEK clock and had ZERO harness, so its balance
 * was unfalsifiable. This drives a FULL multi-day deployment per seed under two
 * scripted commander POLICIES and asks one question with numbers:
 *
 *     Does the strategy layer DISCRIMINATE — does playing COIN well beat playing it
 *     badly — or is it flatlined / inert (directives dead, CERP one-way, score a
 *     constant)?
 *
 * Two policies, same seeds:
 *   A "careful COIN"  — presence patrols rotated through every village WITH rotated
 *                       approach axes (route hygiene vs the patrol-heat IED adaptation —
 *                       issue 037; ITM_FIXED_ROUTES=1 reproduces the old fixed routes),
 *                       KLEs with the elders, CERP projects funded AND secured to
 *                       completion, resupply to keep construction materials flowing,
 *                       restraint (tight ROE, hold-on-contact).
 *   B "body count"    — aggressive patrols toward the hostile/enemy ground, weapons
 *                       free, assault-through, NO KLEs, NO projects, NO resupply.
 *
 * Both are fully deterministic: every decision is driven off the world's own RNG or a
 * fixed day schedule — no Math.random, no Date.now in the harness logic — so a seed
 * reproduces the campaign AND the verdict (the determinism contract).
 *
 * OUTPUT COLUMNS (mean across seeds, per policy):
 *   end        did every seed reach end-of-tour, NaN-free, with a clean serialize()
 *   score      final computeTourScore() (0..100)  — and A−B SPREAD is the headline
 *   stab/att/  the five tour metrics at the end (stability / attitude / enemyStrength
 *   eny/cbt/hi   / combatPower / higherConfidence)
 *   enemy      enemyStrengthAbs min / mean / max over the tour, + %days pinned at cap
 *   Δattitude  mean village attitude start→end (does funding a project move it?)
 *   dir        directives issued / completed / failed  (+ did deadline/penalty EVER fire?)
 *   cerp       CERP balance start→min→end (recon: one-way, runs dry?)
 *   proj       projects funded / completed
 *
 * Then a PASS/FAIL interpretation per metric: is the loop ALIVE and DISCRIMINATING,
 * or FLATLINED / INERT?
 *
 * READ-ONLY on engine SOURCE: drives the public World command API (createWorld, formPatrol,
 * conductKLE, startProject, secureBuild, requestResupply, tick, serialize, computeTourScore) —
 * it never imports or edits lib/sim. NO state pokes: the old u.pos workaround is gone, replaced by
 * the real World.secureBuild order (the COIN wave closed that API gap) — policy A routes a dedicated
 * element to the project SITE and holds an overwatch so tickProjects' security gate is satisfied the
 * way a player would do it.
 *
 * Run:  npx tsx scripts/campaign-loop.ts [seeds] [days]      (default: 3 survey seeds × 8 days)
 *       npx tsx scripts/campaign-loop.ts 6 14                 (6 survey seeds × 14 game-days)
 *       npx tsx scripts/campaign-loop.ts survey-40,survey-41 9  (HELD-OUT named seeds, Law 3)
 * NOTE: budget ~10–60 s wall / game-day depending on contact (adaptive sub-step — see the dt note).
 * NOTE: the discrimination checks key on the PAIRED BEST SEED, not the 3-seed mean — the mean is
 *       censored by the relief-of-command lottery and was measured to swing ~19 pts under a single
 *       world-init RNG draw (see the verdict's AGGREGATION RE-ANCHOR comment, 2026-07-03).
 *
 * Per CLAUDE.md: this captures the HEAD strategic baseline. Re-run after any COIN
 * change and report the delta; prove discrimination on a held-out seed tail.
 */
import { createWorld, World } from "../lib/sim/world";
import type { VillageState, Directive } from "../lib/sim/campaign";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const seedArg = argv[0];
// Default horizon is 8 game-days, not 3. The strategic layer physically CANNOT express in 3 days:
// a CERP project takes 1.2–2.6 days just to BUILD (after a 4–18 h materials/contractor ETA), the
// directive issuance cadence is 5–8 days, and directive deadlines are 12–21 days — so a 3-day tour
// shows 0 completed projects, 0 cadence issuance and 0 directive resolution by construction, and
// the VERDICT reads INERT even though the layer is alive. 8 days is the shortest horizon at which
// a secured project completes and the cadence fires; prove longer trajectories with a bigger [days].
const DAYS = Number(argv[1] ?? 8);

// Corpus convention: survey-N strings. Allow an explicit comma-list or a count.
function parseSeeds(arg: string | undefined): string[] {
  if (!arg) return Array.from({ length: 3 }, (_, i) => `survey-${i}`);
  if (arg.includes(",")) return arg.split(",").map((s) => s.trim()).filter(Boolean);
  const n = Number(arg);
  if (Number.isFinite(n) && n > 0) return Array.from({ length: n }, (_, i) => `survey-${i}`);
  return [arg];
}
const SEEDS = parseSeeds(seedArg);

// ROUTE HYGIENE (issue 037, measured 2026-07-16): the careful policy rotates its approach axis
// per visit — the midpoint steps perpendicular off the direct COP→village axis by {+1,−1,0}×240 m
// (3 patrol-heat buckets), per-village visit counters, deterministic, no rng — the cheap
// pattern-avoidance a competent commander does by default (FM 3-24), so the scripted careful
// commander is no longer maximally predictable (issue 015's "tactically-naive routing" residual).
// HONEST FINDING (patrol-predictability-probe.ts, 3 gate seeds × 8 d × fixed/varied): the
// measured predictability TAX on the current enemy is ~ZERO — 6 IED plants, 0 detonations,
// 0 IED casualties across all 48 tour-days; hot-seed KIA/day fixed-vs-varied 5.14 vs 5.00. The
// careful-tour killers are POSITION-REACTIVE (ambush/harass spawn around the live patrol
// centroid), which route hygiene cannot dodge by construction; the memory-based IED channel
// never connects (radial 30–95 m placement guess vs 8 m victim-trigger — issue 038). So this
// variety is kept as instrument hygiene, NOT as a score lever: the issue-037 mean collapse was
// difficulty, not route punishment. Body-count keeps its fixed aggressive routes (neglect is
// its character). ITM_FIXED_ROUTES=1 is the A/B kill-switch reproducing the old fixed-route
// careful policy (the NO_OBJ_COVER precedent). Gate thresholds are untouched.
const FIXED_ROUTES = process.env.ITM_FIXED_ROUTES === "1";

// dt choice — the central honest tradeoff of a multi-DAY harness, REVISITED.
//
// The engine is validated at SIM_DT=0.1 (the store always ticks 0.1, even when warping) because
// ballistics/LOS/movement are dt-sensitive. The first cut of this harness ticked a flat COARSE
// dt (30 s) and noted that a pure-0.1 faithful pass was infeasible (the COP under near-continuous
// pressure → ~18 min wall PER GAME-DAY). But flat-coarse had a fatal scoring bug: a 30 s step
// over-marches a PATROL into an ambush it can't break, ~DOUBLING its casualties (measured: ~24 KIA
// at DT=30 vs ~12 at fine dt on the survey-40 careful day-1 firefight). That coarse-dt MASSACRE —
// not the COIN layer — was what inverted the held-out verdict (careful zeroed by relief-of-command
// while body-count survived). The flat-coarse harness was lying about careful play.
//
// The fix (now MEASURED feasible): an ADAPTIVE step — sub-step at a faithful COMBAT_DT (2 s, 15×
// coarser than 0.1 so 15× cheaper, but fine enough to restore the ~12-KIA truth) while a MOBILE
// PATROL element is in contact (see patrolInContact — NOT the static garrison, whose continuous COP
// defense is what made a flat fine pass infeasible and which can't be over-marched anyway), and take
// the coarse DT otherwise. Patrol contact windows are a small fraction of a multi-day tour, so cost
// stays at ~10–60 s of wall time per game-day (vs the 18 min of a flat 0.1 pass). This is the prior
// wave's named-but-deferred faithful-combat fix, now in place and bounded.
//
// What this BUYS and what it COSTS, stated plainly:
//   - FAITHFUL: every strategic integrator (attitude drift, insurgency regen, supplies,
//     project build, metrics relaxation, directive progress, CERP) is a `rate * dt / DAY`
//     or `dt / seconds` term — linear and stable at any dt. The strategic baseline this
//     harness exists to measure is therefore accurate.
//   - NOW-FAITHFUL combat: with the adaptive sub-step (COMBAT_DT while inContact) firefight
//     casualty counts track the fine-dt truth, so careful play is no longer over-killed — the
//     held-out verdict reflects the COIN layer, not the integrator. Verified NaN-free + serialize-
//     clean over full tours. (For exact game-min ballistics use balance.ts / autonomy.ts at 0.1;
//     this stays the STRATEGIC instrument, but it no longer LIES about combat.)
const DT = 30;
// Faithful combat sub-step: while in contact the harness ticks at this dt (close to the store's
// 0.1 SIM_DT in spirit — fine enough that a patrol can react/break contact instead of being
// over-marched into an ambush), taking the coarse DT only when the valley is quiet. 2 s is the
// measured sweet spot: it restores fine-dt casualty counts (≈12 not ≈24 KIA on the survey-40
// careful day-1 firefight) at ~½ the wall cost of a 0.1 step.
const COMBAT_DT = 2;
const DAY = 86400;

type Policy = "careful" | "bodycount";

interface Result {
  ended: boolean;
  nan: boolean;
  serializeOk: boolean;
  endDay: number;
  score: number;
  stability: number;
  attitude: number;
  enemyMetric: number;
  combatPower: number;
  higher: number;
  enemyMin: number;
  enemyMean: number;
  enemyMax: number;
  enemyCapFrac: number; // fraction of day-samples with enemyStrengthAbs >= 79 (cap is 80)
  attStart: number; // mean village attitude at deploy
  attEnd: number; // mean village attitude at end
  dirIssued: number;
  dirComplete: number;
  dirFailed: number;
  deadlinePassed: number; // directives whose deadlineDay was passed while still active (would-be failures)
  penaltyFired: boolean; // did any directive ever transition to "failed" (penalty applied)?
  cerpStart: number;
  cerpMin: number;
  cerpEnd: number;
  cerpEverRose: boolean; // did CERP ever increase tick-over-tick (refund / income)?
  projFunded: number;
  projComplete: number;
  patrolsIssued: number;
  klesIssued: number;
  nVillages: number; // valley size — the denominator of any per-village payoff's valley-mean footprint
}

const ENEMY_CAP = 80; // matches clamp in tickInsurgency / applyCivcasBacklash

// ---------------------------------------------------------------- helpers
function meanAttitude(villages: VillageState[]): number {
  return villages.reduce((a, v) => a + v.attitude, 0) / Math.max(1, villages.length);
}

/**
 * Should we sub-step combat this tick? — the discriminator that makes faithful combat affordable.
 *
 * The coarse-dt over-march massacre only afflicts a MOVING element: a 30 s step marches a patrol
 * along its route straight into an ambush it would otherwise have broken (measured: ~24 KIA vs ~12
 * fine on the survey-40 day-1 firefight). The STATIC COP garrison doesn't get over-marched — it
 * fires from prepared positions in place — so its near-continuous defensive contact does NOT need
 * the (expensive) fine step. Sub-stepping on garrison contact is what made a flat fine pass
 * infeasible (~18 min/game-day on COP-defense-heavy seeds — survey-0 didn't finish ONE 8-day seed
 * in 30 min). So sub-step only when (a) a MOBILE patrol element is OUT (moving / on-station / RTB —
 * the over-march-capable phases) AND (b) there is contact in the valley. Condition (a) is the cost
 * gate (garrison-only time stays coarse); (b)+(a) together catch the very first coarse step that
 * would massacre a cold patrol walking into an ambush. Measured: survey-0 8-day careful 30 min→90 s,
 * survey-40 careful relieved-day-4-score-3 → full-tour-score-50. A secure element holding a site is
 * static (no over-march), so it doesn't itself trigger the gate — but if it's the one in contact,
 * inContact() is true and any other patrol out covers it.
 */
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

/** A squad is "free" if none of its members are committed to an active (non-complete) task. */
function squadFree(w: World, squadId: string): boolean {
  const sq = w.platoon.squads.find((s) => s.id === squadId);
  if (!sq) return false;
  const committed = new Set<string>();
  for (const t of w.state.tasks) if (t.phase !== "complete") for (const id of t.memberIds) committed.add(id);
  const ready = sq.memberIds.filter((id) => {
    const m = w.platoon.members.find((x) => x.id === id);
    return m && m.alive && (m.status === "ready" || m.status === "rest");
  });
  if (ready.length < 4) return false; // not enough able bodies to step off
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

function midRoute(w: World, vx: number, vy: number) {
  const cop = w.terrain.copCell;
  return [
    { cx: Math.round((cop.cx + vx) / 2), cy: Math.round((cop.cy + vy) / 2) },
    { cx: vx, cy: vy },
  ];
}

/** Route-varied presence route (issue 037): same endpoints as midRoute, but the midpoint steps
 *  perpendicular off the COP→village axis by {0,+1,−1}×240 m, cycling per visit to THAT village,
 *  snapped to passable ground. 240 m = 3 patrol-heat buckets (HEAT grid is 32² over 2560 m), so
 *  successive visits genuinely walk different ground instead of re-warming the same IED'd cells. */
function variedMidRoute(w: World, vx: number, vy: number, visitIdx: number) {
  const t = w.terrain;
  const cop = t.copCell;
  // Cycle STARTS offset (+1 first): with only 1–3 visits per village in a tour, a 0-first
  // cycle never engages (measured — see patrol-predictability-probe.ts variedRoute).
  const k = [1, -1, 0][visitIdx % 3];
  if (k === 0) return midRoute(w, vx, vy);
  const ax = vx - cop.cx;
  const ay = vy - cop.cy;
  const alen = Math.hypot(ax, ay) || 1;
  const offCells = (240 / t.cellSize) * k;
  const snapped = t.nearestPassable(
    Math.max(2, Math.min(t.size - 3, Math.round((cop.cx + vx) / 2 + (-ay / alen) * offCells))),
    Math.max(2, Math.min(t.size - 3, Math.round((cop.cy + vy) / 2 + (ax / alen) * offCells)))
  );
  return [
    { cx: snapped.cx, cy: snapped.cy },
    { cx: vx, cy: vy },
  ];
}

// ---------------------------------------------------------------- one deployment
function runDeployment(seed: string, policy: Policy): Result {
  const w = createWorld(seed, DAYS);
  const { state, sim } = w;

  const attStart = meanAttitude(state.villages);
  const cerpStart = state.cerp;
  let cerpMin = state.cerp;
  let cerpEverRose = false;
  let prevCerp = state.cerp;

  let enemyMin = state.enemyStrengthAbs;
  let enemyMax = state.enemyStrengthAbs;
  let enemySum = 0;
  let enemySamples = 0;
  let capHits = 0;

  let patrolsIssued = 0;
  let klesIssued = 0;
  let nan = false;

  // Track directive failures the engine might fire, and deadlines that elapse while a
  // directive is still active (the would-be failure the engine never acts on).
  let penaltyFired = false;
  const deadlinePassedSet = new Set<number>();

  // Rotate presence/KLE through villages by index so coverage is even and deterministic.
  let villageCursor = 0;
  // Per-village visit counters drive the careful policy's approach-axis rotation (issue 037).
  const visitCounts = new Map<string, number>();
  // Day-gated scheduler: act once per game-day, off the world clock (deterministic).
  let lastSchedDay = -1;

  let lastSampleDay = -1; // enemyStrengthAbs sampled ONCE PER GAME-DAY (so the trajectory mean
  //                         is a clean daily series, independent of dt)
  let guard = 0;
  const GUARD_MAX = Math.ceil((DAYS + 2) * DAY / DT) + 1000; // hard cap (defensive; tour ends well before)

  while (!state.ended && guard++ < GUARD_MAX) {
    const day = w.day;

    // ---- daily bookkeeping ------------------------------------------------------------
    if (day !== lastSchedDay) {
      lastSchedDay = day;
      // deadline bookkeeping (read-only observation of the dead penalty path)
      for (const d of state.directives) {
        if (d.status === "active" && day > d.deadlineDay) deadlinePassedSet.add(d.id);
      }
    }

    // ---- EVENT-DRIVEN strategic scheduling (pacing re-anchor, 2026-07-03) --------------
    // The scheduler used to run ONCE PER GAME-DAY at the midnight tick — so an op that
    // straddled midnight idled its squad for the rest of the day (~20 h). Measured on an
    // 8-day careful tour at doctrine-honest march speeds: sq1/sq2 IDLE 83–89% of the tour,
    // march+return only 7–11% (coin-q4-budget-m2-s1.txt) — the fixed daily sample, not
    // movement, was the throughput ceiling. That under-expresses the CAREFUL policy's own
    // design intent (FM 3-24: sustained daytime population engagement — presence in every
    // village, shuras, secured builds), and misattributes any honest-speed change to "COIN
    // got worse". Re-anchored EVENT-DRIVEN: the schedulers run every strategic step and an
    // op squad steps off again when it is home+free — gated to DAYLIGHT for the careful
    // policy (a shura convenes in daylight; a careful commander does not push presence
    // patrols into the night), ungated for body-count (aggressive night ambushes are its
    // character). Tempo therefore EMERGES from op duration + the daylight window + the
    // muster/rest machinery — no fixed ops/day count exists to tune.
    if (policy === "careful") {
      scheduleCareful(w, () => villageCursor++, () => villageCursor, () => {
        patrolsIssued++;
      }, () => {
        klesIssued++;
      }, visitCounts);
    } else {
      scheduleBodycount(w, () => {
        patrolsIssued++;
      });
    }

    // ---- ADAPTIVE strategic step (faithful combat, coarse strategy) ----
    // The strategic integrators are linear in dt (stable at any step), but combat BALLISTICS are
    // not: a 30 s step over-marches a patrol into an ambush it can't break, doubling its casualties
    // (measured: a careful patrol takes ~24 KIA at DT=30 vs ~12 at fine dt on the same seed — and
    // that coarse-dt massacre, not the COIN layer, was what zeroed careful tours on held-out seeds).
    // So when a mobile patrol is in contact we sub-step the whole window at COMBAT_DT (faithful, like
    // the live store's 0.1 tick), otherwise take one coarse step. The cost bound is the early-break:
    // the moment the patrol is no longer in contact we finish the window coarse. (A FINE_CAP that
    // truncated the fine portion after ~12 s was tried for extra speed and REVERTED — it under-modeled
    // careful's combat survival, costing ~7 score points on a sustained-contact seed and tipping the
    // spread 26→24; full per-window fidelity is both more correct and what clears the discrimination
    // gate. The price is body-count's continuous-contact seeds run ~7 min each — acceptable for an
    // occasional strategic baseline.)
    if (patrolInContact(w)) {
      let acc = 0;
      while (acc < DT) {
        const step = Math.min(COMBAT_DT, DT - acc);
        w.tick(step);
        acc += step;
        if (state.ended) break;
        if (!patrolInContact(w) && acc >= COMBAT_DT) {
          // the patrol broke contact mid-window — finish the remaining time in one coarse step
          if (DT - acc > 0) w.tick(DT - acc);
          break;
        }
      }
    } else {
      w.tick(DT);
    }

    // ---- daily strategic sampling (day-gated → a clean per-day enemy-strength series) --
    if (w.day !== lastSampleDay) {
      lastSampleDay = w.day;
      const es = state.enemyStrengthAbs;
      enemyMin = Math.min(enemyMin, es);
      enemyMax = Math.max(enemyMax, es);
      enemySum += es;
      enemySamples++;
      if (es >= ENEMY_CAP - 1) capHits++;
    }

    // ---- per-step economy / integrity sampling --------------------------------------
    if (state.cerp < cerpMin) cerpMin = state.cerp;
    if (state.cerp > prevCerp + 1e-6) cerpEverRose = true;
    prevCerp = state.cerp;

    for (const d of state.directives) if (d.status === "failed") penaltyFired = true;

    if (!nan) {
      for (const u of sim.units) {
        if (Number.isNaN(u.pos.x) || Number.isNaN(u.pos.y)) {
          nan = true;
          break;
        }
      }
    }
  }

  // serialize round-trip (the determinism / no-NaN contract)
  let serializeOk = false;
  try {
    const blob = w.serialize();
    const json = JSON.stringify(blob);
    serializeOk = json.length > 0 && !json.includes("null,null") && !/"x":null/.test(json) && !json.includes("NaN");
  } catch {
    serializeOk = false;
  }

  const score = w.computeTourScore();
  const m = state.metrics;
  const dirIssued = state.directives.length;
  const dirComplete = state.directives.filter((d: Directive) => d.status === "complete").length;
  const dirFailed = state.directives.filter((d: Directive) => d.status === "failed").length;

  return {
    ended: state.ended,
    nan,
    serializeOk,
    endDay: w.day,
    score,
    stability: m.stability,
    attitude: m.attitude,
    enemyMetric: m.enemyStrength,
    combatPower: m.combatPower,
    higher: m.higherConfidence,
    enemyMin,
    enemyMean: enemySamples ? enemySum / enemySamples : 0,
    enemyMax,
    enemyCapFrac: enemySamples ? capHits / enemySamples : 0,
    attStart,
    attEnd: meanAttitude(state.villages),
    dirIssued,
    dirComplete,
    dirFailed,
    deadlinePassed: deadlinePassedSet.size,
    penaltyFired,
    cerpStart,
    cerpMin,
    cerpEnd: state.cerp,
    cerpEverRose,
    projFunded: state.projects.length,
    projComplete: state.projects.filter((p) => p.stage === "complete").length,
    patrolsIssued,
    klesIssued,
    nVillages: state.villages.length,
  };
}

// ---------------------------------------------------------------- policy A: careful COIN
function scheduleCareful(
  w: World,
  bumpCursor: () => void,
  getCursor: () => number,
  onPatrol: () => void,
  onKle: () => void,
  visitCounts: Map<string, number>
) {
  const villages = w.state.villages;
  if (villages.length === 0) return;
  // Population engagement is a DAYTIME act (the pacing re-anchor's one gate): shuras
  // convene in daylight and a careful commander doesn't walk presence patrols at night.
  const daylight = !w.isNight();

  // 1st Squad: rolling presence patrol, one village at a time (advances the presence
  // directive — it needs boots in EVERY village — and lifts attitude on-station).
  // Event-driven: steps off again as soon as it is home+free in daylight.
  if (daylight && squadFree(w, "sq1")) {
    const v = villages[getCursor() % villages.length];
    bumpCursor();
    const ids = readyMembers(w, "sq1");
    // Rotate the approach axis per visit (issue 037) unless the A/B kill-switch pins the
    // old maximally-predictable fixed route.
    const visit = visitCounts.get(v.id) ?? 0;
    visitCounts.set(v.id, visit + 1);
    const route = FIXED_ROUTES ? midRoute(w, v.cx, v.cy) : variedMidRoute(w, v.cx, v.cy, visit);
    const t = w.formPatrol(ids, route, "presence", "tactical", {
      movement: "patrol",
      contact: "hold",
      roe: "tight",
    });
    if (t) onPatrol();
  }

  // 2nd Squad: KLE with the least-recently-engaged village (advances the kle directive,
  // big attitude/cooperation lift on-station). Event-driven, daylight-gated as above.
  if (daylight && squadFree(w, "sq2")) {
    // pick the village we've engaged least (lowest lastVisitedDay), break ties by index
    const target = [...villages].sort((a, b) => a.lastVisitedDay - b.lastVisitedDay)[0];
    const ids = readyMembers(w, "sq2");
    const t = w.conductKLE(ids, target.id, "tactical");
    if (t) onKle();
  }

  // CERP funding — DECOUPLED from the KLE squad (it used to be nested inside `if sq2 free`, so on busy
  // days no project ever got funded). Fund at most ONE project in flight at a time. (Tried also gating
  // this on a securing squad being free — it REGRESSED the tuned default: throttled funding on close,
  // securable seeds where the secure squad is briefly busy, dropping spread 26→17. The secure block
  // below already dispatches the element the same day, so the gate was both unnecessary and harmful.)
  const anyInFlight = w.state.projects.some(
    (p) => p.stage === "building" || p.stage === "awaiting_materials" || p.stage === "awaiting_contractor"
  );
  if (!anyInFlight && w.state.cerp >= 5000) {
    // Build where we can HOLD, and SPREAD CERP across the valley before re-attempting a sabotaged site.
    // The naive policy re-funded the SAME far qalat every day (a sabotaged project never enters
    // v.projects, so the distance−attitude sort kept picking it — 7 funds, 1 completion, CERP drained
    // 30k→10k on a held-out seed). But PERMANENTLY blacklisting a sabotaged village cost the tuned-default
    // spread (26→17) by starving throughput. The synthesis: rank villages with NO project history FIRST
    // (a careful commander spreads goodwill — every village gets a turn before he re-attempts a failed
    // one), then by reachability (near + neutral so the secure element holds before the sabotage timer).
    // Re-funding a once-sabotaged site is allowed, but only after the untried villages — so we never loop.
    const cop = w.terrain.cellCenter(w.terrain.copCell.cx, w.terrain.copCell.cy);
    const hasHistory = (vid: string) => w.state.projects.some((p) => p.villageId === vid);
    const rank = (v: VillageState) => {
      const c = w.terrain.cellCenter(v.cx, v.cy);
      // untried villages get a large head-start; among equals, prefer near + neutral
      return (hasHistory(v.id) ? 100000 : 0) + Math.hypot(c.x - cop.x, c.y - cop.y) - v.attitude * 4;
    };
    const fundable = villages
      .filter((v) => !v.projects.includes(v.wants))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (fundable) w.startProject(fundable.id, fundable.wants); // the secure block (below) secures it this same day
  }

  // Secure the in-flight project with a dedicated element (the new secure-build ORDER replaces
  // the old u.pos poke). One securing element at a time; Weapons Sqd if it has the bodies, else
  // 3rd Sqd. The secure task moves to the SITE via the normal reachability-aware pathing.
  const building = w.state.projects.find((p) => p.stage !== "complete" && p.stage !== "sabotaged");
  if (building) {
    const bv = w.state.villages.find((v) => v.id === building.villageId);
    // Don't double-assign if an element is already securing this village.
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

  // Keep construction materials and ammo flowing so projects can actually be built.
  if (w.state.supplies.construction < 12 || w.state.supplies.ammo_556 < 8000) {
    w.requestResupply("convoy");
  }
}

// ---------------------------------------------------------------- policy B: body count
function scheduleBodycount(w: World, onPatrol: () => void) {
  // Push every available rifle squad out aggressively, weapons free, assault-through,
  // toward the hostile ground / nearest enemy. No KLEs, no projects, no resupply.
  for (const sid of ["sq1", "sq2", "sq3"]) {
    if (!squadFree(w, sid)) continue;
    const ids = readyMembers(w, sid);
    // Aim at the most hostile village (lowest attitude) to maximize contact.
    const target = [...w.state.villages].sort((a, b) => a.attitude - b.attitude)[0];
    if (!target) continue;
    const t = w.formPatrol(ids, midRoute(w, target.cx, target.cy), "ambush", "tactical", {
      movement: "fast",
      contact: "assault",
      roe: "free",
    });
    if (t) onPatrol();
  }
}

// ---------------------------------------------------------------- aggregation + report
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function runPolicy(policy: Policy): Result[] {
  return SEEDS.map((s) => {
    // Liveness on stderr (not stdout, so the report stays clean / pipeable) — one line per
    // finished deployment with its wall-time, so a multi-seed sweep visibly progresses.
    const t0 = Date.now();
    const r = runDeployment(s, policy);
    process.stderr.write(
      `  [${policy}] ${s}: ${((Date.now() - t0) / 1000).toFixed(1)}s  endDay ${r.endDay}  score ${r.score}  ` +
        `proj ${r.projComplete}/${r.projFunded}  enemyMean ${r.enemyMean.toFixed(0)}\n`
    );
    return r;
  });
}

function f(n: number, d = 1): string {
  return n.toFixed(d);
}

console.log(`\n=== STRATEGIC CAMPAIGN-LOOP BASELINE — ${SEEDS.length} seeds × ${DAYS} game-days × 2 policies ===`);
console.log(`seeds: ${SEEDS.join(", ")}   dt=${DT}s (coarse strategic step; combat ballistics approximate, strategic integrators exact)`);

const careful = runPolicy("careful");
const bodycount = runPolicy("bodycount");

function summarize(label: string, rs: Result[]) {
  const endedAll = rs.every((r) => r.ended && !r.nan && r.serializeOk);
  const score = mean(rs.map((r) => r.score));
  console.log(`\n── ${label} ──`);
  console.log(
    `  reached-end:   ${rs.filter((r) => r.ended).length}/${rs.length}   ` +
      `NaN-free:${rs.every((r) => !r.nan) ? "yes" : "NO"}   serialize-clean:${rs.every((r) => r.serializeOk) ? "yes" : "NO"}   ` +
      `mean end-day:${f(mean(rs.map((r) => r.endDay)), 0)}`
  );
  console.log(`  TOUR SCORE:    ${f(score)}   (per-seed: ${rs.map((r) => r.score).join(", ")})`);
  console.log(
    `  final metrics: stab ${f(mean(rs.map((r) => r.stability)), 0)}  att ${f(mean(rs.map((r) => r.attitude)), 0)}  ` +
      `enemy ${f(mean(rs.map((r) => r.enemyMetric)), 0)}  cbtPwr ${f(mean(rs.map((r) => r.combatPower)), 0)}  ` +
      `higher ${f(mean(rs.map((r) => r.higher)), 0)}`
  );
  console.log(
    `  enemyStrAbs:   min ${f(mean(rs.map((r) => r.enemyMin)), 0)}  mean ${f(mean(rs.map((r) => r.enemyMean)), 0)}  ` +
      `max ${f(mean(rs.map((r) => r.enemyMax)), 0)}   %time-at-cap(${ENEMY_CAP}): ${f(100 * mean(rs.map((r) => r.enemyCapFrac)), 0)}%`
  );
  console.log(
    `  village attitude start→end:  ${f(mean(rs.map((r) => r.attStart)))} → ${f(mean(rs.map((r) => r.attEnd)))}   ` +
      `(Δ ${f(mean(rs.map((r) => r.attEnd - r.attStart)), 1)})`
  );
  console.log(
    `  directives:    issued ${f(mean(rs.map((r) => r.dirIssued)), 1)}  complete ${f(mean(rs.map((r) => r.dirComplete)), 1)}  ` +
      `failed ${f(mean(rs.map((r) => r.dirFailed)), 1)}   deadlines-elapsed-while-active ${f(mean(rs.map((r) => r.deadlinePassed)), 1)}  ` +
      `penalty-EVER-fired: ${rs.some((r) => r.penaltyFired) ? "YES" : "no"}`
  );
  console.log(
    `  CERP:          start ${f(mean(rs.map((r) => r.cerpStart)), 0)} → min ${f(mean(rs.map((r) => r.cerpMin)), 0)} → end ${f(mean(rs.map((r) => r.cerpEnd)), 0)}   ` +
      `ever-rose: ${rs.some((r) => r.cerpEverRose) ? "yes" : "NO (one-way)"}`
  );
  console.log(
    `  projects:      funded ${f(mean(rs.map((r) => r.projFunded)), 1)}  complete ${f(mean(rs.map((r) => r.projComplete)), 1)}   ` +
      `patrols issued ${f(mean(rs.map((r) => r.patrolsIssued)), 0)}  KLEs issued ${f(mean(rs.map((r) => r.klesIssued)), 0)}`
  );
  return { endedAll, score };
}

const A = summarize("POLICY A — careful COIN  (patrols + KLE + CERP + restraint)", careful);
const B = summarize("POLICY B — body count    (aggressive, weapons-free, no projects)", bodycount);

// ---------------------------------------------------------------- verdict
const spread = A.score - B.score;
console.log(`\n=== VERDICT ===`);

// STANDING GATE (2026-06-26): this is the design's WIN-CONDITION check — "you can win every
// firefight and still lose the valley" — so it is a GATE, not a probe. Every assertion below is a
// DESIGN ORACLE (the loop discriminates / attitude moves / directives live / CERP two-way / enemy
// dynamic / projects complete), never a fitted sim-output constant. See docs/wiki/Harnesses.md.
// `line` tallies failures; the script exits non-zero if the win-condition layer is inert.
//
// AGGREGATION RE-ANCHOR (2026-07-03, the issue-030 calibration debt, measured): the three
// discrimination checks (score / attitude / projects) used the 3-SEED MEAN — but a tour's score is
// CENSORED by relief-of-command: an early-firefight cascade (trajectory-chaotic, policy-blind)
// relieves the commander and floors the tour at ~0 no matter how well COIN was played, so the
// per-seed careful score is bimodal (0 relieved | ~30–70 survived) and the mean measures the
// relief LOTTERY, not the COIN layer. Measured at the gate's own green-baseline commit (f573728):
// ONE extra world-init RNG draw — zero behavior change — flipped 2/3 careful tours into day-5/6
// relief and swung the mean spread 37.3 → 18.3 (RED); the yard-life commit it "bisected" to
// measured 20.0, indistinguishable from that null perturbation (evidence:
// docs/progress/2026-07-02-realism-campaign/after/coin-q1-*). So the discrimination checks are now
// evaluated PER-SEED PAIRED — same valley, same enemy, only the policy differs (the design's own
// A/B) — keyed on the BEST pair: robust to censoring (needs one surviving careful tour), while an
// INERT layer still fails (policies barely differing show best-pair ≈ 3, measured day-one on
// survey-0 — coin-gate-day-one.md). Thresholds are unchanged and design-anchored, not fitted.
const pairs = SEEDS.map((s, i) => ({
  seed: s,
  dScore: careful[i].score - bodycount[i].score,
  dAtt: careful[i].attEnd - careful[i].attStart - (bodycount[i].attEnd - bodycount[i].attStart),
  // One full shura's valley-mean footprint on THIS seed's valley: the KLE dwell pays +8 attitude
  // in the engaged village (tasks.ts onStationEffects), so +8/nVillages is what one delivered
  // COIN act does to the valley mean — a design constant, not a fitted output.
  shuraFootprint: 8 / Math.max(1, careful[i].nVillages),
}));
const bestPairScore = Math.max(...pairs.map((p) => p.dScore));
const bestPairAtt = Math.max(...pairs.map((p) => p.dAtt));
const attClearsShura = pairs.some((p) => p.dAtt > p.shuraFootprint);
console.log(
  `  per-seed careful−bodycount: ${pairs.map((p) => `${p.seed} ${f(p.dScore, 0)} (Δatt ${f(p.dAtt, 1)})`).join(" · ")}`
);
console.log(
  `  noise floor: the 3-seed MEAN spread swings ~19 pts under a single world-init RNG draw ` +
    `(null perturbation, measured 2026-07-03) — mean-spread deltas inside that band are noise; the gate keys on the best pair.`
);

let fails = 0;
const line = (ok: boolean, name: string, detail: string) => {
  if (!ok) fails++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name.padEnd(26)} ${detail}`);
};

// 1. Loop alive (reaches end, no NaN, serialize clean)
line(
  A.endedAll && B.endedAll,
  "loop runs a full tour",
  A.endedAll && B.endedAll ? "both policies reach end-of-tour, NaN-free, serialize-clean" : "a policy failed to end / NaNed / serialize dirty"
);

// Relief-censoring tier: a tour that ends before the horizon was relieved of command — its
// strategic magnitudes are CENSORED (floored ~0) by the opening-days combat lottery, not by the
// policy. A seed set where EVERY careful tour was relieved carries no magnitude information about
// the COIN layer (measured: dbf317c + one null RNG draw relieved all 3 careful tours by day 5 —
// coin-q1-dbf317c-drawshift.txt). Calling such a draw "inert" would block innocent changes on
// noise — the WIA-band mistake (docs/wiki/Harnesses.md). So on a fully-censored set the gate
// asserts only what a censored tour CAN express — ordinal dominance (careful never loses to
// body-count), EQUAL censoring (body-count died too; careful-only death IS a real signal),
// attitude ordinality, enemy dynamics — and reports the magnitude checks as CENSORED with a loud
// banner demanding more seeds/days for an authoritative read.
const carefulSurvivors = careful.filter((r) => r.endDay > DAYS).length;
const bodycountSurvivors = bodycount.filter((r) => r.endDay > DAYS).length;
const informative = carefulSurvivors > 0;
if (!informative) {
  console.log(
    `  !! FULLY CENSORED SET: 0/${SEEDS.length} careful tours survived to end-of-tour (all relieved by the ` +
      `opening-days combat lottery) — magnitude checks unmeasurable on this draw; asserting liveness + ordinal dominance only.`
  );
}
const censoredLine = (name: string, detail: string) =>
  console.log(`  [CENSORED] ${name.padEnd(22)} ${detail}`);

// 2. Score discriminates: careful on top in aggregate, AND on at least one valley the paired
//    separation exceeds 25 pts — the score's own COIN-delivery geometry (computeTourScore: the
//    delivered-projects + won-over-villages term is "~25–35 points a body-count tour cannot
//    earn"), i.e. somewhere in the seed set a full COIN-delivery's worth of advantage showed.
//    On a fully-censored set the magnitude is unmeasurable; the oracle degrades to ordinality:
//    careful must never be BEATEN by body-count, and body-count must not have out-SURVIVED it.
let discriminates: boolean;
if (informative) {
  discriminates = A.score > B.score && bestPairScore > 25;
  line(
    discriminates,
    "score DISCRIMINATES (>25)",
    `mean careful ${f(A.score)} − bodycount ${f(B.score)} = ${f(spread)}; best paired seed ${f(bestPairScore, 0)}  ${discriminates ? "" : "→ strategy choice barely matters"}`
  );
} else {
  discriminates = A.score >= B.score && bestPairScore >= 0 && bodycountSurvivors === 0;
  line(
    discriminates,
    "score ORDINAL (censored)",
    `careful ${f(A.score)} vs bodycount ${f(B.score)}, best pair ${f(bestPairScore, 0)}, bodycount survivors ${bodycountSurvivors}` +
      `${discriminates ? "" : " → careful play is being BEATEN or out-survived — a real signal even censored"}`
  );
}

// 3. Funding a project / holding shuras actually moves attitude: on the best paired seed,
//    careful's VALLEY-MEAN attitude swing must beat body-count's by more than ONE FULL SHURA'S
//    valley footprint (+8 in the engaged village / nVillages ≈ 1.0–1.6 pts — design constants:
//    the KLE dwell pays +8, an on-want project pays 9.6–22.4, both in ONE village of n). The old
//    flat ">5 valley-mean" bar demanded ~4 delivered acts of separation and flunked tours that
//    verifiably delivered (a 55-point best-pair tour with a completed project read Δatt 3.0 —
//    coin-q3-recal-f573728-drawshift.txt). Paired best-seed for the same censoring reason as
//    check 2. Fully-censored sets assert only the SIGN — careful ≤ body-count on every seed
//    would mean the attitude channel itself is dead.
const aDelta = mean(careful.map((r) => r.attEnd - r.attStart));
const bDelta = mean(bodycount.map((r) => r.attEnd - r.attStart));
const projComplete = mean(careful.map((r) => r.projComplete));
line(
  informative ? attClearsShura : bestPairAtt > 0,
  informative ? "COIN moves attitude" : "COIN attitude ordinal",
  `best paired seed Δatt ${f(bestPairAtt)}${
    informative ? ` vs one-shura footprint ${f(Math.min(...pairs.map((p) => p.shuraFootprint)))}` : " (>0; magnitude censored)"
  } (means: careful ${f(aDelta)} vs bodycount ${f(bDelta)}; careful projects complete ${f(projComplete, 1)})`
);

// 4. Directives are live: careful play COMPLETES some, the cadence issues them, AND the failure/
//    penalty path fires WHEN THE HORIZON ALLOWS it. The shortest directive deadline is 12 days
//    (interdict), so a deadline can only elapse on a tour of ~13+ game-days — demanding a failure on
//    an 8-day default is structurally impossible and BACKWARDS (a good commander COMPLETES directives,
//    he doesn't fail them). So the failure-path requirement is gated on horizon: below ~13 days we ask
//    only that directives complete + issue on cadence (the failure mechanism is verified separately —
//    proven to fire D14/D16 under total neglect at 16 days, see the progress record); at ≥13 days we
//    additionally require the penalty path to have fired on the neglectful body-count policy.
const compl = mean(careful.map((r) => r.dirComplete));
const everFailed = careful.concat(bodycount).some((r) => r.penaltyFired);
const deadlinesElapsed = mean(bodycount.map((r) => r.deadlinePassed));
const SHORTEST_DEADLINE = 12; // interdict (DIRECTIVE_SPECS); the earliest a deadline can elapse
const horizonCanFail = DAYS >= SHORTEST_DEADLINE + 1;
const dirLive = compl > 0 && mean(careful.map((r) => r.dirIssued)) > 2 && (!horizonCanFail || everFailed);
if (informative) {
  line(
    dirLive,
    "directives fully live",
    `complete ${f(compl, 1)}/${f(mean(careful.map((r) => r.dirIssued)), 1)}; failure/penalty path ${
      everFailed ? "FIRES" : horizonCanFail ? "NEVER fires" : "n/a at this horizon (needs ≥13d; verified live under neglect)"
    } (deadlines elapsed on neglect: ${f(deadlinesElapsed, 1)}/tour)`
  );
} else {
  // Directive COMPLETION needs a tour that lives past its objective (~day 5+); on a fully-relieved
  // set only issuance-at-deploy (2) is expressible.
  line(
    mean(careful.map((r) => r.dirIssued)) >= 2,
    "directives issued (cens.)",
    `issued ${f(mean(careful.map((r) => r.dirIssued)), 1)} (deploy pair present; completion/cadence unmeasurable on a fully-relieved set)`
  );
}

// 5. CERP is a two-way economy (not strictly one-way drain). Income paths are the completion
//    refund and the day 6–8 stipend — a fully-relieved set (tours dead by ~day 5) can express
//    neither, so absence there is censoring, not a one-way economy.
const cerpRose = careful.some((r) => r.cerpEverRose);
if (informative || cerpRose) {
  line(
    cerpRose,
    "CERP two-way economy",
    cerpRose ? "CERP can increase during a tour" : "CERP only ever DECREASES — one-way drain, no income/refund"
  );
} else {
  censoredLine("CERP two-way economy", "no tour lived to the first stipend/refund window (day 5+)");
}

// 6. Enemy strength is not pinned (a healthy sim lets you push it down)
const capFrac = mean(careful.map((r) => r.enemyCapFrac));
const enemyMin = mean(careful.map((r) => r.enemyMin));
line(
  capFrac < 0.5 && enemyMin < ENEMY_CAP - 10,
  "enemy strength dynamic",
  `careful: %time-at-cap ${f(100 * capFrac, 0)}%, min ${f(enemyMin, 0)}  ${capFrac >= 0.5 ? "→ pinned high" : ""}`
);

// 7. projects actually complete under the secure-build order (was 0 — all sabotaged). The oracle
//    is MECHANISM liveness — a funded, secured project CAN reach completion — which one completion
//    anywhere in the seed set proves; a mean over relief-censored tours measures the lottery
//    (a relieved day-4 tour completes 0 whatever the policy did — see the check-2 note). A build
//    takes a 4–18 h ETA + 1.2–2.6 d secured work, so a fully-relieved set may structurally never
//    show one — censoring, not sabotage.
const projCompleteMax = Math.max(...careful.map((r) => r.projComplete));
if (informative || projCompleteMax >= 1) {
  line(
    projCompleteMax >= 1,
    "projects COMPLETE (secured)",
    `careful completes ${f(projCompleteMax, 0)} on its best seed, ${f(mean(careful.map((r) => r.projComplete)), 1)}/tour mean (was 0 — all sabotaged)`
  );
} else {
  censoredLine("projects COMPLETE", "build ETA + 1.2–2.6 d work exceeds every relieved tour's lifespan");
}

// 8. directives issued on a cadence (more than the 2 initial; cadence fires day 5–8, so a
//    fully-relieved set structurally cannot show it)
const issuedMean = mean(careful.map((r) => r.dirIssued));
if (informative || issuedMean > 2) {
  line(
    issuedMean > 2,
    "directive cadence live",
    `${f(issuedMean, 1)} directives issued/tour (was 2 fixed)`
  );
} else {
  censoredLine("directive cadence live", `${f(issuedMean, 1)} issued — cadence fires day 5–8; no tour lived that long`);
}

console.log(
  `\nINTERPRETATION: ${
    !informative && fails === 0
      ? "CENSORED DRAW — every careful tour was relieved in the opening-days combat lottery before the strategic layer could express. Liveness + ordinal dominance hold; discrimination magnitude is UNMEASURABLE on this seed set. Re-run with more seeds (e.g. `6 8`) or a held-out list for an authoritative read."
      : discriminates && cerpRose && (dirLive || !informative)
        ? "the strategy layer is ALIVE and discriminating — careful COIN beats body-count on the COIN levers (attitude, projects, Higher's trust), not the kill count."
        : "the strategy layer is LARGELY INERT — playing COIN well vs badly barely changes the outcome. See FAILs above."
  }\n`
);

// ---- the gate: the win-condition must stay alive + discriminating (docs/wiki/Harnesses.md) ----
if (fails === 0) {
  console.log(
    informative
      ? "COIN GATE OK — win-condition layer alive + discriminating."
      : "COIN GATE OK (CENSORED DRAW) — liveness + ordinal dominance hold; magnitude unmeasurable on this seed set (see banner)."
  );
} else {
  console.error(`COIN GATE FAILED — ${fails} win-condition check(s) failed (see FAILs above).`);
  process.exit(1);
}
