# 028 — Sprite-shadow re-author + hero assets (deferred from the WebGL terrain campaign)

**Status:** OPEN (deferred, documented). Opened 2026-06-13 by the WebGL terrain lighting
rebuild (`docs/progress/2026-06-12-webgl-terrain/`, archive report `2026-06-13-the-sun-is-real`).

The terrain rebuild made the sun real (live per-fragment lighting, cast ridge shadows, moon,
grade, cloud shadows, valley fog). Two items from the design fan-out's art-seam axis (P4) were
deliberately NOT done, because their marginal value is low now that the terrain carries the
realism and their cost/risk is high. Recorded here so they're a choice, not an oversight.

## 028a — Rotated-statics carry a wrong-direction baked contact shadow

**Mechanism (confirmed, real):** `drawWorldSprite` (lib/render/sprites.ts) does `ctx.rotate(opts.rot)`
then blits the sprite, which has the NW→SE contact shadow baked into its SVG art (ART_BIBLE §1).
So any sprite drawn with a rotation rotates its baked shadow too → it points the wrong way
relative to the world light. Affected call sites: `hesco-straight` (draw.ts:404, rot a+π/2),
`ecp-gate` (:445), `jersey-barrier` (:469), barracks (:523).

**Severity:** low-minor now. These are small low structures; the new GL terrain lighting + grade
dominate the scene, and C6 added renderer-drawn sun-tracked CAST shadows for the tall structures
(which DO track correctly). The baked contact shadow on a rotated low wall is barely visible.

**Proper fix (when it's worth it):** separate the shadow from the sprite art — strip the
`data-cast-shadow` group from the SVG sources at manifest-build time (with a build-time
`castHeight ⟺ group` cross-validation so both failure modes are compile errors), and draw the
contact shadow world-aligned at runtime (the `drawSunShadow` cast-shadow half already exists).
Repro: zoom to the COP wire at tactical zoom near golden hour; the HESCO segments' baked shadows
fan inconsistently around the ring.

## 028b — Hero-asset re-author not done

The ≤15 close-zoom hero sprites (qalat compounds, TOC, HESCO, towers, key trees) were not redrawn
at 2-4× detail with baked AO. Lowest marginal value once terrain/lighting/atmosphere carry the
realism; close-zoom already reads (see `c6-final/noon-close.png`). P2's accepted residual stands:
the baked NW sprite key converges with the dynamic sun at golden hour, mismatch worst at morning
when shadows are sub-8px at typical zoom. Pick this up only if a close-zoom pass is the focus.

## Also noted
- A clean cross-GPU frame-time number for the GL path is unmeasured (the headless rAF probe was
  inconclusive — a CDP serialization quirk). The GL pass is one draw call + an amortized ≤4 Hz
  shadow rebake, and the 2D pass now sheds its per-frame 4096² blit; the 18-shot matrix rendered
  without hitches on an M1 Max. Take a `requestAnimationFrame`-delta measurement on an Intel iGPU
  before claiming the perf budget.
