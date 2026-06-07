/**
 * ambient.ts — BROWSER. The AmbientEngine: a PERSISTENT procedural voice bank that turns an
 * {@link AmbientMix} (from the pure ambient-state.ts) into the living acoustic bed of the
 * valley — wind, river, the COP's diesel generator, day birds, night crickets, dogs, rain,
 * and the call to prayer. The geophony/biophony/anthrophony sibling of synth.ts.
 *
 * It lives on its OWN bus (the `destination` passed in — the atmos bus), NEVER the 24-voice
 * combat pool: the bed must keep breathing under a firefight (then duck), and a one-shot
 * gunshot must never steal an ambient slot. Everything is synthesized; NO binary assets, NO
 * npm audio deps beyond Web Audio.
 *
 * THE THREE TIERS (research dossier):
 *   1) PERSISTENT BED LOOPS — built once, lazily, on the first update(); gains are CROSSFADED
 *      with setTargetAtTime, the loops are NEVER swapped/restarted (a restart clicks + breaks
 *      the seamless bed). wind / river / generator / rain.
 *   2) POISSON SPOT ONE-SHOTS — birds / insects / dogs / rain droplets, scheduled off a PURE
 *      deterministic clock (ambient-state.poissonInterval) advanced by dt only when running, so
 *      same seed + clock ⇒ same birds. Plus the SCHEDULED (not Poisson) adhan.
 *   3) DYNAMIC PARAMS — the mix chased every update().
 *
 * ACOUSTIC-NICHE PARTITIONING (the mix-mud cure — enforced HERE by each layer's filters):
 *   wind howl 100–400 Hz + whistle 1–3 kHz · river 0.4–6 kHz notched 3–4 kHz · generator <250 Hz
 *   · birds 2–5 kHz · insects 4–7 kHz · adhan 0.3–2 kHz · rain bed broadband-low.
 *
 * DETERMINISM (Law 7): scheduling DECISIONS read the internal `clock` (advanced by the caller's
 * dt), NEVER ctx.currentTime — ctx.currentTime is used ONLY as a setTargetAtTime/start ramp
 * anchor. The Poisson stream + adhan latch are reproducible. Math.random appears ONLY in the
 * persistent noise-buffer fill (exactly like synth.ts:noiseBuffer) — render-side, never the sim.
 */

import type { AmbientMix, AmbientSignals } from "./ambient-state";
import { computeAmbientMix, poissonInterval, hashToUnit } from "./ambient-state";

// Re-export the pure interfaces so consumers (player.ts, the render oracle) import the whole
// ambient surface from this one render-side module — `import { AmbientEngine, type AmbientSignals }
// from "./ambient"`. The shapes live in (and are owned by) the pure ambient-state.ts.
export type { AmbientMix, AmbientSignals } from "./ambient-state";

// node-web-audio-api's OfflineAudioContext is structurally a Web Audio BaseAudioContext; the
// DOM lib types describe the same runtime. We type the public API in DOM terms and the few
// constructor calls (Oscillator/Gain/etc.) come off the ctx, so both runtimes satisfy it.
type Ctx = BaseAudioContext;

/** Mutually-PRIME LFO rates (Hz) so no two modulators ever phase-lock into an audible loop.
 *  (research dossier: wind 0.13, river 0.077, insect 0.19, generator 0.043.) */
const LFO = {
  windGust: 0.13,
  riverBreath: 0.077,
  genLope: 5.0, // the diesel "lope" is a fast 3–7 Hz tremolo, not a slow drift
  genDrift: 0.043, // a slow secondary drift so the lope itself wanders
} as const;

/** Ramp time-constants (seconds) for setTargetAtTime. Beds chase slowly so weather/time shifts
 *  feel geological; the contact duck is asymmetric — fast IN, slow EXHALE (the readable-silence
 *  contract). */
const TAU = {
  bed: 8.0, // day/weather crossfades
  density: 6.0, // spot densities ease in/out
  duckIn: 0.4, // contact rising edge: HARD + FAST collapse
  duckOut: 12.0, // contact falling edge: a slow EXHALE — the absence sells the violence
} as const;

// ----------------------------------------------------------------------------- noise buffer
let _noise: AudioBuffer | null = null;
/** Several seconds of brown-ish + white noise, built ONCE (cheap, immutable), looped by every
 *  bed and burst. Brown (integrated) energy gives the wind/river their body; the white tail
 *  feeds the bright whistle/hiss bands. Render-side Math.random only — mirrors synth.ts. */
