/**
 * audio-render.ts — the HEADLESS AUDIO ORACLE.
 *
 *   npx tsx scripts/audio-render.ts [outDir=docs/progress/_audio-latest]
 *
 * "No fix without a number" (Law 1) applied to SOUND. Audio quality is normally judged by ear;
 * this harness renders the REAL synth graph offline to PCM and turns each scene into objective,
 * A/B-able numbers AND a listenable .wav. It is the instrument behind every "20x" claim.
 *
 * HOW IT STAYS HONEST (Law 4 — the oracle must obey the mover's real rules):
 *   • timbre comes from the live `synthCue`/`isPositional` (lib/audio/synth.ts).
 *   • spatialization comes from the live, pure `computeSpatial` + `KIND_TRIM`/`KIND_WET` (player.ts).
 *   • the full STATIC signal path here MIRRORS player.ts `unlock()`/`schedule()`: master→limiter,
 *     combat/atmos/radio(in-handset chain)/score buses, the shared valley convolver with per-cue
 *     wet sends (HP+preDelay), occlusion 2nd-pole lowpass, elevation shelf, the near-miss tail —
 *     and the 32-voice cap WITH RETIREMENT (voices free their slot when they end, so a long scene
 *     plays all its cues, not just the first 32). Each block is tagged `// MIRRORS player.ts`.
 *   • the real `AmbientEngine` renders the bed for the calm scenes.
 *   NOT modeled (time-evolving, verified live + by the firefight/spread metrics): the HDR window,
 *   control-side ducking, and priority voice-stealing — the oracle measures the signal path that
 *   carries timbre/reverb/width/occlusion/loudness. If unlock()/schedule() change, update both.
 * It renders through node-web-audio-api's OfflineAudioContext — the SAME Web Audio nodes the
 * browser runs — so the measured signal is what a player would actually hear.
 *
 * METRICS (per scene, all deterministic given the deterministic cue list):
 *   peakDb     — true-peak of the float buffer in dBFS (>0 would mean inter-sample clip risk;
 *                we measure pre-clip so overload is visible even though the .wav is hard-clipped).
 *   rmsDb      — gated RMS level (dBFS) over audible blocks — overall energy.
 *   lufs       — ITU-R BS.1770 K-weighted integrated loudness (approx; -70 LUFS abs gate,
 *                400 ms blocks) — the perceptual loudness used to compare mixes fairly.
 *   crestDb    — peak − rms: transient sharpness (a gunshot wants a HIGH crest; mud is low).
 *   centroidHz — spectral centroid (brightness) averaged over audible windows.
 *   stereoCorr — L/R Pearson correlation (1 = mono, 0 = wide, <0 = anti-phase).
 *   widthPct   — side/(mid+side) energy as a percent — the size of the stereo image.
 *   tailMs     — decay time from peak down to −40 dBFS (a reverb / sustain proxy).
 *   audibleMs  — time the signal sits above the −60 dBFS noise floor.
 * It also dumps a downsampled waveform envelope + an averaged log-spaced spectrum per scene into
 * metrics.json so the HTML report can draw charts without re-rendering.
 *
 * SCENES: a per-cue "palette" (every CueKind solo), a dense "firefight" (mix-under-load: clipping /
 * width / dynamic spread), a "distant" high-ground burst (pan + air-absorption + reverb + crack/thump
 * split), an "occlusion-open" vs "occlusion-ridge" pair (terrain LOS muffling), and "ambient-calm"
 * / "ambient-night" (the living valley bed — SILENT on HEAD; the single biggest 20x gap).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { OfflineAudioContext } from "node-web-audio-api";
import { synthCue, isPositional } from "../lib/audio/synth";
import { computeSpatial, KIND_TRIM, KIND_WET, type TerrainProbe, type AmbientEnv } from "../lib/audio/player";
import { createValleyReverb } from "../lib/audio/reverb";
import { AmbientEngine, type AmbientSignals } from "../lib/audio/ambient";
import type { AudioCue, CueKind } from "../lib/audio/cue";
import type { Camera } from "../lib/render/topo";

// node-web-audio-api's OfflineAudioContext is structurally a Web Audio BaseAudioContext; the
// DOM lib types and the package's own types describe the same runtime. Cast at the boundary.
type Ctx = AudioContext;
const SR = 48000;
const MAX_VOICES = 32; // MIRRORS player.ts MAX_VOICES
const MASTER = 0.6; // MIRRORS player.ts DEFAULT_VOLUME
const dbToLin = (db: number) => Math.pow(10, db / 20);
const BUS_TRIM = { combat: dbToLin(0), atmos: dbToLin(-20), radio: dbToLin(-3), score: dbToLin(0) }; // MIRRORS player.ts
// NOTE the category mixer (bus → category → master, player.ts cats) is all-unity by default, so
// the oracle renders the default mix without modeling it; if category defaults ever change, add it.

// ----------------------------------------------------------------------------- scene model
interface TimedCue {
  cue: AudioCue;
  at: number; // seconds into the scene
}
interface Scene {
  name: string;
  durationS: number;
  cam: Camera;
  cues: TimedCue[];
  note: string;
  terrain?: TerrainProbe; // optional synthetic terrain for the occlusion scene
  /** optional ambient bed: render the real AmbientEngine with this env over the scene. */
  ambient?: AmbientEnv;
  /** optional direct spot/adhan auditions (engine.audition) — for sampling rare events
   *  (thunder, the adhan) that Poisson/prayer scheduling won't reliably hit in a short render. */
  audition?: { layer: "birds" | "insects" | "dogs" | "drops" | "thunder" | "adhan"; at: number; h?: number; pan?: number }[];
}

