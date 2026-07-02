/**
 * route-smoothness — Phase 1 confirm/refute probe for front B ("paths too squiggly").
 *
 * The complaint has two candidate layers; this probe measures BOTH so the verdict can say
 * which one a viewer is actually seeing:
 *
 * PART 1 — PLANNED route shape (same plumbing as scripts/route-quality.ts: gateOutside ->
 * every village via findPath, roadBias 0.25). On the string-pulled polyline:
 *   - turn/100m : total |heading change| (deg) per 100 m of route. A geodesic contour route
 *                 is ~20-60; a stair-stepped grid path is hundreds.
 *   - >15/>30/>60 per km : direction-change counts by size. The existing `rev` metric only
 *                 sees >120 deg — this is the small-angle zig-zag it is blind to.
 *   - segM      : mean waypoint segment length (short segments = grid texture survived
 *                 string-pulling).
 *   - ratio     : route length / crow (route-quality's number, for context).
 * TERRAIN RESPONSE (the beeline question): step the polyline at 5 m; at each step classify
 * the heading vs the local elevation gradient: CONTOUR (within 30 deg of perpendicular to
 * the gradient), FALL (within 30 deg of the fall line), MIXED. Bucketed by local slope
 * (mod 0.15-0.3, steep 0.3-0.6, vsteep >0.6). Real trails contour on steep ground (USFS
 * half-rule; ~10% avg grade oracle — see CONTEXT.md). The same classification run on the
 * straight start->goal BEELINE is the null baseline: if route contour% ~= beeline contour%
 * on steep ground, the planner is not contouring at all. Random-heading null is 33%/33%.
 *
 * PART 2 — EXECUTED track texture (same plumbing as scripts/squad-arrival.ts: combat-free
 * patrol, enemyStrengthAbs=0, dt=0.2, nearest reachable village, sq1). Samples every man's
 * position every 2 s while (phase==="moving" && exited), then:
 *   - navT/100m, folT/100m : turn density of the NAVIGATOR's track vs the FOLLOWERS' mean.
 *                 The nav has NO meander (he walks the raw route), followers add the
 *                 per-man weave (formation.ts driveFollower) — the delta isolates it.
 *   - weaveRMS  : per-man lateral deviation RMS from the navigator's spatial track (per-man
 *                 mean removed, so a constant offset doesn't count). This is the meander
 *                 amplitude as actually walked (sin amp 0.3-0.8 m -> expect ~0.2-0.6 m).
 *   - cenRMS    : same, vs the squad-centroid spatial line (the mission's stated reference).
 * A/B: ITM_NOMEANDER=1 zeroes the meander amplitude (env-gated, read once at module level in
 * lib/sim/world/formation.ts; default byte-identical). Diff HEAD vs nomeander on Part 2.
 *
 * Run: npx tsx scripts/route-smoothness.ts [seeds...]
 *      ITM_PART=plan|exec npx tsx scripts/route-smoothness.ts   (subset the parts)
 *      ITM_NOMEANDER=1 ITM_PART=exec npx tsx scripts/route-smoothness.ts  (the A/B)
 */
import { createWorld } from "../lib/sim/world";
import { findPath } from "../lib/sim/path";
import { Vec2 } from "../lib/sim/vec";

const SEEDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["smoke-test", "korengal", "survey-2", "survey-7", "survey-9", "valley-3", "ridge-11", "alpha-1", "bravo-2", "delta-4"];
const PART = process.env.ITM_PART ?? "both"; // plan | exec | both

// ---------------------------------------------------------------------------- shared math

const deg = (r: number) => (r * 180) / Math.PI;

/** Turn-density metrics on a polyline (pts includes the start). minStep filters
 *  degenerate/paused samples so executed tracks don't count standing wobble as turns. */
function turnMetrics(pts: Vec2[], minStep = 0.001) {
  let len = 0;
  let turnSum = 0; // deg
  let n15 = 0, n30 = 0, n60 = 0;
  let segs = 0;
  let prevH: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const d = Math.hypot(dx, dy);
    if (d < minStep) continue;
    len += d;
    segs++;
    const h = Math.atan2(dy, dx);
    if (prevH !== null) {
      let dh = Math.abs(h - prevH);
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      const a = deg(dh);
      turnSum += a;
      if (a > 15) n15++;
      if (a > 30) n30++;
      if (a > 60) n60++;
    }
    prevH = h;
  }
  const km = Math.max(1e-6, len / 1000);
  return {
    len,
    turnPer100: turnSum / Math.max(1e-6, len / 100),
    n15km: n15 / km,
    n30km: n30 / km,
    n60km: n60 / km,
    meanSeg: segs ? len / segs : 0,
  };
}

