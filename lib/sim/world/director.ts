import { clamp, clamp01 } from "../rng";
import { Vec2, add, sub, norm, scale, len, fromAngle, angle, dist } from "../vec";
import { makeInsurgent, Unit } from "../entities";
import { lineOfSight } from "../los";
import type { World } from "./world";
import { MAX_ACTIVE_ENEMY, DAY, EnemyCell } from "./types";
import { clampMap, enemyRoleFor } from "./helpers";
import { pickCellForActivity, nearestLivingCache, heatAt } from "./network";

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
  // The US owns the night (NODs); the enemy lacked them, so deep-night DIRECT-FIRE activity is
  // SPARSE and the enemy favors the dawn/dusk stand-to windows and daylight harassment. The old
  // `if (night) base *= 0.6` had it inverted (smaller base = sooner = MORE frequent at night).
  // Night infiltration (caching/movement) is preserved below — it's just not gunfights.
  const hour = w.secondsOfDay / 3600;
  const deepNight = night && (hour < 4.5 || hour >= 21);
  const dawnDusk = (hour >= 4.5 && hour < 7) || (hour >= 17 && hour < 19.5);
  if (deepNight) base *= 1.8;        // far LESS frequent deep at night
  else if (dawnDusk) base *= 0.75;   // the favored stand-to windows — slightly MORE
  w.state.nextActivityAt = w.state.clock + base;

  if (w.sim.livingEnemies().length >= MAX_ACTIVE_ENEMY) return;
  if (w.state.enemyStrengthAbs <= 1) return;

  // The director now SPENDS a cell, not a scalar: which cell reacts (weighted by strength, grudge and
  // proximity to any patrol) and which activity it stages (weighted by its own aggression / IED skill).
  const cell = pickCellForActivity(w);
  if (!cell) return; // every cell broken or mid-succession — the valley stays quiet this beat
  cell.lastActivityClock = w.state.clock;

  const r = w.rng.next();
  // Personality bends the activity roll: an aggressive cell ambushes and presses more; a patient one
  // harasses and infiltrates. The bands still sum to the same behaviour space as before.
  const ambushCut = clamp(0.30 + 0.24 * cell.aggression, 0.25, 0.6);
  if (deepNight) {
    // Deep night: mostly infiltration/caching movement; the occasional probe, no complex attacks.
    if (r < 0.75) spawnInfiltration(w, cell);
    else spawnHarass(w, cell);
  } else if (r < ambushCut) {
    // Against a patrol in a hotter valley, an IED-skilled cell prefers the IED-initiated ambush —
    // but only if it has a living cache in range (spawnIedAmbush falls back to a small-arms ambush).
    if (w.state.enemyHeat > 0.45 && w.activePatrolCentroid() && w.rng.chance(0.25 + 0.5 * cell.iedSkill)) spawnIedAmbush(w, cell);
    else spawnAmbushOnPatrol(w, cell);
  } else if (r < 0.7) spawnInfiltration(w, cell);
  else if (r < 0.88 || !night) spawnHarass(w, cell);
  else spawnComplexAttack(w, cell);

  // A hot valley also drops indirect from defilade — the tube teams that made the
  // real fight. Overlays the other activity (mortars + small arms = the complex
  // attack), gated on heat/strength so it isn't constant.
  if (w.state.enemyHeat > 0.55 && w.state.enemyStrengthAbs > 8 && w.rng.chance(0.13)) spawnIndirectHarass(w, cell);
}

/**
 * An 82mm tube (or DShK in the plunging-fire role) harasses the COP or a pinned
 * patrol from a reverse slope you can't see. Inaccurate (large CEP), a handful of
 * rounds, telegraphed by ICOM so an alert player takes cover and the gun crews get
 * their heads down. Activates the engine's enemy-indirect pipeline (previously
 * fully built but never called).
 */
