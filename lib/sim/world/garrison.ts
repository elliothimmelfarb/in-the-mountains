import { Vec2, dist, angle, sub } from "../vec";
import { RosterMember } from "../entities";
import type { CopLayout } from "../terrain";
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
  const cs = w.terrain.cellSize;
  for (const m of w.platoon.members) {
    if (!m.alive || m.status === "wounded" || m.evac || tasked.has(m.id)) continue;
    // Invariant self-heal: a man standing INSIDE a solid cell (Structure/Hesco/wall) can
    // never move again — moveUnit refuses every micro-step out of an impassable cell, the
    // 2 s watchdog wipes his path, garrison re-issues the same line, forever (measured:
    // 938/951 out-of-contact stall-wipes on bal-2 were ONE such man; the writer that put
    // him there is dragToCover's unchecked buddy placement, combat.ts:1892 — see
    // docs/issues/032). Position in a solid cell is an invariant breach whoever writes it,
    // so the garrison, as the layer that owns placement, snaps him to the nearest
    // reachable ground once. Deterministic; a no-op every tick the invariant holds.
    if (!w.terrain.passableCell(Math.floor(m.pos.x / cs), Math.floor(m.pos.y / cs))) {
      m.pos = { ...w.terrain.reachablePoint(m.pos.x, m.pos.y) };
      m.path = [];
      m.postStuck = 0;
    }
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

  // Daytime idle LIFE: the off-duty pool doesn't stand frozen on a lattice — a couple of
  // men work the improvised gym, small conversation knots form and dissolve, and solo men
  // drift between loafing spots on a minutes-scale. All deterministic (absSeconds + id
  // hashes, zero RNG), so replays are bit-identical and nothing new is persisted.
  const idlers =
    !standTo && !mealTime && !sleepTime
      ? home.filter(
          (m) =>
            m.role !== "machinegunner" && m.role !== "medic" &&
            m.role !== "platoon_leader" && m.role !== "platoon_sergeant" &&
            m.role !== "rto" && m.role !== "jtac" &&
            !onGuard.has(m.id) && !detail.has(m.id)
        )
      : [];
  const social = planSocial(w, idlers, center, wire, cop, fps.map((f) => f.pos));

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
      let b = ((ord + 0.5) / Math.max(1, detail.size)) * Math.PI * 2;
      const wr = (cop.radius - 2) * w.terrain.cellSize;
      // never set up a work detail on top of a manned fighting position — walk the bearing
      // along the wire until the spot is clear of every FP seat (margin > the ±3 m jitter).
      for (let t = 0; t < 6; t++) {
        const cand = { x: center.x + Math.cos(b) * wr, y: center.y + Math.sin(b) * wr };
        if (fps.every((f) => dist(cand, f.pos) > 6.4)) break;
        b += 0.32;
      }
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
      // golden-angle fan, not hash jitter: consecutive ids hash to near-identical offsets,
      // which stacked the CP staff into a ~1 m pile once seats stopped quantizing to cells.
      post = fanAround(w, m, toc, 7);
      m.brainState = "toc";
    } else if (sleepTime) {
      // racked out for the night — spread along the rear billets, not piled on two doorways
      post = yardSpot(w, m, center, wire, cop.gateDir, true);
      m.brainState = "rest";
    } else {
      // off-duty: fan out across the yard (the lived-in COP), instead of stacking on the
      // barracks — with the social plan layered on top (gym pair / conversation knots /
      // drifting solo spots + varied facing) so the yard reads as men living, not tokens.
      const s = social.get(m.id);
      post = s ? s.post : yardSpot(w, m, center, wire, cop.gateDir, false);
      if (s) face = s.face;
      m.brainState = "garrison";
    }

    m.faceLock = face;
    // A post whose own cell is boxed (inside a footprint) would quantize to a cell centre in
    // the snap below — and two quantized posts collapse onto the SAME centre (the measured
    // 0.9–1.6 m piles at the TOC/chow fan). Pull it into the open first — along a PER-MAN
    // bearing (centre-ward rotated by his id hash, ±0.8 rad) so two boxed posts fan out to
    // different ground instead of converging on the same patch. Snap only if still boxed.
    if (!w.terrain.passableCell(Math.floor(post.x / cs), Math.floor(post.y / cs))) {
      const rot = ((hashId(m.id) % 100) / 100 - 0.5) * 1.6;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      for (let tries = 0; tries < 3 && !w.terrain.passableCell(Math.floor(post.x / cs), Math.floor(post.y / cs)); tries++) {
        const toC = sub(center, post);
        const dc = Math.hypot(toC.x, toC.y) || 1;
        const dx = (toC.x / dc) * cr - (toC.y / dc) * sr;
        const dy = (toC.x / dc) * sr + (toC.y / dc) * cr;
        post = { x: post.x + dx * 4.5, y: post.y + dy * 4.5 };
      }
    }
    // Keep the seat on REACHABLE ground (a jittered post can land on a solid wall/building or, with
    // the river now a real barrier, in a tiny passable pocket the man can't actually get to). Using
    // nearestReachable (not just nearestPassable) guarantees the seat is in the garrison's own
    // component, so walkTo never re-fires the heavy free A* every tick chasing an unreachable seat.
    // reachablePoint returns the CELL CENTER — when the post's own cell is already reachable keep
    // the post's sub-cell offset, or the 5 m quantization collapses a conversation knot / the
    // lattice's fine spread onto shared cell centres (men standing inside each other).
    const snap = w.terrain.reachablePoint(post.x, post.y);
    const sameCell =
      Math.floor(snap.x / cs) === Math.floor(post.x / cs) && Math.floor(snap.y / cs) === Math.floor(post.y / cs);
    const seat = sameCell ? post : snap;
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
      // Social men SETTLE onto their exact mark (a slow shuffle, ≤0.5 m/s): the mover halts
      // up to ~1.2 m off its final waypoint, which erodes a 3.4 m conversation ring back into
      // a crowd. Only inside the arrive radius, only over passable ground — reads as a man
      // adjusting his stance in the group, and keeps the knot geometry (BUNCH) honest.
      if (social.has(m.id)) {
        const d = dist(m.pos, seat);
        if (d > 0.2) {
          const st = Math.min(d, 0.5 * dt);
          const nx = m.pos.x + ((seat.x - m.pos.x) / d) * st;
          const ny = m.pos.y + ((seat.y - m.pos.y) / d) * st;
          if (w.terrain.passableCell(Math.floor(nx / cs), Math.floor(ny / cs))) m.pos = { x: nx, y: ny };
        }
      }
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

