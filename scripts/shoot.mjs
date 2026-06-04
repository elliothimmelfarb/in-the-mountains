// Headless live-screenshot harness — drives the REAL running app via the Chrome DevTools
// Protocol (zero deps; Node 22+ global fetch + WebSocket), so it never contends with the
// MCP browser. Boots a game, stages a deterministic COMBAT TABLEAU directly on the world
// (suppression, casualties, bleed, buddy-aid, an inbound fire mission, a frag arc, a blast),
// frames the camera, and captures a PNG of the live canvas with all the combat-FX cues.
//
//   node scripts/shoot.mjs [out.png] [ppm]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "docs/progress/2026-06-04-combat-visual/live-combat.png";
const PPM = Number(process.argv[3] || 2.8);
const STRESS = process.argv.includes("--stress"); // scatter many rounds for the haze + perf test
const FPS = process.argv.includes("--fps"); //        measure frame time at tactical zoom
const PORT = 9333;

// injected into the page stage: ~80 in-flight rounds + muzzles across two clusters
const STRESS_JS = STRESS ? `
  for (let i = 0; i < 80; i++) {
    const cl = i % 2 === 0 ? { x: cx - 90, y: cy - 45 } : { x: cx + 95, y: cy + 25 };
    const px = cl.x + ((i * 37) % 80) - 40, py = cl.y + ((i * 53) % 80) - 40;
    sim.projectiles.push({ indirect: false, pos: { x: px, y: py }, vel: { x: Math.cos(i) * 320, y: Math.sin(i) * 320 }, faction: i % 3 === 0 ? "us" : "insurgent", tracer: i % 4 === 0, age: 0, timeToImpact: 0, arcHeight: 0, origin: { x: px, y: py }, aimpoint: { x: px, y: py } });
    if (i % 3 === 0) sim.addEffect("muzzle", { x: px, y: py }, 0.12, { faction: i % 2 ? "us" : "insurgent", size: 1 });
  }` : "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- launch an isolated headless Chrome (separate profile → no MCP conflict) ----------
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  "--disable-gpu-vsync", "--disable-frame-rate-limit", // so rAF dt reflects real work for --fps
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-shoot-profile",
  "--window-size=1440,900", URL,
], { stdio: "ignore" });

let ws;
async function cdp() {
  // find the page target for our URL
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost:3000"));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("no page target");
}

let _id = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++_id;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("timeout " + method)), 30000); });
}

