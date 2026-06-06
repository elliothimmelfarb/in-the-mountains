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
4. **A walkable floodplain + the river as a real obstacle** (`carveFloodplain`, issue 010). The raw
   river incision used to cut a ~22 m, ~48 m-wide V into the floor, so the cells flanking the water
   read as **cliffs** and the channel fragmented into impassable, **valley-splitting** pieces (a
   measured 28% of seeds could not be walked across). Instead a continuous, gentle **floodplain** is
   benched around the meandering centerline (killing the incision cliffs), leaving a shallow channel
   for the water. The **river itself is impassable on foot** — too deep/fast to wade — and is crossed
   only at a **Ford** (a shallow gravel-bar crossing: passable, slow, almost no cover — a killing
   ground) or a **Footbridge**. `placeFords` lays fords down the valley (~every 260 m) and
   `ensureRiverCrossings` adds more wherever the two banks are still in different passable components,
   until the valley is one connected piece. This is the realistic core: the river *shapes* movement
   (you cross at the ford), it doesn't wall the valley off or trap a man who steps into it.
5. **Landcover classification** into **25 classes** by altitude band, slope, distance to the river,
   and a moisture field: river, marsh, **dry wash**, irrigated cropland, **terraces** and their
   stone **terrace-wall** risers (emergent from sharp downhill drops), orchards, upland meadow,
   grass, holly scrub, forest, scree, **boulder fields**, rock, **cliffs**, walled **compounds**
   and **compound walls**, **cemeteries**, roads, trails, **footbridges**, **fords**, and the COP's
   **HESCO** barriers, **structures** and **gravel** pads.
6. **Villages** placed on benches, stamped with walled qalats (interior + perimeter wall),
   surrounding orchards/terraces, and an occasional cemetery.
7. **The COP** scored onto a commanding bench/low spur near the valley (prominent, a few tens of
   metres above the floor, close enough to be supplied by road — not an alpine perch), then built out
   as a real fortified position (see below).
8. **Road & path network** — a tiered, connected network (`carveRoadsAndTrails`):
   - the valley-floor **Road** (MSR) just off the river;
   - a graded secondary **Track** (`Land.Track`) tying every village to the MSR, plus a village
     **minimum-spanning tree** of tracks linking the villages to one another — routed over the real
     terrain with `findPath` so they follow walkable ground, then laid by `layPath` which conforms
     LIGHTLY to local ground (never a deep cut). This replaced the old "trail trench to the water":
     a cliff-isolated village instead gets a feathered switchbacked graded-Track descent that reads
     as a real mountain road, not a gouge;
   - faint Tier-3 goat **Trails** up the draws (surface-laid, no benching), bridging the river where
     they cross (**Footbridge**);
   - the COP's **switchbacked access road** descends its spur to the MSR.
   Movement ladder (`LAND_MOVE`): **Road 1.0 > Track 0.96 > Trail 0.92 > Footbridge 0.85** ≫ open
   ground — so a patrol on **Fast** (roadBias) and villagers on inter-village errands both prefer the
   network. Tracks/trails are deterministic (seeded), so the network rebuilds identically on load.
   - **Connectivity guard** (`ensureNetworkConnectivity`, after `ensureGatePortal`) — the network is
     only useful if it actually reaches the gate. The MSR can be fragmented by river/steep banks and a
     COP can sit on a bench a cliff band walls off from the valley, so for **each village** the guard
     runs the patrol planner from the gate: if `findPath` reaches it, a **benched ≥3-cell Track** is
     laid along that exact route (the squad rides moveCost 0.96, not 0.2–0.6 cross-country, and the
     lane is guaranteed coarse-pathable); if the coarse router can't thread it (cliff pocket), a
     bounded Dijkstra over **gradeable** ground carves a benched Track **around** the cliffs to the
     gate's reachable component. A village with no gradeable route within ~700 m is left **genuinely
     unreachable** (honest refusal, not a faked arrival). Deterministic (no RNG) → save-load safe.
     This is the "smart" form of the reverted raw-largest-component COP constraint (issue 008): it
     gates on **network reachability and repairs**, never rejects a good bench, and uses no
     straight-line term.
