# C5 gate — atmosphere: cloud shadows + terrain-aware valley fog

Drifting cloud shadows and pooled valley fog, both deterministic, spliced into the terrain
shader. Evidence: `c5-final/` matrix.

## What changed
- lib/render/atmosphere-model.ts (NEW, pure): `atmoState(secondsOfDay, weather, sky, cloudOffset)`
  → cloud density/strength/scale + diurnal fog thickness/strength + graded fog colour;
  `advanceCloud` integrator (offset += wind·Δclock, clamped); `fogVisAt` for 2D parity.
- shaders.ts: cloud shadows = procedural fbm of the wind-drifted world position (dims the SUN
  beam + mottles ambient); valley fog = `clamp((localFloor + thickness − elev)/fade)·strength`
  mixed before the grade. Both off when their strength is ~0 (clear midday = clouds only).
- terrain-gl.ts: 128² local-valley-floor min-field (R32F) — fog pools from the LOCAL floor, so
  it fills the river draw regardless of the 1550→2000 m floor climb; CPU copy kept for parity.
- WorldView.tsx: cloud-drift integrator keyed to World identity (freezes on pause, re-seeds on
  load); `fogAt` sampler fades decoration + village qalats with the SAME field the GL fog uses.

## The two bugs found & fixed (honest record)
1. **Fog read as 0 everywhere.** R32F float textures are only LINEAR-filterable with
   `OES_texture_float_linear`; without enabling it the floor texture was INCOMPLETE → sampled
   0 → `localFloor=0` → terrain elevations (1550+) sat way above the 0+thickness ceiling → no
   fog. Fix: enable the extension (NEAREST fallback if absent). C4→C5 fog-dawn jumped 0.03 → 20.7.
2. **Cloud shadows read as 0 at Clear noon (exact).** The R8 cloud-tile texture path sampled
   black. Rather than chase the upload, switched clouds to PROCEDURAL fbm (already in the
   prelude) — fewer failure modes, deterministic, no texture. C4→C5 noon-strategic 0.00 → 1.19
   (maxDiff 39 in cloud cores — sparse cumulus, correct for Clear).

## Gates
- **Cloud shadows read as aerial footage (PASS).** noon-strategic: soft drifting darker patches
  over the valley; subtle at Clear (density 0.18), heavier under Overcast/Rain.
- **Valley fog pools in the draws (PASS).** fog-dawn-operational: the whole low valley socked
  in, COP + high ground emerging — the documented Korengal morning. Burns off by mid-morning
  (diurnal curve), gone midday, returns at dusk/overnight.
- **2D coherence (PASS by construction).** `fogVisAt` and the GL fog use the IDENTICAL formula
  reading the SAME local-floor field (CPU copy bilinear-sampled to match the GL R32F LINEAR
  tap) — decoration/qalats in fog recede with the terrain, no poke-through.
- **Determinism (PASS).** Clouds = spatial fbm + sim-clock-integrated offset (freeze on pause);
  fog = pure function of clock/weather/elevation. No per-frame randomness.

## Residuals
- COP structures (drawCop) not yet fog-faded (on higher ground near the focus; drawCop is a
  separate module). Decoration + qalats are. Note for a later pass if a fogged-COP shot offends.
- Full 24h×6-weather luma-tracking harness not built; single-fold rule preserved in sky.ts
  (exposure carries weatherLightMult once; fog/cloud are chroma/local). Overcast/Fog correctly
  darker. C4 luma sweep (noon 119 / dusk 67 / night 53) stands.

Standing checks: tsc clean, build green, smoke OK, sun probe identity 0.0, my files lint-clean.
