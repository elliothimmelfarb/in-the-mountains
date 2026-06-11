/**
 * player.ts — BROWSER. The AudioEngine: AudioContext lifecycle + unlock-on-gesture, the bus
 * graph, the shared valley reverb, the HDR auto-mixer, control-side ducking, priority
 * voice-stealing, the per-frame schedule loop, distance/occlusion/elevation spatialization, the
 * persistent ambient bed, the pause/warp gate, and the master limiter. Holds ONE CueMapper; each
 * `tick()` collects fresh cues from the live sim and schedules them. Render-side: it freely uses
 * ctx.currentTime for scheduling and never feeds anything back into lib/sim (Law 7).
 *
 * THE GRAPH (built once at unlock). The user's category mixer sits between the buses and
 * master (bus → category → master) so per-category volume/mute NEVER fights the control-side
 * ducking, which rides the bus gains upstream:
 *   destination
 *    └ limiter (DynamicsCompressor, conservative brickwall)
 *       └ master (volume/mute)
 *          ├ cat.combat   ← combatBus (positional fire + HE + the HDR window)
 *          │               ← reverbReturn ← ValleyReverb.convolver ← per-cue wet sends (HP+preDelay)
 *          ├ cat.ambience ← atmosBus (AmbientEngine: wind/river/generator/wildlife); ducks on TIC/HE
 *          ├ cat.radio    ← radioBus (fixed in-handset chain HP550→LP3k→tanh→comp→peak+6@1.5k)
 *          └ cat.alerts   ← scoreBus (tic_sting + the danger-close klaxon — the command channel)
 *
 * Per positional combat cue: cueGain → lowpass(occlusion/air) → [elevation shelf] → pan → combatBus,
 * plus a parallel wet tap cueGain → sendGain → highpass 300 → preDelay → reverb.input. The dry path
 * stays a point source (correct physics); the STEREO reverb IR decorrelates the tail → real width.
 *
 * SSR-safe: nothing browser is touched at construction. The AudioContext is created lazily and
 * resumed only inside a user gesture (browser autoplay policy + Next 16 client rules).
 */
import type { Camera } from "../render/topo";
import { CueMapper, type CueSource } from "./mapper";
import { type AudioCue, type CueKind } from "./cue";
import { synthCue, isPositional, type Spatial } from "./synth";
import { createValleyReverb, type ValleyReverb } from "./reverb";
import { AmbientEngine, type AmbientSignals } from "./ambient";

const SPEED_OF_SOUND = 343; // m/s — the crack-thump split
const MAX_VOICES = 32; // raised from 24: the HDR window pre-culls and the limiter protects the sum
const DEFAULT_VOLUME = 0.6;
const dbToLin = (db: number) => Math.pow(10, db / 20);

/**
 * Player-facing sound CATEGORIES — the on/off + volume groups the settings UI exposes. Each is
 * one gain node between its bus(es) and master (bus → category → master), so user trim NEVER
 * fights the control-side ducking (which rides the bus gains upstream):
 *   combat   — positional fire/HE (combatBus) + the shared valley-reverb return (only combat
 *              kinds have a wet send, so the tail belongs to this category: muting combat must
 *              also silence its echo).
 *   ambience — the AmbientEngine bed (atmosBus): wind/river/generator/wildlife/weather.
 *   radio    — the in-handset net chain (radioBus).
 *   alerts   — the non-diegetic command-channel cues (scoreBus): tic_sting + the danger-close
 *              klaxon. Kept separate so a player can silence the "game" sounds but keep the war.
 */
export type AudioCategory = "combat" | "ambience" | "radio" | "alerts";
export const AUDIO_CATEGORIES: AudioCategory[] = ["combat", "ambience", "radio", "alerts"];

/** Per-cue static loudness trim so the mix sits right (a single muzzle must not be as loud as
 *  an IED). Multiplies the cue's own gain + distance + master. Exported so the offline render
 *  oracle (scripts/audio-render.ts) measures the EXACT trims the live mix uses (Law 4). */