/** A tactical listener pose: centered on the COP, mid zoom. ~853 m half-width audible ref. */
function cam(cx = 1280, cy = 1280, ppm = 0.75): Camera {
  return { cx, cy, ppm, vw: 1280, vh: 720 };
}

const ALL_KINDS: CueKind[] = [
  "muzzle_us", "muzzle_insurgent", "mg_us", "mg_insurgent", "impact", "ricochet", "nearmiss",
  "blast_small", "blast_large", "ied", "smoke_pop", "frag_air", "flare", "radio", "shot",
  "incoming", "splash", "dangerclose", "tic_sting",
];

// ----------------------------------------------------------------------------- render
/**
 * Render one scene to a stereo pair through the real synth + spatializer + bus graph.
 * MIRRORS the STATIC signal path of AudioEngine.schedule()/unlock(): per-cue chain
 * cueGain(sp.gain*cue.gain*trim) → lowpass(sp.cutoff) → [elev highshelf] → pan → combatBus,
 * a parallel reverb send (sp.wet*KIND_WET → HP300 → preDelay → shared convolver → master),
 * radio→radio-chain bus, tic_sting→score bus, all → master → limiter → destination, plus the
 * distant near-miss tail. The DYNAMIC mix (HDR window, ducking, voice-stealing) is time-evolving
 * and verified live + by the firefight/spread metrics — the oracle measures the signal path that
 * carries timbre/reverb/width/occlusion/loudness. If schedule()/unlock() change, update here.
 */