// ---- the staging script, evaluated IN the page ----------------------------------------
const STAGE = `(async () => {
  const log = [];
  const W = () => window.__ITM && window.__ITM.getState();
  // 1. boot a fresh campaign
  if (!W()) return "no __ITM";
  W().newCampaign("valley-fx-shoot", 90);
  // 2. wait for the world, the camera hook, and the sprite registry
  let ok = false;
  for (let i = 0; i < 100; i++) {
    const st = W();
    if (st.world && window.__setCam) { ok = true; break; }
    await new Promise(r => setTimeout(r, 60));
  }
  if (!ok) return "world/cam not ready";
  const w = W().world, sim = w.sim;
  const fr = sim.playerUnits();
  if (fr.length < 7) return "too few friendlies: " + fr.length;
  // 3. lay a CLEAN, spaced row of staged men on the open LZ pad so each cue reads alone
  const lz = w.terrain.cellCenter(w.terrain.cop.lz.cx, w.terrain.cop.lz.cy);
  const g = fr.slice(0, 7);
  const STEP = 12;
  const ROWY = lz.y + 30; // just SOUTH of the LZ pad so its markings don't occlude the men
  g.forEach((u, i) => { u.pos = { x: lz.x + (i - 3) * STEP, y: ROWY }; u.facing = -1.9; });
  const cx = lz.x, cy = ROWY;
  const nw = { x: -0.55, y: -0.84 }; // fire from the NW
  // 4. one cue per man, left→right:
  // s0 suppressed-but-fighting (crescent), s1 PINNED (crescent+closed ring), s2 different bearing
  g[0].suppression = 0.32; g[0].threatDir = { ...nw };
  g[1].suppression = 0.78; g[1].composure = 0.18; g[1].threatDir = { ...nw };
  g[2].suppression = 0.45; g[2].threatDir = { x: 0.9, y: -0.3 };
  // s3 casualty DOWN + arterial bleed; s4 medic treating him (buddy-aid link)
  const cas = g[3]; cas.conscious = false; cas.bleedRate = 1.5; cas.bleedTQable = 0.7; cas.hp = 18;
  const doc = g[4]; doc.brainState = "treating"; doc.targetId = cas.id;
  doc.pos = { x: cas.pos.x + 9, y: cas.pos.y - 1 };
  // s5 throws a frag (mid-arc to a point south); s6 healthy control
  try { g[5].grenades = Math.max(1, g[5].grenades || 1); sim.throwFrag(g[5], { x: g[5].pos.x + 4, y: g[5].pos.y + 30 }); } catch (e) { log.push("frag:" + e); }
  const frag = sim.projectiles.find(p => p.indirect);
  if (frag) { frag.age = 0.72; frag.timeToImpact = 0.72; }
  // 5. scene spectacle, kept OFF the soldier row: a ground-HE blast + scorch to the north,
  //    an inbound ENEMY mortar reticle to the east
  sim.addEffect("blast", { x: cx - 20, y: cy - 34 }, 0.6, { size: 1.6, faction: "insurgent" }); // mortar
  sim.addEffect("blast", { x: cx + 34, y: cy - 30 }, 0.6, { size: 2.3, faction: "insurgent", ied: true }); // IED — bigger, dirtier scar
  sim.addEffect("frag_air", { x: g[5].pos.x + 4, y: g[5].pos.y + 30 }, 1.4, {});
  // directional muzzle cones: g[6] fires EAST, g[5] fires NW — the cone shows which way
  sim.addEffect("muzzle", g[6].pos, 0.12, { faction: g[6].faction, size: 1, facing: 0 });
  sim.addEffect("muzzle", g[5].pos, 0.12, { faction: g[5].faction, size: 1.6, facing: -2.4 });
  sim.addEffect("impact", { x: g[1].pos.x - 4, y: g[1].pos.y - 6 }, 0.35, { faction: "insurgent" });
  sim.addEffect("blood", cas.pos, 0.5, { faction: cas.faction });
  sim.enemyFireMission("mortar82", { x: cx + 46, y: cy - 8 }, 6, 9);
  // a HIDDEN shooter's muzzle flash (no confirmed enemy nearby) → suspected pinpoint
  sim.addEffect("muzzle", { x: cx - 34, y: cy - 30 }, 0.12, { faction: "insurgent", size: 1 });
  for (const e of sim.effects) { if (e.kind === "blast") e.t = 0.26; if (e.kind === "impact") e.t = 0.15; if (e.kind === "frag_air") e.t = 0.3; if (e.kind === "muzzle" && e.faction === "insurgent") e.t = 0.5; }
  ${STRESS_JS}
  // 6. frame on the row
  window.__setCam(cx, cy, ${PPM});
  return "ok n=" + fr.length + " proj=" + sim.projectiles.length + " " + log.join(";");
})()`;

(async () => {
  try {
    const url = await cdp();
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    };
    await send("Page.enable");
    await send("Runtime.enable");
    // wait for the app bundle to define __ITM
    for (let i = 0; i < 80; i++) {
      const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true });
      if (r.result && r.result.value) break;
      await sleep(250);
    }
    const staged = await send("Runtime.evaluate", { expression: STAGE, awaitPromise: true, returnByValue: true });
    console.log("stage:", staged.result && staged.result.value);
    await sleep(700); // let the RAF draw the staged frame
    if (FPS) {
      const fpsR = await send("Runtime.evaluate", {
        expression: "(async()=>{let last=performance.now(),frames=0,total=0,worst=0;return await new Promise(res=>{function tick(now){const dt=now-last;last=now;if(frames>0){total+=dt;if(dt>worst)worst=dt;}if(++frames<90)requestAnimationFrame(tick);else res({avgMs:+(total/(frames-1)).toFixed(2),worstMs:+worst.toFixed(2),fps:Math.round(1000/(total/(frames-1)))});}requestAnimationFrame(tick);});})()",
        awaitPromise: true, returnByValue: true,
      });
      console.log("fps:", JSON.stringify(fpsR.result && fpsR.result.value));
    }
    // clip to the map canvas and render at 2x so the cues are legible
    const rectR = await send("Runtime.evaluate", {
      expression: "(()=>{const c=document.querySelector('canvas');const r=c.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height});})()",
      returnByValue: true,
    });
    const r = JSON.parse(rectR.result.value);
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 },
      captureBeyondViewport: true,
    });
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("wrote", OUT, `(${Math.round(r.width)}x${Math.round(r.height)} @2x)`);
  } catch (e) {
    console.error("ERROR", e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    chrome.kill("SIGKILL");
  }
})();
