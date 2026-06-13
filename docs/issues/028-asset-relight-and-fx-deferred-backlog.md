# 028 · Asset relight + FX particles — the deferred backlog (WebGL terrain 10x, attempt #2)

**Status:** 🟡 OPEN / DEFERRED backlog — a deliberate scope cut from the 2026-06-13 WebGL
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