// slope buckets for the terrain-response metric (tan slope)
const BUCKETS = [
  { name: "flat<.15", lo: 0, hi: 0.15 },
  { name: "mod.15-.3", lo: 0.15, hi: 0.3 },
  { name: "stp.3-.6", lo: 0.3, hi: 0.6 },
  { name: "vst>.6", lo: 0.6, hi: Infinity },
];
interface BucketAcc { len: number; contour: number; fall: number; }
const newAcc = (): BucketAcc[] => BUCKETS.map(() => ({ len: 0, contour: 0, fall: 0 }));

/** Walk a polyline in ~5 m steps; classify each step's heading vs the local elevation
 *  gradient into contour / fall-line / mixed, accumulated per slope bucket (by length). */
function terrainResponse(t: any, pts: Vec2[], acc: BucketAcc[]) {
  const STEP = 5;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 0.5) continue;
    const ux = (b.x - a.x) / segLen, uy = (b.y - a.y) / segLen;
    const nStep = Math.max(1, Math.round(segLen / STEP));
    const ds = segLen / nStep;
    for (let s = 0; s < nStep; s++) {
      const mx = a.x + ux * ds * (s + 0.5), my = a.y + uy * ds * (s + 0.5);
      const h = 5;
      const gx = (t.elevAt(mx + h, my) - t.elevAt(mx - h, my)) / (2 * h);
      const gy = (t.elevAt(mx, my + h) - t.elevAt(mx, my - h)) / (2 * h);
      const g = Math.hypot(gx, gy); // tan slope
      let bi = 0;
      for (let k = 0; k < BUCKETS.length; k++) if (g >= BUCKETS[k].lo && g < BUCKETS[k].hi) bi = k;
      acc[bi].len += ds;
      if (g < 0.03) continue; // gradient direction undefined on truly flat ground
      const ang = deg(Math.acos(Math.min(1, Math.abs(ux * (gx / g) + uy * (gy / g))))); // 0=fall-line, 90=contour
      if (ang >= 60) acc[bi].contour += ds;
      else if (ang <= 30) acc[bi].fall += ds;
    }
  }
}

// ---------------------------------------------------------------------------- part 1: planned

interface PlanRow {
  seed: string; objs: number; ratio: number; turn100: number;
  n15: number; n30: number; n60: number; segM: number;
}

