# Combat graphical overhaul — progress report (2026-06-04)

**Goal:** make every aspect of combat intelligently *clear* and *beautiful* — a player should
understand from simple, clear cues what is happening in a firefight. Built in parallel with the
squad-command overhaul (separate agent), so this work is confined to the **render layer** to avoid
collisions: a new `lib/render/combat-fx.ts`, additive upgrades to `lib/render/draw.ts`, one
consolidated hook in `WorldView.tsx`, plus the asset library + ART_BIBLE. **Zero `combat.ts` edits**
so far — every cue is a faithful read-out of data the sim already computes.

## Method
1. **Design workflow** (8 agents): 4 diverse design lenses → 3-judge panel → synthesized *Combat
   Visual Language* + asset manifest + phased plan. The judges cut the off-palette thermal-cyan
   tint, a recoil sprite-jolt, a spectacle-only shockwave ring, and any HUD banners (those are the
   squad-command agent's lane).
2. **Verify, don't assume.** Read the actual sim tick before building. Two findings that changed the
   plan: (a) fire-mission rounds **never become flying projectiles** — they `detonate()` instantly —
   so the indirect cue had to be the *reticle* (reading `sim.fireMissions`), not in-flight rounds;
   (b) indirect-round progress is **exact** via `age/(age+timeToImpact)` (their sum is the launch
   time-of-flight), so no caching is needed and the arc never jumps.
3. **Headless eyeball test** (no browser): `scripts/fx-legend.mjs` + `scripts/fx-explosions.mjs`
   rasterize the cues with `sharp` using the *same* geometry/palette as the renderer.

## Shipped (Phases 1–3) — all render-only, `tsc` clean
- **Indirect beaten-zone reticle** (`drawFireMissions`): dashed ground ring sized to dispersion, a
  converging telegraph + ETA countdown while inbound, an **amber/deep-shadow danger-close hazard**
  variant with halos on at-risk friendlies. Enemy harassing fire and US fires share the cue (rust vs
  amber). *This is the headline win — indirect was previously completely unannounced (a flat orange
  disc simply appeared).*
- **Grenade lob-arc** (`drawProjectiles`): thrown frags now render as a lobbed round with a ground
  shadow + smoke wisp arcing to the airburst, using the exact-progress math.
- **Threat-bearing crescent** (`drawSuppressionCues`): a rust crescent on the bearing incoming fire
  arrives from (`Unit.threatDir`, smoothed so it doesn't swim) — the clearest "it's coming from
  THERE" read, from data the sim already had but never drew.
- **Pinned vs suppressed**: a closed, slow-pulsing rust ring when composure breaks under fire.
- **Layered explosions** (`drawEffects`): `blast` (ground HE) → flash → *dirty* fireball → tan dust
  dome → smoke rim, scaled to the true beaten radius; `frag_air` (airburst) → a tight bright ring.
  Fixes the only off-palette color shipping (the hot orange → warm/dirty `#c97036`).
- **Strikes**: tan dust-puff + deterministic spall on `impact`; punchier muzzle flash; capped blood
  spatter.
- **Casualty cues** (`drawCasualtyCues`): a growing-but-capped **arterial-bleed pool** with a slow
  pulse (deeper red = TQ-now) and a **teal buddy-aid tether** treater→casualty, bound strictly to
  `brainState==="treating"` so it can't lie. Complements (never duplicates) the KIA-X / down-cross /
  hp-bar that `draw.ts` already owns. Down US soldiers now render as the **`sol-us-casualty`** prone
  body, not an upright man.
- **Lingering scorch decals** (`drawScorchDecals`): a ground-HE blast drops a **`fx-blast-scorch`**
  crater that persists ~9 s (the 0.6 s blast is the flash; this is the crater), deduped by the
  monotonic `Effect.id` — the "a charge went off HERE" read.
- **Contact-onset (TIC)** (`drawContactMarker`): an expanding rust starburst on the first contact
  after a lull (debounced via a 4 s gap), plus a pulsing aggregate glyph at the contact centroid when
  zoomed out — so a distant firefight stays on the map sheet and the per-soldier cues carry it in
  close. Derived render-side from the friendly roster (no `combat.ts` touch).
- **Fog-of-war** (`WorldView` + `drawFogReveals`): a SUSPECTED enemy ghost now **fades with the
  staleness of the intel** toward the 25 s cull (`1 - (timeS-lastSeenS)/25`), reading "where he WAS"
  not "where he is"; and a hostile muzzle flash whose origin isn't near a confirmed enemy drops a
  **suspected-shooter pinpoint** (rust dashed diamond, ~6 s, deduped ~6 m) so "fire from the treeline
  THERE" stays actionable after the 0.12 s flash. No x-ray — the flash is already drawn.
- **Directional muzzle cone + IED-vs-mortar scar** — the *only* `combat.ts` touch (4 additive lines,
  coordinated with the squad agent; `realism-probe ied` + `fx-probe` confirm no behavior change): two
  optional `Effect` fields (`facing?`, `ied?`). The muzzle flash now draws a **forward cone along the
  gun line** (you see which way a soldier is firing; SAW/MG flashes bigger), and an **IED initiation
  craters ~35% larger and dirtier** than a mortar splash. Both fall back gracefully (omni star / plain
  scar) for effects lacking the new fields.
- **LOD aggregation** (`drawCombatHaze` + zoom gates) — below ~0.45 ppm a firefight collapses from a
  mush of per-round dots into a few **warm fire-haze blobs** (one shared per-frame ~50 m grid-bin),
  while the individual tracer/muzzle/impact/blood draws gate OFF; the tracer also dropped its
  per-frame `createLinearGradient` for a **2-segment solid** (the documented 116 fps risk). Measured
  (headless A/B at tactical zoom, `shoot.mjs --stress --fps`): 81 in-flight rounds add **~0.4 ms/frame**
  (31.27 → 31.64 ms) — combat rendering is essentially free. (The ~31 ms baseline is dev-mode full-map
  overhead, not combat; prod is the repo's verified 116 fps.)

## Verification
- `scripts/fx-probe.ts` — **7/7 hard checks pass**: enemy mortar populates the reticle (spread 38 m,
  real target, ETA 20→15 s, walks to *firing*); frag arc progress is monotonic `[0.00 0.07 … 0.93]`.
- `npx tsc --noEmit` clean (my files); the headless plates confirm the vocabulary is coherent,
  on-palette, and the three munition types are distinguishable at a glance.
- **LIVE verified** via a new `scripts/shoot.mjs` — a zero-dependency headless-Chrome harness that
  drives the REAL running app over the Chrome DevTools Protocol (so it never contends with the MCP
  browser the parallel agent holds). It boots a game, stages a deterministic combat tableau directly
  on the world (`window.__ITM`), frames the camera (`window.__setCam`), and screenshots the live
  canvas. Confirmed all cues render and read on real terrain: threat crescent, pinned ring,
  casualty + bleed-pulse + buddy-aid teal tether, muzzle flashes, the dashed enemy reticle, and the
  lingering scorch crater (`docs/progress/2026-06-04-combat-visual/live-*.png`). Two live-tuning
  passes followed: the crescent/pinned/bleed cues gained a **dark keyline backing** so they pop off
  the dusty relief (the bible's ink-edge trick), and the bleed pulse + buddy-aid link were brightened
  for contrast on dark dirt.

## Live screenshot harness (reusable)
`scripts/shoot.mjs` — `node scripts/shoot.mjs [out.png] [ppm]` boots a game in an isolated headless
Chrome (CDP, zero deps), stages a deterministic combat tableau on `window.__ITM`, frames via
`window.__setCam`, and clips a 2× screenshot of the live canvas. Independent of the MCP browser, so
two agents can drive the game at once. Stage tableau: a 7-man row on the LZ apron, one cue per man.

## Status
All designed cues are shipped and verified (live + headless). Several design-manifest items (the
reticle, bleed pool, crescent, contact starburst, combat haze) are intentionally **procedural**, not
SVGs, because they animate/scale dynamically. No known remaining work; future ideas would be net-new
(e.g. thermal-optics legibility, which the design cut as off-palette).
