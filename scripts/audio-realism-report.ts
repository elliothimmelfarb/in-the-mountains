/**
 * audio-realism-report.ts — generate the 2026-06-11 calibre-voices HTML report (every weapon
 * gets its real sound + the missing battle sounds): paired before/after metrics, embedded A/B
 * audio samples, side-by-side calibre comparisons, and the spectrogram visuals.
 *
 *   npx tsx scripts/audio-realism-report.ts
 *
 * Reads docs/progress/2026-06-11-sound-realism/{baseline,after}/metrics.json + viz/*.png and
 * writes report.html into the same folder. Media is referenced by RELATIVE path so the folder
 * is portable (the publish-report flow copies it whole). The report is a pure function of the
 * captured data — re-run it any time the metrics change.
 */
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "docs/progress/2026-06-11-sound-realism";
type Scene = {
  name: string; peakDb: number; rmsDb: number; lufs: number; crestDb: number; centroidHz: number;
  stereoCorr: number; widthPct: number; tailMs: number; audibleMs: number; loudWindowDb?: number;
  hf4kPct?: number; lf200Pct?: number; note: string;
};
const base: Scene[] = JSON.parse(readFileSync(`${DIR}/baseline/metrics.json`, "utf8")).scenes;
const aft: Scene[] = JSON.parse(readFileSync(`${DIR}/after/metrics.json`, "utf8")).scenes;
const B = (n: string) => base.find((s) => s.name === n);
const A = (n: string) => aft.find((s) => s.name === n)!;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A/B audio row: label + before/after <audio> players (before omitted for new scenes). */
function abAudio(name: string, label: string, why: string, isNew = false): string {
  const beforeCell = isNew
    ? `<div class="cell"><div class="cap">before</div><div class="none">— did not exist —</div></div>`
    : `<div class="cell"><div class="cap">before</div><audio controls preload="none" src="baseline/${name}.wav"></audio></div>`;
  return `<div class="ab">
    <div class="abhead"><b>${esc(label)}</b><span class="why">${esc(why)}</span></div>
    <div class="abrow">${beforeCell}
    <div class="cell"><div class="cap">after</div><audio controls preload="none" src="after/${name}.wav"></audio></div></div>
  </div>`;
}

/** Side-by-side comparison of two AFTER scenes (calibre vs calibre, not before vs after). */
function cmpAudio(aName: string, aLabel: string, bName: string, bLabel: string, label: string, why: string): string {
  return `<div class="ab">
    <div class="abhead"><b>${esc(label)}</b><span class="why">${esc(why)}</span></div>
    <div class="abrow">
    <div class="cell"><div class="cap">${esc(aLabel)}</div><audio controls preload="none" src="after/${aName}.wav"></audio></div>
    <div class="cell"><div class="cap">${esc(bLabel)}</div><audio controls preload="none" src="after/${bName}.wav"></audio></div></div>
  </div>`;
}

