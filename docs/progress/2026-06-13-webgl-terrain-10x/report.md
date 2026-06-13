# WebGL terrain 10x — attempt #2 (the engineering record)

**Published report (player-facing):** `public/manual/archive/reports/2026-06-13-the-valley-is-real/report.html`
(wired into the Field Manual archive: timeline chapter `c-2026-06-13-the-valley-is-real` + catalog card).

## What this was
Attempt #1 (commits `1d487a2`→`c55bf19`) was reverted in `b5a0f33` for being **parity-plus-a-filter**:
it blitted the existing flat painted relief onto the GPU byte-for-byte, then added a moving sun, cast
shadows, and a colour grade over the top. The owner: *"do it again and 10× better, go the WebGL route."*

Attempt #2 **inverts the idea**: the painted albedo is demoted to one input of five; the fragment shader
recomposes the surface per-pixel from the sim's own arrays (landcover/slope/cover/heightfield) against a
procedural material library, lit in linear radiance, with real AO, water, atmosphere, and an ACES finish —
while a `u_detailGain` zoom-ramp keeps strategic zoom byte-faithful (the legibility firewall).

## Process (this directory = the raw record)
- **Design fan-out** (`design/fanout-raw.json`, `design/contract.json`): 4 proposers × 4 judges →
  synthesized build contract. Spine = photoreal-drone surface recomposition (8.38/10, 4/4 "genuine 10x"),
  grafting living-valley water + cinematic-film atmosphere; asset-fidelity deferred.
- **Owner steer:** SOBER photoreal ISR (surface fidelity carries it, not Hollywood bloom/glint); NO summer snow.
- **Build:** 9 commits (`a1aeedc`…`ade0368`), each green, one transformative layer at a time. See git log.
- **Verification** (`design/verify-fanout.json`): 4-critic adversarial pass → **1/4 cleared the bar**, three
  citing the river (near-white "salt flat") + daytime haze crushing operational contrast. Both fixed
  (dark silt water + zoom-scaled haze + calmer materials + 3 deeper bugs: marsh-checkerboard, NEAREST-flow
  decorrelation, partial-mask bright-bed bleed). A **fresh-eyes reviewer confirmed: clears the bar, ships.**

## Evidence (matrices: 4 times × 4 zooms + rain/fog, real GPU, seed `visual-baseline`)
- `baseline-current/` — the pre-overhaul flat-2D "before".
- `c1-skeleton/`, `c2-linear/`, `c4-materials/`, `c5-ao/` — per-phase progression.
- `after/` — the final shipped state (post-critic-fixes).

## Verbatim gate numbers
- **Legibility firewall:** strategic mid-grey luma 132.2 → 132.4 (Δ+0.2) — byte-faithful preserved.
- **Noon calibration (C2):** center luma 149.5 → 156.1 (in attempt-1 ballpark, relief raised not inverted).
- **AO (C5):** noon-operational center 154.4 → 146.1 (Δ−8.3, contact darkening in draws/cliff bases).
- **Compound-veil floor (C7):** fog-dawn readable mid-grey 115 (not crushed); clear-noon legible 153.
- **GL capability probe (headless SwiftShader):** RGBA16F renderable, R8UI/RG8 uploads clean, usampler2D links.
- **Standing checks at ship:** tsc clean · `next build` compiled · smoke OK (no-NaN + serialize + material
  hash 3664222144) · balance 12/12 firefights, 0 stranded · sun-determinism probe identity maxErr 0.0.

## Honest residuals / deferred backlog (issue 028)
- **Terrain = full 10×; assets = grounding only.** The 164 sprites are still flat bitmaps with sun-tracked
  cast shadows; full per-sprite normal/AO relight (deferred GBuffer pass) + continuous HESCO berm + FX
  particles (movement dust, wind-driven smoke) are a scoped follow-on campaign — `docs/issues/028-*.md`.
- Braided gravel floodplain reads texturally busy at maximum close zoom (non-gating cosmetic).
- Dawn warm/cool temperature split could go further (low priority).
