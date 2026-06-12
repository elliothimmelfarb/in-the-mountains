// Visual-matrix capture — the canonical before/after evidence grid for visual campaigns.
// Boots ONE deterministic campaign, pins weather, then sweeps time-of-day × zoom and
// captures the live canvas at each point. Same camera, same seed, same clock values →
// pixel-comparable A/B grids across renderer rebuilds.
//
//   node scripts/visual-matrix.mjs <outdir> [--seed visual-baseline] [--webgl]
//
// Writes <outdir>/<time>-<zoom>.png (e.g. dawn-tactical.png) plus two weather variants.
// --webgl drops --disable-gpu so a WebGL terrain layer renders with real GPU rasterization.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const OUTDIR = process.argv[2];
if (!OUTDIR) { console.error("usage: node scripts/visual-matrix.mjs <outdir> [--seed s] [--webgl]"); process.exit(1); }
const SEED = process.argv.includes("--seed") ? process.argv[process.argv.indexOf("--seed") + 1] : "visual-baseline";
const WEBGL = process.argv.includes("--webgl");
mkdirSync(OUTDIR, { recursive: true });

const PORT = 9335;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", ...(WEBGL ? ["--use-angle=swiftshader"] : ["--disable-gpu"]),
  "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-vmx-profile",
  "--window-size=1440,900", URL,
], { stdio: "ignore" });

const pending = new Map();
let ws, msgId = 0;
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
  });
}
async function cdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const ts = await r.json();
      const p = ts.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP target");
}

// hour is decimal game-hours of day (e.g. 18.5 = 18:30); clock is seconds since Day-1 06:00
const CLEAR_W = `w.state.weather={label:"Clear",visibilityM:3900,wind:3,windDir:5.3,ceiling:6000,airAvailable:true,precip:false}; if(sim.weather){sim.weather.label="Clear";sim.weather.windX=-2;sim.weather.windY=1;}`;
const RAIN_W  = `w.state.weather={label:"Rain",visibilityM:1500,wind:7,windDir:5.3,ceiling:700,airAvailable:false,precip:true}; if(sim.weather){sim.weather.label="Rain";sim.weather.windX=-6;sim.weather.windY=2;}`;
const FOG_W   = `w.state.weather={label:"Fog",visibilityM:600,wind:1,windDir:5.3,ceiling:300,airAvailable:false,precip:false}; if(sim.weather){sim.weather.label="Fog";sim.weather.windX=-1;sim.weather.windY=0;}`;

const boot = `(async () => {
  const S = () => window.__ITM.getState();
  if (!S()) return "no __ITM";
  S().newCampaign(${JSON.stringify(SEED)}, 90);
  let w = null;
  for (let i = 0; i < 200; i++) { const st = S(); if (st.world && window.__setCam) { w = st.world; break; } await new Promise(r => setTimeout(r, 60)); }
  if (!w) return "not ready";
  const sim = w.sim;
  if (!S().paused) S().togglePause();
  ${CLEAR_W}
  const cop = w.copWorld();
  window.__vmx = { cop };
  return JSON.stringify({ cop, weather: w.state.weather.label });
})()`;

// each shot: set clock + weather + camera; the paused frame loop still redraws every rAF
const shot = (hour, weatherJs, cx, cy, ppm) => `(() => {
  const S = () => window.__ITM.getState(); const w = S().world; const sim = w.sim;
  w.state.clock = ${hour} * 3600 - 6 * 3600 + 86400; // day 2, so pre-06:00 hours stay positive
  if (w.refreshLight) w.refreshLight(); sim.light = w.ambientLight();
  ${weatherJs}
  window.__setCam(${cx}, ${cy}, ${ppm});
  return JSON.stringify({ ambient: +w.ambientLight().toFixed(3), label: w.state.weather.label });
})()`;

const TIMES = [
  ["dawn", 6.25],
  ["noon", 12],
  ["dusk", 18.5],
  ["night", 23],
];
// [name, ppm, camera: "cop" | "valley"]
const ZOOMS = [
  ["strategic", 0.35, "valley"],
  ["operational", 0.9, "cop"],
  ["tactical", 2.5, "cop"],
  ["close", 4.6, "cop"],
];

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await send("Page.enable"); await send("Runtime.enable");
    for (let i = 0; i < 80; i++) { const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true }); if (r.result && r.result.value) break; await sleep(250); }

    const booted = await send("Runtime.evaluate", { expression: boot, awaitPromise: true, returnByValue: true });
    console.log("boot →", booted.result && booted.result.value);
    const { cop } = JSON.parse(booted.result.value);
    await sleep(6000); // let the terrain bake/warm finish before first capture

    const clipR = await send("Runtime.evaluate", { expression: "(()=>{const c=document.querySelector('canvas');const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,width:b.width,height:b.height,scale:1});})()", returnByValue: true });
    const clip = JSON.parse(clipR.result.value);

    const capture = async (name, hour, weatherJs, cx, cy, ppm) => {
      const st = await send("Runtime.evaluate", { expression: shot(hour, weatherJs, cx, cy, ppm), returnByValue: true });
      await sleep(700); // a few frames so weather/fx phase settles
      const png = await send("Page.captureScreenshot", { format: "png", clip });
      writeFileSync(`${OUTDIR}/${name}.png`, Buffer.from(png.data, "base64"));
      console.log(name, "→", st.result && st.result.value);
    };

    const valley = { x: 1280, y: 1280 }; // world center (512 × 5 m / 2)
    for (const [tName, hour] of TIMES)
      for (const [zName, ppm, at] of ZOOMS) {
        const c = at === "cop" ? cop : valley;
        await capture(`${tName}-${zName}`, hour, CLEAR_W, c.x, c.y, ppm);
      }
    await capture("rain-noon-operational", 12, RAIN_W, cop.x, cop.y, 0.9);
    await capture("fog-dawn-operational", 6.5, FOG_W, cop.x, cop.y, 0.9);

    console.log("DONE", OUTDIR);
  } catch (e) {
    console.error("FAIL", e.message);
    process.exitCode = 1;
  } finally {
    chrome.kill();
  }
})();
