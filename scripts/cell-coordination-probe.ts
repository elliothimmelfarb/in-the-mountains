/**
 * CELL-COORDINATION PROBE — metricizes the enemy "group mind" (lib/sim/ai/cell-combat.ts).
 *
 * A led cell should (a) open an ambush as ONE volley (disciplined initiation via _cellHold),
 * (b) keep continuous fire up while half the cell displaces (group fire-and-movement), and
 * (c) peel to a shared rally instead of evaporating in four directions. This probe runs the
 * balance.ts dispatch pattern (sq1+medic presence patrol, heat 0.85; the director is held
 * until the patrol is OUT of its ~2.5-min "assembling" phase — drawn earlier, an ambush is
 * laid on a hostile village 500+ m from anyone and melts unseen — then its clock is pulled
 * forward to ≤120 s so every run draws several ambush cells ON the patrol), grouping
 * insurgents by squadId
 * (`acm-<clock>` / `acm-ied-<clock>`, cells with ≥3 members), and A/Bs the coordinator
 * against the atomized per-man FSM via the ITM_NOCELL=1 kill-switch.
 *
 * ITM_NOCELL is read ONCE at module load of cell-combat.ts, so the B side cannot run in
 * the same process: the default invocation prints side A, then self-execs this script with
 * ITM_NOCELL=1 (child_process.execSync — the audio-probe.ts precedent) for side B, then
 * prints the deltas. Deterministic per side (same seeds, all randomness from the world rng;
 * the probe's instrumentation is pure observation).
 *
 * Measurement choices (noted per the brief):
 *  - "a member fired this tick"  = his `ammo` DECREASED since last tick (reloads only ever
 *    jump ammo UP at reload start — combat.ts:996-1004 — so a negative delta is rounds fired).
 *  - "first shot per member"     = the tick his `hasFired` flips (combat.ts:1077).
 *  - "began in brainState ambush" is read in a pre-`sim.tick` hook (instance-level wrap), i.e.
 *    at exact spawn configuration — a led cell can spring the trap, and an unled man can
 *    self-trigger, on the very spawn tick, which would corrupt a post-tick snapshot.
 *
 * Columns (per seed, then a pooled AGGREGATE row per side):
 *  - ambC      qualifying ambush cells (≥3 members, ≥2 spawned in "ambush", non-IED — an IED
 *              cell's volley is the CHARGE's to initiate on both sides, so it would dilute
 *              the A/B contrast; IED cells still count for fireCont/peel)
 *  - volley(s) per-cell spread (last−first) of members' first-shot times within the opening
 *              30 s of that cell's fight (cells with ≥2 firers in the window)
 *  - fireCont  fraction of 2 s windows, while a cell is in contact (any member fired within
 *              the last 60 s, ≥1 member alive), in which ≥1 member fired (all ≥3-man cells)
 *  - enemyRPM  total insurgent rounds per in-contact minute (any insurgent fired ≤60 s ago);
 *              summed from per-tick ammo decreases (sim.ammoExpended counts ALL factions)
 *  - peel30M(n) mean pairwise distance among a cell's exfil'd members, snapshotted 30 s after
 *              the first entered "exfil" (cells where ≥3 had entered by then). NOTE the
 *              structural bias measured during the shakedown: a coordinated peel steps men
 *              out on a 2.5 s beat toward a 180 m rally, so at +30 s it is strung out ALONG
 *              the route mid-drill (large), while a rout's first few runners start compact —
 *              read it together with the convergence column:
 *  - peel90M   the SAME member set re-measured at +90 s (off-map/evac'd men drop out; needs
 *              ≥3 still present). A peel to a shared rally CONVERGES (90M < 30M); a rout
 *              disperses (90M > 30M).
 *  - usKIA/usWIA/enKIA  balance.ts sanity columns
 *
 * Hard assertion (exit 1): side-A (coordinator ON) pooled volleyP50 ≤ 2.5 s.
 * The B-side deltas (volleyP50 A≪B, fireCont A>B, peelM A<B, enemyRPM within ±15%) print
 * for the orchestrator's judgment — not asserted.
 *
 * Run:  npx tsx scripts/cell-coordination-probe.ts                 (A, then self-exec B, deltas)
 *       npx tsx scripts/cell-coordination-probe.ts 6 25 cellco     (SEEDS MINUTES PREFIX)
 *       ITM_NOCELL=1 npx tsx scripts/cell-coordination-probe.ts    (B table standalone)
 */
