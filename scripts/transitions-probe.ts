/**
 * TRANSITIONS PROBE — metricizes the two new contact→lull seam behaviors:
 *
 *  1. CONSOLIDATE & REORGANIZE (lib/sim/world/tasks.ts — releaseCombat / consolidating /
 *     crossLevelAmmo): when a moving/returning patrol's contact ends, the task must enter
 *     a consolidate beat — tight holdSecurity ring (r=12), the SL physically walking team
 *     to team (t.consolidateStep), rifle reserve cross-levelled onto the SAW/auto gunners
 *     once (t.aceDone), the "head count N up, K down" radio log, 30–80 s keyed to
 *     casualties+suppression, preempted instantly by renewed contact — THEN resume the march.
 *  2. MEDIC SCENE / THIRD FIGURE (lib/sim/ai/friendly.ts — buddy-aid block): while a medic
 *     is treating a casualty, the aid buddy posts security — brainState "securing", kneeling
 *     ~2.5 m off on the threat side, faceLock on the threat, NEVER facing the patient.
 *
 * Medic-scene definitions (mover-faithful — Law 4):
 *   · An EPISODE is the medic's contiguous brainState "treating" span on one casualty
 *     (medicTreat keeps "treating" during the walk-in, so the approach counts; gaps ≤2 s
 *     chain). On-casualty work alone is physically capped at ~2.6 s — bleedRate caps at 5
 *     (ballistics.ts:300) and the medic burns it at (0.6+medical*1.6)/s ≈ 2 (friendly.ts:289)
 *     — so an on-casualty-only episode could never reach the 6 s floor.
 *   · The patient is identified the way medicTreat actually tracks him (a LOCAL variable —
 *     friendly.ts:269-308, u.targetId is honored only if it points at a valid casualty):
 *     nearest same-faction unit still needing work (bleedRate>0 or untreated wounds) ≤30 m.
 *   · Coverage is demanded only on scene-POSSIBLE ticks: medic ON the casualty (<4 m, the
 *     medicOn gate), the casualty qualifies for buddy-aid (combat.ts:1801
 *     nearestDownedNeedingHelp — unconscious or bleedRate>0.3; walking-wounded get no guard
 *     BY DESIGN), an able conscious non-medic buddy ≤24 m, and ≥4 s into the episode.
 *   · STAGED SCENE: natural eligible scenes are rare (severe bleeders usually die, get
 *     buddy-TQ'd below 0.3, or stabilize in ~1 s), so each seed also runs one deterministic
 *     staged casualty (fresh world `<seed>-stage`, unconscious chest bleeder at the muster
 *     yard, threatDir due east, medic 3 m off, buddy 3 m off, 1 s coverage grace) and
 *     measures it with the SAME tracker. Guarantees the sceneCov/face assertions are
 *     exercised every run; episode floor (≥6 s) applies to natural episodes only.
 *
 * Per seed (one squad + medic presence patrol, heat 0.85, like balance.ts), per contact
 * episode (task.squadState set → cleared):
 *   contacts     contact episodes observed
 *   consol/elig  consolidates set at the lull / eligible contact-ends (eligible = lull
 *                happened in phase moving|returning AND element centroid outside the wire)
 *   meanConsS    mean ACTUAL duration of completed consolidates (design band 30–80 s)
 *   meanRingT    mean s from consolidate entry until ≥70% of living members are within
 *                16 m of the element centroid AND in brainState "holding" ("-" = never met)
 *   slWalk%      consolidates where the SL's consolidateStep advanced past 0
 *   aceRds       total reserve rounds that arrived on SAW/auto gunners across entry ticks
 *   sceneEp      medic-scene episodes (natural + staged) ≥6 s long with ≥1 s of
 *                scene-possible ticks
 *   sceneCov%    fraction of scene-possible ticks with a "securing" squadmate within 4 m
 *                of the casualty (seed aggregate)
 *   faceOK%      securing ticks whose faceLock is within ±60° of the casualty's threatDir
 *                bearing (threatDir null → merely NOT pointing at the casualty ±45°)
 *   resume%      completed consolidates followed within 120 s by phase advance / task
 *                completion / renewed contact / ≥50% of living members brainState "moving"
 *   stuck        tasks standing still >180 s post-contact with no consolidate active
 *   preempt      consolidates cut short by renewed contact (informational)
 *   end          run-end element state (home | onstation | marching | contact | consol | STUCK)
 *
 * ASSERTS (exit 1, failures printed): consolidate follows ≥90% of eligible contact-ends ·
 * resume 100% · stuck 0 · sceneCov ≥70% aggregate when scene episodes exist (the staged
 * scene makes them exist) · ZERO scene episodes where the securing man faces the casualty
 * (±45°) · the staged scene must actually produce scene-possible ticks (else inconclusive).
 * Deterministic: fixed 0.1 s dt loop, seeded worlds, no Date/Math.random.
 *
 * Run:  npx tsx scripts/transitions-probe.ts                 (6 seeds × 25 game-min)
 *       npx tsx scripts/transitions-probe.ts 8 30            (8 generated seeds × 30 min)
 *       npx tsx scripts/transitions-probe.ts trans-3 40      (named seeds × 40 min)
 */
