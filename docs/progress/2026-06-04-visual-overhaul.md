# Map Visual Overhaul — 2026-06-04

A ground-up upgrade of the tactical map's visual fidelity: the renderer went from primitive canvas
shapes (blue rectangles for soldiers, wireframe boxes for buildings, coloured dots for everything else)
to a **hand-authored SVG sprite system with a zoom-aware level-of-detail layer**.

**The deliverable:** [`../visual-overhaul/asset-bible.html`](../visual-overhaul/asset-bible.html) — a
studio art bible with the design system, before/after, and all **160 assets** rendered live. Art
direction contract: [`../visual-overhaul/ART_BIBLE.md`](../visual-overhaul/ART_BIBLE.md).

## What changed

- **160 SVG assets** across 16 families: US/ANA/insurgent/civilian figures, COP buildings &
  fortifications, aviation, vehicles, qalat village compounds, vegetation, map markers, HUD
  cartography, and a flat UI icon set. Authored to one contract: single **NW key light**, locked dusty
  palette, top-down 2.5-D projection, documented anchor + footprint per asset.
- **Sprite/LOD runtime** (`lib/render/sprites.ts`): rasterize-once / blit-many; NATO symbols crossfade
  to detailed figure sprites as you zoom; buildings, the LZ pad, the ECP gate, towers, fighting
  positions, the flag and parked vehicles render the COP as a real outpost; qalat compounds + attitude
  banner pins replace house glyphs; a Black Hawk lands on the LZ during air resupply.
- **Terrain** (`lib/render/topo.ts`): higher bake resolution, **fbm-dithered landcover boundaries**
  (organic edges, not 5 m stair-steps), a world-anchored high-zoom detail overlay (hides upscale blur),
  warmer/dustier palette, and a baked gabion texture so the HESCO perimeter reads as bastion baskets.
- **Decoration** (`lib/render/decoration.ts`): trees / rocks / reeds scattered by landcover from a
  **stable per-cell hash** (no jitter), with clumping, clearance from roads/water/the COP, and
  per-instance variation — forest/orchard/scree become actual vegetation at tactical zoom.
- **UI iconography** (`components/Icon.tsx` + `DeployScreen.tsx`): order tools, missions, fire support,
  CERP projects, soldier roles, logistics, weather and a faction crest now carry authored icons.

## How it was built & verified

Assets were authored and adversarially critiqued by **background Workflows** (one agent per family,
each rendering its own SVG with `sharp` and self-critiquing the PNG before returning). A 4-lens AAA
art-director critique then drove a fix pass (building aspect, strategic-zoom garrison collapse,
decoration naturalism, nameplate collisions, palette, grounded LZ pad, attitude pins, tree contrast).

**Verified:** live across all zoom bands via Playwright + `window.__ITM`; **116 fps** at high zoom with
the sim running; `tsc` / `npm run build` / `smoke` all green; render-only (zero simulation impact).

## Before / after

| | Before | After |
|---|---|---|
| COP | wireframe boxes + labels | gabion ring, B-huts w/ roofs, LZ pad + Black Hawk, motor pool |
| Units | blue rectangles / red diamonds | top-down soldier sprites per role, faction rings, LOD symbols |
| Villages | house glyph + name | mud-walled qalat compounds + attitude banner pins |
| Terrain | shaded relief (blocky/blurry) | dithered organic edges, decoration trees/rocks, detail tooth |
| HUD/UI | unicode glyphs | compass rose, scale bar, full milspec icon set |

Baseline captures in [`../visual-overhaul/baseline/`](../visual-overhaul/baseline/), final captures in
[`../visual-overhaul/after/`](../visual-overhaul/after/); the live `asset-bible.html` embeds both.