import { execSync } from "node:child_process";
import { createWorld } from "../lib/sim/world";

const SEEDS = Number(process.argv[2] ?? 6);
const MINUTES = Number(process.argv[3] ?? 25);
const PREFIX = process.argv[4] ?? "cellco";
const HEAT = 0.85;
const NOCELL = process.env.ITM_NOCELL === "1";
const EMIT_JSON = process.env.ITM_PROBE_EMIT_JSON === "1";

interface CellTrack {
  isIed: boolean;
  spawnAmbush: number; // members whose brainState was "ambush" at spawn (pre-first-brain-tick)
  memberIds: string[];
  firstShotS: Map<string, number>; // member -> sim time his hasFired flipped
  exfilS: Map<string, number>; // member -> sim time he first showed brainState "exfil"
  firstExfilS?: number;
  peelMeasured: boolean;
  peelSpreadM?: number;
  peelSetIds?: string[]; // the +30 s member set, re-measured at +90 s for convergence
  peel90Measured: boolean;
  peelSpread90M?: number;
  lastShotS?: number;
  firedThisWindow: boolean;
  contactWindows: number;
  firedWindows: number;
}

interface SeedRow {
  seed: string;
  ambushCells: number; // qualifying non-IED ambush cells
  volleys: number[]; // per-cell first-shot spreads (s)
  firedWindows: number;
  contactWindows: number;
  rounds: number;
  contactS: number;
  peels: number[]; // per-cell peel spreads at +30 s (m)
  peels90: number[]; // same member sets re-measured at +90 s (m)
  usKIA: number;
  usWIA: number;
  enKIA: number;
}

