// Multi-scene live-capture for the 5× campaign report. Drives the REAL running app via CDP
// (its own isolated Chrome, like shoot.mjs — never contends with MCP). For each scene it boots a
// campaign, stages a deterministic tableau (night firefight / weather / COIN HUD), frames the
// camera, and writes a PNG into the campaign progress folder so the orchestrator can Read + embed.
//
//   node scripts/scene-shots.mjs            # all scenes
//   node scripts/scene-shots.mjs night      # one scene
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const ONLY = process.argv[2] || "all";
const PORT = 9334;
const OUTDIR = "docs/progress/2026-06-06-fivex-campaign/shots";
mkdirSync(OUTDIR, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-scene-profile",
  "--window-size=1440,900", URL,
], { stdio: "ignore" });

const pending = new Map();
let ws, msgId = 0;
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
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

// ---- the shared combat tableau, parameterized by clock (light) + weather ----
const stage = (clockH, weatherJs, ppm) => `(async () => {
  const S = () => window.__ITM.getState();
  if (!S()) return "no __ITM";
  S().newCampaign("fivex-scene", 90);
  let w=null; for (let i=0;i<150;i++){ const st=S(); if(st.world&&window.__setCam){w=st.world;break;} await new Promise(r=>setTimeout(r,60)); }
  if (!w) return "not ready";
  const sim=w.sim; sim.effects.length=0; sim.projectiles.length=0;
  w.state.clock = ${clockH}*3600; if (w.refreshLight) w.refreshLight(); sim.light = w.ambientLight();
  ${weatherJs}
  const lz=w.terrain.cellCenter(w.terrain.cop.lz.cx, w.terrain.cop.lz.cy);
  const fr=sim.playerUnits().slice(0,8); const STEP=13, ROWY=lz.y+24;
  fr.forEach((u,i)=>{u.pos={x:lz.x+(i-3.5)*STEP,y:ROWY};u.facing=-1.9;u.stance=i%2?"prone":"crouch";u.alive=true;u.conscious=true;});
  const cx=lz.x, cy=ROWY, nw={x:-0.55,y:-0.84};
  fr[0].suppression=0.35; fr[0].threatDir={...nw};
  fr[1].suppression=0.82; fr[1].composure=0.16; fr[1].threatDir={...nw};
  fr[2].suppression=0.5; fr[2].threatDir={x:0.9,y:-0.3};
  const cas=fr[3]; cas.conscious=false; cas.bleedRate=1.5; cas.bleedTQable=0.7; cas.hp=18;
  const doc=fr[4]; doc.brainState="treating"; doc.targetId=cas.id; doc.pos={x:cas.pos.x+9,y:cas.pos.y-1};
  sim.addEffect("muzzle", fr[0].pos, 0.12, {faction:"us",size:1,facing:-2.0});
  sim.addEffect("muzzle", fr[2].pos, 0.12, {faction:"us",size:1.6,facing:-2.3});
  sim.addEffect("muzzle", fr[6].pos, 0.12, {faction:"us",size:1,facing:-1.6});
  sim.addEffect("muzzle", {x:cx-120,y:cy-150}, 0.12, {faction:"insurgent",size:1.6,facing:0.9});
  sim.addEffect("muzzle", {x:cx-70,y:cy-175}, 0.12, {faction:"insurgent",size:1,facing:1.0});
  for (let i=0;i<12;i++){ const fe=i%2===0; const ox=fe?cx-110+i*5:cx-40+i*8, oy=fe?cy-150+i*4:cy-2;
    sim.projectiles.push({indirect:false,pos:{x:ox+i*6,y:oy+i*9},vel:{x:(fe?1:-1)*260,y:(fe?1:-1)*200},faction:fe?"insurgent":"us",tracer:true,age:0,timeToImpact:0,arcHeight:0,origin:{x:ox,y:oy},aimpoint:{x:ox,y:oy}}); }
  sim.addEffect("blast", {x:cx+50,y:cy-40}, 0.6, {size:1.9,faction:"insurgent"});
  sim.addEffect("blast", {x:cx-30,y:cy-66}, 0.6, {size:1.3,faction:"insurgent"});
  sim.enemyFireMission("mortar82", {x:cx+44,y:cy-8}, 6, 9);
  for (const e of sim.effects){ if(e.kind==="muzzle")e.t=0.03; if(e.kind==="blast")e.t=0.20; }
  if(!S().paused) S().togglePause();
  window.__setCam(cx, cy-30, ${ppm});
  return JSON.stringify({ambient:+w.ambientLight().toFixed(2), night:+(1-w.ambientLight()).toFixed(2), weather:w.state.weather.label, eff:sim.effects.length});
})()`;

