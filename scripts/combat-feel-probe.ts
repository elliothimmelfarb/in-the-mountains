/**
 * Combat-feel probe — metricizes the owner's four combat complaints as hard numbers,
 * headless, no browser. Per CLAUDE.md Law 1 ("no fix without a number"). This is the
 * baseline + after harness for the combat-feel overhaul (2026-06-08).
 *
 *   npx tsx scripts/combat-feel-probe.ts [seed] [seconds]
 *
 * It stages a deterministic firefight (a patrol + an ambush cell spawned in LOS) and
 * runs a 60 fps RENDER loop over the 0.1 s sim tick — exactly mirroring state/store.ts
 * frame() (accumulate _acc += realDt; tick while _acc>=SIM_DT) and the WorldView rAF —
 * so the numbers reflect what the player actually SEES, not just the sim state.
 *
 * METRICS (each maps to a verbatim owner complaint):
 *  1. BULLET SMOOTHNESS  ("bullets appear midway / don't travel / not smooth")
 *     - per-frame screen jump of a tracer (px @ a fixed zoom), verbatim vs interpolated
 *     - % of render frames a mid-flight bullet is FROZEN (same pixel as last frame)
 *     - distinct on-screen positions per bullet over its whole flight
 *  2. FX FLICKER         ("visual feedback is a little flickery")
 *     - muzzle-flash alias: distinct fade-alpha steps shown over a flash's screen life
 *       (a smooth fade shows ~N steps for N frames; a quantized one shows 1-2 => strobe)
 *  3. SUPPRESSION→FIRE   ("suppressed soldiers shouldn't be firing as much")
 *     - rounds per shooter-second bucketed by the shooter's suppression at trigger-pull
 *  4. PERSONALITY/CADENCE("explore rate of fire + personality of combatants")
 *     - burst-length distribution by faction (US disciplined vs insurgent ragged)
 *
 * The interpolated smoothness number is computed by the SAME math the render fix uses
 * (lerp(prevTickPos, curTickPos, _acc/SIM_DT)); it is the *projected* after — the real
 * renderer change is verified live. Verbatim is the true HEAD baseline.
 */
import { createWorld } from "../lib/sim/world";
import { makeInsurgent } from "../lib/sim/entities";
import { getWeapon } from "../lib/sim/weapons";
import type { World } from "../lib/sim/world";
import type { Unit } from "../lib/sim/entities";

const SEED = process.argv[2] ?? "feel-0";
const SECONDS = Number(process.argv[3] ?? 90);
const SIM_DT = 0.1;
const FPS = 60;
const PPM = 1.4; // a representative tactical zoom (figures visible); px = m * PPM

