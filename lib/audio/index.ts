/**
 * lib/audio barrel.
 *
 * The PURE side (cue + mapper) is safe to import from a headless probe; it pulls in nothing
 * browser. The PLAYER (AudioEngine) is browser-only — importing it from Node is fine at
 * MODULE load (it touches no browser global until `unlock()` runs inside a gesture), but the
 * probe deliberately imports only mapper+cue so a regression that leaks a browser global into
 * the pure path is caught (audio-probe.ts assertion C).
 */
export { AudioEngine, AUDIO_CATEGORIES } from "./player";
export type { AudioFlags, AudioCategory } from "./player";
export { CueMapper } from "./mapper";
export type { CueSource } from "./mapper";
export type { AudioCue, CueKind } from "./cue";
export { cueVar } from "./cue";