async function renderScene(scene: Scene): Promise<{ L: Float32Array; R: Float32Array; sr: number }> {
  const frames = Math.ceil(scene.durationS * SR) + Math.ceil(2.5 * SR); // tail headroom for reverb
  const octx = new OfflineAudioContext(2, frames, SR);
  const ctx = octx as unknown as Ctx;

  // master → limiter → destination
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; // MIRRORS player.ts
  limiter.attack.value = 0.001; limiter.release.value = 0.25;
  limiter.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(limiter);

  const mkBus = (trim: number) => { const g = ctx.createGain(); g.gain.value = trim; g.connect(master); return g; };
  const combatBus = mkBus(BUS_TRIM.combat);
  const scoreBus = mkBus(BUS_TRIM.score);
  const atmosBus = mkBus(BUS_TRIM.atmos);
  // radio in-handset chain bus (MIRRORS player.makeRadioBus)
  const radioBus = ctx.createGain(); radioBus.gain.value = BUS_TRIM.radio;
  {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 550; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    const sh = ctx.createWaveShaper(); const cv = new Float32Array(257);
    for (let i = 0; i < 257; i++) cv[i] = Math.tanh(((i / 256) * 2 - 1) * 1.6); sh.curve = cv;
    const cp = ctx.createDynamicsCompressor(); cp.threshold.value = -30; cp.ratio.value = 14; cp.attack.value = 0.003; cp.release.value = 0.1;
    const pk = ctx.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 1500; pk.Q.value = 1.2; pk.gain.value = 6;
    radioBus.connect(hp).connect(lp).connect(sh).connect(cp).connect(pk).connect(master);
  }
  const reverb = createValleyReverb(ctx, { seed: 0x4b4f52, rt60: 1.8 });
  reverb.output.connect(master);

  const busFor = (k: CueKind) => (k === "radio" ? radioBus : k === "tic_sting" || k === "dangerclose" ? scoreBus : combatBus); // MIRRORS player.busFor
  const sendReverb = (srcGain: GainNode, wet: number, preDelay: number) => {
    if (!(wet > 0.001)) return;
    const send = ctx.createGain(); send.gain.value = wet;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 300;
    const pre = ctx.createDelay(0.2); pre.delayTime.value = preDelay;
    srcGain.connect(send).connect(hp).connect(pre).connect(reverb.input);
  };

  // ambient bed (the real engine) — present for the calm scene
  if (scene.ambient) {
    const amb = new AmbientEngine(ctx, atmosBus);
    const sig = ambientSignalsFor(scene.ambient);
    const step = 0.1;
    for (let t = 0; t < scene.durationS; t += step) {
      amb.update(sig, step, { running: true, paused: false, warp: false });
    }
    // direct auditions (thunder/adhan samples) at explicit scene times.
    for (const a of scene.audition ?? []) amb.audition(a.layer, a.at, a.h ?? 0.5, a.pan ?? 0);
  }

  // Voice budget MIRRORS the live engine's RETIREMENT: voices free their slot when they finish, so
  // a long scene plays all its cues (not just the first MAX_VOICES). Track active end-times; prune
  // those that ended before this cue starts, then admit if under the cap. Cues are processed in
  // start-time order so the prune is monotonic (Adversarial Finding 1).
  const ends: number[] = [];
  const admit = (at: number): boolean => {
    for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= at) ends.splice(i, 1);
    if (ends.length >= MAX_VOICES) return false;
    return true;
  };
  for (const tc of [...scene.cues].sort((a, b) => a.at - b.at)) {
    const sp = computeSpatial(tc.cue, scene.cam, scene.terrain);
    if (!sp) continue;
    if (!admit(tc.at)) continue;
    const k = tc.cue.kind;

    const cueGain = ctx.createGain();
    cueGain.gain.value = sp.gain * tc.cue.gain * KIND_TRIM[k];
    let node: AudioNode = cueGain;
    if (isPositional(k)) { // single source of truth — exactly the live engine's branch (Finding 2)
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = sp.cutoff;
      node = node.connect(lp);
      if (sp.occ > 0.35) { const lp2 = ctx.createBiquadFilter(); lp2.type = "lowpass"; lp2.frequency.value = sp.cutoff; node = node.connect(lp2); }
      if (Math.abs(sp.shelfDb) > 0.5) {
        const shf = ctx.createBiquadFilter(); shf.type = "highshelf"; shf.frequency.value = 5000; shf.gain.value = sp.shelfDb;
        node = node.connect(shf);
      }
      const pan = ctx.createStereoPanner(); pan.pan.value = sp.pan;
      node = node.connect(pan);
    }
    node.connect(busFor(k));
    sendReverb(cueGain, sp.wet * KIND_WET[k], sp.preDelay);
    ends.push(synthCue(ctx, cueGain, tc.cue, sp, tc.at).endTime);

    if (sp.split && (k === "muzzle_us" || k === "muzzle_insurgent" || k === "mg_us" || k === "mg_insurgent") && admit(tc.at)) {
      const g = ctx.createGain(); g.gain.value = sp.gain * 0.6 * KIND_TRIM.nearmiss;
      const tpan = ctx.createStereoPanner(); tpan.pan.value = sp.pan;
      g.connect(tpan).connect(combatBus);
      sendReverb(g, sp.wet * KIND_WET.nearmiss, sp.preDelay);
      ends.push(synthCue(ctx, g, { ...tc.cue, kind: "nearmiss" }, sp, tc.at).endTime);
    }
  }

  const buf = await octx.startRendering();
  return { L: buf.getChannelData(0) as Float32Array, R: buf.getChannelData(1) as Float32Array, sr: SR };
}

/** Build AmbientSignals from a scene's env + camera (the COP at the camera center, a village to one
 *  side, a river to the other) so the oracle's ambient bed has plausible positional layers. */
function ambientSignalsFor(env: AmbientEnv): AmbientSignals {
  return {
    secondsOfDay: env.secondsOfDay, solar: env.solar, isNight: env.isNight,
    windSpeed: env.windSpeed, weatherLabel: env.weatherLabel, precip: env.precip, inContact: env.inContact,
    copDist: 40, copPan: 0, villageDist: 220, villagePan: 0.5, riverDist: 90, riverPan: -0.4,
  };
}

// ----------------------------------------------------------------------------- DSP helpers
/** In-place iterative radix-2 FFT (re/im). Length must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Direct-form-I biquad applied to a copy of x. coeffs (b0,b1,b2,a1,a2) with a0 normalized. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xn; y2 = y1; y1 = yn;
    y[i] = yn;
  }
  return y;
}

/** ITU-R BS.1770 K-weighting: a high-shelf "head" filter then an RLB high-pass (RBJ forms). */
function kWeight(x: Float32Array, sr: number): Float32Array {
  // Stage 1: high shelf, f0≈1681.97 Hz, +3.999 dB, Q≈0.7071 (RBJ high-shelf).
  {
    const f0 = 1681.974, Q = 0.7071752, A = Math.pow(10, 3.999843 / 40);
    const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q), tsa = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cw + tsa;
    const b0 = (A * ((A + 1) + (A - 1) * cw + tsa)) / a0;
    const b1 = (-2 * A * ((A - 1) + (A + 1) * cw)) / a0;
    const b2 = (A * ((A + 1) + (A - 1) * cw - tsa)) / a0;
    const a1 = (2 * ((A - 1) - (A + 1) * cw)) / a0;
    const a2 = ((A + 1) - (A - 1) * cw - tsa) / a0;
    x = biquad(x, b0, b1, b2, a1, a2);
  }
  // Stage 2: RLB high-pass, f0≈38.135 Hz, Q≈0.5003 (RBJ high-pass).
  {
    const f0 = 38.13547, Q = 0.5003271;
    const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    const a0 = 1 + alpha;
    const b0 = ((1 + cw) / 2) / a0, b1 = (-(1 + cw)) / a0, b2 = ((1 + cw) / 2) / a0;
    const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
    x = biquad(x, b0, b1, b2, a1, a2);
  }
  return x;
}

