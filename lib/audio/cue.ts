/**
 * AudioCue — the PURE wire format between the deterministic event MAPPER (mapper.ts) and
 * the browser-only synth PLAYER (player.ts). This file is the analogue of an Effect: it
 * DESCRIBES a sound, it does not make one. Zero browser imports; the only sim import is the
 * pure static `RNG.hashString` (via the @/lib/sim/world barrel) for per-cue variation.
 *
 * Layer law (Law 7 / determinism contract): nothing here touches AudioContext, window,
 * document, performance, or Math.random. A cue is a pure function of the sim event that
 * produced it — same effect/log/fire-mission id => byte-identical cue, forever. The probe
 * (scripts/audio-probe.ts) asserts this.
 */
import { RNG } from "@/lib/sim/world";

export type CueKind =
  | "muzzle_us"
  | "muzzle_insurgent" // single rifle crack, faction-tinted (no weaponId on the Effect)
  | "mg_us"
  | "mg_insurgent" // MG burst — a single cue that schedules a run of cracks (size>=1.5 muzzle)
  | "impact"
  | "ricochet"
  | "nearmiss" // round terminal effects + the supersonic "thump" (the latter is a player tail)
  | "blast_small"
  | "blast_large"
  | "ied" // HE by size + buried initiation (the signature opener)
  | "smoke_pop"
  | "frag_air"
  | "flare"
  | "radio" // squelch+beep bed under a contact/radio/support/kia/casualty/objective log line
  | "shot"
  | "splash" // indirect: the tube report and the rounds landing
  | "dangerclose" // klaxon when our own men sit under the beaten zone
  | "tic_sting"; // AWE: low drone + contact sting on the TIC rising edge

export interface AudioCue {
  kind: CueKind;
  /** world position (m) for direct events; undefined => non-positional (radio, tic_sting, shot). */
  pos?: { x: number; y: number };
  /** deterministic 0..1 variation seed (pure hash of the source id). Drives pitch/timbre jitter. */
  v: number;
  /** intensity 0..1 (MG burst length, blast size, suppression weight). */
  gain: number;
  /** the source effect/log/fire-mission id this cue derives from — for the probe's 1:1 assertion. */
  srcId: number;
  /** which monotonic stream the srcId belongs to (so srcId collisions across streams don't alias). */
  srcStream: "fx" | "log" | "fm" | "tic";
}

/**
 * Per-cue variation in [0,1) — a PURE hash of the source id (+ a salt so two cues off the
 * same id, e.g. splash+dangerclose, differ). Mirrors the civilian trait hash
 * (lib/sim/ai/civilian.ts: `RNG.hashString(id+salt) % N`). No PRNG stream advance, no
 * wall-clock: deterministic by construction.
 */
export const cueVar = (srcId: number, salt: string): number =>
  (RNG.hashString(String(srcId) + salt) % 100000) / 100000;
