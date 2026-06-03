# Simulation Systems

All under `lib/sim`, pure TypeScript, seeded by `RNG` (`rng.ts`, a mulberry32 with gaussian,
weighted pick, shuffle, disc sampling, and `ValueNoise`/`fbm` for terrain). Determinism is a
feature: a seed reproduces a valley, and forks (`rng.fork(salt)`) give subsystems independent but
reproducible streams.

## Terrain (`terrain.ts`)

A `Terrain` is a square grid (default 160×160 cells × 20 m = 3.2 km). Generation:

1. A **meandering centerline** (the river/valley floor) as a function of row.
2. A **cross-valley profile** rising from the floor to ridge crests, modulated by multi-octave
   noise for spurs/fingers and irregular crests.
3. **Draws** (re-entrants) carved into one side or the other, lower and wetter.
4. **River incision** near the centerline; fine surface roughness everywhere.
5. **Landcover classification** by altitude band, slope, and a moisture field (draws and the
   north are wetter): river, terraced field, orchard, grass, holly scrub, forest, scree, rock.
6. **Villages** placed on benches (low slope, off the river), stamped with qalats + orchards.
7. **The COP** scored onto a prominent-but-not-summit knob toward the south, then flattened.
8. **Roads & trails** — a valley-floor road and goat trails to villages and up the draws.
9. **Cover & concealment** derived per cell from landcover.
10. **Named features** — prominent crest peaks get names and spot elevations.

Queries (world meters, bilinear where it matters): `elevAt`, `slopeAt`, `landAt`, `coverAt`
(stops rounds), `concealAt` (blocks sight), `moveCostAt` (speed multiplier from slope + landcover).

## Line of Sight (`los.ts`)

`lineOfSight(terrain, from, to, opts)` marches the ground profile between observer eye and target
and tracks the maximum upward angle to intervening terrain (the "horizon angle"). Comparing that to
the angles to the target's feet and head yields a smooth **exposure fraction** — partial defilade,
not a binary. Vegetation/canopy concealment and smoke crossed along the path multiply exposure down
(via an exponential transmittance). Returns `{ visible, exposure, terrainBlocked, concealment, rangeM }`.

`detectionChance(...)` turns an LOS result into a per-moment probability of *acquiring* a target,
folding range vs optics, light level, NVGs (US recover most of the night penalty), target movement,
muzzle flash, and prone posture. Acquisition is distinct from whether a bullet can connect.

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
**outcome** (victory on broken contact, destroyed, or a lull-detection fallback so fights always end).

Player intent enters via `issueOrder(ids, order)`; fire support via `requestFireMission` /
`requestCAS` / `medevac`. The store reads `units`, `projectiles`, `effects`, `smoke`, `revealed`,
and `log` for rendering and the HUD.