function runSeed(seed: string, idx: number): SeedRow {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = HEAT;

  // balance.ts dispatch pattern: sq1 + medic on a presence patrol toward a village.
  const cop = terrain.copCell;
  const v = terrain.villages[idx % terrain.villages.length];
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

  const cells = new Map<string, CellTrack>();
  const seenUnits = new Set<string>();
  const prevAmmo = new Map<string, number>();
  const prevFired = new Map<string, boolean>();

  // Observe director spawns BEFORE their first brain tick (runDirector runs earlier in the
  // same world.tick): spawn-time brainState is the only reliable cell-type discriminator.
  const origTick = sim.tick.bind(sim);
  (sim as { tick(dt: number): void }).tick = (dt: number) => {
    for (const u of sim.units) {
      if (u.faction !== "insurgent" || !u.squadId || !u.squadId.startsWith("acm-")) continue;
      if (seenUnits.has(u.id)) continue;
      seenUnits.add(u.id);
      let c = cells.get(u.squadId);
      if (!c) {
        c = {
          isIed: u.squadId.startsWith("acm-ied-"),
          spawnAmbush: 0,
          memberIds: [],
          firstShotS: new Map(),
          exfilS: new Map(),
          peelMeasured: false,
          peel90Measured: false,
          firedThisWindow: false,
          contactWindows: 0,
          firedWindows: 0,
        };
        cells.set(u.squadId, c);
      }
      c.memberIds.push(u.id);
      if (u.brainState === "ambush") c.spawnAmbush++;
      // Seed the fire-detection baselines at spawn so rounds fired ON the spawn tick
      // (firing is step 5 of this same sim.tick) are not undercounted.
      prevAmmo.set(u.id, u.ammo);
      prevFired.set(u.id, u.hasFired);
    }
    origTick(dt);
  };

  let rounds = 0;
  let contactS = 0;
  let globalLastShotS = -Infinity;

  const ticks = MINUTES * 600;
  for (let t = 0; t < ticks && !state.ended; t++) {
    world.tick(0.1);
    // Tempo control (deterministic — no rng consumed; identical logic on both A/B sides):
    // HOLD the director while the patrol is assembling — activePatrolCentroid() is null
    // during phase "assembling" (~2.5 min), and an ambush drawn then is laid on a hostile
    // village 500+ m from anyone, melts unseen at the −22 s patience, and pollutes the
    // sample (measured in the shakedown: dist-to-patrol 522 m, vis 0). Once the patrol is
    // OUT, pull the clock forward so a 25-min run draws several ambush cells on it.
    if (world.activePatrolCentroid()) {
      state.nextActivityAt = Math.min(state.nextActivityAt, state.clock + 120);
    } else {
      state.nextActivityAt = Math.max(state.nextActivityAt, state.clock + 5);
    }
    const now = sim.timeS;

    for (const u of sim.units) {
      if (u.faction !== "insurgent") continue;
      const c = u.squadId ? cells.get(u.squadId) : undefined;

      const pa = prevAmmo.get(u.id);
      if (pa !== undefined && u.ammo < pa) {
        rounds += pa - u.ammo;
        globalLastShotS = now;
        if (c) {
          c.lastShotS = now;
          c.firedThisWindow = true;
        }
      }
      prevAmmo.set(u.id, u.ammo);

      if (!(prevFired.get(u.id) ?? false) && u.hasFired) {
        if (c && !c.firstShotS.has(u.id)) c.firstShotS.set(u.id, now);
      }
      prevFired.set(u.id, u.hasFired);

      if (u.brainState === "exfil" && c && !c.exfilS.has(u.id)) {
        c.exfilS.set(u.id, now);
        if (c.firstExfilS === undefined) c.firstExfilS = now;
      }
    }

    if (now - globalLastShotS <= 60) contactS += 0.1;

    // Peel coherence: one snapshot per cell at +30 s after its first man entered exfil,
    // then the SAME member set re-measured at +90 s (convergence vs dispersion).
    for (const c of cells.values()) {
      if (c.firstExfilS === undefined) continue;
      if (!c.peelMeasured && now >= c.firstExfilS + 30) {
        c.peelMeasured = true;
        if (c.memberIds.length >= 3) {
          const members = c.memberIds
            .filter((id) => c.exfilS.has(id))
            .map((id) => sim.unit(id))
            .filter((u): u is NonNullable<typeof u> => !!u && u.alive && !u.evac);
          if (members.length >= 3) {
            c.peelSpreadM = meanPairwiseDist(members.map((u) => u.pos));
            c.peelSetIds = members.map((u) => u.id);
          }
        }
      }
      if (!c.peel90Measured && c.peelSetIds && now >= c.firstExfilS + 90) {
        c.peel90Measured = true;
        const members = c.peelSetIds
          .map((id) => sim.unit(id))
          .filter((u): u is NonNullable<typeof u> => !!u && u.alive && !u.evac);
        if (members.length >= 3) c.peelSpread90M = meanPairwiseDist(members.map((u) => u.pos));
      }
    }

    // Fire-continuity bookkeeping on a 2 s window boundary.
    if ((t + 1) % 20 === 0) {
      for (const c of cells.values()) {
        if (c.memberIds.length >= 3 && c.lastShotS !== undefined && now - c.lastShotS <= 60) {
          const alive = c.memberIds.some((id) => {
            const u = sim.unit(id);
            return !!u && u.alive && !u.evac;
          });
          if (alive) {
            c.contactWindows++;
            if (c.firedThisWindow) c.firedWindows++;
          }
        }
        c.firedThisWindow = false;
      }
    }
  }

  // Per-cell volley spreads (non-IED ambush cells; need ≥2 firers in the opening 30 s).
  const volleys: number[] = [];
  let ambushCells = 0;
  let firedWindows = 0;
  let contactWindows = 0;
  const peels: number[] = [];
  const peels90: number[] = [];
  for (const c of cells.values()) {
    if (c.memberIds.length < 3) continue;
    firedWindows += c.firedWindows;
    contactWindows += c.contactWindows;
    if (c.peelSpreadM !== undefined) peels.push(c.peelSpreadM);
    if (c.peelSpread90M !== undefined) peels90.push(c.peelSpread90M);
    if (c.isIed || c.spawnAmbush < 2) continue;
    ambushCells++;
    if (c.firstShotS.size === 0) continue; // never triggered (melted away) — no volley to score
    const times = [...c.firstShotS.values()];
    const first = Math.min(...times);
    const inWin = times.filter((x) => x <= first + 30);
    if (inWin.length >= 2) volleys.push(Math.max(...inWin) - Math.min(...inWin));
  }

  return {
    seed,
    ambushCells,
    volleys,
    firedWindows,
    contactWindows,
    rounds,
    contactS,
    peels,
    peels90,
    usKIA: world.platoon.members.filter((m) => !m.alive).length,
    usWIA: world.platoon.members.filter((m) => m.alive && m.wounds.length > 0).length,
    enKIA: world.platoon.members.reduce((a, m) => a + m.kills, 0),
  };
}

