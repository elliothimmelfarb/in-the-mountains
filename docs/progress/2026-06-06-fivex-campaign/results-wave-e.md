# 5× Campaign — Wave E results (World-map scale realism, issue 014 Bucket 1) — verified

The one clearly-visible remaining realism gap: soldiers were drawn ~36× too large (a fixed 15 px floor →
~21 m ground-width at default zoom), so a 9-man squad's correct 5.5 m dispersion collapsed into one blob at
every zoom. Render-only fix (Bucket 1 = R1 + R2); terrain/sim scale (Bucket 2) deliberately untouched.

Files: `lib/render/draw.ts`, `lib/render/combat-fx.ts` (sync only), `components/world/WorldView.tsx`,
`scripts/scale-probe.mjs`. Done-gate: tsc clean · build 0 · smoke OK.

## What changed
- **R1 — figure tracks footprint:** `figurePx` `max(15, min(40, ppm*7))` → `max(7, min(26, ppm*1.6))`
  (a 1.6 m kit footprint, 7 px legibility floor instead of a 15 px giant floor). `dotR` `max(4.5,min(13,
  0.95ppm))` → `max(3,min(9,0.7ppm))`. LOD fade bands pushed to tactical zoom (FIG_FADE0 0.5→2.5,
  FIG_FADE1 0.9→3.5): individuals only resolve at ppm ≥ 2.5, where they're near-true size.
- **R2 — per-squad aggregation below tactical zoom:** new `drawSquadIcon()` — one NATO friendly rectangle
  (echelon dot + `"1st ×9"` badge, contact-tint) per squadId at the element centroid; WorldView groups live
  non-garrison friendlies by squad below FIG_FADE0 with a 0.4-ppm crossfade so nothing pops. A squad reads as
  one icon when zoomed out, as spaced individuals when zoomed in.
- **combat-fx SYNC (the #1 regression risk):** deleted combat-fx's private `figurePx` + inline dot formulas;
  it now IMPORTS `figurePx`/`dotR` from draw.ts (no cycle). One source of truth → the suppression crescent,
  bleed pool, and danger-close halo can never detach from a resized figure ring.

## scale-probe.mjs (seed korengal) — BEFORE → AFTER
| ppm | LOD | figVsTrue | soldier/COP | squad overlap |
|---|---|---|---|---|
| 0.3 (strategic) | squad-icon | 83× → **39×** | 0.294 → 0.137 | true → **false** |
| 0.7 (default) | squad-icon | 36× → **17×** | 0.126 → 0.059 | true → **false** |
| 1.0 | squad-icon | 25× → **12×** | 0.088 → 0.041 | true → **false** |
| 2.0 | squad-icon | 13× → **6×** | 0.044 → 0.021 | true → **false** |
| 4.0 (tactical) | figures | 12× → **3×** | 0.041 → **0.010** (~realistic ~1%) | true → **false** |
| 8.0 | figures | 8× → **3×** | 0.029 → **0.009** | true → **false** |
`squadFiguresOverlap` is now **false at every zoom**: below 2.5 ppm a squad is one icon; at 2.5+ ppm the
figure (≤1.8 m) finally fits inside the real 5.5 m gap.

## Visual confirmation (re-captured shots in ./shots/)
- `combat-day.png` / `night-firefight.png` / `combat-tableau.png` (ppm 4.6): the squad now reads as
  **distinct, evenly-spaced named individuals** (Kowalski · Beckett · Camilo · Salazar · Whitaker), tiny on
  the 170 m COP — not a blob. Combat-FX cues stay hugged to the (now correctly-sized) figures.
- `coin-hud.png` (ppm 1.1): the COP renders as clean blue **squad icons** (the R2 aggregation), not giant dots.

## Honest tradeoff / scope
- Legibility-vs-realism tension lives only in the narrow 2.1–2.5 ppm crossfade band (icon fading out /
  individuals fading in, both briefly semi-transparent); unambiguous above 2.5 and below 2.1.
- R3 (village sub-compound cluster — render a hamlet not one qalat) deliberately deferred (smallest slice).
- Bucket 2 (valley shape, weapons-squad count, COP geometry) untouched — sim/terrain is sensitive and 014
  itself rates the relief/peaks already authentic. Issue 014 → **Bucket 1 resolved; Bucket 2 deferred.**
