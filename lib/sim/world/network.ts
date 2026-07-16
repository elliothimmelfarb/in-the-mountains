import { RNG, clamp, clamp01, lerp } from "../rng";
import { Terrain } from "../terrain";
import { Vec2, dist } from "../vec";
import { pashtunName } from "../names";
import { VillageState } from "../campaign";
import type { World } from "./world";
import { EnemyCell, EnemyCache, EnemyNetwork, HEAT_DIM, DAY } from "./types";

/**
 * The persistent enemy NETWORK — the insurgency as an ORGANIZATION, not a weather system.
 *
 * Before this module the enemy was `enemyStrengthAbs` (a scalar rolled 40–70 at world init) plus
 * a memoryless director: fighters spawned from nothing, fought, and despawned into nothing. You
 * cannot hunt a weather system. After it the enemy is 3–5 named CELLS with home areas, physical
 * munitions CACHES, and a memory of the player's habits (a decaying patrol-heat field). The
 * director SPENDS cells; an exfiltrated fighter flows BACK into his cell (attrition is physical);
 * a killed named leader forces succession; a won-over village gives its cell up (HUMINT). So the
 * FM 3-24 loop — win the population → they expose the network → you dismantle it → the valley
 * calms — is mechanical, not flavor.
 *
 * `enemyStrengthAbs` stays ALIVE as the DERIVED SUM of living cell strengths (`deriveEnemyStrength`),
 * so every existing reader (the interdict directive, the HUD ENY meter, the director's own gates,
 * the harnesses) keeps working unchanged. Every WRITE to the scalar is now routed to a cell.
 *
 * Determinism: creation draws from a keyed FORK (never the main stream, so create-time draw order
 * is untouched); the per-tick network draws come from `w.rng` in the tick, the same contract every
 * subsystem honors. No `Date.now` / `Math.random`.
 */

/** The insurgency's ceiling — the historical clamp the scalar carried (tickInsurgency / civcas).
 *  The sum of living cell strengths is held to this, so the derived scalar stays in its old band. */
const NETWORK_CAP = 80;
/** A cell that falls below this many fighters can no longer function — it BREAKS. */
const BREAK_FLOOR = 2;

// ---------------------------------------------------------------------------
//  Creation
// ---------------------------------------------------------------------------

/**
 * Build the order of battle for a fresh valley: 3–5 cells seeded on the most insurgent-sympathetic
 * villages, home areas on the high ground / draws NEAR them (reachability-snapped — the spawn
 * invariant), 4–8 munitions caches near their villages, and the rolled strength `budget` distributed
 * across the cells so Σ === budget exactly (conservation). Draws ONLY from the passed (forked) rng.
 */
