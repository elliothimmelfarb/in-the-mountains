/**
 * Stall-watchdog THRASH probe. Instruments the navigator (point man) of a worst-case
 * patrol and counts:
 *   - replanDrops: ticks where the watchdog cleared nav.path/pathGoal (blockedTimer hit
 *     STALL_WINDOW). Each drop forces drivePatrol to re-issue an A* next tick.
 *   - identicalReplans: re-issues whose FIRST waypoint is within 0.5 m of the previous
 *     re-issue's first waypoint AND whose start pos moved <1 m since the last drop —
 *     i.e. A* (deterministic) handed back the SAME wall-ward route from the SAME spot.
 *   - longBlockRun: longest continuous run (s) blockedTimer was >0 without ever resetting
 *     (a slide-along-wall or wedge that produces no real progress).
 *   - maxBlocked: peak blockedTimer reached.
 * Run: npx tsx scripts/thrash-probe.ts
 */
import { createWorld } from "../lib/sim/world";

const SEEDS = ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "survey-1", "survey-4", "survey-12"];
const ARRIVE = 25;

console.log(
  "seed".padEnd(12),
  "vilDist".padStart(8),
  "arrived".padStart(8),
  "drops".padStart(6),
  "identRe".padStart(8),
  "longBlk".padStart(8),
  "maxBlk".padStart(7),
  "verdict"
);

for (const seed of SEEDS) {
  let w: any;
  try {
    w = createWorld(seed, 60);
  } catch {
    continue;
  }
  const t = w.terrain;
  const cop = t.cop;
  const gateDir = cop.gateDir as { x: number; y: number };
  const gateAng = Math.atan2(gateDir.y, gateDir.x);
  let worst: any = null;
  let worstScore = -Infinity;
  for (const v of t.villages) {
    const bx = v.cx - cop.center.cx;
    const by = v.cy - cop.center.cy;
    const ang = Math.atan2(by, bx);
    let diff = Math.abs(ang - gateAng);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const distM = Math.hypot(bx, by) * cs0(t);
    const score = diff - distM / 800;
    if (score > worstScore && distM < 700) {
      worstScore = score;
      worst = v;
    }
  }
  if (!worst) worst = t.villages[0];
  const objW = t.cellCenter(worst.cx, worst.cy);
  const vilDistM = Math.hypot((worst.cx - cop.center.cx) * cs0(t), (worst.cy - cop.center.cy) * cs0(t));

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1")!;
  const ids: string[] = sq.memberIds.slice();
  const task = w.formPatrol(ids, [{ cx: worst.cx, cy: worst.cy }], "presence", "patrol");

  let drops = 0;
  let identicalReplans = 0;
  let longBlockRun = 0;
  let curBlockRun = 0;
  let maxBlocked = 0;
  let leadMaxArrive = Infinity;
  let onStation = false;

  let prevPath = -1; // length last tick — detect the watchdog clearing it
  let lastDropPos: { x: number; y: number } | null = null;
  let lastDropFirstWp: { x: number; y: number } | null = null;

  for (let k = 0; k < 12000; k++) {
    w.tick(0.1);
    const lead = task.leadId ? w.sim.unit(task.leadId) : null;
    if (lead) {
      const bt = lead.blockedTimer ?? 0;
      maxBlocked = Math.max(maxBlocked, bt);
      if (bt > 0) {
        curBlockRun += 0.1;
        longBlockRun = Math.max(longBlockRun, curBlockRun);
      } else curBlockRun = 0;

      // Detect a watchdog drop: path went from >0 to 0 with the unit NOT near its goal
      // (an arrival also empties the path; exclude that).
      if (prevPath > 0 && lead.path.length === 0 && lead.pathGoal == null) {
        const farFromGoal = dist(lead.pos, objW) > ARRIVE * 2;
        if (farFromGoal) {
          drops++;
          lastDropPos = { ...lead.pos };
        }
      }
      // Detect the re-issue after a drop: path just became non-empty again. Compare its
      // first waypoint and the unit's position to the moment of the last drop.
      if (prevPath === 0 && lead.path.length > 0 && lastDropPos) {
        const movedSinceDrop = dist(lead.pos, lastDropPos);
        const firstWp = lead.path[0];
        if (lastDropFirstWp && dist(firstWp, lastDropFirstWp) < 0.5 && movedSinceDrop < 1.5) {
          identicalReplans++;
        }
        lastDropFirstWp = { ...firstWp };
      }
      prevPath = lead.path.length;
      const d = dist(lead.pos, objW);
      leadMaxArrive = Math.min(leadMaxArrive, d);
    }
    if (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete") onStation = true;
    if (task.phase === "complete") break;
  }

  const reached = leadMaxArrive < 45;
  const ok = onStation && reached;
  const verdict = ok ? "OK" : onStation ? `SET UP SHORT (${Math.round(leadMaxArrive)}m)` : `STUCK (${Math.round(leadMaxArrive)}m)`;
  console.log(
    seed.padEnd(12),
    (Math.round(vilDistM) + "m").padStart(8),
    (ok ? "yes" : "NO").padStart(8),
    String(drops).padStart(6),
    String(identicalReplans).padStart(8),
    (longBlockRun.toFixed(1) + "s").padStart(8),
    (maxBlocked.toFixed(1) + "s").padStart(7),
    verdict
  );
}

function cs0(t: any): number {
  return t.cellSize;
}
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
