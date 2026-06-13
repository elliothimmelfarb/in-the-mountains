# C4 gate — night relight + time-of-day grade

The flat navy night wash is gone on the GL path. Night is now real low-key moonlight with
form; dusk/dawn carry a warm grade; the grade seam puts world-dressing under the light and
units/FX/HUD over it. Evidence: `c4-night/` matrix.

## What changed
- sky.ts: grade exposure kept NEAR 1 (0.86–1.0) — the day→night darkness is carried by the
  LIGHTING (sun gone → only moon + sky-ambient), not by exposure (no double-darkening). Night
  sky-ambient + moon raised so moonlit relief reads. Grade does colour: warm WB at golden
  hour, cool scotopic WB + desaturation + shadow-lift at night.
- shaders.ts: moon as a second key (own cast-shadow vis tap, rakes the relief → night has
  FORM) + the `grade()` block (exposure·WB → saturation → shadow-lift) at output.
- WorldView.tsx: GL path passes night=0 to drawTerrainOverlays (no wash; GL self-grades);
  `drawScreenGrade(sky.grade.spriteTint)` seam inserted AFTER world dressing (contours/paths/
  decoration/weather/villages/COP) and BEFORE units/orders/ROE/FX/callouts/night-light/HUD.

## Gates
- **Daytime unchanged (PASS).** c3→c4 noon-operational meanDiff **0.000**, noon-tactical
  0.001 — the grade is exactly identity at high sun, zero daytime regression.
- **Golden grade engages (PASS).** c3→c4 dawn-operational meanDiff 22.2 — the warm low-sun
  grade applies as intended; dusk-tactical shows the amber raking golden hour.
- **Night relit with form, not regressed (PASS).** night-operational reads as cool moonlit
  relief with visible ridgelines + warm COP glow (vs C3's flat navy veil). Terrain mean luma
  (left 60%, panel-inflated): noon 119, dusk 67 (0.56×), night 53 (0.44×) — night is dark,
  cool, and legible. The moon intentionally lifts VISUAL night above the gameplay 0.05 floor
  for night-ops readability; nightFactor (the 2D gameplay value) stays exact (sun probe
  identity maxErr 0.0).
- **Legibility law (PASS).** Units/cues/FX/HUD draw above the grade seam → ungraded ink/light;
  additive night-light muzzle bloom unaffected.

## Residual
- COP life-signs are drawn inside drawCop (above the seam) so they take the night tint. Reads
  fine in capture; if a future eye wants them to bloom harder, split drawCopNightLights below
  the seam (P4) — deferred, not needed now.

Standing checks: tsc clean, build green, smoke OK, sun probe identity 0.0, no new lint errors.
