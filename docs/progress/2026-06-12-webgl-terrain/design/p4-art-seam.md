# art-seam — everything drawn ON TOP of the new WebGL terrain: sprite shadows, decoration, grade coherence, contours, hero assets, ART_BIBLE contract

confidence: 0.8

## Summary
The 2D layer above the GL terrain gets one new physical system — sun-tracking cast shadows — and one new coherence system — a shared sun/grade module that both canvases read. Roughly 33 of the 164 sprites (vegetation, COP structures, qalats — the static world-fixed objects) have their baked SE shadows stripped from the SVG sources (wrapped in a `data-cast-shadow` group the manifest builder removes) and replaced by a runtime projected-silhouette shadow: a pre-baked, blurred, half-res tint of each sprite's own raster, slid and stretched along the live sun's shadow axis with length = castHeight·cot(elevation), clamped. This also fixes a latent bug: HESCO/ECP segments are drawn rotated today (draw.ts:404,445), so their baked "SE" shadows already point the wrong way around the ring. Rotating figures/vehicles keep their symmetric contact shadows (unchanged, per ART_BIBLE rationale); flat ink (markers/HUD/UI/FX, ~100 sprites) is untouched. Time-of-day grade and night dim reach sprites via a single full-screen 'source-atop' tint pass on the top canvas — the only composite op that tints existing pixels without occluding the GL terrain below — driven by the same gradeFor() function the GL shader receives as uniforms, so sprites never float off the graded terrain. Draw order is re-cut so world dressing (decoration, villages, COP) sits under weather+grade while units, orders, ink labels, and combat FX stay above (legibility law preserved); contours/paths/grid stay exactly as they are, just split out of drawTerrain. Fifteen hero sprites (qalats, mosque, B-huts/TOC, guard tower, HESCO, ECP, cedar/walnut, UH-60) get 2–4× re-authors with Kunar-correct detail (stone-and-timber qalats, plywood B-huts, wire-grid HESCO) and baked AO under the new soft-light contract. The result clears the bar because the one thing aerial footage of the Korengal always shows — long morning shadows raking west off every cedar and tower, swinging north by noon, dying under overcast — now happens, coherently, on both canvases at once.

## Design
# Art-Seam Design: the 2D layer over the WebGL terrain

Scope: sun-tracking sprite shadows, the ART_BIBLE contract rewrite, decoration/grade/fog coherence between canvases, hero asset upgrades, loading-phase changes, and confirmation that contours/paths/ink stay 2D. The GL terrain itself (normals, ridge shadows, splat) belongs to the gl-core axis; this doc specifies the **shared contracts** it must honor (sun uniform, grade parity) with sketch code.

---

## 1. Components and proposed files

| Component | File | Status |
|---|---|---|
| Sun + grade model (shared, render-layer) | `lib/render/sun.ts` | NEW |
| Sprite shadow masks + projected draw | `lib/render/sprites.ts` | extend (`AssetDef.castHeightM`, `Baked.shadow`, shadow block in `drawWorldSprite`) |
| Decoration with shadows | `lib/render/decoration.ts` | extend (pass `SunState` through) |
| COP/village shadows + night-light split | `lib/render/draw.ts` | extend (`CopEnv.sun`; split `drawCopNightLights`) |
| Map ink split (contours/paths survive the GL swap) | `lib/render/topo.ts:552-593` | split `drawTerrain` → keep `drawMapInk` |
| Frame orchestration + grade pass | `components/world/WorldView.tsx:214-740` | reorder + 2 new calls |
| Shadow-strip + castHeight plumbing | `scripts/build-asset-manifest.mjs`, `docs/visual-overhaul/assets/_meta.json`, ~35 SVG sources | edit sources, regenerate |
| Loading phases | `state/store.ts:373-380` | rework `renderWarmPhases` |
| Contract | `docs/visual-overhaul/ART_BIBLE.md` §1, §7.2, §8, new §1b | rewrite |

Data flow per frame (top canvas): `World.secondsOfDay` + `weatherLightMult` → `sunState()` / `gradeFor()` computed ONCE in WorldView's `draw()` → passed by value into `drawDecoration` / village loop / `drawCop` (shadow direction, length factor, alpha) → one `source-atop` fillRect applies the grade/night tint to everything drawn so far → units/FX/HUD draw above, ungraded. The same `sunState()`/`gradeFor()` outputs go to the GL underlayer as uniforms (gl-core seam). Render reads the live World, never writes — unchanged.

---

## 2. The sun contract — `lib/render/sun.ts` (NEW, ~90 lines)

One pure function of the master clock. Both canvases read it; nothing else may define a sun. Deterministic (no Math.random, no wall clock — `secondsOfDay` only).