function spawnIndirectHarass(w: World, cell?: EnemyCell) {
  const patrol = w.activePatrolCentroid();
  // walk fire onto a patrol that's actually fixed/in contact; otherwise the base.
  const onPatrol = patrol && w.inContact();
  const target = onPatrol ? patrol! : w.copWorld();
  const rounds = w.rng.int(2, 2 + Math.round(w.state.enemyHeat * 2));
  const eta = w.rng.range(22, 46); // spotting, lay, fire
  w.sim.enemyFireMission("mortar82", target, rounds, eta);
  if (w.rng.chance(0.7)) {
    const who = cell && cell.intelLevel >= 1 ? `${cell.leaderName}'s crew` : "the crew";
    w.addIntel({ source: "SIGINT", text: `ICOM: "...${who} ready the tube... walk it onto ${onPatrol ? "the patrol" : "the base"}..."`, reliability: 0.55 });
  }
  w.log("ICOM chatter about a tube — possible incoming indirect.", "radio");
  w.interrupt("possible enemy indirect");
}

/** Lay an ambush astride a patrolling element (or near a hostile village). */
function spawnAmbushOnPatrol(w: World, cell?: EnemyCell) {
  const patrol = w.activePatrolCentroid();
  const focus = patrol ?? w.hostileVillageWorld() ?? randomFloorPoint(w);
  const count = drawEnemy(w, w.rng.int(3, 6), cell);
  if (count === 0) return;
  const embody = leaderEmbodied(w, cell, count);
  const dir = patrol ? norm(sub(w.copWorld(), focus)) : { x: 0, y: -1 };
  // 80..260 m: small-arms ambush range in a narrow valley. The old 90..360 m let the elevation
  // reweight push the cell onto distant ridges that engaged at ~320 m (too far to suppress).
  const positions = firingPositions(w, focus, dir, count, 80, 260);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count, cell, i === 0 && embody);
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
export function spawnIedAmbush(w: World, cell?: EnemyCell) {
  const patrol = w.activePatrolCentroid();
  if (!patrol) return;
  const cop = w.copWorld();
  let dir = norm(sub(patrol, cop)); // the patrol is generally outbound from the wire
  if (len(dir) < 0.1) dir = { x: 0, y: -1 };
  // An IED requires a living munitions cache within reach — no cache, no charge (the cell falls back
  // to a small-arms ambush). This is what makes seizing/blowing caches (the COIN loop) matter.
  const kill0 = clampMap(w.terrain, add(patrol, scale(dir, w.rng.range(40, 85))));
  const cache = nearestLivingCache(w, kill0, 600) ?? nearestLivingCache(w, patrol, 600);
  if (!cache) {
    spawnAmbushOnPatrol(w, cell);
    return;
  }
  // Kill point a short bound ahead of the patrol — biased to the HIGHEST patrol-heat cell among a few
  // candidates on that axis (the enemy learns where you habitually walk), snapped to passable ground.
  let kill = kill0;
  let bestHeat = -1;
  for (let k = 0; k < 5; k++) {
    const cand = clampMap(w.terrain, add(patrol, scale(dir, w.rng.range(30, 95))));
    const cc = w.terrain.nearestPassable(Math.floor(cand.x / w.terrain.cellSize), Math.floor(cand.y / w.terrain.cellSize));
    const h = heatAt(w, cc.cx, cc.cy);
    if (h > bestHeat) {
      bestHeat = h;
      kill = w.terrain.cellCenter(cc.cx, cc.cy);
    }
  }
  const count = drawEnemy(w, w.rng.int(3, 6), cell);
  if (count === 0) return;
  const embody = leaderEmbodied(w, cell, count);
  // Spend a round of munitions from the cache; a spent cache is expended.
  cache.munitions = Math.max(0, cache.munitions - 1);
  if (cache.munitions === 0) cache.destroyed = true;
  if (cell) cell.iedSkill = clamp01(cell.iedSkill + 0.03); // the cell gets better at the emplacement
  const squadId = `acm-ied-${w.state.clock | 0}`;
  // Concealed firing positions around the kill zone (the L), weapons tight.
  const positions = firingPositions(w, kill, scale(dir, -1), count, 30, 120);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count, cell, i === 0 && embody);
    e.squadId = squadId;
    e.brainState = "ambush";
    e.rof = "hold";
    e.stance = "prone";
    e.iedInit = true; // hold fire until the charge initiates
    e.brainTimer = w.rng.range(4, 14);
    if (i === 0) e.role = "ied_team"; // the triggerman who set and watches the charge
  });
  w.sim.plantIED(kill, squadId);
  if (w.rng.chance(0.45)) {
    const who = cell && cell.intelLevel >= 1 ? `${cell.leaderName}'s men have it` : "it is";
    w.addIntel({
      source: "SIGINT",
      text: `ICOM: "...${who} ready on the road... wait until they reach it..."`,
      reliability: 0.5,
      cx: Math.round(kill.x / w.terrain.cellSize),
      cy: Math.round(kill.y / w.terrain.cellSize),
    });
  }
}

