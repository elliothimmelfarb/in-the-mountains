// Report tooling — assemble the world-scale realism HTML report. Inlines the SVG diagrams,
// base64-embeds the live screenshots (with correct scale-bar overlays), renders the
// measured projection table, and writes a single self-contained report.html.
// Run from repo root:  node docs/progress/2026-06-06-world-scale-realism/build/report-build.mjs
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "docs/progress/2026-06-06-world-scale-realism";
const svg = (n) => readFileSync(`${DIR}/diagrams/${n}.svg`, "utf8");
const img = (n) => "data:image/png;base64," + readFileSync(`${DIR}/shots/${n}.png`).toString("base64");
const M = JSON.parse(readFileSync(`${DIR}/scale-measurements.json`, "utf8"));

// ---- screenshot with a guaranteed-correct scale bar overlay (816x765 native; ppm = px/m) ----
function shot(file, ppm, barM, caption) {
  const barPx = barM * ppm, bx = 22, by = 765 - 26;
  const overlay = `<svg class='ov' viewBox='0 0 816 765' preserveAspectRatio='xMidYMid meet'>
    <rect x='${bx - 8}' y='${by - 22}' width='${barPx + 70}' height='34' fill='rgba(8,9,6,0.62)' rx='4'/>
    <line x1='${bx}' y1='${by}' x2='${bx + barPx}' y2='${by}' stroke='#fff' stroke-width='2.5'/>
    <line x1='${bx}' y1='${by - 5}' x2='${bx}' y2='${by + 5}' stroke='#fff' stroke-width='2.5'/>
    <line x1='${bx + barPx}' y1='${by - 5}' x2='${bx + barPx}' y2='${by + 5}' stroke='#fff' stroke-width='2.5'/>
    <text x='${bx + barPx + 8}' y='${by + 4}' font-family='ui-monospace,monospace' font-size='15' fill='#fff'>${barM} m</text>
  </svg>`;
  return `<figure class='shot'><div class='shotwrap'><img src='${img(file)}' alt='${caption}'/>${overlay}</div><figcaption>${caption}</figcaption></figure>`;
}

// ---- projection table ----
const projRows = M.projection.map((p) => {
  const cls = p.ppm === 0.7 ? " class='hi'" : "";
  return `<tr${cls}><td>${p.ppm}${p.ppm === 0.7 ? " ◄ default" : ""}</td><td>${p.figurePx}</td><td><b>${p.figureGroundM} m</b></td><td>${p.figureVsTrue.replace("x", "×")}</td><td>${(p.soldierFigVsCop * 100).toFixed(1)}%</td><td>${p.squadFiguresOverlap ? "<span class='bad'>blob</span>" : "<span class='good'>resolved</span>"}</td><td>${p.screenCoverM.replace("x", " × ")} m</td></tr>`;
}).join("");

