import { clamp, clamp01 } from "../rng";
import { Vec2, add, sub, norm, fromAngle, angle, dist } from "../vec";
import { makeInsurgent, Unit } from "../entities";
import { lineOfSight } from "../los";
import type { World } from "./world";
import { MAX_ACTIVE_ENEMY, DAY } from "./types";
import { clampMap, enemyRoleFor } from "./helpers";

/**
 * The enemy activity director. It owns the valley's tempo: heat drifts with how
 * the population leans and how the fight is going, and on a clock that quickens
 * at night and as heat climbs it stages ambushes, infiltrations, harassment and
 * the occasional complex attack — all routed through the terrain.
 */
export function runDirector(w: World, dt: number) {
  // enemy heat drifts with hostility & stability
  const hostility = w.state.villages.reduce((a, v) => a + (v.attitude < 0 ? 1 : 0), 0) / Math.max(1, w.state.villages.length);
  const target = clamp01(0.22 + hostility * 0.4 + (1 - w.state.metrics.stability / 100) * 0.4);
  w.state.enemyHeat = clamp01(w.state.enemyHeat + (target - w.state.enemyHeat) * (0.4 / DAY) * dt + w.rng.gauss(0, 0.0006));

  if (w.state.clock < w.state.nextActivityAt) return;
  const night = w.isNight();
  let base = (w.rng.range(14, 30) * 60) / (0.45 + w.state.enemyHeat);
  if (night) base *= 0.6;
  w.state.nextActivityAt = w.state.clock + base;

  if (w.sim.livingEnemies().length >= MAX_ACTIVE_ENEMY) return;
  if (w.state.enemyStrengthAbs <= 1) return;

  const r = w.rng.next();
  if (r < 0.42) spawnAmbushOnPatrol(w);
  else if (r < 0.7) spawnInfiltration(w);
  else if (r < 0.88 || !night) spawnHarass(w);
  else spawnComplexAttack(w);

  // A hot valley also drops indirect from defilade — the tube teams that made the
  // real fight. Overlays the other activity (mortars + small arms = the complex
  // attack), gated on heat/strength so it isn't constant.
  if (w.state.enemyHeat > 0.55 && w.state.enemyStrengthAbs > 8 && w.rng.chance(0.13)) spawnIndirectHarass(w);
}

/**
 * An 82mm tube (or DShK in the plunging-fire role) harasses the COP or a pinned
 * patrol from a reverse slope you can't see. Inaccurate (large CEP), a handful of
 * rounds, telegraphed by ICOM so an alert player takes cover and the gun crews get
 * their heads down. Activates the engine's enemy-indirect pipeline (previously
 * fully built but never called).
 */
function spawnIndirectHarass(w: World) {
  const patrol = w.activePatrolCentroid();
  // walk fire onto a patrol that's actually fixed/in contact; otherwise the base.
  const onPatrol = patrol && w.inContact();
  const target = onPatrol ? patrol! : w.copWorld();
  const rounds = w.rng.int(2, 2 + Math.round(w.state.enemyHeat * 2));
  const eta = w.rng.range(22, 46); // spotting, lay, fire
  w.sim.enemyFireMission("mortar82", target, rounds, eta);
  if (w.rng.chance(0.7))
    w.addIntel({ source: "SIGINT", text: `ICOM: "...ready the tube... walk it onto ${onPatrol ? "the patrol" : "the base"}..."`, reliability: 0.55 });
  w.log("ICOM chatter about a tube — possible incoming indirect.", "radio");
  w.interrupt("possible enemy indirect");
}

/** Lay an ambush astride a patrolling element (or near a hostile village). */
function spawnAmbushOnPatrol(w: World) {
  const patrol = w.activePatrolCentroid();
  const focus = patrol ?? w.hostileVillageWorld() ?? randomFloorPoint(w);
  const count = drawEnemy(w, w.rng.int(3, 6));
  if (count === 0) return;
  const dir = patrol ? norm(sub(w.copWorld(), focus)) : { x: 0, y: -1 };
  const positions = firingPositions(w, focus, dir, count, 90, 360);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count);
    e.brainState = "ambush";
    e.brainTimer = w.rng.range(2, 8);
    e.rof = "hold";
    e.stance = "prone";
  });
}

/** Fighters move through the draws toward a village to cache / intimidate. */
function spawnInfiltration(w: World) {
  const v = w.rng.pick(w.state.villages);
  const targetPt = w.terrain.cellCenter(v.cx, v.cy);
  const staging = drawStaging(w, targetPt);
  const count = drawEnemy(w, w.rng.int(2, 5));
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const pos = add(staging, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(0, 30)));
    const e = spawnFighter(w, clampMap(w.terrain, pos), i, count);
    e.brainState = "patrolling";
    e.rof = "free";
    e.technique = "concealed";
    w.sim.pathTo(e, add(targetPt, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(20, 60))), { concealBias: 0.7 });
  }
  if (w.rng.chance(0.5))
    w.addIntel({ source: "SIGINT", text: `ICOM: fighters moving toward ${v.name} tonight.`, reliability: 0.55, cx: v.cx, cy: v.cy });
}

