/**
 * reverb.ts — BROWSER (and OfflineAudioContext-safe). The shared VALLEY REVERB: one procedural
 * canyon echo every gunshot/blast cue sends to. A Korengal report is mostly its TAIL — "pop…
 * then rolling thunder down the valley" — the muzzle crack itself is a tiny fraction of what a
 * soldier hears; the rest is the wavefront slapping off the far ridge and rolling back. This
 * file synthesizes that tail as a single shared ConvolverNode, zero binary audio assets.
 *
 * THE DSP (Moorer 1979: an exp-decaying noise burst is a near-ideal reverb impulse response):
 *   • The IR is white noise multiplied by an exponential decay envelope. The decay base is
 *       base = (1/1000)^(1/(RT60·sr))
 *     so the envelope reaches exactly −60 dB (a factor of 1/1000) at t = RT60 — i.e. the IR's
 *     amplitude `base^j` hits −60 dB at sample j = RT60·sr by construction.
 *   • HIGHPASS (~350 Hz, one-pole): strips the boom so the tail reads as dirt/rock, not a tiled
 *     room. Mountains are not bathrooms.
 *   • SWEPT LOWPASS (≈6 kHz at the head → ≈1.2 kHz at the tail): models air absorption — high
 *     frequencies die first over distance, so the tail darkens as it recedes down the valley.
 *     Implemented as a one-pole LP whose coefficient interpolates across the buffer length.
 *   • An 8 ms fade-IN at the very start removes the click of starting on a discontinuity.
 *   • RIDGE SLAP-TAPS: 3–4 discrete echoes added on top of the diffuse tail at hand-placed
 *     times/amplitudes, each panned by writing DIFFERENT L/R amplitudes (different cliff faces
 *     at different bearings) so the result reads as MOUNTAINS surrounding the listener, not a box.
 *   • STEREO (2-channel) IR: each channel gets INDEPENDENT noise and slightly different tap
 *     amplitudes. Convolving a mono dry signal with a decorrelated stereo IR makes the *tail*
 *     wide while the *dry* sound stays a point source — that decorrelation (low L/R correlation)
 *     is the whole reason the reverb sounds like an open valley.
 *
 * DETERMINISM (Law 7): the IR is a PURE function of the deployment seed. The noise fill uses a
 * LOCAL mulberry32 PRNG seeded from opts.seed (NOT global Math.random), so the same seed yields
 * a byte-identical IR. The IR is render-side only — it never feeds back into lib/sim.
 *
 * SSR-safe: nothing browser is touched at module load. Everything runs inside the function on the
 * passed ctx. The param is typed `BaseAudioContext` so this works for both the live AudioContext
 * and the headless OfflineAudioContext (node-web-audio-api) the audio oracle renders through.
 */

/** A shared valley-reverb send: connect cue sends to `input`, route `output` to master. */
export interface ValleyReverb {
  /** Cue sends connect HERE (post per-cue sendGain / highpass / pre-delay). */
  input: GainNode;
  /** Connect to master. The wet return. */
  output: GainNode;
  /** The single shared convolver carrying the procedural canyon IR. */
  convolver: ConvolverNode;
  /** The RT60 (−60 dB decay time, seconds) the IR was built for. */
  rt60: number;
}

/** Options for {@link createValleyReverb}. All optional — the defaults are the v1 valley. */
export interface ValleyReverbOpts {
  /** Seed for the noise fill. Same seed ⇒ byte-identical IR (Law 7). Default {@link DEFAULT_SEED}. */
  seed?: number;
  /** −60 dB decay time in seconds. Default 1.8 (a normal report); ~2.6 for the "HE" variant. */
  rt60?: number;
  /** IR buffer length in seconds. Defaults to rt60 + a little headroom so the tail isn't truncated. */
  durationS?: number;
}

/** Fixed default seed so a build with no seed is still deterministic across runs. */
const DEFAULT_SEED = 0x5f3a91c7;
const DEFAULT_RT60 = 1.8;

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit seeded PRNG. Inlined so the IR fill never
 * touches global Math.random (determinism contract). Returns a closure yielding floats in [0,1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A ridge slap-tap: an echo time (s), and the per-channel amplitude it's written at (different
 *  L/R ⇒ a distinct bearing/cliff face). */
interface SlapTap {
  t: number;
  /** [left, right] amplitude. */
  amp: [number, number];
}

/**
 * The discrete ridge reflections, hand-placed per the research dossier (t / base-amp):
 *   0.18/0.6 · 0.42/0.35 · 0.85/0.2 · 1.4/0.12
 * Each is given asymmetric L/R amplitudes so the four taps arrive from four different bearings —
 * the listener is ringed by ridgelines, not standing in a room. Scaled to a fraction of RT60 so
 * a shorter/longer tail keeps its slaps inside the buffer in roughly the right places.
 */
