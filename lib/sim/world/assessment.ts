import type { World } from "./world";
import { RNG, clamp } from "../rng";
import { DAY, EnemyCell, BubSnapshot } from "./types";
import { VillageState } from "../campaign";

/**
 * The two player-facing surfaces on the enemy network — the left-column ENEMY PICTURE panel/map
 * markers and the weekly COMMANDER'S ASSESSMENT (BUB) — both read the order of battle through the
 * ONE gate in this file (`enemyPicture`). Nothing here (and nothing the HUD renders) may reach past
 * `intelLevel` / `found` / `destroyed` / succession state to the sim's ground truth: true strength
 * at intelLevel < 3, intelLevel-0 cells, unfound caches, and the patrol-heat field must stay
 * unreachable from the DOM. A player reading the React tree learns nothing the fiction hasn't told
 * him.
 *
 * The whole module is PURE and React-free (the layer line): it reads WorldState, never mutates it
 * except through `advanceBubSchedule` (the one explicit scheduler write), and never draws from the
 * sim rng — the intelLevel-2 position FUZZ is a deterministic hash of the cell id (`RNG.hashString`,
 * the same wall-clock-free hash the render layer already uses), so the same world produces the same
 * markers every frame and the determinism probe deep-equals across a same-seed replay.
 */

// ===========================================================================
//  The shared enemy-picture gate (both HUD surfaces read this — they can't drift)
// ===========================================================================

/** One cell as the PLAYER is allowed to see it. Fields appear only at the intel level that unlocks
 *  them (Level 1 named · Level 2 located · Level 3 mapped); a broken/leaderless cell is flagged
 *  rather than detailed. Ground truth (exact strength below level 3, home coords, cache totals,
 *  patrol-heat) is never present. */
export interface EnemyCellView {
  id: string;
  level: 1 | 2 | 3;
  broken: boolean;
  leaderUnclear: boolean; // succession pending — the name is withheld until the new one arrives
  leaderName: string | null; // Level 1+ (null while leaderUnclear or broken)
  strengthBand: string | null; // Level 2 only — a BAND ("8–12 fighters"), never the exact number
  strengthApprox: number | null; // Level 3 — exact-ish ("~10")
  villages: string[] | null; // Level 2+ — the villages it draws from
  activity: "active" | "quiet" | null; // Level 2+ — from lastActivityClock
  cachesFound: number | null; // Level 3 — how many of its caches the player has located
  cachesDestroyed: number | null; // Level 3 — how many are seized/blown (a trophy count)
}

/** A cell home-area map marker. Position is FUZZED ~120 m at level 2 (deterministic hash of the
 *  cell id), true at level 3. `level` lets the renderer draw a looser reticle at 2, tighter at 3. */
export interface EnemyMarker {
  id: string;
  cx: number;
  cy: number;
  level: 2 | 3;
  label: string;
}

/** A located cache marker (found && shown). Destroyed caches stay visible, struck, for the tour. */
export interface CacheMarker {
  id: string;
  cx: number;
  cy: number;
  destroyed: boolean;
}

export interface EnemyPicture {
  rows: EnemyCellView[];
  markers: EnemyMarker[];
  caches: CacheMarker[];
  /** True when S-2 assesses unidentified groups still operate (any living intelLevel-0 cell). The
   *  COUNT of unknown cells is NEVER exposed — only that some exist. */
  unknownExist: boolean;
}

/** Strength BAND for a located (level-2) cell: bucketed to the nearest 4 so the player gets a feel,
 *  never the exact roster. "8–12 fighters"; a near-broken cell reads as understrength. */
function strengthBand(s: number): string {
  if (s < 5) return "understrength — a handful";
  const lo = Math.floor(s / 4) * 4;
  return `${lo}–${lo + 4} fighters`;
}

/** Deterministic, rng-free ~120 m position fuzz for a level-2 home marker: a stable hash of the
 *  cell id → bearing + radius. The render layer never touches the sim rng; the same world draws the
 *  same fuzzed point every frame. */