// One social "epoch": knots re-form, the gym pair rotates, solo men drift to a new loafing
// spot. Minutes-scale — long enough to read as living, short enough to see it happen.
const SOCIAL_EPOCH = 9 * 60;
// Knot/gym spacing (m). BUNCH counts a man with another within 3 m as crowding
// (scripts/scratch-cop-men.ts) — a conversation still reads at 3.4–3.5 m top-down, and a trio
// on a 2.0 m-radius circle keeps every pair at 2.0·√3 ≈ 3.5 m, so even with the mover's
// ±1.2 m waypoint-arrival slop a knot never re-creates the pile.
const KNOT_R = 2.0;
const PAIR_HALF = 1.7;

/**
 * The improvised gym corner — pure geometry from the COP layout (abeam the gate axis, pulled
 * toward the rear), shared by the sim (two men work out here) and the renderer (bench, plates
 * and a squat rack are drawn at the same anchor via the world barrel). Deterministic.
 */
export function gymSpot(cop: CopLayout, cellSize: number): Vec2 {
  const cx = (cop.center.cx + 0.5) * cellSize;
  const cy = (cop.center.cy + 0.5) * cellSize;
  const wire = cop.radius * cellSize;
  const px = -cop.gateDir.y;
  const py = cop.gateDir.x;
  return {
    x: cx + px * wire * 0.52 - cop.gateDir.x * wire * 0.12,
    y: cy + py * wire * 0.52 - cop.gateDir.y * wire * 0.12,
  };
}

/**
 * Assign the daytime off-duty pool their social posture: 2 men at the gym, ~40% of the rest
 * in 2–3-man conversation knots (walk to a buddy, face each other), the remainder solo on a
 * drifting lattice spot with varied facing. Rotates on SOCIAL_EPOCH so pairings and spots
 * change through the day. Deterministic — sorted ids + absSeconds epoch, zero RNG draws.
 */