9. **Cover & concealment** derived per cell from landcover (compound walls and terrace risers are
   real hard cover; dry washes give defilade; forest/orchard conceal).
10. **Named features** — prominent crest peaks get names and spot elevations.

Queries (world meters, bilinear where it matters): `elevAt`, `slopeAt`, `landAt`, `coverAt`
(stops rounds), `concealAt` (blocks sight), `moveCostAt` (speed multiplier from slope + landcover),
`passableCell` (cliffs/compound walls/**HESCO**/**the river channel**/very steep are impassable on
foot — the river is crossed only at a Ford or Footbridge), and `reachableFromGate`/`nearestReachable`
(the cached, mover-faithful — anti-corner-cut — reachable set, so objectives snap to ground the
squad can actually get to, never the far bank).

## The combat outpost (`terrain.cop`)

The COP isn't a dot on the map — it's a fortified position generated from the seed (`buildCop`) and
stamped into the landcover so cover, sight and pathing all respect it. A `CopLayout` describes:

- a **HESCO perimeter wall** (impassable, the hardest cover on the map; ≥3 cells thick so it reads as
  a real barrier at the 15 m pathfinding scale) ringing a benched, graded interior, broken only by a
  single **entry-control point** (the gate);
- a **benched perimeter track** — a graded patrol road ringing the wall just outside it — so movement
  has a clean, cheap, walkable way *around* the outpost to any bearing (a patrol bound for a village on
  the far side of the gate rounds the wire on a road instead of clawing across the broken hillside);
- interior **structures** — TOC, two barracks, aid station, armory, chow hall, latrines — and a
  **motor pool** and **helicopter LZ** of graded gravel near the gate;
- **crew-served fighting positions and guard towers** sited around the wall, facing out;
- the **gate** approach (inside/outside staging points) and the **muster** yard where patrols form.
  A generation-time guard (`ensureGatePortal`) proves the squad can actually egress by probing the
  FULL `muster → gateOutside` route with the **real `findPath`** (not a hand-rolled flood), and widens
  the gate + diagonal interior lane until the planner transits it. This matters because `findPath`
  forbids a diagonal step through a wall corner (anti corner-cutting), so a **diagonal** gate can be
  every-cell-passable and ring-100%-open yet sealed for the planner — the old flood-based check missed
  it and stranded the squad inside the wire (the "squad cannot leave COP" bug);
- a **connected interior yard with real streets** (`spaceCopBuildings` + `ensureInteriorConnectivity`,
  issue 012). The wire is small (R ≈ 85 m) and packs eight buildings, so without a guard their
  footprints touch and **seal interior courtyards** — leaving garrison posts a man literally can't path
  to, where he grinds a wall forever ("a squad gets stuck on buildings"). Two deterministic guards fix
  it: `spaceCopBuildings` relaxes any two footprints that are closer than 2 cells apart (separating along
  the axis closest to clearing, clamped inside R−3) so there is always a ≥ 10 m **gravel street**
  between buildings; then `ensureInteriorConnectivity` (run **last** in generation, so it sees the final
  terrain) floods the interior from the muster with the planner's own anti-corner-cut rule and **carves a
  widening benched lane** from any unreachable region (or post) to the nearest reachable cell until the
  **whole interior is one walkable yard** — relocating a stranded fighting position inward to reachable
  berm, and sealing only tiny post-free dead corners. It never touches the HESCO wire, so the perimeter
  (and infiltration) is unchanged. Belt-and-suspenders: a garrison man wedged short of his post escalates
  from the cheap router to a full `findPath` (`world/garrison.ts`). `copaudit` carries the invariant
  ("seeds with an unreachable garrison post: 0/N");
