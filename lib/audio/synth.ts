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

// ----------------------------------------------------------------------------- weapon table
/**
 * The per-weapon parameter table that drives the 5-LAYER gunfire stack. One row per audible
 * weapon class — we have no per-weapon id on the Effect, only faction + size>=1.5 ⇒ MG, so a
 * cue.kind maps 1:1 to a row. US (5.56) is bright/sharp; insurgent (7.62) is woodier/lower —
 * THAT centre-frequency split is the audible enemy-vs-us tell. Exported so the offline oracle
 * and any test can read the exact values the live mix uses (Law 4) — realism is checkable, not
 * vibes (FM 3-22.9 small-arms report character; the muzzle blast carries calibre identity).
 *
 * Layers (see synthCue): 1 TRANSIENT (shared <5 ms click), 2 BODY (bandpass @ bodyCenterHz),
 * 3 SUB (chest punch subF0→subF1), 4 MECHANICAL (bolt clack after the report), 5 TAIL (not here
 * — player.ts feeds the reverb send from the whole cue; synth.ts only leaves headroom).
 */
export interface WeaponVoice {
  /** layer 2 — broadband report carrying weapon identity (bandpass centre Hz). */
  bodyCenterHz: number;
  /** layer 2 — bandpass Q (lower = woodier/broader for 7.62). */
  bodyQ: number;
  /** layer 2 — report duration s. */
  bodyDur: number;
  /** layer 2 — the bright formant/colour band (a 2nd bandpass above bodyCenter); 4.2 kHz US
   *  vs 3.0 kHz INS is the dominant 5.56-vs-7.62 brightness tell. */
  formantHz: number;
  /** layer 3 — sub start Hz (chest punch). */
  subF0: number;
  /** layer 3 — sub end Hz. */
  subF1: number;
  /** layer 3 — sub duration s. */
  subDur: number;
  /** N-wave (ballistic shock period) duration s — tighter = sharper snap. */
  nwaveDur: number;
  /** N-wave highpass corner Hz — weapon-tinted shock (5.56 higher than 7.62). */
  nwaveHP: number;
  /** MG burst inter-shot step range [lo,hi] s (rate of fire); undefined for single rifles. */
  rpmStep?: [number, number];
  /** MG burst count range [lo,hi]; undefined for single rifles. */
  burst?: [number, number];
  /** MG burst gain falloff across the burst (0.5 ⇒ last shot at 50%). */
  falloff?: number;
}

/** The shipped values. US bright/sharp (5.56), insurgent woodier/lower (7.62). */
export const WEAPON_TABLE: Record<"muzzle_us" | "muzzle_insurgent" | "mg_us" | "mg_insurgent", WeaponVoice> = {
  muzzle_us: {
    bodyCenterHz: 3500, bodyQ: 1.5, bodyDur: 0.05, formantHz: 4200,
    subF0: 180, subF1: 90, subDur: 0.06,
    nwaveDur: 0.00035, nwaveHP: 5000,
  },
  muzzle_insurgent: {
    bodyCenterHz: 2600, bodyQ: 1.2, bodyDur: 0.075, formantHz: 3000,
    subF0: 140, subF1: 68, subDur: 0.07,
    nwaveDur: 0.0006, nwaveHP: 3500,
  },
  mg_us: {
    bodyCenterHz: 3700, bodyQ: 1.8, bodyDur: 0.045, formantHz: 4400,
    subF0: 180, subF1: 95, subDur: 0.05,
    nwaveDur: 0.00035, nwaveHP: 5200,
    rpmStep: [0.064, 0.078], burst: [5, 9], falloff: 0.5, // ~850 rpm SAW rip
  },
  mg_insurgent: {
    bodyCenterHz: 2400, bodyQ: 1.0, bodyDur: 0.085, formantHz: 2800,
    subF0: 130, subF1: 60, subDur: 0.07,
    nwaveDur: 0.0007, nwaveHP: 3300,
    rpmStep: [0.088, 0.102], burst: [4, 7], falloff: 0.4, // ~650 rpm PKM hammer
  },
};

/**
 * Build ONE shot from the 5-LAYER stack into `out` at time `t`. This is the single unified
 * gunfire mechanism (Law 6) — a single rifle crack is just a 1-shot "burst", and the MG loop
 * calls this per round. `w` is the weapon row; `vi` is a deterministic 0..1 per-shot jitter seed
 * (golden-ratio walked across a burst); `bg` is the burst gain for this shot (1 for singles);
 * `firstInBurst` drives the SUB policy (full sub only on the first round to avoid low-end mud).
 */