const db = (lin: number) => (lin <= 1e-9 ? -120 : 20 * Math.log10(lin));

// ----------------------------------------------------------------------------- metrics
export interface SceneMetrics {
  name: string;
  durationS: number;
  peakDb: number;
  rmsDb: number;
  lufs: number;
  crestDb: number;
  centroidHz: number;
  stereoCorr: number;
  widthPct: number;
  tailMs: number;
  audibleMs: number;
  loudWindowDb: number; // loudest 1 s window RMS (dBFS) — the "how loud does it GET" measure
  hf4kPct: number; // % of spectral energy above 4 kHz (brightness / occlusion probe)
  note: string;
  /** downsampled |peak| envelope (mono max of L/R), 0..1, for the report waveform chart. */
  envelope: number[];
  /** averaged magnitude spectrum, 48 log-spaced bins 30 Hz–18 kHz, normalized 0..1. */
  spectrum: number[];
}

function metrics(name: string, durationS: number, note: string, L: Float32Array, R: Float32Array, sr: number): SceneMetrics {
  const n = L.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

  // peak (float, pre-clip)
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));

  // gated RMS over the audible region (above -60 dBFS in 20 ms windows)
  const floor = Math.pow(10, -60 / 20);
  const win = Math.floor(sr * 0.02);
  let sumSq = 0, cntSq = 0, firstAud = -1, lastAud = -1;
  for (let s = 0; s < n; s += win) {
    let e = 0; const end = Math.min(n, s + win);
    for (let i = s; i < end; i++) e += mono[i] * mono[i];
    const rms = Math.sqrt(e / (end - s));
    if (rms > floor) {
      sumSq += e; cntSq += end - s;
      if (firstAud < 0) firstAud = s;
      lastAud = end;
    }
  }
  const rms = cntSq ? Math.sqrt(sumSq / cntSq) : 0;
  const audibleMs = firstAud < 0 ? 0 : ((lastAud - firstAud) / sr) * 1000;

  // loudest 1 s window RMS — captures combat's PEAK loudness (not dragged down by inter-shot gaps).
  let loudWindow = 0;
  const lw = Math.floor(sr * 1.0);
  if (n >= lw) {
    let e = 0;
    for (let i = 0; i < lw; i++) e += mono[i] * mono[i];
    let best = e;
    for (let i = lw; i < n; i++) { e += mono[i] * mono[i] - mono[i - lw] * mono[i - lw]; if (e > best) best = e; }
    loudWindow = Math.sqrt(best / lw);
  } else loudWindow = rms;

  // LUFS (K-weighted, 400 ms blocks, -70 LUFS absolute gate)
  const lk = kWeight(L, sr), rk = kWeight(R, sr);
  const block = Math.floor(sr * 0.4);
  const blockLoud: number[] = [];
  for (let s = 0; s + block <= n; s += block) {
    let ms = 0;
    for (let i = s; i < s + block; i++) ms += lk[i] * lk[i] + rk[i] * rk[i];
    ms /= block; // sum of channel mean-squares
    const lufs = -0.691 + 10 * Math.log10(ms + 1e-12);
    if (lufs > -70) blockLoud.push(ms);
  }
  const meanMs = blockLoud.length ? blockLoud.reduce((a, b) => a + b, 0) / blockLoud.length : 0;
  const lufs = blockLoud.length ? -0.691 + 10 * Math.log10(meanMs + 1e-12) : -120;

  // spectral centroid averaged over audible Hann windows. Short cues (audible region < FFT, e.g.
  // a 40 ms muzzle) get ONE zero-padded window over [firstAud,lastAud] so brightness is never 0.
  const FFT = 4096;
  const reC = new Float32Array(FFT), imC = new Float32Array(FFT);
  let cWeighted = 0, cTotal = 0;
  const specAccum = new Float64Array(FFT / 2);
  let specWindows = 0;
  const aStart = Math.max(0, firstAud), aStop = lastAud > 0 ? lastAud : n;
  const doFFT = (s: number, len: number) => {
    reC.fill(0); imC.fill(0);
    let e = 0;
    for (let i = 0; i < len; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)); reC[i] = mono[s + i] * w; e += mono[s + i] * mono[s + i]; }
    if (Math.sqrt(e / Math.max(1, len)) < floor) return;
    fft(reC, imC);
    let num = 0, den = 0;
    for (let k = 1; k < FFT / 2; k++) {
      const mag = Math.hypot(reC[k], imC[k]);
      num += ((k * sr) / FFT) * mag; den += mag; specAccum[k] += mag;
    }
    if (den > 0) { cWeighted += num / den; cTotal++; }
    specWindows++;
  };
  if (aStop - aStart >= FFT) {
    for (let s = aStart; s + FFT <= aStop; s += FFT) doFFT(s, FFT);
  } else if (aStop > aStart) {
    doFFT(aStart, aStop - aStart); // zero-padded single window for short cues
  }
  const centroidHz = cTotal ? cWeighted / cTotal : 0;

  // stereo correlation + width (over audible region)
  let sL = 0, sR = 0, sLR = 0, sLL = 0, sRR = 0, mid = 0, side = 0, cc = 0;
  const a0 = Math.max(0, firstAud), a1 = lastAud > 0 ? lastAud : n;
  for (let i = a0; i < a1; i++) {
    sL += L[i]; sR += R[i]; cc++;
  }
  const mL = cc ? sL / cc : 0, mR = cc ? sR / cc : 0;
  for (let i = a0; i < a1; i++) {
    const dl = L[i] - mL, dr = R[i] - mR;
    sLR += dl * dr; sLL += dl * dl; sRR += dr * dr;
    const m = (L[i] + R[i]) * 0.5, sd = (L[i] - R[i]) * 0.5;
    mid += m * m; side += sd * sd;
  }
  const stereoCorr = sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : 1;
  const widthPct = mid + side > 0 ? (Math.sqrt(side) / (Math.sqrt(mid) + Math.sqrt(side))) * 100 : 0;

  // tail: peak → -40 dBFS decay time (reverb / sustain proxy)
  let peakIdx = 0, pk = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > pk) { pk = a; peakIdx = i; } }
  const tailThresh = pk * Math.pow(10, -40 / 20);
  let tailEnd = peakIdx;
  const tw = Math.floor(sr * 0.01);
  for (let s = peakIdx; s + tw <= n; s += tw) {
    let e = 0; for (let i = s; i < s + tw; i++) e += mono[i] * mono[i];
    if (Math.sqrt(e / tw) > tailThresh) tailEnd = s + tw;
  }
  const tailMs = ((tailEnd - peakIdx) / sr) * 1000;

  // downsampled envelope (600 bins, peak per bin)
  const EB = 600;
  const envelope: number[] = new Array(EB).fill(0);
  const bs = Math.max(1, Math.floor(n / EB));
  for (let b = 0; b < EB; b++) {
    let m = 0; const s = b * bs, e = Math.min(n, s + bs);
    for (let i = s; i < e; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    envelope[b] = +m.toFixed(4);
  }

  // averaged spectrum → 48 log bins (30 Hz .. 18 kHz), normalized
  const SB = 48, fMin = 30, fMax = 18000;
  const spectrum: number[] = new Array(SB).fill(0);
  if (specWindows > 0) {
    for (let bi = 0; bi < SB; bi++) {
      const f0 = fMin * Math.pow(fMax / fMin, bi / SB), f1 = fMin * Math.pow(fMax / fMin, (bi + 1) / SB);
      const k0 = Math.max(1, Math.floor((f0 * FFT) / sr)), k1 = Math.min(FFT / 2, Math.ceil((f1 * FFT) / sr));
      let m = 0, c = 0;
      for (let k = k0; k < k1; k++) { m += specAccum[k]; c++; }
      spectrum[bi] = c ? m / c : 0;
    }
    const mx = Math.max(...spectrum, 1e-9);
    for (let i = 0; i < SB; i++) spectrum[i] = +(spectrum[i] / mx).toFixed(4);
  }

  // HF ratio: fraction of spectral energy above 4 kHz (brightness; drops hard under occlusion).
  let hfNum = 0, hfDen = 0;
  for (let k = 1; k < FFT / 2; k++) { const f = (k * sr) / FFT; hfDen += specAccum[k]; if (f >= 4000) hfNum += specAccum[k]; }
  const hf4kPct = hfDen > 0 ? (hfNum / hfDen) * 100 : 0;

  return {
    name, durationS, note,
    peakDb: +db(peak).toFixed(2), rmsDb: +db(rms).toFixed(2), lufs: +lufs.toFixed(2),
    crestDb: +(db(peak) - db(rms)).toFixed(2), centroidHz: Math.round(centroidHz),
    stereoCorr: +stereoCorr.toFixed(3), widthPct: +widthPct.toFixed(1),
    tailMs: Math.round(tailMs), audibleMs: Math.round(audibleMs),
    loudWindowDb: +db(loudWindow).toFixed(2), hf4kPct: +hf4kPct.toFixed(2),
    envelope, spectrum,
  };
}

