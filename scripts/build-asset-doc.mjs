// Generate the studio "art bible" HTML doc from the authored assets + metadata.
// Self-contained: every SVG is inlined (crisp vector); screenshots referenced by relative path.
//   node scripts/build-asset-doc.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const dir = "docs/visual-overhaul/assets";
const out = "docs/visual-overhaul/asset-bible.html";
const meta = existsSync(join(dir, "_meta.json")) ? JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")) : {};

const assets = readdirSync(dir).filter((f) => f.endsWith(".svg")).sort().map((f) => {
  const id = basename(f, ".svg");
  return { id, svg: readFileSync(join(dir, f), "utf8").trim(), ...(meta[id] || {}) };
});

// Family display config (order + label + blurb). Anything not listed falls into "misc".
const FAMILIES = [
  ["us-soldiers", "US Infantry", "Top-down US soldiers — one per role. Rotating sprites; faction read = blue IR-flag patch. The weapon is carried diagonally (never an axial 'pan-handle'); shoulders are the widest axis."],
  ["ana-soldiers", "Afghan National Army", "Lighter kit, teal-green accent, AK-pattern weapons — legibly 'ours but not US' at a glance."],
  ["insurgents", "Anti-Coalition Militia", "Earth-tone shalwar-kameez fighters, turban/pakol heads (no helmet), red accent. Includes a translucent 'suspected' (unconfirmed contact) treatment."],
  ["civilians", "Civilians & Livestock", "Robed non-combatants carrying tools/loads — clearly unarmed and distinct from fighters — plus goats and a donkey."],
  ["cop-buildings", "COP Structures", "2.5-D top-down buildings: corrugated roofs, sandbag berms, the TOC's comms cluster. Static — full NW key light + SE cast shadow."],
  ["cop-defenses", "Fortifications", "HESCO bastion runs & corners, the ECP gate, guard towers, sandbag fighting positions, concertina, the flag — the bones of a combat outpost."],
  ["aviation", "Aviation", "UH-60 Black Hawk and CH-47 Chinook, top-down with translucent rotor discs, parked on the graded LZ pad."],
  ["vehicles", "Vehicles", "MRAP, up-armored HMMWV, a local pickup 'technical', and a colorful Afghan jingle truck. Rotating (symmetric shadow)."],
  ["village-compounds", "Villages & Terrain Features", "Mud-walled qalat compounds (3 sizes), a mosque, a cemetery, a bazaar stall, terraced fields, and a footbridge."],
  ["vegetation", "Vegetation & Rock", "The high-zoom decoration layer — cedars, walnuts, poplars, scrub, boulders, outcrops, reeds, crop furrows — scattered deterministically by landcover."],
  ["map-markers", "Map Markers", "Milspec ink: intel by source (SIGINT/HUMINT/visual), attitude-tinted village pins, the COP pin, objective/waypoint flags, MEDEVAC/TIC/IED, and named-feature glyphs."],
  ["hud-cartography", "HUD & Cartography", "The sheet furniture — compass rose, north arrow, scale bar, legend frame, coordinate tab, range ring, edge ornament."],
  ["ui-orders", "Order & Mission Icons", "Flat toolbar icons for orders (move/assault/hold/suppress/smoke/frag/withdraw) and patrol missions."],
  ["ui-support", "Fire Support & CERP Icons", "Mortars, CAS, MEDEVAC, and the CERP development projects (well, school, clinic, road, micro-hydro…)."],
  ["ui-logistics", "Logistics, Status & Weather", "Supply classes, soldier status badges, and weather glyphs for the command UI."],
  ["ui-roles", "Role Badges & Crests", "Per-role weapon glyphs for the roster, plus US / ANA / ACM faction crests."],
];

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function group(fam) { return assets.filter((a) => a.family === fam); }

const swatches = [
  ["#0c0d0a", "bg"], ["#14160f", "panel"], ["#2c3022", "line"], ["#d8d6c4", "ink"], ["#9a9a82", "ink-dim"],
  ["#6b7a3a", "olive"], ["#c2a878", "tan"], ["#e0a72b", "amber"], ["#b5532a", "rust"], ["#9c2c20", "blood"],
  ["#4a86c6", "US"], ["#6fae9f", "ANA"], ["#c0392b", "ACM"], ["#d8b94a", "civ"], ["#6fae54", "good"],
  ["#8a984e", "cropland"], ["#527038", "orchard"], ["#324c30", "forest"], ["#9c927e", "scree"], ["#40687a", "river"],
  ["#a89668", "HESCO"], ["#a6865e", "mud wall"], ["#857a5c", "roof"], ["#fbf4dc", "rim light"], ["#1c160e", "shadow"],
];

