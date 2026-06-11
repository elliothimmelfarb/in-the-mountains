# 017 — Soundscape: flat combat-only mix (mono, no reverb, silent between firefights)

**Status: ✅ Resolved 2026-06-07 (soundscape campaign).**
Severity: High (soul/immersion — sound is half the "holy shit, an AI built this" bar).
Owner files: `lib/audio/*` (render-side). Oracle: `scripts/audio-render.ts`. Probe: `scripts/audio-probe.ts`.
Full writeup + charts + playable audio: `docs/progress/2026-06-07-soundscape/report.html`.

## What was wrong (HEAD before the change)
The procedural battle audio was a solid spine (~17 cue kinds) but **flat**: the mix was essentially
**mono** (L/R correlation 0.98–1.0 everywhere — `StereoPanner` only level-pans), there was **no
reverb** (a Korengal firefight is defined by the report rolling off the far ridge), and between
firefights the valley was **digital silence** (−120 dBFS, which reads as "audio off"). No master
bus/limiter; gunshots were 3 thin layers; no terrain occlusion or elevation cue.

Baseline (offline oracle, `docs/progress/2026-06-07-soundscape/baseline/`): firefight stereoCorr
**0.981**, ambient-calm **−120 dBFS**, reverb tail **0** (synth decay only), no US-vs-insurgent
brightness split.

## The fix (additive bus architecture, deterministic, 100% procedural)
`master→limiter` with `combat/atmos/radio/score` buses + a shared **valley convolver** (procedural
decaying-noise stereo IR with ridge slap-taps); a 3-tier **ambient bed** (`ambient-state.ts` pure +
`ambient.ts` render) driven by `solarLight()`/`windVector()`/`weather`, contact-ducked; **5-layer
gunfire** (`synth.ts`); HDR auto-mixer + control-side ducking + priority voice-stealing; terrain-LOS
**occlusion** + elevation in `computeSpatial`. Built via a research → design → 3-agent build → verify
→ adversarial-pass campaign. After (oracle, seed-pinned): firefight corr **0.392**, ambient-calm
**−42.6 dB**, calm→combat spread **23.0 dB**, firefight tail **7100 ms**, busiest peak **−2.6 dBFS**
(no clip), occlusion **−9 dB & 42→30% HF**, weapon tell **M4 6860 > AK 6212 / SAW 6435 > PKM 5472**.

## Residuals / deliberate restraint (future work, not bugs)
- **Ambient beds are diffuse** ~~(wind/rain near-mono by design; only spot sounds — birds/dogs/adhan —
  pan to bearing). A future pass could decorrelate/pan the continuous beds (river/generator) for more
  calm-scene width; acoustically the diffuse stance is honest.~~
  **→ Addressed 2026-06-11 (sound pass):** calm-bed width 4% → **12.4%** (corr 0.997 → 0.963). The
  mechanism was per-voice OFFSETS into the shared noise loop (in-phase filters of one buffer stay
  correlated regardless of pan) + river split into two band voices straddling its screen bearing,
  generator panned to the COP bearing, rain Haas-widened. Same pass also added: per-category sound
  mixer (combat/ambience/radio/alerts, bus→category→master so user trim never fights the duck), the
  **incoming-shell whistle** (new cue, 2.4 s lead off `fm.etaS`, once per mission), **thunder** (Rain-only
  Poisson spot, not contact-gated), adhan **vibrato** (5.3 Hz), and 3 ricochet timbre families.
  Report + A/B samples: `docs/progress/2026-06-11-sound-pass/report.html` (published to the archive).
  New residuals recorded there: calm bed ~2.9 dB quieter (in band; knob = river group gain ×0.7 in
  ambient.ts), no MEDEVAC rotor (sim has no aircraft entity — needs sim-side work first, deliberately
  not faked in the audio layer), one whistle per mission (not per round).
- **The offline oracle measures the static signal path**; the time-evolving mix (HDR window, ducking,
  voice-stealing) is verified live + via the firefight/spread metrics, not re-implemented in the
  render. A future oracle could model the dynamic mix for fully faithful busy-scene numbers.
- Kept `StereoPanner` (not HRTF — wasted on a top-down camera) and `tic_sting` as the only musical
  element. Both deliberate.