// ----------------------------------------------------------------------------- WAV
function writeWav(path: string, L: Float32Array, R: Float32Array, sr: number): void {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
    buf.writeInt16LE((l * 32767) | 0, o); buf.writeInt16LE((r * 32767) | 0, o + 2); o += 4;
  }
  writeFileSync(path, buf);
}

// ----------------------------------------------------------------------------- scenes
function cue(kind: CueKind, opts: Partial<AudioCue> = {}): AudioCue {
  return { kind, v: 0.5, gain: 1, srcId: 0, srcStream: "fx", ...opts };
}

function paletteScenes(): Scene[] {
  // each kind solo, the source AT the camera (pan 0, near) so we measure pure timbre.
  return ALL_KINDS.map((k) => ({
    name: `palette-${k}`,
    durationS: k === "tic_sting" ? 3.4 : k === "incoming" ? 3.0 : k === "dangerclose" ? 1.2 : 1.2,
    cam: cam(),
    note: `solo ${k}, centered/near`,
    cues: [{ at: 0.05, cue: cue(k, { pos: { x: 1280, y: 1280 } }) }],
  }));
}

function firefightScene(): Scene {
  // a dense 30-man-ish TIC: outgoing from the COP (center), incoming from a ridge to the right,
  // an RPG, the radio net, an enemy mortar (shot→splash→dangerclose), the contact sting.
  const c = cam();
  const L = (d: number) => ({ x: 1280 - d, y: 1280 });
  const Rt = (d: number) => ({ x: 1280 + d, y: 1180 });
  const cues: TimedCue[] = [];
  cues.push({ at: 0.0, cue: cue("tic_sting", {}) });
  // a sustained TIC — multiple shooters trading fire at once (a real firefight is not one shot at
  // a time): US squad from the left flank, insurgents from the right ridge, overlapping bursts.
  for (let i = 0; i < 56; i++) {
    const t = 0.6 + i * 0.3;
    const us = i % 2 === 0;
    cues.push({ at: t, cue: cue(us ? "muzzle_us" : "muzzle_insurgent", { v: (i * 0.137) % 1, pos: us ? L(60 + (i % 4) * 20) : Rt(180 + (i % 5) * 25), gain: 0.85 }) });
    // a second shooter overlapping (different position/timbre) — density of a real fight
    cues.push({ at: t + 0.12, cue: cue(us ? "muzzle_insurgent" : "muzzle_us", { v: (i * 0.41 + 0.3) % 1, pos: us ? Rt(200 + (i % 3) * 30) : L(70 + (i % 3) * 25), gain: 0.7 }) });
    if (i % 5 === 2) cues.push({ at: t + 0.08, cue: cue(us ? "mg_us" : "mg_insurgent", { v: (i * 0.31) % 1, pos: us ? L(80) : Rt(220), gain: 1 }) });
    if (i % 11 === 5) cues.push({ at: t + 0.2, cue: cue("ricochet", { v: (i * 0.7) % 1, pos: Rt(60) }) });
    if (i % 9 === 4) cues.push({ at: t + 0.05, cue: cue("impact", { v: (i * 0.5) % 1, pos: L(30) }) });
  }
  cues.push({ at: 3.2, cue: cue("blast_small", { pos: Rt(120), gain: 0.9 }) }); // RPG
  cues.push({ at: 5.0, cue: cue("radio", {}) });
  cues.push({ at: 9.0, cue: cue("radio", { v: 0.3 }) });
  cues.push({ at: 7.5, cue: cue("shot", { pos: Rt(400) }) }); // enemy tube
  cues.push({ at: 8.1, cue: cue("incoming", { pos: L(40) }) }); // the whistle closing on us
  cues.push({ at: 10.5, cue: cue("splash", { pos: L(40) }) }); // landing near us
  cues.push({ at: 10.5, cue: cue("dangerclose", {}) });
  cues.push({ at: 13.0, cue: cue("ied", { pos: L(20), gain: 1 }) });
  return { name: "firefight", durationS: 20, cam: c, cues, note: "dense TIC: outgoing L, incoming ridge R, RPG, radio, enemy mortar, IED, sting" };
}

