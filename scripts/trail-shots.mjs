// trail-shots — live captures of the trail/road network (whole valley / trailhead fan / switchback
// zoom) at forced midday + clear weather, events auto-dismissed.
// Boots the REAL app via CDP (own headless Chrome, own profile/port — never contends with MCP),
// starts a campaign on a given seed, then frames: (1) the whole valley, (2) a village trailhead
// fan, (3) a tactical-zoom hillside with switchbacks. PNGs land in the campaign progress folder.
//   node scripts/scratch-trail-shots.mjs <seed> <outdir> [tag]
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const SEED = process.argv[2] || "korengal";
const OUTDIR = process.argv[3] || "docs/progress/2026-06-11-trail-network/shots";
const TAG = process.argv[4] || "after";
mkdirSync(OUTDIR, { recursive: true });
const PORT = Number(process.env.SHOT_CDP_PORT || 9341);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.SHOT_URL || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-trailshot-profile",
  "--window-size=1440,900", URL,
], { stdio: "ignore" });

let ws;
async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page" && t.url.startsWith(URL));
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
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("timeout " + method)), 180000); });
}

const BOOT = `(async () => {
  const W = () => window.__ITM && window.__ITM.getState();
  for (let i = 0; i < 600 && !W(); i++) await new Promise(r => setTimeout(r, 250));
  if (!W()) return "no __ITM";
  W().newCampaign(${JSON.stringify(SEED)}, 90);
  for (let i = 0; i < 100; i++) {
    if (W().world && window.__setCam) break;
    await new Promise(r => setTimeout(r, 60));
  }
  const w = W().world;
  if (!w) return "no world";
  // force midday so the terrain reads in full light (clock backs absSeconds = clock + DEPLOY_START)
  const DAY = 86400;
  w.state.clock += (12 * 3600 - (w.absSeconds % DAY) + DAY) % DAY;
  w.tick(0.1);
  // the time-jump can fire a narrative event whose modal covers the map — resolve it away
  for (let i = 0; i < 4 && w.pendingEvent; i++) {
    W().resolveEvent(w.pendingEvent.choices ? w.pendingEvent.choices[0].id : "ok");
    await new Promise(r => setTimeout(r, 150));
  }
  // force clear weather so the light level is identical across before/after captures
  if (w.state.weather) { w.state.weather.label = "Clear"; w.state.weather.precip = false; }
  w.tick(0.1);
  // pick the village with the most trail polylines nearby as the showcase trailhead
  const lines = w.terrain.trailLines.filter(l => l.kind === "trail");
  let best = w.terrain.villages[0], bestN = -1;
  for (const v of w.terrain.villages) {
    const c = w.terrain.cellCenter(v.cx, v.cy);
    const n = lines.filter(l => Math.hypot(l.pts[0].x - c.x, l.pts[0].y - c.y) < 120).length;
    if (n > bestN) { bestN = n; best = v; }
  }
  const c = w.terrain.cellCenter(best.cx, best.cy);
  // longest climbing trail near the showcase village — frame ITS midpoint, not a blind offset
  let show = null, showLen = -1;
  for (const l of lines) {
    if (Math.hypot(l.pts[0].x - c.x, l.pts[0].y - c.y) > 200) continue;
    let len = 0;
    for (let i = 1; i < l.pts.length; i++) len += Math.hypot(l.pts[i].x - l.pts[i-1].x, l.pts[i].y - l.pts[i-1].y);
    if (len > showLen) { showLen = len; show = l; }
  }
  const mid = show ? show.pts[Math.floor(show.pts.length / 2)] : { x: c.x, y: c.y - 160 };
  return JSON.stringify({ vx: c.x, vy: c.y, n: bestN, lines: lines.length, mx: mid.x, my: mid.y });
})()`;

async function shot(name) {
  await sleep(900);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUTDIR}/${TAG}-${name}.png`, Buffer.from(data, "base64"));
  console.log(`wrote ${OUTDIR}/${TAG}-${name}.png`);
}

try {
  ws = new WebSocket(await cdp());
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  await send("Runtime.enable");
  await send("Page.enable");
  const boot = await send("Runtime.evaluate", { expression: BOOT, awaitPromise: true, returnByValue: true });
  const info = JSON.parse(boot.result.value);
  console.log("boot:", boot.result.value);

  // 1. whole valley (the network as a map)
  await send("Runtime.evaluate", { expression: `window.__setCam(1280, 1280, 0.55)` });
  await shot("valley");
  // 2. village trailhead fan
  await send("Runtime.evaluate", { expression: `window.__setCam(${info.vx}, ${info.vy}, 1.6)` });
  await shot("trailhead");
  // 3. tactical zoom on the longest climbing trail's midpoint (switchback weave)
  await send("Runtime.evaluate", { expression: `window.__setCam(${info.mx}, ${info.my}, 3.2)` });
  await shot("switchbacks");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
