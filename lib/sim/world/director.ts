import { clamp, clamp01 } from "../rng";
import { Vec2, add, sub, norm, scale, len, fromAngle, angle, dist } from "../vec";
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
  if (r < 0.42) {
    // Against a patrol in a hotter valley, the ambush is often IED-initiated.
    if (w.state.enemyHeat > 0.45 && w.activePatrolCentroid() && w.rng.chance(0.5)) spawnIedAmbush(w);
    else spawnAmbushOnPatrol(w);
  } else if (r < 0.7) spawnInfiltration(w);
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

/**
 * An IED-initiated complex ambush — the signature valley opener. A charge is buried
 * ahead of the patrol on its outbound axis; an L-shaped cell lies in wait, weapons
 * tight, until the blast initiates and the whole element opens up at once. Activates
 * the dead `ied_team` role (the triggerman) and the engine's IED system.
 */
function spawnIedAmbush(w: World) {
  const patrol = w.activePatrolCentroid();
  if (!patrol) return;
  const cop = w.copWorld();
  let dir = norm(sub(patrol, cop)); // the patrol is generally outbound from the wire
  if (len(dir) < 0.1) dir = { x: 0, y: -1 };
  // kill point a short bound ahead of the patrol, snapped to passable ground
  let kill = clampMap(w.terrain, add(patrol, scale(dir, w.rng.range(40, 85))));
  const kc = w.terrain.nearestPassable(Math.floor(kill.x / w.terrain.cellSize), Math.floor(kill.y / w.terrain.cellSize));
  kill = w.terrain.cellCenter(kc.cx, kc.cy);
  const count = drawEnemy(w, w.rng.int(3, 6));
  if (count === 0) return;
  const cellId = `acm-ied-${w.state.clock | 0}`;
  // Concealed firing positions around the kill zone (the L), weapons tight.
  const positions = firingPositions(w, kill, scale(dir, -1), count, 30, 120);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count);
    e.squadId = cellId;
    e.brainState = "ambush";
    e.rof = "hold";
    e.stance = "prone";
    e.iedInit = true; // hold fire until the charge initiates
    e.brainTimer = w.rng.range(4, 14);
    if (i === 0) e.role = "ied_team"; // the triggerman who set and watches the charge
  });
  w.sim.plantIED(kill, cellId);
  if (w.rng.chance(0.45)) {
    w.addIntel({
      source: "SIGINT",
      text: `ICOM: "...it is ready on the road... wait until they reach it..."`,
      reliability: 0.5,
      cx: Math.round(kill.x / w.terrain.cellSize),
      cy: Math.round(kill.y / w.terrain.cellSize),
    });
  }
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
    // Snap the approach point to ground actually reachable from the network (a real crossing), so an
    // infiltrator whose village sits across the now-impassable river routes to a ford instead of
    // wading toward it and stranding at the water (issue 010 — the enemy analogue of the squad snap).
    const aim = w.terrain.reachablePoint(targetPt.x + w.rng.range(-60, 60), targetPt.y + w.rng.range(-60, 60));
    w.sim.pathTo(e, aim, { concealBias: 0.7, cheapFallback: true });
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