```ts
const RAD = Math.PI / 180;
const LAT = 34.8 * RAD;        // Kunar
const DECL = 15 * RAD;         // fixed early-summer declination (c. May 2011 fighting season)
// Solar noon at 12:15 — centers the gameplay daylight window (solarLight: dawn 05-07,
// full 07-17, dusk 17-19.5, world.ts:122-129). With these constants the sun crosses the
// horizon at ~05:30 and ~19:05 — BELOW the horizon whenever solarLight is at starlight,
// satisfying the consistency invariant without touching gameplay light.
export interface SunState {
  azimuth: number;      // compass radians, 0=N, π/2=E
  elevation: number;    // radians above horizon (<0 below)
  dirX: number; dirY: number;   // unit vector TO the sun in world coords (+x east, +y SOUTH)
  shadowLenK: number;   // cot(elev), clamped — shadow length (m) = castHeightM * shadowLenK
  shadowAlpha: number;  // 0..0.34 — fades across sunrise AND under overcast
  stretch: number;      // silhouette elongation along the shadow axis, 1..2.2
}
export function sunState(secondsOfDay: number, weatherLightMult: number): SunState {
  const H = (secondsOfDay / 3600 - 12.25) * 15 * RAD;              // hour angle
  const sinEl = Math.sin(LAT)*Math.sin(DECL) + Math.cos(LAT)*Math.cos(DECL)*Math.cos(H);
  const el = Math.asin(sinEl);
  // azimuth from north, eastward-positive (atan2 form measures from south → +π)
  const az = Math.atan2(Math.sin(H), Math.cos(H)*Math.sin(LAT) - Math.tan(DECL)*Math.cos(LAT)) + Math.PI;
  // world axes: +x = east, +y = SOUTH (y=0 is the valley's north mouth — terrain.ts)
  const dirX = Math.sin(az), dirY = -Math.cos(az);                 // toward the sun
  const elC = Math.max(el, 6 * RAD);
  const k = Math.min(Math.cos(elC) / Math.sin(elC), 3.5);          // artistic clamp: ≤3.5× height
  const up = smoothstep(-2 * RAD, 6 * RAD, el);                    // shadows fade in over sunrise
  const wk = Math.max(0, (weatherLightMult - 0.55) / 0.45);        // Overcast .8→.56, Fog .6→.11
  return { azimuth: az, elevation: el, dirX, dirY, shadowLenK: k,
           shadowAlpha: 0.34 * up * wk,
           stretch: Math.min(2.2, 1 / Math.max(Math.sin(elC), 0.45)) };
}
```

Sanity (verified by hand): 06:15 → az≈78° (ENE), shadows point WSW; solar noon → az=180°, el≈70°, shadows point NORTH, short; 18:30 → az≈282°, long shadows ESE; 05:00 / 19:30 → el≈−6°, shadowAlpha=0. Morning shadows raking west across the terraces is exactly the Restrepo-footage read.

**Grade, same module:**
```ts
export interface Grade { r: number; g: number; b: number; a: number } // the source-atop tint
export function gradeFor(secondsOfDay: number, weatherLightMult: number): Grade {
  const { elevation: el } = sunState(secondsOfDay, weatherLightMult);
  const night = 1 - /* solarLight-shaped ramp */ clamp01((el + 6*RAD) / (12*RAD));
  // NIGHT: today's exact constants (topo.ts:589) so the night look is pixel-compatible
  if (night > 0.6) return { r: 8, g: 14, b: 30, a: 0.35 + ((night-0.6)/0.4) * 0.42 };
  const golden = clamp01(1 - el / (18 * RAD));   // 1 at horizon → 0 above 18°
  if (el > 0) return { r: 255, g: 168, b: 92, a: 0.16 * golden * weatherLightMult }; // golden hour
  return { r: 70, g: 90, b: 140, a: 0.15 + night * 0.3 };          // blue hour ramp into night
}
```
**GL parity rule (binding on gl-core):** the GL grade term must be `color = mix(color, uGradeTint, uGradeAmt)` with `uGradeTint/uGradeAmt = gradeFor(...)` — the same alpha-mix the 2D `source-atop` fillRect performs — NOT a multiply, or the two canvases drift apart at dusk.

**Consistency snippets for the shared uniforms** (gl-core owns the terrain shader; these document the contract so both axes compute against the same frames of reference):
```glsl
// uSunDir = normalize(vec3(sun.dirX, sun.dirY, tan(sun.elevation))) — world meters, +y SOUTH, z UP
vec3 normalAt(ivec2 c) {            // central differences, cellSize = 5.0 m
  float l = texelFetch(uElev, c + ivec2(-1,0), 0).r, r = texelFetch(uElev, c + ivec2(1,0), 0).r;
  float u = texelFetch(uElev, c + ivec2(0,-1), 0).r, d = texelFetch(uElev, c + ivec2(0,1), 0).r;
  return normalize(vec3((l - r) / 10.0, (u - d) / 10.0, 1.0));
}
float ridgeShadow(vec2 wpos) {      // height-field ray-march toward the sun
  float t = 5.0, h0 = elevAt(wpos), s = 1.0;
  for (int i = 0; i < 24; i++) {
    vec2 p = wpos + uSunDir.xy * t;
    float dh = (h0 + uSunDir.z * t) - elevAt(p);
    s = min(s, smoothstep(0.0, 12.0, dh));      // soft penumbra
    t *= 1.35;                                   // log steps out to ~1.5 km
  }
  return s;
}
// splat blend: gl-core's axis; only constraint from here is palette parity with ART_BIBLE §3.
```
**Cross-axis flag (relief inversion):** with a real noon sun (az 180°) a north-up map is in the classic relief-inversion condition. Recommend gl-core blends ~25–35% fixed NW form light into the diffuse term. This also justifies §6 below: sprites keep a soft NW *surface* bias, so terrain and sprites share the same residual form light.

---

## 3. Sun-tracking sprite shadows

### 3.1 The mechanism: projected self-silhouette, baked once, blitted per instance

At sprite load, for every `AssetDef` with `castHeightM`, bake a **shadow mask**: the sprite's own raster at half resolution, blurred once, recolored to deep shadow:

```ts
// lib/render/sprites.ts — one-time, cached on Baked
function shadowMask(b: Baked): HTMLCanvasElement {
  if (b.shadow) return b.shadow;
  const w = Math.max(8, b.baseW >> 1), h = Math.max(8, b.baseH >> 1);
  const s = document.createElement("canvas"); s.width = w; s.height = h;
  const c = s.getContext("2d")!;
  c.filter = `blur(${Math.max(1.5, w * 0.025)}px)`;   // one-time soften (bake-time only — never per frame)
  c.drawImage(b.canvas, 0, 0, w, h);
  c.filter = "none";
  c.globalCompositeOperation = "source-in";            // keep alpha, replace color
  c.fillStyle = "#1c160e";                             // ART_BIBLE deep shadow
  c.fillRect(0, 0, w, h);
  return (b.shadow = s);
}
```

