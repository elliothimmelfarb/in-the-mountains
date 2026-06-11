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
  /** layer 1 transient highpass corner Hz (default 6000) — the .50s blast LOW even at the
   *  attack; leaving the shared 6 kHz click at full peak made every gun equally bright. */
  transHP?: number;
  /** layer 1 transient peak (default 1.0). */
  transPeak?: number;
  /** MG burst inter-shot step range [lo,hi] s (rate of fire); undefined for single rifles. */
  rpmStep?: [number, number];
  /** MG burst count range [lo,hi]; undefined for single rifles. */
  burst?: [number, number];
  /** MG burst gain falloff across the burst (0.5 ⇒ last shot at 50%). */
  falloff?: number;
  /** bolt-action: schedule the two-clack bolt cycle (open ~0.45 s, close ~0.65 s) after the shot —
   *  the M24/Enfield signature a one-shot semi-auto never makes. */
  boltCycle?: boolean;
}

/** The shipped CLASS values. US bright/sharp (5.56), insurgent woodier/lower (7.62); the .50s
 *  are a different animal — slow, concussive, more muzzle-blast wash than crack. */
export const WEAPON_TABLE: Record<"muzzle_us" | "muzzle_insurgent" | "mg_us" | "mg_insurgent" | "hmg_us" | "hmg_insurgent", WeaponVoice> = {
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
  hmg_us: {
    // M2 Browning: ~550 rpm, a deep PUNCHING report — the COP's voice. Centre an octave below
    // the 7.62 guns; long body; the sub IS the identity (you feel an M2 before you place it).
    bodyCenterHz: 1500, bodyQ: 0.8, bodyDur: 0.12, formantHz: 2000,
    subF0: 100, subF1: 38, subDur: 0.14,
    nwaveDur: 0.001, nwaveHP: 2200,
    transHP: 2500, transPeak: 0.85,
  },
  hmg_insurgent: {
    // DShK 12.7×108: marginally slower/duller than the M2 — the dreaded ridge gun.
    bodyCenterHz: 1400, bodyQ: 0.8, bodyDur: 0.13, formantHz: 1900,
    subF0: 95, subF1: 36, subDur: 0.15,
    nwaveDur: 0.0011, nwaveHP: 2100,
    transHP: 2300, transPeak: 0.85,
  },
};

/** Per-WEAPON voice overrides (weapons.ts ids), refining the class row above when the cue
 *  carries `wpn`. Only weapons whose report audibly DIFFERS from their faction's class voice
 *  get a row — an M4 vs an M16 is not an audible distinction at combat ranges; an M9 vs an
 *  M24 absolutely is. Exported for the oracle (Law 4). */
export const WEAPON_VOICES: Record<string, WeaponVoice> = {
  // M9 9 mm: a small sharp BARK — short, toppy, nearly subless next to a rifle.
  m9: {
    bodyCenterHz: 3000, bodyQ: 2.5, bodyDur: 0.028, formantHz: 3600,
    subF0: 150, subF1: 100, subDur: 0.03,
    nwaveDur: 0.0004, nwaveHP: 4500,
  },
  // 7.62×51 precision guns (20"+ barrels): a deeper, authoritative single crack vs the M4.
  m110: {
    bodyCenterHz: 3100, bodyQ: 1.3, bodyDur: 0.06, formantHz: 3700,
    subF0: 160, subF1: 75, subDur: 0.08,
    nwaveDur: 0.00045, nwaveHP: 4200,
  },
  m24: {
    bodyCenterHz: 3050, bodyQ: 1.3, bodyDur: 0.065, formantHz: 3650,
    subF0: 160, subF1: 72, subDur: 0.085,
    nwaveDur: 0.00045, nwaveHP: 4200,
    boltCycle: true, // the two-clack cycle after each shot — the sniper's signature
  },
  // SVD 7.62×54R: between the AK and the PKM — long-barrel boom with the eastern woodiness.
  svd: {
    bodyCenterHz: 2500, bodyQ: 1.1, bodyDur: 0.08, formantHz: 2900,
    subF0: 130, subF1: 60, subDur: 0.08,
    nwaveDur: 0.00055, nwaveHP: 3600,
  },
  // Lee-Enfield .303: the elder's gun — broad, woody, unmistakably old, then the slow bolt.
  enfield: {
    bodyCenterHz: 2200, bodyQ: 0.9, bodyDur: 0.09, formantHz: 2600,
    subF0: 125, subF1: 58, subDur: 0.09,
    nwaveDur: 0.0006, nwaveHP: 3200,
    boltCycle: true,
  },
};

