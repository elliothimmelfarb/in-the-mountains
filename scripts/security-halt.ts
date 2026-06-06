/**
 * SECURITY-HALT harness — turns "soldiers get stuck on each other when they set up a
 * 360" into hard numbers, headless, across a seed sweep.
 *
 * It ISOLATES the set-up itself (the flagged behavior), not the march before it: the
 * squad is placed in a realistic strung-out file on open ground, handed a security halt
 * at the file centroid, and we measure how the perimeter occupation resolves — the thing
 * a viewer reads as "real" or "a clown-car pile-up". (Driving the full cross-valley march
 * here only buried the set-up under arrival lag; cohesion.ts owns the march.)
 *
 *   settle(s):  seconds until the element stops moving and holds (max member speed <
 *               SETTLE_V sustained). A real halt resolves in a few seconds, not a churn.
 *   churn:      mean over men of (distance walked) / (straight-line start→final). ~1.0 =
 *               everyone peeled straight to a near sector; >>1 = men crossing the ring /
 *               orbiting / jostling for a spot (the raw-index bug).
 *   maxChurn:   the worst single man's ratio (one guy marched across the whole circle).
 *   minGap(m):  smallest distance any two men ever came to each other. < ~1.1 m = bodies
 *               interpenetrating (the literal "stuck on each other").
 *   ovlp%:      fraction of man-pair-ticks closer than BODY (1.4 m) — time spent overlapping.
 *   maxGap°:    the largest UNGUARDED arc in the final security ring (ring men only). A
 *               clean 8-man 360 has ~45° gaps; a big number = a hole in the perimeter.
 *   radCV:      coefficient of variation of ring men's radius from center (consistent
 *               standoff → 0).
 *   jit°/s:     settled-state heading change rate (a slow scan is fine, ~5-10; a high
 *               number is robotic dither).
 *
 * Ring geometry (maxGap°, radCV) is measured over the SECURITY RING only — the squad
 * leader / attachments hold the inside of the perimeter and are excluded from it — while
 * minGap/ovlp/settle/churn cover everyone.
 *
 * Run: npx tsx scripts/security-halt.ts [seeds...]
 */
import { createWorld } from "../lib/sim/world";
import { buildSquad, holdSecurity, byTeam } from "../lib/sim/world/formation";
import { centroidOf } from "../lib/sim/world/helpers";
import { angle, scale } from "../lib/sim/vec";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11"];

const cs = 5;
const BODY = 1.4;
const SETTLE_V = 0.08;
const SETTLE_HOLD = 12; // ticks all-stopped before "settled"
const OCC_CAP = 700; // ticks (70 s) of occupation to observe
const RADIUS = 14; // deliberate squad-halt perimeter radius (m)
const FILE_SP = 5; // file interval when we place the strung-out squad

interface Row {
  seed: string;
  settle: number;
  churn: number;
  maxChurn: number;
  minGap: number;
  ovlp: number;
  maxGap: number;
  radCV: number;
  jit: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

function run(seed: string): Row | null {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    return null;
  }
  const t = w.terrain;
  const cop = t.cop;
  const axis = { x: cop.gateDir.x, y: cop.gateDir.y }; // file points out the gate
  const perp = { x: -axis.y, y: axis.x };

  // staging ground ~150 m out the gate, snapped onto passable open ground (a controlled,
  // open test of the set-up itself; the live game also halts at cramped village edges,
  // where the hasty-position fallback keeps men from creeping — see holdSecurity)
  const sc = t.nearestPassable(Math.round(cop.center.cx + axis.x * (cop.radius + 30)), Math.round(cop.center.cy + axis.y * (cop.radius + 30)), 26);
  const stage = t.cellCenter(sc.cx, sc.cy);

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
  if (!sq) return null;
  const ids: string[] = sq.memberIds.slice();
  const members = ids.map((id) => w.sim.unit(id)).filter(Boolean);

  // Keep the men "tasked" so the garrison/idle logic doesn't reseat them mid-halt: form a
  // patrol, then teleport it into the strung-out file and force it on-station.
  const task = w.formPatrol(ids, [{ cx: sc.cx, cy: sc.cy }], "presence", "patrol");
  if (!task) return null;
  members.forEach((u: any, i: number) => {
    const along = (i - (members.length - 1) / 2) * FILE_SP;
    const lat = (((i * 37) % 7) - 3) * 0.5; // deterministic ±1.5 m lateral jitter
    const px = stage.x - axis.x * along + perp.x * lat;
    const py = stage.y - axis.y * along + perp.y * lat;
    const c = t.nearestPassable(Math.floor(px / cs), Math.floor(py / cs), 6);
    u.pos = t.cellCenter(c.cx, c.cy);
    u.alive = true;
    u.conscious = true;
    u.evac = false;
    u.path = [];
    u.pathGoal = null;
    u.faceLock = null;
    u.formationHold = false;
    u.paceScale = 1;
    u.brainState = "holding";
    u.stance = "stand";
    u.technique = "patrol";
    u.facing = angle(scale(axis, -1));
    u.speed = 0;
    u.moving = false;
    u.blockedTimer = 0;
    u.targetId = null;
    u.threatDir = null;
    u.suppression = 0;
    u.visibleEnemyIds = [];
  });
  task.phase = "onstation";
  task.timer = 99999;
  task.exited = true;

  const center = centroidOf(members);
  holdSecurity(w, byTeam(w, members), center, RADIUS, task);

  // command element (held inside the perimeter) is excluded from ring geometry
  const sqS = buildSquad(w, members);
  const inner = new Set<string>([...(sqS.slId ? [sqS.slId] : []), ...sqS.attachedIds]);
  const ringIds = ids.filter((id) => !inner.has(id));