export const KIND_TRIM: Record<CueKind, number> = {
  muzzle_us: 0.72,
  muzzle_insurgent: 0.72,
  mg_us: 0.8,
  mg_insurgent: 0.85,
  impact: 0.4,
  ricochet: 0.45,
  nearmiss: 0.5,
  blast_small: 0.85,
  blast_large: 1.0,
  ied: 1.0,
  smoke_pop: 0.4,
  frag_air: 0.7,
  flare: 0.3,
  radio: 0.5, // the in-handset chain (radioBus) does the heavy band-limiting; trim is pre-chain
  shot: 0.6,
  splash: 0.9,
  dangerclose: 0.7,
  tic_sting: 0.25, // was 0.7 @ scoreBus −9 dB; scoreBus is now 0 dB (so the klaxon can join it at
  //                  its old level) — 0.25 ≈ 0.7 × 10^(−9/20) keeps the sting's absolute level.
};

/** Per-cue REVERB SEND (0..1), multiplied by the distance wet factor. HE/distant fire rings down
 *  the valley; rifle cracks stay mostly dry; radio/UI/sting are bone dry (they're in your headset).
 *  Exhaustive Record so the compiler forces every new CueKind to declare its wetness. */
export const KIND_WET: Record<CueKind, number> = {
  muzzle_us: 0.35,
  muzzle_insurgent: 0.35,
  mg_us: 0.45,
  mg_insurgent: 0.45,
  impact: 0.15,
  ricochet: 0.15,
  nearmiss: 0.25,
  blast_small: 0.6,
  blast_large: 0.85,
  ied: 0.85,
  smoke_pop: 0.1,
  frag_air: 0.12,
  flare: 0.1,
  radio: 0.0,
  shot: 0.0,
  splash: 0.7,
  dangerclose: 0.0,
  tic_sting: 0.0,
};

/** HDR loudness rank (dB SPL-ish, relative) — the loudest current sound raises a window that
 *  everything quieter ducks under. This is how "somber" is engineered: an IED makes the world
 *  go QUIET, not the blast louder. (adaptive-mixing dossier.) */
const KIND_LOUDNESS: Record<CueKind, number> = {
  ied: 128,
  blast_large: 120,
  dangerclose: 120,
  splash: 118,
  blast_small: 110,
  tic_sting: 108,
  shot: 106,
  mg_us: 105,
  mg_insurgent: 105,
  muzzle_us: 100,
  muzzle_insurgent: 100,
  nearmiss: 95,
  radio: 95,
  frag_air: 82,
  impact: 75,
  ricochet: 70,
  smoke_pop: 65,
  flare: 60,
};

/** Voice-steal priority class: a stale ricochet must never hold a slot the gunshot you NEED wants. */
const KIND_PRIORITY: Record<CueKind, number> = {
  ied: 4,
  dangerclose: 4,
  tic_sting: 4,
  blast_large: 3,
  blast_small: 3,
  mg_us: 3,
  mg_insurgent: 3,
  splash: 3,
  shot: 3,
  muzzle_us: 2,
  muzzle_insurgent: 2,
  radio: 2,
  impact: 1,
  ricochet: 1,
  nearmiss: 1,
  smoke_pop: 1,
  frag_air: 1,
  flare: 1,
};

// score moved −9 → 0 dB when dangerclose joined it (the klaxon was tuned at a 0 dB bus);
// KIND_TRIM.tic_sting absorbed the −9 dB so the sting's absolute level is unchanged.
const BUS_TRIM = { combat: dbToLin(0), atmos: dbToLin(-20), radio: dbToLin(-3), score: dbToLin(0) };
const HDR_FLOOR = 55; // dB the window decays toward in silence
const HDR_SIZE = 38; // window height: sounds > HDR_SIZE below the top are culled
const HDR_RELEASE_TAU = 0.9; // s — how fast the window sinks back so quiet valley sounds re-emerge

/** Minimal structural terrain handle the spatializer needs for LOS occlusion. The real Terrain
 *  satisfies this; passing it is a render-side READ of sim state (allowed) — never the reverse. */
export interface TerrainProbe {
  elevAt(x: number, y: number): number;
}

/** Spatialization result — the base {@link Spatial} the synth reads, plus the mix extras only the
 *  player consumes (reverb send, elevation shelf, occlusion, pre-delay). Structural supertype of
 *  Spatial, so it passes straight to synthCue without touching synth.ts. */
interface SpatialMix extends Spatial {
  wet: number; // distance wet factor 0..0.7 (player multiplies by KIND_WET[kind])
  shelfDb: number; // elevation high-shelf gain (+ above, − below the listener)
  occ: number; // 0..1 terrain occlusion (already folded into cutoff/gain)
  preDelay: number; // reverb send pre-delay, s
}