function fuzzHome(w: World, cell: EnemyCell): { cx: number; cy: number } {
  const h = RNG.hashString(cell.id + "|fuzz");
  const ang = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  const radM = 90 + ((h >>> 16) % 60); // 90..149 m
  const cs = w.terrain.cellSize;
  const dx = (Math.cos(ang) * radM) / cs;
  const dy = (Math.sin(ang) * radM) / cs;
  const n = w.terrain.size - 1;
  return { cx: clamp(Math.round(cell.homeCx + dx), 0, n), cy: clamp(Math.round(cell.homeCy + dy), 0, n) };
}

/** THE gate. Assemble everything the player is allowed to know about the network, from intelLevel /
 *  found / destroyed / succession state only. Pure; safe to call every frame. */
export function enemyPicture(w: World): EnemyPicture {
  const net = w.state.network;
  const nameOf = (id: string) => w.state.villages.find((v) => v.id === id)?.name ?? id;
  const rows: EnemyCellView[] = [];
  const markers: EnemyMarker[] = [];
  const caches: CacheMarker[] = [];
  let unknownExist = false;

  for (const c of net.cells) {
    // A cell the player never identified stays invisible — even broken. Exposing a level-0 break
    // would leak that the cell ever existed. Its collapse just quietly shrinks the "additional
    // groups" fiction below.
    if (c.intelLevel < 1) {
      if (!c.broken) unknownExist = true;
      continue;
    }
    const level = c.intelLevel as 1 | 2 | 3;
    const leaderUnclear = !c.broken && !c.leaderAlive; // succession in progress
    const label = c.broken ? c.leaderName : leaderUnclear ? "leadership unclear" : c.leaderName;

    // Owner caches the player has actually found / seized (never the cell's true total).
    const ownFound = net.caches.filter((k) => k.cellId === c.id && k.found && !k.destroyed).length;
    const ownDestroyed = net.caches.filter((k) => k.cellId === c.id && k.destroyed).length;

    const active = c.lastActivityClock > 0 && w.state.clock - c.lastActivityClock < 7 * DAY;

    rows.push({
      id: c.id,
      level,
      broken: !!c.broken,
      leaderUnclear,
      leaderName: c.broken || leaderUnclear ? null : c.leaderName,
      strengthBand: !c.broken && level === 2 ? strengthBand(c.strength) : null,
      strengthApprox: !c.broken && level >= 3 ? Math.round(c.strength) : null,
      villages: level >= 2 ? c.villageIds.map(nameOf) : null,
      activity: !c.broken && level >= 2 ? (active ? "active" : "quiet") : null,
      cachesFound: level >= 3 ? ownFound : null,
      cachesDestroyed: level >= 3 ? ownDestroyed : null,
    });

    // Home markers only once located (level 2+), and never for a broken cell (there's no home to
    // point at any more).
    if (!c.broken && level >= 2) {
      const pos = level >= 3 ? { cx: c.homeCx, cy: c.homeCy } : fuzzHome(w, c);
      markers.push({ id: c.id, cx: pos.cx, cy: pos.cy, level: level >= 3 ? 3 : 2, label });
    }
  }

  // Located caches — the crate glyphs. `found` is the gate; a destroyed cache stays on the map
  // (struck) as a trophy for the rest of the tour.
  for (const k of net.caches) {
    if (!k.found) continue;
    caches.push({ id: k.id, cx: k.cx, cy: k.cy, destroyed: k.destroyed });
  }

  return { rows, markers, caches, unknownExist };
}

// ===========================================================================
//  The weekly Commander's Assessment (BUB) — engine-side, structured, pure
// ===========================================================================