function distantScene(): Scene {
  // a PKM on the high ground, ~700 m up-right: pan right, air-absorption lowpass, crack→thump split.
  const c = cam();
  const pos = { x: 1280 + 560, y: 1280 - 420 }; // ~700 m
  const cues: TimedCue[] = [];
  for (let i = 0; i < 6; i++) cues.push({ at: 0.3 + i * 1.2, cue: cue("mg_insurgent", { v: (i * 0.27) % 1, pos, gain: 1 }) });
  return { name: "distant", durationS: 9, cam: c, cues, note: "PKM ~700 m high-ground: pan R + air-absorption + crack/thump split" };
}

function ambientCalmScene(): Scene {
  // What you hear standing at the COP on a clear day with no contact. On HEAD this is SILENT (no
  // ambient system); with the bed it's a living valley. This is the single biggest 20x gap.
  return {
    name: "ambient-calm",
    durationS: 8,
    cam: cam(),
    cues: [],
    note: "between-firefights ambience — clear day: wind/river/generator/birds bed",
    ambient: { secondsOfDay: 10 * 3600, solar: 1, isNight: false, windSpeed: 3, weatherLabel: "Clear", precip: false, inContact: false },
  };
}

function ambientNightScene(): Scene {
  return {
    name: "ambient-night",
    durationS: 8,
    cam: cam(),
    cues: [],
    note: "night calm: down-valley katabatic wind, crickets, the lone dog, generator drone",
    ambient: { secondsOfDay: 1 * 3600, solar: 0.05, isNight: true, windSpeed: 4, weatherLabel: "Clear", precip: false, inContact: false },
  };
}

