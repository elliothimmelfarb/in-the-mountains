# 2026-06-11 — Sound pass: per-category mixer + five audio improvements

**Goal (owner):** meaningfully improve the sound; add sound configuration so the user can turn
different categories of sound on and off; HTML report with what/why + samples.

**Report (published):** `report.html` here → served copy with playable A/B audio at
`public/manual/archive/reports/2026-06-11-sound-pass/` (chapter + catalog card added to the archive index).

## What shipped (commits)

1. `740962e` feat(audio): per-category sound mixer — combat/ambience/radio/alerts on/off + volume
   — category gains BETWEEN bus and master (duck writes absolute bus values; separate node = no fight);
   reverb return → combat category; dangerclose → scoreBus (alerts) with exact trim compensation
   (score −9→0 dB, tic_sting 0.7→0.25); prefs in `itm-ui-v1`; 🎚 popover in the CommandBar.
2. `e6f538d` feat(audio): incoming-shell whistle, wide calm bed, thunder, adhan vibrato, ricochet variants.
3. (this commit) report + archive publish + docs.

## Verbatim numbers (oracle `scripts/audio-render.ts`, seed-pinned; baseline/ = HEAD@981133c, after/ = post-pass)

| scene | rms dB | corr | width % | tail ms | audible ms |
|---|---|---|---|---|---|
| ambient-calm | −42.62 → −45.48 | 0.997 → 0.963 | 4 → 12.4 | 1740 → 10270 | 10500 → 10500 |
| ambient-night | −42.42 → −45.06 | 0.995 → 0.956 | 5 → 13.3 | 10480 → 10480 | 10500 → 10500 |
| ambient-storm (NEW) | — → −40.91 | — → 0.873 | — → 20.9 | — → 12490 | — → 12500 |
| spot-adhan (NEW) | — → −38.52 | — → 0.92 | — → 27.3 | — → 9980 | — → 10000 |
| palette-incoming (NEW) | — → −29.5 | — → 0.3 | — → 42.3 | — → 1070 | — → 2260 |
| palette-ricochet | −41.22 → −42.61 | 0.539 → 0.571 | 35.4 → 34.3 | 800 → 670 | 720 → 580 |
| firefight | −27.02 → −26.74 | 0.496 → 0.48 | 36.7 → 37.2 | 7100 → 7090 | 18140 → 18140 |

Oracle assertions after: **all green** (no clip −2.8 dBFS busiest · spread 23.0→**25.8 dB** ·
bed alive −45.5 dB · firefight corr 0.48 · occlusion 6.6 dB / HF 30.8% vs 40.9% ·
**calm width 12.4%** · storm alive · whistle 2260 ms). Mixer plumbing proved level-neutral:
post-config re-render vs baseline, all 24 scenes within 0.15 dB rms / 0.01 corr.

## Load-bearing finding

Panning bed voices did NOT widen the calm scene (first attempt: width 4→6.8%) because every bed
loops ONE shared noise buffer and two in-phase filters of the same source stay correlated no
matter the pan. Fix: per-voice start **offsets into the loop** (`bedVoice(..., offsetS)` —
noise autocorrelation dies in samples) → 12.4%. Recorded so nobody re-attempts pan-only width.

## Verification trail

- `npx tsx scripts/audio-probe.ts` — AUDIO OK (incoming added to coverage set; determinism, 1:1, layer purity).
- `npx tsx scripts/audio-render.ts` — RENDER OK, 27 scenes (3 new), 3 new assertions.
- Standing: tsc ✓ · build ✓ · smoke ✓ (`SMOKE OK`) · balance exit 0 (12/12 contacts, KIA 1.50 avg,
  civ cas 0; "3 runs lingering" warning is sim-side, audio is observer-only by probe assertion C).
  **lint: 267 pre-existing problems repo-wide, 0 in lines this pass authored** (3 in touched files
  are in pre-existing WorldView.tsx code) — not fixed, out of scope, noted honestly.
- Live (MCP Playwright): mixer popover → store → engine cat gains (ambience 0.000 / combat 0.500)
  → `itm-ui-v1` → survives reload; prefs reset to defaults afterward. Screenshots:
  `mixer-open.png`, `mixer-popover.png`.

## Deliberately NOT done

- **MEDEVAC rotor loop** — `medevac()` is instantaneous (`u.evac = true`, combat.ts:1659); no
  aircraft entity exists to attach audio to. Faking it with a render-side timer would violate the
  sim-renders-truth stance. Needs sim-side work first.
- **Per-round incoming whistles** in a barrage (one per mission only; `nextRoundS` would support
  it but read as noise with 4-round missions).
- **Synthesized radio voice chatter** — considered, rejected: band-limited gibberish reads cheesy
  faster than squelch reads sparse.
