// RIGHT-PANEL STATE MATRIX — drives the live HUD through every right-column state and, for
// each, captures a 2x crop of the column AND measures every dock panel (height, content
// scrollHeight/clientHeight, whether it SCROLLS, whether it CLIPS, and wasted empty space).
// This is the deterministic oracle for "the right panel has bad UX depending on what's
// selected / collapsed" — it turns that fuzzy complaint into a per-state table + screenshots
// a fan-out can analyze.
//
//   node scripts/ux-rightpanel-matrix.mjs [outDir]   (dev server up on :3000)
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const OUTDIR = process.argv[2] || "docs/progress/2026-06-07-ui-ux-20x/rightpanel";
mkdirSync(OUTDIR, { recursive: true });
const PORT = 9342;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-rpmatrix", "--window-size=1440,900", URL,
], { stdio: "ignore" });

let ws, _id = 0; const pending = new Map();
function send(m, p = {}) { const id = ++_id; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("to " + m)), 30000); }); }
async function ev(e, awaitPromise = false) { const r = await send("Runtime.evaluate", { expression: e, awaitPromise, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result && r.result.value; }
async function cdp() { for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const t = await r.json(); const pg = t.find((x) => x.type === "page"); if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; } catch {} await sleep(300); } throw new Error("no target"); }

// in-page: measure the right column's panels
const MEASURE = `JSON.stringify((()=>{
  const col=document.querySelector('[class~="w-[344px]"]');
  if(!col) return {err:'no col'};
  const colH=Math.round(col.getBoundingClientRect().height);
  let sum=0;
  const panels=[...col.children].map(c=>{
    const head=c.querySelector('.dock-header span.stencil');
    const title=head?head.textContent.trim():(c.className.includes('overflow-y-auto')?'VILLAGE':'?');
    const ph=Math.round(c.getBoundingClientRect().height); sum+=ph;
    // body = the scroll container (the element with overflow-y-auto, or the village wrapper)
    const body=[...c.querySelectorAll('*')].find(e=>{const s=getComputedStyle(e);return s.overflowY==='auto'||s.overflowY==='scroll';});
    const sh=body?Math.round(body.scrollHeight):0, ch=body?Math.round(body.clientHeight):0;
    return {title, panelH:ph, scrollH:sh, clientH:ch, scrolls: body?(sh>ch+2):false, wasted: body?Math.max(0,ch-sh):0};
  });
  return {colH, panelsSum:sum, overflowsColumn: sum>colH+2, panels};
})())`;

async function capture(name) {
  await sleep(450);
  const meas = JSON.parse(await ev(MEASURE));
  const rj = await ev(`(()=>{const e=document.querySelector('[class~="w-[344px]"]');const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height});})()`);
  const r = JSON.parse(rj);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 }, captureBeyondViewport: true });
  writeFileSync(`${OUTDIR}/${name}.png`, Buffer.from(shot.data, "base64"));
  return { name, ...meas };
}

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(x.error.message)) : p.res(x.result); } };
    await send("Page.enable"); await send("Runtime.enable");
    await send("Page.navigate", { url: URL }); await sleep(1500);
    for (let i = 0; i < 120; i++) { if (await ev("!!(window.__ITM&&window.__ITM.getState)")) break; await sleep(300); }
    await ev(`window.__ITM.getState().newCampaign('rp-matrix',120)`, true);
    for (let i = 0; i < 120; i++) { if (await ev(`window.__ITM.getState().screen==='deploy'&&!!window.__ITM.getState().world`)) break; await sleep(120); }
    await sleep(400);

    const S = `window.__ITM.getState()`;
    const results = [];
    const reset = async () => { await ev(`(()=>{const s=${S};s.setRoster(null);s.selectVillage(null);s.setPlanning(false);['orders','taskorg','logistics'].forEach(id=>{if(s.layout.collapsed[id])s.togglePanel(id);});return 1})()`); await sleep(300); };

    // 1. no squad selected
    await reset(); await ev(`${S}.selectSquad(null)`); results.push(await capture("01-no-selection"));
    // 2. squad selected, not tasked (missions show)
    await reset(); await ev(`${S}.selectSquad(${S}.world.platoon.squads[1].id)`); results.push(await capture("02-selected-untasked"));
    // 3. planning a route (selected + planning)
    await reset(); await ev(`(()=>{const s=${S};s.selectSquad(s.world.platoon.squads[1].id);s.setPlanning(true);return 1})()`); results.push(await capture("03-planning"));
    // 4. HQ selected (5-man squad)
    await reset(); await ev(`${S}.selectSquad('hq')`); results.push(await capture("04-hq-selected"));
    // 5. village selected (VillagePanel)
    await reset(); await ev(`${S}.selectVillage(${S}.world.state.villages[0].id)`); results.push(await capture("05-village"));
    // 6. orders collapsed
    await reset(); await ev(`(()=>{const s=${S};s.selectSquad(s.world.platoon.squads[1].id);s.togglePanel('orders');return 1})()`); results.push(await capture("06-orders-collapsed"));
    // 7. taskorg collapsed
    await reset(); await ev(`(()=>{const s=${S};s.selectSquad(s.world.platoon.squads[1].id);s.togglePanel('taskorg');return 1})()`); results.push(await capture("07-taskorg-collapsed"));
    // 8. logistics collapsed
    await reset(); await ev(`(()=>{const s=${S};s.selectSquad(s.world.platoon.squads[1].id);s.togglePanel('logistics');return 1})()`); results.push(await capture("08-logistics-collapsed"));
    // 9. all collapsible collapsed
    await reset(); await ev(`(()=>{const s=${S};s.selectSquad(s.world.platoon.squads[1].id);['orders','taskorg','logistics'].forEach(id=>s.togglePanel(id));return 1})()`); results.push(await capture("09-all-collapsed"));
    // 10. short viewport (selected, untasked)
    await reset(); await ev(`${S}.selectSquad(${S}.world.platoon.squads[1].id)`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 720, deviceScaleFactor: 1, mobile: false }); await sleep(400);
    results.push(await capture("10-short-viewport"));
    await send("Emulation.clearDeviceMetricsOverride");

    writeFileSync(`${OUTDIR}/matrix.json`, JSON.stringify(results, null, 2));
    console.log("\n=== RIGHT-PANEL MATRIX ===");
    console.log("state".padEnd(22), "colH", "sum", "overflow", "scrolling-panels");
    for (const r of results) {
      const scr = (r.panels || []).filter((p) => p.scrolls).map((p) => p.title).join(",") || "—";
      const wasted = (r.panels || []).filter((p) => p.wasted > 40).map((p) => `${p.title}:${p.wasted}px`).join(",");
      console.log(r.name.padEnd(22), String(r.colH).padStart(4), String(r.panelsSum).padStart(4), String(!!r.overflowsColumn).padStart(8), scr, wasted ? "| waste: " + wasted : "");
    }
    console.log("\nwrote", OUTDIR + "/matrix.json and", results.length, "screenshots");
  } catch (e) { console.error("ERR", e.message, e.stack); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} chrome.kill("SIGKILL"); }
})();