/** Persistent world positions (set once on deploy) the ambient bed needs; the engine owns the
 *  camera, so it computes camera-relative distance/pan itself. */
export interface WorldStatics {
  copPos: { x: number; y: number } | null;
  villages: { x: number; y: number }[];
  river: { x: number; y: number }[];
}
/** The dynamic environment signals the ambient bed reads each frame (all deterministic World getters). */
export interface AmbientEnv {
  secondsOfDay: number;
  solar: number;
  isNight: boolean;
  windSpeed: number;
  weatherLabel: string;
  precip: boolean;
  inContact: boolean;
}

/** The flags `frame()` already computes — the gate the audio tick obeys. */
export interface AudioFlags {
  running: boolean; // !paused && !pendingEvent
  paused: boolean;
  warp: boolean;
  inContact: boolean;
}

interface LiveVoice {
  priority: number;
  gain: GainNode;
  cleanup: () => void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private combatBus: GainNode | null = null;
  private atmosBus: GainNode | null = null;
  private radioBus: GainNode | null = null; // entry of the in-handset chain
  private scoreBus: GainNode | null = null;
  private reverb: ValleyReverb | null = null;
  private ambient: AmbientEngine | null = null;
  /** category gain nodes (bus → category → master); null until unlock builds the graph. */
  private cats: Record<AudioCategory, GainNode> | null = null;
  /** persisted-pref mirror so settings set before unlock apply when the graph is built. */
  private readonly catPrefs: Record<AudioCategory, { volume: number; muted: boolean }> = {
    combat: { volume: 1, muted: false },
    ambience: { volume: 1, muted: false },
    radio: { volume: 1, muted: false },
    alerts: { volume: 1, muted: false },
  };

  private readonly mapper = new CueMapper();
  private cam: Camera | null = null;
  private terrain: TerrainProbe | null = null;
  private statics: WorldStatics = { copPos: null, villages: [], river: [] };
  private unlocked = false;
  private muted = false;
  private volume = DEFAULT_VOLUME;

  private voices: LiveVoice[] = [];
  private windowTop = HDR_FLOOR; // HDR window high-water (dB)
  private lastTickAt = 0; // ctx time of the previous tick (render-side dt for HDR release + ambient)

  /** Debug ring buffer the live harness reads via window — proves audio actually fired without
   *  needing to listen. Render-only. */
  readonly debugCues: { kind: CueKind; t: number }[] = [];

