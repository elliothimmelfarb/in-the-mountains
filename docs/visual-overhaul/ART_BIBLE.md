# In the Mountains — Art Direction Bible (Map Visual Overhaul)

> This is the **coherence contract**. Every asset, in every family, obeys it. If two
> assets disagree on light, palette, projection, or scale, they will look pasted-together
> on the map and the whole effect collapses. Read this fully before authoring anything.

The target: a player looks at this map and assumes a **40-person studio** built it. The
touchstones are the operational map art of *WARNO / Wargame*, the hand-painted relief of
*Unity of Command II*, the lived-in tactical board of *Radio Commander / Foxhole*, and a
real, used **1:25,000 military map sheet** — authoritative, weathered, hand-annotated, but
crisp and modern.

---

## 0. The world we're dressing

- Korengal-like Afghan valley, **2011**, US platoon at a remote COP (combat outpost).
- Map is **top-down**, rendered to a `<canvas>`. World is 512×512 cells × 5 m = **2.56 km** square.
- Terrain is a baked shaded-relief bitmap (warm field-guide palette). Assets are drawn **over** it.
- Camera zoom is **`ppm`** (pixels-per-meter), range **0.18 → 8**. A soldier ≈ 1.2 m; a B-hut ≈ 6×8 m.

---

## 1. LIGHTING — the one rule that makes it cohere

> **AMENDMENT (2026-06-13, WebGL terrain rebuild).** The TERRAIN is no longer lit by a fixed
> NW key — it's lit per-pixel by the **live master-clock sun** on the WebGL underlayer
> (`lib/render/sky.ts` + `lib/render/gl/`): the key direction sweeps E→S→W through the day,
> casts real ridge shadows, goes moonlit-cool at night, and carries a time-of-day grade. The
> sun's evening azimuth is WNW, so the dynamic key **converges on the baked NW sprite key at
> golden hour** (the static sprite art is "perpetual golden hour"). Static sprites STILL bake
> the NW key + SE contact shadow below (a deliberate, documented residual — the mismatch is
> worst at morning when sprite shadows are sub-8px); tall structures additionally get a
> renderer-drawn sun-tracked CAST shadow (`drawSunShadow`) that sweeps with the terrain. When
> authoring NEW terrain-baked detail, author it UNLIT (the shader lights it); sprites keep the
> rule below.

**Single key light from the NW (upper-left). Soft fill from the SE. Shadows fall to the SE (lower-right).**

This matched the OLD terrain hillshade exactly (`key = norm3(-0.55,-0.62,0.56)`) and still governs the static sprite library, so sprites sit *in* the relief at golden hour.

- **Lit faces / crests:** upper-left edges. Add a bright rim/highlight on the NW side.
- **Shadowed faces:** lower-right edges, darker, cooler.
- **Cast shadow:** every grounded object drops a soft shadow offset toward **SE** (down-right),
  color `#1c160e` at **28–38% opacity**, blurred. Authored INTO the SVG as an ellipse/shape under the object on a `<g opacity>` with a blur filter. Shadow length ≈ 0.4–0.6× object height; soft, not hard.
- **Top-down volume cue ("2.5D"):** objects show their **roof/top plus a thin sliver of the NW-lit wall and a thinner SE-shadow wall** — just enough bevel to read as having height. NOT full isometric. Think "ortho top-down with a 10–15° tilt hint."
- Soldiers/figures are pure top-down (you see helmet + shoulders + weapon), grounded by a small soft contact shadow.

**CRITICAL — static vs. rotating sprites:**
- **Static / world-fixed** objects (buildings, HESCO, towers, trees, rocks, qalats, markers, the flag) are drawn at a fixed orientation → bake the **full NW directional light + SE cast shadow**. These never rotate.
- **Rotating** objects (soldiers, vehicles — they spin to face their heading) must use a **radially-symmetric soft contact shadow** (a centered blurred ellipse) and **rotation-tolerant top shading** (a gentle centered/forward top highlight), because a baked directional shadow would rotate with the sprite and break the scene's lighting. Author rotating sprites **facing +x (east, pointing right)**; the renderer rotates them. Their read comes from silhouette + faction accent, not from a hard cast shadow.