function ambientStormScene(): Scene {
  // A mountain rainstorm: the Haas-widened rain bed + a thunder roll crossing the valley
  // (auditioned directly — Poisson λ=0.022 won't reliably fire inside a 10 s render).
  return {
    name: "ambient-storm",
    durationS: 10,
    cam: cam(),
    cues: [],
    note: "rainstorm: wide rain bed + a thunder roll crossing the valley (rare spot, auditioned)",
    ambient: { secondsOfDay: 14 * 3600, solar: 0.6, isNight: false, windSpeed: 6, weatherLabel: "Rain", precip: true, inContact: false },
    audition: [{ layer: "thunder", at: 1.2, h: 0.62 }],
  };
}

function adhanScene(): Scene {
  // The call to prayer from the village, late afternoon (OUTSIDE a prayer window so the
  // scheduled path can't double-voice it — the audition is the only adhan in the scene).
  return {
    name: "spot-adhan",
    durationS: 7.5,
    cam: cam(),
    cues: [],
    note: "the adhan from the village to the east — vibrato melisma over the calm bed",
    ambient: { secondsOfDay: 16.8 * 3600, solar: 0.45, isNight: false, windSpeed: 2, weatherLabel: "Clear", precip: false, inContact: false },
    audition: [{ layer: "adhan", at: 0.4, h: 0.2, pan: 0.5 }],
  };
}

/** A gaussian ridge between listener (1280,1280) and a source 300 m east — for LOS occlusion. */
function ridgeTerrain(): TerrainProbe {
  return {
    elevAt(x: number) {
      const base = 1200;
      const ridgeX = 1280 + 150; // halfway to the source
      const h = 120 * Math.exp(-Math.pow((x - ridgeX) / 35, 2)); // ~120 m ridge, ~35 m wide
      return base + h;
    },
  };
}

function occlusionScenes(): Scene[] {
  // Same PKM 300 m east, fired with and without a 120 m ridge in the line of sight. The occluded
  // version must be duller (lower centroid) and a touch quieter — terrain-masked audio.
  const c = cam();
  const pos = { x: 1280 + 300, y: 1280 };
  const cues: TimedCue[] = [];
  for (let i = 0; i < 5; i++) cues.push({ at: 0.3 + i * 1.0, cue: cue("mg_insurgent", { v: (i * 0.27) % 1, pos, gain: 1 }) });
  return [
    { name: "occlusion-open", durationS: 6, cam: c, cues, note: "PKM 300 m east, clear line of sight (bright)" },
    { name: "occlusion-ridge", durationS: 6, cam: c, cues, terrain: ridgeTerrain(), note: "same PKM, 120 m ridge in the LOS (muffled — terrain occlusion)" },
  ];
}

// ----------------------------------------------------------------------------- main
/** Seed global Math.random (mulberry32) so the render-side noise buffers are byte-reproducible
 *  and A/B metric deltas are real, not render jitter. The LIVE game keeps real randomness — only
 *  this measurement rig is pinned. Call before any renderScene. */