  // -------------------------------------------------------------- lifecycle / unlock
  /** Create+resume the context inside a user gesture, build the whole bus graph + reverb +
   *  ambient bed, with the iOS silent-buffer ritual. Idempotent. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      // master → limiter → destination
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5; // true-peak safety net only — NOT a compressor (preserve the
      limiter.knee.value = 0; //       wide somber dynamic range; let per-cue gains do the leveling)
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.25;
      limiter.connect(ctx.destination);
      this.limiter = limiter;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.volume;
      master.connect(limiter);
      this.master = master;

      // category gains → master (the user's mixer; ducking rides the buses upstream)
      const mkCat = (c: AudioCategory): GainNode => {
        const g = ctx.createGain();
        const p = this.catPrefs[c];
        g.gain.value = p.muted ? 0 : p.volume;
        g.connect(master);
        return g;
      };
      this.cats = { combat: mkCat("combat"), ambience: mkCat("ambience"), radio: mkCat("radio"), alerts: mkCat("alerts") };

      // buses → their category → master
      this.combatBus = this.makeBus(BUS_TRIM.combat, this.cats.combat);
      this.atmosBus = this.makeBus(BUS_TRIM.atmos, this.cats.ambience);
      this.scoreBus = this.makeBus(BUS_TRIM.score, this.cats.alerts);
      this.radioBus = this.makeRadioBus(BUS_TRIM.radio, this.cats.radio);

      // shared valley reverb → combat category (only combat kinds have a wet send — muting
      // combat must also silence its valley tail, not leave a ghost echo).
      this.reverb = createValleyReverb(ctx, { seed: 0x4b4f52, rt60: 1.8 });
      this.reverb.output.connect(this.cats.combat);

      // ambient bed → atmosBus (its own voice bank, outside the combat voice pool)
      try {
        this.ambient = new AmbientEngine(ctx, this.atmosBus);
      } catch {
        this.ambient = null; // never let an ambient failure kill combat audio
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
    this.unlocked = true;
  }

  /** A plain submix bus → its category gain. */
  private makeBus(trim: number, dst: AudioNode): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = trim;
    g.connect(dst);
    return g;
  }

  /** The radio bus IS the in-handset chain: entry gain → HP550 → LP3k → tanh grit → comp → peak
   *  +6 @1.5k → the radio category. Cues connect their synth to the returned ENTRY gain; the chain
   *  band-limits it to a degraded field-radio speaker (reference-acoustics dossier). */
  private makeRadioBus(trim: number, dst: AudioNode): GainNode {
    const ctx = this.ctx!;
    const entry = ctx.createGain();
    entry.gain.value = trim;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 550;
    hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) curve[i] = Math.tanh(((i / 256) * 2 - 1) * 1.6);
    shaper.curve = curve;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30;
    comp.ratio.value = 14;
    comp.attack.value = 0.003;
    comp.release.value = 0.1;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = 1500;
    peak.Q.value = 1.2;
    peak.gain.value = 6;
    entry.connect(hp).connect(lp).connect(shaper).connect(comp).connect(peak).connect(dst);
    return entry;
  }

  setCamera(cam: Camera): void {
    this.cam = cam;
  }
  setTerrain(t: TerrainProbe | null): void {
    this.terrain = t;
  }
  setWorldStatics(s: WorldStatics): void {
    this.statics = s;
  }

  setMasterVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /** Per-category volume (0..1). Safe before unlock — prefs apply when the graph is built. */
  setCategoryVolume(cat: AudioCategory, v: number): void {
    this.catPrefs[cat].volume = Math.max(0, Math.min(1, v));
    this.applyCategory(cat);
  }

  /** Per-category on/off. Mute keeps the volume so toggling back restores the player's level. */
  setCategoryMuted(cat: AudioCategory, muted: boolean): void {
    this.catPrefs[cat].muted = muted;
    this.applyCategory(cat);
  }

  private applyCategory(cat: AudioCategory): void {
    if (!this.cats || !this.ctx) return;
    const p = this.catPrefs[cat];
    this.cats[cat].gain.setTargetAtTime(p.muted ? 0 : p.volume, this.ctx.currentTime, 0.02);
  }

  // -------------------------------------------------------------- the per-frame tick
  /**
   * Called once per rendered frame from store.frame(). Always advances the mapper's marks so
   * "what's new" never goes stale; SCHEDULES combat sound only when live. The ambient bed runs
   * whenever unlocked (it obeys its own gate via the flags) so the calm-before has a voice.
   */
  tick(sim: CueSource, flags: AudioFlags, env?: AmbientEnv): void {
    if (!this.unlocked || !this.ctx || !this.master) {
      this.mapper.skip(sim);
      return;
    }
    const now = this.ctx.currentTime;
    const dt = this.lastTickAt ? Math.min(0.5, now - this.lastTickAt) : 0;
    this.lastTickAt = now;

    // HDR window release: sink toward the floor so the valley's quiet sounds re-emerge after fire.
    if (dt > 0) this.windowTop += (HDR_FLOOR - this.windowTop) * (1 - Math.exp(-dt / HDR_RELEASE_TAU));

    // ambient bed — the valley stays alive while PAUSED (the deploy screen starts paused; pausing
    // shouldn't kill atmosphere); only time-warp suspends it (scrubbing would smear the modulation).
    // Combat cues below still obey the full running gate. The bed self-ducks on contact via env.
    if (this.ambient && env) {
      const signals = this.ambientSignals(env);
      // paused:false on purpose — the bed plays through pause (the deploy screen starts paused);
      // only time-warp (warp) suspends it. Combat cues below keep the full running gate.
      this.ambient.update(signals, dt, { running: !flags.warp, paused: false, warp: flags.warp });
    }

    // combat gate: nothing fires during pause/warp; fast-forward marks so resume doesn't dump a backlog.
    if (!flags.running || flags.paused || flags.warp) {
      this.mapper.skip(sim);
      return;
    }

    const cues = this.mapper.collect(sim);
    if (!cues.length) return; // readable calm-before silence is free
    for (const cue of cues) this.schedule(cue, now);
  }

  /** Build the camera-relative ambient signals from the dynamic env + the static world positions. */
  private ambientSignals(env: AmbientEnv): AmbientSignals {
    const cop = this.nearest(this.statics.copPos ? [this.statics.copPos] : []);
    const vil = this.nearest(this.statics.villages);
    const riv = this.nearest(this.statics.river);
    return {
      secondsOfDay: env.secondsOfDay,
      solar: env.solar,
      isNight: env.isNight,
      windSpeed: env.windSpeed,
      weatherLabel: env.weatherLabel,
      precip: env.precip,
      inContact: env.inContact,
      copDist: cop.dist,
      copPan: cop.pan,
      villageDist: vil.dist,
      villagePan: vil.pan,
      riverDist: riv.dist,
      riverPan: riv.pan,
    };
  }

  /** Nearest of a point set to the camera center → its distance (m) + screen pan (-1..1). */
  private nearest(pts: { x: number; y: number }[]): { dist: number; pan: number } {
    if (!this.cam || !pts.length) return { dist: Infinity, pan: 0 };
    const cam = this.cam;
    let best = Infinity;
    let bx = 0;
    for (const p of pts) {
      const d = Math.hypot(p.x - cam.cx, p.y - cam.cy);
      if (d < best) {
        best = d;
        bx = p.x;
      }
    }
    const pan = Math.max(-1, Math.min(1, ((bx - cam.cx) * cam.ppm) / Math.max(1, cam.vw * 0.5)));
    return { dist: best, pan };
  }

  // -------------------------------------------------------------- scheduling one cue
  private schedule(cue: AudioCue, now: number): void {
    const ctx = this.ctx!;
    const sp = this.spatial(cue);
    if (!sp) return; // culled (inaudible / off-screen-far)

    // HDR: the loudest current sound defines the window; quieter ones duck under it / get culled.
    const positionalCombat = isPositional(cue.kind);
    const distDb = positionalCombat ? 20 * Math.log10(Math.max(1e-3, sp.gain)) : 0;
    const effDb = KIND_LOUDNESS[cue.kind] + distDb;
    if (positionalCombat) {
      if (effDb > this.windowTop) this.windowTop = effDb;
      if (effDb < this.windowTop - HDR_SIZE) return; // below the window — culled (and the over-budget pre-filter)
    }
    const hdrGain = positionalCombat ? Math.min(1, dbToLin(effDb - this.windowTop)) : 1;

    // voice budget — steal the lowest-priority live voice if this one strictly outranks it.
    const priority = KIND_PRIORITY[cue.kind] * 1000 + Math.round(hdrGain * sp.gain * 100);
    if (this.voices.length >= MAX_VOICES && !this.makeRoom(priority)) return;

    const dst = this.busFor(cue.kind);
    const cueGain = ctx.createGain();
    cueGain.gain.value = sp.gain * cue.gain * KIND_TRIM[cue.kind] * hdrGain;

    // per-cue dry chain
    let node: AudioNode = cueGain;
    if (positionalCombat) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = sp.cutoff;
      node = node.connect(lp);
      if (sp.occ > 0.35) {
        // a ridge is a steep low-pass: cascade a 2nd pole so the bright transient is actually
        // killed (one pole leaks too much HF), reading as a real terrain-muffled report.
        const lp2 = ctx.createBiquadFilter();
        lp2.type = "lowpass";
        lp2.frequency.value = sp.cutoff;
        node = node.connect(lp2);
      }
      if (Math.abs(sp.shelfDb) > 0.5) {
        const sh = ctx.createBiquadFilter();
        sh.type = "highshelf";
        sh.frequency.value = 5000;
        sh.gain.value = sp.shelfDb;
        node = node.connect(sh);
      }
      const pan = ctx.createStereoPanner();
      pan.pan.value = sp.pan;
      node = node.connect(pan);
    }
    node.connect(dst);

    // parallel reverb send (HE/distant fire rings down the valley). Tap the cue level, strip the
    // sub (highpass) so the tail rings without mud, pre-delay by distance, into the shared convolver.
    const wetAmt = sp.wet * KIND_WET[cue.kind];
    if (this.reverb && wetAmt > 0.001) {
      const send = ctx.createGain();
      send.gain.value = wetAmt;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 300;
      const pre = ctx.createDelay(0.2);
      pre.delayTime.value = sp.preDelay;
      cueGain.connect(send).connect(hp).connect(pre).connect(this.reverb.input);
    }

    const voice = synthCue(ctx, cueGain, cue, sp, now);
    this.debugCues.push({ kind: cue.kind, t: now });
    if (this.debugCues.length > 64) this.debugCues.shift();

    const lifeMs = Math.max(60, (voice.endTime - now) * 1000 + 120);
    const live: LiveVoice = { priority, gain: cueGain, cleanup: () => {} };
    const timer = window.setTimeout(() => this.retire(live), lifeMs);
    live.cleanup = () => {
      window.clearTimeout(timer);
      try {
        cueGain.disconnect();
      } catch {
        /* already gone */
      }
    };
    this.voices.push(live);

    // ducking: a trigger cue ramps other buses down (control-side, deterministic — keyed on kind).
    this.maybeDuck(cue.kind, now);

    // distant direct fire gets a separate near-miss thump tail (the crack-thump signature).
    if (sp.split && (cue.kind === "muzzle_us" || cue.kind === "muzzle_insurgent" || cue.kind === "mg_us" || cue.kind === "mg_insurgent")) {
      this.scheduleNearmissTail(cue, sp, now);
    }
  }

  /** Retire a finished/stolen voice and free its slot. */
  private retire(v: LiveVoice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    v.cleanup();
  }

  /** At the voice cap, fade+steal the lowest-priority live voice IF the incoming strictly outranks
   *  it (prevents voice-steal thrash). Returns true if a slot is now free. */
  private makeRoom(incoming: number): boolean {
    let lowIdx = -1;
    let low = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i].priority < low) {
        low = this.voices[i].priority;
        lowIdx = i;
      }
    }
    if (lowIdx < 0 || incoming <= low) return false;
    const v = this.voices[lowIdx];
    try {
      v.gain.gain.setTargetAtTime(0.0001, this.ctx!.currentTime, 0.005); // 5 ms fade, never hard-cut
    } catch {
      /* gone */
    }
    this.retire(v);
    return true;
  }

  private busFor(kind: CueKind): GainNode {
    if (kind === "radio") return this.radioBus!;
    if (kind === "tic_sting" || kind === "dangerclose") return this.scoreBus!; // both are command-
    return this.combatBus!; // channel alerts, not battlefield sound — they belong to the alerts category
  }

  /** Control-side ducking (DynamicsCompressor can't be sidechained). A trigger cue ramps the
   *  named buses down then back — duck depth/timing is a pure function of the cue kind. */
  private maybeDuck(kind: CueKind, now: number): void {
    const duck = (bus: GainNode | null, base: number, amount: number, atk: number, hold: number, rel: number) => {
      if (!bus) return;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setTargetAtTime(base * amount, now, atk);
      bus.gain.setTargetAtTime(base, now + hold, rel);
    };
    if (kind === "radio") {
      duck(this.atmosBus, BUS_TRIM.atmos, 0.5, 0.02, 0.15, 0.25);
    } else if (kind === "ied" || kind === "blast_large") {
      duck(this.atmosBus, BUS_TRIM.atmos, 0.25, 0.004, 0.18, 0.9);
      duck(this.radioBus, BUS_TRIM.radio, 0.25, 0.004, 0.18, 0.9);
      duck(this.scoreBus, BUS_TRIM.score, 0.25, 0.004, 0.18, 0.9);
      duck(this.combatBus, BUS_TRIM.combat, 0.55, 0.004, 0.18, 0.6);
    }
  }

  /** The low *thump* of a distant report at the speed-of-sound delay after the bright crack. */
  private scheduleNearmissTail(cue: AudioCue, sp: SpatialMix, now: number): void {
    if (this.voices.length >= MAX_VOICES) return;
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = sp.gain * 0.6 * KIND_TRIM.nearmiss;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    g.connect(pan).connect(this.combatBus!);
    if (this.reverb && sp.wet > 0.001) {
      const send = ctx.createGain();
      send.gain.value = sp.wet * KIND_WET.nearmiss;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 300;
      g.connect(send).connect(hp).connect(this.reverb.input);
    }
    const voice = synthCue(ctx, g, { ...cue, kind: "nearmiss" }, sp, now);
    const lifeMs = Math.max(60, (voice.endTime - now) * 1000 + 120);
    const live: LiveVoice = { priority: KIND_PRIORITY.nearmiss * 1000, gain: g, cleanup: () => {} };
    const timer = window.setTimeout(() => this.retire(live), lifeMs);
    live.cleanup = () => {
      window.clearTimeout(timer);
      try {
        g.disconnect();
      } catch {
        /* gone */
      }
    };
    this.voices.push(live);
  }

  // -------------------------------------------------------------- spatialization
  private spatial(cue: AudioCue): SpatialMix | null {
    return computeSpatial(cue, this.cam, this.terrain);
  }
}