Concretely, use these SVG building blocks:
```xml
<!-- soft cast shadow (place FIRST, under the object) -->
<filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.1"/></filter>
<ellipse cx="ANCHOR_X+1.4" cy="ANCHOR_Y+1.2" rx="..." ry="..." fill="#1c160e" opacity="0.32" filter="url(#soft)"/>
<!-- NW rim light on a lit edge -->
<path d="..." stroke="#fbf4dc" stroke-opacity="0.5" stroke-width="0.6" fill="none"/>
```

---

## 2. PROJECTION, ANCHORS & SCALE

- **viewBox:** author every asset in its own `viewBox="0 0 W H"` in **abstract units that map to the documented footprint**. Keep numbers clean (e.g. a 64×64 box).
- **Anchor:** the world point the sprite pins to.
  - *Grounded objects* (soldiers, buildings, vehicles, towers, trees, markers-on-ground): anchor = **bottom-center** of the object's footprint so its shadow grounds it.
  - *Flat map symbols / canopies / pads* (NATO symbols, LZ pad, field tiles): anchor = **center**.
  - State the anchor as a fraction of the viewBox in your return (e.g. `anchor:[0.5, 0.86]`).
- **Footprint (meters):** state the object's real-world size so the renderer scales sprite→world.
  Reference sizes (use these, don't invent): soldier **1.4 m**, B-hut **7×9 m**, TOC **10×10 m**,
  HESCO segment **1.5 m run × 1.0 m thick**, guard tower **3 m**, MRAP **6 m**, HMMWV **5 m**,
  UH-60 **16 m**, cedar canopy **7 m**, walnut/orchard tree **5 m**, scrub bush **2.5 m**, boulder **2 m**,
  qalat (small) **18 m**, mosque **12 m**, village banner pin **screen-fixed**.

---

## 3. PALETTE — locked. Do not introduce new hues; tint within these.

**Map terrain (for blending edges into):** cropland `#8a984e` · terrace `#7c8e4c` · orchard `#527038`
· forest `#324c30` · meadow/grass `#8e925c` · scrub `#847a4e` · scree `#9c927e` · rock `#a49c8e`
· cliff `#76685e` · river `#40687a` · dry wash `#92866 8`→`#928668` · road `#7a6e5c` · trail `#8c7e64`.

**Built materials:**
- HESCO gabion `#a89668` (basket), fill gravel `#9c8d63`, top sandbag course `#b3a06f`.
- Mud / qalat wall `#a6865e`, deep mud `#8c6a46`, earth roof `#9a8460`.
- Corrugated metal roof `#857a5c` (lit) / `#6c6347` (shade), rust streak `#8a5a36`.
- Tarp/canvas `#b3a785`, OD tarp `#6b6f4a`. Sandbag `#b0a172`. Conex (shipping container) `#5e6b52` or `#8a6a3c`.
- Concrete / Jersey barrier `#9a978c`. Gravel pad `#867c6a`. Timber `#7a5a38`.

**UI / markers / chrome (the milspec ink layer):** bg `#0c0d0a` · panel `#14160f` · line `#2c3022`
· ink `#d8d6c4` · ink-dim `#9a9a82` · olive `#6b7a3a` · tan `#c2a878` · amber `#e0a72b` (selection/active)
· rust `#b5532a` · blood `#9c2c20`.

**Factions:** US `#4a86c6` (hi `#6ea8e0`, dark `#2f5f93`) · ANA `#6fae9f` (teal-green) ·
insurgent `#c0392b` (dark `#8a2d22`) · civilian `#d8b94a` · good/positive `#6fae54`.

**Highlight & shadow universal:** rim light `#fbf4dc`, deep shadow `#1c160e`.

Everything is slightly **desaturated and warm** — this is dust country. Avoid pure saturated
primaries except the faction accent colors (which are *accents*, not whole-fills).

---

## 4. LINE & FINISH LANGUAGE

- **Edges:** prefer a 1–2px **dark keyline** (`#1c160e` at 50–70%) only where an object meets the map,
  to pop it off the relief — like an inked map annotation. Internal detail uses softer lines.
- **Texture:** suggest material with a *few* deliberate strokes (corrugation ridges, gabion cells,
  sandbag rows, tree-canopy lobes), NOT noise. Restraint reads as craft; clutter reads as amateur.
- **Gradients:** use linear/radial gradients to model the NW→SE light falloff on roofs, canopies,
  vehicle bodies. One or two stops is plenty.
- **Weathering:** a touch — a rust streak, a scuff, a worn path — never grime for its own sake.
- **No drop-shadow on flat symbols** (NATO symbols, compass) — those are "ink," they're crisp & flat.
  Drop-shadows are ONLY for physical 3D-ish objects.

---

## 5. LOD POLICY — "beautiful at every zoom" = crossfading representations

Each on-map thing declares behavior across four `ppm` bands. The renderer crossfades adjacent
bands over a small ppm window (no popping).

| Band | ppm | Read | Units | COP | Villages | Terrain |
|---|---|---|---|---|---|---|
| **Strategic** | ≤0.35 | map sheet | refined NATO mil-symbols (rect/diamond/dot) | one fortified-base icon + flag | banner pin + name | relief + contours only |
| **Operational** | 0.35–1.2 | recon photo | tiny figure clusters OR enriched symbols | building footprints w/ roofs, HESCO ring, towers | qalat footprint (walls + a few roofs) + banner | relief + sparse decoration |
| **Tactical** | 1.2–3 | diorama | full soldier sprites (facing/role/faction/stance) | full building sprites, sandbag positions, flag, vehicles, helo | full compound w/ courtyard, mosque, cemetery | relief + decoration fading in |
| **Close** | >3 | hero | sprite + kit + weapon + shadow + nameplate | roof material, doorways, antennas, conex, props | per-building detail, animals, market | dense trees/rocks/furrows/ripples |

**Crossfades (author each representation so it's valid alone):** symbol α fades 1→0 over ppm
0.30→0.50 while sprite α fades 0→1; decoration layer fades in 0.8→1.7. Selection rings, health
bars, compass, scale bar, and strategic symbols are **screen-fixed size** (don't scale with ppm).
World objects scale with ppm but clamp to sane min/max px.

---

## 6. THE TWELVE ASSET FAMILIES (authoring scope)

Each family is authored as a set of named SVGs. IDs are canonical — the renderer and docs key on them.

1. **cop-buildings** — top-down 2.5D building sprites: `bld-toc` (command, antennas), `bld-barracks` (B-hut, metal roof), `bld-dfac` (chow, big tent/hardstand), `bld-aid` (red-cross marked), `bld-armory` (conex/bunkered), `bld-motorpool` (open hardstand + bays), `bld-latrine` (small), plus generic `bld-bhut`, `bld-conex`, `bld-tent`.
2. **cop-defenses** — `hesco-straight`, `hesco-corner` (gabion segments, gravel fill, sandbag top), `ecp-gate` (vehicle gate + serpentine + guard shack), `guard-tower` (timber/steel, sandbag cab, .50 cal), `fighting-position` (sandbag horseshoe + crew weapon), `concertina` (coiled wire run), `jersey-barrier`, `cop-flag` (US flag on pole, casting shadow), `antenna-array`.
3. **aviation-vehicles** — `helo-uh60` (Blackhawk top-down, rotor disc), `helo-ch47` (Chinook, tandem rotor), `lz-pad` (graded pad + H + windsock), `veh-mri`→`veh-mrap` (MRAP/MATV), `veh-hmmwv` (with turret), `veh-pickup` (ANA/insurgent technical), `veh-jingle-truck` (civilian, colorful).
4. **us-soldiers** — top-down US infantry per role, facing +x by default, faction-blue accent: `sol-us-rifleman`, `sol-us-squadleader`, `sol-us-saw` (long barrel+bipod), `sol-us-grenadier` (M203), `sol-us-medic` (cross), `sol-us-rto` (antenna), `sol-us-marksman`, `sol-us-sniper` (long rifle, prone variant), `sol-us-jtac`, `sol-us-engineer`, `sol-us-machinegunner`. Include a **prone** and **down/casualty** variant convention.
5. **ana-soldiers** — ANA (Afghan army) infantry, teal-green accent, lighter kit, distinct helmet/cap: `sol-ana-rifleman`, `sol-ana-leader`, `sol-ana-mg`, `sol-ana-rpg`, plus `sol-interpreter` (civilian-dress + US tag).
6. **insurgents** — fighters, earth-tone/man-dress silhouettes, red hostile accent, NO helmet (pakol/turban/bare): `acm-fighter`, `acm-rpg` (RPG tube), `acm-mg` (PKM), `acm-marksman` (SVD), `acm-spotter` (optics/ICOM), `acm-ied` (kneeling, emplacing), `acm-commander`. Plus a **ghost/suspected** variant treatment (semi-transparent, dashed).
7. **civilians** — `civ-farmer`, `civ-herder` (+ goats), `civ-elder` (white-bearded, staff), `civ-child`, `civ-woman` (where appropriate/respectful), `civ-villager`, plus `goat`, `donkey`, `chicken` props.
8. **village-compounds** — `qalat-small`, `qalat-medium`, `qalat-large` (mud-walled courtyards + flat-roof buildings), `mosque` (with minaret shadow + green trim), `cemetery` (rows of stone markers + prayer flags), `bazaar-stall`, `terrace-field` (stepped retaining walls + crop tint), `footbridge`.
9. **vegetation** — decoration sprites for the high-zoom layer: `tree-cedar` (dark conifer canopy), `tree-walnut` (round orchard canopy), `tree-poplar` (tall thin), `bush-scrub` (holly-oak clump), `boulder`, `rock-outcrop`, `reeds` (riverbank), `crop-furrow` (tileable). Top-down canopies with NW-lit crescent + SE shadow.
10. **map-markers** — `pin-village` (banner pin, attitude-tinted variants good/neutral/hostile), `marker-intel-sigint` (antenna burst), `marker-intel-humint` (informant), `marker-intel-visual` (eye/binos), `flag-objective` / `flag-waypoint` (numbered), `marker-peak`/`saddle`/`spur`/`draw`/`junction`/`bridge` (named-feature glyphs), `cop-pin` (fortified base icon), `medevac-marker`, `ied-marker`, `contact-marker` (TIC starburst).
11. **hud-cartography** — `compass-rose` (north arrow, milspec), `scale-bar`, `legend-frame`, `grid-tick`, `map-vignette`/`edge-frame` (subtle sheet border), `coordinate-tab`. These render in screen space.
12. **ui-iconography** — crisp flat icons for the chrome (no drop-shadow): order tools `ico-select/move/assault/hold/suppress/smoke/frag/withdraw`; missions `ico-presence/recon/ambush/census/cordon/overwatch`; fire support `ico-mortar/cas-gun/cas-hellfire/medevac`; roles `ico-role-*` (PL/SL/RFL/SAW/MG/GRN/DM/SNP/DOC/RTO/FO/ENG); CERP `ico-cerp-well/clinic/school/road/bridge/generator/wall/mosque`; logistics `ico-ammo/fuel/water/food/medical/construction`; faction crests `crest-us`/`crest-ana`/`crest-acm`; status `ico-ready/wounded/kia/tasked`; weather `ico-clear/cloud/rain/dust/snow`.

---

## 7. AUTHORING RULES (hard requirements — assets are rejected otherwise)

1. **Valid, self-contained SVG.** Single root `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">…`. No external refs, no `<image>`, no scripts. `<defs>` IDs must be **unique per asset** (prefix with the asset id, e.g. `id="solUsRifleman-grad"`), because many SVGs get rasterized in one document — colliding IDs cross-contaminate.
2. **Lit from the NW**, shadow to the SE, per §1. A grounded object without a contact shadow is rejected.
3. **Only palette colors** (§3), tinted within ±10% lightness. No pure `#000`/`#fff` fills (use `#1c160e`/`#f3ecd6`).
4. **Reads at small size.** Squint test: the silhouette must be recognizable at ~24 px. Detail is a bonus on top of a strong silhouette, never a substitute.
5. **Faction legibility:** the faction accent must be unmistakable at a glance (US blue, ANA teal, ACM red, civ amber) — but as an accent (armband/patch/tint), the body stays earthy/realistic.
6. **Clean geometry:** no stray points, closed paths, sensible coordinates inside the viewBox. Prefer
   `<path>` with relative commands and `<g>` grouping over hundreds of tiny elements.
7. **Document the anchor + footprint** in your return so the renderer places it correctly.

---

## 8. REFERENCE ASSET (the bar to clear)

See `docs/visual-overhaul/reference/sol-us-rifleman.svg` and `hesco-straight.svg` for worked examples
that demonstrate the exact lighting, shadow filter, palette, keyline, and anchor conventions. Match
that level of craft and restraint. When in doubt, do *less, but more deliberately*.

---

## 9. COMBAT FX — the combat visual language

> A firefight should read like a **milspec map coming alive in dust** — never a fireworks show.
> The whole combat layer speaks ONE small, consistent vocabulary so a player learns it once and
> never needs a legend. Lives in `lib/render/combat-fx.ts` (the dynamic cues) and the upgraded
> effect cases in `draw.ts`. Reference plates: `docs/progress/2026-06-04-combat-visual/fx-legend.png`
> + `fx-explosions.png`.

**The one rule that splits everything:**
- **Physical things** (muzzle flash, the round arcing in, the detonation, dust, blood, the lobbed
  grenade) are **world-scaled** and obey §1's NW-light rules.
- **Informational marks** (the threat-bearing crescent, the indirect reticle, the pinned ring, the
  bleed pool, the danger-close hazard ring) are **flat ink — NO drop shadow**, screen-weighted,
  drawn *over* the unit. They're annotations, not objects.

**The vocabulary (each cue = one fact, no second way to say the same thing):**

| Cue | Reads as | Drive (sim field) | Color |
|---|---|---|---|
| **Dashed ground ring** (+ converging telegraph + ETA count) | indirect/CAS is landing HERE, in N seconds | `FireMission.target/spread/etaS/faction/status` | rust enemy · amber friendly |
| **Amber / deep-shadow hazard bars** (+ halo on at-risk men) | our fires are danger-close over our own men | `FireMission.dangerClose` | amber `#e0a72b` + shadow `#1c160e` |
| **Rust crescent** hugging a soldier's ring | fire is coming from THAT bearing | `Unit.threatDir` + `suppression` (smoothed) | rust `#b5532a` |
| **Closed, slow-pulsing rust ring** | that man is PINNED (composure broken) | `suppression>0.55 && composure<0.4` | rust |
| **Lobbed round + ground shadow** arcing to an airburst | a grenade is in the air | indirect `Projectile` (`age/(age+timeToImpact)` = exact progress) | warm tan |
| **Layered blast**: flash → dirty fireball → tan dust dome → smoke rim | ground HE (mortar/IED/RPG) detonated, this big | `Effect.kind="blast"`, `size`=radius/8 | flash `#fff2d6` · fireball `#c97036` · dust `#9c8d63` |
| **Tight bright ring**, little dust | airburst (thrown frag / GL) | `Effect.kind="frag_air"` | `#ffd696` |
| **Tan dust puff + spall flecks** | a round struck the dirt | `Effect.kind="impact"` | dust `#9c8d63` |
| **Dark-red pool** (grows, capped) + slow pulse | arterial bleed — evac NOW (deeper red = TQ-now) | `Unit.bleedRate/bleedTQable` | blood `#9c2c20` / `#7a1f18` |
| **Teal tether** treater→casualty | buddy-aid (CLS) in progress | `brainState="treating"` + `targetId` | teal `#6fae9f` |

**Restraint is the craft (hard rules):**
- Pulses are a **slow breath (~0.6–0.8 Hz)**, never a heartbeat strobe; nothing flickers.
- Blood pools, spall flecks, and bursts are **capped and debounced** — a long fight must never paint
  lakes or machine-gun bursts. Spall/blood fleck angles are **deterministic from `Effect.id`** so they
  don't crawl frame-to-frame.
- The blast **fireball is pulled warm & DIRTY into the dust palette** (`#c97036`) — never the old hot
  `rgba(255,180,80)` orange (the one off-palette color that used to ship).
- LOD: the dynamic cues gate **off below ~0.6 ppm** (the strategic sheet stays clean) and only ever
  appear on units actually in contact (`suppression>0.08`, `bleedRate>0.4`).
- **Lane discipline:** combat FX are map-space flashes/rings/pools only — doctrine banners, base-of-fire
  arcs, maneuver arrows, civGuard rings and net chatter belong to the squad-command layer, not here.

**New asset families (for the static sprites that complement the procedural cues):**
- **fx-particles** — rotation-tolerant physical puffs/glows (`fx-dust-puff`, `fx-glow-tracer`): soft
  contact treatment, no directional shadow.
- **fx-decals** — flat ground STAINS (`fx-blast-scorch`, `fx-bleed-pool`): never a lit object, so NO
  shadow; the IED scorch variant is larger/dirtier than the mortar one.
- Plus `sol-us-casualty` (a prone down-figure, rotating → symmetric contact shadow) and
  `ico-status-bleeding` (flat UI glyph).
