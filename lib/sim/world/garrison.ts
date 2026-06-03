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
  void dt;
  const cop = w.terrain.cop;
  if (!cop) return;

  const tasked = new Set<string>();
  for (const t of w.state.tasks) for (const id of t.memberIds) tasked.add(id);

  // Who's available to move about the COP (not tasked, not down, near the wire).
  const center = w.copWorld();
  const home = w.platoon.members.filter(
    (m) => m.alive && m.status !== "wounded" && !m.evac && !tasked.has(m.id) && dist(m.pos, center) < 160
  );
  if (home.length === 0) return;

  // The COP stands to when fighters are near the wire.
  const standTo = w.sim.livingEnemies().some((e) => dist(e.pos, center) < 360);

  // Building / post lookups (world meters).
  const fps = cop.fightingPositions.map((f) => ({ pos: w.terrain.cellCenter(f.cx, f.cy), face: f.facing }));
  const at = (kind: string): Vec2 => {
    const b = cop.buildings.find((x) => x.kind === kind);
    return b ? w.terrain.cellCenter(b.cx, b.cy) : center;
  };
  const toc = at("toc");
  const aid = at("aid");
  const barracks = cop.buildings.filter((b) => b.kind === "barracks").map((b) => w.terrain.cellCenter(b.cx, b.cy));
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

  const hour = w.secondsOfDay / 3600;
  const mealTime = (hour >= 7 && hour < 8) || (hour >= 12 && hour < 13) || (hour >= 18 && hour < 19);
  const sleepTime = w.isNight();

  for (const m of home) {
    let post: Vec2;
    let face: number | null = null;

    if (standTo) {
      const fp = nearestFP(fps, m.pos);
      post = fp.pos;
      face = fp.face;
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
      face = fp.face;
      m.brainState = "guard";
    } else if (mealTime) {
      post = jit(dfac, m, 5);
      m.brainState = "chow";
    } else if (m.role === "medic") {
      post = jit(aid, m, 4);
      m.brainState = "aid";
    } else if (m.role === "platoon_leader" || m.role === "platoon_sergeant" || m.role === "rto" || m.role === "jtac") {
      post = jit(toc, m, 5);
      m.brainState = "toc";
    } else if (sleepTime && barracks.length) {
      post = jit(barracks[hashId(m.id) % barracks.length], m, 5);
      m.brainState = "rest";
    } else {
      // off-duty: knock about the yard near the barracks
      const base = barracks.length ? barracks[hashId(m.id) % barracks.length] : center;
      post = jit(base, m, 9);
      m.brainState = "garrison";
    }

    m.faceLock = face;
    if (m.path.length === 0 && dist(m.pos, post) > ARRIVE) {
      w.sim.moveTo(m, post);
    } else if (dist(m.pos, post) <= ARRIVE) {
      m.path = [];
    }
  }
}

const GUARD_ROLES = new Set(["rifleman", "team_leader", "grenadier", "saw_gunner", "auto_rifleman", "squad_leader"]);

function nearestFP(fps: { pos: Vec2; face: number }[], p: Vec2): { pos: Vec2; face: number } {
  let best = fps[0];
  let bd = Infinity;
  for (const f of fps) {
    const d = dist(f.pos, p);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best ?? { pos: p, face: 0 };
}

/** A machine-gunner's spot: his crew-served emplacement, facing outboard. */
function mgPost(w: World, m: RosterMember, center: Vec2): { pos: Vec2; face: number } {
  // Gunners were positioned on their emplacement at stand-up; hold the gun there.
  const emp = w.state.fob.emplacements
    .filter((e) => e.weaponId === "m240" || e.weaponId === "m2")
    .map((e) => w.terrain.cellCenter(e.cell.cx, e.cell.cy));
  const pos = emp.length ? emp.reduce((a, b) => (dist(b, m.pos) < dist(a, m.pos) ? b : a)) : m.pos;
  return { pos, face: angle(sub(pos, center)) };
}

function jit(p: Vec2, m: RosterMember, r: number): Vec2 {
  const h = hashId(m.id);
  return { x: p.x + (((h % 100) / 100) * 2 - 1) * r, y: p.y + ((((h / 100) | 0) % 100) / 100 * 2 - 1) * r };
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