import { createWorld } from "../lib/sim/world";
import type { World, Task } from "../lib/sim/world";
import type { Unit } from "../lib/sim/entities";

// ─── args: non-numeric tokens are seed names; numerics are [count] [minutes] ───
const tokens = process.argv.slice(2);
const named = tokens.filter((t) => !Number.isFinite(Number(t)));
const nums = tokens.filter((t) => Number.isFinite(Number(t))).map(Number);
const MINUTES = named.length > 0 ? (nums[0] ?? 25) : (nums[1] ?? 25);
const SEEDS: string[] =
  named.length > 0 ? named : Array.from({ length: nums[0] ?? 6 }, (_, i) => `trans-${i}`);

const HEAT = 0.85;
const DT = 0.1;
const GUN_ROLES = new Set(["saw_gunner", "auto_rifleman"]); // crossLevelAmmo's recipients

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (num: number, den: number) => (den > 0 ? `${((100 * num) / den).toFixed(0)}%` : "-");
/** Minimal absolute angle difference, radians. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
function centroidOf(us: Unit[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const u of us) { x += u.pos.x; y += u.pos.y; }
  return { x: x / us.length, y: y / us.length };
}

// ─── per-consolidate record ───
interface Consol {
  startT: number;
  plannedUntil: number;
  endT?: number; // clear tick (undefined = still open at run end)
  preempted?: boolean;
  ringT?: number; // s from entry to the 70%-holding-within-16m ring (undefined = never met)
  slWalk: boolean; // consolidateStep advanced past 0
  aceRds: number; // reserve rounds that landed on SAW/auto gunners across the entry tick
  resumePhase?: string; // task phase at natural expiry
  resumeDeadline?: number; // expiry + 120 s
  resumed?: boolean; // undefined = window unfinished at run end (excluded from resume%)
}
interface Contact {
  startT: number;
  endT?: number;
  eligible?: boolean; // lull in moving|returning AND centroid outside the wire
  consol?: Consol; // the consolidate set at this episode's lull, if any
}
interface Scene {
  casId: string;
  staged: boolean;
  startT: number;
  lastT: number;
  ticks: number; // treating ticks on this casualty (approach included)
  measTicks: number; // scene-POSSIBLE ticks counted for coverage (header: medicOn + buddy-aid gates)
  covTicks: number; // measured ticks with a "securing" squadmate ≤4 m of the casualty
  aidTicks: number; // diagnostics: ticks with an "aiding" buddy ≤6 m (buddy election DID work)
  faceOkTicks: number; // covered ticks with a doctrinally correct faceLock
  faceViol: boolean; // any covered tick where the securing man FACES the casualty (±45°)
}

/** Shared medic-scene tracker — identical mechanics for natural and staged scenes.
 *  graceS = settle time from episode start before coverage is demanded (natural 4 s —
 *  the buddy may have to travel; staged 1 s — the buddy starts 3 m away). */
