// World-scale realism probe — metricizes "the soldiers/COP/villages look the wrong size."
// Drives the REAL running app (dev server on :3000) via its own headless Chrome over CDP
// (separate profile/port → never contends with MCP-Playwright or shoot.mjs). Boots a
// deterministic campaign, reads live world geometry from window.__ITM, and applies the
// renderer's EXACT clamp formulas (figurePx=clamp(ppm*7,15,40), dotR=clamp(0.95*ppm,4.5,13))
// to compute, per zoom: figure ground-width (m), oversize-vs-real factor, soldier-as-%-of-COP,
// and whether a 9-man squad at 5.5 m dispersion overlaps into a blob. Also captures framings.
// Use to BASELINE the scale problem and to VERIFY a render fix (see the world-scale AGENT-BRIEF).
//
//   node scripts/scale-probe.mjs [seed]
//
// Outputs: docs/progress/2026-06-06-world-scale-realism/scale-measurements.json + shots/*.png
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SEED = process.argv[2] || "korengal";
const OUTDIR = "docs/progress/2026-06-06-world-scale-realism";
const PORT = 9334;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const VW = 1440, VH = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-scale-profile",
  `--window-size=${VW},${VH}`, URL,
], { stdio: "ignore" });

async function cdp() {
  for (let i = 0; i < 80; i++) {
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
let ws, _id = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++_id;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("timeout " + method)), 30000); });
}
async function ev(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result && r.result.value;
}
async function shot(name) {
  const rectJson = await ev("(()=>{const c=document.querySelector('canvas');const r=c.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height});})()");
  const r = JSON.parse(rectJson);
  const png = await send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }, captureBeyondViewport: true });
  writeFileSync(`${OUTDIR}/shots/${name}.png`, Buffer.from(png.data, "base64"));
  console.log("shot:", name);
}