Per instance, immediately before the sprite blit in `drawWorldSprite` (sprites.ts:112-140), when `opts.sun` is passed and `castHeightM > 0`:

```ts
const sun = opts.sun;
if (sun && sun.shadowAlpha > 0.01) {
  const lenPx = b.def.castHeightM! * sun.shadowLenK * cam.ppm;   // ground length of the cast
  const ang = Math.atan2(sun.dirY * -1, sun.dirX * -1);          // shadow axis = away from sun
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);                    // +x is now the shadow axis
  ctx.translate(lenPx * 0.5, 0);      // slide the silhouette's centroid half the cast length
  ctx.scale(sun.stretch, 1);          // elongate along the axis (≈1/sin(elev), clamped 2.2)
  ctx.rotate(-ang);
  if (opts.rot) ctx.rotate(opts.rot); // the sprite's own world rotation — projection stays world-axis
  ctx.globalAlpha = (opts.alpha ?? 1) * sun.shadowAlpha;
  ctx.drawImage(shadowMask(b), -ax, -ay, pxW, pxH);
  ctx.restore();
}
```

Why this reads correctly for top-down art: the shadow draws **under** the (mostly opaque) sprite, so only the sun-away fringe shows — for a 40 m qalat with a 3.5 m wall that fringe IS the wall shadow; for a cedar the offset blurred canopy blob IS the classic aerial tree shadow; for the 6 m guard tower at 17:30, `len = 6·3.5 = 21 m` of raking shadow is the money shot. Interleaved-with-sprite ordering matches exactly what today's baked shadows do under painter's y-sort, so dense forest keeps its accepted look. Escape hatch if dense-forest interleaving looks dirty under long shadows: `drawDecoration` already collects `items[]` (decoration.ts:87-123) — converting to two loops (all shadows, then all sprites) is a 6-line change.

**Rotated statics get fixed for free.** HESCO ring segments (`rot: a + Math.PI/2`, draw.ts:404), ECP gate (draw.ts:445), jersey barriers (draw.ts:469) are rotated static sprites whose baked "SE" shadows already violate the lighting contract today — they rotate around the ring. Since projection happens in world axes *after* `opts.rot`, every segment now casts the same world direction.

Determinism: pure function of `secondsOfDay` + per-asset constants; decoration's rot jitter is already hash-stable. No per-frame randomness, no wall clock.

### 3.2 Surgical per-family decision (the lift-vs-impact table)

**DYNAMIC — strip baked shadow, add `castHeightM` (~33 sprites):**

| Family | Sprites | castHeightM | Why it's worth the lift |
|---|---|---|---|
| vegetation | tree-cedar, tree-cedar-b, tree-walnut, tree-walnut-b, tree-poplar, bush-scrub, boulder, rock-outcrop | 8 / 8 / 5 / 5 / 10 / 1.2 / 1.2 / 2.2 | Thousands of instances on the sun-shaded GL terrain — a forest with frozen NW shadows at 17:00 against east-raking terrain shadows is THE glaring giveaway |
| cop-buildings | all 10 `bld-*` | b-huts 2.6; toc 3.2; motorpool 2.0; tent 2.4; conex 2.6; latrine 2.2 | The COP is where the player lives; sweeping building shadows sell the day cycle |
| cop-defenses | guard-tower 6, ecp-gate 2.5, fighting-position 1.2, antenna-array 8, cop-flag 6, hesco-straight 1.2, hesco-corner 1.2, jersey-barrier 1.0, sandbag-wall 1.0 | — | Tower + flag are tall hero casters; HESCO/jersey fixes the rotation bug |
| village-compounds | qalat-small 3.5, qalat-medium 4, qalat-large 4.5, mosque 6, bazaar-stall 2.5, footbridge 1.5 | — | Qalat wall shadows crawling across courtyards through the day is pure Korengal aerial footage |
| aviation | helo-uh60 4, helo-ch47 5.5 | — | Parked-helo shadow at the LZ, 2 sprites, trivial |

**EXEMPT — keep as authored (no contradiction worth fixing):**
- **Rotating figures/vehicles (38 sprites: us/ana/acm/civ soldiers, animals, veh-*):** KEEP symmetric contact shadows. Confirmed decision. A 1.4 m man's directional shadow at ≤26 px (`FIG_CAP_PX`, draw.ts:51) is sub-noise; the ART_BIBLE rotation rationale (§1) still holds; zero work.
- **Flat/low statics:** lz-pad, terrace-field, crop-furrow, reeds, cemetery, concertina, windsock — flat tiles, wispy wire, or sub-meter clutter whose shadow direction is unreadable. Keep their (minimal) baked grounding.
- **All ink (~100 sprites):** map-markers, hud-cartography, ui-* families, fx-decals/particles — the "flat ink, NO drop shadow" rule is sacred and untouched.

### 3.3 SVG re-author cost, honestly