function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const outDir = process.argv[2] || "docs/progress/_audio-latest";
  mkdirSync(outDir, { recursive: true });
  const scenes: Scene[] = [...paletteScenes(), firefightScene(), distantScene(), ...occlusionScenes(), ambientCalmScene(), ambientNightScene(), ambientStormScene(), adhanScene()];
  const all: SceneMetrics[] = [];

  for (const sc of scenes) {
    // per-scene seed → each scene's noise is isolated & reproducible, so adding/changing one
    // scene never shifts another's A/B numbers.
    let h = 2166136261; for (const ch of sc.name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    seedRandom(h);
    const { L, R, sr } = await renderScene(sc);
    const m = metrics(sc.name, sc.durationS, sc.note, L, R, sr);
    all.push(m);
    writeWav(`${outDir}/${sc.name}.wav`, L, R, sr);
  }

  writeFileSync(`${outDir}/metrics.json`, JSON.stringify({ generatedFor: "render", sampleRate: SR, scenes: all }, null, 2));

  // console table — lead with the headline scenes
  const headline = ["firefight", "distant", "occlusion-open", "occlusion-ridge", "ambient-calm", "ambient-night", "palette-muzzle_us", "palette-mg_insurgent", "palette-ied", "palette-blast_large"];
  console.log("\n  scene                  peakDb  rmsDb   LUFS   crest  centroidHz  corr  width%  tailMs  audMs");
  console.log("  " + "-".repeat(96));
  for (const name of headline) {
    const m = all.find((x) => x.name === name); if (!m) continue;
    console.log(
      "  " + name.padEnd(22) +
      String(m.peakDb).padStart(6) + String(m.rmsDb).padStart(8) + String(m.lufs).padStart(7) +
      String(m.crestDb).padStart(7) + String(m.centroidHz).padStart(11) +
      String(m.stereoCorr).padStart(7) + String(m.widthPct).padStart(7) +
      String(m.tailMs).padStart(8) + String(m.audibleMs).padStart(7),
    );
  }
  console.log(`\n  ${scenes.length} scenes → ${outDir}/  (wav + metrics.json)`);

  // ---- assertions that turn "20x" into checkable numbers (Law 1) ----
  const get = (n: string) => all.find((m) => m.name === n);
  const ff = get("firefight"), calm = get("ambient-calm"), open = get("occlusion-open"), ridge = get("occlusion-ridge");
  const checks: string[] = [];
  const clip = all.filter((m) => m.peakDb > 0);
  checks.push(clip.length ? `⚠ CLIP — ${clip.length} scene(s) peak >0 dBFS: ${clip.map((m) => m.name).join(", ")}` : `ok — no scene clips (all peak ≤ 0 dBFS, busiest=firefight ${ff?.peakDb} dB)`);
  if (ff && calm) {
    // honest dynamic range: combat's LOUDEST 1 s vs the continuous calm bed.
    const spread = ff.loudWindowDb - calm.rmsDb;
    checks.push(spread > 15 ? `ok — calm→combat dynamic spread ${spread.toFixed(1)} dB (>15; loud-window ${ff.loudWindowDb} vs calm ${calm.rmsDb})` : `⚠ dynamic spread only ${spread.toFixed(1)} dB (want >15; loud-window ${ff.loudWindowDb} vs calm ${calm.rmsDb})`);
  }
  if (calm) checks.push(calm.rmsDb > -60 && calm.rmsDb < -28 ? `ok — ambient bed alive but subdued (calm RMS ${calm.rmsDb} dB, was −120/silent)` : `⚠ ambient level off (${calm.rmsDb} dB; want alive but < −28)`);
  if (ff) checks.push(ff.stereoCorr < 0.7 ? `ok — firefight stereo image wide (corr ${ff.stereoCorr}, was 0.98)` : `⚠ firefight still narrow (corr ${ff.stereoCorr})`);
  if (open && ridge) {
    // occlusion = quieter AND darker (a ridge cuts level + highs; low end diffracts around it).
    const quieter = ridge.rmsDb < open.rmsDb - 3, darker = ridge.hf4kPct < open.hf4kPct * 0.8;
    checks.push(quieter && darker ? `ok — terrain occlusion: ridge is ${(open.rmsDb - ridge.rmsDb).toFixed(1)} dB quieter & HF ${ridge.hf4kPct}% vs ${open.hf4kPct}% (darker)` : `⚠ occlusion weak (Δlevel ${(open.rmsDb - ridge.rmsDb).toFixed(1)} dB, HF ${ridge.hf4kPct}% vs ${open.hf4kPct}%)`);
  }
  // calm-bed stereo width: the panned river bands + spread wind must lift the calm scene out of
  // dead-center mono (the 2026-06-07 campaign's recorded residual: corr 0.997 / width 4%).
  if (calm) checks.push(calm.widthPct > 12 ? `ok — calm bed has stereo width (${calm.widthPct}%, corr ${calm.stereoCorr}; was 4%/0.997)` : `⚠ calm bed still near-mono (width ${calm.widthPct}%, corr ${calm.stereoCorr})`);
  const storm = get("ambient-storm");
  if (storm) checks.push(storm.rmsDb > -55 && storm.peakDb <= 0 ? `ok — storm scene alive (rain bed + thunder roll, RMS ${storm.rmsDb} dB, peak ${storm.peakDb})` : `⚠ storm scene off (RMS ${storm.rmsDb}, peak ${storm.peakDb})`);
  const inc = get("palette-incoming");
  if (inc) checks.push(inc.audibleMs > 1600 ? `ok — incoming whistle sustains (${inc.audibleMs} ms audible — the 2.2 s shriek before the splash)` : `⚠ incoming whistle too short (${inc.audibleMs} ms)`);
  console.log("");
  for (const c of checks) console.log("  " + c);

  const failed = checks.filter((c) => c.startsWith("⚠"));
  console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED` : "\nRENDER OK");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
