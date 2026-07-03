/**
 * SQUAD-WEDGE — cohesion / wedge ATTRIBUTION probe (owner report 2026-07-03: "squad members get
 * stuck on buildings in villages; the point man doesn't wait, so the file spreads out").
 *
 * Attributes each blocked tick to the LAND TYPE OF THE CELL THAT ACTUALLY BLOCKED THE MAN (the
 * impassable cell in the direction he's trying to move), NOT mere adjacency — adjacency conflated
 * COP Structure grind during muster with village qalat-wall grind and blamed the wrong cause.
 * FINDING: the wedge is ~0.6s/patrol on village walls, ~11.6s on COP b-huts, ~38.6s on terrain/wire
 * — "buildings in villages" is NOT qalat walls. The real defect is the point man not WAITING for a
 * wedged/strung follower; this probe's navSpeed|stuck + halt% metrics gate the wedge-wait fix.
 *
 * A/B the fix with ITM_NOWAIT=1 (disables the wedge-wait in formation.ts). The shipped follower-strand
 * `maxWedge` column WAS dead (watchStall caps blockedTimer at STALL_WINDOW=2s, so its >6 never fired) —
 * fixed in that file to sum real wedge time.
 *
 * Per patrol we report where the blocked-seconds come from:
 *   wall   : CompoundWall (village qalat perimeter)      <- the owner's "buildings in villages"
 *   struct : Structure    (COP b-huts / TOC / conex)      <- COP muster/egress grind
 *   terr   : Cliff / River / steep (natural terrain)
 *   crowd  : blocked with NO impassable cell ahead (jammed on another body)
 * plus the point-man-forward coupling:
 *   peakFwd / peakStr : max point-man-ahead-of-centroid / max file length (m)
 *   navPace|stuck     : mean nav.paceScale while >=1 follower is wedged >1s (1.0 = not waiting)
 *
 * ITM_VIL=near (default; nearest village <700m — realistic presence patrol) | far (worst-opposite).
 * Run: npx tsx scripts/scratch-village-wedge.ts [seeds...]     ITM_VIL=near|far
 */
import { createWorld } from "../lib/sim/world";
import { Land } from "../lib/sim/terrain";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11",
     "alpha-1", "bravo-2", "charlie-3", "delta-4", "echo-5", "foxtrot-6", "golf-7", "hotel-8",
     "india-9", "juliet-10", "kilo-11", "lima-12", "mike-13", "november-14", "oscar-15"];

const MODE = process.env.ITM_VIL === "far" ? "far" : "near";
const ONSTATION_HOLD = 180;
const MAX_TICK = 12000;
const WEDGE_MIN = 1.0;

type Cause = "wall" | "struct" | "terr" | "crowd";

/** Attribute a blocked man to the impassable cell he's pushing against, in his travel direction. */
function blockCause(t: any, u: any): Cause {
  const cs = t.cellSize;
  const tgt = u.orderTarget ?? (u.path && u.path.length ? u.path[0] : null);
  let dx = 0, dy = 0;
  if (tgt) { dx = tgt.x - u.pos.x; dy = tgt.y - u.pos.y; }
  const dl = Math.hypot(dx, dy);
  const classify = (cx: number, cy: number): Cause | null => {
    if (!t.inBounds(cx, cy)) return null;
    if (t.passableCell(cx, cy)) return null;
    const l = t.land[t.idx(cx, cy)] as number;
    if (l === Land.CompoundWall) return "wall";
    if (l === Land.Structure) return "struct";
    return "terr"; // cliff / river / hesco / steep
  };
  const ucx = Math.floor(u.pos.x / cs), ucy = Math.floor(u.pos.y / cs);
  // 1) the cell one step ahead along his heading
  if (dl > 1e-3) {
    const ax = Math.floor((u.pos.x + (dx / dl) * cs) / cs);
    const ay = Math.floor((u.pos.y + (dy / dl) * cs) / cs);
    const c = classify(ax, ay);
    if (c) return c;
  }
  // 2) otherwise the nearest impassable of the 8 neighbours (his slide is jammed by one of them)
  for (let dy2 = -1; dy2 <= 1; dy2++)
    for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (!dx2 && !dy2) continue;
      const c = classify(ucx + dx2, ucy + dy2);
      if (c) return c;
    }
  // 3) blocked with open ground all around → jammed on another body
  return "crowd";
}