/** Fighters move through the draws toward a village to cache / intimidate. They STAGE from the acting
 *  cell's home area (or a draw mouth if the cell has none), not a random map edge. */
function spawnInfiltration(w: World, cell?: EnemyCell) {
  // Prefer a village the cell recruits from as the objective (its own turf); else any village.
  const vId = cell && cell.villageIds.length ? cell.villageIds[w.rng.int(0, cell.villageIds.length - 1)] : null;
  const v = (vId && w.state.villages.find((x) => x.id === vId)) || w.rng.pick(w.state.villages);
  const targetPt = w.terrain.cellCenter(v.cx, v.cy);
  const staging = cell ? w.terrain.cellCenter(cell.homeCx, cell.homeCy) : drawStaging(w, targetPt);
  const count = drawEnemy(w, w.rng.int(2, 5), cell);
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const pos = add(staging, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(0, 30)));
    const e = spawnFighter(w, clampMap(w.terrain, pos), i, count, cell, false);
    e.brainState = "patrolling";
    e.rof = "free";
    e.technique = "concealed";
    // Snap the approach point to ground actually reachable from the network (a real crossing), so an
    // infiltrator whose village sits across the now-impassable river routes to a ford instead of
    // wading toward it and stranding at the water (issue 010 — the enemy analogue of the squad snap).
    const aim = w.terrain.reachablePoint(targetPt.x + w.rng.range(-60, 60), targetPt.y + w.rng.range(-60, 60));
    w.sim.pathTo(e, aim, { concealBias: 0.7, cheapFallback: true });
  }
  if (w.rng.chance(0.5)) {
    const who = cell && cell.intelLevel >= 1 ? `${cell.leaderName}'s fighters` : "fighters";
    w.addIntel({ source: "SIGINT", text: `ICOM: ${who} moving toward ${v.name} tonight.`, reliability: 0.55, cx: v.cx, cy: v.cy });
  }
}

/** A couple of fighters harass the COP or a patrol from distance. */
function spawnHarass(w: World, cell?: EnemyCell) {
  const patrol = w.activePatrolCentroid();
  const focus = patrol ?? w.copWorld();
  const count = drawEnemy(w, w.rng.int(2, 3), cell);
  if (count === 0) return;
  const embody = leaderEmbodied(w, cell, count);
  // 220..380 m: standoff harassing fire from the high ground — longer than the 80..260 m
  // ambush, but inside effective AK/PKM range so the rounds REACH the patrol (two-way fire),
  // not the old 300..620 m sterile plink that produced enemy-only suppression (integration fix).
  const positions = firingPositions(w, focus, { x: 0, y: -1 }, count, 220, 380);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count, cell, i === 0 && embody);
    e.brainState = "engage";
    e.brainTimer = w.rng.range(6, 14);
    e.rof = "free";
  });
}

/** A larger element presses the COP — the bad nights. `cell` optional so headless probes
 *  (cop-defense-probe) can stage one directly; it picks a cell when none is passed. */
export function spawnComplexAttack(w: World, cell?: EnemyCell) {
  const acting = cell ?? pickCellForActivity(w) ?? undefined;
  const cop = w.copWorld();
  const count = drawEnemy(w, w.rng.int(8, 16), acting);
  if (count === 0) return;
  const embody = leaderEmbodied(w, acting, count);
  for (let i = 0; i < count; i++) {
    const a = w.rng.range(0, Math.PI * 2);
    const r = w.rng.range(260, 560);
    const pos = clampMap(w.terrain, add(cop, fromAngle(a, r)));
    const e = spawnFighter(w, pos, i, count, acting, i === 0 && embody);
    e.brainState = "engage";
    e.rof = "free";
    e.facing = angle(sub(cop, pos));
  }
  w.log("STAND TO — the COP is taking fire from the ridgelines!", "contact");
  w.interrupt("COMPLEX ATTACK on the COP");
}

/** Ambush a resupply convoy on the valley road. `cell` optional (projects.ts / realism-probe call it
 *  bare); it picks a cell when none is passed. */