function makeSceneTracker(world: World, staged: boolean, graceS = 4) {
  const { sim } = world;
  const live = new Map<string, Scene>();
  const closed: Scene[] = [];
  const close = (s: Scene) => closed.push(s);
  const needsWork = (o: Unit) => o.bleedRate > 0 || o.wounds.some((w) => !w.treated);
  return {
    closed,
    observe(clock: number) {
      for (const m of sim.units) {
        if (m.role !== "medic" || !m.alive || !m.conscious || m.evac) continue;
        if (m.brainState !== "treating") continue;
        // patient = medicTreat's REAL bookkeeping: targetId only if valid, else nearest
        // same-faction casualty still needing work (≤30 m so a cross-map stale read
        // can't fabricate an episode)
        let cas: Unit | undefined;
        const viaTarget = m.targetId ? sim.unit(m.targetId) : undefined;
        if (viaTarget && viaTarget.alive && viaTarget.faction === m.faction && needsWork(viaTarget) && dist(m.pos, viaTarget.pos) < 30) {
          cas = viaTarget;
        } else {
          let bd = 30;
          for (const o of sim.units) {
            if (o === m || !o.alive || o.faction !== m.faction || !needsWork(o)) continue;
            const dd = dist(m.pos, o.pos);
            if (dd < bd) { bd = dd; cas = o; }
          }
        }
        if (!cas || cas.faction !== "us") continue;
        let s = live.get(cas.id);
        if (!s || clock - s.lastT > 2) {
          if (s) { live.delete(cas.id); close(s); }
          s = { casId: cas.id, staged, startT: clock, lastT: clock, ticks: 0, measTicks: 0, covTicks: 0, aidTicks: 0, faceOkTicks: 0, faceViol: false };
          live.set(cas.id, s);
        }
        s.lastT = clock;
        s.ticks++;
        if (sim.units.some((o) => o.brainState === "aiding" && o.alive && dist(o.pos, cas.pos) <= 6)) s.aidTicks++;
        // scene-POSSIBLE tick: medic ON the casualty (the medicOn gate, friendly.ts:72 is
        // dist<4), casualty qualifies for buddy-aid (combat.ts:1801 — walking-wounded with
        // bleedRate≤0.3 get no guard by design), an able buddy ≤24 m, ≥4 s into the episode
        const casQualifies = !cas.conscious || cas.bleedRate > 0.3;
        const buddyAvail =
          casQualifies &&
          sim.units.some(
            (o) =>
              o !== m && o.id !== cas.id && o.alive && o.conscious && !o.evac &&
              o.faction === "us" && o.role !== "medic" && o.bleedRate <= 0.5 &&
              o.orderType !== "assault" && dist(o.pos, cas.pos) <= 24
          );
        if (buddyAvail && dist(m.pos, cas.pos) < 4 && clock - s.startT >= graceS) {
          s.measTicks++;
          const sec = sim.units.find(
            (o) =>
              o.brainState === "securing" && o.alive && o.conscious && !o.evac &&
              o.faction === "us" && o.id !== cas.id && dist(o.pos, cas.pos) <= 4
          );
          if (sec) {
            s.covTicks++;
            const fl = sec.faceLock;
            if (fl !== null && fl !== undefined) {
              const toCas = Math.atan2(cas.pos.y - sec.pos.y, cas.pos.x - sec.pos.x);
              const facesCas = angDiff(fl, toCas) <= Math.PI / 4; // ±45° AT the patient
              if (facesCas) s.faceViol = true;
              const td = cas.threatDir;
              const ok =
                td && (td.x !== 0 || td.y !== 0)
                  ? angDiff(fl, Math.atan2(td.y, td.x)) <= Math.PI / 3 // ±60° of the threat
                  : !facesCas;
              if (ok) s.faceOkTicks++;
            } // no faceLock at all → faceOK false (he must be locked on the threat)
          }
        }
      }
      for (const [casId, s] of live) {
        if (clock - s.lastT > 2) {
          live.delete(casId);
          close(s);
        }
      }
    },
    finish() {
      for (const s of live.values()) close(s);
      live.clear();
    },
  };
}

