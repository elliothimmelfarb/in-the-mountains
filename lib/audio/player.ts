/**
 * player.ts — BROWSER. The AudioEngine: AudioContext lifecycle + unlock-on-gesture, master
 * volume/mute, the per-frame schedule loop, distance/pan/speed-of-sound spatialization, the
 * pause/warp gate, and a polyphony cap. Holds ONE CueMapper; each `tick()` collects fresh
 * cues from the live sim and schedules them with Web Audio. Render-side: it freely uses
 * ctx.currentTime for scheduling and never feeds anything back into lib/sim (Law 7).
 *
 * SSR-safe: nothing browser is touched at construction. The AudioContext is created lazily
 * and resumed only inside a user gesture (browser autoplay policy + Next 16 client rules).
 */
import type { Camera } from "../render/topo";
import { CueMapper, type CueSource } from "./mapper";
import { type AudioCue, type CueKind } from "./cue";
import { synthCue, isPositional, type Spatial } from "./synth";

const SPEED_OF_SOUND = 343; // m/s — the crack-thump split
const MAX_VOICES = 24; // hard polyphony cap (a 30-man firefight must not allocate hundreds/frame)
const DEFAULT_VOLUME = 0.6;

/** Per-cue static loudness trim so the mix sits right (a single muzzle must not be as loud as
 *  an IED). Multiplies the cue's own gain + distance + master. */
const KIND_TRIM: Record<CueKind, number> = {
  muzzle_us: 0.5,
  muzzle_insurgent: 0.5,
  mg_us: 0.55,
  mg_insurgent: 0.6,
  impact: 0.4,
  ricochet: 0.45,
  nearmiss: 0.5,
  blast_small: 0.8,
  blast_large: 0.95,
  ied: 1.0,
  smoke_pop: 0.4,
  frag_air: 0.7,
  flare: 0.3,
  radio: 0.32, // ducked: sits UNDER the log line
  shot: 0.6,
  splash: 0.9,
  dangerclose: 0.7,
  tic_sting: 0.7,
};

/** The flags `frame()` already computes — the gate the audio tick obeys. */
export interface AudioFlags {
  running: boolean; // !paused && !pendingEvent
  paused: boolean;
  warp: boolean;
  inContact: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly mapper = new CueMapper();
  private cam: Camera | null = null;
  private unlocked = false;
  private muted = false;
  private volume = DEFAULT_VOLUME;
  private activeVoices = 0;

  /** Debug ring buffer the live harness reads via window — proves audio actually fired on a
   *  real TIC without needing to listen. Render-only. */
  readonly debugCues: { kind: CueKind; t: number }[] = [];

  // -------------------------------------------------------------- lifecycle / unlock
  /** Create+resume the context inside a user gesture, with the iOS silent-buffer ritual.
   *  Idempotent — safe to attach to several once-listeners. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    // iOS unlock ritual: play a 1-sample silent buffer.
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
    this.unlocked = true;
  }

  setCamera(cam: Camera): void {
    this.cam = cam;
  }

  setMasterVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx && !this.muted) {
      // ramp, never step, to avoid a click.
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  // -------------------------------------------------------------- the per-frame tick
  /**
   * Called once per rendered frame from store.frame(). Always advances the mapper's marks so
   * "what's new" never goes stale (identical to noteCombatEffects running every frame); only
   * SCHEDULES sound when live.
   */
  tick(sim: CueSource, flags: AudioFlags): void {
    // GATE: nothing plays during pause/warp/un-unlocked. We still fast-forward the marks so a
    // resume doesn't dump a backlog of cues that piled up while skipping.
    if (!this.unlocked || !this.ctx || !this.master) {
      this.mapper.skip(sim);
      return;
    }
    if (!flags.running || flags.paused || flags.warp) {
      this.mapper.skip(sim);
      return;
    }

    const cues = this.mapper.collect(sim);
    if (!cues.length) return; // the readable "calm-before" silence is free: no events => no sound

    const now = this.ctx.currentTime;
    for (const cue of cues) {
      if (this.activeVoices >= MAX_VOICES) {
        // overload: drop the quietest pending cues so the mix doesn't clip in a 30-man fight.
        // (A coarse but effective limiter — mirrors the LOD-haze philosophy in combat-fx.ts.)
        continue;
      }
      this.schedule(cue, now);
    }
  }

