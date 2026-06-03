# Simulation Systems

All under `lib/sim`, pure TypeScript, seeded by `RNG` (`rng.ts`, a mulberry32 with gaussian,
weighted pick, shuffle, disc sampling, and `ValueNoise`/`fbm` for terrain). Determinism is a
feature: a seed reproduces a valley, and forks (`rng.fork(salt)`) give subsystems independent but
reproducible streams.

## Terrain (`terrain.ts`)

A `Terrain` is a square grid (default **512×512 cells × 5 m = ~2.56 km** — high fidelity).
Generation is resolution-independent (landform frequencies are expressed per-meter):

1. A **meandering centerline** (the river/valley floor) as a function of row.
2. A **cross-valley profile** rising from the floor to ridge crests, modulated by multi-octave
   noise for spurs/fingers and irregular crests.
3. **Draws** (re-entrants) carved into one side or the other, lower and wetter — the enemy's
   covered approaches, exposed as `drawChannels`.
4. **River incision** near the centerline; modest surface roughness everywhere.
5. **Landcover classification** into **21 classes** by altitude band, slope, distance to the river,
   and a moisture field: river, marsh, **dry wash**, irrigated cropland, **terraces** and their
   stone **terrace-wall** risers (emergent from sharp downhill drops), orchards, upland meadow,
   grass, holly scrub, forest, scree, **boulder fields**, rock, **cliffs**, walled **compounds**
   and **compound walls**, **cemeteries**, roads, trails, and **footbridges**.
6. **Villages** placed on benches, stamped with walled qalats (interior + perimeter wall),
   surrounding orchards/terraces, and an occasional cemetery.
7. **The COP** scored onto a prominent-but-not-summit knob toward the south, then flattened.
8. **Roads & trails** — a valley-floor road and goat trails to villages and up the draws, bridging
   the river where a trail crosses it.
9. **Cover & concealment** derived per cell from landcover (compound walls and terrace risers are
   real hard cover; dry washes give defilade; forest/orchard conceal).
10. **Named features** — prominent crest peaks get names and spot elevations.

Queries (world meters, bilinear where it matters): `elevAt`, `slopeAt`, `landAt`, `coverAt`
(stops rounds), `concealAt` (blocks sight), `moveCostAt` (speed multiplier from slope + landcover),
`passableCell` (cliffs/compound walls/very steep are impassable on foot).

## Pathfinding (`path.ts`)

`findPath(terrain, start, goal, opts)` is A* over a coarsened grid (~15 m nodes, so it stays cheap
on the 5 m grid) using the terrain's movement cost, with an optional **concealment bias** so a
"concealed" route threads forest, orchards, and dry washes instead of crossing open ground. The path
is string-pulled (line-of-walk smoothing) to clean waypoints. Patrols and infiltrating fighters both
route through it, so the ground genuinely shapes how everyone moves.

## Movement postures

Units carry a `technique` (`entities.ts`): **crawl, concealed, tactical, patrol, traveling, rush**.
Posture sets base speed, stance (concealed/tactical crouch; crawl prone), and **detectability** —
slow, low, cover-hugging movement reads as near-static to an observer (folded into
`detectionChance` via a stealth term), while a rush is fast but loud and exposed.

## Line of Sight (`los.ts`)

`lineOfSight(terrain, from, to, opts)` marches the ground profile between observer eye and target
and tracks the maximum upward angle to intervening terrain (the "horizon angle"). Comparing that to
the angles to the target's feet and head yields a smooth **exposure fraction** — partial defilade,
not a binary. Vegetation/canopy concealment and smoke crossed along the path multiply exposure down
(via an exponential transmittance). Returns `{ visible, exposure, terrainBlocked, concealment, rangeM }`.

`detectionChance(...)` turns an LOS result into a per-moment probability of *acquiring* a target,
folding range vs optics, light level, NVGs (US recover most of the night penalty), target movement,
muzzle flash, prone posture, and — for a target moving **concealed/crawling** — a stealth term
(slow cover-hugging movement plus the unit's fieldcraft sharply lowers the chance of being seen).
Acquisition is distinct from whether a bullet can connect.

## Ballistics (`ballistics.ts`)

Per-round, no abstract to-hit:

- `dispersionSigmaM(weapon, shooter, range)` → linear dispersion (m) at the target from weapon MOA ×
  (skill, stance, suppression, fatigue, movement, composure, aim settle, range-beyond-effective).
- `spawnProjectile(...)` picks an aimpoint = target + 2-D gaussian(σ), and builds a flying round
  (direct) or a timed indirect round (mortars/arc).
- On arrival, `resolveDirectHit(...)`: geometric hit if the aimpoint lands within the target's
  **silhouette** (which shrinks with cover/defilade), then cover may still stop it per `penetration`.
- `applyDamage(...)`: rolls a body region (legs/arms common, head/chest lethal), applies body armor
  (US plates/helmet; insurgents/civilians none), reduces HP, and sets a capped bleed rate.
- `blastDamageAt(...)`: falloff for indirect/explosive.

`combat.ts` steps projectiles, applies suppression along the flight path and around impacts, and
detonates explosives.

## Combat tick (`combat.ts`)

`CombatSim.tick(dt)` (fixed 0.1 s steps) runs, in order: timers/bleeding/suppression-decay →
throttled **perception** (per-unit LOS scans with staggered cadence) → **fog of war** update
(`revealed` map: confirmed vs. fading last-known) → **AI** brains → **movement** (speed from
technique × stance × terrain × fitness × fatigue × suppression; fatigue accrues with slope &
altitude) → **firing** (burst tracking at cyclic rate, reloads, sidearm fallback) → **projectiles**
→ **fire missions** (indirect/CAS with ETA, dispersion, danger-close) → **morale** (composure toward
a target set by leadership presence, cohesion, suppression, fatigue) → effects/smoke aging →
**outcome**. In the persistent world the `CombatSim` runs in **`persistent` mode** — it never
auto-resolves; the `World` manages the unit lifecycle (spawning/despawning enemies, reconciling
casualties). The whole platoon, civilians, and active fighters all live in one sim at once.

Player intent enters via `issueOrder(ids, order)` (move orders carry a posture and can `pathfind`
through the terrain); fire support via `requestFireMission` / `requestCAS` / `medevac`. Units can be
added/removed live (`addUnit`/`removeUnit`).

## World tick (`world/world.ts`)

`World.tick(dt)` wraps the combat tick with the strategic clock: advance time → update light from
the sun + weather → burn supplies → rest/fatigue/morale → progress **tasks** (patrol/KLE) →
progress **projects** → resolve **resupplies** → roll weather/intel → run the **enemy director** →
surface **events** → recompute **metrics** → `sim.tick(dt)` → reconcile casualties → cull escaped
fighters → check tour end. The store steps this in fixed 0.1 s slices, scaled by speed/warp.