const html = `<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>In the Mountains — World-Map Scale Realism Audit</title>
<style>
  :root{--bg:#101109;--panel:#181a12;--panel2:#1d2018;--ink:#e8e4d8;--sub:#9a9686;--amber:#d8a657;--red:#c8553d;--green:#6f8f4e;--orange:#d98a3d;--blue:#5a86a8;--grid:#2c2f26;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-monospace,Menlo,Consolas,monospace;}
  .wrap{max-width:1000px;margin:0 auto;padding:38px 26px 90px}
  h1{font-size:30px;line-height:1.2;margin:0 0 6px;color:var(--amber);letter-spacing:.5px}
  h2{font-size:21px;margin:48px 0 10px;color:var(--amber);border-bottom:1px solid var(--grid);padding-bottom:8px}
  h3{font-size:16px;margin:26px 0 6px;color:var(--ink)}
  .lede{color:var(--sub);font-size:15px;margin:0 0 4px}
  .meta{color:var(--sub);font-size:12.5px;margin:2px 0 26px}
  p{margin:11px 0}
  a{color:var(--blue)}
  code{background:#0c0d08;border:1px solid var(--grid);border-radius:4px;padding:1px 5px;font-size:13px;color:#e3c98a}
  .verdict{background:linear-gradient(180deg,#1d2018,#15170f);border:1px solid var(--grid);border-left:4px solid var(--amber);border-radius:8px;padding:20px 24px;margin:8px 0 22px}
  .verdict b{color:var(--ink)}
  figure{margin:22px 0}
  figure svg, .dia svg{max-width:100%;height:auto;display:block;border-radius:8px;border:1px solid var(--grid)}
  figcaption{color:var(--sub);font-size:12.5px;margin-top:8px;font-style:italic}
  .shotwrap{position:relative;line-height:0;border-radius:8px;overflow:hidden;border:1px solid var(--grid)}
  .shotwrap img{width:100%;display:block}
  .shotwrap .ov{position:absolute;inset:0;width:100%;height:100%}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:760px){.grid2{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
  th,td{border:1px solid var(--grid);padding:6px 9px;text-align:left}
  th{background:#14160f;color:var(--amber);font-weight:600}
  tr.hi{background:rgba(216,166,87,.10)}
  .bad{color:var(--red);font-weight:700}.good{color:var(--green);font-weight:700}
  .bucket{border-radius:8px;padding:14px 18px;margin:14px 0}
  .b1{background:rgba(216,166,87,.08);border:1px solid #4a3c1e}
  .b2{background:rgba(200,85,61,.07);border:1px solid #4a2820}
  .auth{background:rgba(111,143,78,.09);border:1px solid #34431f;border-radius:8px;padding:14px 18px}
  .auth li{margin:4px 0}
  .tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;margin-left:6px;vertical-align:middle}
  .tg-render{background:#4a3c1e;color:var(--amber)}.tg-sim{background:#4a2820;color:#e08a78}.tg-org{background:#4a3613;color:var(--orange)}.tg-ok{background:#2c3a1a;color:#9ec471}
  .conf{color:var(--sub);font-size:12px}
  .callout{background:#0c0d08;border:1px solid var(--grid);border-radius:8px;padding:14px 18px;margin:16px 0}
  .src{font-size:12.5px;color:var(--sub)} .src li{margin:5px 0}
  .num{color:var(--amber);font-weight:700}
  hr{border:0;border-top:1px solid var(--grid);margin:30px 0}
</style></head><body><div class='wrap'>

<h1>World-Map Scale: a realism audit</h1>
<p class='lede'><i>In the Mountains</i> — are the proportions of the soldiers, the outpost, the villages, the terrain, and the distances between them true to the real Korengal?</p>
<p class='meta'>2026-06-06 · seed <code>korengal</code> · measured on HEAD · model numbers from the live game, real-world numbers from a cited 13-agent research pass</p>

<div class='verdict'>
<p style='margin-top:0'><b>The short answer: your instinct is right — and the loudest problem is the easiest to fix.</b></p>
<p>At the default zoom the game paints each soldier <span class='num'>≈21 m wide</span> on the ground — <span class='num'>36× too big</span> — so men visually dominate a 170 m outpost and a squad standing at textbook spacing fuses into a single blob. That is a <b>rendering</b> bug, not a simulation bug. Strip it away and the underlying sim is, in most dimensions, <b>already authentic</b>: the elevation, the 1,368 m of relief, the ridge-crest heights, the engagement ranges, the 9-man squad, even the 5.5 m man-to-man spacing all check out against doctrine and the real valley.</p>
<p style='margin-bottom:0'>The deeper geometry drifts — the map is one short, <i>square</i> slice of a long narrow slot; a "village" is drawn as one building instead of a hamlet of ~90; the garrison is a touch under-strength — are real, but they are contained, deliberate design choices. <b>Two buckets, and Bucket 1 is cheap.</b></p>
</div>

<div class='dia'>${svg("d4-scorecard")}</div>
<p class='meta'>Every dimension we could pin to a number, ranked by how far it is from reality. The two giant bars are a <b>render</b> bug and a <b>render+sim</b> bug; below them a short cascade of genuine geometry drifts; and a reassuring cluster of green — things that are already right.</p>

<div class='bucket b1'><b>BUCKET 1 — Representation (render only, do first).</b> The sim's numbers are mostly correct; the renderer misreports them. Low-risk, high-impact, fixes ~90% of the "feels wrong." Touches only <code>lib/render/</code> + <code>components/world/</code>.</div>
<div class='bucket b2'><b>BUCKET 2 — Simulation scale (worldgen, do second).</b> Genuine model choices about valley size, village structure, roster, and standoff. Higher blast radius; each is a realism-vs-playability call and must respect the determinism contract.</div>

<h2>How scale works here (60-second primer)</h2>
<p>The world is a <span class='num'>512 × 512</span> grid at <span class='num'>5 m per cell</span> — a <span class='num'>2.56 km</span> square (<code>lib/sim/terrain.ts:118</code>). The camera carries a single scalar, <code>ppm</code> — <b>pixels per metre</b> — that defaults to <code>0.7</code> (<code>WorldView.tsx:103</code>) and ranges <code>0.3–8.0</code>. The pipeline is honest by construction: the pure simulation works in <b>metres</b>; the renderers multiply metres by <code>ppm</code> to get pixels. A building's footprint in metres × <code>ppm</code> = its size on screen. That is faithful.</p>
<p>Soldiers are the exception. A man is <b>not</b> drawn from his footprint. He is drawn at <code>figurePx = clamp(ppm × 7, 15, 40)</code> (<code>lib/render/draw.ts:19</code>) — a fixed <i>pixel</i> size with a <b>15 px floor</b>, divorced from his real 0.6 m width. Divide that by <code>ppm</code> and you recover how many metres of ground the game is implicitly claiming the man covers. That single line is the source of the headline problem.</p>

<h2>Finding 1 — Soldiers are painted as giants <span class='tag tg-render'>RENDER · highest impact</span></h2>
<p>Because <code>figurePx</code> has a pixel floor, the more you zoom out the <i>larger</i> the soldier becomes relative to the ground. At the default zoom he is <span class='num'>21.4 m</span> across; he is <b>never</b> smaller than 5 m at any zoom the game allows. A real soldier is 0.6 m.</p>
<div class='grid2'><div class='dia'>${svg("d1-footprints")}</div><div class='dia'>${svg("d3-clamp-curve")}</div></div>
<p>The same story in hard numbers, straight from the live renderer's own formulas (the <code>◄ default</code> row is what you see on load):</p>
<table><thead><tr><th>zoom (ppm)</th><th>figure px</th><th>ground width</th><th>vs real 0.6 m</th><th>% of COP width</th><th>9-man squad</th><th>screen covers</th></tr></thead><tbody>${projRows}</tbody></table>
<p>At the default zoom a single soldier spans <span class='num'>12.6%</span> of the entire outpost's width. A real soldier spans <span class='num'>0.35%</span> — a <b>36× exaggeration</b>. (Even the low-zoom NATO dot, the <code>r = clamp(0.95·ppm, 4.5, 13)</code> marker at <code>draw.ts:96</code>, is ~13 m wide at default — a ~21× exaggeration on its own.) Here it is on the live map, with a trustworthy 100 m scale bar:</p>
${shot("A-default-cop-ppm0.7", 0.7, 100, "The COP at the default zoom (ppm 0.7). The garrison reads as a chunky cluster of figures piled on the outpost — each figure is drawn ~21 m wide. Scale bar = 100 m.")}
<div class='callout'><b>Why it exists, and why the fix isn't "1:1."</b> Drawing a man at his true 0.6 m would make him a sub-pixel speck at operational zoom — invisible. The renderer over-corrects with a fixed floor. The right answer is the standard operational-wargame convention (NATO APP-6 / MIL-STD-2525; Command Ops, Combat Mission, Steel Beasts all do this): <b>one small unit icon per element when zoomed out, individual figures at near-true footprint when zoomed in.</b> The codebase already has the instinct — it hides the garrison entirely below ppm 0.5 (<code>WorldView.tsx:342</code>); fix <b>R2</b> just generalizes that all-or-nothing cull into a per-squad icon. See <b>R1</b> and <b>R2</b> in the change brief.</div>

<h2>Finding 2 — A squad at correct spacing renders as one blob <span class='tag tg-render'>RENDER</span></h2>
<p>This is the subtle one, and it explains why the <i>spacing</i> feels wrong even though the sim spaces men correctly. The simulation disperses a moving squad at <span class='num'>5.5 m</span> between men (range 4–12 m, <code>formation.ts</code>) — squarely inside the doctrinal 1–10 m wedge band (FM/ATP 3-21.8: "normally 10 metres," tightening in close terrain). But at the default zoom, 5.5 m on screen is only <b>3.85 px</b>, while each figure is drawn <b>15 px</b> wide. The figures are four times wider than the gap between them, so they overlap at <i>every</i> zoom the game offers — the spacing you set can never be seen.</p>
<div class='dia'>${svg("d2-dispersion")}</div>
<div class='grid2'>${shot("C-squad-file-ppm0.7", 0.7, 100, "A 9-man squad placed at the model's real 5.5 m spacing, default zoom. Nine men — but you see a clump. Scale bar = 100 m.")}${shot("D-squad-file-ppm2.0", 2.0, 50, "Same squad at tactical zoom (ppm 2.0). The outpost is at left; the squad on the apron is still an unresolved cluster. Scale bar = 50 m.")}</div>
<p>The <code>squadFiguresOverlap</code> column in the table above is <span class='bad'>blob</span> at every single zoom level. Fix this with the same R1/R2 changes — once a man is drawn near his true size and a squad collapses to one icon when zoomed out, real dispersion becomes visible.</p>

<h2>Finding 3 — A "village" is one building, not a hamlet <span class='tag tg-sim'>RENDER + SIM · biggest geometry error</span></h2>
<p>The research is unambiguous (confidence 0.75): a real Korengal village — Babiyal, Aliabad, Loy Kalay — is a <b>cluster of ~80–100 mud-and-stone houses stacked on hillside terraces</b>, housing 650–830 people. The game models a village as a <b>single walled compound</b>: <code>WorldView.tsx:198</code> draws exactly one qalat sprite (<code>widthM</code> 24/36/50 m by population) over a single map pin. A whole settlement is rendered as one box.</p>
${shot("E-village-ppm1.6", 1.6, 50, "The COP (left) and the nearest village (right) in one frame at ppm 1.6, with a soldier placed beside the compound. The 'village' is a lone structure — not the dozens of stacked houses a real hamlet holds. Scale bar = 50 m.")}
<p>A single Afghan family qalat at 20–60 m per side is itself plausible (the model's 40–80 m compound sits at the upper end of that) — the error is that <b>one compound stands in for the entire village</b>. Fix <b>R3</b> scatters a population-scaled cluster of sub-compounds for a render-only win; a deeper Bucket-2 version stamps real multi-compound footprints into the terrain.</p>

<h2>Finding 4 — The valley is one short, square slice of a long, narrow slot <span class='tag tg-sim'>SIM</span></h2>
<p>The real Korengal runs <span class='num'>~9.7 km</span> along its axis and is only <span class='num'>~0.5–1.0 km</span> wide on the floor — roughly a <b>10:1 slot</b> (confidence 0.92 on length, 0.85 on width; Wikipedia campaign article + FDD + cross-checks). The game's map is a <span class='num'>2.56 km square</span>: about <b>3.8× too short</b> along-axis and <b>~3.4× too wide</b> for the floor, and a square simply cannot hold the real long-narrow geometry.</p>
<div class='dia'>${svg("d5-valley-shape")}</div>
<p>The most honest framing is that <b>the map represents one ~2.56 km segment of the valley</b>, not the whole thing — which is a defensible tactical-slice choice. Two smaller notes: the floor's elevation gradient runs the wrong way (the real Korengal drains <i>north</i> into the Pech, so the low end should be north, not south), and the 5 m cell resolution is actually <i>finer</i> than public 30 m DEMs — appropriate for a tactical sim.</p>

<h2>Finding 5 — The garrison is a satellite OP, and slightly under-strength <span class='tag tg-org'>ORG + SIM</span></h2>
<p>The 35-man platoon maps cleanly onto a <b>forward observation post</b> (Restrepo held ~15 men at a time, a platoon-affiliated ~30–35) — <i>not</i> the company-HQ Korengal Outpost, which held ~100–150 men across the valley. That is "right echelon, wrong node," and entirely defensible: you command a platoon, so a platoon-sized post is the correct scope.</p>
<p>Two concrete drifts worth fixing:</p>
<ul>
<li><b>Weapons squad: 3 vs 9.</b> The model's weapons squad is one-third the doctrinal size, which is the entire reason the platoon totals 35 instead of the real <span class='num'>39 organic / 42 with attachments</span> (FM/ATP 3-21.8, confidence 0.9). A pure roster fix.</li>
<li><b>COP shape: a clean 170 m circle.</b> The footprint <i>scale</i> (~250 m overall) is right (Wanat's VPB Kahler was 300 × 100 m), but a real small OP was a <b>~30-HESCO fishhook, ~70–100 m of wall, conforming to the terrace</b> — not a tidy ring (~220 m of wall / ~90 HESCOs). The model has roughly <b>2.6× too much wall</b> and the wrong, too-regular geometry.</li>
</ul>

<h2>What is already authentic (leave it alone)</h2>
<div class='auth'><p style='margin-top:0'>A realism audit that only lists faults is crying wolf. These dimensions check out against doctrine and the real valley — changing them would make the sim <i>less</i> true:</p>
<ul>
<li><b>Vertical scale &amp; relief</b> <span class='tag tg-ok'>✓</span> measured 1,531–2,899 m, <b>1,368 m of relief</b> — real floor-to-crest is ~1,000–1,650 m. The mountains are the right size.</li>
<li><b>Ridge crest heights</b> <span class='tag tg-ok'>✓</span> model 2,330–2,780 m vs real Abas Ghar 2,378 m / Sawtalo Sar 2,854 m.</li>
<li><b>Valley-floor elevation</b> <span class='tag tg-ok'>✓</span> model 1,550 m ≈ the DEM-measured KOP terrace (~1,500 m). (The encyclopedic "1,000–1,200 m" describes the <i>lower</i> valley near the Pech mouth.)</li>
<li><b>Engagement ranges</b> <span class='tag tg-ok'>✓</span> model 30–620 m vs the real <i>bimodal</i> 16–800 m (~50% of fights past 300 m — Ehrhart, CGSC). Only the 620–800 m tail is clipped.</li>
<li><b>Rifle squad size</b> <span class='tag tg-ok'>✓</span> 9 men, exact.</li>
<li><b>Man-to-man dispersion</b> <span class='tag tg-ok'>✓</span> 5.5 m default (4–12 m range) sits inside the 1–10 m doctrinal wedge band. The <i>value</i> is right; only the rendering hides it.</li>
<li><b>COP siting</b> <span class='tag tg-ok'>✓</span> on a terraced bench 12–95 m above the floor — better-sited than the cautionary real outposts (Keating, Wanat) that sat on the valley floor and conceded the high ground.</li>
</ul></div>

<h2>How this was verified <span class='tag tg-ok'>did an AI really do this?</span></h2>
<p>Nothing here is a guess; every number is either read from the running game or sourced to a citation.</p>
<ul>
<li><b>Model numbers — measured, not recalled.</b> A headless Chrome-DevTools harness booted the live game (seed <code>korengal</code>), read the world geometry from <code>window.__ITM</code>, then applied the renderer's <i>exact</i> clamp formulas to compute the ground-metres-per-figure at each zoom. That is the projection table above; the raw capture is in <code>scale-measurements.json</code>.</li>
<li><b>Real-world ground truth — a cited research pass.</b> 13 agents in parallel: five researchers (valley geography, US outposts, villages/qalats, infantry doctrine, cartographic convention), an adversarial verification of seven load-bearing numbers, and a synthesis. ~849K tokens. Anchored to FM/ATP 3-21.8, Sebastian Junger's <i>War</i>, MAJ Ehrhart's CGSC monograph on Afghanistan engagement ranges, PeakVisor geodata, and SRTM/Copernicus DEM cross-checks for the KOP↔Restrepo distance. Full record in <code>research-raw.txt</code>.</li>
<li><b>Adversarial check on the central claim.</b> A separate skeptic re-read the renderer to try to <i>refute</i> "soldiers are drawn grossly oversized with no per-squad aggregation," quoting the code.</li>
</ul>
<p><b>Honest confidence &amp; caveats.</b> The strongest findings (valley length, ridge heights, doctrinal org/dispersion, engagement ranges, the render math) are multiply-sourced or directly measured. The <b>softest</b> are the valley <i>floor</i> elevation (encyclopedic figures conflict with the DEM; reconciled as lower-valley vs mid-valley) and the per-village footprint &amp; house counts (derived from population arithmetic, not measured). A few primary PDFs (the CSI Wanat study, RAND, Wesley Morgan's <i>The Hardest Place</i>) returned 403 or snippet-only. The <i>direction and order of magnitude</i> of every finding are robust; the exact per-village figures are estimates.</p>

<h2>The fix, in priority order</h2>
<p>The full, agent-ready brief — doctrinal basis → exact <code>file:line</code> → concrete parameter values → integration seam → verification metric, for each change — is in <code>AGENT-BRIEF.md</code> beside this report. In short:</p>
<ol>
<li><b>R1 · Stop drawing 5–50 m soldiers.</b> Replace <code>figurePx = clamp(ppm·7, 15, 40)</code> with a footprint-tracking size and a small legibility floor; push the figure-LOD band to genuinely tactical zoom. <span class='tag tg-render'>render</span></li>
<li><b>R2 · One icon per squad when zoomed out.</b> Below ~ppm 2.5, draw a single NATO unit symbol per <code>squadId</code> at the squad centroid instead of 35 stacked men; crossfade to individual figures above it. <span class='tag tg-render'>render</span></li>
<li><b>R3 · Villages as clusters.</b> Scatter a population-scaled ring of sub-compounds per village instead of one monolithic qalat. <span class='tag tg-render'>render</span></li>
<li><b>Bucket 2 · Sim geometry.</b> Restore the 9-man weapons squad (→ 39–42 platoon); reshape the COP from a circle to a terrain-conforming, shorter-walled position; and treat the map explicitly as one segment of a 10:1 valley (or stretch the long axis). All with determinism preserved (<code>serialize()</code>/<code>loadWorld()</code>, <code>smoke.ts</code>). <span class='tag tg-sim'>sim</span></li>
</ol>
<p>Doing R1 + R2 alone — a few lines in <code>draw.ts</code> plus one squad-aggregation pass in the WorldView render loop — resolves the soldier-giant and squad-blob problems that drive almost all of the "doesn't feel true to life," at near-zero risk to the simulation.</p>

<h2>Sources</h2>
<ul class='src'>
<li>FM / ATP 3-21.8, <i>Infantry Rifle Platoon and Squad</i> — squad/platoon org, movement formations &amp; intervals ("normally 10 metres").</li>
<li>Sebastian Junger, <i>War</i> (and the documentary <i>Restrepo</i>) — KOP as company HQ, Restrepo manning, Babiyal ~½ mile south, HESCO "fishhook."</li>
<li>MAJ Thomas P. Ehrhart, <i>Increasing Small Arms Lethality in Afghanistan: Taking Back the Infantry Half-Kilometer</i> (US Army CGSC, 2009) — ~50% of engagements past 300 m.</li>
<li>Wikipedia, <i>Korangal Valley campaign</i> &amp; <i>Korangal Valley</i>; FDD Long War Journal — valley length/width, village count, OP network.</li>
<li>PeakVisor — Sawtalo Sar 2,854 m, Abbas Ghar 2,378 m (geodata); SRTM / Copernicus DEM — KOP↔Restrepo distance &amp; vertical separation.</li>
<li>Battle of Wanat references (VPB Kahler 300 × 100 m); MDPI <i>Buildings</i> (2025) on qala dimensions.</li>
<li>Live game measurement: <code>scale-measurements.json</code>; full research record: <code>research-raw.txt</code>.</li>
</ul>

<hr><p class='meta'>Generated for <i>In the Mountains</i> · all model figures measured on HEAD at seed <code>korengal</code> · diagrams and screenshots reviewed and revised before publication.</p>
</div></body></html>`;

writeFileSync(`${DIR}/report.html`, html);
console.log("wrote report.html  (" + (html.length / 1024).toFixed(0) + " KB)");