function planSocial(
  w: World,
  idlers: RosterMember[],
  center: Vec2,
  wire: number,
  cop: CopLayout,
  fpSeats: Vec2[]
): Map<string, { post: Vec2; face: number | null }> {
  const out = new Map<string, { post: Vec2; face: number | null }>();
  if (idlers.length === 0) return out;
  const sorted = [...idlers].sort((a, b) => (a.id < b.id ? -1 : 1));
  const n = sorted.length;
  const epoch = Math.floor(w.absSeconds / SOCIAL_EPOCH);
  const pick = (i: number) => sorted[(i + epoch) % n];
  // Keep social spots viable: off the manned fighting positions (a loafer 1.5 m from a
  // sentry reads as crowding, and counts as it) AND on passable ground for the whole knot
  // ring — a member's post that lands inside a footprint snaps to a CELL CENTRE, and two
  // snapped posts collapse onto the same centre (the 0.9 m "pile" seen on bal-2). If a
  // candidate fails, pull it toward the yard centre until clear — deterministic.
  const cs = w.terrain.cellSize;
  const okPost = (p: Vec2, ringR: number): boolean => {
    for (const f of fpSeats) if (dist(p, f) < 3.6 + ringR) return false;
    for (let i = 0; i < 7; i++) {
      const q = i < 6
        ? { x: p.x + Math.cos((i * Math.PI) / 3) * ringR, y: p.y + Math.sin((i * Math.PI) / 3) * ringR }
        : p;
      if (ringR === 0 && i < 6) continue;
      if (!w.terrain.passableCell(Math.floor(q.x / cs), Math.floor(q.y / cs))) return false;
    }
    return true;
  };
  const dodge = (p: Vec2, ringR = 0): Vec2 => {
    let q = p;
    for (let tries = 0; tries < 4; tries++) {
      if (okPost(q, ringR)) return q;
      const toC = sub(center, q);
      const dc = Math.hypot(toC.x, toC.y) || 1;
      q = { x: q.x + (toC.x / dc) * 4.5, y: q.y + (toC.y / dc) * 4.5 };
    }
    return q;
  };

  let cursor = 0;
  // -- the gym pair: one on the bench, a spotter standing off it, both facing the bench.
  if (n >= 4) {
    const g = dodge(gymSpot(cop, w.terrain.cellSize), 3.8);
    const a = pick(cursor++);
    const b = pick(cursor++);
    const toCenter = angle(sub(center, g));
    out.set(a.id, { post: { x: g.x, y: g.y }, face: toCenter + 0.6 });
    out.set(b.id, {
      post: { x: g.x + Math.cos(toCenter) * 3.6, y: g.y + Math.sin(toCenter) * 3.6 },
      face: toCenter + Math.PI, // the spotter watches the lifter
    });
  }
  // -- conversation knots: ~40% of the remainder in trios (pairs on the tail). The anchor
  //    is the first member's lattice seat with CLEAR ground for the whole ring (try each
  //    member's seat in turn — the golden-angle spread keeps candidates apart, so there is
  //    no pull-toward-centre step to converge two knots onto the same patch of yard). No
  //    valid ground this epoch → the knot just doesn't form and the men loaf solo.
  const rest = n - cursor;
  let knotMen = Math.floor(rest * 0.4);
  const solos: RosterMember[] = [];
  while (knotMen >= 2) {
    const size = knotMen >= 3 && knotMen !== 4 ? 3 : 2; // avoid leaving a lone straggler
    const members: RosterMember[] = [];
    for (let i = 0; i < size; i++) members.push(pick(cursor++));
    knotMen -= size;
    let anchor: Vec2 | null = null;
    for (const mm of members) {
      const cand = yardSpot(w, mm, center, wire, cop.gateDir, false);
      if (okPost(cand, KNOT_R + 0.6)) { anchor = cand; break; }
    }
    if (!anchor) { solos.push(...members); continue; }
    if (size === 2) {
      const b = ((hashId(members[0].id) + epoch) % 360) * (Math.PI / 180);
      const off = { x: Math.cos(b) * PAIR_HALF, y: Math.sin(b) * PAIR_HALF };
      out.set(members[0].id, { post: { x: anchor.x + off.x, y: anchor.y + off.y }, face: b + Math.PI });
      out.set(members[1].id, { post: { x: anchor.x - off.x, y: anchor.y - off.y }, face: b });
    } else {
      const b0 = ((hashId(members[0].id) * 3 + epoch) % 360) * (Math.PI / 180);
      for (let i = 0; i < 3; i++) {
        const b = b0 + (i * Math.PI * 2) / 3;
        out.set(members[i].id, {
          post: { x: anchor.x + Math.cos(b) * KNOT_R, y: anchor.y + Math.sin(b) * KNOT_R },
          face: b + Math.PI, // everyone faces the middle of the knot
        });
      }
    }
  }
  // -- solo men: their stable lattice seat plus a small per-epoch drift (a man wanders a
  //    couple of metres every few minutes) and a per-epoch facing so the yard's gazes vary.
  //    Each man's epoch is phase-staggered by his id so the yard never reshuffles in lockstep.
  //    A drift that lands on bad ground retries at rotated bearings AROUND THE MAN'S OWN SEAT
  //    (never a shared pull direction), falling back to the seat itself.
  for (; cursor < n; cursor++) solos.push(pick(cursor));
  for (const m of solos) {
    const seat = yardSpot(w, m, center, wire, cop.gateDir, false);
    const h = hashId(m.id);
    const myEpoch = Math.floor((w.absSeconds + (h % SOCIAL_EPOCH)) / SOCIAL_EPOCH);
    const dr = 0.8 + ((((h >> 3) + myEpoch * 37) % 100) / 100) * 1.4; // 0.8–2.2 m
    let post = seat;
    for (let a = 0; a < 4; a++) {
      const db = ((h * 7 + myEpoch * 131) % 360) * (Math.PI / 180) + a * 1.3;
      const cand = { x: seat.x + Math.cos(db) * dr, y: seat.y + Math.sin(db) * dr };
      if (okPost(cand, 0)) { post = cand; break; }
    }
    out.set(m.id, { post, face: ((h * 13 + myEpoch * 197) % 360) * (Math.PI / 180) });
  }
  return out;
}

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