- a **switchbacked access road** (`gradeAccessRoad`) that descends from the gate to the valley road.
  Rather than lerping a straight cut from the gate to the river — which gouged a long, dead-straight,
  25 m-wide trench across the hillside whenever the knob stood well above the floor — it routes one
  short step at a time, following the terrain: heading for the valley where the grade allows and
  traversing/switchbacking where the fall line is too steep, reshaping the ground only enough to keep
  the tread walkable (so a gentle bench gets a track laid on the surface, no trench).

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
moment they're engaged and falling back to the routine on the lull. Posts are kept on **reachable**
ground (`reachablePoint`), and a man who somehow wedges short of his post (a tight interior, a relocated
spot) escalates from the cheap local router to a full `findPath` after a few seconds rather than
grinding the wall — a runtime backstop behind the generation-time connectivity guard (issue 012).

## Pathfinding (`path.ts`)

`findPath(terrain, start, goal, opts)` is **two-stage, corridor-constrained A***, which is what makes
it both correct and cheap:

1. a fast **coarse** pass (~15 m nodes) lays the global line across the valley. It is honest about
   the big barriers: a coarse node the **river channel** runs through (≥3 river cells) with no
   Ford/Footbridge in it is **impassable**, so the global line is forced to cross at a real crossing
   instead of optimistically cutting the channel;
2. a **full-resolution** A* confined to a **corridor** around that line produces the path the unit
   actually walks — honouring every 5 m feature (it crosses at the real ford, threads the ECP gate,
   slips through a qalat gap) and **always genuinely walkable**. The corridor keeps the search cheap
   and makes a looping/spiralling path impossible; it widens if a tight corridor can't get through.
3. a **free, unclipped** full-resolution A* **fallback** when every corridor fails — a cross-river
   objective often needs a long detour to a distant ford that swings outside any corridor, and the
   free pass finds that genuine route before settling for a best-effort "get as close as the ground
   allows" stop.

The A* scratch is reused with generation-stamping (no per-call allocation), so re-planning is cheap.
**No unit is ever handed a path it can't physically walk**, and objectives are snapped with
`nearestReachable` to a cell in the squad's **own connected component** — never across the river or a
wall on the far bank.

Three optional biases shape the route: a **concealment bias** so a stealthy route threads forest,
orchards and dry washes instead of crossing open ground; a **road bias** so fast movement takes the
valley road/trails (and fords); and a **cover bias** the enemy uses to stay off the skyline. The
COP's HESCO wall is impassable, so routes in and out of the outpost are funneled through the gate
(which has a narrow, switchbacked access road that follows the terrain down the spur to the valley
road — see the COP section). Patrols, fire teams and infiltrating fighters all route through it.

