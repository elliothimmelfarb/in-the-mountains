// scratch: capture a single-camera time-of-day SWEEP at one zoom — the dawn-money-shot strip
// (sun line walking down the west wall, ridge shadow flooding then draining off the floor).
// Real GPU (no --disable-gpu). Delete after the campaign report ships.
//   node scripts/scratch-timelapse.mjs <outdir> <ppm> [hours csv]
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const OUTDIR = process.argv[2] || "docs/progress/2026-06-12-webgl-terrain/timelapse";
const PPM = Number(process.argv[3] || 0.35);
const HOURS = (process.argv[4] || "5.5,6.5,7.5,9,12,15,17,18.5").split(",").map(Number);
mkdirSync(OUTDIR, { recursive: true });
const PORT = 9337;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-device-scale-factor=1", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-tl-profile", "--window-size=1440,900", "http://localhost:3000"], { stdio: "ignore" });
const pending = new Map();
let ws, id = 0;
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + method)); } }, 30000); });
async function cdp() { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(250); } throw new Error("no CDP"); }

const boot = `(async () => { const S=()=>window.__ITM.getState(); if(!S())return"no __ITM"; S().newCampaign("timelapse",90); let w=null; for(let i=0;i<200;i++){const st=S(); if(st.world&&window.__setCam){w=st.world;break;} await new Promise(r=>setTimeout(r,60));} if(!w)return"not ready"; const sim=w.sim; if(!S().paused)S().togglePause(); w.state.weather={label:"Clear",visibilityM:3900,wind:3,windDir:5.3,ceiling:6000,airAvailable:true,precip:false}; if(sim.weather){sim.weather.label="Clear";} const cop=w.copWorld(); window.__tl={cx:1280,cy:1280}; return JSON.stringify({cop}); })()`;
const shot = (h, cx, cy, ppm) => `(()=>{ const w=window.__ITM.getState().world; w.state.clock=${h}*3600-6*3600+86400; if(w.refreshLight)w.refreshLight(); w.sim.light=w.ambientLight(); window.__setCam(${cx},${cy},${ppm}); return JSON.stringify({ambient:+w.ambientLight().toFixed(3)}); })()`;

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await send("Page.enable"); await send("Runtime.enable");
    for (let i = 0; i < 80; i++) { const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true }); if (r.result?.value) break; await sleep(250); }
    const b = await send("Runtime.evaluate", { expression: boot, awaitPromise: true, returnByValue: true });
    console.log("boot", b.result?.value); await sleep(6000);
    const clipR = await send("Runtime.evaluate", { expression: "(()=>{const c=document.querySelector('canvas');const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,width:b.width,height:b.height,scale:1});})()", returnByValue: true });
    const clip = JSON.parse(clipR.result.value);
    for (const h of HOURS) {
      const st = await send("Runtime.evaluate", { expression: shot(h, 1280, 1280, PPM), returnByValue: true });
      await sleep(700);
      const png = await send("Page.captureScreenshot", { format: "png", clip });
      const hh = String(Math.floor(h)).padStart(2, "0") + String(Math.round((h % 1) * 60)).padStart(2, "0");
      writeFileSync(`${OUTDIR}/t${hh}.png`, Buffer.from(png.data, "base64"));
      console.log(`t${hh}`, st.result?.value);
    }
    console.log("DONE", OUTDIR);
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; } finally { chrome.kill(); }
})();