export function spawnRoadAmbush(w: World, cell?: EnemyCell) {
  const acting = cell ?? pickCellForActivity(w) ?? undefined;
  const roadY = w.rng.int(w.terrain.size * 0.3, w.terrain.size * 0.7);
  const focus = w.terrain.cellCenter(Math.round(w.terrain.size / 2), roadY);
  const count = drawEnemy(w, w.rng.int(3, 6), acting);
  const embody = leaderEmbodied(w, acting, count);
  const positions = firingPositions(w, focus, { x: 1, y: 0 }, count, 80, 260);
  positions.forEach((pos, i) => {
    const e = spawnFighter(w, pos, i, count, acting, i === 0 && embody);
    e.brainState = "engage";
    e.rof = "free";
  });
}

/** Decide ONCE per activity whether the first man embodies the cell's named leader: only for a real
 *  element (≥4 men) with a living leader, ~40% of the time. Draws once so the per-fighter loop stays
 *  a pure placement pass. */
function leaderEmbodied(w: World, cell: EnemyCell | undefined, count: number): boolean {
  return !!cell && cell.leaderAlive && count >= 4 && w.rng.chance(0.4);
}

function spawnFighter(w: World, pos: Vec2, i: number, total: number, cell?: EnemyCell, embodyLeader = false): Unit {
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
  // Persistent NETWORK linkage: this fighter belongs to a cell, so his KIA/exfil moves that cell's
  // strength (world.cullEnemies), and the first man may EMBODY the cell's named leader — killing
  // whom forces succession. Passive fields; the combat AI ignores them.
  if (cell) e.cellId = cell.id;
  if (embodyLeader) e.isCellLeader = true;
  // The first man of every batch leads the cell (he also holds the best-scored
  // firing position — the anchor corner), which switches on the cell-combat
  // coordinator (ai/cell-combat.ts). ≥6-man batches already minted a commander via
  // enemyRoleFor; this extends C2 to the small cells. Key on isLeader, never role —
  // spawnIedAmbush overwrites role to "ied_team" after spawn.
  if (i === 0) e.isLeader = true;
  w.sim.addUnit(e);
  return e;
}

/** Number of fighters we can field right now: bounded by the active cap AND the acting cell's own
 *  strength (a cell fields only what it has). With no cell it falls back to the derived scalar. */
function drawEnemy(w: World, n: number, cell?: EnemyCell): number {
  const room = MAX_ACTIVE_ENEMY - w.sim.livingEnemies().length;
  const pool = cell ? Math.ceil(cell.strength) : Math.ceil(w.state.enemyStrengthAbs);
  return clamp(Math.min(n, room, pool), 0, n);
}

/** Score a candidate firing point against the kill zone: plunging fire from concealed,
 *  covered high ground that has LOS to the focus and lies along the desired ambush axis. */
function scoreFiringPoint(w: World, p: Vec2, focus: Vec2, dir: Vec2): number | null {
  const t = w.terrain;
  if (p.x < 20 || p.y < 20 || p.x > t.worldSize - 20 || p.y > t.worldSize - 20) return null;
  if (!t.passableCell(Math.floor(p.x / t.cellSize), Math.floor(p.y / t.cellSize))) return null;
  const los = lineOfSight(t, p, focus, { observerHeight: 1.2, targetHeight: 1.7 });
  if (!los.visible) return null; // a plunging position with no LOS to the kill zone is useless
  const conceal = t.concealAt(p.x, p.y);
  const cover = t.coverAt(p.x, p.y);
  const elevAdv = t.elevAt(p.x, p.y) - t.elevAt(focus.x, focus.y);
  const toP = norm(sub(p, focus));
  const align = toP.x * dir.x + toP.y * dir.y;
  // Plunging fire: normalize elevAdv to a ~0..1.6 band (saturating ~35 m up) so it can OUTWEIGH
  // conceal (the old elevAdv*0.02 was swamped by conceal*3 — elevation was effectively ignored).
  const elevScore = clamp(elevAdv / 22, -0.5, 1.6);
  // PROXIMITY: high ground only matters if it can actually engage the kill zone. Without this,
  // maximizing elevation alone drives the cell onto the tallest, FARTHEST ridges (measured: they
  // engaged at 320 m, too far to suppress, and exfil dominated). Korengal high ground was CLOSE
  // (narrow valley). Prefer firing points near a realistic small-arms ambush range (~150 m),
  // falling off past it — this keeps the plunging advantage at an engageable distance.
  const range = dist(p, focus);
  // Falls off HARD past ~150 m so a far, tall ridge can't beat a closer, slightly-lower knoll.
  // (Integration tuning: with the old /200 falloff + −0.5 floor the elevation term swamped
  //  proximity and harass cells settled at ~330 m / +73 m elev — a one-sided plink the US won
  //  for free with ZERO return-fire suppression. Tighter falloff + weight keeps the plunging
  //  advantage at an ENGAGEABLE range so rounds actually reach the patrol and suppress BOTH sides.)
  const proximity = clamp(1 - Math.abs(range - 150) / 150, -1.2, 1);
  return elevScore * 2.6 + proximity * 2.6 + conceal * 2.2 + cover * 1.6 + los.exposure * 1.6 + align * 0.6;
}

