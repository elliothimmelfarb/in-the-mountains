import { Vec2, dist, angle, sub } from "../vec";
import { RosterMember } from "../entities";
import type { World } from "./world";

/**
 * Garrison life. When soldiers aren't on a task they don't stand frozen in a
 * field — they live in the COP. A rotating guard pulls security on the wall and
 * in the towers, the machine-gun crews stay on their guns, leaders work the TOC,
 * the medic keeps the aid station, and everyone else eats at the chow hall on
 * the meal hours and racks out in the barracks after dark. When the wire takes
 * fire, the whole COP stands to and mans the fighting positions.
 */

const SHIFT = 90 * 60; // guard rotation, game-seconds
const ARRIVE = 4; // m — close enough to a billet

export function tickGarrison(w: World, dt: number) {
  const cop = w.terrain.cop;
  if (!cop) return;

  const tasked = new Set<string>();
  for (const t of w.state.tasks) for (const id of t.memberIds) tasked.add(id);

  const center = w.copWorld();
  const wire = w.terrain.cop.radius * w.terrain.cellSize;

  // Any off-task soldier left outside the wire (a separated straggler after a
  // fight) walks himself home through the gate.
  const muster = w.musterWorld();
  for (const m of w.platoon.members) {
    if (!m.alive || m.status === "wounded" || m.evac || tasked.has(m.id)) continue;
    if (dist(m.pos, center) > wire + 25) {
      m.brainState = "returning";
      m.faceLock = null;
      if (m.path.length === 0) w.sim.pathTo(m, muster);
    }
  }

  // Who's available to take a post inside the wire.
  const home = w.platoon.members.filter(
    (m) => m.alive && m.status !== "wounded" && !m.evac && !tasked.has(m.id) && dist(m.pos, center) <= wire + 25
  );
  if (home.length === 0) return;

  // The COP stands to when fighters are near the wire — AND at first/last light (BMNT/EENT),
  // the stand-to windows every infantryman knows and the enemy favours (director dawn/dusk).
  const hour = w.secondsOfDay / 3600;
  const standToWindow = (hour >= 5 && hour < 6.2) || (hour >= 18.3 && hour < 19.4);
  const standTo = standToWindow || w.sim.livingEnemies().some((e) => dist(e.pos, center) < 360);

  // Building / post lookups (world meters). Fighting positions carry their sector so a sentry
  // can SWEEP his arc instead of staring one way.
  const fps = cop.fightingPositions.map((f) => ({
    pos: w.terrain.cellCenter(f.cx, f.cy),
    face: f.facing,
    left: f.leftLimit,
    right: f.rightLimit,
  }));
  // Buildings are solid (issue 004), so a "post" at a building is its yard-side
  // doorway (toward the COP centre), never boxed between the building and the wall.
  const at = (kind: string): Vec2 => {
    const b = cop.buildings.find((x) => x.kind === kind);
    return b ? w.terrain.buildingSeat(b) : center;
  };
  const toc = at("toc");
  const aid = at("aid");
  const dfac = at("dfac");

  // Rotating guard roster from the riflemen/NCOs (gun crews are posted separately).
  const pool = home
    .filter((m) => GUARD_ROLES.has(m.role))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const onGuard = new Map<string, number>(); // memberId -> fighting-position index
  if (fps.length && pool.length) {
    const need = Math.min(fps.length, Math.max(2, Math.round(pool.length * 0.4)));
    const shift = Math.floor(w.absSeconds / SHIFT);
    for (let i = 0; i < need; i++) {
      const m = pool[(i + shift) % pool.length];
      onGuard.set(m.id, i % fps.length);
    }
  }

  // Work details — "a COP is never finished." A rotating slice of the off-duty riflemen are on
  // detail improving the wire (filling/repairing HESCO + sandbags); while men work, the COP's
  // fortification (fob.hesco) climbs — finally giving that dead stat a writer. Suspended at stand-to.
  const detail = new Map<string, number>(); // id -> ordinal, so the detail spreads EVENLY around the wire
  if (!standTo) {
    const idle = pool.filter((m) => !onGuard.has(m.id));
    const dneed = Math.floor(idle.length * 0.45);
    const dshift = Math.floor(w.absSeconds / (SHIFT / 2)); // details rotate twice as often as guard
    for (let i = 0; i < dneed; i++) {
      const m = idle[(i + dshift) % idle.length];
      if (m && !detail.has(m.id)) detail.set(m.id, detail.size);
    }
  }

  const mealTime = (hour >= 7 && hour < 8) || (hour >= 12 && hour < 13) || (hour >= 18 && hour < 19);
  const sleepTime = w.isNight();

  for (const m of home) {
    let post: Vec2;
    let face: number | null = null;

    if (standTo) {
      const fp = nearestFP(fps, m.pos);
      post = fp.pos;
      face = sweepFace(fp, m, w.absSeconds);
      m.brainState = "standto";
      m.rof = "free";
    } else if (m.role === "machinegunner") {
      const gun = mgPost(w, m, center);
      post = gun.pos;
      face = gun.face;
      m.brainState = "manning";
    } else if (onGuard.has(m.id)) {
      const fp = fps[onGuard.get(m.id)!];
      post = fp.pos;
      face = sweepFace(fp, m, w.absSeconds); // sentry sweeps his sector, doesn't stare one way
      m.brainState = "guard";
    } else if (detail.has(m.id)) {
      // on a work detail at the wire — posted along the inside of the HESCO line, facing out.
      // Bearing is EVEN-by-ordinal (not hashId%360): consecutive member ids hash to consecutive
      // bearings, which piled the whole detail into a 16° corner of the wire; spreading by ordinal
      // walks the detail around the full perimeter (a COP improves the wire everywhere, not one spot).
      const ord = detail.get(m.id)!;
      const b = ((ord + 0.5) / Math.max(1, detail.size)) * Math.PI * 2;
      const wr = (cop.radius - 2) * w.terrain.cellSize;
      post = jit({ x: center.x + Math.cos(b) * wr, y: center.y + Math.sin(b) * wr }, m, 3);
      face = b;
      m.brainState = "detail";
    } else if (mealTime) {
      // chow line — a loose queue fanned at the chow hall, not a 5 m pile stacked on the building
      post = fanAround(w, m, dfac, 9);
      m.brainState = "chow";
    } else if (m.role === "medic") {
      post = jit(aid, m, 4);
      m.brainState = "aid";
    } else if (m.role === "platoon_leader" || m.role === "platoon_sergeant" || m.role === "rto" || m.role === "jtac") {
      post = jit(toc, m, 5);
      m.brainState = "toc";
    } else if (sleepTime) {
      // racked out for the night — spread along the rear billets, not piled on two doorways
      post = yardSpot(w, m, center, wire, cop.gateDir, true);
      m.brainState = "rest";
    } else {
      // off-duty: fan out across the yard (the lived-in COP), instead of stacking on the barracks
      post = yardSpot(w, m, center, wire, cop.gateDir, false);
      m.brainState = "garrison";
    }

    m.faceLock = face;
    // Keep the seat on REACHABLE ground (a jittered post can land on a solid wall/building or, with
    // the river now a real barrier, in a tiny passable pocket the man can't actually get to). Using
    // nearestReachable (not just nearestPassable) guarantees the seat is in the garrison's own
    // component, so walkTo never re-fires the heavy free A* every tick chasing an unreachable seat.
    const seat = w.terrain.reachablePoint(post.x, post.y);
    const far = dist(m.pos, seat) > ARRIVE;
    // Track a man WEDGED (moving but not advancing) while still short of his post: the cheap garrison
    // router (walkTo, one thin corridor) can fail to thread a tight or carved interior and hand him a
    // path that grazes a wall, where he grinds — drops it after 2 s — and is handed the same path again.
    // Once that persists, escalate him to the FULL planner (pathTo), which finds the route the cheap one
    // missed (every post is findPath-reachable from the muster by construction). This fires ONLY for a
    // genuinely stuck man and only when his path empties, so it never pays the heavy search on open ground.
    if (far && m.moving && (m.speed ?? 0) < 0.05) m.postStuck = (m.postStuck ?? 0) + dt;
    else if (!far || (m.speed ?? 0) > 0.1) m.postStuck = Math.max(0, (m.postStuck ?? 0) - dt);
    if (m.path.length === 0 && far) {
      if ((m.postStuck ?? 0) > 4) w.sim.pathTo(m, seat, { cheapFallback: false });
      else w.sim.walkTo(m, seat);
    } else if (!far) {
      m.path = [];
      m.postStuck = 0;
    }
  }

  // While details are on the wire it gets stronger (capped) — the first real writer of fob.hesco.
  if (detail.size > 0) {
    const fob = w.state.fob;
    fob.hesco = Math.min(100, (fob.hesco ?? 0) + detail.size * 0.00012 * dt);
  }
}