/** Eligible = ≥1 s of scene-possible ticks; natural episodes additionally need a ≥6 s
 *  span (the spec floor, filtering treatment flickers — a staged scene is controlled,
 *  so the duration floor would only throw away a valid controlled measurement). */
const sceneEligible = (s: Scene) =>
  s.measTicks >= 10 && (s.staged || s.lastT - s.startT >= 6);

interface SeedRow {
  seed: string;
  contacts: number;
  eligible: number;
  consolOnElig: number;
  consols: Consol[];
  scenes: Scene[]; // eligible scene episodes (natural + staged)
  stagedNote: string;
  stagedPossible: number; // scene-possible ticks the staged scene produced (0 = stage failed)
  stuck: number;
  end: string;
}

/**
 * STAGED MEDIC SCENE — deterministic micro-scenario on a fresh world: an unconscious
 * chest bleeder (bleedRate 4, non-TQable, threatDir due east) at the muster yard, the
 * medic 3 m west (close — the aid buddy DRAGS the casualty toward cover at 0.7 m/s, so
 * a distant medic chases the drag and arrives after the bleed-out), a buddy 3 m off.
 * Runs ≤60 s through the full World.tick so the real medicTreat / buddy-aid / garrison
 * code paths drive every man. Returns the tracker's episodes plus a one-line diagnostic.
 */
function runStagedScene(seed: string): { scenes: Scene[]; note: string; possible: number } {
  const world = createWorld(`${seed}-stage`, 90);
  const { state, sim } = world;
  const sq = world.platoon.squads.find((s) => s.id === "sq1");
  const medic = world.platoon.members.find((m) => m.role === "medic");
  if (!sq || !medic) return { scenes: [], note: "stage SKIPPED (no sq1/medic)", possible: 0 };
  const sqUnits = sq.memberIds
    .map((id) => sim.unit(id))
    .filter((u): u is Unit => !!u && u.alive && u.role !== "medic");
  const victim = sqUnits.find((u) => u.role === "rifleman") ?? sqUnits[sqUnits.length - 1];
  const buddy = sqUnits.find((u) => u !== victim);
  if (!victim || !buddy) return { scenes: [], note: "stage SKIPPED (squad too small)", possible: 0 };

  // settle 5 s of normal garrison life, then inject the casualty
  for (let i = 0; i < 50 && !state.ended; i++) world.tick(DT);
  const muster = world.musterWorld();
  victim.pos = { x: muster.x, y: muster.y };
  buddy.pos = { x: muster.x + 3, y: muster.y + 1 };
  medic.pos = { x: muster.x - 3, y: muster.y };
  victim.conscious = false;
  victim.hp = 100; // bleed 4/s → ~25 s of life; medic needs ~2 s on him
  victim.wounds.push({ region: "chest", severity: 0.6, bleeding: 4, treated: false, timeM: 0 });
  victim.bleedRate = 4; // internal — only the medic can stop it (≈2 s of treatment)
  victim.bleedTQable = 0;
  victim.threatDir = { x: 1, y: 0 }; // threat due east — the post/faceLock ground truth
  victim.moving = false;
  victim.path = [];
  // buddy-aid election is nearest-able across the faction (combat.ts:1816) — if some other
  // garrison man would win it from >20 m out, his own 24 m casualty search would miss the
  // victim and NOBODY would respond; pull the winner in so the scene is always possible
  const elected = sim.nearestAbleBuddy(victim);
  if (elected && dist(elected.pos, victim.pos) > 20) elected.pos = { x: muster.x + 4, y: muster.y - 1 };

  const tracker = makeSceneTracker(world, true, /*graceS*/ 1);
  for (let i = 0; i < 600 && !state.ended; i++) {
    world.tick(DT);
    tracker.observe(state.clock);
    if (!victim.alive) break;
    if (tracker.closed.length > 0) break; // episode over (medic done + 2 s gap)
  }
  tracker.finish();
  const scenes = tracker.closed;
  const treatS = scenes.reduce((a, s) => a + s.ticks, 0) / 10;
  const possible = scenes.reduce((a, s) => a + s.measTicks, 0);
  const cov = scenes.reduce((a, s) => a + s.covTicks, 0);
  const aid = scenes.reduce((a, s) => a + s.aidTicks, 0);
  const outcome = !victim.alive ? "victim DIED mid-scene · " : "";
  const note =
    possible === 0
      ? `stage: STAGE FAILED — ${scenes.length === 0 ? "medic never entered a treating episode" : `no scene-possible ticks (treat ${treatS.toFixed(1)}s, ${outcome}medic likely never closed <4 m)`}`
      : `stage: ${outcome}treat ${treatS.toFixed(1)}s · possible ${possible}t · aiding ${aid}t · securing ${cov}t`;
  return { scenes: scenes.filter(sceneEligible), note, possible };
}

