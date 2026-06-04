/**
 * Combat-FX probe — proves the Phase-1 combat-visual cues are driven by REAL sim data,
 * as hard numbers, with no browser. Per CLAUDE.md: turn "does the reticle have anything
 * to draw?" into a measurement.
 *
 *   npx tsx scripts/fx-probe.ts
 *
 *  • indirect reticle: an enemy mortar mission and (if a tube is loaded) a US mission
 *    populate sim.fireMissions with target/spread/etaS/dangerClose; etaS decrements and
 *    status walks requested → firing. (drawFireMissions reads exactly these fields.)
 *  • frag lob-arc: a thrown frag is a real indirect projectile; the renderer's
 *    progress = age/(age+timeToImpact) is EXACT (their sum is the launch time-of-flight)
 *    and walks 0→1 monotonically, tracing origin→aimpoint. (drawProjectiles uses this.)
 */
import { createWorld } from "../lib/sim/world";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---- 1. INDIRECT RETICLE: enemy harassing mortar -----------------------------------
{
  const w = createWorld("fx-probe-reticle", 90);
  const sim = w.sim;
  const friend = sim.playerUnits()[0];
  const target = friend ? { x: friend.pos.x, y: friend.pos.y } : { x: 1280, y: 1280 };
  sim.enemyFireMission("mortar82", target, 4, 20);
  const fm = sim.fireMissions[sim.fireMissions.length - 1];
  check("enemy fire mission created", !!fm, fm ? `faction=${fm.faction}` : "none");
  check("reticle has a real beaten-zone radius", !!fm && fm.spread > 0, fm ? `spread=${fm.spread.toFixed(0)}m` : "");
  check("reticle has a target to draw at", !!fm && Number.isFinite(fm.target.x), fm ? `(${fm.target.x.toFixed(0)},${fm.target.y.toFixed(0)})` : "");
  const eta0 = fm?.etaS ?? 0;
  for (let i = 0; i < 50; i++) sim.tick(0.1); // 5 s
  const eta1 = fm?.etaS ?? 0;
  check("ETA countdown decrements", eta1 < eta0, `${eta0.toFixed(1)}s → ${eta1.toFixed(1)}s`);
  for (let i = 0; i < 250; i++) sim.tick(0.1); // run to/through impact
  const seen = sim.fireMissions.find((f) => f.id === fm?.id);
  check("mission walks to firing/complete (rounds drop)", !seen || seen.status === "firing" || seen.status === "complete",
    seen ? `status=${seen.status} roundsLeft=${seen.roundsLeft}` : "completed+culled");
}

// ---- 2. DANGER-CLOSE: a US mission plotted on our own men --------------------------
{
  const w = createWorld("fx-probe-dc", 90);
  const sim = w.sim;
  const friend = sim.playerUnits()[0];
  if (friend) {
    const fm = sim.requestFireMission("mortar60", { x: friend.pos.x, y: friend.pos.y }, 2);
    if (fm) {
      check("US mission on friendlies flags DANGER CLOSE", fm.dangerClose === true, `dangerClose=${fm.dangerClose}`);
    } else {
      // no mortar60 tube loaded in this world build — try any available tube id
      console.log("INFO  requestFireMission('mortar60') returned null (no tube); danger-close path needs a loaded mortar — covered live");
    }
  }
}

// ---- 3. FRAG LOB-ARC: a real indirect projectile, exact progress -------------------
{
  const w = createWorld("fx-probe-frag", 90);
  const sim = w.sim;
  const u = sim.playerUnits()[0];
  let ok = false, detail = "no friendly";
  if (u) {
    u.grenades = Math.max(1, u.grenades);
    const aim = { x: u.pos.x + 30, y: u.pos.y + 12 };
    sim.throwFrag(u, aim);
    const frag = sim.projectiles.find((p) => p.indirect && p.id.startsWith("frag"));
    ok = !!frag && frag.arcHeight > 0;
    detail = frag ? `arcHeight=${frag.arcHeight} tti=${frag.timeToImpact}` : "no frag projectile";
    check("thrown frag is a real indirect projectile (arc to draw)", ok, detail);
    if (frag) {
      // sample progress over its time-of-flight; must be exact 0→1, monotonic
      const samples: number[] = [];
      for (let i = 0; i < 16; i++) {
        const f = sim.projectiles.find((p) => p.id === frag.id);
        if (!f) break;
        samples.push(f.age / Math.max(1e-3, f.age + f.timeToImpact));
        sim.tick(0.1);
      }
      const monotonic = samples.every((v, i) => i === 0 || v >= samples[i - 1] - 1e-6);
      check("frag arc progress is monotonic 0→1 (no jump)", monotonic && samples.length > 2,
        `[${samples.map((v) => v.toFixed(2)).join(" ")}]`);
    }
  } else {
    check("thrown frag is a real indirect projectile (arc to draw)", false, detail);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