  const start: Record<string, { x: number; y: number }> = {};
  const travel: Record<string, number> = {};
  const last: Record<string, { x: number; y: number }> = {};
  for (const u of members) {
    start[u.id] = { ...u.pos };
    travel[u.id] = 0;
    last[u.id] = { ...u.pos };
  }

  let minGap = Infinity;
  let ovlpPairTicks = 0;
  let pairTicks = 0;
  let settleTick = -1;
  let stoppedRun = 0;

  const live = () => ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
  for (let k = 0; k < OCC_CAP; k++) {
    w.tick(0.1);
    const men = live();
    if (men.length === 0) break;
    for (const u of men) {
      travel[u.id] += Math.hypot(u.pos.x - last[u.id].x, u.pos.y - last[u.id].y);
      last[u.id] = { ...u.pos };
    }
    for (let i = 0; i < men.length; i++)
      for (let j = i + 1; j < men.length; j++) {
        const d = Math.hypot(men[i].pos.x - men[j].pos.x, men[i].pos.y - men[j].pos.y);
        if (d < minGap) minGap = d;
        pairTicks++;
        if (d < BODY) ovlpPairTicks++;
      }
    const vmax = Math.max(...men.map((u: any) => u.speed ?? 0));
    if (vmax < SETTLE_V) stoppedRun++;
    else stoppedRun = 0;
    if (settleTick < 0 && stoppedRun >= SETTLE_HOLD) settleTick = k - SETTLE_HOLD + 1;
    if (settleTick >= 0 && k - settleTick > 60) break; // settled + 6 s sampled
  }

  const men = live();
  const ring = men.filter((u: any) => ringIds.includes(u.id));
  const churnArr = men.map((u: any) => {
    const straight = Math.hypot(u.pos.x - start[u.id].x, u.pos.y - start[u.id].y);
    return travel[u.id] / Math.max(1, straight);
  });

  // ring geometry about the perimeter center
  const radii = ring.map((u: any) => Math.hypot(u.pos.x - center.x, u.pos.y - center.y));
  const bearings = ring.map((u: any) => Math.atan2(u.pos.y - center.y, u.pos.x - center.x)).sort((a: number, b: number) => a - b);
  let maxGap = 0;
  for (let i = 0; i < bearings.length; i++) {
    const nxt = i === bearings.length - 1 ? bearings[0] + Math.PI * 2 : bearings[i + 1];
    maxGap = Math.max(maxGap, nxt - bearings[i]);
  }
  const radCV = mean(radii) > 0 ? sd(radii) / mean(radii) : 0;

  // settled-state jitter
  const prevFace: Record<string, number> = {};
  const jit: number[] = [];
  for (const u of live()) prevFace[u.id] = u.facing;
  for (let k = 0; k < 40; k++) {
    w.tick(0.1);
    for (const u of live()) {
      if (prevFace[u.id] !== undefined) {
        let dh = Math.abs(u.facing - prevFace[u.id]);
        if (dh > Math.PI) dh = Math.PI * 2 - dh;
        jit.push((dh * 180) / Math.PI / 0.1);
      }
      prevFace[u.id] = u.facing;
    }
  }

  return {
    seed,
    settle: settleTick >= 0 ? settleTick * 0.1 : -1,
    churn: mean(churnArr),
    maxChurn: Math.max(...churnArr),
    minGap: minGap === Infinity ? 0 : minGap,
    ovlp: pairTicks ? (ovlpPairTicks / pairTicks) * 100 : 0,
    maxGap: (maxGap * 180) / Math.PI,
    radCV,
    jit: mean(jit),
  };
}

console.log(
  "seed".padEnd(12),
  "settle".padStart(7),
  "churn".padStart(6),
  "maxChu".padStart(7),
  "minGap".padStart(7),
  "ovlp%".padStart(6),
  "maxGap°".padStart(8),
  "radCV".padStart(6),
  "jit°/s".padStart(7)
);
const rows: Row[] = [];
for (const seed of SEEDS) {
  const r = run(seed);
  if (!r) continue;
  rows.push(r);
  console.log(
    seed.padEnd(12),
    (r.settle >= 0 ? r.settle.toFixed(1) + "s" : "—").padStart(7),
    r.churn.toFixed(2).padStart(6),
    r.maxChurn.toFixed(1).padStart(7),
    (r.minGap.toFixed(2) + "m").padStart(7),
    (r.ovlp.toFixed(1) + "%").padStart(6),
    (Math.round(r.maxGap) + "°").padStart(8),
    r.radCV.toFixed(2).padStart(6),
    r.jit.toFixed(0).padStart(7)
  );
}
const got = rows.filter((r) => r.settle >= 0);
const m = (f: (r: Row) => number, src = rows) => mean(src.map(f));
console.log("-".repeat(78));
console.log(
  "MEAN".padEnd(12),
  (got.length ? m((r) => r.settle, got).toFixed(1) + "s" : "—").padStart(7),
  m((r) => r.churn).toFixed(2).padStart(6),
  m((r) => r.maxChurn).toFixed(1).padStart(7),
  (m((r) => r.minGap).toFixed(2) + "m").padStart(7),
  (m((r) => r.ovlp).toFixed(1) + "%").padStart(6),
  (Math.round(m((r) => r.maxGap)) + "°").padStart(8),
  m((r) => r.radCV).toFixed(2).padStart(6),
  m((r) => r.jit).toFixed(0).padStart(7)
);
console.log(
  "\nlegend: settle fast good; churn≈1 good; minGap>1.1m good (no overlap); ovlp%→0 good;" +
    "\nmaxGap°≈45 good / large=hole in the 360; radCV→0 good; jit ~5-10 = live scan, high=dither."
);