function runSeed(seed: string): SeedRow {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = HEAT;

  // one squad + medic presence patrol toward a village, exactly like balance.ts
  const cop = terrain.copCell;
  const v = terrain.villages[Math.abs(hash(seed)) % terrain.villages.length];
  const sq = world.platoon.squads.find((s) => s.id === "sq1");
  if (!sq) throw new Error(`sq1 missing on seed ${seed}`);
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  const task = world.formPatrol(
    ids,
    [
      { cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) },
      { cx: v.cx, cy: v.cy },
    ],
    "presence",
    "tactical"
  );
  if (!task) throw new Error(`formPatrol failed on seed ${seed}`);
  const taskId = task.id;
  state.nextActivityAt = 0; // first enemy activity ASAP

  const copW = world.copWorld();
  const wireM = terrain.cop.radius * terrain.cellSize;

  // trackers
  const contacts: Contact[] = [];
  let openContact: Contact | undefined;
  let lastEnded: Contact | undefined;
  const consols: Consol[] = [];
  let openConsol: Consol | undefined;
  const pendingResumes: Consol[] = [];
  let prevSS = false;
  let prevCU: number | undefined;
  const prevReserve = new Map<string, number>(); // gunner reserveAmmo, previous tick
  let hadLull = false; // first contact episode has ended → "post-contact" begins
  let stillAnchor: { x: number; y: number } | undefined;
  let stillTimer = 0;
  let stuck = 0;
  let stuckFlagged = false;
  const sceneTracker = makeSceneTracker(world, false);

  const ticks = MINUTES * 600;
  for (let i = 0; i < ticks && !state.ended; i++) {
    world.tick(DT);
    const clock = state.clock;
    const t: Task | undefined = state.tasks.find((tk) => tk.id === taskId);
    const living = t
      ? t.memberIds
          .map((id) => sim.unit(id))
          .filter((u): u is Unit => !!u && u.alive && !u.evac)
      : [];
    const centroid = living.length > 0 ? centroidOf(living) : undefined;

    // ── contact episodes: task.squadState set → cleared ──
    const hasSS = !!t?.squadState;
    if (hasSS && !prevSS) {
      openContact = { startT: clock };
      contacts.push(openContact);
    }
    if (!hasSS && prevSS && openContact) {
      openContact.endT = clock;
      const phase = t?.phase ?? "complete";
      const insideWire = centroid ? dist(centroid, copW) <= wireM : true;
      openContact.eligible = (phase === "moving" || phase === "returning") && !insideWire;
      lastEnded = openContact;
      openContact = undefined;
      hadLull = true;
    }
    prevSS = hasSS;

    // ── consolidate lifecycle ──
    const cu = t?.consolidateUntil;
    if (cu !== undefined && prevCU === undefined && t) {
      // entry tick: releaseCombat just set the beat (crossLevelAmmo ran THIS tick too,
      // so diff the gunners' reserveAmmo against last tick's snapshot)
      let ace = 0;
      for (const u of living) {
        if (!GUN_ROLES.has(u.role)) continue;
        ace += Math.max(0, u.reserveAmmo - (prevReserve.get(u.id) ?? u.reserveAmmo));
      }
      openConsol = { startT: clock, plannedUntil: cu, slWalk: false, aceRds: ace };
      consols.push(openConsol);
      if (lastEnded && lastEnded.consol === undefined) lastEnded.consol = openConsol;
    }
    if (openConsol && cu !== undefined && t) {
      if ((t.consolidateStep ?? 0) > 0) openConsol.slWalk = true;
      if (openConsol.ringT === undefined && centroid && living.length > 0) {
        const ok = living.filter(
          (u) => u.brainState === "holding" && dist(u.pos, centroid) <= 16
        ).length;
        if (ok / living.length >= 0.7) openConsol.ringT = clock - openConsol.startT;
      }
    }
    if (cu === undefined && prevCU !== undefined && openConsol) {
      openConsol.endT = clock;
      // preempt = renewed contact cleared it (squadFight stamps squadState the same tick);
      // belt-and-braces: a clear before the planned expiry is also a preempt
      const renewed = !!t?.squadState;
      const expired = clock >= openConsol.plannedUntil - 1e-9;
      openConsol.preempted = renewed || !expired;
      if (!openConsol.preempted) {
        openConsol.resumePhase = t?.phase ?? "complete";
        openConsol.resumeDeadline = clock + 120;
        pendingResumes.push(openConsol);
      }
      openConsol = undefined;
    }
    prevCU = cu;

    // ── resume watch (completed consolidates only) ──
    for (const c of pendingResumes) {
      if (c.resumed !== undefined) continue;
      if (clock > (c.resumeDeadline ?? 0)) {
        c.resumed = false;
        continue;
      }
      if (!t) { c.resumed = true; continue; } // task completed → element home
      if (t.phase !== c.resumePhase) { c.resumed = true; continue; } // phase advanced
      if (t.squadState) { c.resumed = true; continue; } // renewed contact preempts the march
      if (clock >= (c.endT ?? 0) + 1 && living.length > 0) {
        // 1 s past expiry so we don't credit the exit tick's own brainState stamp
        const moving = living.filter((u) => u.brainState === "moving").length;
        if (moving / living.length >= 0.5) c.resumed = true;
      }
    }

    // ── stuck watch: post-contact stillness with no consolidate, out of contact ──
    if (
      t && hadLull && centroid &&
      !t.squadState && t.consolidateUntil === undefined &&
      (t.phase === "moving" || t.phase === "returning")
    ) {
      if (!stillAnchor || dist(centroid, stillAnchor) > 3) {
        stillAnchor = { ...centroid };
        stillTimer = 0;
      } else {
        stillTimer += DT;
      }
      if (stillTimer > 180 && !stuckFlagged) {
        stuckFlagged = true;
        stuck++;
      }
    } else {
      stillAnchor = undefined;
      stillTimer = 0;
    }

    // ── medic scenes (natural) ──
    sceneTracker.observe(clock);

    // snapshot the gunners' reserve for next tick's entry-diff
    for (const u of living) if (GUN_ROLES.has(u.role)) prevReserve.set(u.id, u.reserveAmmo);
  }

  // run end: close open scenes; finish bookkeeping
  sceneTracker.finish();
  const tEnd = state.tasks.find((tk) => tk.id === taskId);
  const end = !tEnd
    ? "home"
    : tEnd.squadState
      ? "contact"
      : tEnd.consolidateUntil !== undefined
        ? "consol"
        : tEnd.phase === "onstation"
          ? "onstation"
          : stuckFlagged
            ? "STUCK"
            : tEnd.phase;

  const staged = runStagedScene(seed);
  const closedEpisodes = contacts.filter((c) => c.endT !== undefined);
  const eligible = closedEpisodes.filter((c) => c.eligible).length;
  const consolOnElig = closedEpisodes.filter((c) => c.eligible && c.consol).length;
  return {
    seed,
    contacts: contacts.length,
    eligible,
    consolOnElig,
    consols,
    scenes: [...sceneTracker.closed.filter(sceneEligible), ...staged.scenes],
    stagedNote: staged.note,
    stagedPossible: staged.possible,
    stuck,
    end,
  };
}