// ---------- the render clamp formulas, copied verbatim from lib/render/draw.ts ----------
// AFTER the R1 fix: figure tracks a 1.6 m footprint with a small 7 px legibility floor / 26 px
// cap (was clamp(ppm*7,15,40)); NATO dot floor dropped to 3 px / cap 9 (was 4.5/13).
const figurePx = (ppm) => Math.max(7, Math.min(26, ppm * 1.6));
const dotR = (ppm) => Math.max(3, Math.min(9, 0.7 * ppm));
// Below FIG_FADE0 a squad is ONE icon (R2), so individuals don't overlap there at all; the
// squadFiguresOverlap metric below is only MEANINGFUL at/above tactical zoom where men resolve.
const FIG_FADE0 = 2.5;

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
    for (let i = 0; i < 80; i++) { if (await ev("!!window.__ITM")) break; await sleep(250); }

    // boot deterministic campaign
    const boot = await ev(`(async()=>{const W=()=>window.__ITM&&window.__ITM.getState();W().newCampaign(${JSON.stringify(SEED)},90);for(let i=0;i<150;i++){const st=W();if(st.world&&window.__setCam)return "ok";await new Promise(r=>setTimeout(r,60));}return "timeout";})()`, true);
    console.log("boot:", boot);
    await sleep(400);

    // read live world geometry
    const geomJson = await ev(`(()=>{
      const w=window.__ITM.getState().world, t=w.terrain, sim=w.sim;
      const cs=t.cellSize;
      const cc=(cx,cy)=>t.cellCenter(cx,cy);
      const copC=cc(t.cop.center.cx,t.cop.center.cy);
      const vills=t.villages.map(v=>{const p=cc(v.cx,v.cy);return {name:v.name,cx:v.cx,cy:v.cy,sizeCells:v.size,radiusM:v.size*cs,population:v.population,x:p.x,y:p.y};});
      const soldiers=sim.playerUnits().map(u=>({x:u.pos.x,y:u.pos.y,squad:(u.squadId||u.squad),role:u.role,id:u.id}));
      // COP -> nearest village distances
      const copVillDist=vills.map(v=>({name:v.name,m:Math.round(Math.hypot(v.x-copC.x,v.y-copC.y))})).sort((a,b)=>a.m-b.m);
      // village-village min/max
      let vvmin=1e9,vvmax=0;for(let i=0;i<vills.length;i++)for(let j=i+1;j<vills.length;j++){const d=Math.hypot(vills[i].x-vills[j].x,vills[i].y-vills[j].y);if(d<vvmin)vvmin=d;if(d>vvmax)vvmax=d;}
      // garrison pairwise nearest-neighbor spacing (are they clumped on boot?)
      const nn=soldiers.map(s=>{let m=1e9;for(const o of soldiers){if(o.id===s.id)continue;const d=Math.hypot(o.x-s.x,o.y-s.y);if(d<m)m=d;}return m;}).filter(x=>x<1e8);
      const nnMean=nn.reduce((a,b)=>a+b,0)/nn.length;
      return JSON.stringify({
        cellSize:cs, gridSize:t.size, worldSize:t.size*cs,
        elev:{min:Math.round(t.minElev),max:Math.round(t.maxElev),relief:Math.round(t.maxElev-t.minElev)},
        cop:{x:copC.x,y:copC.y,cx:t.cop.center.cx,cy:t.cop.center.cy,radiusCells:t.cop.radius,radiusM:t.cop.radius*cs,diameterM:2*t.cop.radius*cs,gate:cc(t.cop.gateOutside.cx,t.cop.gateOutside.cy),gateDir:t.cop.gateDir},
        villages:vills, copVillDist, villageGap:{minM:Math.round(vvmin),maxM:Math.round(vvmax)},
        garrison:{count:soldiers.length, nnMeanM:+nnMean.toFixed(2)},
      });
    })()`);
    const G = JSON.parse(geomJson);

    // ---------- compute on-screen projection table ----------
    const ppms = [0.3, 0.5, 0.7, 1.0, 2.0, 4.0, 8.0];
    const SOLDIER_TRUE_M = 0.6;     // a man top-down ~0.5-0.7 m wide
    const SQUAD_N = 9, DISPERSION_M = 5.5; // model patrol dispersion
    const projection = ppms.map((ppm) => {
      const fpx = figurePx(ppm);
      const figGroundM = fpx / ppm;             // how many meters the drawn figure spans
      const dpx = dotR(ppm) * 2;                // NATO dot diameter px
      const dotGroundM = dpx / ppm;
      const trueSoldierPx = SOLDIER_TRUE_M * ppm;
      const copPx = G.cop.diameterM * ppm;
      const squadSpanM = (SQUAD_N - 1) * DISPERSION_M;
      const squadSpanPx = squadSpanM * ppm;
      // R2: below FIG_FADE0 the renderer draws ONE squad icon, not 9 men — so individuals
      // can't overlap there at all. The geometric overlap test is only the real read at/above
      // tactical zoom, where men actually resolve. Report both: the raw geometric test AND the
      // effective on-screen result given the squad-icon LOD.
      const figuresOverlapGeom = (fpx * SQUAD_N) > squadSpanPx; // do 9 figures fit in their real span?
      const squadIconLOD = ppm < FIG_FADE0;                     // R2 collapses to one icon here
      const figuresOverlap = squadIconLOD ? false : figuresOverlapGeom; // effective on screen
      const screenWm = VW / ppm, screenHm = VH / ppm;
      return {
        ppm, lod: squadIconLOD ? "squad-icon" : "figures", figurePx: +fpx.toFixed(1), figureGroundM: +figGroundM.toFixed(1),
        figureVsTrue: +(figGroundM / SOLDIER_TRUE_M).toFixed(0) + "x oversized",
        dotDiamPx: +dpx.toFixed(1), dotGroundM: +dotGroundM.toFixed(1),
        trueSoldierPx: +trueSoldierPx.toFixed(2),
        copDiameterPx: Math.round(copPx),
        soldierFigVsCop: +(fpx / copPx).toFixed(3), // fraction of COP a soldier figure occupies
        squadSpanPx: Math.round(squadSpanPx), squadFiguresWidthPx: Math.round(fpx * SQUAD_N),
        squadFiguresOverlap: figuresOverlap, squadFiguresOverlapGeom: figuresOverlapGeom,
        screenCoverM: `${Math.round(screenWm)}x${Math.round(screenHm)}`,
      };
    });
    // real-world ground truth: soldier 0.6m vs COP 170m
    const realSoldierVsCop = SOLDIER_TRUE_M / G.cop.diameterM;

    const out = { seed: SEED, viewport: { w: VW, h: VH }, geometry: G,
      constants: { SOLDIER_TRUE_M, SQUAD_N, DISPERSION_M, realSoldierVsCopFraction: +realSoldierVsCop.toFixed(5) },
      projection };
    writeFileSync(`${OUTDIR}/scale-measurements.json`, JSON.stringify(out, null, 2));
    console.log("\n=== MEASUREMENTS ===");
    console.log("grid", G.gridSize, "@", G.cellSize, "m =", G.worldSize, "m valley");
    console.log("elev", G.elev);
    console.log("COP diam", G.cop.diameterM, "m | garrison", G.garrison.count, "men, nn-spacing", G.garrison.nnMeanM, "m");
    console.log("villages", G.villages.map(v => `${v.name}(pop${v.population},r${v.radiusM}m)`).join(", "));
    console.log("COP->village", G.copVillDist.map(d => `${d.name}:${d.m}m`).join(", "));
    console.log("village-village gap min/max", G.villageGap);
    console.log("\nppm | LOD | figPx | figGroundM | figVsTrue | dotGroundM | COPpx | soldier/COP | squadSpanPx | 9figPx | overlap(eff) | overlap(geom) | screenM");
    for (const p of projection) console.log(`${p.ppm} | ${p.lod} | ${p.figurePx} | ${p.figureGroundM} | ${p.figureVsTrue} | ${p.dotGroundM} | ${p.copDiameterPx} | ${p.soldierFigVsCop} | ${p.squadSpanPx} | ${p.squadFiguresWidthPx} | ${p.squadFiguresOverlap} | ${p.squadFiguresOverlapGeom} | ${p.screenCoverM}`);
    console.log("REAL soldier(0.6m)/COP(170m) fraction =", out.constants.realSoldierVsCopFraction);

    // ---------- SCREENSHOTS ----------
    // A. default zoom on the COP — the canonical "soldiers vs COP" view
    await ev(`window.__setCam(${G.cop.x},${G.cop.y},0.7)`); await sleep(600); await shot("A-default-cop-ppm0.7");
    // B. strategic zoom-out — whole valley, villages, COP, inter-village distances
    const midX = G.worldSize / 2, midY = G.worldSize / 2;
    await ev(`window.__setCam(${midX},${midY},0.3)`); await sleep(600); await shot("B-strategic-ppm0.3");
    // C. place a 9-man squad in a clean column at REAL 5.5 m dispersion on the gate apron, then
    //    show it at default zoom (the "spacing collapses to a blob" demonstration)
    const stage = await ev(`(()=>{
      const w=window.__ITM.getState().world, sim=w.sim, t=w.terrain;
      const all=sim.playerUnits();
      let sq=all.filter(u=>(u.squadId||u.squad)==='sq1').slice(0,9);
      if(sq.length<9) sq=all.slice(0,9); // fallback: any 9 friendlies
      if(sq.length<9) return 'only '+sq.length+' friendlies';
      const g=t.cop.gateOutside, gc=t.cellCenter(g.cx,g.cy);
      // march axis = gateDir; lateral = perp. Lay a single file at 5.5 m spacing.
      const dx=t.cop.gateDir.x, dy=t.cop.gateDir.y;
      sq.forEach((u,i)=>{ u.pos={x:gc.x+dx*(i*5.5+10), y:gc.y+dy*(i*5.5+10)}; u.facing=Math.atan2(dy,dx); });
      const mid=sq[4].pos;
      window.__cx=mid.x; window.__cy=mid.y;
      return 'ok mid='+Math.round(mid.x)+','+Math.round(mid.y);
    })()`);
    console.log("stage squad:", stage);
    await sleep(200);
    await ev(`window.__setCam(window.__cx,window.__cy,0.7)`); await sleep(600); await shot("C-squad-file-ppm0.7");
    // D. same squad at tactical zoom
    await ev(`window.__setCam(window.__cx,window.__cy,2.0)`); await sleep(600); await shot("D-squad-file-ppm2.0");
    // E. nearest village at moderate zoom (compound footprint vs a soldier standing beside it)
    const nearest = G.villages.find(v => v.name === G.copVillDist[0].name) || G.villages[0];
    await ev(`(()=>{const w=window.__ITM.getState().world,sim=w.sim;const u=sim.playerUnits()[0];u.pos={x:${nearest.x}+ ${nearest.radiusM} + 5, y:${nearest.y}};return 'man beside village';})()`);
    await ev(`window.__setCam(${nearest.x},${nearest.y},1.6)`); await sleep(600); await shot("E-village-ppm1.6");

    console.log("\nDONE.");
  } catch (e) {
    console.error("ERR", e);
  } finally {
    try { ws && ws.close(); } catch {}
    chrome.kill("SIGKILL");
    await sleep(200);
    process.exit(0);
  }
})();