export function buildNetwork(terrain: Terrain, villages: VillageState[], budget: number, rng: RNG): EnemyNetwork {
  const cells: EnemyCell[] = [];
  const caches: EnemyCache[] = [];
  if (villages.length === 0) return { cells, caches };

  // Affinity: how readily a village would host insurgents (hidden sympathy + open hostility).
  const affinity = (v: VillageState) => v.sympathy + Math.max(0, -v.attitude);
  const ranked = [...villages].sort((a, b) => affinity(b) - affinity(a) || (a.id < b.id ? -1 : 1));
  const nCells = clamp(Math.round(villages.length / 2), 3, 5);
  const seeds = ranked.slice(0, Math.min(nCells, ranked.length));

  // Home area: near the seed village, biased to the highest REACHABLE ground within a few hundred
  // metres (a spur / draw the cell owns), snapped so a spawned fighter is never stranded.
  const homeCell = (v: VillageState): { cx: number; cy: number } => {
    const c = terrain.cellCenter(v.cx, v.cy);
    let best = terrain.reachablePoint(c.x, c.y);
    let bestE = terrain.elevAt(best.x, best.y);
    for (let k = 0; k < 8; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const rad = rng.range(60, 220); // 60..220 m off the village centre
      const p = terrain.reachablePoint(c.x + Math.cos(ang) * rad, c.y + Math.sin(ang) * rad);
      const e = terrain.elevAt(p.x, p.y);
      if (e > bestE) {
        bestE = e;
        best = p;
      }
    }
    return { cx: Math.floor(best.x / terrain.cellSize), cy: Math.floor(best.y / terrain.cellSize) };
  };

  // Strength distribution: weighted by seed affinity, last cell soaks the rounding remainder so the
  // integer strengths sum to `budget` EXACTLY (the conservation the probe asserts).
  const wts = seeds.map((v) => Math.max(1, affinity(v)));
  const wsum = wts.reduce((a, b) => a + b, 0);
  let assigned = 0;
  seeds.forEach((v, i) => {
    const hc = homeCell(v);
    const strength = i === seeds.length - 1 ? budget - assigned : Math.round((budget * wts[i]) / wsum);
    assigned += strength;
    cells.push({
      id: `cell-${i}`,
      leaderName: pashtunName(rng),
      leaderAlive: true,
      homeCx: hc.cx,
      homeCy: hc.cy,
      strength: Math.max(0, strength),
      aggression: rng.range(0.3, 0.8),
      iedSkill: rng.range(0.1, 0.45),
      grudge: 0,
      villageIds: [],
      intelLevel: 0,
      lastActivityClock: 0,
    });
  });

  // Every village recruits for its NEAREST cell (a partition — so per-cell regen never double-counts
  // a village). The seed villages naturally fall to their own cell.
  for (const v of villages) {
    const vc = terrain.cellCenter(v.cx, v.cy);
    let best = cells[0];
    let bd = Infinity;
    for (const c of cells) {
      const d = dist(vc, terrain.cellCenter(c.homeCx, c.homeCy));
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    best.villageIds.push(v.id);
  }

  // Caches: 4–8 munitions stores near the cells' villages, snapped reachable.
  const nCaches = rng.int(4, 8);
  for (let i = 0; i < nCaches; i++) {
    const cell = cells[i % cells.length];
    const vid = cell.villageIds.length ? cell.villageIds[rng.int(0, cell.villageIds.length - 1)] : null;
    const base = vid
      ? terrain.cellCenter(villages.find((x) => x.id === vid)!.cx, villages.find((x) => x.id === vid)!.cy)
      : terrain.cellCenter(cell.homeCx, cell.homeCy);
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(40, 160);
    const p = terrain.reachablePoint(base.x + Math.cos(ang) * rad, base.y + Math.sin(ang) * rad);
    caches.push({
      id: `cache-${i}`,
      cx: Math.floor(p.x / terrain.cellSize),
      cy: Math.floor(p.y / terrain.cellSize),
      munitions: rng.int(2, 6),
      found: false,
      destroyed: false,
      cellId: cell.id,
    });
  }

  return { cells, caches };
}

// ---------------------------------------------------------------------------
//  Derived strength + strength mutation (the ONLY writers of enemyStrengthAbs)
// ---------------------------------------------------------------------------

/** enemyStrengthAbs === Σ living cell strengths. Called after every cell-strength mutation so every
 *  legacy reader (director gates, interdict directive, HUD meter, harnesses) sees a correct scalar. */
export function deriveEnemyStrength(w: World): void {
  let s = 0;
  for (const c of w.state.network.cells) if (!c.broken) s += c.strength;
  w.state.enemyStrengthAbs = Math.max(0, s);
}

/** Total living strength right now (the value enemyStrengthAbs mirrors). */
export function networkTotal(w: World): number {
  let s = 0;
  for (const c of w.state.network.cells) if (!c.broken) s += c.strength;
  return s;
}

/** Mutate a cell's strength and re-derive the scalar. Growth is capped so the network total never
 *  exceeds the historical ceiling; strength never goes negative. */
export function addCellStrength(w: World, cell: EnemyCell, amt: number): void {
  if (amt > 0) {
    const room = NETWORK_CAP - networkTotal(w);
    amt = Math.min(amt, Math.max(0, room));
  }
  cell.strength = Math.max(0, cell.strength + amt);
  deriveEnemyStrength(w);
}

// ---------------------------------------------------------------------------
//  Lookups
// ---------------------------------------------------------------------------

export function cellById(w: World, id: string | undefined): EnemyCell | null {
  if (!id) return null;
  return w.state.network.cells.find((c) => c.id === id) ?? null;
}

/** The cell that recruits from this village (its home partition), else the nearest living cell. */
export function cellForVillage(w: World, villageId: string): EnemyCell | null {
  const owner = w.state.network.cells.find((c) => !c.broken && c.villageIds.includes(villageId));
  if (owner) return owner;
  const v = w.state.villages.find((x) => x.id === villageId);
  if (!v) return null;
  return nearestCell(w, w.terrain.cellCenter(v.cx, v.cy));
}

/** Nearest living cell to a world point (by home area). */
export function nearestCell(w: World, pos: Vec2): EnemyCell | null {
  let best: EnemyCell | null = null;
  let bd = Infinity;
  for (const c of w.state.network.cells) {
    if (c.broken) continue;
    const d = dist(pos, w.terrain.cellCenter(c.homeCx, c.homeCy));
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Nearest usable cache (not destroyed, still holding munitions) within `maxM` of a world point. */
export function nearestLivingCache(w: World, pos: Vec2, maxM: number): EnemyCache | null {
  let best: EnemyCache | null = null;
  let bd = maxM;
  for (const c of w.state.network.caches) {
    if (c.destroyed || c.munitions <= 0) continue;
    const d = dist(pos, w.terrain.cellCenter(c.cx, c.cy));
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Director support — which cell acts, and where it stages
// ---------------------------------------------------------------------------

/** Which cell stages the next activity: weighted by strength × (0.5 + grudge) and, when there's a
 *  patrol out, by proximity to it. Cells mid-succession (leaderless) or broken sit it out. */
export function pickCellForActivity(w: World): EnemyCell | null {
  const live = w.state.network.cells.filter((c) => !c.broken && c.leaderAlive && c.strength >= 1);
  if (!live.length) return null;
  const patrol = w.activePatrolCentroid();
  const weights = live.map((c) => {
    let wgt = c.strength * (0.5 + c.grudge);
    if (patrol) {
      const d = dist(patrol, w.terrain.cellCenter(c.homeCx, c.homeCy));
      wgt *= 0.5 + Math.max(0, 1 - d / 1500); // a nearer cell is likelier to be the one that reacts
    }
    return Math.max(0.01, wgt);
  });
  return w.rng.weighted(live, weights);
}

// ---------------------------------------------------------------------------
//  Patrol-heat field (the one honest adaptation)
// ---------------------------------------------------------------------------

/** Heat-grid bucket index for a terrain CELL coordinate. */
export function heatIndex(w: World, cx: number, cy: number): number {
  const bx = clamp(Math.floor((cx / w.terrain.size) * HEAT_DIM), 0, HEAT_DIM - 1);
  const by = clamp(Math.floor((cy / w.terrain.size) * HEAT_DIM), 0, HEAT_DIM - 1);
  return by * HEAT_DIM + bx;
}

/** Heat under a terrain cell (how often the player patrols there). */
export function heatAt(w: World, cx: number, cy: number): number {
  return w.state.patrolHeat[heatIndex(w, cx, cy)] ?? 0;
}

/** Increment the buckets under moving friendly patrols; decay the whole field on a ~weekly constant.
 *  No rng — pure integration, safe to run every tick. */
export function tickPatrolHeat(w: World, dt: number): void {
  const ph = w.state.patrolHeat;
  const decay = Math.exp(-dt / (7 * DAY)); // ~weekly memory of where you walk
  for (let i = 0; i < ph.length; i++) ph[i] *= decay;
  const t = w.terrain;
  for (const u of w.sim.units) {
    if ((u.faction === "us" || u.faction === "ana") && u.alive && !u.evac && u.moving) {
      const cx = Math.floor(u.pos.x / t.cellSize);
      const cy = Math.floor(u.pos.y / t.cellSize);
      ph[heatIndex(w, cx, cy)] += dt;
    }
  }
}

// ---------------------------------------------------------------------------
//  Regeneration — the tickInsurgency replacement (per-cell recruit distribution)
// ---------------------------------------------------------------------------

/**
 * The insurgency regenerates from the population, PER CELL. Each cell recruits from its own villages
 * (sympathy / hostility, floored by unresolved blood debts), takes a share of the thin outside
 * infiltration, and loses men where its villages have gone friendly. The aggregate matches the old
 * whole-valley integrator (villages partition across cells), but now attrition and regen land on
 * real nodes. Growth is capped to the network ceiling; the scalar is re-derived at the end.
 */
export function regenNetwork(w: World, dt: number): void {
  const cells = w.state.network.cells.filter((c) => !c.broken);
  if (cells.length === 0) {
    deriveEnemyStrength(w);
    return;
  }
  const byId = new Map(w.state.villages.map((v) => [v.id, v]));
  const infilShare = (0.4 * w.state.enemyHeat) / cells.length; // outside fighters via the draws, split
  const deltas = cells.map((c) => {
    let recruit = 0;
    let pacify = 0;
    for (const vid of c.villageIds) {
      const v = byId.get(vid);
      if (!v) continue;
      const unresolved = (v.grievances ?? []).reduce((a, g) => a + (g.resolved ? 0 : 1), 0);
      const sympEff = Math.max(v.sympathy, Math.min(36, 12 * unresolved));
      recruit += (sympEff / 100) * (v.attitude < 0 ? 1.0 : 0.55);
      if (v.attitude > 35) pacify += 0.35;
    }
    return recruit + infilShare - pacify;
  });
  cells.forEach((c, i) => {
    c.strength = Math.max(0, c.strength + (deltas[i] * dt) / DAY);
  });
  const tot = networkTotal(w);
  if (tot > NETWORK_CAP) for (const c of cells) c.strength *= NETWORK_CAP / tot;
  deriveEnemyStrength(w);
}

// ---------------------------------------------------------------------------
//  Leader succession
// ---------------------------------------------------------------------------

/** The named leader is dead: the cell goes leaderless, tempo pauses, grudge spikes, and the player
 *  learns the man's name if he didn't already. Succession lands 1–2 game-days later. */
export function beginSuccession(w: World, cell: EnemyCell): void {
  if (!cell.leaderAlive) return;
  cell.leaderAlive = false;
  cell.successionAt = w.state.clock + w.rng.range(1, 2) * DAY;
  cell.grudge = clamp01(cell.grudge + 0.3);
  const dead = cell.leaderName;
  // Killing him teaches the player the name (0→1) if it wasn't already known.
  if (cell.intelLevel === 0) cell.intelLevel = 1;
  w.log(`ICOM traffic scatters in the valley — ${dead} has been killed.`, "radio");
  w.addIntel({
    source: "HUMINT",
    text: `${dead}, a local commander, is dead. His men are leaderless — for now.`,
    reliability: 0.7,
    cx: cell.intelLevel >= 2 ? cell.homeCx : undefined,
    cy: cell.intelLevel >= 2 ? cell.homeCy : undefined,
  });
}

/** Run pending successions and the cell-break end state; re-derive the scalar. Called once per tick
 *  after casualties are reconciled. */
export function advanceNetwork(w: World): void {
  for (const cell of w.state.network.cells) {
    if (cell.broken) continue;
    if (cell.successionAt !== undefined && !cell.leaderAlive && w.state.clock >= cell.successionAt) {
      const old = cell.leaderName;
      let name = pashtunName(w.rng);
      for (let tries = 0; tries < 4 && name === old; tries++) name = pashtunName(w.rng);
      cell.leaderName = name;
      cell.leaderAlive = true;
      cell.successionAt = undefined;
      cell.strength = Math.max(0, cell.strength * 0.7); // fighters drift during the vacuum
      w.log(`Word from the valley: ${cell.leaderName} has taken over ${old}'s men.`, "radio");
      w.addIntel({
        source: "HUMINT",
        text: `HUMINT: ${old} is dead; his men answer to ${cell.leaderName} now.`,
        reliability: 0.65,
        cx: cell.intelLevel >= 2 ? cell.homeCx : undefined,
        cy: cell.intelLevel >= 2 ? cell.homeCy : undefined,
      });
    }
  }
  // Cell-break end state: a cell shot down below the floor collapses; its survivors merge into the
  // nearest living cell (or dissolve), and its villages get a spell of calm.
  for (const cell of w.state.network.cells) {
    if (cell.broken) continue;
    if (cell.successionAt !== undefined) continue; // not while a succession is resolving
    if (cell.strength < BREAK_FLOOR) breakCell(w, cell);
  }
  deriveEnemyStrength(w);
}

// ---------------------------------------------------------------------------
//  The COIN loop — a won-over village gives up its cell (HUMINT)
// ---------------------------------------------------------------------------

/** A noisy-true node location: cell coords within a radius that SHRINKS with reliability (a better
 *  source points closer). Kept under ~150 m for a located (intelLevel ≥ 2) report. */
function noisyNode(w: World, hcx: number, hcy: number, reliability: number): { cx: number; cy: number } {
  const radM = lerp(140, 25, clamp01(reliability)); // 25..140 m — always inside the located radius
  const ang = w.rng.range(0, Math.PI * 2);
  const r = w.rng.range(0, radM);
  const cs = w.terrain.cellSize;
  return {
    cx: clamp(Math.round(hcx + (Math.cos(ang) * r) / cs), 0, w.terrain.size - 1),
    cy: clamp(Math.round(hcy + (Math.sin(ang) * r) / cs), 0, w.terrain.size - 1),
  };
}

/**
 * A cooperative, no-longer-hostile village occasionally EXPOSES the cell that recruits from it —
 * the FM 3-24 loop made mechanical. The intel it gives escalates with what the player already knows:
 * first the leader's NAME (0→1), then a LOCATED report near the true home (1→2), then — with real
 * cooperation — the network MAPPED and a cache site given up (2→3). Reliability scales with the
 * village's cooperation; noise shrinks with it. Hostile villages give up nothing. Returns true iff
 * a report was emitted (so the caller can fall back to ICOM flavor when nothing was learned).
 */
export function emitNetworkHumint(w: World): boolean {
  const coop = w.state.villages.filter((v) => v.attitude > 20 && v.cooperation > 45);
  if (!coop.length) return false;
  const v = w.rng.pick(coop);
  const cell = cellForVillage(w, v.id);
  if (!cell || cell.broken) return false;
  const rel = clamp01(0.45 + v.cooperation / 200);

  if (cell.intelLevel === 0) {
    cell.intelLevel = 1;
    w.addIntel({ source: "HUMINT", text: `A man from ${v.name} names the local commander: ${cell.leaderName}.`, reliability: rel });
    return true;
  }
  if (cell.intelLevel === 1) {
    cell.intelLevel = 2;
    const n = noisyNode(w, cell.homeCx, cell.homeCy, rel);
    w.addIntel({
      source: "HUMINT",
      text: `${v.name} points to where ${cell.leaderName}'s men shelter — up in the draws.`,
      reliability: rel,
      cx: n.cx,
      cy: n.cy,
    });
    return true;
  }
  // intelLevel ≥ 2: high cooperation MAPS the network and gives up a cache.
  if (v.cooperation > 60) {
    if (cell.intelLevel === 2) cell.intelLevel = 3;
    const cache = w.state.network.caches.find((c) => c.cellId === cell.id && !c.found && !c.destroyed);
    if (cache) {
      cache.found = true;
      w.addIntel({
        source: "HUMINT",
        text: `${v.name} gives up a cache site used by ${cell.leaderName}'s men.`,
        reliability: Math.min(0.9, rel + 0.1),
        cx: cache.cx,
        cy: cache.cy,
      });
      return true;
    }
    const n = noisyNode(w, cell.homeCx, cell.homeCy, Math.min(1, rel + 0.1));
    w.addIntel({
      source: "HUMINT",
      text: `${v.name} confirms ${cell.leaderName}'s ground — his men, his shelters, his routes.`,
      reliability: Math.min(0.9, rel + 0.1),
      cx: n.cx,
      cy: n.cy,
    });
    return true;
  }
  return false;
}

function breakCell(w: World, cell: EnemyCell): void {
  cell.broken = true;
  const hadVillageIds = [...cell.villageIds];
  const residual = cell.strength;

  // The nearest still-living cell inherits the wreckage.
  const home = w.terrain.cellCenter(cell.homeCx, cell.homeCy);
  let heir: EnemyCell | null = null;
  let bd = Infinity;
  for (const c of w.state.network.cells) {
    if (c.broken || c === cell) continue;
    const d = dist(home, w.terrain.cellCenter(c.homeCx, c.homeCy));
    if (d < bd) {
      bd = d;
      heir = c;
    }
  }

  // Survivors on the map re-flag to the heir (or lose their linkage if the network is finished).
  for (const u of w.sim.units) {
    if (u.faction === "insurgent" && u.cellId === cell.id) {
      u.cellId = heir?.id;
      u.isCellLeader = false;
    }
  }

  cell.villageIds = [];
  cell.strength = 0;
  if (heir) {
    heir.villageIds.push(...hadVillageIds);
    addCellStrength(w, heir, residual); // fold the residual in so total strength is conserved
  }

  // A spell of calm settles over the ground this cell held.
  const names: string[] = [];
  for (const vid of hadVillageIds) {
    const v = w.state.villages.find((x) => x.id === vid);
    if (!v) continue;
    v.attitude = clamp(v.attitude + 3, -100, 100);
    v.sympathy = clamp(v.sympathy - 6, 0, 100);
    names.push(v.name);
  }
  const where = names.length ? ` around ${names[0]}` : "";
  w.log(`A fighting cell${where} has been broken — its men scattered or dead. The valley there goes quiet.`, "objective");
  w.interrupt("an enemy cell has broken");
}