// COIN HUD scene: populate strategic state so the HUD reads rich, capture FULL viewport.
const stageHud = `(async () => {
  const S = () => window.__ITM.getState();
  S().newCampaign("fivex-hud", 90);
  let w=null; for (let i=0;i<150;i++){ const st=S(); if(st.world&&window.__setCam){w=st.world;break;} await new Promise(r=>setTimeout(r,60)); }
  if (!w) return "not ready";
  w.state.clock = 8*3600; if (w.refreshLight) w.refreshLight();
  // a project under way + one complete; move attitudes; spend+regain CERP
  try { const v=w.state.villages[0]; if (w.startProject) w.startProject(v.id, "micro-hydro"); } catch(e){}
  if (w.state.projects[0]) { w.state.projects[0].stage="building"; w.state.projects[0].progress=0.55; w.state.projects[0].materialsDelivered=true; w.state.projects[0].contractorOnSite=true; }
  w.state.villages[0].attitude=42; w.state.villages[1].attitude=18; w.state.villages[2].attitude=-12;
  if (w.state.directives[0]) w.state.directives[0].progress=0.6;
  window.__setCam(w.terrain.cellCenter(w.terrain.cop.lz.cx, w.terrain.cop.lz.cy).x, w.terrain.cellCenter(w.terrain.cop.lz.cx,w.terrain.cop.lz.cy).y, 1.1);
  if(!S().paused) S().togglePause();
  return JSON.stringify({villages:w.state.villages.map(v=>v.attitude), projects:w.state.projects.length, cerp:w.state.cerp, directives:w.state.directives.length});
})()`;

const clearW = `w.state.weather={label:"Clear",visibilityM:3900,wind:3,windDir:5.3,ceiling:6000,airAvailable:true,precip:false}; if(sim.weather){sim.weather.label="Clear";sim.weather.windX=0;sim.weather.windY=0;}`;
// Strategic-zoom scene: no combat staging — just frame the COP so the platoon's squads render as
// clean per-squad NATO icons (the R2 LOD win), not a blob of giant figures. ppm 0.9 < FIG_FADE0.
const stageStrategic = `(async () => {
  const S=()=>window.__ITM.getState(); S().newCampaign("fivex-strategic",90);
  let w=null; for(let i=0;i<150;i++){const st=S(); if(st.world&&window.__setCam){w=st.world;break;} await new Promise(r=>setTimeout(r,60));}
  if(!w) return "not ready"; const sim=w.sim; w.state.clock=8*3600; if(w.refreshLight)w.refreshLight(); sim.light=w.ambientLight();
  ${clearW.replace(/w\.state/g,'w.state').replace(/sim\.weather/g,'sim.weather')}
  if(!S().paused) S().togglePause();
  const cop=w.copWorld(); window.__setCam(cop.x, cop.y, 0.9);
  return JSON.stringify({ppm:0.9, units:sim.playerUnits().length});
})()`;

const SCENES = [
  { name: "night-firefight", js: stage(16, clearW, 4.6), full: false },
  { name: "weather-rain", js: stage(8, `w.state.weather={label:"Rain",visibilityM:1500,wind:7,windDir:5.3,ceiling:700,airAvailable:false,precip:true}; if(sim.weather){sim.weather.label="Rain";sim.weather.windX=-6;sim.weather.windY=2;}`, 3.0), full: false },
  { name: "weather-fog", js: stage(8, `w.state.weather={label:"Fog",visibilityM:600,wind:1,windDir:5.3,ceiling:300,airAvailable:false,precip:false}; if(sim.weather){sim.weather.label="Fog";sim.weather.windX=-1;sim.weather.windY=0;}`, 3.0), full: false },
  { name: "combat-day", js: stage(8, clearW, 4.6), full: false },
  { name: "scale-strategic", js: stageStrategic, full: false },
  { name: "coin-hud", js: stageHud, full: true },
];

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await send("Page.enable"); await send("Runtime.enable");
    for (let i = 0; i < 80; i++) { const r = await send("Runtime.evaluate", { expression: "!!window.__ITM", returnByValue: true }); if (r.result && r.result.value) break; await sleep(250); }
    for (const sc of SCENES) {
      if (ONLY !== "all" && ONLY !== sc.name) continue;
      const staged = await send("Runtime.evaluate", { expression: sc.js, awaitPromise: true, returnByValue: true });
      console.log(sc.name, "→", staged.result && staged.result.value);
      // full-page (HUD) scenes must wait for the DEPLOYING loading overlay to finish the bake +
      // dismiss before the game HUD renders; canvas-clip scenes draw under it so 900ms is enough.
      await sleep(sc.full ? 5000 : 900);
      let clip = undefined;
      if (!sc.full) {
        let r = null;
        for (let k = 0; k < 12; k++) {
          const rr = await send("Runtime.evaluate", { expression: "(()=>{const c=document.querySelector('canvas');if(!c)return '';const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,width:b.width,height:b.height});})()", returnByValue: true });
          const v = rr.result && rr.result.value;
          if (v) { r = JSON.parse(v); break; }
          await sleep(200);
        }
        if (!r) { console.log("  WARN no canvas rect for", sc.name, "— skipping"); continue; }
        clip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 };
      }
      const shot = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: !!clip });
      const out = `${OUTDIR}/${sc.name}.png`;
      writeFileSync(out, Buffer.from(shot.data, "base64"));
      console.log("  wrote", out);
    }
  } catch (e) { console.error("ERROR", e.message); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} chrome.kill("SIGKILL"); }
})();