  // -------------------------------------------------------------- scheduling one cue
  private schedule(cue: AudioCue, now: number): void {
    const ctx = this.ctx!;
    const master = this.master!;
    const sp = this.spatial(cue);
    if (!sp) return; // culled (inaudible / off-screen-far)

    // per-cue chain: synth -> cueGain -> panner -> master
    const cueGain = ctx.createGain();
    cueGain.gain.value = sp.gain * cue.gain * KIND_TRIM[cue.kind];
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    // air-absorption lowpass on the whole cue for far events.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = sp.cutoff;
    cueGain.connect(lp).connect(pan).connect(master);

    const voice = synthCue(ctx, cueGain, cue, sp, now);
    this.activeVoices++;
    this.debugCues.push({ kind: cue.kind, t: now });
    if (this.debugCues.length > 64) this.debugCues.shift();

    // tear down a hair after the last node stops; free the polyphony slot.
    const lifeMs = Math.max(60, (voice.endTime - now) * 1000 + 80);
    window.setTimeout(() => {
      try {
        cueGain.disconnect();
        lp.disconnect();
        pan.disconnect();
      } catch {
        /* already gone */
      }
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, lifeMs);

    // distant direct fire gets a separate near-miss thump tail (the crack-thump signature).
    if (sp.split && (cue.kind === "muzzle_us" || cue.kind === "muzzle_insurgent" || cue.kind === "mg_us" || cue.kind === "mg_insurgent")) {
      this.scheduleNearmissTail(cue, sp, now);
    }
  }

  /** The low *thump* of a distant report, scheduled at the speed-of-sound delay after the
   *  bright crack — the "you see the flash, then hear it" beat. Counted as one extra voice. */
  private scheduleNearmissTail(cue: AudioCue, sp: Spatial, now: number): void {
    if (this.activeVoices >= MAX_VOICES) return;
    const ctx = this.ctx!;
    const master = this.master!;
    const g = ctx.createGain();
    g.gain.value = sp.gain * 0.6 * KIND_TRIM.nearmiss;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    g.connect(pan).connect(master);
    const tailCue: AudioCue = { ...cue, kind: "nearmiss" };
    const voice = synthCue(ctx, g, tailCue, sp, now);
    this.activeVoices++;
    const lifeMs = Math.max(60, (voice.endTime - now) * 1000 + 80);
    window.setTimeout(() => {
      try {
        g.disconnect();
        pan.disconnect();
      } catch {
        /* gone */
      }
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, lifeMs);
  }

  // -------------------------------------------------------------- spatialization
  /**
   * Distance attenuation, low-pass-far, stereo pan, and the speed-of-sound crack/thump split.
   * The listener is the camera center; zoom (ppm) scales the audible world radius. Returns
   * null to cull inaudible/too-far cues.
   */
  private spatial(cue: AudioCue): Spatial | null {
    // non-positional cues: centered, full-band, no delay.
    if (!cue.pos || !isPositional(cue.kind) || !this.cam) {
      return { crackAt: 0.0, thumpAt: 0.0, gain: 1, pan: 0, cutoff: 14000, split: false };
    }
    const cam = this.cam;
    const dx = cue.pos.x - cam.cx;
    const dy = cue.pos.y - cam.cy;
    const distM = Math.hypot(dx, dy);

    // audible radius scales with zoom: zoomed in => smaller world on screen => closer feel.
    const halfW = (cam.vw * 0.5) / Math.max(0.01, cam.ppm); // metres center->edge
    const ref = Math.max(150, halfW); // never below 150 m so tight zoom isn't deaf
    const AUDIBLE_M = ref * 4; // 4 screens out = edge of audibility

    const norm = Math.min(1, distM / AUDIBLE_M);
    const atten = Math.pow(Math.max(0, 1 - norm), 1.6);
    if (atten < 0.02) return null; // cull inaudible

    const cutoff = 12000 + (700 - 12000) * norm; // 12 kHz near -> 700 Hz far
    const sx = (dx * cam.ppm) / Math.max(1, cam.vw * 0.5); // screen-space -1..1 at edges
    const pan = Math.max(-1, Math.min(1, sx));

    const delayS = distM / SPEED_OF_SOUND; // e.g. 600 m => ~1.75 s
    const split = delayS > 0.08; // collapse near events to a single sound
    return {
      crackAt: 0.0,
      thumpAt: split ? delayS : 0.0,
      gain: atten,
      pan,
      cutoff: Math.max(400, cutoff),
      split,
    };
  }
}

export type { CueSource };
