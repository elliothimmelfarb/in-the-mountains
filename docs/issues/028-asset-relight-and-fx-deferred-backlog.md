# 028 · Asset relight + FX particles — the deferred backlog (WebGL terrain 10x, attempt #2)

**Status:** 🟡 OPEN / PARTIAL (2026-06-13) — lighting coherence (live-sun form-light) + grounding
(contact-AO) shipped in CPU Canvas-2D; the full GBuffer relight, HESCO berm, and FX particles remain
open. See the Resolution at the bottom. Originally a deliberate scope cut from the 2026-06-13 WebGL
terrain overhaul. The design fan-out scoped these as a **separate asset campaign** to run
*after* the terrain spine shipped (the contract's last phase + the cuts list). They were
designed against HEAD, not built this session.

**Why deferred (one line):** the terrain spine was the priority — and intentionally so — so the
resolving ground does not out-resolve flat-sticker buildings before the assets are ready; these
are a separate scoped campaign with their own risk to de-risk first, not a tail of the terrain
work.

## Shipped context (what these build on)

The terrain got the full 10x (see `docs/progress/2026-06-13-webgl-terrain-10x/`): a WebGL2 HDR
underlayer (`lib/render/gl/{terrain-gl,shaders,material-atlas}.ts` + `sky.ts` +
`atmosphere-model.ts`) recomposing the surface per-pixel from the sim's arrays — material atlas
+ detail-normal raking, baked horizon AO, live-sun cast shadows with PCF penumbra, a dark-silt
flow-advected river, single-scatter aerial perspective + in-fog god-rays, ACES tonemap + grade,
all under a transparent Canvas-2D HUD, with an alive 2D-bake fallback (`TerrainGL.ok=false`).

Assets got **grounding, not relight** (commit `89c87d5`, C9): `drawSunShadow` now drops
sun-tracked cast shadows under ALL world-dressing — COP structures + qalats since C1, extended
to every scattered tree (long, height-scaled) and rock (tight contact), all tracking the live
clock sun and fading with the valley fog + deco LOD alpha so nothing floats. That closes the
*most jarring* seam (flat sprites sitting on top of resolving ground) but the sprites still do
not catch the live sun with real form.

## Deferred items, in priority order

1. **Full per-sprite normal/AO relight — a deferred GBuffer pass.** An instanced WebGL2 deferred
   sprite pass lighting ALL ~160 world-dressing sprites in ONE draw (strictly cheaper than the
   current 164 CPU `drawImage` blits) from the SAME `SkyState` + the SAME `formLightNW` guard the
   terrain uses — so a sprite catches the live sun with real volume instead of its baked-NW flat
   shade. **De-risk the SDF-extrude bake on 3–4 long-tail assets BEFORE committing the pipeline**
   — the named failure mode is the **"puffed-pillow"** look (a soft uniform extrude that turns a
   crisp B-hut into a marshmallow). If the spike is mushy, hand-author only the high-pixel heroes
   (HESCO, B-hut, tower, MRAP, qalat, soldier, cedar) and lean on cast-shadow + contact-AO for the
   tail. **Load-bearing correctness:** rotate the tangent-space normal into WORLD frame in the
   fragment *after* the sprite's heading rotation, else rotating soldiers/vehicles get lighting
   that spins with heading — verify with a 360° turntable probe of one soldier. Must resolve the
   **ART_BIBLE §1 baked-light contradiction explicitly**: either strip the baked NW directional
   light from the 164 SVG albedo sources, or accept the double-light long tail — mutually
   exclusive. 2D-fallback parity: the albedo channel IS the old flat sprite, one `ok` branch
   mirrors `TerrainGL.ok`.

2. **Continuous-extruded HESCO berm.** Re-author the dotted-segment COP wall ring as ONE
   continuous extruded berm (instanced strip driven from the COP layout geometry) with mitered
   corners + a sandbag parapet + the gate cut. Highest single-asset payoff for ~0.2 ms — the COP
   is the emotional center and currently reads as a dotted necklace, not a wall.

3. **FX particles.** (a) **Movement dust** — a kicked-up dust plume behind moving units on dry
   ground (rotation-tolerant `fx-dust-puff`, soft contact, no directional shadow; ART_BIBLE §9).
   (b) **Volumetric wind-driven smoke** — proper smoke columns (cookfires, smoke grenades, burning
   wrecks) that drift with the sim wind vector and self-shadow, instead of flat sprite puffs.
   Both are world-scaled physical effects obeying §1's NW-light rules; phase must key off
   `world.secondsOfDay`/the wind vector (freezes on pause, NO wall clock).

## Repro / rationale

- **Repro the seam:** deploy any seed, zoom to **close** (ppm > 3) in the afternoon, look at a
  soldier or vehicle on the now-resolving ground. The terrain reads as lit material; the sprite
  reads as a flat sticker with a (correct) cast shadow but no form-light — it does not catch the
  sun. Rotate a moving unit and confirm its *baked* shade does not change with heading (the
  evidence the relight is missing, and the constraint the GBuffer pass must honor).
- **Rationale:** the contract deferred this on purpose — "the resolving ground does not out-resolve
  flat-sticker buildings" is the ordering reason, and the SDF-extrude *puffed-pillow* risk is real
  enough to spike before committing a whole GBuffer pipeline. The cheap, high-payoff HESCO berm
  could be interleaved earlier if the owner wants the COP to read as fortified sooner, at the cost
  of close-band ground/object coherence ordering (owner decision, contract `openDecisionsForOwner`).

## Acceptance (when this campaign is taken up)

- SDF-extrude spike reviewed on 3–4 long-tail assets BEFORE the GBuffer pipeline is committed
  (puffed-pillow check).
- 360° turntable probe shows soldier lighting does NOT spin with heading.
- COP reads as a fortified outpost from above (the continuous berm); building classes remain
  distinguishable at operational.
- Movement dust + drifting smoke key off the master clock / wind (freeze on pause; no strobe at
  time-warp).
- 2D-fallback parity holds (the `ok` branch); tsc/build/lint/smoke/balance green.

## Resolution (2026-06-13) — PARTIAL: lighting coherence + grounding banked; full GBuffer NOT built

The owner asked for the sprite layer to "match the terrain's level." We took the **low-risk,
high-payoff** path the contract recommended and **explicitly did NOT gamble on the deferred
GBuffer pass** — instead banking the two wins that closed most of the flat-sticker seam in CPU
Canvas-2D, then stopping with budget intact rather than risking the puffed-pillow rebuild.

**What shipped (all in the one-writer files: `sprites.ts`, `draw.ts`, `decoration.ts`,
`WorldView.tsx`):**

1. **Per-sprite live-sun FORM-LIGHT (the coherence win).** New `spriteLightFrom(SkyState)` →
   `SpriteLight`, computed ONCE per frame from the single SkyState and threaded into every
   world-sprite blit. `drawWorldSprite` now composites ONE `source-atop` directional gradient over
   the sprite's own pixels: a warm highlight on the sun-facing edge → neutral mid → a cool sky-bounce
   shade on the sun-away edge. Strength keys off `sunIntensity` × a low-sun *rake* term (hard raking
   side-light at golden hour/dusk, near-flat at noon, **zero at night** — the pass is skipped when the
   sun is down, so the night life-signs read unchanged). So a COP building now catches the SAME live
   sun the GL terrain does. **~1 extra fill per sprite; no re-bake, no GL.**
   - **Load-bearing correctness HONORED:** the gradient axis is the sun's screen-projected world
     direction; for a rotating sprite (vehicle/helo) the blit counter-rotates the axis by `-heading`
     so the lit side stays WORLD-anchored. Verified to machine precision by a turntable probe
     (8 headings, max err 1e-16 — "lit side does NOT spin with heading"). Figures go through
     `drawScreenSprite` and are deliberately left UNTINTED (legibility law — they sit below the grade
     seam as ink/light).

2. **Contact-AO grounding.** New sun-independent `drawContactAO` (a soft squashed dark pool hugging
   the base) under every COP building, fighting position, tower, parked vehicle, helo, and qalat — and
   a lighter inline pool under each figure/casualty in `drawUnit`. This is what keeps objects planted
   at **high noon** when the long directional `drawSunShadow` collapses to nothing. Structure-AO is
   gated on `env.light`/`sprLight` (undefined on the 2D fallback → skipped, so 2D parity holds).

**Verified visually (real GPU, `scratch-shot1.mjs`, close-zoom COP @ 4.6 ppm):** dawn 6.5h (sun E,
buildings lit on the east edge, cast shadows sweep W), noon 12h (flat form-light + AO grounding),
golden 17–18h + dusk 18.6h (warm/orange raking edge-light, cool shade, grounded), night 22h
(form-light faded, life-signs intact). Before/after at matched 18.6h shows the COP go from flat
floating decals to grounded objects sitting in the valley's light. SwiftShader parity confirmed.
Faction rings + name plates stay crisp at every frame (legibility contract intact).

**Standing gates:** `tsc --noEmit` clean · `npm run build` clean · `scripts/smoke.ts` → SMOKE OK
(asset manifest builds) · `eslint` adds **0 new errors** (the 2 pre-existing WorldView errors —
`performance.now` purity @ 771, exhaustive-deps — are from commit `5b2d1d1`, untouched by this work).

**Residuals / deliberately NOT done (still OPEN for a future taking-up):**
- **Full GBuffer deferred-light pass (item 1) — not built.** The CPU form-light is a soft *overlay*,
  not true per-pixel normal relight. It reads convincingly but it is a screen-space gradient, not
  volume from a normal map. The GBuffer pass remains the way to get real per-pixel form.
- **ART_BIBLE §1 baked-light double-light tail — accepted, NOT resolved.** The 164 SVG albedos still
  bake their own NW light + SE drop-shadow; the live form-light is a second light on top. Verified
  benign at the worst case (morning, sun in the east vs the baked SE shadow) — the soft overlay
  dominates the read — but the contradiction is not *resolved*. Stripping the baked light is the
  mutually-exclusive bigger commitment the 2D fallback depends on; not taken.
- **Continuous-extruded HESCO berm (item 2) — not done.** The wall is still a dotted gabion
  necklace; it now sits in the live light + is grounded, but it is not one continuous mitered berm.
- **FX particles (item 3) — not done** (movement dust, volumetric drifting smoke).
- **Hero-asset re-authoring — assessed, judged unnecessary for now.** Rendered the B-hut / barracks /
  qalat-large SVGs: they are already isometric with pitched roofs, wall shading, doors, sandbags —
  NOT crude stickers. The "flat sticker" complaint was overwhelmingly a *lighting-coherence* problem
  (now fixed), not an art-detail problem, so re-authoring was de-prioritised in favour of banking the
  coherence win cleanly. The continuous HESCO berm (item 2) is the highest-payoff single asset left.

## Update (2026-06-26) — baked GROUND cast-shadow double MUTED (not the form-light tail)

A follow-up owner report ("graphical artifacts with the lighting that are happening with the
shadows") traced to the **baked SE ground cast-shadow** half of the baked-light tail — distinct from
the form-light (NW directional) half this issue's item 1 is about. Every structure stacked THREE
grounders (baked-SE in-art + sun-tracked `drawSunShadow` + sun-independent `drawContactAO`), which
(a) crater-stacked at the dense COP and (b) read as "two suns" in the morning (baked SE vs the real
westward shadow). Fixed in `2026-06-26-shadow-grounding`: contact-AO de-stacked (lower cap +
sun-height fade so it stops doubling the cast shadow), and the baked ground cast-shadow opacity cut
×0.6 on 14 structure SVGs so the sun-tracked `drawSunShadow` carries the direction. This **mutes**
the ground-shadow double; the **form-light (NW) baked-light contradiction (item 1) remains OPEN** —
the real per-pixel GBuffer relight is still the way to retire it fully.
