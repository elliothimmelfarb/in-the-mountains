# Adopted design + build decomposition (orchestrator's cut)

The research `DOSSIER.md` is the spec — concrete params, build order, determinism notes, all
verified against the real code. This file records the orchestrator's **decisions**: what we build
now, the **seams** (interfaces fan-out agents build to), and who writes which file (one-writer-per-file).

## Target node graph (the AudioEngine, built once at unlock)
```
destination
 └ limiter            DynamicsCompressor  thr −6, knee 0, ratio 20, atk .003, rel .25  (brickwall safety)
    └ master          GainNode = volume/mute (ramped)            [was: master→destination]
       ├ combatBus    Gain  0 dB
       ├ atmosBus     Gain −6 dB   ← AmbientEngine connects here; ducks on TIC/HE, exhales 12 s
       ├ radioBus     Gain −3 dB   ← fixed in-handset chain (HP550→LP3k→tanh→comp→peak+6@1.5k)
       ├ scoreBus     Gain −9 dB   ← tic_sting only
       └ reverbReturn Gain  ← convolver(stereo decaying-noise IR + ridge slap-taps) ← per-cue sends
```
Per positional combat cue: `cueGain → lowpass(occlusion/air) → stereoPan → combatBus`
plus wet tap: `cueGain → sendGain(=wetByDist·KIND_WET) → highpass 300 → preDelay → convolver`.
Non-positional: radio→radioBus, tic_sting→scoreBus, others→combatBus. **Stereo IR decorrelates the
tail → fixes the mono-mix metric for free; dry stays a point source (correct physics).**

## What we build now (ranked, dossier moves 1–8)
1. Bus refactor + master limiter (foundation). 2. Shared valley convolver + distance wet send.
3. HDR window auto-mixer (render-side gain decision) + control-side ducking. 4. Gunfire 5-layer
stack + per-weapon table + true N-wave. 5. Crack/thump already correct — refine. 6. 3-tier ambient
bed (wind/river/generator/birds/dogs/adhan), day+weather driven, TIC-ducked. 7. Terrain-LOS
occlusion + elevation brightness. 8. Priority voice-stealing, MAX_VOICES 24→32.

## Decomposition (one writer per file)
- **SPINE — me (orchestrator):** `lib/audio/player.ts` (buses, limiter, reverb wiring, HDR,
  ducking, voice priority, occlusion/elevation in `computeSpatial`), `state/store.ts` +
  `components/world/WorldView.tsx` (seams: pass `terrain` for occlusion + World env signals for
  ambient), `scripts/audio-render.ts` (oracle: MIRRORS update, ambient scene, LUFS/spread asserts),
  `lib/audio/cue.ts` (KIND_WET/loudnessDb/priority exhaustive Records if co-located).
- **Agent A → `lib/audio/reverb.ts` (NEW):** `createValleyReverb(ctx, {seed,rt60}) → {convolver,
  input, output}`; procedural decaying-noise IR + ridge slap-taps. Pure of game state.
- **Agent B → `lib/audio/ambient-state.ts` (NEW, PURE) + `lib/audio/ambient.ts` (NEW, RENDER):**
  ambient-state maps World signals → `AmbientMix` target numbers (pure, deterministic); ambient.ts
  is a persistent voice bank that takes an `atmosBus` destination + applies the mix via setTargetAtTime.
- **Agent C → `lib/audio/synth.ts`:** restructure `muzzle_*`/`mg_*` into TRANSIENT·BODY·SUB·
  MECHANICAL·TAIL with a per-weapon param table + tighten the N-wave; same `synthCue` signature.

## Seams the agents build to (interface contracts)
- Reverb: `createValleyReverb(ctx: BaseAudioContext, opts) → { input: GainNode; output: GainNode; convolver: ConvolverNode }`. Player connects `output → master` and taps cue sends into `input`.
- Ambient: `new AmbientEngine(ctx, destination: AudioNode)`; `.update(mix: AmbientMix, dt)`; `.setGate(running)`. `computeAmbientMix(world-signals) → AmbientMix` is the pure half.
- Synth: unchanged signature `synthCue(ctx, out: GainNode, cue, sp: Spatial, now): Voice`. Internal restructure only. May read a new exported `WEAPON_TABLE`.

## Determinism (Law 7) — non-negotiable for every file
Timbre/scheduling params derive from `cue.v` + shot-index golden-ratio, never `Math.random` in the
decision layer. `Math.random` only in render-side noise/IR fill. Ambient-state reads ONLY existing
deterministic World signals (`solarLight()`, `windVector()`, `secondsOfDay`, `weather`). New
`Record<CueKind,…>` tables are exhaustive so the compiler enforces coverage. The oracle
(`audio-render.ts`) + probe (`audio-probe.ts`) are the guards; oracle renders are seeded-reproducible.

## Verify (every change, in isolation)
`npx tsx scripts/audio-render.ts <out>` → metric delta vs `baseline/`. Targets: ambient-calm
−120→living bed · firefight stereoCorr 0.98→<0.7 · reverb tail present & distance-scaled · no
clip (peak<0) · calm/loud RMS spread >15 dB. Then standing checks + live app.
