import { Terrain } from "./terrain";
import { Unit } from "./entities";
import { Vec2, norm, len, dot, scale, add, sub, fromAngle, rotate } from "./vec";

/**
 * Local steering — the "steer locally" half of "navigate globally, steer locally".
 *
 * A unit's PATH (from A*) is the global plan: the sequence of waypoints that get
 * it across the valley and around the big stuff (cliffs, the COP ring). But a path
 * is a thin polyline; followed naively a unit will scrape along a wall it's routed
 * beside, walk straight into a teammate, or pile up at a choke. This module turns
 * the raw "head at my next waypoint" intent into a heading that a real body would
 * actually take: it rounds obstacles instead of grinding them, and it keeps its
 * spacing from other bodies instead of interpenetrating.
 *
 * Two behaviors, blended:
 *   1. SEPARATION — a short-range push away from nearby bodies, so men don't stack
 *      up. In open ground it does nothing (everyone's already spread); in a choke
 *      it is exactly what makes a wedge collapse into a clean single file.
 *   2. OBSTACLE AVOIDANCE — context/fan steering. We fan candidate headings around
 *      the goal direction, ray-probe each for how far it stays on passable ground,
 *      and choose the clearest heading that still points roughly at the goal. This
 *      *curves around* convex obstacles (the round HESCO wall) the way a person
 *      does, and — unlike a repulsion field — never stalls when approached head-on.
 *
 * The whole thing is a no-op in the common case: if the path ahead is clear and no
 * one is crowding, it returns the goal direction unchanged (so it costs almost
 * nothing and does not perturb open-ground or combat movement). It only does work
 * — and only bends the heading — where the ground or the crowd demands it.
 */

export interface SteerResult {
  dir: Vec2; // unit heading to actually walk this tick
  steered: boolean; // true if avoidance/separation changed the raw goal heading
}

// Tunables. Kept conservative so steering corrects, never fights, navigation.
const BODY = 0.55; // half a man's footprint (m); used as the floor on separation distance
const SEP_RADIUS = 2.4; // start easing apart inside this gap (m)
const SEP_STRENGTH = 1.1; // how hard separation pushes vs. the goal heading
const PROBE = 7; // obstacle look-ahead distance (m) — local, the path does the long haul
const PROBE_STEP = 1; // ray-march resolution (m): fine enough to catch a 2-cell HESCO wall
// Fan of candidate headings (radians), widening out from straight-ahead. Symmetric
// pairs let a unit peel off to whichever side is clearer.
const FAN = [0, 0.21, -0.21, 0.42, -0.42, 0.65, -0.65, 0.9, -0.9, 1.2, -1.2, 1.6, -1.6];

/** How far (m, capped at PROBE) the ground stays passable from `p` along `dir`. */
function clearAhead(terrain: Terrain, p: Vec2, dir: Vec2, probe: number): number {
  const cs = terrain.cellSize;
  for (let s = PROBE_STEP; s <= probe; s += PROBE_STEP) {
    const x = p.x + dir.x * s;
    const y = p.y + dir.y * s;
    if (!terrain.passableCell(Math.floor(x / cs), Math.floor(y / cs))) return s - PROBE_STEP;
  }
  return probe;
}

/**
 * Resolve the heading a unit should actually take this tick.
 *
 * @param goalDir   normalized direction toward the current waypoint (the raw intent)
 * @param neighbors nearby bodies to keep clear of (already filtered to a small radius)
 * @param speed     intended speed (m/s) — scales the look-ahead so faster movers look further
 */
export function steer(
  terrain: Terrain,
  u: Unit,
  goalDir: Vec2,
  neighbors: Unit[],
  speed: number
): SteerResult {
  if (len(goalDir) < 1e-6) return { dir: goalDir, steered: false };

  // 1) Separation: sum of away-pushes from crowding neighbors, stronger the closer.
  let sx = 0;
  let sy = 0;
  let crowd = 0;
  for (const n of neighbors) {
    const dx = u.pos.x - n.pos.x;
    const dy = u.pos.y - n.pos.y;
    const d = Math.hypot(dx, dy);
    if (d >= SEP_RADIUS) continue;
    crowd++;
    const inv = 1 / Math.max(BODY, d);
    const w = (SEP_RADIUS - d) / SEP_RADIUS; // 0 at the rim, →1 as they touch
    sx += (dx * inv) * w;
    sy += (dy * inv) * w;
  }

  // Intent = goal heading nudged by separation. The avoidance fan then runs on this
  // combined intent, so a man squeezed sideways by his buddies still won't be pushed
  // into a wall — the fan guarantees the final heading is on clear ground.
  let intent = goalDir;
  if (crowd > 0) {
    const sep = norm({ x: sx, y: sy });
    intent = norm(add(goalDir, scale(sep, SEP_STRENGTH)));
    if (len(intent) < 1e-6) intent = goalDir;
  }

  // 2) Obstacle avoidance. Fast path: if the intent is clear for the full probe and
  // nobody's crowding, take it as-is (open ground / combat are untouched).
  const probe = Math.min(PROBE, Math.max(3, speed * 1.3 + 3));
  const straight = clearAhead(terrain, u.pos, intent, probe);
  if (straight >= probe - 1e-3 && crowd === 0) return { dir: goalDir, steered: false };

  // Otherwise score the fan: prefer headings that stay clear longest and still aim
  // at the goal, with a mild penalty for big turns (so we don't dither).
  let best = intent;
  let bestScore = -Infinity;
  for (const off of FAN) {
    const cand = off === 0 ? intent : rotate(intent, off);
    const clear = clearAhead(terrain, u.pos, cand, probe);
    const align = dot(cand, goalDir); // [-1,1] — keep pointing at the objective
    const score = (clear / probe) * 1.6 + align * 0.7 - Math.abs(off) * 0.12;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return { dir: best, steered: true };
}