function gunShot(ctx: AudioContext, out: AudioNode, t: number, w: WeaponVoice, vi: number, bg: number, firstInBurst: boolean): void {
  // per-shot deterministic jitter: body ±8%, peak ±15%, decay ±12%, timing ±4 ms.
  const k = (lo: number, hi: number) => lo + vi * (hi - lo);
  const bodyJ = k(0.92, 1.08);
  const peakJ = k(0.85, 1.15);
  const decJ = k(0.88, 1.12);
  const at = t + k(-0.004, 0.004);

  // LAYER 1 — TRANSIENT: the <5 ms attack click ("how close"). Shared across all weapons.
  noiseBurst(ctx, out, at, 0.004, "highpass", 6000, 0.5, 1.0 * bg * peakJ, 0.00005);

  // LAYER 2 — BODY: broadband report carrying weapon identity. The bandpass centre IS the
  // calibre tell (5.56 ~3.5 kHz vs 7.62 ~2.6 kHz), so it must be loud enough to move the
  // spectral brightness — not buried under the sub. A bright formant burst at formantHz
  // (4.2 kHz US vs 3.0 kHz INS) is the dominant identity tell — it's what makes 5.56 audibly
  // sharper than 7.62.
  noiseBurst(ctx, out, at, w.bodyDur * decJ, "bandpass", w.bodyCenterHz * bodyJ, w.bodyQ, 1.0 * bg * peakJ);
  noiseBurst(ctx, out, at, w.bodyDur * decJ, "bandpass", w.formantHz * bodyJ, 1.4, 0.9 * bg * peakJ);

  // LAYER 3 — SUB: 30–120 Hz chest punch — felt, not the identity. Kept under the body so it
  // punches without dominating brightness. Full only on the first round of a burst; reduced
  // after (avoids low-end mud building across a long burst).
  const subGain = (firstInBurst ? 0.32 : 0.14) * bg;
  sub(ctx, out, at, w.subF0, w.subF1, w.subDur * decJ, subGain);

  // LAYER 4 — MECHANICAL: the bolt clack 12–25 ms AFTER the report — what makes it a real action.
  noiseBurst(ctx, out, at + k(0.012, 0.025), 0.006, "bandpass", 3000 * bodyJ, 5, 0.12 * bg, 0.0006);

  // LAYER 5 — TAIL: NOT synthesized here — player.ts feeds a reverb send from the whole cue.
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
      // Tight, bright M4-class crack: the 5-layer stack, one shot. (US = sharp 5.56.)
      gunShot(ctx, out, crack, WEAPON_TABLE.muzzle_us, cue.v, 1, true);
      return { endTime: crack + WEAPON_TABLE.muzzle_us.subDur + 0.06 };
    }
    case "muzzle_insurgent": {
      // Lower, woodier AK-class report — the audible enemy-vs-us split with no weaponId.
      gunShot(ctx, out, crack, WEAPON_TABLE.muzzle_insurgent, cue.v, 1, true);
      return { endTime: crack + WEAPON_TABLE.muzzle_insurgent.subDur + 0.07 };
    }
    // Belt-fed MGs (M240/M2 · PKM/DShK) carry the HEAVIER 7.62/.50 timbre but fire exactly ONE
    // crack per cue: the sim already emits one muzzle effect PER ROUND (combat.ts fireRound) at the
    // gun's true cyclic spacing, so the mapper sends one cue per round. The old per-cue 5-9 round
    // burst MULTIPLIED that — an 8-round M240 burst became ~40-70 cracks, a buzzing roar instead of
    // a recognizable hammer. Cadence is now emergent from the sim's roundTimer (Law 6), not a synth
    // burst fighting it. (SAW/RPK are cls=lmg, size=1 → routed to muzzle_* single cracks already.)
    case "mg_us": {
      gunShot(ctx, out, crack, WEAPON_TABLE.mg_us, cue.v, 1, true);
      return { endTime: crack + WEAPON_TABLE.mg_us.subDur + 0.06 };
    }
    case "mg_insurgent": {
      gunShot(ctx, out, crack, WEAPON_TABLE.mg_insurgent, cue.v, 1, true);
      return { endTime: crack + WEAPON_TABLE.mg_insurgent.subDur + 0.08 };
    }
    case "nearmiss": {
      // The N-WAVE: the ballistic shockwave (separate from the muzzle report). We model the
      // shock PERIOD, not the full Whitham waveform — a single tight highpassed noise SNAP,
      // weapon-tinted by the same N-wave corner the rounds carry, then a low thump at the
      // s.o.s. delay (the "snap … crump" of an incoming round). Faction is unknown on a
      // near-miss tail, so we use the insurgent N-wave corner (incoming is the enemy's).
      const w = WEAPON_TABLE.muzzle_insurgent;
      // a tight 2–4 kHz tick reads better than a pure highpass (which sounds thin), tinted by
      // the weapon's N-wave corner; ~0.5 ms keeps the snap sharp.
      noiseBurst(ctx, out, crack, 0.0005 + w.nwaveDur, "highpass", w.nwaveHP, 0.3, 1.0, 0.00005);
      noiseBurst(ctx, out, crack, 0.012, "bandpass", j(2200, 3000), 4, 0.7);
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
      // THREE deterministic timbre families off cue.v — every deflection identical was the single
      // most repetitive sound in a long firefight. All share the swept-sine-through-bandpass core;
      // what varies is what a real deflection varies by: how long the fragment sings (dwell), how
      // fast it tumbles (vibrato rate), and how far the pitch falls.
      //   v<0.45 ZING  — the classic long singing whine (rock face, shallow graze)
      //   v<0.75 BUZZ  — short, hard, fast-tumbling (a destabilized fragment, barely sings)
      //   else   WHINE — high thin start, long slow fall (the Hollywood spinner, kept rare)
      const fam = cue.v < 0.45 ? 0 : cue.v < 0.75 ? 1 : 2;
      const dur = fam === 0 ? j(0.16, 0.2) : fam === 1 ? j(0.07, 0.1) : j(0.26, 0.34);
      const fStart = fam === 2 ? j(3200, 3800) : j(2300, 2700);
      const fEnd = fam === 1 ? j(1100, 1400) : j(550, 800);
      const vibRate = fam === 1 ? 70 : 30;
      const vibDepth = fam === 1 ? 140 : 60;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(fStart, crack);
      o.frequency.exponentialRampToValueAtTime(fEnd, crack + dur);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vibRate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = vibDepth;
      lfo.connect(lfoGain).connect(o.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = fam === 2 ? 2100 : 1500;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, crack);
      g.gain.exponentialRampToValueAtTime(fam === 1 ? 0.8 : 0.7, crack + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, crack + dur);
      o.connect(bp).connect(g).connect(out);
      o.start(crack);
      o.stop(crack + dur + 0.02);
      lfo.start(crack);
      lfo.stop(crack + dur + 0.02);
      // the initial impact tick the whine spins off from (all families) — grounds the zing in a hit.
      noiseBurst(ctx, out, crack, 0.012, "bandpass", j(2500, 3500), 3, 0.5, 0.0005);
      return { endTime: crack + dur + 0.04 };
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
    case "incoming": {
      // The descending shell whistle — the 2.2 s shriek before the splash (the mapper fires this
      // INCOMING_LEAD_S before the round lands, so the whistle ends as the blast arrives). Two
      // swelling layers: a pitched whine sweeping down ~1.3 kHz→320 Hz with a growing flutter
      // (the tumbling-shell instability), and a bandpass whoosh tracking an octave above it.
      // Approach physics in the envelope: starts a whisper, peaks just before impact.
      const dur = 2.2;
      const f0 = 1200 + cue.v * 350;
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(f0, crack);
      o.frequency.exponentialRampToValueAtTime(320, crack + dur);
      const flut = ctx.createOscillator(); // flutter deepens as the round closes
      flut.frequency.setValueAtTime(6, crack);
      flut.frequency.linearRampToValueAtTime(11, crack + dur);
      const flutAmt = ctx.createGain();
      flutAmt.gain.setValueAtTime(4, crack);
      flutAmt.gain.linearRampToValueAtTime(38, crack + dur);
      flut.connect(flutAmt).connect(o.frequency);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, crack);
      og.gain.exponentialRampToValueAtTime(0.55, crack + dur * 0.85); // the swell IS the dread
      og.gain.exponentialRampToValueAtTime(0.0001, crack + dur);
      o.connect(og).connect(out);
      o.start(crack);
      o.stop(crack + dur + 0.02);
      flut.start(crack);
      flut.stop(crack + dur + 0.02);
      // the air-tearing whoosh: swept bandpass noise an octave up, same swell.
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(f0 * 2, crack);
      bp.frequency.exponentialRampToValueAtTime(650, crack + dur);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, crack);
      ng.gain.exponentialRampToValueAtTime(0.4, crack + dur * 0.9);
      ng.gain.exponentialRampToValueAtTime(0.0001, crack + dur);
      src.connect(bp).connect(ng).connect(out);
      src.start(crack);
      src.stop(crack + dur + 0.02);
      return { endTime: crack + dur + 0.05 };
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