A coarse node stays passable if *any* of its sub-cells is (so a thin wall can't seal a reachable
goal), but it is charged a **barrier penalty** (`BARRIER_PENALTY`, quadratic in the fraction of
wall/cliff cells it carries). Without this, a 2-cell wall is invisible at 15 m nodes — every
COP-wall node still held ~7 passable apron/interior cells and scored as cheap ground, so A* used to
**tunnel straight through the walled outpost** (out the gate, across the yard and back) instead of
rounding it. Paired with a HESCO wall thickened to **≥3 cells** (a coarse node centred on it is then
genuinely impassable, so the ring truly seals and A* can't route in-and-out the single gate node)
and the COP's **benched perimeter track**, routes now cleanly go *around* the wire to any bearing.

## Closed-loop movement (`combat.ts` `moveUnit`)

Movement is self-correcting, which is the single mechanism that keeps everyone un-stuck without
per-situation special-casing. A unit walks its path toward a `pathGoal`; **the wire is solid** (it
never steps into an impassable cell — it slides along it instead); and a watchdog notices when it
can't advance freely (wall-blocked / sliding) for a couple of seconds and **drops the stale path so
its driver re-issues a fresh one** (the squad's point man re-routes from where he stands; a
civilian/garrison man takes a cheap straight step). The watchdog itself runs no pathfinding, so
dozens of idle/milling units never pile A* onto a tick. Objectives are snapped to reachable ground
(off cliffs, out of walled compounds to the village edge), and the task layer has a no-progress
backstop (measured as the navigator's **remaining route length**, which falls monotonically as he
advances — so rounding a convex obstacle, where crow-flies distance to the goal *grows*, no longer
trips it and freezes the patrol half-way claiming success).

**Local steering** (`steering.ts`) sits between the path and the integrator: each tick a unit's raw
"head at my next waypoint" intent is resolved into a heading a real body would take. It **rounds
obstacles** (a fan of candidate headings, each ray-probed for clearance — the clearest one still
aimed at the goal wins, so it curves around the convex HESCO ring instead of grinding it) and keeps
**separation** from nearby bodies (a short-range push, so soldiers don't interpenetrate and a column
naturally collapses to single file at a choke). It is a no-op when the lane ahead is clear and no one
crowds, so open-ground and combat movement are unaffected; neighbour lookups use a per-tick spatial
hash. This is *physics* — every agent (soldiers, civilians, the enemy) gets it for free.

**Facing is rate-limited, not snapped.** A body slews toward its target heading at a bounded turn rate
(≈170°/s marching, ≈80°/s holding/scanning, fast onto an acquired threat) instead of teleporting to it
each tick — the instantaneous snap was the dominant "robotic" tell (heading jitter peaked at ~730°/s;
it now sits ~16°/s on the march). Movement also **eases into its final waypoint** (decelerate onto the
slot, not full-speed-then-stop) and keeps a **never-freeze speed floor** so a patrol always reads as
moving. Where separation can't run — two *halted* bodies, since steering only fires for a man
following a path — a cheap **de-overlap** pass eases them apart (onto passable ground only), so a
settled 360 or a soldier-meets-standing-civilian never interpenetrates. Every bit of per-agent
variation (interval personality, scan phase, civilian pace/dwell) comes from a **pure hash of the unit
id**, so the headless sim stays bit-for-bit reproducible across replays.

## Movement postures

Units carry a `technique` (`entities.ts`): **crawl, concealed, tactical, patrol, traveling, rush**.
Posture sets base speed, stance (concealed/tactical crouch; crawl prone), and **detectability** —
slow, low, cover-hugging movement reads as near-static to an observer (folded into
`detectionChance` via a stealth term), while a rush is fast but loud and exposed. The posture also
feeds the squad's formation choice and pathfinding biases (below).

**Fatigue economy** (`combat.ts`) — speed also pays a fatigue drag (`×(1 − fatigue·0.32)`). Fatigue
accrues with effort but is **exertion-gated**: on gentle ground a recovery-while-moving term offsets
the small accrual so a routine foot patrol **plateaus** at a working level, while a steep climb or a
rush still saturates it (so combat fatigue — ballistics MOA, composure — stays meaningful). The
**altitude** penalty is exertion-gated too (issue 010): thin air makes *climbing* brutal, but ambling
a flat track at altitude is not itself draining — previously the unconditional altitude term redlined
a long high-valley patrol to ~0.68× and made far villages arrive only after the tactical window.
Before the broader retune, fatigue saturated to 1.0 on any long march and pinned the squad at ~0.55×
for the rest of the hump (see `docs/progress/2026-06-05-pathfinding/` and `2026-06-06-river-navigation/`).

## Squad movement & doctrine (`world/formation.ts`)

A patrol does not move as a loose cloud of dots — it moves as a real US infantry squad: a **squad
leader plus two four-man fire teams** (team leader, automatic rifleman, grenadier, rifleman).
`planFormation` reconstructs that echelon from the patrol's roster and chooses doctrine from the
mission, posture, terrain and whether the squad **expects contact**:

- **Formation** — *file* in restrictive ground (forest/draws) or when moving stealthy; *staggered
  column* on an admin road march; *wedge* for movement to contact in the open; *dispersed* (teams
  abreast, all-round) when contact is expected. Interval follows the doctrinal **"5 and 10"** — ~5 m
  between individual men, ~11–14 m between fire teams with the squad leader riding between them —
  opening up when contact is likely and closing down in close terrain for control, with a stable
  per-soldier ±10% so the file reads as men rather than a machined lattice.
- **Routing** — concealed/seeking postures hug cover and stay off the obvious lanes; fast postures
  bias to roads; an ambush/recon never walks the road into its own kill zone.

`steerSquad` then drives it: the lead team's leader navigates the terrain (A*) with a rifleman out
on point; his automatic rifleman and grenadier hold the team's flanks; the squad leader follows
controlling, with the medic/RTO; the trail team brings up the rear and watches the backtrail. Every
man pulls a **security sector** (`Unit.faceLock`, honored even when halted), so the element provides
360° coverage on the move.

The rest of the squad moves in **trace**, not by posing. The navigator's actual route is recorded as
a breadcrumb polyline (`Task.trail`); each follower's path is the run of breadcrumb points from where
it currently is *forward to its slot* — a distance back along the real route, plus a lateral offset
from the **local trail tangent**. Because the breadcrumb is literally ground the point man already
walked, a follower is handed a **walkable route around big obstacles** (the COP ring, a draw) rather
than beelining at a slot that may be across a wall; local steering only handles the small stuff. The
lateral offset opens the file into a fire-team wedge in the open and collapses toward the trail in
close country — and the formation's **width is sensed**, not fixed: `steerSquad` probes the free
corridor across the line of travel each tick and scales the spread to fit, so the wedge smoothly
narrows to single file threading the benched track around the wire. This (with the trail tangent
keying the offset) removed the old "turnstile", where geometric slots hung off the leader's heading
swung the whole element sideways every time he turned.

A man who gets **separated** — most often still inside the wire when the squad has filed out, so every
breadcrumb point is across the HESCO from him — stops tracing (which would only grind him on the wall)
and **rejoins with a real A\* route**: out through the gate if he's inside the wire, then back onto the
leader's wake. That is how a separated soldier actually rejoins — he navigates to the formation, he
doesn't walk through the wall.

The point man **governs the pace** with a smooth throttle (`Unit.paceScale`, applied in `moveUnit`):
he eases off — never to a dead stop — as the element strings out, and after a spell of waiting pushes
on so a man genuinely hung up on an obstacle is left to chase rather than freezing the patrol. (The
old binary "hold" froze him outright, which — combined with the leg's no-progress backstop — could
strand a patrol at its own gate.) Filing out the ECP, the point man pours straight through at full
pace, and the file-out backstop watches *his* progress, not the lagging centroid, so the element
doesn't flip to formation while the lead is still inside the wire. On the objective the squad sets up
only once it has **closed up** — the lead holds on the objective (the pace governor draws the file in)
until ~80% of the element is within ~55 m, or a short grace expires, so the 360 forms with the squad
*together* rather than with a fire team still 100 m back (the strung-out arrival).

The **360° security halt** itself (`holdSecurity`) is a *cigar-perimeter, near-side occupation* — the
fix for men "getting stuck on each other" setting up security. Each man takes the ring sector he is
already **nearest**: evenly-spaced outward slots are laid down and the ring is rotated against the men
(sorted by their current bearing) to **minimise total angular travel**, which for points on a circle
is crossing-free — nobody marches across the formation through everyone else (the old raw-index
assignment routinely sent a man on the east to the *west* slot). Slots are nudged per-man off the
geometric ideal (so it isn't a machined circle), snapped onto **passable + cover**, and snapped onto
**reachable** ground; a sector walled off behind broken terrain falls back to a **hasty position on
the man's own bearing** instead of a long detour. The **squad leader holds the inside** of the cigar
(command from within the perimeter), the radius **fits the terrain** (it shrinks in a draw and is
squad-sized — deliberate 14 m / KLE 9 m), and the assignment is cached so a contact flicker doesn't
reshuffle the whole perimeter. A halted man **settles** (a deadband stops the sub-metre re-aim dither),
**scans his sector** (a slow facing sweep that freezes onto a real threat) rather than locking like a
turret, and a per-tick **de-overlap** pass eases any two settled bodies apart so the perimeter can't
collapse into a pile. Coming home, the element **files back in keyed on the
LEAD reaching the gate** (not the centroid — the column trails the point man, so a centroid test left
the squad standing down *outside* the wire), and completes the moment the bulk is inside (the garrison
walks in the last straggler). The instant rounds crack, the formation releases and combat AI takes
over; it re-forms on the lull.

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

**Thermal optics** (CLU/LRAS3/thermal weapon sights) are a distinct sensor channel — the US
overmatch in the valley. Carried by the few (marksman, sniper, JTAC, weapons-squad MG gunners), a
thermal sight is **light-independent** (it reads body heat by day or in the dark) and sees **through
vegetation** (but not terrain defilade, and only partly through smoke). `LOSResult` exposes the
geometric/veg/smoke concealment split so thermal recombines the exposure; the perception gate is
thermal-aware, so a fighter in dense canopy at night — invisible to the naked eye and weak on NVGs —
reads clearly on thermal.

## Ballistics (`ballistics.ts`)

Per-round, no abstract to-hit:

- `dispersionSigmaM(weapon, shooter, range)` → linear dispersion (m) at the target from weapon MOA ×
  (skill, stance, suppression, fatigue, movement, composure, aim settle, range-beyond-effective).
- `spawnProjectile(...)` picks an aimpoint = target + 2-D gaussian(σ) **+ wind drift** over the
  round's time of flight, and builds a flying round (direct) or a timed indirect round (mortars/arc).
- `retainedLethality(weapon, range)` — **range-dependent terminal energy**. A ball round's wounding
  power falls with range as velocity bleeds off, on a per-kinetic-class curve: **5.56 has a sharp
  fragmentation knee** (full <150 m, ~half by 500 m — the literal reason the valley fight demanded
  7.62/.50/CAS), 7.62 full-power holds, .50 is ~flat, 9 mm cliffs. (Frag/HEAT are unaffected; their
  falloff is spatial.)
- On arrival, `resolveDirectHit(...)`: geometric hit if the aimpoint lands within the target's
  **silhouette** (which shrinks with cover/defilade), then cover may still stop it per `penetration`.
- `applyDamage(...)`: rolls a body region, applies body armor (US plates/helmet; insurgents/civilians
  none), reduces HP, and sets a **split bleed** — extremity (leg/arm) wounds bleed fast but are
  **tourniquetable** (any buddy stops them, TCCC); torso/junctional bleed internally and need a medic.
- `blastDamageAt(...)`: falloff for indirect/explosive.

`combat.ts` steps projectiles, applies suppression along the flight path and around impacts, detonates
explosives, and runs **buried IEDs** (`plantIED`/`stepIeds`) that command-detonate when a patrol
enters the kill zone. A **wind vector** (prevailing synoptic + a diurnal valley flow, anabatic
up-valley by day / katabatic down at night — `world.windVector`) drifts bullets and smoke.
**Combat-load weight** (`combatLoadKg` — the Korengal "every man a mule", ~30 kg for a rifleman to
~56 kg for a 240 gunner) drags movement speed and accelerates fatigue.

## Combat tick (`combat.ts`)

`CombatSim.tick(dt)` (fixed 0.1 s steps) runs, in order: timers/bleeding/suppression-decay →
throttled **perception** (per-unit LOS scans with staggered cadence) → **fog of war** update
(`revealed` map: confirmed vs. fading last-known) → **AI** brains (`ai/friendly.ts`,
`ai/insurgent.ts`, `ai/civilian.ts` — the per-man executors; the squad's tactical decisions are
made one layer up in `ai/squad-combat.ts`, on the world tick before this one) → **movement** (speed from
technique × stance × terrain × fitness × fatigue × suppression; fatigue accrues with slope &
altitude) → **firing** (burst tracking at cyclic rate, reloads, sidearm fallback) → **projectiles**
→ **fire missions** (indirect/CAS with ETA, dispersion, danger-close) → **morale** (composure toward
a target set by leadership presence, cohesion, suppression, fatigue) → effects/smoke aging →
**outcome**. In the persistent world the `CombatSim` runs in **`persistent` mode** — it never
auto-resolves; the `World` manages the unit lifecycle (spawning/despawning enemies, reconciling
casualties). The whole platoon, civilians, and active fighters all live in one sim at once.

**Combat is 100% AI** — the player never commands a man in a firefight. Player intent enters one
layer up, at the World/store level: you pick a fixed squad and give it a **route** (`formPatrol` /
`conductKLE`, both carrying a `SquadSOP`), and you can `reroute` a deployed squad or edit its `setSOP`
*before* contact. Once the squad is in contact those levers lock; the **squad-combat coordinator**
(`ai/squad-combat.ts`) runs the fight (see below). The player's only in-combat inputs are
fire-support approvals (`requestFireMission` / `requestCAS`) and `medevac`. Units can be added/removed
live (`addUnit`/`removeUnit`).

### The squad SOP & the squad-combat coordinator (`world/types.ts`, `ai/squad-combat.ts`)

A squad's entire command surface is its **`SquadSOP`** — three standing settings the player sets
before step-off (mission type seeds sensible defaults) and that **lock once the squad is in contact**:

- **MOVEMENT** (`stealth` / `patrol` / `fast`) — how it moves to its waypoints (maps to a move
  technique, hugging cover vs. balanced vs. road-march).
- **ON CONTACT** (`hold` / `suppress` / `assault` / `break`) — the battle drill the squad AI runs the
  instant it makes contact.
- **ROE** (`hold` / `tight` / `free`) — the civilian-fire rules that govern every friendly trigger.

`ai/squad-combat.ts` (`squadFight`, invoked from `tickTasks` on the **world** tick — before
`sim.tick`, so the decision lands the same tick the men act on it) is the squad leader's brain. On
contact it orients (everyone to cover, return fire per ROE), then runs the SOP's drill — designating a
**base-of-fire** team and a **maneuver** team and bounding onto the objective (assault), pinning and
**raising a call-for-fire** (suppress), holding from cover (hold), or leapfrogging back to a rally
(break) — popping smoke as needed. It only *decides*: it stamps the same per-man intent fields
(`rof`, `brainState`, `orderType`, `orderTarget`, `roe`) that `ai/friendly.ts` already executes each
tick (cover, return fire, buddy-aid, the per-man bound). A squad that has become **combat-ineffective
always breaks contact automatically** — that safety overrides the SOP and is never a player dial.

**The `civClear` ROE gate** (`combat.ts`) makes every friendly shot check the shooter's ROE before it
flies: it scans living civilians for any in the keep-out bubble around the aimpoint or in the
line-of-fire corridor, sized by ROE (`free` shrinks to danger-close, `tight`/`hold` keep a generous
bubble) and widened for area/blast weapons. Under `tight` a soldier **holds fire rather than risk a
civilian in the kill zone**, and that restraint is recorded (`restraintEvents`) so the World can turn
it into a small COIN reward — held fire nudges the village's attitude up; civilian casualties tank it.

**Fires & MEDEVAC are AI-requested, player-approved.** When suppressing or pinned the coordinator
raises a call-for-fire (`requestSquadFires` → a pending `fireRequest`: squad, reason, proposed grid);
the commander **approves** (rounds fly via `requestFireMission`/`requestCAS`) or **denies**. MEDEVAC
likewise — the AI surfaces a casualty and the player calls the bird.

## World tick (`world/world.ts`)

`World.tick(dt)` wraps the combat tick with the strategic clock: advance time → update light from
the sun + weather → burn supplies → rest/fatigue/morale → progress **tasks** (patrol/KLE) →
progress **projects** → resolve **resupplies** → roll weather/intel → run the **enemy director** →
surface **events** → recompute **metrics** → `sim.tick(dt)` → reconcile casualties → cull escaped
fighters → check tour end. The store steps this in fixed 0.1 s slices, scaled by speed/warp.