const cards = (fam) => group(fam).map((a) => `
  <figure class="card">
    <div class="tiles">
      <div class="tile t-map">${a.svg.replace("<svg", '<svg class="big"')}</div>
      <div class="tile t-dark">${a.svg.replace("<svg", '<svg class="sm"')}</div>
      <div class="tile t-scree">${a.svg.replace("<svg", '<svg class="xs"')}</div>
    </div>
    <figcaption><span class="id">${a.id}</span><span class="m">${a.footprint != null ? "~" + a.footprint + " m" : "UI"}${a.rotating ? " · rot" : ""}</span></figcaption>
  </figure>`).join("");

const famSections = FAMILIES.filter(([f]) => group(f).length).map(([f, label, blurb]) => `
  <section class="fam">
    <h3>${label} <span class="count">${group(f).length}</span></h3>
    <p class="blurb">${blurb}</p>
    <div class="grid">${cards(f)}</div>
  </section>`).join("");

function img(p, cap) {
  return existsSync(join("docs/visual-overhaul", p)) ? `<figure class="shot"><img src="${p}" loading="lazy"><figcaption>${cap}</figcaption></figure>` : "";
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>In the Mountains — Map Art Bible</title>
<style>
  :root{--bg:#0c0d0a;--panel:#14160f;--panel2:#1b1e15;--line:#2c3022;--ink:#d8d6c4;--dim:#9a9a82;--amber:#e0a72b;--tan:#c2a878;}
  *{box-sizing:border-box}
  body{margin:0;background:
     radial-gradient(1200px 600px at 70% -10%, #15180f 0%, transparent 60%),
     var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  .mono{font-family:ui-monospace,Menlo,monospace}
  header{padding:64px 40px 36px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#101208,transparent)}
  header .kicker{letter-spacing:5px;font-size:11px;color:var(--amber);text-transform:uppercase;font-family:ui-monospace,monospace}
  h1{font-size:42px;margin:8px 0 6px;letter-spacing:-0.5px;font-weight:800}
  header p{max-width:760px;color:var(--dim);font-size:15px}
  main{max-width:1180px;margin:0 auto;padding:0 28px 80px}
  section.block{padding:40px 0;border-bottom:1px solid var(--line)}
  h2{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:var(--amber);font-family:ui-monospace,monospace;margin:0 0 18px}
  h3{font-size:18px;margin:0 0 4px;display:flex;align-items:baseline;gap:10px}
  h3 .count{font-size:11px;color:var(--dim);font-family:ui-monospace,monospace;border:1px solid var(--line);border-radius:10px;padding:1px 8px}
  .blurb{color:var(--dim);margin:0 0 16px;max-width:820px;font-size:13px}
  .sw{display:flex;flex-wrap:wrap;gap:8px}
  .sw div{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 10px 6px 6px;font-family:ui-monospace,monospace;font-size:11px}
  .sw i{width:22px;height:22px;border-radius:4px;display:block;border:1px solid rgba(255,255,255,.08)}
  .lod{width:100%;border-collapse:collapse;font-size:12.5px}
  .lod th,.lod td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  .lod th{background:var(--panel);color:var(--amber);font-family:ui-monospace,monospace;font-weight:600;letter-spacing:1px;font-size:11px;text-transform:uppercase}
  .lod td.b{font-family:ui-monospace,monospace;color:var(--tan);white-space:nowrap}
  .shots{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
  .shot{margin:0}.shot img{width:100%;border:1px solid var(--line);border-radius:8px;display:block}
  .shot figcaption{color:var(--dim);font-size:11.5px;margin-top:6px;font-family:ui-monospace,monospace}
  .fam{padding:26px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
  .card{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .tiles{display:flex;align-items:center;gap:0}
  .tile{flex:1;display:flex;align-items:center;justify-content:center;padding:10px;min-height:92px}
  .t-map{background:#8a984e;flex:1.5}.t-dark{background:#14160f}.t-scree{background:#9c927e}
  .tile svg{display:block}.big{width:64px;height:64px}.sm{width:40px;height:40px}.xs{width:26px;height:26px}
  figcaption{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-top:1px solid var(--line);font-family:ui-monospace,monospace;font-size:10.5px}
  .id{color:var(--ink)}.m{color:var(--dim)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:28px}
  @media(max-width:780px){.two,.shots,.tiles{grid-template-columns:1fr}.tiles{flex-direction:column}}
  .note{color:var(--dim);font-size:12.5px;max-width:840px}
  .pill{display:inline-block;font-family:ui-monospace,monospace;font-size:10.5px;color:var(--amber);border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin-right:6px}
  footer{padding:30px 40px;color:var(--dim);font-size:12px;font-family:ui-monospace,monospace;text-align:center}
</style></head><body>
<header>
  <div class="kicker">In the Mountains — Cartographic Asset System</div>
  <h1>The Map Art Bible</h1>
  <p>A complete visual overhaul of the tactical map: <b>${assets.length} hand-authored SVG assets</b> — soldiers, fortifications,
  villages, vehicles, vegetation, markers and UI — rasterized into a sprite atlas and composited over shaded-relief
  terrain with a single NW key light and a zoom-aware level-of-detail system. Every asset shown here is the live game art.</p>
</header>
<main>
  <section class="block">
    <h2>Design System</h2>
    <div class="two">
      <div>
        <h3>One light, one palette</h3>
        <p class="note">Everything is lit from the <b>north-west</b> to match the terrain's baked hillshade, so each sprite
        grounds itself with a soft south-east shadow and reads as sitting <i>in</i> the diorama. Static objects bake a
        directional cast shadow; rotating sprites (soldiers, vehicles) use a symmetric contact shadow so any heading looks right.
        Colours stay dusty, warm and desaturated — faction tints are accents, never whole fills.</p>
        <div class="sw">${swatches.map(([c, n]) => `<div><i style="background:${c}"></i>${n} <span style="color:var(--dim)">${c}</span></div>`).join("")}</div>
      </div>
      <div>
        <h3>Level of detail across zoom</h3>
        <p class="note">The camera spans <span class="pill">ppm 0.18→8</span> — the whole 2.56 km valley down to a single
        outpost. Representations <b>crossfade</b> so the map is beautiful at every zoom rather than right at one.</p>
        <table class="lod">
          <tr><th>Band</th><th>Units</th><th>Structures</th><th>Terrain</th></tr>
          <tr><td class="b">Strategic<br>≤0.35</td><td>NATO symbols</td><td>base / village pins</td><td>relief + contours</td></tr>
          <tr><td class="b">Operational<br>0.35–1.2</td><td>symbols→figures</td><td>building footprints, pins</td><td>+ sparse decoration</td></tr>
          <tr><td class="b">Tactical<br>1.2–3</td><td>figure sprites</td><td>full COP, qalats, vehicles</td><td>decoration + detail layer</td></tr>
          <tr><td class="b">Close<br>&gt;3</td><td>kit + facing + health</td><td>roofs, antennas, the flag</td><td>dense trees/rocks/grain</td></tr>
        </table>
      </div>
    </div>
  </section>

  <section class="block">
    <h2>Before &amp; After</h2>
    <p class="note">The baseline rendered entities as primitive canvas shapes — blue rectangles, wireframe boxes, coloured dots.
    The overhaul replaces them with authored art, a decoration layer, qalat villages, and a cartographic HUD.</p>
    <div class="shots">
      ${img("baseline/baseline-02-cop-ppm2.5.png", "BEFORE — COP, wireframe boxes & symbol dots")}
      ${img("after/02-cop-tactical.png", "AFTER — building sprites, LZ pad, wall positions, forest ring")}
      ${img("baseline/baseline-03-tactical-ppm8.png", "BEFORE — tactical zoom, blurred terrain & blue rectangles")}
      ${img("after/03-cop-close.png", "AFTER — B-huts, motor pool, garrison soldiers, ground detail")}
      ${img("after/04-village-qalat.png", "AFTER — a qalat compound ringed with orchard decoration")}
      ${img("after/01-strategic.png", "AFTER — the operational sheet: pins, relief, compass & scale")}
    </div>
  </section>

  <section class="block">
    <h2>The Asset Library — ${assets.length} pieces</h2>
    <p class="note">Each card shows the asset on cropland, on the dark panel, and on scree, at 64 / 40 / 26 px — the squint test
    every asset had to pass. Footprint (metres) and rotation are noted.</p>
    ${famSections}
  </section>

  <section class="block">
    <h2>How it composites on the map</h2>
    <p class="note">Authored SVGs are rasterized once to offscreen canvases (bake-once / blit-many, like the terrain itself),
    then blitted scaled &amp; rotated each frame. Terrain decoration is scattered from a stable per-cell hash so it never jitters
    on pan/zoom; a world-anchored noise overlay adds high-frequency tooth that hides the relief bitmap's upscaling blur.
    The whole stack holds <b>&gt;60 fps</b> with the simulation running. Renderer: <span class="mono">lib/render/{sprites,topo,draw,decoration}.ts</span> +
    <span class="mono">components/world/WorldView.tsx</span>; assets in <span class="mono">docs/visual-overhaul/assets/</span>.</p>
  </section>
</main>
<footer>In the Mountains · map visual overhaul · ${assets.length} assets · generated from live game art</footer>
</body></html>`;

writeFileSync(out, html);
console.log(`wrote ${out} (${assets.length} assets, ${(html.length / 1024).toFixed(0)} KB)`);
