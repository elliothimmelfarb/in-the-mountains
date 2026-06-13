// scratch-shot1 — ONE headless GL screenshot, fast, for tight shader iteration. Real GPU by
// default (the GL terrain needs it; --disable-gpu would force the 2D fallback). --webgl forces
// the portable SwiftShader path.  node scripts/scratch-shot1.mjs out.png [hour] [ppm] [cop|valley] [clear|rain|fog]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "/tmp/shot1.png";
const HOUR = Number(process.argv[3] ?? 6.25);
const PPM = Number(process.argv[4] ?? 4.6);
const AT = process.argv[5] || "cop";
const WX = process.argv[6] || "clear";
const WEBGL = process.argv.includes("--webgl");
const DSF = process.argv.includes("--dpr2") ? "2" : "1"; // --dpr2 catches HiDPI canvas-sizing bugs the dpr=1 default hides
const PORT = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 9341; // unique port → parallel captures don't collide
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", ...(WEBGL ? ["--use-angle=swiftshader"] : []),
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--force-device-scale-factor=${DSF}`, `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/itm-shot1-${PORT}`, "--window-size=1440,900", "http://localhost:3000",
], { stdio: "ignore" });

const pending = new Map();
let ws, id = 0;
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + m)); } }, 30000); });
async function cdp() { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const t = await r.json(); const p = t.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(250); } throw new Error("no CDP target"); }

const WXJS = {
  clear: `w.state.weather={label:"Clear",visibilityM:3900,wind:3,windDir:5.3,ceiling:6000,airAvailable:true,precip:false};if(sim.weather){sim.weather.label="Clear";sim.weather.windX=-2;sim.weather.windY=1;}`,
  rain: `w.state.weather={label:"Rain",visibilityM:1500,wind:7,windDir:5.3,ceiling:700,airAvailable:false,precip:true};if(sim.weather){sim.weather.label="Rain";sim.weather.windX=-6;sim.weather.windY=2;}`,
  fog: `w.state.weather={label:"Fog",visibilityM:600,wind:1,windDir:5.3,ceiling:300,airAvailable:false,precip:false};if(sim.weather){sim.weather.label="Fog";sim.weather.windX=-1;sim.weather.windY=0;}`,
}[WX];

const boot = `(async()=>{const S=()=>window.__ITM.getState();if(!S())return"no __ITM";S().newCampaign("visual-baseline",90);let w=null;for(let i=0;i<200;i++){const st=S();if(st.world&&window.__setCam){w=st.world;break;}await new Promise(r=>setTimeout(r,60));}if(!w)return"not ready";if(!S().paused)S().togglePause();const cop=w.copWorld();window.__c=cop;return JSON.stringify(cop);})()`;
const camExpr = AT === "cop" ? "window.__c" : AT.includes(",") ? `{x:${AT.split(",")[0]},y:${AT.split(",")[1]}}` : "{x:1280,y:1280}";
const shot = `(()=>{const S=()=>window.__ITM.getState();const w=S().world;const sim=w.sim;w.state.clock=${HOUR}*3600-6*3600+86400;if(w.refreshLight)w.refreshLight();sim.light=w.ambientLight();${WXJS};const c=${camExpr};window.__setCam(c.x,c.y,${PPM});return JSON.stringify({ambient:+w.ambientLight().toFixed(3),label:w.state.weather.label});})()`;

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await send("Page.enable"); await send("Runtime.enable");
    for (let i = 0; i < 80; i++) { const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true }); if (r.result?.value) break; await sleep(250); }
    console.log("boot:", (await send("Runtime.evaluate", { expression: boot, awaitPromise: true, returnByValue: true })).result?.value);
    await sleep(2500);
    console.log("shot:", (await send("Runtime.evaluate", { expression: shot, returnByValue: true })).result?.value);
    await sleep(700);
    const clip = JSON.parse((await send("Runtime.evaluate", { expression: "(()=>{const c=document.querySelector('canvas');const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,width:b.width,height:b.height});})()", returnByValue: true })).result.value);
    const png = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
    writeFileSync(OUT, Buffer.from(png.data, "base64"));
    console.log("wrote", OUT);
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} chrome.kill("SIGKILL"); }
})();
