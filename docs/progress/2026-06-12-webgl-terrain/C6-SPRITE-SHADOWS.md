# C6 gate — sun-tracked cast shadows (+ scoped deferrals)

The COP structures and village qalats now throw long cast shadows that sweep with the clock,
matching the terrain's. Evidence: `c6-final/`.

## What shipped
- sprites.ts `drawSunShadow(ctx, cam, wx, wy, heightM, footprintM, sky.spriteShadow)`: a soft
  dark cast shadow projecting from an object's base toward the anti-sun direction, length =
  heightM × spriteShadow.lengthPerM (= 1/tan(sun alt), clamped), width = footprint, alpha
  folding sun/moon intensity × shadowStrength. Drawn UNDER the sprite, BEFORE the grade seam
  (so it grades with the world).
- Applied to COP buildings (h 3 m) + guard towers (3.5 m) in draw.ts (via CopEnv.sunShadow),
  and village qalats (3 m) in WorldView — only on the GL path, and faded out where valley fog
  hides them.

## Why this is the right scope (not the full P4 axis)
A baked **contact shadow** (tight AO at the base, in the SVG art) and a **cast shadow** (long
projection away from the sun) are physically distinct and coexist on real objects — so adding
renderer cast shadows needs NO change to the 164 SVGs. That delivers the consistency win
(structures cast like the terrain) at zero art-library risk.

## Gates
- **Shadows sweep with the clock (PASS).** C5→C6 dusk-tactical meanDiff 0.27 (1.2% changed,
  maxDiff 100 in the shadow); noon-tactical 0.003 (≈0 — high sun, tiny shadows). Long at
  dawn/dusk, none at noon — exactly the physical behaviour, consistent with the GL terrain
  cast shadows.
- **Not smeary (PASS).** dusk-tactical: soft directional building/tower shadows, readable.

## Deliberate deferrals (documented, not silently dropped)
- **Rotated-statics baked-shadow bug (P4 find, confirmed real).** drawWorldSprite rotates the
  whole sprite incl. its baked SE shadow, so HESCO/ECP/jersey/rotated-barracks carry
  wrong-direction baked contact shadows (draw.ts:404/445/469/523). Minor now (small low
  structures; GL terrain lighting + grade dominate). Proper fix = separate the shadow from the
  SVG (manifest build strips `data-cast-shadow` groups, runtime draws it world-aligned) — SVG
  surgery deferred; the cast-shadow primitive added here is the runtime half already in place.
- **Hero-asset re-author (≤15 SVGs at 2-4× detail).** Lowest marginal value now that the
  terrain/lighting/atmosphere carry the realism and close-zoom already reads (noon-close).
  Per the owner ethos (simplest architecture that clears the bar), deferred rather than spend
  hours of SVG authoring for ~5%. P2's accepted residual (baked NW sprite key converges with
  the dynamic sun at golden hour; mismatch worst at morning when shadows are sub-8px) stands.

Standing checks: tsc clean, build green, smoke OK, my files lint-clean (the 3 WorldView lint
errors pre-date this campaign — hoisted `draw`, `performance.now`).