function ridgeTaps(rt60: number): SlapTap[] {
  const s = rt60 / DEFAULT_RT60; // keep tap geometry proportional to the tail length
  return [
    { t: 0.18 * s, amp: [0.6, 0.52] }, // near ridge, slightly left
    { t: 0.42 * s, amp: [0.3, 0.35] }, // a face to the right
    { t: 0.85 * s, amp: [0.2, 0.16] }, // far wall, left of centre
    { t: 1.4 * s, amp: [0.1, 0.12] }, // the long roll back, right
  ];
}

/**
 * Fill ONE channel of the IR in place: exp-decaying seeded noise, + a one-pole highpass, + a
 * swept (bright→dull) one-pole lowpass, + the 8 ms fade-in, + the channel's ridge slap-taps.
 * Each channel is filled with its OWN PRNG stream and slightly different tap amps so L/R
 * decorrelate (stereo width).
 */
function fillChannel(
  out: Float32Array,
  sr: number,
  rt60: number,
  rng: () => number,
  taps: SlapTap[],
  chan: 0 | 1,
): void {
  const n = out.length;

  // −60 dB at exactly RT60: amplitude per sample is base^j, base hits 1/1000 at j = rt60·sr.
  const base = Math.pow(1 / 1000, 1 / (rt60 * sr));

  // 1) exp-decaying white noise.
  let env = 1;
  for (let j = 0; j < n; j++) {
    out[j] = (rng() * 2 - 1) * env;
    env *= base;
  }

  // 2) one-pole HIGHPASS (~350 Hz): y[j] = a·(y[j-1] + x[j] − x[j-1]). Strips the boom.
  const fHp = 350;
  const aHp = 1 / (1 + 2 * Math.PI * fHp / sr); // one-pole HP coefficient
  let prevX = 0;
  let prevY = 0;
  for (let j = 0; j < n; j++) {
    const x = out[j];
    const y = aHp * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    out[j] = y;
  }

  // 3) one-pole LOWPASS swept BRIGHT→DULL across the tail (air absorption).
  //    cutoff: ~6 kHz at the head → ~1.2 kHz at the end. Coefficient interpolates per sample.
  const fcStart = 6000;
  const fcEnd = 1200;
  let lpPrev = 0;
  for (let j = 0; j < n; j++) {
    const frac = n > 1 ? j / (n - 1) : 0;
    const fc = fcStart + (fcEnd - fcStart) * frac;
    // one-pole LP coefficient for cutoff fc at sample rate sr.
    const c = 2 * Math.PI * fc / sr;
    const a = c / (c + 1);
    lpPrev += a * (out[j] - lpPrev);
    out[j] = lpPrev;
  }

  // 4) 8 ms fade-IN at the very start (kill the head click / DC step from the filters).
  const fadeN = Math.min(n, Math.max(1, Math.round(0.008 * sr)));
  for (let j = 0; j < fadeN; j++) out[j] *= j / fadeN;

  // 5) discrete ridge SLAP-TAPS, this channel's amplitudes (asymmetric L/R ⇒ bearing).
  for (const tap of taps) {
    const idx = Math.round(tap.t * sr);
    if (idx >= 0 && idx < n) out[idx] += tap.amp[chan];
  }
}

/**
 * Build the shared valley reverb. Graph: input(Gain) → convolver(IR) → output(Gain).
 * The IR is a 2-channel `ctx.createBuffer` filled by {@link fillChannel} with two independent
 * seeded noise streams ⇒ a decorrelated stereo tail. Pure given `opts.seed` (Law 7).
 */
export function createValleyReverb(ctx: BaseAudioContext, opts: ValleyReverbOpts = {}): ValleyReverb {
  const seed = opts.seed ?? DEFAULT_SEED;
  const rt60 = opts.rt60 ?? DEFAULT_RT60;
  // leave headroom past RT60 so the −60 dB tail (and the last slap) aren't truncated.
  const durationS = opts.durationS ?? rt60 + 0.6;
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(durationS * sr));

  const ir = ctx.createBuffer(2, n, sr);
  const taps = ridgeTaps(rt60);

  // Two INDEPENDENT PRNG streams (offset seeds) ⇒ the L/R noise decorrelates → stereo width.
  // Tap amplitudes also differ per channel (see ridgeTaps) ⇒ slaps arrive from distinct bearings.
  fillChannel(ir.getChannelData(0), sr, rt60, mulberry32(seed), taps, 0);
  fillChannel(ir.getChannelData(1), sr, rt60, mulberry32(seed ^ 0x9e3779b9), taps, 1);

  const input = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.normalize = false; // keep our hand-built energy/decay; normalize would flatten the tail
  convolver.buffer = ir;
  const output = ctx.createGain();

  input.connect(convolver).connect(output);

  return { input, output, convolver, rt60 };
}