export interface AttitudeLine {
  village: string;
  attitude: number; // current (rounded)
  delta: number; // change since last assessment (rounded)
  causes: string[]; // prose fragments a staff officer would read out
}
export interface ValleySection {
  lines: AttitudeLine[];
  meanDelta: number;
}
export interface EnemySection {
  picture: EnemyPicture;
  contacts: number; // contact reports logged this week
  ieds: number; // IED events logged this week
  humint: string[]; // the week's network HUMINT lines (already gated, from the intel feed)
}
export interface DirectiveLine {
  title: string;
  status: "active" | "complete" | "failed";
  deadlineIn: number | null; // game-days until the deadline (active only); negative = overdue
  progressPct: number;
}
export interface HigherSection {
  confidence: number;
  confidenceDelta: number;
  trend: "climbing" | "steady" | "slipping";
  directives: DirectiveLine[];
  cerp: number;
  reviewOpen: boolean; // battalion's relief watch is running
  /** The relief evidence file (state.confLedger) — the attributed pattern battalion is weighing.
   *  Present only while a review is open, so it reads as consequence, not a standing scoreboard. */
  evidence: { casualties: number; civcas: number; directives: number } | null;
}
export interface MenSection {
  kia: string[]; // one somber line each, this week
  wia: string[];
  fatiguePct: number; // platoon mean fatigue
  ready: number; // men ready for duty
  strength: number; // men still standing (not KIA)
}
export interface Assessment {
  day: number;
  weekLabel: string; // "First week", "Second week", …
  clockLabel: string;
  sinceDay: number; // the day the previous assessment was taken (window start)
  valley: ValleySection;
  enemy: EnemySection;
  higher: HigherSection;
  men: MenSection;
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
function weekLabel(day: number): string {
  const wk = Math.max(1, Math.floor((day - 1) / 7)); // day 8 → week 1
  return (ORDINALS[wk - 1] ?? `${wk}th`) + " week";
}

/** Take the baseline snapshot the next assessment will diff against. Pure — used both at world
 *  creation (the deployment baseline) and by `advanceBubSchedule` after each BUB fires. */
export function bubSnapshotOf(villages: VillageState[], higherConfidence: number, day: number): BubSnapshot {
  const v: BubSnapshot["villages"] = {};
  for (const x of villages) {
    v[x.id] = {
      attitude: x.attitude,
      kept: x.keptPromises ?? 0,
      broken: x.brokenPromises ?? 0,
      grievances: (x.grievances ?? []).length,
      projects: x.projects.length,
    };
  }
  return { day, higherConfidence, villages: v };
}

/** Is a weekly assessment due? True on the first tick past 0700 on the scheduled day (or any time
 *  after, if the player warped through it). The store also gates on not-in-contact / no pending
 *  event before it actually raises the modal. */
export function assessmentDue(w: World): boolean {
  const due = w.state.nextBubDay;
  if (due === undefined || due === null) return false;
  return w.day > due || (w.day === due && w.secondsOfDay >= 7 * 3600);
}

/** After a BUB has been built and shown: re-baseline the snapshot to now and push the schedule to
 *  the next week (skipping any weeks the player warped past). The ONE state write in this module. */
export function advanceBubSchedule(w: World): void {
  w.state.bubSnapshot = bubSnapshotOf(w.state.villages, w.state.metrics.higherConfidence, w.day);
  let next = w.state.nextBubDay ?? 8;
  while (next <= w.day) next += 7;
  w.state.nextBubDay = next;
}

/** Assemble the weekly Commander's Assessment — sim-truth, structured, no JSX. The component just
 *  renders the sections. Deltas are measured from `w.state.bubSnapshot`; casualties, contacts and
 *  HUMINT are windowed by the campaign log's day field. */
export function buildWeeklyAssessment(w: World): Assessment {
  const snap = w.state.bubSnapshot;
  const sinceDay = snap?.day ?? 0;
  const day = w.day;

  // ---- 1) The valley — per-village attitude delta WITH causes ------------------------------
  const lines: AttitudeLine[] = [];
  let deltaSum = 0;
  for (const v of w.state.villages) {
    const base = snap?.villages[v.id];
    const attitude = Math.round(v.attitude);
    const delta = base ? Math.round(v.attitude - base.attitude) : 0;
    deltaSum += delta;
    const causes: string[] = [];

    // Completed / sabotaged CERP work (village.projects holds completed labels; the tail past the
    // snapshot count is what finished this week).
    if (base) {
      const finished = v.projects.slice(base.projects);
      for (const p of finished) causes.push(`the ${p} was finished`);
    }
    const sabotaged = w.state.projects.filter((p) => p.villageId === v.id && p.stage === "sabotaged").length;
    if (sabotaged > 0 && base) {
      // sabotage is rare and biting — surface it plainly (count isn't windowed, so phrase softly).
      causes.push("a project site was sabotaged");
    }

    // Kept / broken promises since the snapshot.
    if (base) {
      const kept = (v.keptPromises ?? 0) - base.kept;
      const broke = (v.brokenPromises ?? 0) - base.broken;
      if (kept > 0) causes.push(kept === 1 ? "we kept our word to the elder" : `we kept ${kept} promises`);
      if (broke > 0) causes.push(broke === 1 ? "a promise was let lapse" : `${broke} promises were let lapse`);
    }

    // Fresh civilian-casualty grievances (a blood debt to our fire).
    if (base) {
      const newGrief = (v.grievances ?? []).length - base.grievances;
      if (newGrief > 0) causes.push(newGrief === 1 ? "a household buried one of its own to our fire" : `${newGrief} households grieve our fire`);
    }

    // Presence / neglect.
    const daysSinceVisit = day - v.lastVisitedDay;
    if (v.lastVisitedDay > sinceDay) causes.push("a patrol sat with the elders");
    else if (daysSinceVisit >= 5) causes.push(`no patrol has been through in ${daysSinceVisit} days`);

    lines.push({ village: v.name, attitude, delta, causes });
  }
  // Worst movers first, then by name, so the report opens on what needs the commander's attention.
  lines.sort((a, b) => a.delta - b.delta || (a.village < b.village ? -1 : 1));
  const valley: ValleySection = { lines, meanDelta: lines.length ? Math.round(deltaSum / lines.length) : 0 };

  // ---- 2) The enemy — the SAME gated picture, plus the week's contacts/IEDs -----------------
  const inWindow = (d: number) => d > sinceDay;
  let contacts = 0;
  let ieds = 0;
  const humint: string[] = [];
  for (const l of w.state.log) {
    if (!inWindow(l.day)) continue;
    if (/\bIED\b|improvised/i.test(l.msg)) ieds++;
    else if (l.kind === "contact") contacts++;
  }
  for (const r of w.state.intel) {
    if (!inWindow(r.day) || r.source !== "HUMINT") continue;
    humint.push(r.text);
    if (humint.length >= 3) break;
  }
  const enemy: EnemySection = { picture: enemyPicture(w), contacts, ieds, humint };

  // ---- 3) Higher — confidence trend, directives, CERP, the relief evidence file -------------
  const conf = Math.round(w.state.metrics.higherConfidence);
  const confDelta = snap ? Math.round(w.state.metrics.higherConfidence - snap.higherConfidence) : 0;
  const trend = confDelta > 2 ? "climbing" : confDelta < -2 ? "slipping" : "steady";
  const directives: DirectiveLine[] = w.state.directives
    .slice()
    .sort((a, b) => {
      const rank = (s: string) => (s === "active" ? 0 : 1);
      return rank(a.status) - rank(b.status) || a.deadlineDay - b.deadlineDay;
    })
    .slice(0, 6)
    .map((d) => ({
      title: d.title,
      status: d.status,
      deadlineIn: d.status === "active" ? d.deadlineDay - day : null,
      progressPct: Math.round(d.progress * 100),
    }));
  const reviewOpen = w.state.reliefWatchClock >= 0;
  const higher: HigherSection = {
    confidence: conf,
    confidenceDelta: confDelta,
    trend,
    directives,
    cerp: w.state.cerp,
    reviewOpen,
    evidence: reviewOpen ? { ...w.state.confLedger } : null,
  };

  // ---- 4) The men — this week's KIA/WIA by name, platoon fatigue ----------------------------
  // The log is the source of names/day: a KIA line (kind "kia") is unambiguously one of ours; a
  // friendly evac is a "casualty" line that says "evacuated" (civilian-casualty lines never do).
  const kia: string[] = [];
  const wia: string[] = [];
  for (const l of w.state.log) {
    if (!inWindow(l.day)) continue;
    if (l.kind === "kia") kia.push(l.msg);
    else if (l.kind === "casualty" && /evacuated/i.test(l.msg)) wia.push(l.msg);
  }
  const alive = w.platoon.members.filter((m) => m.status !== "kia");
  const fatiguePct = alive.length ? Math.round((alive.reduce((a, m) => a + (m.fatigue ?? 0), 0) / alive.length) * 100) : 0;
  const ready = w.platoon.members.filter((m) => m.status === "ready" || m.status === "rest").length;
  const men: MenSection = { kia, wia, fatiguePct, ready, strength: alive.length };

  return {
    day,
    weekLabel: weekLabel(day),
    clockLabel: w.clockLabel(),
    sinceDay,
    valley,
    enemy,
    higher,
    men,
  };
}