function meanPairwiseDist(pts: { x: number; y: number }[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      sum += Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      n++;
    }
  return sum / n;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function fmt(x: number, d = 2): string {
  return Number.isFinite(x) ? x.toFixed(d) : "—";
}

interface SideAgg {
  volleyP50: number;
  volleyP90: number;
  nVolley: number;
  nAmbushCells: number;
  fireCont: number;
  enemyRPM: number;
  peelSpreadM: number;
  peelSpread90M: number;
  nPeel: number;
  nPeel90: number;
  usKIA: number;
  usWIA: number;
  enKIA: number;
}

function runSide(label: string): SideAgg {
  console.log(
    `\n=== SIDE ${label}: cell coordinator ${NOCELL ? "OFF (ITM_NOCELL=1)" : "ON"} — ` +
      `${SEEDS} seeds × ${MINUTES} game-min, heat ${HEAT}, sq1+medic presence patrol ===`
  );
  console.log(
    "seed".padEnd(14) +
      "ambC volC  volley spreads (s)".padEnd(34) +
      "fireCont  enemyRPM  peel30M(n)  peel90M(n)  usKIA usWIA enKIA"
  );

  const rows: SeedRow[] = [];
  for (let i = 0; i < SEEDS; i++) rows.push(runSeed(`${PREFIX}-${i}`, i));

  for (const r of rows) {
    const fc = r.contactWindows ? r.firedWindows / r.contactWindows : NaN;
    const rpm = r.contactS >= 10 ? r.rounds / (r.contactS / 60) : NaN;
    const peel = r.peels.length ? r.peels.reduce((a, b) => a + b, 0) / r.peels.length : NaN;
    const peel90 = r.peels90.length ? r.peels90.reduce((a, b) => a + b, 0) / r.peels90.length : NaN;
    console.log(
      r.seed.padEnd(14) +
        String(r.ambushCells).padEnd(5) +
        String(r.volleys.length).padEnd(6) +
        (r.volleys.map((v) => v.toFixed(1)).join(",") || "—").padEnd(28) +
        fmt(fc).padEnd(10) +
        fmt(rpm, 1).padEnd(10) +
        `${fmt(peel, 1)}(${r.peels.length})`.padEnd(12) +
        `${fmt(peel90, 1)}(${r.peels90.length})`.padEnd(12) +
        String(r.usKIA).padEnd(6) +
        String(r.usWIA).padEnd(6) +
        String(r.enKIA)
    );
  }

  const volleys = rows.flatMap((r) => r.volleys);
  const peels = rows.flatMap((r) => r.peels);
  const peels90 = rows.flatMap((r) => r.peels90);
  const firedW = rows.reduce((a, r) => a + r.firedWindows, 0);
  const contW = rows.reduce((a, r) => a + r.contactWindows, 0);
  const rounds = rows.reduce((a, r) => a + r.rounds, 0);
  const contS = rows.reduce((a, r) => a + r.contactS, 0);
  const agg: SideAgg = {
    volleyP50: quantile(volleys, 0.5),
    volleyP90: quantile(volleys, 0.9),
    nVolley: volleys.length,
    nAmbushCells: rows.reduce((a, r) => a + r.ambushCells, 0),
    fireCont: contW ? firedW / contW : NaN,
    enemyRPM: contS >= 10 ? rounds / (contS / 60) : NaN,
    peelSpreadM: peels.length ? peels.reduce((a, b) => a + b, 0) / peels.length : NaN,
    peelSpread90M: peels90.length ? peels90.reduce((a, b) => a + b, 0) / peels90.length : NaN,
    nPeel: peels.length,
    nPeel90: peels90.length,
    usKIA: rows.reduce((a, r) => a + r.usKIA, 0) / SEEDS,
    usWIA: rows.reduce((a, r) => a + r.usWIA, 0) / SEEDS,
    enKIA: rows.reduce((a, r) => a + r.enKIA, 0) / SEEDS,
  };
  console.log(
    `AGGREGATE   volleyP50 ${fmt(agg.volleyP50, 1)} s · volleyP90 ${fmt(agg.volleyP90, 1)} s ` +
      `(${agg.nVolley} volleys / ${agg.nAmbushCells} ambush cells) · fireCont ${fmt(agg.fireCont)} · ` +
      `enemyRPM ${fmt(agg.enemyRPM, 1)} · peel30M ${fmt(agg.peelSpreadM, 1)} (${agg.nPeel}) · ` +
      `peel90M ${fmt(agg.peelSpread90M, 1)} (${agg.nPeel90}) · ` +
      `avg usKIA ${fmt(agg.usKIA)} usWIA ${fmt(agg.usWIA)} enKIA ${fmt(agg.enKIA)}`
  );
  return agg;
}

// ---------------------------------------------------------------------------

const side = NOCELL ? "B" : "A";
const agg = runSide(side);

if (EMIT_JSON) console.log("##JSON## " + JSON.stringify(agg));

let fail = false;
if (!NOCELL) {
  // Self-exec the B side (kill-switch is latched at cell-combat.ts module load, so it must
  // be a fresh process), then print the deltas.
  const out = execSync(
    `npx tsx "${process.argv[1]}" ${SEEDS} ${MINUTES} ${PREFIX}`,
    {
      env: { ...process.env, ITM_NOCELL: "1", ITM_PROBE_EMIT_JSON: "1" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  const lines = out.split("\n");
  const jsonLine = lines.find((l) => l.startsWith("##JSON## "));
  console.log(lines.filter((l) => !l.startsWith("##JSON## ")).join("\n"));
  if (!jsonLine) {
    console.error("FAIL: B side emitted no ##JSON## summary line.");
    process.exit(1);
  }
  const b = JSON.parse(jsonLine.slice("##JSON## ".length)) as SideAgg;

  const rpmPct = ((agg.enemyRPM - b.enemyRPM) / b.enemyRPM) * 100;
  console.log(`\n=== DELTA (A = coordinator ON, B = ITM_NOCELL=1) ===`);
  console.log(`volleyP50  A ${fmt(agg.volleyP50, 1)} s  vs  B ${fmt(b.volleyP50, 1)} s   (expect A ≪ B)`);
  console.log(`volleyP90  A ${fmt(agg.volleyP90, 1)} s  vs  B ${fmt(b.volleyP90, 1)} s   (expect A ≪ B)`);
  console.log(`fireCont   A ${fmt(agg.fireCont)}    vs  B ${fmt(b.fireCont)}     (expect A > B)`);
  console.log(`peel30M    A ${fmt(agg.peelSpreadM, 1)}  vs  B ${fmt(b.peelSpreadM, 1)}    (expect A < B; CAVEAT: a 2.5 s-beat peel is strung out mid-drill at +30 s)`);
  console.log(
    `peel90/30  A ${fmt(agg.peelSpread90M, 1)}/${fmt(agg.peelSpreadM, 1)}  vs  B ${fmt(b.peelSpread90M, 1)}/${fmt(b.peelSpreadM, 1)}   ` +
      `(convergence: a rally-bound peel shrinks 30→90 s, a rout disperses)`
  );
  console.log(`enemyRPM   A ${fmt(agg.enemyRPM, 1)}  vs  B ${fmt(b.enemyRPM, 1)}    (expect within ±15%; Δ ${fmt(rpmPct, 1)}%)`);

  // The one hard assertion: a led ambush opens as one volley.
  if (!(agg.volleyP50 <= 2.5)) {
    console.error(
      `\nFAIL: side-A volleyP50 ${fmt(agg.volleyP50, 2)} s > 2.5 s ` +
        `(${agg.nVolley} volleys measured) — the led ambush is not opening as one volley.`
    );
    fail = true;
  } else {
    console.log(`\nPASS: side-A volleyP50 ${fmt(agg.volleyP50, 2)} s ≤ 2.5 s (${agg.nVolley} volleys).`);
  }
}

process.exit(fail ? 1 : 0);