function noiseBuffer(ctx: Ctx): AudioBuffer {
  if (_noise && _noise.sampleRate === ctx.sampleRate) return _noise;
  const len = Math.floor(ctx.sampleRate * 4); // 4 s loop — long enough to hide the seam
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let brown = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    brown = (brown + 0.02 * white) / 1.02; // leaky integrator → brown noise
    d[i] = brown * 3.5 + white * 0.25; // mostly brown body + a little white sparkle
  }
  _noise = buf;
  return buf;
}

/** A looping filtered-noise source: buffer → biquad → gain. The persistent bed primitive. */
interface BedVoice {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

// ----------------------------------------------------------------------------- the engine
export class AmbientEngine {
  private readonly ctx: Ctx;
  private readonly dest: AudioNode;

  /** built lazily on first update() so construction is SSR-safe + cheap. */
  private built = false;

  // ---- bus topology ----
  private bus!: GainNode; // the whole ambient bed; the contact duck rides HERE
  private busTarget = 1; // last duck target we set (so we only ramp on a real change)
  private running = true; // last gate.running we saw (so we ramp the bus down once on stop)

  // ---- bed layers + their modulators ----
  private wind!: { howlLo: BedVoice; howlBp: BedVoice; whistleA: BedVoice; whistleB: BedVoice; group: GainNode };
  private windGustLfo!: OscillatorNode;
  private windGustAmt!: GainNode;
  private windWhistleGain!: GainNode; // whistle group gain, driven by a LAGGED gust follower
  private river!: BedVoice & { notch: BiquadFilterNode };
  private riverLfo!: OscillatorNode;
  private riverLfoAmt!: GainNode;
  private generator!: { gain: GainNode; lopeLfo: OscillatorNode; lopeAmt: GainNode };
  private rain!: BedVoice;

  // ---- spot scheduling (pure deterministic clock) ----
  private clock = 0; // internal sim-seconds clock; advanced by dt only when running
  /** per-layer next-fire time + event index for the Poisson streams. */
  private spot: Record<string, { next: number; n: number }> = {
    birds: { next: 0, n: 0 },
    insects: { next: 0, n: 0 },
    dogs: { next: 0, n: 0 },
    drops: { next: 0, n: 0 },
  };
  private adhanFired = -1; // last adhanMark we voiced (latch: one melisma per prayer window)

  // the live mix (chased each update so spot scheduling reads current densities/pans).
  private mix: AmbientMix | null = null;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.dest = destination;
  }

  // -------------------------------------------------------------- public tick
  /**
   * Chase the mix and advance the deterministic spot clock. Builds the node bank lazily on the
   * first call. On !running the bus ramps to 0 (and the clock STOPS — no backlog dump on resume,
   * mirroring player.ts's skip()). dt is sim-seconds since the last update (pass-through).
   */
  update(s: AmbientSignals, dt: number, gate: { running: boolean; paused: boolean; warp: boolean }): void {
    if (!this.built) this.build();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const live = gate.running && !gate.paused && !gate.warp;

    // --- gate: ramp the WHOLE bus down when not live; do not advance the clock or schedule. ---
    if (!live) {
      if (this.running) {
        this.bus.gain.setTargetAtTime(0, now, 0.25); // quick, click-free mute
        this.running = false;
      }
      return;
    }
    if (!this.running) {
      // resume: restore the bus to the current duck target (no backlog of skipped spots).
      this.bus.gain.setTargetAtTime(this.busTarget, now, 0.25);
      this.running = true;
    }

    const mix = computeAmbientMix(s);
    this.mix = mix;

    // --- 1) the contact duck on the bus (asymmetric ramp) ---
    if (mix.duck !== this.busTarget) {
      const tau = mix.duck < this.busTarget ? TAU.duckIn : TAU.duckOut; // collapsing? fast. exhaling? slow.
      this.bus.gain.setTargetAtTime(mix.duck, now, tau);
      this.busTarget = mix.duck;
    }

    // --- 2) chase the persistent beds ---
    this.chaseBeds(mix, s, now);

    // --- 3) advance the deterministic spot clock + fire due Poisson one-shots ---
    this.clock += dt;
    this.fireSpots(mix, now);

    // --- 4) the scheduled (NOT Poisson) adhan ---
    this.serviceAdhan(mix, now);
  }