function runPlanned() {
  console.log("== PART 1: PLANNED route shape (findPath gateOutside->village, roadBias 0.25) ==");
  console.log(
    "seed".padEnd(12), "objs".padStart(5), "ratio".padStart(6), "turn/100m".padStart(10),
    ">15/km".padStart(7), ">30/km".padStart(7), ">60/km".padStart(7), "segM".padStart(6)
  );
  const rows: PlanRow[] = [];
  const routeAcc = newAcc();
  const beeAcc = newAcc();
  for (const seed of SEEDS) {
    let w: any;
    try { w = createWorld(seed, 60); } catch { continue; }
    const t = w.terrain;
    const gateOut = w.gateOutsideWorld();
    let objs = 0;
    const agg = { ratio: 0, turn100: 0, n15: 0, n30: 0, n60: 0, segM: 0 };
    for (const v of t.villages) {
      const c = t.nearestPassable(v.cx, v.cy);
      const goal = t.cellCenter(c.cx, c.cy);
      const crow = Math.hypot(goal.x - gateOut.x, goal.y - gateOut.y);
      if (crow < 60) continue; // skip trivially-close (route-quality convention)
      const route = findPath(t, gateOut, goal, { roadBias: 0.25 });
      const pts = [gateOut, ...route];
      const m = turnMetrics(pts);
      objs++;
      agg.ratio += m.len / Math.max(1, crow);
      agg.turn100 += m.turnPer100;
      agg.n15 += m.n15km; agg.n30 += m.n30km; agg.n60 += m.n60km;
      agg.segM += m.meanSeg;
      terrainResponse(t, pts, routeAcc);
      terrainResponse(t, [gateOut, goal], beeAcc); // beeline null baseline
    }
    if (!objs) continue;
    const r: PlanRow = {
      seed, objs, ratio: agg.ratio / objs, turn100: agg.turn100 / objs,
      n15: agg.n15 / objs, n30: agg.n30 / objs, n60: agg.n60 / objs, segM: agg.segM / objs,
    };
    rows.push(r);
    console.log(
      seed.padEnd(12), String(objs).padStart(5), r.ratio.toFixed(2).padStart(6),
      r.turn100.toFixed(1).padStart(10), r.n15.toFixed(1).padStart(7),
      r.n30.toFixed(1).padStart(7), r.n60.toFixed(1).padStart(7), r.segM.toFixed(1).padStart(6)
    );
  }
  const m = (f: (r: PlanRow) => number) => rows.reduce((a, r) => a + f(r) * r.objs, 0) / Math.max(1, rows.reduce((a, r) => a + r.objs, 0));
  console.log("-".repeat(66));
  console.log(
    "ALL".padEnd(12), String(rows.reduce((a, r) => a + r.objs, 0)).padStart(5), m((r) => r.ratio).toFixed(2).padStart(6),
    m((r) => r.turn100).toFixed(1).padStart(10), m((r) => r.n15).toFixed(1).padStart(7),
    m((r) => r.n30).toFixed(1).padStart(7), m((r) => r.n60).toFixed(1).padStart(7), m((r) => r.segM).toFixed(1).padStart(6)
  );

  console.log("");
  console.log("TERRAIN RESPONSE (ALL seeds, by-length; contour = heading within 30deg of the");
  console.log("contour line, fall = within 30deg of the fall line; random-heading null = 33%/33%)");
  console.log(
    "slope".padEnd(11), "share%".padStart(7), "cont%".padStart(6), "fall%".padStart(6),
    "| beeline:".padStart(11), "cont%".padStart(6), "fall%".padStart(6)
  );
  const tot = routeAcc.reduce((a, b) => a + b.len, 0);
  const btot = beeAcc.reduce((a, b) => a + b.len, 0);
  for (let k = 0; k < BUCKETS.length; k++) {
    const r = routeAcc[k], b = beeAcc[k];
    console.log(
      BUCKETS[k].name.padEnd(11),
      ((r.len / Math.max(1, tot)) * 100).toFixed(1).padStart(6) + "%",
      ((r.contour / Math.max(1, r.len)) * 100).toFixed(0).padStart(5) + "%",
      ((r.fall / Math.max(1, r.len)) * 100).toFixed(0).padStart(5) + "%",
      "|".padStart(8),
      "(" + ((b.len / Math.max(1, btot)) * 100).toFixed(0) + "%)",
      ((b.contour / Math.max(1, b.len)) * 100).toFixed(0).padStart(5) + "%",
      ((b.fall / Math.max(1, b.len)) * 100).toFixed(0).padStart(5) + "%"
    );
  }
}

// ---------------------------------------------------------------------------- part 2: executed

/** Signed perpendicular distance from p to the nearest point of polyline `line`.
 *  Returns null when p projects onto the clamped ends (off the line's span). */
function lateralTo(line: Vec2[], p: Vec2): number | null {
  let best = Infinity, bestSigned: number | null = null, bestIdx = -1, bestT = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    let tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    tt = Math.max(0, Math.min(1, tt));
    const qx = a.x + dx * tt, qy = a.y + dy * tt;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best) {
      best = d;
      const L = Math.sqrt(L2);
      bestSigned = ((p.x - a.x) * (-dy) + (p.y - a.y) * dx) / L; // + = left of travel
      bestIdx = i; bestT = tt;
    }
  }
  if (bestSigned === null) return null;
  // discard samples that fall off the ends of the reference line
  if ((bestIdx === 1 && bestT === 0) || (bestIdx === line.length - 1 && bestT === 1)) return null;
  return bestSigned;
}

/** RMS of per-man lateral deviation from a reference spatial line, per-man mean removed. */
function weaveRMS(tracks: Map<string, Vec2[]>, ref: Vec2[], skipId: string | null): number {
  const sq: number[] = [];
  for (const [id, tr] of tracks) {
    if (id === skipId) continue;
    const lats: number[] = [];
    for (const p of tr) {
      const l = lateralTo(ref, p);
      if (l !== null && Math.abs(l) < 25) lats.push(l); // >25 m = off-wake rejoin, not weave
    }
    if (lats.length < 20) continue;
    const mean = lats.reduce((a, b) => a + b, 0) / lats.length;
    for (const l of lats) sq.push((l - mean) ** 2);
  }
  return sq.length ? Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length) : 0;
}

interface ExecRow {
  seed: string; navLen: number; navT100: number; folT100: number;
  nav30: number; fol30: number; weave: number; cen: number; men: number;
}