/** HE calibre gradation for blast_large: scales sub onset/length + rumble length so a 60 mm
 *  crump, an 82 mm and a 120 mm valley-shaker read as different EVENTS, not volumes. Keyed by
 *  weapons.ts id; 1 = the 81/82 mm reference. Exported for the oracle (Law 4). */
export const BLAST_SCALE: Record<string, number> = {
  mortar60: 0.78,
  mortar81: 1.0,
  mortar82: 1.0,
  mortar120: 1.35,
  mk19: 0.62, // 40×53 mm HE-DP — barely clears the big-blast size gate; keep it a crack, not a boom
  spg9: 0.72,
  at4: 0.72,
  javelin: 0.9,
};

/** Resolve the voice row for a gunfire cue: the per-weapon override when the cue names one,
 *  else the faction/class row for its kind. */
export function voiceFor(kind: "muzzle_us" | "muzzle_insurgent" | "mg_us" | "mg_insurgent" | "hmg_us" | "hmg_insurgent", wpn?: string): WeaponVoice {
  return (wpn && WEAPON_VOICES[wpn]) || WEAPON_TABLE[kind];
}

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

  // LAYER 1 — TRANSIENT: the <5 ms attack click ("how close"). Corner/peak are weapon-tinted
  // (default 6 kHz/1.0): a .50's attack is a low WHUMP, not a rifle's snap.
  noiseBurst(ctx, out, at, 0.004, "highpass", w.transHP ?? 6000, 0.5, (w.transPeak ?? 1.0) * bg * peakJ, 0.00005);

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
    // One crack per cue for ALL guns: the sim emits one muzzle effect PER ROUND (combat.ts
    // fireRound) at the gun's true cyclic spacing, so cadence is emergent from the sim's
    // roundTimer (Law 6) — the old per-cue 5-9 round synth burst MULTIPLIED the sim's rounds
    // into a buzzing roar. The voice row comes from cue.wpn when the effect names the weapon
    // (an M9 bark, an M24 boom-then-bolt) and falls back to the faction/class row.
    case "muzzle_us":
    case "muzzle_insurgent":
    case "mg_us":
    case "mg_insurgent": {
      const w = voiceFor(cue.kind, cue.wpn);
      gunShot(ctx, out, crack, w, cue.v, 1, true);
      if (w.boltCycle) {
        // the bolt cycle: open (extract+eject) then close (strip+chamber) — two distinct
        // mechanical clacks well after the report, quiet, only meaningful for near shooters.
        const tOpen = crack + j(0.42, 0.5);
        noiseBurst(ctx, out, tOpen, 0.012, "bandpass", 2300, 5, 0.1, 0.0006);
        noiseBurst(ctx, out, tOpen + j(0.16, 0.24), 0.014, "bandpass", 1900, 4, 0.12, 0.0006);
        return { endTime: tOpen + 0.3 };
      }
      return { endTime: crack + w.subDur + 0.07 };
    }
    case "hmg_us":
    case "hmg_insurgent": {
      // The .50s (M2 / DShK): the deep slow hammer. The class row carries the low centre; on
      // top, a muzzle-blast WASH — the broadband concussion that makes a .50 read as artillery's
      // little brother rather than a big rifle.
      const w = voiceFor(cue.kind, cue.wpn);
      gunShot(ctx, out, crack, w, cue.v, 1, true);
      noiseBurst(ctx, out, crack, 0.1, "lowpass", 600, 0.7, 0.5); // concussive wash
      return { endTime: crack + w.subDur + 0.12 };
    }
    // --- launches (the projectile's own blast cue arrives separately at impact) ---------
    case "rocket_launch": {
      // RPG-7: booster POP, then the sustainer motor lights ~10 m out — a rising whoosh as it
      // departs. AT4/SPG-9 (recoilless): no flight motor — ONE violent muzzle/venturi bang with
      // a heavy rearward blast wash. Both are unmistakable "RPG!" moments in the accounts.
      const recoilless = cue.wpn === "at4" || cue.wpn === "spg9";
      noiseBurst(ctx, out, crack, 0.003, "highpass", 2500, 0.5, 0.85, 0.00008); // ignition click
      noiseBurst(ctx, out, crack, recoilless ? 0.07 : 0.05, "bandpass", j(750, 950), 1, 1.0); // the pop
      sub(ctx, out, crack, recoilless ? 90 : 80, recoilless ? 45 : 42, recoilless ? 0.12 : 0.1, recoilless ? 0.7 : 0.55);
      noiseBurst(ctx, out, crack, recoilless ? 0.16 : 0.12, "lowpass", 600, 0.7, recoilless ? 0.7 : 0.5); // backblast wash
      if (!recoilless) {
        // sustainer whoosh: bandpass noise sweeping UP as the rocket accelerates away, swelling
        // then dying — the sound that makes everyone's head snap toward the launch point.
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx);
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 1.6;
        bp.frequency.setValueAtTime(j(1100, 1400), crack + 0.03);
        bp.frequency.exponentialRampToValueAtTime(j(2200, 2600), crack + 0.55);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, crack + 0.03);
        g.gain.exponentialRampToValueAtTime(0.45, crack + 0.16);
        g.gain.exponentialRampToValueAtTime(0.0001, crack + 0.6);
        src.connect(bp).connect(g).connect(out);
        src.start(crack + 0.03);
        src.stop(crack + 0.62);
        return { endTime: crack + 0.65 };
      }
      return { endTime: crack + 0.2 };
    }
    case "gl_launch": {
      // 40 mm leaving the tube. M320/M203: the hollow BLOOP (tube resonance, almost comic until
      // you know what follows). Mk 19: a deeper mechanical THUNK-and-clank from the heavy bolt.
      if (cue.wpn === "mk19") {
        noiseBurst(ctx, out, crack, 0.07, "bandpass", 250, 1.5, 0.8); // deep thunk
        sub(ctx, out, crack, 120, 70, 0.08, 0.5);
        noiseBurst(ctx, out, crack + 0.055, 0.012, "bandpass", 1600, 4, 0.3, 0.0006); // bolt clank
        return { endTime: crack + 0.16 };
      }
      tone(ctx, out, crack, "sine", j(270, 300), 180, 0.09, 0.5); // the hollow tube note
      noiseBurst(ctx, out, crack, 0.05, "bandpass", 420, 2, 0.5); // breath of the launch
      noiseBurst(ctx, out, crack, 0.004, "highpass", 1800, 0.5, 0.3, 0.0002); // primer tick
      return { endTime: crack + 0.14 };
    }
    case "reload": {
      // A man swapping mags a few metres away: mag-out clack → mag seated → bolt released.
      // Quiet, dry, strictly mechanical — the sound of a fight breathing between bursts.
      const t0 = crack + j(0, 0.06);
      noiseBurst(ctx, out, t0, 0.012, "bandpass", j(1700, 2000), 4, 0.5, 0.0006); // mag release/out
      noiseBurst(ctx, out, t0 + 0.02, 0.04, "highpass", 3200, 0.7, 0.15); // kit rattle
      noiseBurst(ctx, out, t0 + j(0.24, 0.36), 0.02, "bandpass", j(1100, 1300), 3, 0.7, 0.0008); // mag seated
      noiseBurst(ctx, out, t0 + j(0.46, 0.58), 0.016, "bandpass", j(2400, 2800), 5, 0.6, 0.0006); // bolt release
      return { endTime: t0 + 0.7 };
    }

    case "nearmiss": {
      // The N-WAVE: the ballistic shockwave (separate from the muzzle report). The leading
      // compression SNAP, the rarefaction lobe ~1.5 ms behind it (softer, lower — the "suck"
      // that completes the N), the turbulent-wake sizzle riding the pair, then the low thump
      // at the s.o.s. delay (the "snap … crump" of an incoming round). Faction is unknown on
      // a near-miss tail, so we use the insurgent N-wave corner (incoming is the enemy's).
      const w = WEAPON_TABLE.muzzle_insurgent;
      // a tight 2–4 kHz tick reads better than a pure highpass (which sounds thin), tinted by
      // the weapon's N-wave corner; ~0.5 ms keeps the snap sharp.
      noiseBurst(ctx, out, crack, 0.0005 + w.nwaveDur, "highpass", w.nwaveHP, 0.3, 1.0, 0.00005);
      noiseBurst(ctx, out, crack, 0.012, "bandpass", j(2200, 3000), 4, 0.7);
      noiseBurst(ctx, out, crack + 0.0015, 0.01, "bandpass", j(1500, 2100), 3, 0.45); // rarefaction lobe
      noiseBurst(ctx, out, crack, 0.03, "highpass", 7000, 0.5, 0.22); // wake sizzle
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
      // Mortar/rocket HE: deeper, longer rumble; a casing pre-crack. CALIBRE GRADATION from
      // cue.wpn — a 60 mm crump and a 120 mm valley-shaker are different events, not volumes:
      // bigger charge ⇒ lower sub onset, longer sub and rumble.
      const k = BLAST_SCALE[cue.wpn ?? ""] ?? 1;
      const kd = Math.pow(k, 1.4); // duration grows faster than pitch falls — a 120 ROLLS
      noiseBurst(ctx, out, crack, 0.006, "highpass", 800 / k, 0.5, 0.9);
      sub(ctx, out, thump, 55 / Math.sqrt(k), 22 / Math.sqrt(k), 0.5 * kd, 1.0);
      noiseBurst(ctx, out, thump, 0.6 * kd, "lowpass", 400 / k, 0.7, 0.7);
      return { endTime: thump + 0.65 * kd };
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
      // SOIL LAG: a buried charge HEAVES before it cracks — the ground wave and sub-bass lead,
      // the airborne transient arrives a beat later through the lofted soil cap, and the highs
      // are eaten by the ground (rumble corner 280, was 350). The seismic layer (26→16 Hz,
      // sustained) rides the clipper so harmonics carry it on small speakers.
      sub(ctx, shaper, crack, 26, 16, 1.1, 0.8); // seismic ground wave — felt, then heard
      sub(ctx, shaper, crack, 60, 20, 0.6, 1.0);
      noiseBurst(ctx, shaper, crack + 0.008, 0.002, "highpass", 20, 0.3, 1.0); // lagged over-pressure
      noiseBurst(ctx, shaper, crack, 0.9, "lowpass", 280, 0.7, 0.85);
      return { endTime: crack + 1.15 };
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
      // Net texture keyed off cue.v, SPARSE by design (most squelches stay clean — texture on
      // every keying would read as a broken radio, not a busy net):
      //   v>0.85 — a second station steps on the net (faint crosstalk squelch under the first)
      //   v<0.10 — multipath dropout: the carrier stutters once before the beep
      noiseBurst(ctx, out, crack, 0.03, "bandpass", j(1200, 2400), 3, 0.5); // open squelch
      if (cue.v > 0.85) noiseBurst(ctx, out, crack + 0.045, 0.025, "bandpass", 900 + cue.v * 600, 4, 0.16); // crosstalk
      if (cue.v < 0.1) noiseBurst(ctx, out, crack + 0.035, 0.012, "bandpass", 1600, 5, 0.3); // dropout stutter
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
      flutAmt.gain.linearRampToValueAtTime(52, crack + dur);
      flut.connect(flutAmt).connect(o.frequency);
      // a real shell's shriek is CHAOTIC, not a clean siren: a second incommensurate fast
      // wobble (aero instability) rides the same frequency so the two LFOs never phase-lock —
      // the pitch wanders instead of singing. Rate keyed off cue.v so no two shells wail alike.
      const wob = ctx.createOscillator();
      wob.frequency.setValueAtTime(23 + cue.v * 14, crack);
      const wobAmt = ctx.createGain();
      wobAmt.gain.setValueAtTime(2, crack);
      wobAmt.gain.linearRampToValueAtTime(26, crack + dur);
      wob.connect(wobAmt).connect(o.frequency);
      wob.start(crack);
      wob.stop(crack + dur + 0.02);
      // the broadband SHRILL fused to the tone (Q6 noise tracking f0) — the "tearing" component
      // that keeps the whistle from reading as a musical instrument.
      const shrill = ctx.createBufferSource();
      shrill.buffer = noiseBuffer(ctx);
      shrill.loop = true;
      const sbp = ctx.createBiquadFilter();
      sbp.type = "bandpass";
      sbp.Q.value = 6;
      sbp.frequency.setValueAtTime(f0, crack);
      sbp.frequency.exponentialRampToValueAtTime(320, crack + dur);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, crack);
      sg.gain.exponentialRampToValueAtTime(0.4, crack + dur * 0.85);
      sg.gain.exponentialRampToValueAtTime(0.0001, crack + dur);
      shrill.connect(sbp).connect(sg).connect(out);
      shrill.start(crack);
      shrill.stop(crack + dur + 0.02);
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
