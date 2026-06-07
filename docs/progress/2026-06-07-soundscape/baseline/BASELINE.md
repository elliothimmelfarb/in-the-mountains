# Soundscape campaign — HEAD baseline (2026-06-07)

Captured BEFORE any change, with the new offline oracle `scripts/audio-render.ts` (renders the
real `synthCue` + `computeSpatial` through `OfflineAudioContext`, seeds `Math.random` so renders
are byte-reproducible). Numbers in `baseline-summary.csv` / `metrics.json`; WAVs alongside.

## The system on HEAD
Combat-only, event-driven procedural audio: ~17 cue kinds (muzzle/MG/blast/IED/impact/ricochet/
smoke/frag/flare/radio/shot/splash/dangerclose/tic_sting). Spatialization = `StereoPanner` (L/R
level), distance attenuation (`pow 1.6`), an air-absorption lowpass, and a speed-of-sound
crack/thump split. **No reverb, no ambient bed, no occlusion, no elevation, no master dynamics.**

## The numbers that name the gaps
| Gap | Evidence (baseline) |
|---|---|
| **The mix is mono** | `stereoCorr` = **1.000** on every solo cue; **0.981** even in the dense L-vs-R firefight (width **9.8%**). `StereoPanner` changes only L/R *level* — the channels stay perfectly correlated, so there is no decorrelation/envelopment. |
| **No reverb / canyon echo** | firefight `tailMs` 2450 is just the IED+sting synth decay; the `distant` PKM tail (5660 ms) is the crack/thump split, not reflections. No reflected energy exists. |
| **Ambient = silence** | `ambient-calm` = **−120 dBFS**. Between firefights the valley is dead air. The single biggest immersion gap. |
| **Quiet, wide dynamic range, no bus control** | firefight peak −7.7 dBFS, RMS −29, LUFS −29.4. No master limiter/compressor; loudness drifts per scene (palette LUFS spans −21 to −46). |
| **Thin combat timbres** | each gunshot is 2 noise bursts + 1 sub (≈40 ms). No mechanical action, no brass, no tail layer, no reflections — `crestDb` ~17 but spectrally simple. |

## The oracle (how every later "better" is proven)
`npx tsx scripts/audio-render.ts <outDir>` → per-scene `peakDb, rmsDb, lufs(BS.1770 K-weighted),
crestDb, centroidHz, stereoCorr, widthPct, tailMs, audibleMs` + a downsampled waveform envelope
and a 48-bin log spectrum (for report charts) + a listenable `.wav` per scene. Scenes: a per-cue
**palette** (timbre), a dense **firefight** (mix-under-load), a **distant** high-ground burst
(spatialization), and **ambient-calm** (the silent gap). Renders are byte-reproducible
(`seedRandom`), so baseline↔after deltas are real, not render jitter.

## Target (what "20x" must move)
ambient-calm: silence → a living valley bed (geophony/biophony/anthrophony, day/weather aware) ·
firefight stereoCorr 0.98 → < 0.7 (real width) · reverb tail: none → distance-scaled canyon
echo · master: uncontrolled → limited, consistent LUFS · gunfire: 3-layer → multi-layer with
mechanical + tail + reflections. Prove on held-out seeds + live app.
