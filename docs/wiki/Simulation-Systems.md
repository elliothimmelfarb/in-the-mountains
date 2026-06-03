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
5. **Landcover classification** into **24 classes** by altitude band, slope, distance to the river,
   and a moisture field: river, marsh, **dry wash**, irrigated cropland, **terraces** and their
   stone **terrace-wall** risers (emergent from sharp downhill drops), orchards, upland meadow,
   grass, holly scrub, forest, scree, **boulder fields**, rock, **cliffs**, walled **compounds**
   and **compound walls**, **cemeteries**, roads, trails, **footbridges**, and the COP's **HESCO**
   barriers, **structures** and **gravel** pads.
6. **Villages** placed on benches, stamped with walled qalats (interior + perimeter wall),
   surrounding orchards/terraces, and an occasional cemetery.
7. **The COP** scored onto a prominent-but-not-summit knob toward the south, then built out as a
   real fortified position (see below).
8. **Roads & trails** — a valley-floor road and goat trails to villages and up the draws, bridging
   the river where a trail crosses it; the COP's access trail runs from its gate down to the road.
9. **Cover & concealment** derived per cell from landcover (compound walls and terrace risers are
   real hard cover; dry washes give defilade; forest/orchard conceal).
10. **Named features** — prominent crest peaks get names and spot elevations.

Queries (world meters, bilinear where it matters): `elevAt`, `slopeAt`, `landAt`, `coverAt`
(stops rounds), `concealAt` (blocks sight), `moveCostAt` (speed multiplier from slope + landcover),
`passableCell` (cliffs/compound walls/**HESCO**/very steep are impassable on foot).

## The combat outpost (`terrain.cop`)

The COP isn't a dot on the map — it's a fortified position generated from the seed (`buildCop`) and
stamped into the landcover so cover, sight and pathing all respect it. A `CopLayout` describes:

- a **HESCO perimeter wall** (impassable, the hardest cover on the map) ringing a benched, graded
  interior, broken only by a single **entry-control point** (the gate);
- interior **structures** — TOC, two barracks, aid station, armory, chow hall, latrines — and a
  **motor pool** and **helicopter LZ** of graded gravel near the gate;
- **crew-served fighting positions and guard towers** sited around the wall, facing out;
- the **gate** approach (inside/outside staging points) and the **muster** yard where patrols form.

Because the wall is impassable and only the gate is open, A* naturally funnels everyone in and out
through the ECP, and patrols file out and back through it. The layout drives where the platoon is
billeted, where the crew-served weapons sit, and the whole garrison routine (below).

## Garrison life (`world/garrison.ts`)

Off-task soldiers live in the COP rather than standing frozen. Each tick `tickGarrison` posts every
available man by time of day and role: a **rotating guard roster** mans the wall positions and
towers and the MG crews stay on their guns (always eyes on the wire); meal hours fill the **chow
hall**; after dark the off-guard rack out in the **barracks**; by day leaders work the **TOC**, the
medic keeps the **aid station**, and everyone else knocks about the yard. When fighters close on the
wire the whole COP **stands to** and mans the nearest fighting positions, breaking to fight the
moment they're engaged and falling back to the routine on the lull.

## Pathfinding (`path.ts`)

`findPath(terrain, start, goal, opts)` is **hierarchical A***, which is what makes it both correct
and cheap. A fast **coarse** pass (~15 m nodes) finds the long route across the valley for a few
thousand node expansions; then string-pulling walks that route, and wherever a straight segment
would clip a 5 m feature (a compound wall, a cliff lip) it splices in a short **fine**
(full-resolution) A* over just that ~15 m gap. So long-range stays coarse-cheap, and the only
full-resolution work happens in the few metres where it matters — **no unit is ever handed a path it
can't physically walk**, which is what kept patrols off the wire. The A* scratch is reused with
generation-stamping (no per-call allocation), so re-planning is essentially free.

Three optional biases shape the route: a **concealment bias** so a stealthy route threads forest,
orchards and dry washes instead of crossing open ground; a **road bias** so fast movement takes the
valley road/trails; and a **cover bias** the enemy uses to stay off the skyline. The COP's HESCO
wall is impassable, so routes in and out of the outpost are funneled through the gate (which has a
graded access road off the knob). Patrols, fire teams and infiltrating fighters all route through it.

## Closed-loop movement (`combat.ts` `moveUnit`)

Movement is self-correcting, which is the single mechanism that keeps everyone un-stuck without
per-situation special-casing. A unit walks its path toward a `pathGoal`; **the wire is solid** (it
never steps into an impassable cell — it slides along it instead); and a watchdog notices when it
can't advance freely (wall-blocked / sliding) for a couple of seconds and **drops the stale path so
its driver re-issues a fresh one** (the squad's point man re-routes from where he stands; a
civilian/garrison man takes a cheap straight step). The watchdog itself runs no pathfinding, so
dozens of idle/milling units never pile A* onto a tick. Objectives are snapped to reachable ground
(off cliffs, out of walled compounds to the village edge), and the task layer has a no-progress
backstop, so a leg or a return that genuinely can't be closed is force-advanced rather than frozen.

## Movement postures

Units carry a `technique` (`entities.ts`): **crawl, concealed, tactical, patrol, traveling, rush**.
Posture sets base speed, stance (concealed/tactical crouch; crawl prone), and **detectability** —
slow, low, cover-hugging movement reads as near-static to an observer (folded into
`detectionChance` via a stealth term), while a rush is fast but loud and exposed. The posture also
feeds the squad's formation choice and pathfinding biases (below).

## Squad movement & doctrine (`world/formation.ts`)

A patrol does not move as a loose cloud of dots — it moves as a real US infantry squad: a **squad
leader plus two four-man fire teams** (team leader, automatic rifleman, grenadier, rifleman).
`planFormation` reconstructs that echelon from the patrol's roster and chooses doctrine from the
mission, posture, terrain and whether the squad **expects contact**:

- **Formation** — *file* in restrictive ground (forest/draws) or when moving stealthy; *staggered
  column* on an admin road march; *wedge* for movement to contact in the open; *dispersed* (teams
  abreast, all-round) when contact is expected. Interval opens up when contact is likely and closes
  down in close terrain for control.
- **Routing** — concealed/seeking postures hug cover and stay off the obvious lanes; fast postures
  bias to roads; an ambush/recon never walks the road into its own kill zone.

`steerSquad` then drives it: the lead team's leader navigates the terrain (A*) with a rifleman out
on point; his automatic rifleman and grenadier hold the team's flanks; the squad leader follows
controlling, with the medic/RTO; the trail team brings up the rear and watches the backtrail. Every
man pulls a **security sector** (`Unit.faceLock`, honored even when halted), so the element provides
360° coverage on the move. The point man **governs the pace** so the squad stays together, and
followers route terrain-aware (straight when clear, A* around obstacles, every slot snapped to
passable ground) so nobody strands the column on a wall or cliff. On the objective each fire team
sets into a sector of a 360° security halt. The instant rounds crack, the formation releases and
combat AI takes over; it re-forms on the lull.

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