/**
 * PURE spatialization: distance attenuation, low-pass-far (air absorption + terrain occlusion),
 * stereo pan, elevation brightness, the distance reverb wet factor, and the speed-of-sound
 * crack/thump split. The listener is the camera center; zoom (ppm) scales the audible world
 * radius. Returns null to cull inaudible cues. Exported & camera/terrain-as-arguments so the
 * headless render oracle exercises the IDENTICAL math the live engine does (Law 4).
 */
export function computeSpatial(cue: AudioCue, cam: Camera | null, terrain?: TerrainProbe | null): SpatialMix | null {
  // non-positional cues: centered, full-band, dry, no delay.
  if (!cue.pos || !isPositional(cue.kind) || !cam) {
    return { crackAt: 0, thumpAt: 0, gain: 1, pan: 0, cutoff: 14000, split: false, wet: 0, shelfDb: 0, occ: 0, preDelay: 0 };
  }
  const dx = cue.pos.x - cam.cx;
  const dy = cue.pos.y - cam.cy;
  const distM = Math.hypot(dx, dy);

  const halfW = (cam.vw * 0.5) / Math.max(0.01, cam.ppm); // metres center->edge
  const ref = Math.max(150, halfW); // never below 150 m so tight zoom isn't deaf
  const AUDIBLE_M = ref * 4; // 4 screens out = edge of audibility

  const norm = Math.min(1, distM / AUDIBLE_M);
  let atten = Math.pow(Math.max(0, 1 - norm), 1.6);
  if (atten < 0.02) return null; // cull inaudible

  // air absorption: 14 kHz near → ~500 Hz far (steeper perceptual curve than the old linear one).
  let cutoff = Math.max(500, 14000 * Math.pow(1 - norm, 2.0));
  const sx = (dx * cam.ppm) / Math.max(1, cam.vw * 0.5);
  const pan = Math.max(-1, Math.min(1, sx));

  // terrain LOS occlusion + elevation: "the valley is the enemy", applied to sound.
  let occ = 0;
  let shelfDb = 0;
  if (terrain) {
    const eListen = terrain.elevAt(cam.cx, cam.cy) + 1.7; // listener ~eye height
    const eSrc = terrain.elevAt(cue.pos.x, cue.pos.y) + 1.7; // muzzle ~chest height
    const N = 10;
    let blocked = 0;
    let maxPen = 0;
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const sightElev = eListen + (eSrc - eListen) * t;
      const groundElev = terrain.elevAt(cam.cx + dx * t, cam.cy + dy * t);
      if (groundElev > sightElev) {
        blocked++;
        maxPen = Math.max(maxPen, groundElev - sightElev);
      }
    }
    occ = Math.min(1, (blocked / (N - 1)) * 0.6 + Math.min(1, maxPen / 40) * 0.4);
    if (occ > 0.001) {
      cutoff = cutoff + (220 - cutoff) * occ; // a ridge muffles hard (but rock diffraction passes low end)
      atten *= 1 - 0.5 * occ; // ~−6 dB max, NOT the −15 dB of an indoor wall
    }
    // elevation brightness: a gun on the high ground has clear HF path → brighter, sits forward.
    const relElev = eSrc - eListen;
    shelfDb = Math.max(-1, Math.min(1, relElev / 120)) * 4;
    if (relElev > 0) cutoff = Math.min(14000, cutoff * 1.15);
  }

  const delayS = distM / SPEED_OF_SOUND;
  const split = delayS > 0.08;
  // near ~dry, far ~mostly tail; a blocked source also reaches the reflecting walls with less
  // energy, so occlusion cuts the wet send too (else the bright tail leaks the highs back).
  const wet = atten * Math.max(0, Math.min(0.7, 0.12 + 0.55 * norm)) * (1 - 0.8 * occ);
  const preDelay = Math.max(0.02, Math.min(0.18, 0.02 + norm * 0.12));
  return { crackAt: 0, thumpAt: split ? delayS : 0, gain: atten, pan, cutoff: Math.max(400, cutoff), split, wet, shelfDb, occ, preDelay };
}

export type { CueSource };
