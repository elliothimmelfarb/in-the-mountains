/**
 * synth.ts — BROWSER. Turns an AudioCue + a spatialized listener pose into a Web Audio node
 * graph: oscillators + filtered-noise bursts + envelopes. Every sound is synthesized; there
 * are NO binary assets and NO npm audio deps (Web Audio API only). The recipes are tuned to
 * the genre (Restrepo/WAR/The Outpost): the crack-thump of incoming, the SAW's rip vs a PKM
 * hammer, the mortar's shot/splash, the danger-close klaxon, the TIC sting.
 *
 * This file (and player.ts) are the ONLY audio files that touch AudioContext. The mapper is
 * pure; this is the "draw call". Per-cue jitter comes from cue.v (deterministic 0..1).
 *
 * Spatialization is applied by the caller (player.ts) via a shared `Spatial` it passes in:
 * a per-cue lowpass cutoff (air absorption), a gain multiplier (distance), a pan, and the
 * crack/thump scheduling offsets (speed of sound). synth.ts only builds the source timbre.
 */
import type { AudioCue } from "./cue";

/** The spatialized parameters the player computes per cue and hands to the synth. */
export interface Spatial {
  /** seconds from ctx.currentTime at which the bright/crack layer should start. */
  crackAt: number;
  /** seconds from ctx.currentTime for the low body/report (>= crackAt; the thump for far events). */
  thumpAt: number;
  /** 0..1 distance gain (already folded with cue.gain and master). */
  gain: number;
  /** stereo pan -1..1. */
  pan: number;
  /** lowpass cutoff Hz for the far-attenuated highs (air absorption). */
  cutoff: number;
  /** true once the event is far enough that the crack and thump are perceptibly split. */
  split: boolean;
}

/** A reusable graph + the time (ctx.currentTime-relative seconds) it finishes, so the player
 *  can schedule teardown / count polyphony. */
export interface Voice {
  /** ctx-absolute time the last node stops — the player tears down a hair after this. */
  endTime: number;
}

// ----------------------------------------------------------------------------- shared state
let _noise: AudioBuffer | null = null;
/** One second of white noise, built once, shared by every noise-burst (cheap, immutable). */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (_noise && _noise.sampleRate === ctx.sampleRate) return _noise;
  const len = Math.floor(ctx.sampleRate * 1);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // render-side only; never feeds the sim
  _noise = buf;
  return buf;
}

