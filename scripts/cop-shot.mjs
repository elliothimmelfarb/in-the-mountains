// COP portrait harness — drives the REAL running app (dev server on :3000) via the Chrome
// DevTools Protocol on its OWN isolated Chrome (port 9334, separate profile) so it never
// contends with shoot.mjs or the MCP browser. Boots a fresh campaign, advances the world a
// few game-minutes so the garrison settles into its posts, frames the camera on the COP, and
// captures a clean PNG of the live canvas — the in-game art, not the diagnostic cell view.
//
//   node scripts/cop-shot.mjs [out.png] [ppm] [settleMinutes] [hourOfDay]
//
// ppm        pixels-per-meter zoom (default 5 — frames the whole ~120 m wire + a margin)
// settleMin  game-minutes to advance so guards man the wall and the camp lives (default 14)
// hourOfDay  optional 0-24; if given, the world clock is wound to that hour BEFORE settling
//            (use 22 for a night/atmosphere shot). Omit for the campaign's natural start time.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "docs/progress/2026-06-08-cop-overhaul/cop-live.png";
const PPM = Number(process.argv[3] || 5);
const SETTLE = Number(process.argv[4] || 14);
const HOUR = process.argv[5] !== undefined ? Number(process.argv[5]) : null;
const SEED = process.env.COP_SEED || "valley-2533";
const PORT = 9334;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/cop-shot-chrome",
  "--headless=new",
  "--hide-scrollbars",
  "--window-size=1400,1400",
  "--no-first-run",
  URL,
], { stdio: "ignore" });

async function cdp() {
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
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("timeout " + method)), 60000); });
}

const STAGE = `(async () => {
  const W = () => window.__ITM && window.__ITM.getState();
  if (!W()) return "no __ITM";
  await W().newCampaign(${JSON.stringify(SEED)}, 90);
  let ok = false;
  for (let i = 0; i < 120; i++) {
    const st = W();
    if (st.world && window.__setCam) { ok = true; break; }
    await new Promise(r => setTimeout(r, 60));
  }
  if (!ok) return "world/cam not ready";
  const w = W().world;
  // optionally jump the clock to a target hour-of-day (directly, not by simulating) BEFORE
  // settling, so the garrison then takes its routine for that hour (day posts vs night rack).
  ${HOUR !== null ? `{
    const DAY = 24 * 3600;
    let delta = ${HOUR} * 3600 - w.secondsOfDay;
    if (delta < 0) delta += DAY;
    w.state.clock += delta;
  }` : ""}
  // advance so the garrison takes its posts (guards on the wall, crews on guns, camp alive)
  const steps = Math.round(${SETTLE} * 60 / 0.1);
  for (let i = 0; i < steps; i++) w.tick(0.1);
  const cop = w.terrain.cop;
  // optional: stage an ASSAULT on the wire so the COP raises a Final Protective Fire request
  // (THE WATCH). Clone friendlies into insurgents at the wire, then tick until the FPF appears;
  // the pending fireRequest's aimpoint pulses on the canvas where the mortar will land.
  ${process.env.COP_ASSAULT ? `{
    const c = w.terrain.cellCenter(cop.center.cx, cop.center.cy);
    const wireM = cop.radius * w.terrain.cellSize;
    const tmpl = w.sim.playerUnits()[0];
    for (let i = 0; i < 6; i++) {
      const a = 1.15 + i * 0.13;
      const e = Object.assign({}, tmpl);
      e.id = "atk-" + i; e.faction = "insurgent"; e.alive = true; e.suspect = false; e.evac = false;
      e.conscious = true; e.hp = 100; e.suppression = 0; e.path = []; e.targetId = null;
      e.pos = { x: c.x + Math.cos(a) * (wireM + 42), y: c.y + Math.sin(a) * (wireM + 42) };
      e.facing = a + Math.PI;
      w.sim.units.push(e);
    }
    for (let i = 0; i < 200 && !w.state.fireRequest; i++) w.tick(0.1);
  }` : ""}
  const c = w.terrain.cellCenter(cop.center.cx, cop.center.cy);
  window.__setCam(c.x, c.y, ${PPM});
  return "ok hod=" + Math.round(w.secondsOfDay/360)/10 + "h fps=" + cop.fightingPositions.length + " blds=" + cop.buildings.length;
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
    for (let i = 0; i < 80; i++) {
      const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true });
      if (r.result && r.result.value) break;
      await sleep(250);
    }
    const staged = await send("Runtime.evaluate", { expression: STAGE, awaitPromise: true, returnByValue: true });
    console.log("stage:", staged.result && staged.result.value);
    await sleep(800); // let the RAF draw a couple of frames so animated FX settle
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
    console.log("wrote", OUT);
  } catch (e) {
    console.error("cop-shot failed:", e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    setTimeout(() => process.exit(), 200);
  }
})();