// ─── run + print ───
console.log(
  `\n=== TRANSITIONS PROBE (${SEEDS.length} seeds × ${MINUTES} game-min · sq1+medic presence patrol · heat ${HEAT} · +1 staged medic scene/seed) ===`
);
console.log(
  `legend: consol/elig=consolidates at eligible lulls · meanConsS=completed-consolidate duration · ringT=s to 70%-holding ring`
);
console.log(
  `        slWalk%=SL walked the line · aceRds=rounds cross-levelled to guns · sceneCov%/faceOK%=third-figure coverage/facing\n`
);

const W = [12, 9, 12, 10, 10, 8, 8, 8, 10, 9, 8, 6, 8, 0];
const HDR = ["seed", "contacts", "consol/elig", "meanConsS", "meanRingT", "slWalk%", "aceRds", "sceneEp", "sceneCov%", "faceOK%", "resume%", "stuck", "preempt", "end"];
const fmtRow = (cells: (string | number)[]) =>
  cells.map((c, i) => String(c).padEnd(W[i] || 0)).join("");
console.log(fmtRow(HDR));
console.log("-".repeat(HDR.reduce((a, _, i) => a + (W[i] || 6), 0)));

const rows: SeedRow[] = [];
for (const seed of SEEDS) {
  const r = runSeed(seed);
  rows.push(r);
  const completed = r.consols.filter((c) => c.endT !== undefined && !c.preempted);
  const ringTs = r.consols.filter((c) => c.ringT !== undefined).map((c) => c.ringT!);
  const resumeJudged = completed.filter((c) => c.resumed !== undefined);
  const resumed = resumeJudged.filter((c) => c.resumed).length;
  const meas = r.scenes.reduce((a, s) => a + s.measTicks, 0);
  const cov = r.scenes.reduce((a, s) => a + s.covTicks, 0);
  const fok = r.scenes.reduce((a, s) => a + s.faceOkTicks, 0);
  console.log(
    fmtRow([
      r.seed,
      r.contacts,
      `${r.consolOnElig}/${r.eligible}`,
      completed.length ? avg(completed.map((c) => c.endT! - c.startT)).toFixed(1) : "-",
      ringTs.length ? avg(ringTs).toFixed(1) : "-",
      pct(r.consols.filter((c) => c.slWalk).length, r.consols.length),
      r.consols.reduce((a, c) => a + c.aceRds, 0),
      r.scenes.length,
      pct(cov, meas),
      pct(fok, cov),
      pct(resumed, resumeJudged.length),
      r.stuck,
      r.consols.filter((c) => c.preempted).length,
      r.end,
    ])
  );
  console.log(`${"".padEnd(12)}  ${r.stagedNote}`);
}

