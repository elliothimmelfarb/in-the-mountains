# Shadow grounding — un-stack the COP, un-freeze the sprite shadows (2026-06-26)

**Owner report:** "graphical artifacts with the lighting that are happening with the shadows."

## What I found (evidence, not vibes)

Captured a matrix of real-GPU screenshots (`scratch-shot1.mjs`) across dawn / noon / golden /
morning at strategic / operational / close zoom, and pixel-peeped the suspicious regions
(`scratchpad/crop.mjs`, mean-luma via `scratch-pngluma.mjs`).

Two artifacts were **NOT** real / already fixed:
- **Terrain slope banding** ("horizontal lines on the sun side, rounded on the other") — the
  `c2223d8` de-band (per-texel dithered ray-march + decorrelated rake) holds. Strategic noon/golden
  ridges read smooth. Not re-rolled.
- **Noon "bright rectangular panels"** and **golden "dark lobes"** — the SAME crop/grass field
  strips, bright when lit, dark olive at low sun. Expected tonal behaviour, not a bug.

The **real** artifact is the **sprite grounding-shadow stack**. Every structure carried *three*
shadows: a **baked SE ground cast-shadow in the SVG art** (fixed direction), the renderer's
sun-tracked `drawSunShadow`, and a sun-independent `drawContactAO` pool. Confirmed by a decisive
test — disabling `drawContactAO` entirely left the dark pools unchanged → they were **baked into the
sprite art**, not the AO.

Two failure modes:
1. **Crater stacking at the COP.** `drawContactAO` stamped a pool `max(wM,hM)×1.05` wide (wider than
   the building) at α≤0.4 per object via `source-over`; N overlapping pools darken as `1−(1−a)ⁿ`, so
   the dense COP cluster crushed to a muddy dark interior. The baked SE shadow (α 0.30–0.37) sat
   under that.
2. **"Two suns."** The baked SE ground shadow is fixed-direction. At golden hour it roughly aligns
   with the live sun-shadow, but in the **morning** (sun east → real shadow west) it points the
   opposite way, so a building showed shadows on *both* sides.

## Fix (one grounding model, sun-tracked, subtle)

- **`drawContactAO` (`sprites.ts`)** — base-hugging radius (`×0.55→×0.5`), capped much lower
  (`0.4/0.34 → 0.26/0.22`) so a 4-deep overlap stays ~0.6 instead of crushing to black.
- **Sun-height AO fade (`draw.ts` `aoFade`)** — the contact-AO exists to ground at *noon* when the
  long cast shadow collapses; when the sun is low (long `drawSunShadow`), the AO now fades to 0.4 so
  the two stop doubling. Building AO footprint `×1.05 → ×0.82` (sits inside the footprint).
- **Baked ground cast-shadow (14 structure SVGs)** — opacity cut **×0.6** (e.g. 0.35→0.21,
  0.30→0.18) on *only* the path following each `<!-- … CAST SHADOW … -->` comment (form-shading,
  AC units, wall shade untouched). The faint baked pool now reads as soft grounding; the sun-tracked
  `drawSunShadow` carries the *direction*. Per-figure inline AO softened to match.

## Numbers (before → after)

| View | Metric | Before | After |
|---|---|---|---|
| Noon close, tight crop under buildings | darkDecile (shadow-pool luma ↑ = lighter) | 60.7 | **64.1** |
| Noon close, tight crop | shadow/lit ratio | 0.314 | **0.331** |
| Noon close, tight crop | center luma | 130.2 | **133.6** |

Buildings stay grounded at operational + close; no floating. Verified noon / morning / golden,
close + operational (`shots/`).

## Standing checks
`tsc --noEmit` clean · `npm run build` exit 0 · `smoke.ts` SMOKE OK (material hash 3664222144
intact — SVG edits don't touch the procedural atlas) · `eslint lib/render/draw.ts
lib/render/sprites.ts` 0 errors (the 276 project-wide lint problems are pre-existing `any` in
scripts/probes, untouched).

## Residual (deliberately not done)
- **Low-sun muddiness.** The valley center-luma drops ~160→~57 from noon to golden. Some is honest
  golden hour; some is the GL exposure/grade. That is the *SACRED* light curve (`sky.ts`) and a
  separate concern from "shadows" — left for a metricized exposure pass, not touched here.
- **Hard cell-quantized landcover edges** (5 m field boundaries) — a terrain-albedo aliasing issue,
  adjacent to but distinct from lighting. Tracked, not fixed here.
- **Full baked-shadow removal + GBuffer relight** (issue 028 item 1) — still deferred; this pass
  *mutes* the baked-shadow double rather than removing it, keeping 2D-fallback grounding intact.
