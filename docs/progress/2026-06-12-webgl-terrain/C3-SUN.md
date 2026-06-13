# C3 gate — the sun is real

The GL underlayer now lights the UNLIT albedo per-fragment from the heightmap with the live
clock sun + cast ridge shadows. Evidence: `c3-sun/` (18-shot matrix) + `timelapse/` (8-frame
dawn→dusk sweep at strategic zoom, single camera).

## What changed vs C2 (blit parity)
- topo.ts `makeBake(terrain, lit)`: `lit=false` drops the relief shade, altitude warm/cool,
  and haze from the bake → unlit albedo (own cache, `bakeAlbedo`). Those three terms are now
  LIVE in the shader.
- Per-fragment normals (forward difference, screen-res) + Lambert sun tinted by sky.sunColor
  + anti-solar fill + hemisphere sky-ambient (carries more when the sun is down).
- Cast ridge shadows: 1024² R8 sun-visibility FBO, exponential-stride ray-march spanning the
  whole 2.56 km map, rebaked only when the key dir moves >0.25°.
- `u_formLightNW = 0.32`: a fixed NW key blended into the diffuse so a high noon sun (due
  south on a north-up map) still rakes the relief — the relief-inversion guard (P4).
- GPU ground-grain restores the close-zoom tooth C2 dropped.

## Gates
- **Marquee — cast ridge shadows sweep (PASS).** `dawn-strategic`: the entire western valley
  floor sits in deep cast shadow thrown by the east wall, warm light only on east-facing
  slopes + ridgetops — the documented Korengal morning. `noon-strategic`: evenly lit, full
  color, fields/forest read. `dusk`: shadows rake from the opposite (WNW) side. Sun visibly
  walks across the day in `timelapse/t0530…t1830`.
- **Noon legibility squint, 4 LOD bands (PASS).** strategic/operational/tactical/close all
  read; the form-light keeps relief legible under the flattening high sun; COP, roads, river,
  contours crisp at every band.
- **Night not regressed (PASS).** C3 keeps the 2D navy wash; ambient carries form so night is
  a dark-but-legible relief (proper moonlit relight + grade is C4).
- **Close-zoom tooth restored (PASS).** `noon-close` shows the GPU grain; HESCO/LZ/buildings
  read.

## Calibration note
`u_keyGain=1.0`, `u_formLightNW=0.32` — daytime brightness close to HEAD by eye; not pixel-
identical (the light is now real — noon is legitimately flatter than the old frozen-NW bake,
which is correct). Final exposure handed to the grade in C4.

Standing checks: tsc clean, build green, smoke OK, my files lint-clean.