const GUARD_ROLES = new Set(["rifleman", "team_leader", "grenadier", "saw_gunner", "auto_rifleman", "squad_leader"]);

/** A fighting position with its sector bounds, so a sentry can sweep his arc. */
type FP = { pos: Vec2; face: number; left: number; right: number };

/** A sentry's gaze: slowly sweep across the position's sector instead of staring outward.
 *  Deterministic (phase from sim time + the man's id), so a same-seed replay is identical. */
function sweepFace(fp: FP, m: RosterMember, t: number): number {
  const TWO_PI = Math.PI * 2;
  const span = Math.min(1.2, Math.abs(((fp.left - fp.right) % TWO_PI + TWO_PI) % TWO_PI));
  return fp.face + Math.sin(t * 0.22 + hashId(m.id)) * span * 0.35;
}

function nearestFP(fps: FP[], p: Vec2): FP {
  let best = fps[0];
  let bd = Infinity;
  for (const f of fps) {
    const d = dist(f.pos, p);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best ?? { pos: p, face: 0, left: Math.PI / 4, right: -Math.PI / 4 };
}

/** A machine-gunner's spot: his crew-served emplacement, facing outboard. */
function mgPost(w: World, m: RosterMember, center: Vec2): { pos: Vec2; face: number } {
  // Gunners were positioned on their emplacement at stand-up; hold the gun there.
  const emp = w.state.fob.emplacements
    .filter((e) => e.weaponId === "m240" || e.weaponId === "m2" || e.weaponId === "mk19")
    .map((e) => w.terrain.cellCenter(e.cell.cx, e.cell.cy));
  const pos = emp.length ? emp.reduce((a, b) => (dist(b, m.pos) < dist(a, m.pos) ? b : a)) : m.pos;
  return { pos, face: angle(sub(pos, center)) };
}

function jit(p: Vec2, m: RosterMember, r: number): Vec2 {
  const h = hashId(m.id);
  return { x: p.x + (((h % 100) / 100) * 2 - 1) * r, y: p.y + ((((h / 100) | 0) % 100) / 100 * 2 - 1) * r };
}

// Golden angle (rad) — phyllotaxis: successive indices land ~137.5° apart, so ANY subset of
// the platoon (the off-duty pool changes as guard rotates) still fans out evenly, never clumps.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A man's STABLE personal spot in garrison life, fanned across the open interior yard by a
 * golden-angle lattice keyed to his platoon index — so off-duty men SPREAD across the COP
 * (weapons-cleaning on the Hescos, racks down the billet rows, loafing, walking the wire)
 * instead of piling onto two barracks doorways. That pile-up — ~13 men jammed onto the two
 * rear barracks footprints — was the "stuck on buildings, too close together" the player saw:
 * not a footprint/collider problem (every building's apron is 80–100% open) but a PLACEMENT
 * one, the whole off-duty pool funnelled to two seats. Spreading them reads as a lived-in
 * outpost and dissolves the cluster.
 *
 * Deterministic — platoon index + a pure id hash, zero RNG — so replays stay bit-identical and
 * nothing new is persisted. The caller's reachablePoint snap steps any spot that lands on a
 * building/wall onto its apron, so the man always has somewhere walkable to stand.
 *   rear : pull the lattice toward the rear billets at a tighter radius (night rest — men settle
 *          by their racks, not out in the open ECP yard); false = the full daytime yard.
 */
function yardSpot(w: World, m: RosterMember, center: Vec2, wire: number, gateDir: Vec2, rear: boolean): Vec2 {
  const members = w.platoon.members;
  let idx = 0;
  for (let i = 0; i < members.length; i++) if (members[i].id === m.id) { idx = i; break; }
  const n = Math.max(1, members.length);
  const frac = (idx + 0.5) / n;
  // sqrt(frac) → uniform AREA density (men don't pile in the centre); bounds keep every spot
  // inside the R-3 buildable yard (rHi 0.74·R ≈ R-3 at R=12), so reachablePoint rarely re-snaps.
  const rLo = rear ? 0.26 : 0.20;
  const rHi = rear ? 0.56 : 0.74;
  const rad = wire * (rLo + (rHi - rLo) * Math.sqrt(frac));
  const ang = idx * GOLDEN + (hashId(m.id) % 360) * (Math.PI / 180) * 0.12; // tiny per-man phase
  const p = { x: center.x + Math.cos(ang) * rad, y: center.y + Math.sin(ang) * rad };
  // Night: bias toward the rear (away from the gate) so sleepers settle by the billets.
  return rear ? { x: p.x - gateDir.x * wire * 0.16, y: p.y - gateDir.y * wire * 0.16 } : p;
}

/** Fan a man around a gathering point by his platoon index (golden angle), so a crowd at one
 *  spot — the chow line at the dfac — reads as a loose queue rather than a tight pile stacked on
 *  the building. Deterministic; the caller's reachablePoint snap keeps it off the footprint. */
function fanAround(w: World, m: RosterMember, anchor: Vec2, spread: number): Vec2 {
  const members = w.platoon.members;
  let idx = 0;
  for (let i = 0; i < members.length; i++) if (members[i].id === m.id) { idx = i; break; }
  const r = spread * (0.35 + 0.65 * (((idx * 7) % 11) / 10));
  const a = idx * GOLDEN;
  return { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r };
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