The strip is **annotation, not re-drawing**. In every static source the cast shadow is the first 1–3 painted elements (a blurred ellipse/path in the #1c160e/#160f08/#120c06 range, usually with a `<!-- cast shadow -->` comment — verified in tree-cedar.svg, guard-tower.svg). Work:

1. Wrap those elements in `<g data-cast-shadow="1">…</g>` across ~33 files. Semi-automated (script proposes the wrap on leading blurred dark elements; human eyeballs every diff). **Cost: 2–3 h including review.** Hazard: a missed element → double shadow; an over-greedy wrap → object loses a dark belly. Mitigation: regenerate `asset-bible.html` (`node scripts/build-asset-doc.mjs`) + per-family before/after screenshots; manifest builder **errors** if `castHeight` is set but no `data-cast-shadow` group was found (and vice versa).
2. `_meta.json`: add `castHeight` per the table. 30 min.
3. `build-asset-manifest.mjs`: strip `data-cast-shadow` groups from the emitted svg string; pass `castHeight` through to `AssetDef.castHeightM`. ~20 lines. Sources keep the shadow markup (regeneration stays idempotent; the bible can render both states).
4. `sprites.ts` + `sun.ts` + call-site plumbing: ~150 lines total.

Optional polish (NOT in the critical path): hand-authored shadow-profile SVGs for ≤3 sprites whose uniform-extrusion shadow loses a signature feature — `mosque` (minaret spike), `guard-tower` (legs + cab), `antenna-array` (lattice). Each is a one-shape black silhouette rasterized into `Baked.shadow` instead of the self-silhouette. ~1 h each; do them only if the uniform shadows disappoint on screenshot.

---

## 4. ART_BIBLE rewrite — what changes, what is sacred

**§1 LIGHTING — rewritten.** New contract text (the substance):
- *Surface* shading on static sprites: soft, low-contrast, with a **gentle NW form-light bias** (matching the ~30% fixed NW form light gl-core blends into terrain) + baked AO in crevices. Strong directional surface claims are out; "lit from NW, rim on NW edge" is demoted from hard rule to mild bias.
- *Cast shadows are runtime.* No grounded static sprite may bake a cast shadow; it MUST declare `castHeight` (m) in `_meta.json` instead. The renderer projects its silhouette along the live sun.
- Rotating sprites: unchanged — symmetric contact shadow, rotation-tolerant top shading, authored facing +x.
- New **§1b THE SUN**: documents `lib/render/sun.ts` as the single source of light truth, the world-axis conventions (+y south), the consistency invariant with `solarLight()`, the shadow alpha/weather damping, and the rule that no other module may hardcode a light direction.
- New **§1c THE GRADE**: the source-atop top-canvas pass + GL mix parity; sprites are authored to read correctly under the NEUTRAL noon grade (don't pre-warm art for sunset — the grade does it, and ±10% restraint prevents double-warming).

**§7 rule 2 — changed:** "a grounded object without a contact shadow is rejected" → "a grounded STATIC object without a `castHeight` declaration is rejected; a grounded ROTATING object without a symmetric contact shadow is rejected."

**§8 — reference assets re-cut** to the new contract (hesco-straight stripped; one hero qalat added as the worked example).

**SACRED — explicitly unchanged:** §3 palette + ±10% tint restraint (the locked dusty palette is the coherence backbone; the grade tints at runtime so art stays in-palette) · §5 LOD bands + crossfade windows + screen-fixed chrome (legibility law) · §4 line/finish incl. "no drop-shadow on flat symbols" · §2 anchors/footprints (extended with `castHeight`, nothing removed) · §6 family taxonomy · §7 rules 1, 3–7 (squint test, palette-only, clean geometry) · §9 combat FX vocabulary in its entirety (physical-vs-ink split already anticipates this design).

---

## 5. Decoration, villages, COP on the GL terrain — grade/fog coherence and the new draw order

**The float problem:** GL terrain will be sun-shaded, graded, and night-dimmed in-shader. Sprites on the top canvas keep daylight colors unless something tints them — today they literally do: the night wash (topo.ts:587-592) runs *inside* drawTerrain, BEFORE decoration/villages/COP, so trees and qalats render full-bright at night. Over the old uniformly-dark bake this passed; over a GL-graded terrain it reads as stickers.

**The mechanism: one `source-atop` fillRect.** On a transparent-backed canvas, `multiply`/`overlay` composites against transparent pixels produce opaque garbage that would occlude the GL terrain — but `source-atop` paints only where destination alpha > 0, preserving transparency exactly. So a single full-screen `fillRect` with `gradeFor()`'s rgba tints every sprite/stroke drawn so far and nothing else. Cost: one quad. This is the **dependency flag for the synthesizer**: the grade must exist in BOTH places — GL `mix()` for terrain, source-atop for sprites — both fed by `gradeFor()` in `lib/render/sun.ts`. Neither axis may invent its own curve.

**New top-canvas order** (current order at WorldView.tsx:222-605 annotated with changes):

```
GL canvas (under):  terrain + sun lighting + ridge shadows + GL-side grade  [gl-core]
2D canvas (over):
 1. drawMapInk(ctx, terrain, cam)        ← split from drawTerrain: contours (topo.ts:581) +
                                            path network (topo.ts:584), verbatim algorithms
 2. drawDecoration(ctx, terrain, cam, sun)   ← + sun shadows               (was :223)
 3. villages (qalat sprites get sun via drawWorldSprite)                   (was :274-336)
 4. projects ring                                                          (was :339)
 5. drawCop(ctx, cam, terrain, env{sun,...}) — structures only             (was :357)
 6. drawWeather(...)                     ← MOVED here from :229 so fog/precip occlude
                                            structures & trees (dawn fog pooling reads right)
 7. GRADE PASS: gco='source-atop'; fillRect(gradeFor(...))                 ← NEW (replaces
                                            the night wash topo.ts:587-592)
 8. drawCopNightLights(...)              ← split out of drawCop (draw.ts:667-718) so window
                                            glow/floods/beacons stay luminous ABOVE the dim
 9. drawSmoke, markers, units, orders, projectiles, effects, drawNightLights, HUD — as today,
    ABOVE the grade: units and ink stay full-legibility at night (tactical map law, and it
    matches today's behavior where units were never night-washed)
```

Items 2–5 are world dressing → graded and fogged. Item 9 is information → never dimmed. The only *behavioral* change players see: trees/qalats/COP structures now darken at night and warm at dusk (correct), while every unit, label, and order stays as readable as today.

**Terrain-aware valley fog pooling (ownership split, flagged):** any fog that should *occlude* sprites must live on the TOP canvas — GL fog under the sprite layer would have qalats poking through a fog bank. Proposal: gl-core keeps only surface haze (a tint, not an occluder); `drawWeather`'s existing deterministic fog blobs (topo.ts:640-761) gain a pooling weight `poolK = smoothstep(120, 0, elevAt(wx,wy) - floorElevNear)` multiplied into blob alpha, biased by dawn hours — fog hugs the river draw and thins on the spurs. Both layers read one exported `fogDensityAt(terrain, wx, wy, secondsOfDay, weather)` helper (proposed home: `lib/render/sun.ts` or a sibling `atmosphere.ts`). ~25 lines; reuses the existing blob field so determinism and the night damp (`nightK`) carry over.

**Decoration colors:** no per-sprite recolor needed — the grade pass covers tone; tree palettes already match the locked terrain palette (§3), which gl-core is bound to preserve. The noise-grain overlay (topo.ts:560-578) uses `overlay` composite and CANNOT move to the transparent top canvas — it must move into the GL shader or die (gl-core decision; flag it).

---

## 6. Hero asset upgrade list (15 sprites, 2–4× detail + baked AO, new soft-light contract)

Kunar references: Korengali architecture is stacked dry-stone first stories with timber lacing (cator-and-cribbage) and mud-plastered uppers, flat roofs used as work surfaces; US construction is plywood B-huts, HESCO bastions, sandbags everywhere (The Outpost; Restrepo stills).

| # | Sprite | What to add (and what NOT) |
|---|---|---|
| 1 | qalat-small | Stone coursing on wall tops, timber beam-ends punctuating the roof edge, rooftop clutter (firewood stack, charpoy, drying fruit), AO pooling in courtyard corners. Keep the mud palette — stone is grey-warm `#a49c8e` accents, not a repaint |
| 2 | qalat-medium | + interior life: shade awning (OD tarp `#6b6f4a`), livestock pen, roof-access stair block |
| 3 | qalat-large | + defensive corner tower (second story — the qalat's signature silhouette), varied roof heights via AO steps |
| 4 | mosque | Green-trimmed parapet (`#527038`-family within ±10%), minaret with loudspeaker horn, courtyard prayer-rug rows; candidate for the hand `mosque-shadowprofile` |
| 5 | bld-toc | Plywood + sandbag roof course (IDF protection), cable runs to the mast, AC box, AO under eaves |
| 6 | bld-barracks | B-hut: corrugated tin w/ ridge seams, sandbag rows on roof, stovepipe, plywood door |
| 7 | bld-aid | Same B-hut fidelity + roof red cross, litter stack at door |
| 8 | bld-bhut | The generic filler at matched fidelity (it appears most often) |
| 9 | guard-tower | Timber leg lattice, HESCO base course, sandbag cab w/ cam-net scrim, .50 barrel; candidate shadow-profile |
| 10 | hesco-straight | Wire-mesh diamond grid catching light, geotextile liner at the lip, gravel fill, dust streak at the ground seam — **the most-instanced sprite at the COP; biggest win per authoring hour** |
| 11 | hesco-corner | Match #10 exactly (they tile) |
| 12 | ecp-gate | Swing bar, guard shack with sandbag sill, "STOP/ISTAD" board, HESCO flanks |
| 13 | tree-cedar | The Korengal IS its deodars: layered branch whorls, a dead-spike-top variant lobe, root flare; deepen needle texture without breaking the §7 squint test |
| 14 | tree-walnut | Orchard walnut: broad crown with gap structure, whitewashed trunk base (Afghan orchard practice) — reads at close zoom as "tended," not wild |
| 15 | helo-uh60 | Rotor-blur disc, open cabin doors, tail number, exhaust staining — the MEDEVAC close-up |

Mechanics: viewBox 48→96/128; `baseResFor` (sprites.ts:56-61) gets a per-def `hero: true` bump (×1.5 raster res, capped 1024). All 15 are in the dynamic-shadow set, so they're authored shadow-free from the start. Batch 3–5 per commit, regenerate asset-bible + screenshot each batch. Honest cost: 30–60 min careful SVG authoring each → **8–15 h total**; phased, never blocking.

---

## 7. Loading screen / renderWarmPhases (store.ts:373-380)

Defensive design for either gl-core albedo choice, keeping the `DeployPhase[]` shape (store.ts:326-368 loop untouched):

```ts
function renderWarmPhases(getWorld: () => World): DeployPhase[] {
  return [
    // gl-core swaps this run() body behind one interface; label survives either way:
    //  - GPU-procedural albedo: init GL, compile shaders, upload heightmap (512² R32F or
    //    R16 split) + land/splat textures, then ONE offscreen warm-up render (forces shader
    //    compile/JIT — on SwiftShader this alone can be ~1s; report(1) after the readback fence)
    //  - CPU albedo bake retained: bakeAlbedoProgressive(report) then texture upload
    { id: "relief", label: "Surveying the relief — preparing the terrain",
      run: (report) => prepareTerrainGPU(getWorld().terrain, report) },
    // sprite rasterization + NEW: shadow-mask baking (~33 masks, blur+composite ≤256² each,
    // ~60–150 ms total) folded in with fractional report so the bar keeps moving
    { id: "assets", label: "Issuing kit — rasterizing the asset library",
      run: (report) => loadSprites(ASSETS, report) },
  ];
}
```

`loadSprites` gains an optional `report` and bakes shadow masks eagerly after rasterize (lazy-on-first-draw is the fallback if load time matters; masks are also rebuilt automatically if a hero re-raster replaces `b.canvas`). If terrain prep drops under ~300 ms the loading screen just flashes through the phase — `runDeploy` already paints each phase row, no API change needed. The `bakeTerrain` WeakMap and `drawTerrain` night param die with the blit (gl-core seam, listed in integration points so nobody leaves dead code).

---

## 8. Contours, paths, grid — confirmed: stay 2D, one split required

`drawContoursLive` + `drawPathsLive` are already live screen-space vectors (topo.ts:580-584) — **no algorithm change**. Required change: they're currently called from inside `drawTerrain`, which dies with the blit. Split into `drawMapInk(ctx, terrain, cam)` (contours + paths verbatim) called first on the top canvas (WorldView.tsx:222's slot). They sit UNDER the grade pass, so they dim at night exactly as the old wash dimmed them — contour ink will not glow at night. `drawGrid` (topo.ts:764) is unchanged. One follow-up check at implementation: contour stroke contrast against the GL terrain's noon palette (a single screenshot at 4 zoom levels; adjust stroke alpha ±0.05 if needed).

---

## 9. Phased implementation (game never broken between phases)

- **P0 — contract first:** ART_BIBLE §1/§1b/§1c/§7.2 rewrite + `lib/render/sun.ts` with unit-sanity probe (`scratch-sun-probe.ts`: elevation/azimuth at 05:00/06:15/12:15/18:30/19:30 vs the solarLight windows). Pure additions; nothing renders differently.
- **P1 — runtime shadows at the legacy angle:** SVG `data-cast-shadow` wraps + `castHeight` meta + manifest strip + shadow masks + `drawWorldSprite` shadow block + plumb `sun` through decoration/villages/drawCop — but feed a FIXED sun (az 315°, el 40° ≈ the old NW key). Screen output ≈ today's, so the strip QA is a pure screenshot-diff against baseline (`scripts/visual-matrix.mjs`), independent of everything GL. Fixes the rotated-HESCO shadow bug as a measurable delta. fps check: `scripts/shoot.mjs --fps` at tactical forest zoom, before/after.
- **P2 — (lands WITH the gl-core swap, same PR):** WorldView reorder per §5; `drawTerrain` → `drawMapInk` split; night wash deleted; grade pass added; `drawCopNightLights` split; sprite sun switched from fixed to `sunState(world.secondsOfDay, weatherMult)`; `renderWarmPhases` rework. Until this PR, P1's fixed-sun shadows over the old baked terrain are self-consistent — the game is never half-lit.
- **P3 — fog pooling:** `fogDensityAt` + drawWeather pooling weight. Independent, additive.
- **P4 — heroes:** 15 sprites in 4 batches, each batch = author → manifest regen → asset-bible regen → screenshot pair → commit.
- **P5 — optional shadow profiles** (mosque/tower/antenna) only if P2 screenshots disappoint.

Verification per phase: tsc/build/smoke green; screenshot matrix at 06:00 / 12:00 / 17:30 / 22:00 × {strategic, operational, tactical, close} archived in `docs/progress/`; fps before/after at the dense-forest worst case.

## Key decisions
- **Strip baked cast shadows from ~33 static world sprites and draw a runtime projected self-silhouette shadow (pre-baked half-res blurred tint of the sprite's own raster, slid/stretched along the sun axis); keep symmetric contact shadows on all rotating figures/vehicles; leave all flat ink untouched.**
  - rejected: (a) Keep baked shadows everywhere and accept the dawn/dusk contradiction — rejected: thousands of tree shadows frozen NW against an east-raking GL terrain at 17:00 is the single loudest tell that the scene is fake, and the rotated HESCO/ECP segments already break the baked contract today (draw.ts:404,445). (b) Author 4-8 directional shadow variants per sprite — rejected: 33 sprites × N angles of hand art for what one transform does. (c) Dynamic shadows for soldiers too — rejected per ART_BIBLE rotation rationale and because a 1.4 m man's shadow at ≤26 px is sub-noise.
  - why: The silhouette projection is ~60 lines, costs one extra drawImage per instance, needs zero new art for the long tail, automatically handles rotated statics, and concentrates hand-authoring budget on the 15 heroes where it shows.
- **Shadows draw interleaved (immediately under each sprite inside drawWorldSprite), not as a separate全-shadow pass.**
  - rejected: Two-pass (all shadows then all sprites) — cleaner in dense forest but requires restructuring drawCop and every call site; per-sun-bucket composite atlases (shadow+sprite pre-merged per 5° sun bucket) — zero per-frame cost but breaks on rotated sprites (HESCO ring) and adds cache complexity.
  - why: Interleaved matches exactly what today's baked shadows do under painter's y-sort (the accepted look), is a one-point change, and decoration.ts already collects items[] so lifting to two-pass later is a 6-line escape hatch if forest screenshots look dirty.
- **Static sprite SURFACE shading stays baked with a softened NW form-light bias + AO; only CAST shadows become dynamic.**
  - rejected: Fully dynamic surface lighting via normal-mapped sprites in GL — rejected as a different (much larger) architecture; fully flattening surface shading to ambient-only — rejected because silhouettes lose volume at the §7 squint test.
  - why: Flat rasters can't be relit; cast shadows carry ~90% of the time-of-day read. Pairing the sprites' residual NW bias with the ~30% fixed NW form light gl-core should blend into terrain (also the relief-inversion fix) makes the residual bias a shared, coherent convention rather than a contradiction.
- **Time-of-day grade and night dim reach sprites via ONE full-screen 'source-atop' fillRect on the top canvas, fed by the same gradeFor() function gl-core receives as mix() uniforms; world dressing (decoration/villages/COP structures) draws under it, units/ink/FX above it.**
  - rejected: multiply/overlay composite on the top canvas — WRONG: against transparent pixels it produces opaque fill that occludes the GL terrain. CSS filter on the canvas element — imprecise, can't match the GL curve, dpr-fragile. Per-sprite tinting — N offscreen composites per frame. Grading units too — rejected: legibility is law and today's units were never night-washed.
  - why: source-atop is the only canvas composite that tints existing pixels while preserving transparency; one quad, exact parity achievable by mandating GL use the identical alpha-mix form.
- **One shared sun module lib/render/sun.ts (lat 34.8°N, fixed +15° declination, solar noon 12:15) is the single source of light truth for both canvases; sprite shadows, terrain lighting, grade, and fog all derive from it.**
  - rejected: Letting each axis model its own sun — guaranteed drift (sprite shadows pointing differently than ridge shadows is worse than no shadows); a full seasonal ephemeris — over-engineering for a fixed-season campaign.
  - why: Hand-verified against the sacred gameplay curve: sun crosses the horizon ~05:30/~19:05, below horizon whenever solarLight is at starlight; az 78° at 06:15 (shadows WSW), 180° at noon (shadows N, short), 282° at 18:30 — physically right for Kunar in fighting season and consistent with solarLight()'s 05-07/17-19.5 ramps without touching lib/sim.
- **Occluding valley fog lives on the TOP canvas (drawWeather upgraded with a terrain-aware pooling weight); gl-core keeps only non-occluding surface haze.**
  - rejected: GL fog under the sprite layer — qalats and trees poke through fog banks, instantly fake; a third GL canvas above the 2D one — architecture cost far beyond the payoff.
  - why: Fog must hide trees and structures to read as fog; drawWeather's deterministic blob field already exists, already damps at night, and needs only a ~25-line elevation-pooling multiplier.
- **Shadow markup stays in SVG sources wrapped in <g data-cast-shadow>, stripped at manifest build time, with castHeight in _meta.json validated against the wrap.**
  - rejected: Deleting shadow elements from sources — loses the audit trail and asset-bible comparability; runtime DOM-parsing strip — slow and fragile at boot.
  - why: Sources remain the single edited artifact per the generated-files invariant; the build step is 20 lines; the cross-validation (castHeight ⟺ data-cast-shadow) turns the two failure modes (double shadow / missing shadow) into build errors.

## Integration points
- lib/render/sun.ts (new) — sunState(secondsOfDay, weatherLightMult) + gradeFor(...) + fogDensityAt(...) — single source of light truth for both canvases; gl-core consumes as uniforms, never re-derives
- lib/render/sprites.ts:17-26 — AssetDef gains castHeightM?: number (from _meta.json castHeight via the manifest builder)
- lib/render/sprites.ts:28-35 and :112-140 — Baked gains lazy shadow canvas (half-res blurred source-in tint, baked once); drawWorldSprite gains opts.sun?: SunState and draws the projected silhouette (rotate→slide len·0.5→stretch→unrotate→opts.rot) under the sprite blit
- scripts/build-asset-manifest.mjs — strip <g data-cast-shadow> groups from emitted svg; emit castHeightM; error if castHeight and data-cast-shadow disagree (one without the other)
- docs/visual-overhaul/assets/_meta.json + ~33 SVG sources — castHeight per the §3.2 table; wrap existing cast-shadow elements (first 1-3 painted elements, verified pattern) in <g data-cast-shadow="1">; regenerate manifest + asset-bible
- lib/render/topo.ts:552-593 — split drawTerrain: blit (:553-558) and noise-grain overlay (:560-578) move to GL or die (gl-core); contours+paths (:580-584) become exported drawMapInk(ctx,terrain,cam) verbatim; night wash (:587-592) DELETED — replaced by the WorldView grade pass
- components/world/WorldView.tsx:220-237 — compute const sun = sunState(w.secondsOfDay, weatherMult) and grade = gradeFor(...) once per frame; replace drawTerrain call (:222) with drawMapInk; pass sun into drawDecoration (:223); MOVE drawWeather (:229) to after drawCop
- components/world/WorldView.tsx:289-294 — village qalat drawWorldSprite calls gain { sun } (castHeightM comes from the def)
- components/world/WorldView.tsx:357 — drawCop env gains sun; immediately after the (moved) drawWeather: the grade pass — ctx.globalCompositeOperation='source-atop'; fillRect(grade) — then drawCopNightLights(...)
- lib/render/draw.ts:363-369 — CopEnv gains sun: SunState; all static drawWorldSprite calls inside drawCop (hesco :404, ecp :445, jersey :469, buildings :497, towers :558, antenna :610, flag :663) pass it through
- lib/render/draw.ts:667-718 — night life-signs block split into exported drawCopNightLights(ctx, cam, terrain, env) called AFTER the grade pass so additive glows aren't dimmed
- lib/render/decoration.ts:73-128 — drawDecoration gains sun param, forwards into drawWorldSprite for items and terrain.coverObjects; items[] collection kept so a two-pass shadow variant is a 6-line escape hatch
- state/store.ts:373-380 — renderWarmPhases: 'relief' phase run() swapped to gl-core's prepareTerrainGPU(terrain, report) behind one interface (incl. an offscreen warm-up render for SwiftShader shader compile); 'assets' phase loadSprites(ASSETS, report) also bakes the ~33 shadow masks with fractional report
- lib/render/topo.ts:640-761 (drawWeather) — fog blob alpha multiplied by pooling weight from fogDensityAt (elevation above local floor, dawn-biased); deterministic blob field and nightK damp preserved
- docs/visual-overhaul/ART_BIBLE.md §1, §7.2, §8 + new §1b/§1c — lighting contract rewrite per design §4; palette/LOD/ink/FX sections explicitly marked unchanged

## Risks
- [medium] Missed or over-greedy shadow strips across ~33 hand-edited SVGs → double shadows or hollowed-out art → Phase P1 renders at the FIXED legacy NW angle so output should match baseline pixel-for-pixel minus shadow softness — pure screenshot-diff QA via visual-matrix; manifest builder errors on castHeight⟺data-cast-shadow mismatch; asset-bible regen per batch
- [medium] FPS regression at tactical forest zoom: up to +1800 shadow drawImages/frame at the decoration CAP → Shadows gate on shadowAlpha>0.01 (off all night and under fog/heavy overcast) and on decoration's own lodAlpha; measure shoot.mjs --fps before/after in P1; fallback knobs ready: shadow cap (first N y-sorted items) or per-sun-bucket composite for the vegetation family only (non-rotated, jitter ±14° acceptable)
- [medium] Grade divergence between GL mix() and 2D source-atop at extreme dusk → sprites visibly float off the terrain → Single gradeFor() source; binding parity rule that GL uses the identical alpha-mix form (not multiply); calibration screenshots at 06:00/12:00/17:30/22:00 on both canvases archived in docs/progress before sign-off
- [medium] Relief inversion at noon (real sun due south on a north-up map) makes valleys read as ridges — a gl-core term, but it would make my correct sprite shadows sit on inverted-looking relief → Flagged to synthesizer with the concrete fix: blend ~25-35% fixed NW form light into the GL diffuse; sprite surface shading keeps the matching soft NW bias so the residual convention is shared
- [low] Night-dimming villages/COP structures (new behavior — today they render full-bright at night) regresses map legibility → Units, name labels, pins, orders, and all FX stay ABOVE the grade pass exactly as today; only world dressing dims; COP life-sign glows re-drawn after the pass; one night screenshot review gate
- [low] Uniform-extrusion silhouette shadows lose signature features (minaret, tower legs) and read as blobs → Accept for the long tail; optional hand shadow-profile SVGs for mosque/guard-tower/antenna-array (P5, ~1 h each) only if P2 screenshots disappoint
- [low] Headless harness (SwiftShader, --disable-gpu) behaves differently on bake-time ctx.filter blur or slows under the extra draws → Blur is bake-time only (~33 small canvases, never per-frame); Chromium implements 2D filters CPU-side; harness needs correctness not 60fps; visual-matrix --webgl flag already exists for the GL path

## Perf budget
Per-frame GPU/CPU (top 2D canvas, integrated GPU): +1 small drawImage per shadow-casting instance. Typical views (COP or village, ~100-300 static sprites on screen): +0.3-0.9 ms. Worst case (close-zoom dense forest at the existing decoration CAP of 1800): +1800 textured-quad blits ≈ +2-4 ms on a GPU-accelerated canvas — today's frame is ~8.6 ms (116 fps via shoot.mjs --fps), so worst case lands ~11-13 ms ≈ 75-90 fps, and that view is rare; shadows are also fully OFF at night (~35-40% of clock time) and under fog/heavy overcast via shadowAlpha=0. Grade pass: one full-screen source-atop fillRect ≈ <0.3 ms. sunState/gradeFor: trivial trig, once per frame. Texture/canvas memory: shadow masks ~33 sprites at half base res (128-256 px) ≈ 4-5 MB; hero re-rasters at bumped res ≈ +8-10 MB sprite atlas; total +~15 MB against the existing 67 MB 4096² terrain bake (which this overhaul likely retires in CPU form) — net memory roughly flat or down. Load time: shadow-mask baking +60-150 ms folded into the existing assets phase with progress reporting; if gl-core goes GPU-procedural for albedo, the 2-3 s relief bake collapses to GL init + 512² heightmap upload + one warm-up render, so total deploy time goes DOWN. Escape hatches if the forest worst case measures hot: per-frame shadow cap on y-sorted items, or pre-composited shadow+sprite atlases per 5° sun bucket for the (non-rotated) vegetation family, which returns per-frame cost to exactly today's one blit per item. All numbers to be re-measured at P1 with shoot.mjs --fps before/after as the gate.

## Open questions
- Which axis owns lib/render/sun.ts in the synthesized plan? This design assumes the TS module is the single source and GL receives uniforms computed CPU-side per frame (no GLSL re-derivation) — synthesizer must dedupe if gl-core proposed its own model, and the gameplay-consistency constants (solar noon 12:15, decl +15°) must survive the merge.
- Does gl-core keep a CPU albedo bake (loading phase stays seconds) or go GPU-procedural (phase collapses to <1 s)? renderWarmPhases here is designed for either behind prepareTerrainGPU(terrain, report), but the 'relief' phase label/reporting granularity should match the chosen path.
- Will gl-core blend the recommended ~25-35% fixed NW form light into terrain diffuse (relief-inversion fix)? If not, the sprite surface-shading contract should drop its residual NW bias too (flatter ambient+AO) to avoid a one-sided convention.
- Where does the noon-grade neutral point sit exactly? Sprites are authored to read correctly at zero grade; if gl-core's terrain look needs a nonzero midday tint, the sprite source-atop pass must mirror it (shared gradeFor handles this, but the art QA baseline screenshots should be taken at whatever 'neutral' the merged design picks.
- Fog pooling occlusion of VILLAGE STRUCTURES vs the village name labels/pins: labels currently draw in the same village block (WorldView.tsx:324-335); design keeps labels above the grade+fog — confirm the synthesizer keeps label draws out of the fogged band when the village loop is split.
- Should sprite shadows also respect GL ridge shadows (a tree inside a mountain's cast shadow shouldn't cast its own)? Correct answer is yes via sampling a coarse CPU shadow-factor grid from sunState ray-march, but it's a cross-canvas data dependency — proposed as a post-P2 polish question, not in scope here.