// MEAN / aggregate row
const allConsols = rows.flatMap((r) => r.consols);
const allCompleted = allConsols.filter((c) => c.endT !== undefined && !c.preempted);
const allRingTs = allConsols.filter((c) => c.ringT !== undefined).map((c) => c.ringT!);
const allJudged = allCompleted.filter((c) => c.resumed !== undefined);
const allResumed = allJudged.filter((c) => c.resumed).length;
const allScenes = rows.flatMap((r) => r.scenes);
const totMeas = allScenes.reduce((a, s) => a + s.measTicks, 0);
const totCov = allScenes.reduce((a, s) => a + s.covTicks, 0);
const totFok = allScenes.reduce((a, s) => a + s.faceOkTicks, 0);
const totElig = rows.reduce((a, r) => a + r.eligible, 0);
const totConsolOnElig = rows.reduce((a, r) => a + r.consolOnElig, 0);
const totStuck = rows.reduce((a, r) => a + r.stuck, 0);
const faceViolEpisodes = allScenes.filter((s) => s.faceViol).length;
console.log("-".repeat(HDR.reduce((a, _, i) => a + (W[i] || 6), 0)));
console.log(
  fmtRow([
    "MEAN",
    avg(rows.map((r) => r.contacts)).toFixed(1),
    `${totConsolOnElig}/${totElig}`,
    allCompleted.length ? avg(allCompleted.map((c) => c.endT! - c.startT)).toFixed(1) : "-",
    allRingTs.length ? avg(allRingTs).toFixed(1) : "-",
    pct(allConsols.filter((c) => c.slWalk).length, allConsols.length),
    Math.round(allConsols.reduce((a, c) => a + c.aceRds, 0) / Math.max(1, rows.length)),
    allScenes.length,
    pct(totCov, totMeas),
    pct(totFok, totCov),
    pct(allResumed, allJudged.length),
    totStuck,
    allConsols.filter((c) => c.preempted).length,
    "",
  ])
);
console.log(
  `\nringT met on ${allRingTs.length}/${allConsols.length} consolidates · resume judged on ${allJudged.length}/${allCompleted.length} completed (rest: window unfinished at run end)` +
    ` · scene episodes ${allScenes.length} (${allScenes.filter((s) => s.staged).length} staged) · faceViol episodes ${faceViolEpisodes}/${allScenes.length}`
);

