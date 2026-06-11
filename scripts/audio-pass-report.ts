/**
 * audio-pass-report.ts — generate the 2026-06-11 sound-pass HTML report (the category mixer +
 * five audio improvements): paired before/after metrics, embedded A/B audio samples, the
 * spectrogram visuals, and the mixer screenshot.
 *
 *   npx tsx scripts/audio-pass-report.ts
 *
 * Reads docs/progress/2026-06-11-sound-pass/{baseline,after}/metrics.json + viz/*.png +
 * mixer-popover.png and writes report.html into the same folder. Media is referenced by
 * RELATIVE path so the folder is portable (the publish-report flow copies it whole). The
 * report is a pure function of the captured data — re-run it any time the metrics change.
 */
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "docs/progress/2026-06-11-sound-pass";
type Scene = {
  name: string; peakDb: number; rmsDb: number; lufs: number; crestDb: number; centroidHz: number;
  stereoCorr: number; widthPct: number; tailMs: number; audibleMs: number; loudWindowDb?: number;
  hf4kPct?: number; note: string;
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

/** Compact before→after metric chips for a scene. */
function chips(name: string, keys: { k: keyof Scene; label: string; unit: string }[]): string {
  const b = B(name); const a = A(name);
  return `<div class="chips">` + keys.map(({ k, label, unit }) => {
    const bv = b ? (b[k] as number) : null; const av = a[k] as number;
    return `<span class="chip">${esc(label)}: ${bv === null ? "—" : bv}${bv === null ? "" : unit} → <b>${av}${unit}</b></span>`;
  }).join("") + `</div>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sound Pass — the category mixer + five audible improvements</title>
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
  <h1>Sound Pass — the category mixer + five audible improvements</h1>
  <div class="sub">2026-06-11 · lib/audio · all sound 100% procedural (zero binary assets) · oracle: scripts/audio-render.ts (offline render of the REAL synth graph) · every number below is from the seed-pinned oracle, before = HEAD, after = this pass</div>
</header>

<h2>What this pass did</h2>
<p>Two deliverables. <b>One:</b> a per-category <b>sound mixer</b> — combat, ambience, radio, and alerts each
get an on/off toggle and a volume slider, persisted per device. <b>Two:</b> five improvements to the audio
itself, each grounded in either a recorded residual of the 2026-06-07 soundscape campaign or a missing
battlefield signature — and each verified by the offline oracle as a number, not a vibe.</p>

<h2>1 · The sound mixer</h2>
<p>The engine already had four submix buses; the mixer inserts a user gain <i>between each bus and master</i>
(<code>bus → category → master</code>, lib/audio/player.ts). That placement is the design decision: the
contact-duck system writes absolute values to the <i>bus</i> gains, so putting the user's trim on a separate
downstream node means ducking and user preference multiply instead of fighting. Two consequences worth
knowing: the shared valley-reverb return is routed into the <b>combat</b> category (only combat sounds feed
it — muting combat must also mute its echo, not leave a disembodied tail), and the danger-close klaxon moved
from the combat bus to the <b>alerts</b> bus where it semantically belongs (it is a command-channel warning,
not battlefield sound) with trims re-balanced so its absolute level is unchanged.</p>
<img src="mixer-popover.png" alt="The sound mixer popover: per-category toggle + slider" style="max-width:300px">
<p class="sub">Live-verified end to end: UI toggle → store → engine gain (ambience 0.000, combat 0.500) →
localStorage <code>itm-ui-v1</code> → survives reload. The oracle re-render after the re-routing showed all
24 scenes within 0.15 dB of baseline — the mixer's plumbing is level-neutral by construction.</p>

<h2>2 · The five audio improvements</h2>

<h3>2.1 · The incoming-shell whistle (new battlefield signature)</h3>
<p><b>Why:</b> indirect fire had a tube report ("shot") and an impact ("splash") but nothing in between —
yet the 2–3 seconds of descending shriek before a mortar round lands is the single most recognizable
indirect-fire experience in every first-hand account. The sim already counts down <code>FireMission.etaS</code>
each tick, so the mapper now voices one whistle per mission, deterministically, 2.4 s before the first round
(<code>INCOMING_LEAD_S</code>, lib/audio/mapper.ts) — the whistle ends exactly as the blast arrives. The synth
is a triangle sweep (~1.3 kHz → 320 Hz) with a flutter that deepens as the round closes, plus a swept-noise
whoosh an octave up, under a swelling envelope: the swell is the dread.</p>
${chips("palette-incoming", [{ k: "audibleMs", label: "audible", unit: " ms" }, { k: "stereoCorr", label: "corr", unit: "" }, { k: "rmsDb", label: "rms", unit: " dB" }])}
${abAudio("palette-incoming", "incoming — the shell whistle, solo", "2.26 s of descending whistle; in the game it always ends in a blast", true)}
<img src="viz/incoming.png" alt="Spectrogram: the descending incoming whistle">
${abAudio("firefight", "the full firefight scene", "listen at ~8 s: shot → whistle → splash → danger-close klaxon, inside a sustained TIC")}

<h3>2.2 · Calm-bed stereo width (the recorded residual)</h3>
<p><b>Why:</b> the 2026-06-07 campaign shipped the living valley bed but recorded its own gap: the calm
scene measured <b>corr 0.997 / width 4%</b> — effectively mono. The fix was less about panning and more
about a subtlety of synthesis: all bed voices loop <i>one shared noise buffer</i>, and two in-phase filters
of the same source stay correlated <i>no matter how you pan them</i>. Each voice now starts at a different
<b>offset into the loop</b> (noise autocorrelation dies in samples, so offset reads are genuinely
uncorrelated), and then the panning does real work: the river splits into two band voices (950 / 1900 Hz,
the bird-band notch preserved) straddling the river's actual screen bearing, the generator pans to the COP's
bearing, rain is Haas-widened (13 ms), and the wind howl spreads ±0.5.</p>
${chips("ambient-calm", [{ k: "widthPct", label: "width", unit: "%" }, { k: "stereoCorr", label: "corr", unit: "" }, { k: "rmsDb", label: "rms", unit: " dB" }])}
${abAudio("ambient-calm", "ambient-calm — a clear day at the COP", "wind, river, generator, birds; the width is the change — use headphones")}
${abAudio("ambient-night", "ambient-night — katabatic wind, crickets, the lone dog", "same width mechanism on the night bed")}
<img src="viz/ab-ambient-calm.png" alt="Spectrogram A/B: ambient-calm before and after">

<h3>2.3 · Thunder (new — the storm finally sounds like one)</h3>
<p><b>Why:</b> Rain weather had a hiss bed and droplet ticks but no thunder — a Kunar mountain storm without
its defining sound. A new Poisson spot layer (λ = 0.022/s, Rain only) builds each roll as a mid-frequency
strike head that darkens into a brown-noise rumble with 2–3 swells, answered ~0.6 s later by a quieter roll
panned to the <i>opposite</i> quarter — the sound crossing the valley. Deliberately <b>not</b> gated by
contact: a firefight silences the birds, never the sky.</p>
${chips("ambient-storm", [{ k: "rmsDb", label: "rms", unit: " dB" }, { k: "widthPct", label: "width", unit: "%" }, { k: "tailMs", label: "tail", unit: " ms" }])}
${abAudio("ambient-storm", "ambient-storm — rain bed + a thunder roll", "the roll arrives at ~1.2 s from the left, answers from the right", true)}
<img src="viz/storm.png" alt="Spectrogram: the storm scene">

<h3>2.4 · The adhan gets a voice</h3>
<p><b>Why:</b> the call to prayer is formant-filtered sawtooth with a programmed melisma — but a held note
with mathematically flat pitch reads as a slide whistle, not a human voice. A 5.3 Hz vibrato (depth 2.5% of
the base pitch) fading in over the first second is the classic synthesis tell of a singing voice, and it
does more for realism than any filter change.</p>
${chips("spot-adhan", [{ k: "rmsDb", label: "rms", unit: " dB" }, { k: "centroidHz", label: "centroid", unit: " Hz" }, { k: "audibleMs", label: "audible", unit: " ms" }])}
${abAudio("spot-adhan", "the adhan from the village (dusk, panned east)", "a new oracle scene — the baseline render had no adhan sample to compare", true)}
<img src="viz/adhan.png" alt="Spectrogram: the adhan with vibrato">

<h3>2.5 · Ricochet variety</h3>
<p><b>Why:</b> every deflection played the identical zing — the most repetitive sound in a long firefight.
Three deterministic timbre families now key off the cue's hash (<code>cue.v</code>): the classic singing
<b>zing</b> (~45% of rounds), a short hard fast-tumbling <b>buzz</b> (~30%), and a rarer high thin
<b>whine</b> with a long fall (~25%) — plus an impact tick grounding each one in a hit. Same mechanism,
three parameterizations; same seed still gives the same firefight.</p>
${chips("palette-ricochet", [{ k: "audibleMs", label: "audible", unit: " ms" }, { k: "centroidHz", label: "centroid", unit: " Hz" }])}
${abAudio("palette-ricochet", "ricochet (the v=0.5 family — the new buzz)", "the palette renders one family; all three appear in the firefight scene")}
<img src="viz/ab-ricochet.png" alt="Spectrogram A/B: ricochet before and after">

<h2>3 · The numbers, all in one table</h2>
<table>
<tr><th>scene</th><th>rms dB</th><th>corr</th><th>width %</th><th>tail ms</th><th>audible ms</th></tr>
${["ambient-calm", "ambient-night", "ambient-storm", "spot-adhan", "palette-incoming", "palette-ricochet", "firefight", "distant", "occlusion-ridge"].map((n) => {
  const b = B(n); const a = A(n);
  const f = (x: Scene | undefined, k: keyof Scene) => (x ? String(x[k]) : "—");
  return `<tr><td>${n}</td><td>${f(b, "rmsDb")} → ${f(a, "rmsDb")}</td><td>${f(b, "stereoCorr")} → ${f(a, "stereoCorr")}</td><td>${f(b, "widthPct")} → ${f(a, "widthPct")}</td><td>${f(b, "tailMs")} → ${f(a, "tailMs")}</td><td>${f(b, "audibleMs")} → ${f(a, "audibleMs")}</td></tr>`;
}).join("\n")}
</table>
<p class="sub">Oracle assertions after this pass — all green: no clipping (busiest scene −2.8 dBFS) ·
calm→combat dynamic spread 25.8 dB (was 23.0) · ambient bed alive (−45.5 dB) · firefight corr 0.48 ·
occlusion 6.6 dB / HF 30.8% vs 40.9% · <b>calm width 12.4% (was 4%)</b> · storm alive ·
whistle sustains 2.26 s. Plus scripts/audio-probe.ts green (mapper purity, 1:1 cue mapping, determinism,
layer law) — incoming now part of its coverage set.</p>

<h2>4 · Honest residuals</h2>
<div class="res">
<ul>
<li><b>Calm bed is ~2.9 dB quieter than before</b> (−42.6 → −45.5 dB): the band-split river sums a little
quieter than the old single wide band. Still comfortably inside the oracle's alive band (−60..−28) and the
dynamic-spread number <i>improved</i>, but if the valley feels too quiet in play, the river group gain
(ambient.ts, <code>mix.river.gain × 0.7</code>) is the one knob to turn.</li>
<li><b>No MEDEVAC helicopter.</b> Evacuation is instantaneous in the sim (<code>u.evac = true</code> —
no aircraft entity exists, combat.ts:1659), so a rotor loop has nothing to attach to. Deliberately NOT
faked with a timer in the audio layer; recorded as deferred work that needs a sim-side entity first.</li>
<li><b>One whistle per fire mission, not per round.</b> A multi-round barrage announces once;
later rounds land on the gun's interval unannounced. Per-round whistles are doable off
<code>nextRoundS</code> but read as noise in testing scenes with 4-round missions.</li>
<li><b>The oracle does not model the category gains</b> (they default to unity, which is what it renders).
If category defaults ever change from 1.0, add them to the mirror in scripts/audio-render.ts.</li>
<li><b>npm run lint reports 267 pre-existing problems repo-wide</b> (none in lines this pass authored —
the three in touched files are in WorldView.tsx code that predates it). Not fixed here; out of scope.</li>
</ul>
</div>

<h2>5 · How to verify this yourself</h2>
<ul>
<li><code>npx tsx scripts/audio-render.ts /tmp/check</code> — re-renders all 27 scenes, prints the table + assertions (expect RENDER OK).</li>
<li><code>npx tsx scripts/audio-probe.ts</code> — mapper purity/determinism/coverage (expect AUDIO OK).</li>
<li>In game: the 🎚 button in the command bar's audio cluster opens the mixer; prefs persist per device.</li>
</ul>

</div></body></html>
`;

writeFileSync(`${DIR}/report.html`, html);
console.log(`wrote ${DIR}/report.html`);