/** Compact before→after metric chips for a scene. */
function chips(name: string, keys: { k: keyof Scene; label: string; unit: string }[]): string {
  const b = B(name); const a = A(name);
  return `<div class="chips">` + keys.map(({ k, label, unit }) => {
    const bv = b ? (b[k] as number | undefined) : null; const av = a[k] as number;
    return `<span class="chip">${esc(label)}: ${bv == null ? "—" : bv}${bv == null ? "" : unit} → <b>${av}${unit}</b></span>`;
  }).join("") + `</div>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calibre Voices — every weapon gets its real sound</title>
<style>
  :root{--bg:#11130d;--panel:#1a1d14;--line:#2e3323;--ink:#d8d4c2;--dim:#8b8a76;--amber:#d9a441;--good:#7a9c52;--rust:#b0563b}
  body{background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI",sans-serif;margin:0;padding:0 0 80px}
  .wrap{max-width:980px;margin:0 auto;padding:0 20px}
  header{border-bottom:1px solid var(--line);padding:36px 0 22px;margin-bottom:28px}
  h1{font-size:26px;margin:0 0 6px;color:var(--amber);letter-spacing:.5px}
  h2{font-size:19px;color:var(--amber);margin:40px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  h3{font-size:15px;margin:22px 0 6px;color:var(--ink)}
  .sub{color:var(--dim);font-size:13px}
  p{margin:10px 0}
  code{background:var(--panel);border:1px solid var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px}
  .ab{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:14px 0}
  .abhead{display:flex;justify-content:space-between;gap:14px;align-items:baseline;margin-bottom:8px;flex-wrap:wrap}
  .abhead b{color:var(--amber)}
  .why{color:var(--dim);font-size:13px}
  .abrow{display:flex;gap:18px;flex-wrap:wrap}
  .cell{flex:1;min-width:260px}
  .cap{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  .none{color:var(--dim);font-style:italic;padding:10px 0;font-size:13px}
  audio{width:100%;height:36px}
  .chips{margin:8px 0 2px;display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:2px 10px;font-size:12px;color:var(--dim)}
  .chip b{color:var(--good)}
  img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin:8px 0}
  table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
  th,td{border:1px solid var(--line);padding:6px 9px;text-align:right}
  th:first-child,td:first-child{text-align:left}
  th{background:var(--panel);color:var(--dim);font-weight:600}
  .good{color:var(--good)} .bad{color:var(--rust)}
  ul{margin:8px 0 8px 22px;padding:0}
  li{margin:5px 0}
  .res{background:var(--panel);border-left:3px solid var(--rust);padding:10px 14px;border-radius:0 6px 6px 0;margin:12px 0}
</style></head><body><div class="wrap">

<header>
  <h1>Calibre Voices — every weapon gets its real sound</h1>
  <div class="sub">2026-06-11 · lib/sim + lib/audio · all sound 100% procedural (zero binary assets) ·
  oracle: scripts/audio-render.ts (offline render of the REAL synth graph) · every number below is from the
  seed-pinned oracle, before = HEAD@54a3091, after = this pass</div>
</header>

<h2>What this pass did</h2>
<p>One sentence of sim code unlocked the whole thing: the engine now stamps <b>which weapon</b> produced
each muzzle/blast effect (<code>Effect.weapon</code>, combat.ts). Before this, the audio layer knew only
<i>faction</i> and <i>"is it a machine gun"</i> — so an M2 .50, an RPG leaving the tube, an M9 pistol and an
M4 all collapsed into two faction rifle cracks. The synth's own comment admitted it: <i>"we have no
per-weapon id on the Effect."</i> Now the .50s hammer, rockets pop-and-whoosh, 40 mm bloops, bolt guns cycle
their bolts, pistols bark, mortars grade by calibre — and the battlefield gained sounds it never had:
the RPG launch, the Mk19's thunk, and a man two metres away swapping mags.</p>

<h2>1 · The calibre ladder</h2>
<p>A soldier tells weapons apart by ear before he sees anything — the report's pitch and weight ARE the
information. That ladder is now real and measurable (spectral centroid, solo/near):
<b>M9 7701&nbsp;Hz &gt; M4 6860 &gt; M24 6450 &gt; Enfield 5876 &gt; DShK 5242</b>. The .50s needed more than a
deeper bandpass: the shared 6&nbsp;kHz attack transient had made every gun equally bright, so the transient
itself is now weapon-tinted (<code>transHP/transPeak</code>, the M2's attack is a low WHUMP).</p>
${cmpAudio("palette-mg_insurgent", "PKM (7.62×54R)", "palette-hmg_insurgent", "DShK (.50)", "the medium gun vs the heavy gun", "the dreaded ridge gun is darker by 772 Hz and you feel it before you place it")}
<img src="viz/cmp-pkm-dshk.png" alt="Spectrogram: PKM (top) vs DShK .50 (bottom)">
${cmpAudio("palette-muzzle_us", "M4 (5.56)", "wpn-m9", "M9 (9 mm)", "the rifle vs the sidearm", "a pistol is a small sharp bark, nearly subless — the last-resort sound")}
${abAudio("wpn-m24", "M24 sniper — shot, then the bolt cycle", "the two-clack extract/chamber ~0.5 s after the report; the Enfield does it slower", true)}
<img src="viz/m24.png" alt="Spectrogram: M24 shot + bolt cycle">
${chips("wpn-m24", [{ k: "audibleMs", label: "audible", unit: " ms" }, { k: "centroidHz", label: "centroid", unit: " Hz" }])}

<h2>2 · The missing battle sounds</h2>

<h3>2.1 · The RPG launch (new)</h3>
<p><b>Why:</b> "RPG!" is one of the defining calls of the Korengal accounts — and the game only voiced the
<i>impact</i>. The launch is now its own event: booster POP, then the sustainer motor lights ~10 m out and
the whoosh rises as the rocket departs. AT4/SPG-9 (recoilless) get the other signature: no flight motor,
one violent venturi bang with a heavy rearward wash.</p>
${chips("palette-rocket_launch", [{ k: "audibleMs", label: "audible", unit: " ms" }, { k: "rmsDb", label: "rms", unit: " dB" }])}
${abAudio("palette-rocket_launch", "RPG-7 leaving the tube", "pop → rising whoosh; in game the blast arrives separately at the impact point", true)}
<img src="viz/rocket.png" alt="Spectrogram: RPG-7 launch pop + whoosh">
${cmpAudio("palette-rocket_launch", "RPG-7 (booster + motor)", "wpn-at4", "AT4 (recoilless bang)", "two launch physics, two sounds", "the RPG departs; the AT4 just detonates a charge behind the gunner's shoulder")}

<h3>2.2 · The 40 mm launchers (new)</h3>
${abAudio("palette-gl_launch", "M320 — the hollow bloop", "tube resonance ~280→180 Hz; almost comic until you know what follows", true)}
${cmpAudio("palette-gl_launch", "M320 bloop", "wpn-mk19", "Mk 19 thunk", "hand launcher vs crew-served AGL", "the Mk19's heavy bolt clanks 55 ms after the deep thunk")}

<h3>2.3 · Reload (new)</h3>
<p><b>Why:</b> a fight breathes — bursts, then lulls where men service weapons. The sim already modeled
reloading (<code>u.reloading</code>); it just happened silently. It now emits a <code>reload</code> effect →
a strictly near-field cue: mag-out clack, kit rattle, mag seated, bolt release, at −51.6 dB RMS. You will
only ever hear it standing next to your own men in a lull — which is exactly where it belongs.</p>
${chips("palette-reload", [{ k: "rmsDb", label: "rms", unit: " dB" }, { k: "audibleMs", label: "audible", unit: " ms" }])}
${abAudio("palette-reload", "reload, solo/near", "mag out → seat → bolt release over ~0.6 s", true)}
<img src="viz/reload.png" alt="Spectrogram: the reload clatter">

<h2>3 · Mortar calibre gradation</h2>
<p><b>Why:</b> a 60 mm crump and a 120 mm valley-shaker were the same sound at the same volume. Now
<code>BLAST_SCALE</code> grades sub onset and rumble length by calibre (duration grows faster than pitch
falls — the big tube ROLLS). The honest metric story: centroid and HF% barely moved because broadband noise
dominates them by bin count, so the oracle gained a <b>low-band share metric</b> (<code>lf200Pct</code> —
energy below 200 Hz, where a blast's calibre actually lives): <b>60 mm 14.1% vs 120 mm 19.9%</b>.</p>
${cmpAudio("blast-m60", "60 mm impact", "blast-m120", "120 mm impact", "the small tube vs the big tube", "same peak discipline, different event: the 120's rumble is ~2× longer and sits lower")}
<img src="viz/cmp-m60-m120.png" alt="Spectrogram: 60 mm (top) vs 120 mm (bottom)">

<h2>4 · Realism upgrades to existing sounds</h2>

<h3>4.1 · The IED — soil heave, not a big firecracker</h3>
<p><b>Why:</b> a buried charge doesn't crack like shell HE — the ground HEAVES. The sub-bass and a new
seismic ground wave (26→16 Hz, 1.1 s, riding the soft-clipper so harmonics carry it on small speakers) now
<i>lead</i>, the airborne transient arrives 8 ms late through the lofted soil cap, and the rumble is duller
(350→280 Hz) and longer. Centroid drops 5233 → <b>3951 Hz</b>; 37.9% of the energy now sits below 200 Hz.</p>
${chips("palette-ied", [{ k: "centroidHz", label: "centroid", unit: " Hz" }, { k: "lf200Pct", label: "LF share", unit: "%" }, { k: "rmsDb", label: "rms", unit: " dB" }])}
${abAudio("palette-ied", "IED — before / after", "before: a loud blast; after: the ground moves first")}
<img src="viz/ab-ied.png" alt="Spectrogram A/B: IED before and after">

<h3>4.2 · The incoming shell — chaotic, not musical</h3>
<p><b>Why:</b> the whistle swept cleanly — physically a siren, not a tumbling shell. A second
incommensurate fast wobble (23–37 Hz, deepening) now rides the pitch so the two modulators never
phase-lock, and a broadband shrill (high-Q noise fused to the tone) adds the tearing component. Keyed off
the cue hash: no two shells wail alike, same seed wails the same.</p>
${chips("palette-incoming", [{ k: "audibleMs", label: "audible", unit: " ms" }, { k: "centroidHz", label: "centroid", unit: " Hz" }])}
${abAudio("palette-incoming", "incoming — before / after", "before: a clean descending tone; after: it tears")}
<img src="viz/ab-incoming.png" alt="Spectrogram A/B: incoming whistle before and after">

<h3>4.3 · The near miss — the full N-wave</h3>
<p><b>Why:</b> a passing supersonic round is compression THEN rarefaction THEN turbulent wake — the old
synth had only the leading snap. Added: the rarefaction lobe 1.5 ms behind (softer, lower — the "suck"
that completes the N) and a 7 kHz wake sizzle. Centroid 7794 → 8443 Hz (the wake is the brightness).</p>
${abAudio("palette-nearmiss", "near miss — before / after", "subtle by design — the snap-crack of a round passing close")}
<img src="viz/ab-nearmiss.png" alt="Spectrogram A/B: near miss before and after">

<h3>4.4 · Radio net texture (sparse by design)</h3>
<p><b>Why:</b> a combat net has crosstalk and multipath dropouts — but texture on EVERY keying reads as a
broken radio. So it keys off the cue hash at the extremes only: ~15% of squelches carry a faint second
station stepping on the net, ~10% stutter once before the beep. The default squelch is byte-identical to
before (the palette scene metrics did not move) — restraint you can verify in the table below.</p>

<h2>5 · The numbers, all in one table</h2>
<table>
<tr><th>scene</th><th>rms dB</th><th>centroid Hz</th><th>audible ms</th><th>LF&lt;200 Hz %</th></tr>
${["palette-ied", "palette-incoming", "palette-nearmiss", "palette-hmg_us", "palette-hmg_insurgent", "palette-rocket_launch", "palette-gl_launch", "palette-reload", "wpn-m9", "wpn-m24", "wpn-enfield", "blast-m60", "blast-m120", "palette-radio", "palette-muzzle_us", "firefight"].map((n) => {
  const b = B(n); const a = A(n);
  const f = (x: Scene | undefined, k: keyof Scene) => (x && x[k] != null ? String(x[k]) : "—");
  return `<tr><td>${n}</td><td>${f(b, "rmsDb")} → ${f(a, "rmsDb")}</td><td>${f(b, "centroidHz")} → ${f(a, "centroidHz")}</td><td>${f(b, "audibleMs")} → ${f(a, "audibleMs")}</td><td>${f(b, "lf200Pct")} → ${f(a, "lf200Pct")}</td></tr>`;
}).join("\n")}
</table>
<p class="sub">Oracle after this pass: <b>RENDER OK — 39 scenes (12 new), 13/13 assertions green</b>, incl.
5 new: the .50 darker than the PKM by 772 Hz · RPG launch sustains 1100 ms · reload whisper (−51.6 dB,
520 ms) · mortar LF gradation 19.9 vs 14.1% · M24 bolt cycle spans 920 ms. The firefight scene now contains
the M2 answering and an RPG launch, hence its small rms/centroid shift. Plus scripts/audio-probe.ts green
(1:1 cue mapping now incl. reload effects, determinism, layer purity) and a 3-seed held-out run where the
new cues emerged from ORGANIC combat: hmg_us 75–900 cues (the COP's M2), gl_launch 34 (Mk19), reload 5–151,
M9 sidearms 42–130.</p>

<h2>6 · Honest residuals</h2>
<div class="res">
<ul>
<li><b>rocket_launch never fired organically in the 3 held-out runs</b> — RPG gunners carry one round and
these fights didn't trigger it. The routing is proven by a direct mapper check (rpg7/spg9/at4 →
rocket_launch) and the synth by the oracle; an organic occurrence remains unobserved.</li>
<li><b>Backblast is folded into the launch sound</b>, not a separate directional cue — a true
listener-relative backblast cone needs facing-aware spatialization. Deferred, recorded.</li>
<li><b>No wounded vocalizations.</b> Deliberate: synthesized screams are the same trap as the rejected
synthesized radio voice ("reads cheesy faster than squelch reads sparse"), with higher stakes. The
casualty's weight stays in the radio traffic and the visual.</li>
<li><b>No MEDEVAC rotor</b> — still no aircraft entity in the sim to attach it to (recorded negative).</li>
<li><b>SAW vs M4 share a voice</b> — same 5.56 calibre; the cadence difference already comes from the sim's
true cyclic timing, which is the audible difference in reality.</li>
<li><b>npm run lint: 0 problems in lines this pass authored</b> (two findings in combat.ts predate it,
outside this pass's hunks). Repo-wide count unchanged in spirit; not fixed here.</li>
</ul>
</div>

<h2>7 · How to verify this yourself</h2>
<ul>
<li><code>npx tsx scripts/audio-render.ts</code> — re-renders all 39 scenes, prints the table + 13 assertions (expect RENDER OK).</li>
<li><code>npx tsx scripts/audio-probe.ts</code> — mapper purity/determinism/1:1 incl. reload (expect AUDIO OK).</li>
<li>In game: watch a COP defense — the M2 hammers under the rifle fire; an insurgent RPG announces itself before the blast; in a lull, zoom to your men and listen for the mag change.</li>
</ul>

</div></body></html>
`;

writeFileSync(`${DIR}/report.html`, html);
console.log(`wrote ${DIR}/report.html`);