  // -------------------------------------------------------------- lazy construction
  private build(): void {
    const ctx = this.ctx;
    this.built = true;

    // --- the bus: everything ambient flows through here so the duck is one ramp. ---
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.dest);

    this.buildWind();
    this.buildRiver();
    this.buildGenerator();
    this.buildRain();
  }

  /** A looping filtered-noise bed voice → (caller wires .gain to a group/bus). */
  private bedVoice(type: BiquadFilterType, freq: number, q: number, gain0 = 0): BedVoice {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = gain0;
    src.connect(filter).connect(gain);
    src.start();
    return { src, filter, gain };
  }

  // ---- WIND: howl 100–400 Hz (lowpass/bandpass @180,350) + whistle 1–3 kHz (bandpass @900,2200, high Q) ----
  private buildWind(): void {
    const ctx = this.ctx;
    const group = ctx.createGain(); // the whole wind layer's gain (gusts ride here)
    group.gain.value = 0;
    group.connect(this.bus);

    // Real valley wind is ENVELOPING, not a point — spread the four band voices (each carries
    // different filtered content off the shared noise, so panning them genuinely decorrelates L/R
    // and gives the calm bed stereo WIDTH instead of a dead-center wash). (Adversarial Finding 3.)
    const spread = (n: { gain: GainNode }, pan: number, dst: AudioNode) => {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      n.gain.connect(p).connect(dst);
    };

    // HOWL band (the body) — reserved 100–400 Hz, kept near-center (low end localizes poorly).
    const howlLo = this.bedVoice("lowpass", 180, 0.7, 0.6);
    const howlBp = this.bedVoice("bandpass", 350, 0.7, 0.5);
    spread(howlLo, -0.25, group);
    spread(howlBp, 0.25, group);

    // WHISTLE band (the bite) — reserved 1–3 kHz, high-Q so it sings rather than hisses. Panned
    // wide (the singing wind comes off both ridgelines). Its group gain is driven by a LAGGED gust
    // follower so the whistle arrives AFTER the gust swells.
    const whistleGain = ctx.createGain();
    whistleGain.gain.value = 0;
    whistleGain.connect(group);
    const whistleA = this.bedVoice("bandpass", 900, 8, 0.5);
    const whistleB = this.bedVoice("bandpass", 2200, 10, 0.4);
    spread(whistleA, -0.75, whistleGain);
    spread(whistleB, 0.75, whistleGain);

    // GUST LFO (0.13 Hz) modulates the whole-layer gain. Slow, breathing.
    const gustLfo = ctx.createOscillator();
    gustLfo.frequency.value = LFO.windGust;
    const gustAmt = ctx.createGain();
    gustAmt.gain.value = 0; // depth set per-update from windSpeed
    gustLfo.connect(gustAmt).connect(group.gain);
    gustLfo.start();

    this.wind = { howlLo, howlBp, whistleA, whistleB, group };
    this.windGustLfo = gustLfo;
    this.windGustAmt = gustAmt;
    this.windWhistleGain = whistleGain;
  }

  // ---- RIVER: bandpass ~1.2 kHz (Q0.4) + slow center LFO (breathing) + peaking NOTCH 3–4 kHz (room for birds) ----
  private buildRiver(): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.4; // wide — the river is broadband babble, 0.4–6 kHz
    // a peaking NOTCH at ~3.5 kHz to CARVE OUT the bird band (acoustic-niche partitioning).
    const notch = ctx.createBiquadFilter();
    notch.type = "peaking";
    notch.frequency.value = 3500;
    notch.Q.value = 1.5;
    notch.gain.value = -14; // dB cut — clears the room for 2–5 kHz birds
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(notch).connect(gain).connect(this.bus);
    src.start();

    // slow LFO breathing the bandpass center (the water "rolls").
    const lfo = ctx.createOscillator();
    lfo.frequency.value = LFO.riverBreath;
    const amt = ctx.createGain();
    amt.gain.value = 220; // ±220 Hz around 1.2 kHz
    lfo.connect(amt).connect(filter.frequency);
    lfo.start();

    this.river = { src, filter, gain, notch };
    this.riverLfo = lfo;
    this.riverLfoAmt = amt;
  }

  // ---- GENERATOR: additive sines @55–65 Hz + 3–5 harmonics → lowpass 250 Hz; a 3–7 Hz lope ----
  private buildGenerator(): void {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 250; // reserved band: <250 Hz
    lp.Q.value = 0.7;
    lp.connect(gain);
    gain.connect(this.bus);

    // the diesel fundamental + harmonics (additive sines — the drone's identity).
    const f0 = 58; // ~58 Hz fundamental (diesel genset idle ≈ 1750 rpm range)
    const harmonics = [1, 2, 3, 4, 5];
    const amps = [1.0, 0.5, 0.32, 0.18, 0.1];
    for (let i = 0; i < harmonics.length; i++) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f0 * harmonics[i];
      const og = ctx.createGain();
      og.gain.value = amps[i] * 0.25;
      o.connect(og).connect(lp);
      o.start();
    }

    // the LOPE: a 5 Hz tremolo on the genset gain (the chugging diesel pulse), itself slowly
    // drifting so the lope rate wanders (two mutually-prime LFOs).
    const lopeLfo = ctx.createOscillator();
    lopeLfo.frequency.value = LFO.genLope;
    const lopeAmt = ctx.createGain();
    lopeAmt.gain.value = 0; // depth set per-update (only when audible)
    lopeLfo.connect(lopeAmt).connect(gain.gain);
    lopeLfo.start();
    const drift = ctx.createOscillator();
    drift.frequency.value = LFO.genDrift;
    const driftAmt = ctx.createGain();
    driftAmt.gain.value = 1.2; // ±1.2 Hz wander on the lope rate
    drift.connect(driftAmt).connect(lopeLfo.frequency);
    drift.start();

    this.generator = { gain, lopeLfo, lopeAmt };
  }

  // ---- RAIN bed: noise → intensity lowpass (broadband hiss; droplet ticks are spots) ----
  private buildRain(): void {
    const v = this.bedVoice("lowpass", 6000, 0.5, 0);
    v.gain.connect(this.bus);
    this.rain = v;
  }

  // -------------------------------------------------------------- chase the beds
  private chaseBeds(mix: AmbientMix, s: AmbientSignals, now: number): void {
    const floor = mix.bedFloor;

    // WIND base group gain → windSpeed (with the readable floor so calm ≠ silence). The gust LFO
    // depth scales with loudness; the whistle gain LAGS via a smoothed follower (gust→then→whistle).
    const wg = Math.max(floor, mix.wind.gain) * 0.9;
    this.wind.group.gain.setTargetAtTime(wg, now, TAU.bed);
    this.windGustAmt.gain.setTargetAtTime(wg * 0.5, now, TAU.bed); // ±50% gusting depth
    // whistle openness chases wind.brightness but with a LONGER tau than the body → it lags.
    this.windWhistleGain.gain.setTargetAtTime(mix.wind.brightness * 0.8, now, TAU.bed * 1.6);
    // open the whistle bandpass slightly higher as it brightens (the wind "sharpens" in a gust).
    this.wind.whistleB.filter.frequency.setTargetAtTime(2200 + mix.wind.brightness * 900, now, TAU.bed);

    // RIVER gain → camera proximity; notch stays put (it's a fixed niche carve).
    this.river.gain.gain.setTargetAtTime(mix.river.gain * 0.7, now, TAU.bed);

    // GENERATOR gain → COP proximity; lope depth only meaningful when audible.
    const gg = mix.generator.gain;
    this.generator.gain.gain.setTargetAtTime(gg, now, TAU.bed);
    this.generator.lopeAmt.gain.setTargetAtTime(gg * 0.35, now, TAU.bed); // tremolo ±35% of level

    // RAIN bed: gain → intensity; the lowpass opens with intensity (harder rain = brighter).
    this.rain.gain.gain.setTargetAtTime(mix.rain.gain * 0.6, now, TAU.bed);
    this.rain.filter.frequency.setTargetAtTime(2500 + mix.rain.brightness * 5000, now, TAU.bed);
  }

  // -------------------------------------------------------------- Poisson spot one-shots
  /** Fire every spot whose deterministic next-fire time has passed the internal clock. Each
   *  fire advances the per-layer event index n and reschedules from the current density. */
  private fireSpots(mix: AmbientMix, now: number): void {
    this.serviceSpot("birds", mix.birds.density, mix, now);
    this.serviceSpot("insects", mix.insects.density, mix, now);
    this.serviceSpot("dogs", mix.dogs.density, mix, now);
    this.serviceSpot("drops", mix.drops.density, mix, now);
  }

  private serviceSpot(layer: string, density: number, mix: AmbientMix, now: number): void {
    const st = this.spot[layer];
    if (density <= 0) {
      // stream sleeps; keep next ahead of the clock so it resumes promptly when density returns.
      st.next = this.clock + poissonInterval(layer, st.n, 1e-3); // big interval, but finite-seeded
      return;
    }
    // guard against a long warp/resume gap dumping a backlog: cap catch-up iterations.
    let guard = 0;
    while (st.next <= this.clock && guard < 8) {
      this.spawnSpot(layer, st.n, mix, now);
      st.n++;
      st.next += poissonInterval(layer, st.n, density);
      guard++;
    }
    if (guard >= 8) st.next = this.clock + poissonInterval(layer, st.n, density); // skip the backlog
  }

  /** Synthesize one spot one-shot. Pitch/pan derive from the same hash family (determinism). */
  private spawnSpot(layer: string, n: number, mix: AmbientMix, at: number): void {
    const ctx = this.ctx;
    const h = hashToUnit(layer + "#", n); // a SECOND hash stream for per-event jitter
    switch (layer) {
      case "birds":
        this.spawnBird(h, mix.birds.pan, mix.birds.gain, at);
        break;
      case "insects":
        this.spawnInsect(h, mix.insects.pan, mix.insects.gain, at);
        break;
      case "dogs":
        this.spawnDog(h, mix.dogs.pan, mix.dogs.gain, at);
        break;
      case "drops":
        this.spawnDrop(h, mix.drops.gain, at);
        break;
    }
    void ctx;
  }

  /** A short panned one-shot graph → bus. Returns the gain node the caller fills with a voice. */
  private spotChain(pan: number): GainNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.bus);
    return g;
  }

  /** BIRD (day, 2–5 kHz): 2–4 fast sine sweeps 3.5k→2.8k through a high-Q bandpass. */
  private spawnBird(h: number, pan: number, gain: number, at: number): void {
    const ctx = this.ctx;
    const out = this.spotChain(pan);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3200;
    bp.Q.value = 8;
    bp.connect(out);
    const n = 2 + Math.floor(h * 3); // 2..4 chirps
    const step = 0.06 + h * 0.05;
    for (let i = 0; i < n; i++) {
      const t = at + i * step;
      const f0 = 3500 + h * 600;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(2800, t + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g).connect(bp);
      o.start(t);
      o.stop(t + 0.08);
    }
    this.cleanup(out, at + n * step + 0.2);
  }

  /** INSECT/CRICKET (night, 4–7 kHz): a gated 4.5 kHz sine pulse train. */
  private spawnInsect(h: number, pan: number, gain: number, at: number): void {
    const ctx = this.ctx;
    const out = this.spotChain(pan);
    const f = 4500 + h * 2000; // 4.5–6.5 kHz
    const pulses = 4 + Math.floor(h * 6);
    const rate = 0.022 + h * 0.01;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(g).connect(out);
    o.start(at);
    for (let i = 0; i < pulses; i++) {
      const t = at + i * rate;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + rate * 0.55);
    }
    o.stop(at + pulses * rate + 0.05);
    this.cleanup(out, at + pulses * rate + 0.2);
  }

  /** DOG (rare, night): a lowpassed noise burst + 300/600 Hz formants — a distant bark. */
  private spawnDog(h: number, pan: number, gain: number, at: number): void {
    const ctx = this.ctx;
    const out = this.spotChain(pan);
    const barks = 1 + Math.floor(h * 3); // 1..3 barks
    for (let b = 0; b < barks; b++) {
      const t = at + b * (0.28 + h * 0.1);
      // noise body
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(gain * 0.5, t + 0.01);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      src.connect(lp).connect(ng).connect(out);
      src.start(t);
      src.stop(t + 0.18);
      // formants (the bark's pitch)
      for (const ff of [300, 600]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(ff * (1 + h * 0.15), t);
        o.frequency.exponentialRampToValueAtTime(ff * 0.8, t + 0.12);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0001, t);
        og.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.015);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        o.connect(og).connect(out);
        o.start(t);
        o.stop(t + 0.16);
      }
    }
    this.cleanup(out, at + barks * 0.4 + 0.2);
  }

  /** RAIN DROPLET: a highpassed noise tick. */
  private spawnDrop(h: number, gain: number, at: number): void {
    const ctx = this.ctx;
    const out = this.spotChain(h * 1.6 - 0.8); // scattered across the field
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3500 + h * 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    src.connect(hp).connect(g).connect(out);
    src.start(at);
    src.stop(at + 0.04);
    this.cleanup(out, at + 0.1);
  }

  // -------------------------------------------------------------- the adhan (scheduled)
  /** Fire exactly one melisma when entering a prayer window (latched by adhanMark). */
  private serviceAdhan(mix: AmbientMix, now: number): void {
    if (!mix.adhanActive) {
      if (mix.adhanMark === -1) this.adhanFired = -1; // left every window: re-arm
      return;
    }
    if (this.adhanFired === mix.adhanMark) return; // already voiced this call
    this.adhanFired = mix.adhanMark;
    this.spawnAdhan(mix.adhanMark, mix.adhanPan, now);
  }

  /** ADHAN: sawtooth → vowel-formant peaking filters (~700/1200/2600 Hz) + a programmed pitch
   *  contour (setValueCurveAtTime melisma) → lowpass ~1.5 kHz, panned to the nearest village.
   *  Reserved band 0.3–2 kHz. A firefight interrupting it (the duck) lands hard. */
  private spawnAdhan(mark: number, pan: number, at: number): void {
    const ctx = this.ctx;
    const out = this.spotChain(pan);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1500; // the call is distant, filtered — 0.3–2 kHz niche
    lp.connect(out);

    // three vowel formants from a single sawtooth source.
    const formants = [700, 1200, 2600];
    const fAmps = [0.6, 0.4, 0.18];
    const dur = 5.5; // a phrase; the engine plays one phrase per call (not the whole adhan)
    const src = ctx.createOscillator();
    src.type = "sawtooth";

    // a melisma: a programmed pitch contour around a low base, varied by the prayer mark so the
    // five calls aren't identical. setValueCurveAtTime = a sung, sliding line.
    const base = 196 + mark * 8; // ~G3, nudged per call
    const curve = new Float32Array(9);
    const shape = [0, 0.06, 0.02, 0.12, 0.08, 0.16, 0.05, 0.1, 0];
    for (let i = 0; i < curve.length; i++) curve[i] = base * (1 + shape[i]);
    src.frequency.setValueAtTime(base, at);
    src.frequency.setValueCurveAtTime(curve, at + 0.05, dur - 0.1);

    // overall amplitude envelope (a slow swell + a tail).
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(0.5, at + 0.6);
    amp.gain.setValueAtTime(0.5, at + dur - 1.2);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    amp.connect(lp);

    for (let i = 0; i < formants.length; i++) {
      const pk = ctx.createBiquadFilter();
      pk.type = "peaking";
      pk.frequency.value = formants[i];
      pk.Q.value = 6;
      pk.gain.value = 12;
      const fg = ctx.createGain();
      fg.gain.value = fAmps[i];
      src.connect(pk).connect(fg).connect(amp);
    }
    src.start(at);
    src.stop(at + dur + 0.1);
    this.cleanup(out, at + dur + 0.3);
  }

  // -------------------------------------------------------------- teardown helpers
  /** Disconnect a transient spot's output a hair after it finishes (frees the graph). In an
   *  OfflineAudioContext there's no setTimeout cadence, so we no-op there — the render simply
   *  lets finished nodes go silent (they're cheap and few). */
  private cleanup(node: AudioNode, endTime: number): void {
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
    const ctx = this.ctx;
    const ms = Math.max(60, (endTime - ctx.currentTime) * 1000 + 120);
    window.setTimeout(() => {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }, ms);
  }

  /** Tear the whole bed down (stop the long-lived sources, drop the bus). */
  dispose(): void {
    if (!this.built) return;
    const stop = (o?: { src?: AudioBufferSourceNode } | AudioScheduledSourceNode) => {
      try {
        if (o && "stop" in o) (o as AudioScheduledSourceNode).stop();
        else if (o && (o as { src?: AudioBufferSourceNode }).src) (o as { src: AudioBufferSourceNode }).src.stop();
      } catch {
        /* already stopped */
      }
    };
    stop(this.wind.howlLo.src);
    stop(this.wind.howlBp.src);
    stop(this.wind.whistleA.src);
    stop(this.wind.whistleB.src);
    stop(this.windGustLfo);
    stop(this.river.src);
    stop(this.riverLfo);
    stop(this.generator.lopeLfo);
    stop(this.rain.src);
    try {
      this.bus.disconnect();
    } catch {
      /* gone */
    }
    this.built = false;
  }
}
