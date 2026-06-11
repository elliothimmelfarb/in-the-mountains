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

## 2026-06-11 follow-up — calibre voices (the weapon-identity pass)

The remaining "weapon-tell" coarseness (two faction cracks for ~24 weapon systems) is closed.
The unlock was sim-side: `Effect.weapon` (weapons.ts id) now stamped on muzzle/blast/reload
effects (`combat.ts` fireRound/detonate/reload; effects are transient — save schema untouched).

- **5 new cue kinds:** `hmg_us`/`hmg_insurgent` (M2/DShK — body an octave down, weapon-tinted
  attack transient; DShK centroid darker than PKM by **772 Hz**), `rocket_launch` (RPG-7 pop +
  booster whoosh, 1100 ms; AT4/SPG-9 recoilless bang), `gl_launch` (M320 bloop / Mk19 thunk),
  `reload` (mag swap at **−51.6 dB** RMS — sim now emits a reload effect; NEW sound, was silent).
- **Per-weapon voice rows** (`WEAPON_VOICES`, cue.wpn): M9 bark, M110/M24/SVD/Enfield; bolt guns
  cycle the bolt ~0.5 s after the report (M24 span 920 ms). Mortar **calibre gradation**
  (`BLAST_SCALE`): 60 vs 120 mm LF-share **14.1 vs 19.9%** (new `lf200Pct` oracle metric —
  centroid/HF are bin-count-blind to sub-bass).
- **Physics upgrades:** IED seismic heave + soil lag (centroid 5233→**3951 Hz**, LF 37.9%),
  incoming-shell chaotic shrill (two incommensurate modulators), near-miss rarefaction + wake,
  sparse radio net texture (default squelch byte-identical — restraint proven by unchanged palette).
- **Verification:** oracle 39 scenes, **13/13 assertions**; probe 1:1/determinism/purity green;
  3 held-out seeds emit the new kinds from organic combat (hmg_us 75–900, gl_launch 34,
  reload 5–151, m9 42–130). Report + A/B: `docs/progress/2026-06-11-sound-realism/report.html`
  (published to the archive).
- **New residuals:** rocket_launch unobserved organically in the 3 holdout runs (RPG gunners
  carry 1 round; routing proven by direct mapper check) · backblast directionality folded into
  the launch sound (listener-relative cone = renderer work, deferred) · **no synthesized
  screams, deliberately** — the recorded negative on synthesized radio voice extends to wounded
  men, with higher stakes · SAW vs M4 share the 5.56 voice (cadence is the sim's real cyclic
  timing — that IS the audible difference).