// ─── ASSERTIONS ───
const failures: string[] = [];
if (totElig === 0) {
  failures.push(
    `INCONCLUSIVE: zero eligible contact-ends observed across ${SEEDS.length} seeds — the probe never exercised the consolidate seam (raise minutes/heat/seeds)`
  );
} else if (totConsolOnElig / totElig < 0.9) {
  failures.push(
    `consolidate followed only ${totConsolOnElig}/${totElig} eligible contact-ends (${((100 * totConsolOnElig) / totElig).toFixed(0)}% < 90%)`
  );
}
const resumeFails = allJudged.length - allResumed;
if (resumeFails > 0) {
  const bad = rows
    .filter((r) => r.consols.some((c) => c.resumed === false))
    .map((r) => r.seed)
    .join(", ");
  failures.push(`resume failed on ${resumeFails}/${allJudged.length} completed consolidates (seeds: ${bad})`);
}
if (totStuck > 0) {
  const bad = rows.filter((r) => r.stuck > 0).map((r) => `${r.seed}(end=${r.end})`).join(", ");
  failures.push(`stuck ${totStuck} > 0 — element(s) stood still >180 s post-contact with no consolidate (${bad})`);
}
if (rows.every((r) => r.stagedPossible === 0)) {
  failures.push(
    `INCONCLUSIVE: the staged medic scene produced zero scene-possible ticks on every seed — behavior #2 was never exercised (stage notes above)`
  );
}
if (allScenes.length > 0 && totMeas > 0 && totCov / totMeas < 0.7) {
  failures.push(
    `sceneCov ${((100 * totCov) / totMeas).toFixed(0)}% < 70% aggregate over ${allScenes.length} medic-scene episodes (${totCov}/${totMeas} possible ticks covered)`
  );
}
if (faceViolEpisodes > 0) {
  failures.push(
    `${faceViolEpisodes} medic-scene episode(s) had the securing man FACING the casualty (±45°) — must be zero`
  );
}

if (failures.length > 0) {
  console.log(`\nFAIL (${failures.length}):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `\nOK — consolidate ${totConsolOnElig}/${totElig} eligible lulls · resume ${allResumed}/${allJudged.length} · stuck 0 · ` +
    `sceneCov ${pct(totCov, totMeas)} over ${allScenes.length} episodes (${allScenes.filter((s) => s.staged).length} staged) · faceViol 0`
);
process.exit(0);