function pickVillage(t: any) {
  const cop = t.cop;
  if (MODE === "far") {
    const gateAng = Math.atan2(cop.gateDir.y, cop.gateDir.x);
    let vil: any = null, bs = -Infinity;
    for (const v of t.villages) {
      const ang = Math.atan2(v.cy - cop.center.cy, v.cx - cop.center.cx);
      let df = Math.abs(ang - gateAng); if (df > Math.PI) df = 2 * Math.PI - df;
      const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * 5;
      const score = df - dm / 800;
      if (score > bs && dm < 700) { bs = score; vil = v; }
    }
    return vil ?? t.villages[0];
  }
  let vil: any = null, best = Infinity;
  for (const v of t.villages) {
    const dm = Math.hypot(v.cx - cop.center.cx, v.cy - cop.center.cy) * 5;
    if (dm < best && dm > 120) { best = dm; vil = v; }
  }
  return vil ?? t.villages[0];
}

function run(seed: string) {
  let w: any;
  try { w = createWorld(seed, 60); } catch { return null; }
  const t = w.terrain;
  const vil = pickVillage(t);
  if (!vil) return null;
  const objDist = Math.hypot((vil.cx - t.cop.center.cx) * t.cellSize, (vil.cy - t.cop.center.cy) * t.cellSize);

  const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
  const ids: string[] = sq.memberIds.slice();
  const task = w.formPatrol(ids, [{ cx: vil.cx, cy: vil.cy }], "presence", "patrol");

  const cause: Record<Cause, number> = { wall: 0, struct: 0, terr: 0, crowd: 0 };
  // wall-cause split by phase (approach threading alleys vs the security halt)
  let wallMoving = 0, wallHalt = 0;
  const perWall: Record<string, { role: string; sec: number }> = {};
  ids.forEach((id) => { const u = w.sim.unit(id); perWall[id] = { role: u?.role ?? "?", sec: 0 }; });

  let peakForward = 0, peakStretch = 0;
  let fwdSum = 0, marchTicks = 0, farFwdTicks = 0; // mean forward + fraction of march time >30m ahead
  let navSpeedSum = 0, navStuckN = 0, navHaltTicks = 0;
  const contig: Record<string, number> = {};
  let onstationTick = -1, reached = false;

  for (let k = 0; k < MAX_TICK; k++) {
    w.tick(0.1);
    const members = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
    if (members.length === 0) break;
    const navId = task?.leadId ?? ids[0];
    const nav = w.sim.unit(navId);

    let anyStuck = false;
    for (const u of members) {
      if ((u.blockedTimer ?? 0) > 1e-6) {
        const c = blockCause(t, u);
        cause[c] += 0.1;
        if (c === "wall") {
          if (task?.phase === "onstation") wallHalt += 0.1; else wallMoving += 0.1;
          perWall[u.id].sec += 0.1;
        }
        contig[u.id] = (contig[u.id] ?? 0) + 0.1;
        if (u.id !== navId && contig[u.id] >= WEDGE_MIN) anyStuck = true;
      } else contig[u.id] = 0;
    }

    // Only measure the PATROL MARCH — past the wire, in squad formation (steerSquad). Egress through
    // the gate runs steerFile (a deliberate full-pace pour through the choke, where the file spanning
    // muster->gate is expected and reforms past the wire); including it over-counts the point man as
    // "too far forward". task.exited flips true once the element has cleared the HESCO.
    const marching = !!task?.exited && task.phase === "moving";
    if (nav && marching) {
      const cen = members.reduce((a: any, u: any) => ({ x: a.x + u.pos.x, y: a.y + u.pos.y }), { x: 0, y: 0 });
      cen.x /= members.length; cen.y /= members.length;
      const fwd = Math.hypot(nav.pos.x - cen.x, nav.pos.y - cen.y);
      peakForward = Math.max(peakForward, fwd);
      fwdSum += fwd; marchTicks++; if (fwd > 30) farFwdTicks++;
      let far = 0; for (const u of members) far = Math.max(far, Math.hypot(u.pos.x - nav.pos.x, u.pos.y - nav.pos.y));
      peakStretch = Math.max(peakStretch, far);
      if (anyStuck) {
        navSpeedSum += nav.speed ?? 0; navStuckN++;
        if ((nav.speed ?? 0) < 0.05) navHaltTicks++; // point man actually halted while a man is wedged
      }
    }

    if (task && (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete")) {
      if (onstationTick < 0) { onstationTick = k; reached = true; }
      if ((k - onstationTick) * 0.1 > ONSTATION_HOLD) break;
    }
  }

  const worstWall = Object.values(perWall).reduce((a, b) => (b.sec > a.sec ? b : a), { role: "-", sec: 0 });
  return {
    seed, reached, objDist, cause, wallMoving, wallHalt,
    peakForward, peakStretch,
    meanForward: marchTicks ? fwdSum / marchTicks : 0,
    farFwdFrac: marchTicks ? farFwdTicks / marchTicks : 0,
    navSpeedWhenStuck: navStuckN ? navSpeedSum / navStuckN : -1,
    haltFrac: navStuckN ? navHaltTicks / navStuckN : 0,
    stuckSampleN: navStuckN,
    worstWall,
  };
}

console.log(`# village-wedge probe v2  MODE=${MODE}  (block attributed to the cell that blocks the man)\n`);
console.log(
  "seed".padEnd(12), "obj".padStart(6), "arr".padStart(4),
  "wall".padStart(7), "struct".padStart(7), "terr".padStart(7),
  "peakFwd".padStart(8), "peakStr".padStart(8), "navSpd|stuck".padStart(12), "halt%".padStart(7)
);
const rows: any[] = [];
for (const seed of SEEDS) {
  const r = run(seed); if (!r) continue; rows.push(r);
  console.log(
    seed.padEnd(12),
    (Math.round(r.objDist) + "m").padStart(6),
    (r.reached ? "y" : "N").padStart(4),
    (r.cause.wall.toFixed(1) + "s").padStart(7),
    (r.cause.struct.toFixed(1) + "s").padStart(7),
    (r.cause.terr.toFixed(1) + "s").padStart(7),
    (Math.round(r.peakForward) + "m").padStart(8),
    (Math.round(r.peakStretch) + "m").padStart(8),
    (r.navSpeedWhenStuck < 0 ? "-" : r.navSpeedWhenStuck.toFixed(2) + "m/s").padStart(12),
    (Math.round(r.haltFrac * 100) + "%").padStart(7)
  );
}
const n = rows.length || 1;
const mean = (f: (r: any) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
const withStuck = rows.filter((r) => r.stuckSampleN > 0);
const meanS = (f: (r: any) => number) => (withStuck.length ? withStuck.reduce((s, r) => s + f(r), 0) / withStuck.length : 0);
console.log("\n# AGGREGATE across", rows.length, "seeds (MODE=" + MODE + ")   [march phase only, past the wire]");
console.log("  mean blocked-sec by cause  wall / struct / terr :",
  mean((r) => r.cause.wall).toFixed(1), "/", mean((r) => r.cause.struct).toFixed(1), "/", mean((r) => r.cause.terr).toFixed(1));
console.log("  mean peak point-man-forward (m)   :", mean((r) => r.peakForward).toFixed(1));
console.log("  mean AVG point-man-forward (m)     :", mean((r) => r.meanForward).toFixed(1), " <- the 'often far forward' metric");
console.log("  mean % march time >30m forward    :", Math.round(mean((r) => r.farFwdFrac) * 100) + "%");
console.log("  mean peak file stretch (m)        :", mean((r) => r.peakStretch).toFixed(1));
console.log("  mean nav SPEED while a man wedged  :", meanS((r) => r.navSpeedWhenStuck).toFixed(2), "m/s  (lower = point man waits)");
console.log("  mean halt% while a man wedged      :", Math.round(meanS((r) => r.haltFrac) * 100) + "%  (point man fully stopped)");
console.log("  seeds peakForward > 40m           :", rows.filter((r) => r.peakForward > 40).length, "/", rows.length);