// ---- stage a deterministic firefight --------------------------------------------------
function stageFight(seed: string): World {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = 0.8;

  // push sq1 + medic out on a tactical patrol toward the nearest village
  const cop = terrain.copCell;
  const v = terrain.villages[0];
  const sq = world.platoon.squads.find((s) => s.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  world.formPatrol(
    ids,
    [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
    "presence",
    "tactical",
  );
  // march out a bit so the squad is in open ground, then drop an ambush cell in LOS
  for (let i = 0; i < 400; i++) world.tick(SIM_DT); // 40 s of movement
  const c = world.activePatrolCentroid() ?? terrain.cellCenter(cop.cx, cop.cy);
  const erng = world.rng.fork("probe-ambush");
  const N = 10; // a sustained two-way fight so suppression actually builds on both sides
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const rad = 180 + erng.range(0, 110); // 180-290 m: rounds reach, but not instant overmatch
    const pos = { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad };
    const cell = terrain.nearestPassable(Math.floor(pos.x / terrain.cellSize), Math.floor(pos.y / terrain.cellSize));
    const wp = terrain.cellCenter(cell.cx, cell.cy);
    const role = i === 0 ? "commander" : i === 1 ? "mg_gunner" : "fighter";
    const e = makeInsurgent(erng.fork(`amb-${i}`), role, wp, 0.85);
    e.brainState = "engage";
    e.rof = "free";
    sim.addUnit(e);
  }
  return world;
}

// ---- run the render loop over the sim, capturing per-frame data ------------------------
interface FrameProjRec { id: string; pos: { x: number; y: number }; tickIdx: number; alpha: number }
// Track EVERY muzzle effect the renderer ever samples (not just drawable ones), so we can
// report what fraction ever reach a drawable frame (k<=0.6 in draw.ts) and the fade alias.
interface MuzzleRec { id: number; minK: number; drawableFrames: number; drawableInterp: number; alphaSteps: Set<number>; interpSteps: Set<number>; frames: number }

const world = stageFight(SEED);
const { sim } = world;

// per-projectile streams of {pos, tickIdx, alpha} across render frames
const projFrames = new Map<string, FrameProjRec[]>();
const projMeta = new Map<string, { speed: number; faction: string; tracer: boolean }>();
// per-muzzle-effect alias tracking (keyed by effect id)
const muzzleRecs = new Map<number, MuzzleRec>();

// fire-volume vs suppression: rounds + shooter-opportunities by suppression bucket & faction
const BUCKETS = [0, 0.15, 0.35, 0.55, 0.75, 1.01]; // [0-.15),[.15-.35),...
function bucketOf(s: number): number {
  for (let i = 0; i < BUCKETS.length - 1; i++) if (s < BUCKETS[i + 1]) return i;
  return BUCKETS.length - 2;
}
const roundsByBucket: Record<string, number[]> = { us: Array(BUCKETS.length - 1).fill(0), insurgent: Array(BUCKETS.length - 1).fill(0) };
const shooterTicksByBucket: Record<string, number[]> = { us: Array(BUCKETS.length - 1).fill(0), insurgent: Array(BUCKETS.length - 1).fill(0) };

// burst length by faction, and (to isolate PERSONALITY from weapon mix) by rifle/carbine only
const burstLens: Record<string, number[]> = { us: [], insurgent: [] };
const burstLensRifle: Record<string, number[]> = { us: [], insurgent: [] };
const roundsThisBurst = new Map<string, number>();
const burstWeaponCls = new Map<string, string>(); // unit -> weapon cls at burst start
// tracer ratio by faction/class: total rounds vs tracer rounds
const tracerTally = new Map<string, { total: number; tracer: number }>();
const RIFLE_CLS = new Set(["rifle", "carbine"]);

let _acc = 0;
let tickIdx = 0;
const realDt = 1 / FPS;
const totalFrames = SECONDS * FPS;
const projIdsSeen = new Set<string>();

for (let f = 0; f < totalFrames; f++) {
  _acc += realDt; // 1× real time (combat clamp); effSpeed = 1
  // run sim ticks for this frame, instrumenting each tick
  while (_acc >= SIM_DT) {
    const beforeIds = new Set(sim.projectiles.map((p) => p.id));
    const firedThisTick = new Map<string, number>();
    world.tick(SIM_DT);
    tickIdx++;
    // new projectiles => rounds fired this tick
    for (const p of sim.projectiles) {
      if (!beforeIds.has(p.id)) {
        const owner = sim.unit(p.ownerId);
        if (owner) {
          const fac = owner.faction === "us" || owner.faction === "ana" ? "us" : owner.faction === "insurgent" ? "insurgent" : null;
          if (fac) {
            roundsByBucket[fac][bucketOf(owner.suppression)]++;
            firedThisTick.set(owner.id, (firedThisTick.get(owner.id) ?? 0) + 1);
            roundsThisBurst.set(owner.id, (roundsThisBurst.get(owner.id) ?? 0) + 1);
            const cls = getWeapon(p.weaponId).cls;
            if (!burstWeaponCls.has(owner.id)) burstWeaponCls.set(owner.id, cls);
            const tk = `${fac}:${cls}`;
            const tt = tracerTally.get(tk) ?? { total: 0, tracer: 0 };
            tt.total++; if (p.tracer) tt.tracer++;
            tracerTally.set(tk, tt);
          }
        }
        projMeta.set(p.id, { speed: p.speed, faction: p.faction, tracer: p.tracer });
      }
    }
    // shooter-opportunities + burst closing
    for (const u of sim.units) {
      const fac = u.faction === "us" || u.faction === "ana" ? "us" : u.faction === "insurgent" ? "insurgent" : null;
      if (!fac || !u.alive || !u.conscious) continue;
      const engaged = !!u.targetId || u.suppression > 0.05 || u.rof === "suppress";
      if (engaged) shooterTicksByBucket[fac][bucketOf(u.suppression)]++;
      // close a burst: had rounds, didn't fire this tick, and burst is empty
      const rb = roundsThisBurst.get(u.id) ?? 0;
      if (rb > 0 && !firedThisTick.has(u.id) && u.burstLeft === 0) {
        burstLens[fac].push(rb);
        if (RIFLE_CLS.has(burstWeaponCls.get(u.id) ?? "")) burstLensRifle[fac].push(rb);
        roundsThisBurst.set(u.id, 0);
        burstWeaponCls.delete(u.id);
      }
    }
    _acc -= SIM_DT;
  }
  const alpha = _acc / SIM_DT;

  // capture what the renderer would draw this frame
  for (const p of sim.projectiles) {
    if (p.indirect) continue;
    projIdsSeen.add(p.id);
    let arr = projFrames.get(p.id);
    if (!arr) { arr = []; projFrames.set(p.id, arr); }
    arr.push({ id: p.id, pos: { x: p.pos.x, y: p.pos.y }, tickIdx, alpha });
  }
  // muzzle flash: draw.ts draws the daytime flash ONLY while k=e.t/ttl <= 0.6, fading on
  // f=1-k/0.6. Track every muzzle the renderer samples + whether it ever reaches a drawable frame.
  for (const e of sim.effects) {
    if (e.kind !== "muzzle") continue;
    const k = e.t / e.ttl;
    // AFTER fix #1: the renderer reads age one tick behind, interpolated by frac (=alpha):
    const kInterp = Math.max(0, (e.t - SIM_DT * (1 - alpha)) / e.ttl);
    let rec = muzzleRecs.get(e.id);
    if (!rec) { rec = { id: e.id, minK: k, drawableFrames: 0, drawableInterp: 0, alphaSteps: new Set(), interpSteps: new Set(), frames: 0 }; muzzleRecs.set(e.id, rec); }
    rec.frames++;
    rec.minK = Math.min(rec.minK, k);
    if (k <= 0.6) {
      rec.drawableFrames++;
      rec.alphaSteps.add(Math.round((1 - k / 0.6) * 100) / 100); // distinct fade alpha at 0.01 resolution
    }
    if (kInterp <= 0.6) {
      rec.drawableInterp++;
      rec.interpSteps.add(Math.round((1 - kInterp / 0.6) * 100) / 100);
    }
  }
}

// ---- analyze projectile smoothness ----------------------------------------------------
// For each projectile, reconstruct the sequence of distinct TICK positions, then compute
// the drawn-position stream two ways: verbatim (p.pos) and interpolated (lerp prev->cur).
function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function d(a: { x: number; y: number }, b: { x: number; y: number }) { return Math.hypot(a.x - b.x, a.y - b.y); }

const verbatimMaxJump: number[] = [];
const interpMaxJump: number[] = [];
const verbatimDistinct: number[] = [];
const verbatimFrozenFrac: number[] = [];

for (const [id, frames] of projFrames) {
  if (frames.length < 2) continue;
  // tick positions: pos as of each tickIdx (constant within a tickIdx)
  const tickPos = new Map<number, { x: number; y: number }>();
  for (const fr of frames) if (!tickPos.has(fr.tickIdx)) tickPos.set(fr.tickIdx, fr.pos);
  const origin = frames[0].pos; // first observed (close to muzzle)

  // verbatim drawn stream = pos each frame
  let vbMax = 0, frozen = 0, transitions = 0;
  for (let i = 1; i < frames.length; i++) {
    const jump = d(frames[i].pos, frames[i - 1].pos);
    vbMax = Math.max(vbMax, jump);
    transitions++;
    if (jump < 0.05) frozen++;
  }
  verbatimMaxJump.push(vbMax * PPM);
  verbatimDistinct.push(tickPos.size);
  verbatimFrozenFrac.push(transitions ? frozen / transitions : 0);

  // interpolated drawn stream = lerp(tickPos[k-1], tickPos[k], alpha) during tickIdx=k frames
  let ipMax = 0;
  let prevDrawn: { x: number; y: number } | null = null;
  for (const fr of frames) {
    const cur = tickPos.get(fr.tickIdx)!;
    const prev = tickPos.get(fr.tickIdx - 1) ?? origin;
    const drawn = lerp(prev, cur, fr.alpha);
    if (prevDrawn) ipMax = Math.max(ipMax, d(drawn, prevDrawn) * PPM);
    prevDrawn = drawn;
  }
  interpMaxJump.push(ipMax);
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ---- report ---------------------------------------------------------------------------
console.log(`\n=== COMBAT-FEEL PROBE — seed=${SEED} · ${SECONDS}s @ ${FPS}fps · zoom ${PPM}px/m ===`);
console.log(`firefight: ${projIdsSeen.size} direct rounds fired · ${muzzleRecs.size} muzzle flashes · ${sim.livingEnemies().length} enemies left`);

console.log(`\n[1] BULLET SMOOTHNESS  (owner: "bullets appear midway / don't travel / not smooth")`);
console.log(`    tracers analyzed: ${verbatimMaxJump.length}`);
console.log(`    per-frame screen JUMP  (px)   verbatim  median ${pct(verbatimMaxJump, 0.5).toFixed(1)}  p95 ${pct(verbatimMaxJump, 0.95).toFixed(1)}  max ${Math.max(0, ...verbatimMaxJump).toFixed(1)}`);
console.log(`                                  interp    median ${pct(interpMaxJump, 0.5).toFixed(1)}  p95 ${pct(interpMaxJump, 0.95).toFixed(1)}  max ${Math.max(0, ...interpMaxJump).toFixed(1)}`);
console.log(`    FROZEN frames (bullet stuck)  verbatim  ${(mean(verbatimFrozenFrac) * 100).toFixed(0)}%   (interp: ~0% by construction — continuous lerp)`);
console.log(`    distinct on-screen positions per bullet (whole flight)  verbatim  ${mean(verbatimDistinct).toFixed(1)}   (interp: = frames alive, smooth)`);

console.log(`\n[2] FX FLICKER  (owner: "visual feedback is a little flickery")`);
const allMuzzles = [...muzzleRecs.values()];
const everDrawable = allMuzzles.filter((r) => r.drawableFrames > 0);
const everDrawableInterp = allMuzzles.filter((r) => r.drawableInterp > 0);
const interpFrames = everDrawableInterp.map((r) => r.drawableInterp);
const interpStepsArr = everDrawableInterp.map((r) => r.interpSteps.size);
console.log(`    muzzle flashes sampled by the renderer: ${allMuzzles.length}`);
console.log(`    VERBATIM (HEAD):  ever reach a drawable frame (k≤0.6): ${everDrawable.length}/${allMuzzles.length}  ${allMuzzles.length ? "(" + ((everDrawable.length / allMuzzles.length) * 100).toFixed(0) + "%)" : ""}  · min k seen mean ${mean(allMuzzles.map((r) => r.minK)).toFixed(2)} (0.83 = born past the cutoff = INVISIBLE)`);
console.log(`    INTERP  (fix#1):  ever reach a drawable frame: ${everDrawableInterp.length}/${allMuzzles.length}  ${allMuzzles.length ? "(" + ((everDrawableInterp.length / allMuzzles.length) * 100).toFixed(0) + "%)" : ""}  · mean ${mean(interpFrames).toFixed(1)} frames on screen · mean ${mean(interpStepsArr).toFixed(1)} distinct fade steps (smooth, not strobe)`);

console.log(`\n[3] SUPPRESSION → VOLUME OF FIRE  (owner: "suppressed soldiers shouldn't be firing as much")`);
console.log(`    rounds per shooter-second, by shooter suppression at trigger-pull:`);
for (const fac of ["us", "insurgent"]) {
  const parts: string[] = [];
  for (let b = 0; b < BUCKETS.length - 1; b++) {
    const rounds = roundsByBucket[fac][b];
    const ticks = shooterTicksByBucket[fac][b];
    const rps = ticks ? (rounds / (ticks * SIM_DT)) : 0;
    const label = `${BUCKETS[b].toFixed(2)}-${BUCKETS[b + 1] >= 1 ? "1.0" : BUCKETS[b + 1].toFixed(2)}`;
    parts.push(`${label}:${rps.toFixed(2)}${ticks ? "" : "·"}`);
  }
  console.log(`      ${fac.toUpperCase().padEnd(10)} ${parts.join("  ")}`);
}
console.log(`      (each cell = rounds/shooter/sec; · = no shooter-ticks observed in that bucket.`);
console.log(`       FLAT across buckets = suppression does NOT throttle fire (the bug). Should DECLINE rightward.)`);

console.log(`\n[4] BURST LENGTH BY FACTION  (owner: "rate of fire + personality of combatants")`);
console.log(`    all weapons (mixed classes — SAW/PKM bands swamp the personality signal):`);
for (const fac of ["us", "insurgent"]) {
  const b = burstLens[fac];
  console.log(`      ${fac.toUpperCase().padEnd(10)} bursts:${b.length}  mean ${mean(b).toFixed(2)}  p10 ${pct(b, 0.1).toFixed(0)}  p90 ${pct(b, 0.9).toFixed(0)}  max ${Math.max(0, ...b)}`);
}
console.log(`    rifles/carbines ONLY (isolates discipline — US M4/M16 vs insurgent AKM):`);
for (const fac of ["us", "insurgent"]) {
  const b = burstLensRifle[fac];
  console.log(`      ${fac.toUpperCase().padEnd(10)} bursts:${b.length}  mean ${mean(b).toFixed(2)}  p10 ${pct(b, 0.1).toFixed(0)}  p90 ${pct(b, 0.9).toFixed(0)}`);
}
console.log(`      (personality: US should run TIGHTER/shorter controlled bursts than ragged insurgent fire.)`);

console.log(`\n[5] TRACER RATIO BY WEAPON CLASS  (owner: "cluttered" / tracers should read on the guns)`);
const tkeys = [...tracerTally.keys()].sort();
for (const k of tkeys) {
  const t = tracerTally.get(k)!;
  console.log(`      ${k.padEnd(18)} ${((t.tracer / Math.max(1, t.total)) * 100).toFixed(0).padStart(3)}% tracer  (${t.tracer}/${t.total})`);
}
console.log(`      (belt-fed lmg/mmg/hmg ~24% (4:1 belt); rifle/carbine ~3-8% — tracers concentrate on the guns.)`);

// ---- CONTROLLED micro-probe: isolate ONE variable at a time -----------------------------
// The firefight above is realistic but noisy. These hold everything else fixed.
runMicroProbes();
console.log("");

function runMicroProbes() {
  // (A) SUPPRESSION -> ROF: one US rifleman vs a passive dummy at 160 m; sweep fixed suppression.
  console.log(`\n[micro-A] SUPPRESSION -> rate of fire — one M4 rifleman, fixed suppression, 40 s each:`);
  const levels = [0, 0.2, 0.4, 0.6, 0.8];
  const out: string[] = [];
  for (const s of levels) {
    const rps = measureShooterRPS(s);
    out.push(`supp ${s.toFixed(1)} → ${rps.toFixed(2)} rds/s`);
  }
  console.log(`      ${out.join("   ")}`);
  console.log(`      (HEAD: ~flat. AFTER: monotonic decline — a suppressed man services his weapon less.)`);

  // (B) PERSONALITY -> burst length — disciplined (composure .85/aggr .25) vs ragged (.45/.85),
  // SAME M4, zero suppression, 60 s each. Isolates trait shaping from weapon + suppression.
  console.log(`\n[micro-B] PERSONALITY -> burst length — same M4, zero suppression, 60 s each:`);
  const disc = measureBursts(0.85, 0.25);
  const ragg = measureBursts(0.45, 0.85);
  console.log(`      disciplined (composure .85 / aggr .25): mean burst ${mean(disc).toFixed(2)}  (n=${disc.length})`);
  console.log(`      ragged      (composure .45 / aggr .85): mean burst ${mean(ragg).toFixed(2)}  (n=${ragg.length})`);
  console.log(`      (HEAD: identical — burst is weapon-only. AFTER: disciplined squeezes toward bmin=3, ragged toward bmax=6.)`);
}

// Drive ONLY the firing cadence (sim.updateFiring) with the timers decayed by hand — no
// perception, no brain, no movement — so the measurement isolates the updateFiring gate itself
// (suppression / personality), free of AI-suppressed-behaviour and target-reacquire noise.
function fireStep(sim: World["sim"], u: Unit, dt: number, target: Unit): number {
  u.targetId = target.id;
  u.fireCooldown = Math.max(0, u.fireCooldown - dt);
  u.roundTimer = Math.max(0, u.roundTimer - dt);
  u.reloading = Math.max(0, u.reloading - dt);
  const before = sim.projectiles.length;
  sim.updateFiring(u, dt);
  const n = sim.projectiles.length - before;
  sim.projectiles.length = 0; // we don't simulate flight here
  u.ammo = 600; u.reserveAmmo = 600; // never reload / black-out
  return n;
}

/** One US M4 shooter holding fire on a fixed target at `supp` suppression; return rounds/sec. */
function measureShooterRPS(supp: number): number {
  const w = createWorld(`micro-supp-${supp}`, 90);
  const { shooter, dummy } = duel(w);
  let rounds = 0;
  for (let t = 0; t < 400; t++) {
    shooter.suppression = supp;
    shooter.composure = 0.7; // hold composure fixed so only suppression varies
    rounds += fireStep(w.sim, shooter, 0.1, dummy);
  }
  return rounds / 40;
}

/** Same shooter, trait-controlled, zero suppression; return burst-length samples. */
function measureBursts(composure: number, aggression: number): number[] {
  const w = createWorld(`micro-pers-${composure}-${aggression}`, 90);
  const { shooter, dummy } = duel(w);
  shooter.aggression = aggression;
  const lens: number[] = [];
  let cur = 0;
  for (let t = 0; t < 600; t++) {
    shooter.suppression = 0;
    shooter.composure = composure;
    const fired = fireStep(w.sim, shooter, 0.1, dummy);
    if (fired > 0) cur += fired;
    else if (cur > 0 && shooter.burstLeft === 0) { lens.push(cur); cur = 0; }
  }
  return lens;
}

/** A lone US M4 shooter + a stationary enemy in clear LOS at ~150 m. */
function duel(w: World): { shooter: Unit; dummy: Unit } {
  const { terrain, sim } = w;
  const cop = terrain.cellCenter(terrain.copCell.cx, terrain.copCell.cy);
  const sp = terrain.reachablePoint(cop.x + 60, cop.y);
  const shooter = sim.playerUnits().find((u) => u.weaponId === "m4") ?? sim.playerUnits()[0];
  shooter.pos = { ...sp }; shooter.path = []; shooter.pathGoal = null; shooter.stance = "prone";
  shooter.rof = "free"; shooter.ammo = 600; shooter.reserveAmmo = 600; shooter.aimProgress = 1;
  // place the dummy where LOS is actually clear (scan a few bearings/ranges)
  let dummy: Unit | null = null;
  for (const r of [150, 120, 100, 180, 90]) {
    for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4]) {
      const ep = terrain.reachablePoint(sp.x + Math.cos(a) * r, sp.y + Math.sin(a) * r);
      const e = makeInsurgent(w.rng.fork(`duel-${r}-${a}`), "fighter", ep, 0.5);
      e.stance = "stand"; e.hp = 9999;
      if (sim.los(shooter, e).visible) { sim.addUnit(e); dummy = e; break; }
    }
    if (dummy) break;
  }
  if (!dummy) { // fallback: drop one in and use it regardless
    const e = makeInsurgent(w.rng.fork("duel-fallback"), "fighter", terrain.reachablePoint(sp.x + 120, sp.y), 0.5);
    e.hp = 9999; sim.addUnit(e); dummy = e;
  }
  return { shooter, dummy };
}