/**
 * Firing positions for an enemy cell. TWO-STAGE so the cell actually MASSES on a firing line
 * (the L) instead of ringing the kill zone uniformly (#12). The old single-stage version sampled
 * count*8 points across the whole minR..maxR annulus — ~380k m² with ~40 samples ⇒ candidates
 * ~100 m apart, so no picker could ever build a tight firing line (measured: within-45m-of-best
 * = 1–3, pairwise ~180 m). Instead we now: (1) sample ANCHORS across the annulus and pick the
 * best 1–2 high-ground/defilade sectors (the L corners); (2) sample the actual firing positions
 * DENSELY around each anchor (within a fire-team frontage), so the cell lands on 1–2 firing lines.
 */
function firingPositions(w: World, focus: Vec2, dir: Vec2, count: number, minR: number, maxR: number): Vec2[] {
  const t = w.terrain;
  const FRONTAGE = 40; // a fire team's firing line frontage (m) — tight on the kill zone

  // Stage 1: scan anchors across the annulus; keep the scored, LOS-capable ones.
  const anchors: { p: Vec2; s: number }[] = [];
  for (let tries = 0; tries < 700 && anchors.length < 24; tries++) {
    const p = add(focus, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(minR, maxR)));
    const s = scoreFiringPoint(w, p, focus, dir);
    if (s !== null) anchors.push({ p, s: s + w.rng.range(0, 0.4) });
  }
  anchors.sort((a, b) => b.s - a.s);

  // Choose 1–2 anchors (L corners): the best, plus — only for a cell big enough to man two legs —
  // one well clear of it for angular separation. Small cells (≤4) stay a single tight firing line.
  const corners: Vec2[] = [];
  if (anchors.length) corners.push(anchors[0].p);
  if (count > 4) {
    const second = anchors.find((a) => corners.every((c) => dist(a.p, c) > FRONTAGE * 1.6));
    if (second) corners.push(second.p);
  }
  if (corners.length === 0) {
    // No LOS anchor found — fall back to spread points so the cell still spawns somewhere valid.
    const out: Vec2[] = [];
    while (out.length < count) out.push(clampMap(t, add(focus, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(minR, maxR)))));
    return out;
  }

  // Stage 2: densely sample firing positions around each corner; take the best, MIN_SEP apart.
  const MIN_SEP = 4; // not stacked on one man
  const perCorner = Math.ceil(count / corners.length);
  const out: Vec2[] = [];
  for (const corner of corners) {
    const local: { p: Vec2; s: number }[] = [{ p: corner, s: scoreFiringPoint(w, corner, focus, dir) ?? 0 }];
    for (let tries = 0; tries < 200 && local.length < perCorner * 6; tries++) {
      const p = add(corner, fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(0, FRONTAGE)));
      const s = scoreFiringPoint(w, p, focus, dir);
      if (s !== null) local.push({ p, s: s + w.rng.range(0, 0.3) });
    }
    local.sort((a, b) => b.s - a.s);
    let placed = 0;
    for (const c of local) {
      if (out.length >= count || placed >= perCorner) break;
      if (out.some((q) => dist(q, c.p) < MIN_SEP)) continue;
      out.push(c.p);
      placed++;
    }
  }
  // Top up around the primary corner if dense sampling fell short (rough terrain / few cells).
  while (out.length < count) {
    const p = add(corners[0], fromAngle(w.rng.range(0, Math.PI * 2), w.rng.range(0, FRONTAGE)));
    out.push(clampMap(t, p));
  }
  return out.slice(0, count);
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