/** A couple of fighters harass the COP or a patrol from distance. */
function spawnHarass(w: World) {
  const patrol = w.activePatrolCentroid();
  const focus = patrol ?? w.copWorld();
  const count = drawEnemy(w, w.rng.int(2, 3));
  if (count === 0) return;
  const positions = firingPositions(w, focus, { x: 0, y: -1 }, count, 300, 620);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count);
    e.brainState = "engage";
    e.brainTimer = w.rng.range(6, 14);
    e.rof = "free";
  });
}

/** A larger element presses the COP — the bad nights. */
function spawnComplexAttack(w: World) {
  const cop = w.copWorld();
  const count = drawEnemy(w, w.rng.int(8, 16));
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const a = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(260, 560);
    const pos = clampMap(w.terrain, add(cop, fromAngle(a, r)));
    const e = spawnFighter(w, pos, i, count);
    e.brainState = "engage";
    e.rof = "free";
    e.facing = angle(sub(cop, pos));
  }
  w.log("STAND TO — the COP is taking fire from the ridgelines!", "contact");
  w.interrupt("COMPLEX ATTACK on the COP");
}

/** Ambush a resupply convoy on the valley road. */
export function spawnRoadAmbush(w: World) {
  const roadY = w.rng.int(w.terrain.size * 0.3, w.terrain.size * 0.7);
  const focus = w.terrain.cellCenter(Math.round(w.terrain.size / 2), roadY);
  const count = drawEnemy(w, w.rng.int(3, 6));
  const positions = firingPositions(w, focus, { x: 1, y: 0 }, count, 80, 260);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count);
    e.brainState = "engage";
    e.rof = "free";
  });
}

function spawnFighter(w: World, pos: Vec2, i: number, total: number): Unit {
  const role = enemyRoleFor(i, total, w.rng);
  const e = makeInsurgent(
    w.rng.fork(`enemy-${(w.state.clock | 0)}-${i}-${w.sim.units.length}`),
    role,
    clampMap(w.terrain, pos),
    Math.min(1, w.state.enemyHeat + 0.1)
  );
  // Fighters spawned together are a cell (shared squadId): they feel each other's
  // losses (casualty shock) and a fallen commander's cell promotes a new leader —
  // the enemy-side of #3, previously inert because insurgents had no squadId.
  e.squadId = `acm-${w.state.clock | 0}`;
  w.sim.addUnit(e);
  return e;
}

/** Number of fighters we can field right now without exceeding the active cap. */
function drawEnemy(w: World, n: number): number {
  const room = MAX_ACTIVE_ENEMY - w.sim.livingEnemies().length;
  return clamp(Math.min(n, room, Math.ceil(w.state.enemyStrengthAbs)), 0, n);
}

function firingPositions(w: World, focus: Vec2, dir: Vec2, count: number, minR: number, maxR: number): Vec2[] {
  const t = w.terrain;
  const out: Vec2[] = [];
  const cands: { p: Vec2; s: number }[] = [];
  for (let tries = 0; tries < 500 && cands.length < count * 8; tries++) {
    const a = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(minR, maxR);
    const p = add(focus, fromAngle(a, r));
    if (p.x < 20 || p.y < 20 || p.x > t.worldSize - 20 || p.y > t.worldSize - 20) continue;
    if (!t.passableCell(Math.floor(p.x / t.cellSize), Math.floor(p.y / t.cellSize))) continue;
    const los = lineOfSight(t, p, focus, { observerHeight: 1.2, targetHeight: 1.7 });
    if (!los.visible) continue;
    const conceal = t.concealAt(p.x, p.y);
    const cover = t.coverAt(p.x, p.y);
    const elevAdv = t.elevAt(p.x, p.y) - t.elevAt(focus.x, focus.y);
    const toP = norm(sub(p, focus));
    const align = toP.x * dir.x + toP.y * dir.y;
    cands.push({ p, s: elevAdv * 0.02 + conceal * 3 + cover * 2 + los.exposure * 2 + align * 0.6 + w.rng.range(0, 1) });
  }
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    if (out.length >= count) break;
    if (out.some((q) => dist(q, c.p) < 14)) continue;
    out.push(c.p);
  }
  while (out.length < count) out.push(clampMap(t, add(focus, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(minR, maxR)))));
  return out;
}

/** Staging point at the mouth of the nearest draw toward `target`. */
function drawStaging(w: World, target: Vec2): Vec2 {
  const t = w.terrain;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const d of t.drawChannels) {
    const cx = t.size / 2 + d.side * t.size * 0.4;
    const p = t.cellCenter(Math.round(clamp(cx, 4, t.size - 4)), Math.round(clamp(d.y, 4, t.size - 4)));
    const dd = dist(p, target);
    if (dd < bestD) {
      bestD = dd;
      best = p;
    }
  }
  return best ?? edgePoint(w);
}

function edgePoint(w: World): Vec2 {
  const m = w.terrain.worldSize;
  const side = w.rng.int(0, 3);
  if (side === 0) return { x: w.rng.range(10, m - 10), y: 10 };
  if (side === 1) return { x: w.rng.range(10, m - 10), y: m - 10 };
  if (side === 2) return { x: 10, y: w.rng.range(10, m - 10) };
  return { x: m - 10, y: w.rng.range(10, m - 10) };
}

function randomFloorPoint(w: World): Vec2 {
  const y = w.rng.int(w.terrain.size * 0.2, w.terrain.size * 0.8);
  return w.terrain.cellCenter(Math.round(w.terrain.centerXAt(y)), y);
}
