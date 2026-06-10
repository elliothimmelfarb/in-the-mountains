/**
 * cover-directional-probe — issue 020 (the deferred HEAVY half): is a soldier actually COVERED when he
 * is behind THIS rock from THAT threat bearing, and does POSTURE change it?
 *
 * The 2026-06-09 pass shipped the cover OBJECT layer (terrain.coverObjects, drawn=sim) but left combat
 * cover reading the 5 m averaged scalar — so the firefight ignores the rock the man is tucked behind.
 * This probe is the mover-faithful oracle for the directional fix: for many cover objects on OPEN ground,
 * it places a target tucked just behind the object and a shooter on the far (threat) side — the round must
 * pass THROUGH the object to hit — and measures los().exposure. It also measures:
 *   - openCtrl : the same target with NO object on the line (open ground control)
 *   - flank    : a shooter 90 deg off the cover bearing (the object should NOT help — directionality)
 *   - prone vs stand: posture must change the behind-object number (a low wall covers a prone man more)
 *
 * On HEAD (before the fix) behind ~= open ~= flank (the object is invisible to combat) — that IS the bug.
 * After the directional fix: behind << open, behind << flank (directional), and prone < stand behind a
 * low object. The DoD (issue 020): behind-object exposure <= 0.20, open >= 0.80, posture changes it.
 *
 * Run: npx tsx scripts/cover-directional-probe.ts [N]
 */
import { createWorld } from "../lib/sim/world";
import { lineOfSight as los } from "../lib/sim/los";
import { Land } from "../lib/sim/terrain";

const N = Number(process.argv[2] ?? 6);
const SEEDS = Array.from({ length: N }, (_, i) => `survey-${i}`);

// Sample positions just behind a cover object relative to a threat bearing, and measure exposure.
function run(seed: string) {
  const world = createWorld(seed, 90);
  const t = world.terrain;
  const objs = t.coverObjects;
  // open-ground objects only (the cover the owner wants usable); skip rocky-cell objects so the 5 m
  // raster isn't already doing the work — isolate the OBJECT's directional contribution.
  const openObj = objs.filter((o) => {
    const l = t.landAt(o.x, o.y) as Land;
    return l === Land.Grass || l === Land.Meadow || l === Land.Scrub || l === Land.Terrace;
  });
  let nBehind = 0, behindSum = 0, openSum = 0, flankSum = 0, proneSum = 0, standSum = 0;
  const step = 80; // subsample for speed
  for (let i = 0; i < openObj.length; i += step) {
    const o = openObj[i];
    // a deterministic threat bearing from the object's stable rotation
    const th = o.rot;
    const ux = Math.cos(th), uy = Math.sin(th);
    const standoff = 1.2; // target tucked just behind the object (m)
    const tgt = { x: o.x - ux * standoff, y: o.y - uy * standoff };
    const shooter = { x: o.x + ux * 40, y: o.y + uy * 40 }; // 40 m out on the threat side (through the object)
    if (!t.inBounds(Math.floor(tgt.x / t.cellSize), Math.floor(tgt.y / t.cellSize))) continue;
    if (!t.passableCell(Math.floor(tgt.x / t.cellSize), Math.floor(tgt.y / t.cellSize))) continue;
    nBehind++;
    // behind the object, standing
    behindSum += los(t, shooter, tgt, { targetHeight: 1.0 }).exposure;
    // standing vs prone behind the object (posture)
    standSum += los(t, shooter, tgt, { targetHeight: 1.6 }).exposure;
    proneSum += los(t, shooter, tgt, { targetHeight: 0.5 }).exposure;
    // open control: same target+shooter geometry but offset off any object (open ground 25 m to the side)
    const offx = -uy * 25, offy = ux * 25;
    const oc = { x: tgt.x + offx, y: tgt.y + offy };
    const os = { x: shooter.x + offx, y: shooter.y + offy };
    openSum += los(t, os, oc, { targetHeight: 1.0 }).exposure;
    // flank: shooter 90 deg off the cover bearing — object should NOT help (directionality)
    const fs = { x: o.x + -uy * 40, y: o.y + ux * 40 };
    flankSum += los(t, fs, tgt, { targetHeight: 1.0 }).exposure;
  }
  const d = Math.max(1, nBehind);
  return {
    seed, n: nBehind,
    behind: behindSum / d, open: openSum / d, flank: flankSum / d,
    stand: standSum / d, prone: proneSum / d,
  };
}

console.log("seed         |   n  | behind | open  | flank | stand | prone  (exposure 0..1; lower=more covered)");
console.log("-------------|------|--------|-------|-------|-------|------");
const rows: ReturnType<typeof run>[] = [];
for (const s of SEEDS) {
  const r = run(s);
  rows.push(r);
  console.log(
    `${r.seed.padEnd(12)} | ${String(r.n).padStart(4)} | ${r.behind.toFixed(3)}  | ${r.open.toFixed(3)} | ${r.flank.toFixed(3)} | ${r.stand.toFixed(3)} | ${r.prone.toFixed(3)}`
  );
}
const avg = (k: "behind" | "open" | "flank" | "stand" | "prone") => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
console.log("-------------|------|--------|-------|-------|-------|------");
console.log(`MEAN behind ${avg("behind").toFixed(3)} · open ${avg("open").toFixed(3)} · flank ${avg("flank").toFixed(3)} · stand ${avg("stand").toFixed(3)} · prone ${avg("prone").toFixed(3)}`);
console.log(`DoD (issue 020): behind ≤ 0.20, open ≥ 0.80, behind << flank (directional), prone < stand (posture)`);