function runExecuted() {
  console.log("");
  console.log(`== PART 2: EXECUTED track texture (combat-free patrol, dt=0.2, 2 s samples${process.env.ITM_NOMEANDER ? ", ITM_NOMEANDER=1" : ""}) ==`);
  console.log(
    "seed".padEnd(12), "navLen".padStart(7), "navT/100".padStart(9), "folT/100".padStart(9),
    "nav>30/km".padStart(10), "fol>30/km".padStart(10), "weaveRMS".padStart(9), "cenRMS".padStart(7), "men".padStart(4)
  );
  const DT = 0.2;
  const CAP = 1500; // s
  const rows: ExecRow[] = [];
  for (const seed of SEEDS) {
    let w: any;
    try { w = createWorld(seed, 90); } catch { continue; }
    w.state.enemyStrengthAbs = 0; // no spawns — movement only (squad-arrival convention)
    const t = w.terrain;
    const g0 = t.cop.gateOutside;
    const reach = t.reachableFromGate();
    const villages = t.villages
      .slice()
      .filter((v: any) => reach[t.idx(v.cx, v.cy)] || reach[t.idx(t.nearestPassable(v.cx, v.cy).cx, t.nearestPassable(v.cx, v.cy).cy)])
      .sort((a: any, b: any) => Math.hypot(a.cx - g0.cx, a.cy - g0.cy) - Math.hypot(b.cx - g0.cx, b.cy - g0.cy));
    const v = villages[0];
    if (!v) continue;
    const sq = w.platoon.squads.find((s: any) => s.id === "sq1");
    const ids: string[] = sq.memberIds.slice();
    const task = w.formPatrol(ids, [{ cx: v.cx, cy: v.cy }], "presence", "patrol");
    if (!task) continue;

    const tracks = new Map<string, Vec2[]>();
    for (const id of ids) tracks.set(id, []);
    const centroidTrack: Vec2[] = [];
    const SAMPLE_EVERY = Math.round(2 / DT); // every 2 s
    for (let k = 0; k < CAP / DT; k++) {
      w.tick(DT);
      if (task.phase === "onstation" || task.phase === "returning" || task.phase === "complete") break;
      if (k % SAMPLE_EVERY !== 0) continue;
      if (!(task.phase === "moving" && task.exited)) continue;
      const members = ids.map((id) => w.sim.unit(id)).filter((u: any) => u && u.alive);
      if (!members.length) break;
      let cx = 0, cy = 0;
      for (const u of members) { cx += u.pos.x; cy += u.pos.y; tracks.get(u.id)!.push({ x: u.pos.x, y: u.pos.y }); }
      centroidTrack.push({ x: cx / members.length, y: cy / members.length });
    }

    const navId = task.leadId as string;
    const navTr = tracks.get(navId) ?? [];
    if (navTr.length < 30) { console.log(seed.padEnd(12), "  (too few moving samples — skipped)"); continue; }
    const navM = turnMetrics(navTr, 0.5);
    let folT = 0, fol30 = 0, folN = 0;
    for (const [id, tr] of tracks) {
      if (id === navId || tr.length < 30) continue;
      const m = turnMetrics(tr, 0.5);
      folT += m.turnPer100; fol30 += m.n30km; folN++;
    }
    const weave = weaveRMS(tracks, navTr, navId);
    const cen = weaveRMS(tracks, centroidTrack, null);
    const r: ExecRow = {
      seed, navLen: navM.len, navT100: navM.turnPer100, folT100: folN ? folT / folN : 0,
      nav30: navM.n30km, fol30: folN ? fol30 / folN : 0, weave, cen, men: folN + 1,
    };
    rows.push(r);
    console.log(
      seed.padEnd(12), (Math.round(r.navLen) + "m").padStart(7), r.navT100.toFixed(1).padStart(9),
      r.folT100.toFixed(1).padStart(9), r.nav30.toFixed(1).padStart(10), r.fol30.toFixed(1).padStart(10),
      r.weave.toFixed(2).padStart(9), r.cen.toFixed(2).padStart(7), String(r.men).padStart(4)
    );
  }
  const m = (f: (r: ExecRow) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
  console.log("-".repeat(84));
  console.log(
    "MEAN".padEnd(12), "".padStart(7), m((r) => r.navT100).toFixed(1).padStart(9),
    m((r) => r.folT100).toFixed(1).padStart(9), m((r) => r.nav30).toFixed(1).padStart(10),
    m((r) => r.fol30).toFixed(1).padStart(10), m((r) => r.weave).toFixed(2).padStart(9),
    m((r) => r.cen).toFixed(2).padStart(7), ""
  );
}

if (PART === "plan" || PART === "both") runPlanned();
if (PART === "exec" || PART === "both") runExecuted();
