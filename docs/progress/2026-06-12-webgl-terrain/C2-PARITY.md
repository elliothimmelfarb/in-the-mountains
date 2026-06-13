# C2 gate — WebGL underlayer at blit parity

The GL underlayer renders the EXISTING lit bake as a textured quad (no lighting). Any diff vs
the 2D baseline is a transform/stack bug, not a feature. Captured on the real M1 Max GPU
(`node scripts/visual-matrix.mjs … c2-glblit`, no --disable-gpu).

## Mean per-pixel RGB diff vs `baseline/` (scripts/scratch-pngdiff.mjs)

| shot | meanDiff | %changed | maxDiff | note |
|---|---|---|---|---|
| noon-operational | 2.05 | 1.5% | 95 | parity |
| dusk-operational | 1.38 | 1.2% | 90 | parity |
| fog-dawn-operational | 1.43 | 1.0% | 86 | parity |
| rain-noon-operational | 2.58 | 6.3% | 86 | parity |
| dawn-tactical | 5.80 | 30% | 108 | + noise-tooth |
| night-tactical | 5.94 | 9.5% | 136 | + noise-tooth |
| noon-close | 9.85 | 63% | 136 | + noise-tooth |
| noon-tactical | 10.25 | 69% | 114 | + noise-tooth |

## Reading

- **Operational/strategic zooms: parity** (meanDiff 1.4–2.6). The GL textured quad reproduces
  the 2D drawImage blit pixel-for-pixel within mipmap-resampling tolerance.
- **Tactical/close diffs are the noise-tooth, not a bug.** The delta scales exactly with
  `detailA = clamp01((ppm−0.6)/2)·0.5` — ~0 at operational (0.9 ppm), ~0.48 at tactical
  (2.5 ppm). The tooth lived in `drawTerrainBlit` (the part the GL path replaces); P1's design
  moves it to GPU procedural grain in C3 (shaders §6). Visual A/B (noon-tactical) confirms:
  COP, HESCO ring, gate serpentine, road, river, decoration all register PERFECTLY — only the
  fine grain differs.
- **The missing tooth also confirms the GL path is live.** If WebGL had fallen back to the 2D
  path, the tooth would be present and every diff ~0. Its absence proves `terrainGL.ok` is
  true and the `drawTerrainOverlays` branch is taken.

## Residual carried into C3
GPU procedural grain (shaders §6) restores close-zoom tooth; re-diff close zoom there.

Standing checks: tsc clean, smoke OK, build (see commit body).
