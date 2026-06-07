# Soundscape campaign — 20× immersion rebuild (2026-06-07)

Full interactive writeup with charts, annotated spectrograms, and playable before/after audio:
**`report.html`** (open it). This is the numbers-first corpus summary.

## What changed
The audio went from combat-only, essentially **mono**, **no reverb**, **silent between firefights**,
to a living valley: a canyon that echoes, a wind/river/generator/wildlife bed driven by the sim's
time-of-day + weather, terrain that muffles fire behind a ridge, 5-layer weapon synthesis with a
correct 5.56>7.62 timbre tell, and an HDR mix + brickwall limiter that gives a wide somber dynamic
range without clipping. 100% procedural (Web Audio only, zero audio assets — the reverb IR is
generated noise), and deterministic (the cue/ambient mapping is pure; `audio-probe.ts` = `AUDIO OK`).

## Before → after (offline oracle, `scripts/audio-render.ts`, seed-pinned)
| Metric | HEAD | New | Note |
|---|---|---|---|
| Firefight stereo correlation | 0.981 | **0.392** | 1.0 = mono → wide (decorrelated reverb tail) |
| Distant-fire correlation | 1.000 | **0.037** | same scene; pure width win |
| Ambient calm RMS | −120 (silent) | **−42.6 dB** | a living, subtle bed where there was nothing |
| Calm→combat dynamic spread | n/a | **23.0 dB** | loud-window −19.5 vs calm −42.6 |
| Firefight reverb tail | 2450 ms (synth decay) | **7100 ms** | real canyon ring |
| Busiest-scene peak | — | **−2.6 dBFS** | no clipping (limiter) |
| Occlusion (ridge vs open) | — | **−9.0 dB & 42→30% HF** | terrain muffles fire |
| Weapon tell (centroid Hz) | M4 7980 ≈ AK 8058 (no split) | **M4 6860 > AK 6212; SAW 6435 > PKM 5472** | correct 5.56>7.62 |

## How it was built (agent fleet)
1. **Research** — 6-agent fan-out workflow (gunfire DSP / canyon reverb / ambient design / Web-Audio
   spatialization / adaptive mixing / Afghan-valley acoustics) → cited `research/DOSSIER.md`.
2. **Design** — adopted the dossier as an additive bus architecture (`research/DESIGN-ADOPTED.md`).
3. **Build** — 3 parallel agents wrote the isolated modules (`reverb.ts`, `ambient*.ts`, 5-layer
   `synth.ts`) to interface contracts; the spine (`player.ts` bus graph/HDR/ducking/occlusion) +
   seams (`store.ts`, `terrain.riverPoints`) integrated by hand.
4. **Verify** — built the offline oracle + spectrogram viz; tuned to all-green; verified **live**
   (full graph builds in-browser, bed plays at −40 dB during calm, combat cues fire, 0 console errs).
5. **Adversarial pass** — a skeptic agent confirmed determinism/purity/no-leaks and caught a real
   oracle bug (voice counter never decremented → firefight measured on only its first 32 cues).
   Fixed (proper voice retirement), corrected the gain staging it had masked, re-measured honestly.

## Residuals / restraint (logged → issue 017)
- Ambient **beds are diffuse** (wind/rain near-mono by design; only spot sounds — birds/dogs/adhan —
  pan to bearing). Acoustically honest; not aggressively stereo.
- The oracle measures the **static signal path**; the time-evolving mix (HDR window, ducking,
  voice-stealing) is verified live + by the firefight/spread metrics, not in the offline render.
- Kept `StereoPanner` (not HRTF) and `tic_sting` as the only musical element — deliberate.

## Standing checks
`tsc` · `npm run build` · `eslint` (0 new; 2 pre-existing WorldView `performance.now` errors on HEAD)
· `smoke` (SMOKE OK) · `balance` (exit 0) · `audio-probe` (AUDIO OK) · oracle (RENDER OK, 5/5).

## Files
New: `lib/audio/{reverb,ambient,ambient-state}.ts`, `scripts/audio-{render,viz,report}.ts`.
Rewritten: `lib/audio/player.ts`. Restructured: `lib/audio/synth.ts`. Edited: `state/store.ts`,
`lib/sim/terrain.ts`, `docs/wiki/Simulation-Systems.md`, `README.md`. Baseline + research + viz in
this folder.