// ----------------------------------------------------------------------------- primitives
/** A short filtered white-noise burst with an exponential decay envelope. */
function noiseBurst(
  ctx: AudioContext,
  dst: AudioNode,
  at: number,
  dur: number,
  filter: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  attack = 0.001,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(dst);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** A pitched oscillator tone sweeping f0->f1 with an exp-decay envelope. */
function tone(
  ctx: AudioContext,
  dst: AudioNode,
  at: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
  attack = 0.002,
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(dst);
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** A low sub-bass thump (sine), the body of a report / blast. */
function sub(ctx: AudioContext, dst: AudioNode, at: number, f0: number, f1: number, dur: number, peak: number): void {
  tone(ctx, dst, at, "sine", f0, f1, dur, peak, 0.004);
}

// ----------------------------------------------------------------------------- recipes
/**
 * Synthesize one cue into `out` (a per-cue gain node already wired to pan->master).
 * Returns a Voice with the finish time. `now` is ctx.currentTime. All scheduling is offset
 * by the player-supplied crackAt/thumpAt so a distant event's report lags its flash.
 */
export function synthCue(ctx: AudioContext, out: GainNode, cue: AudioCue, sp: Spatial, now: number): Voice {
  const j = (lo: number, hi: number) => lo + cue.v * (hi - lo); // deterministic jitter from cue.v
  const crack = now + sp.crackAt;
  const thump = now + sp.thumpAt;

  switch (cue.kind) {
    // --- small arms -------------------------------------------------------------------
    case "muzzle_us": {
      // Tight, bright M4-class crack + a short body.
      noiseBurst(ctx, out, crack, 0.045, "highpass", 2000, 0.7, 1.0);
      noiseBurst(ctx, out, crack, 0.04, "peaking", j(3500, 4500), 6, 0.9);
      sub(ctx, out, crack, 180, 90, 0.06, 0.4);
      return { endTime: crack + 0.1 };
    }
    case "muzzle_insurgent": {
      // Lower, woodier AK-class report — the audible enemy-vs-us split with no weaponId.
      noiseBurst(ctx, out, crack, 0.07, "highpass", 1500, 0.6, 0.9);
      noiseBurst(ctx, out, crack, 0.06, "peaking", j(2500, 3200), 3, 0.85);
      sub(ctx, out, crack, 140, 70, 0.07, 0.45);
      return { endTime: crack + 0.13 };
    }
    case "mg_us": {
      // SAW rip — a single cue == a burst of 5-9 cracks at ~70 ms (≈850 RPM), falling gain.
      const n = Math.round(j(5, 9));
      const step = j(0.064, 0.078);
      for (let i = 0; i < n; i++) {
        const t = crack + i * step;
        const g = 1 - (i / n) * 0.5;
        noiseBurst(ctx, out, t, 0.04, "highpass", 2000, 0.7, 0.95 * g);
        noiseBurst(ctx, out, t, 0.035, "peaking", j(3400, 4400), 6, 0.85 * g);
        sub(ctx, out, t, 180, 95, 0.05, 0.35 * g);
      }
      return { endTime: crack + n * step + 0.08 };
    }
    case "mg_insurgent": {
      // PKM hammer — slower (~95 ms, ≈650 RPM), heavier, deeper: the gun from the high ground.
      const n = Math.round(j(4, 7));
      const step = j(0.088, 0.102);
      for (let i = 0; i < n; i++) {
        const t = crack + i * step;
        const g = 1 - (i / n) * 0.4;
        noiseBurst(ctx, out, t, 0.06, "highpass", 1400, 0.6, 0.95 * g);
        noiseBurst(ctx, out, t, 0.05, "peaking", j(2400, 3000), 3, 0.85 * g);
        sub(ctx, out, t, 130, 62, 0.07, 0.5 * g);
      }
      return { endTime: crack + n * step + 0.1 };
    }
    case "nearmiss": {
      // Supersonic snap then a 30 Hz thump (only the player schedules this for far+toward events).
      noiseBurst(ctx, out, crack, 0.02, "bandpass", j(2200, 3000), 4, 0.8);
      sub(ctx, out, thump, 34, 26, 0.06, 0.6);
      return { endTime: thump + 0.1 };
    }

    // --- round terminal effects -------------------------------------------------------
    case "impact": {
      // Bullets striking dirt/rock — a tiny lowpassed tick.
      noiseBurst(ctx, out, crack, 0.06, "lowpass", j(260, 360), 1, 0.7);
      return { endTime: crack + 0.1 };
    }
    case "ricochet": {
      // The classic zing: a sine swept down with a fast vibrato through a bandpass.
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(j(2300, 2700), crack);
      o.frequency.exponentialRampToValueAtTime(j(600, 800), crack + 0.18);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 30;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 60;
      lfo.connect(lfoGain).connect(o.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1500;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, crack);
      g.gain.exponentialRampToValueAtTime(0.7, crack + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, crack + 0.18);
      o.connect(bp).connect(g).connect(out);
      o.start(crack);
      o.stop(crack + 0.2);
      lfo.start(crack);
      lfo.stop(crack + 0.2);
      return { endTime: crack + 0.22 };
    }

    // --- high explosive ---------------------------------------------------------------
    case "blast_small": {
      // RPG / 40mm: a sub boom + lowpassed noise + a click transient.
      noiseBurst(ctx, out, crack, 0.004, "highpass", 1000, 0.5, 0.9); // click
      sub(ctx, out, crack, 70, 35, 0.25, 0.9);
      noiseBurst(ctx, out, crack, 0.18, "lowpass", 800, 0.8, 0.7);
      return { endTime: crack + 0.3 };
    }
    case "blast_large": {
      // Mortar / 120: deeper, longer rumble; a casing pre-crack.
      noiseBurst(ctx, out, crack, 0.006, "highpass", 800, 0.5, 0.9);
      sub(ctx, out, thump, 55, 22, 0.5, 1.0);
      noiseBurst(ctx, out, thump, 0.6, "lowpass", 400, 0.7, 0.7);
      return { endTime: thump + 0.65 };
    }
    case "ied": {
      // The signature opener — loudest single sound: hard over-pressure transient + a deep
      // sub + a long dirt rumble, run through a soft clipper for the "felt-it-in-the-chest" bite.
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) {
        const x = (i / 256) * 2 - 1;
        curve[i] = Math.tanh(x * 2.2);
      }
      shaper.curve = curve;
      shaper.connect(out);
      noiseBurst(ctx, shaper, crack, 0.002, "highpass", 20, 0.3, 1.0); // full-band over-pressure
      sub(ctx, shaper, crack, 60, 20, 0.6, 1.0);
      noiseBurst(ctx, shaper, crack, 0.7, "lowpass", 350, 0.7, 0.85);
      return { endTime: crack + 0.75 };
    }

    // --- atmospherics -----------------------------------------------------------------
    case "smoke_pop": {
      noiseBurst(ctx, out, crack, 0.08, "bandpass", 400, 2, 0.7); // thunk
      noiseBurst(ctx, out, crack + 0.05, 0.25, "highpass", 3000, 0.5, 0.3); // billow hiss
      return { endTime: crack + 0.32 };
    }
    case "frag_air": {
      // A tighter, higher airburst with a metallic shimmer.
      sub(ctx, out, crack, 120, 60, 0.16, 0.7);
      noiseBurst(ctx, out, crack, 0.12, "lowpass", 1200, 0.8, 0.6);
      tone(ctx, out, crack, "square", 1200, 1100, 0.12, 0.12);
      tone(ctx, out, crack, "square", 1800, 1650, 0.12, 0.1);
      return { endTime: crack + 0.16 };
    }
    case "flare": {
      // Faint pfft + a soft rising hiss; atmospheric only.
      noiseBurst(ctx, out, crack, 0.03, "bandpass", 900, 2, 0.4);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.setValueAtTime(1000, crack);
      f.frequency.linearRampToValueAtTime(3000, crack + 0.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, crack);
      g.gain.exponentialRampToValueAtTime(0.18, crack + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, crack + 0.4);
      src.connect(f).connect(g).connect(out);
      src.start(crack);
      src.stop(crack + 0.42);
      return { endTime: crack + 0.44 };
    }

    // --- net + indirect ---------------------------------------------------------------
    case "radio": {
      // Squelch -> beep -> squelch-off, sitting UNDER the line (the player ducks this hard).
      noiseBurst(ctx, out, crack, 0.03, "bandpass", j(1200, 2400), 3, 0.5); // open squelch
      tone(ctx, out, crack + 0.03, "square", 1200, 1200, 0.06, 0.25); // beep
      noiseBurst(ctx, out, crack + 0.1, 0.02, "bandpass", 1800, 3, 0.35); // close squelch
      return { endTime: crack + 0.13 };
    }
    case "shot": {
      // The tube report, off-map: a lowpassed sub thump + a faint mechanical click. "Shot, over."
      noiseBurst(ctx, out, crack, 0.004, "lowpass", 600, 0.5, 0.5); // click
      sub(ctx, out, crack, 60, 40, 0.2, 0.7);
      return { endTime: crack + 0.24 };
    }
    case "splash": {
      // Rounds landing AT the target: a positional blast_large body (the individual landing
      // rounds are separate `blast` effects already in the fx stream — counted there).
      noiseBurst(ctx, out, crack, 0.006, "highpass", 800, 0.5, 0.9);
      sub(ctx, out, thump, 55, 22, 0.5, 1.0);
      noiseBurst(ctx, out, thump, 0.6, "lowpass", 400, 0.7, 0.7);
      return { endTime: thump + 0.65 };
    }
    case "dangerclose": {
      // Two-tone klaxon, non-positional, slightly distorted: "rounds danger close."
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) curve[i] = Math.tanh(((i / 256) * 2 - 1) * 1.6);
      shaper.curve = curve;
      shaper.connect(out);
      for (let i = 0; i < 3; i++) {
        const t = crack + i * 0.24;
        tone(ctx, shaper, t, "square", 700, 700, 0.11, 0.4);
        tone(ctx, shaper, t + 0.12, "square", 520, 520, 0.11, 0.4);
      }
      return { endTime: crack + 0.8 };
    }

    // --- AWE: the contact sting ------------------------------------------------------
    case "tic_sting": {
      // A low 45 Hz drone fading in/out (the "oh shit, it's on" floor) + a rising sting +
      // a soft cymbal-ish noise swell. The only musical element — subtle, rare, gated to the
      // TIC rising edge.
      const drone = ctx.createOscillator();
      drone.type = "sine";
      drone.frequency.value = 45;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.0001, crack);
      dg.gain.exponentialRampToValueAtTime(0.5, crack + 0.4);
      dg.gain.exponentialRampToValueAtTime(0.0001, crack + 3.0);
      drone.connect(dg).connect(out);
      drone.start(crack);
      drone.stop(crack + 3.1);
      tone(ctx, out, crack, "sine", 110, 160, 0.25, 0.4); // rising sting
      noiseBurst(ctx, out, crack, 0.6, "highpass", 1500, 0.4, 0.25); // swell
      return { endTime: crack + 3.1 };
    }
  }
}

/** Which cues spatialize (positional). Non-positional cues are centered, full-band. */
export function isPositional(kind: AudioCue["kind"]): boolean {
  switch (kind) {
    case "radio":
    case "shot":
    case "dangerclose":
    case "tic_sting":
      return false;
    default:
      return true;
  }
}
