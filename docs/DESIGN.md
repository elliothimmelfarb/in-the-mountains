# In the Mountains — Design Document

> A tactical-strategic simulation of company/platoon command at a remote combat outpost
> in a fictional Korengal-like valley, Kunar Province, Afghanistan, c. 2011.
>
> Tone & research inspiration: *War* and *Korengal*/*Restrepo* (Sebastian Junger / Tim
> Hetherington), *The Outpost* (Jake Tapper), *Lone Survivor* (Luttrell), *One Bullet Away*
> (Fick), COIN field manual FM 3-24, and the lived texture of the Pech/Korengal valley
> deployments (2nd Bn 503rd, 1-32 IN, the "Valley of Death").

## 1. Pillars

1. **The valley is the enemy.** Terrain is the dominant actor — ridgelines, draws, spurs,
   dead ground, switchback trails, terraced fields, the river. Elevation drives line of
   sight, cover, concealment, movement cost, weapon effectiveness, and exhaustion.
2. **Every bullet matters.** Each projectile from every weapon system is simulated:
   muzzle velocity, time of flight, dispersion, suppression. Ammo is finite and heavy.
3. **People, not pieces.** Soldiers have names, ranks, jobs, skill, fear, fatigue, and
   relationships. They get tired, suppressed, panicked, wounded, killed. Leadership and
   the brotherhood hold them together. Losses are permanent and they cost you.
4. **Asymmetry.** The enemy doesn't fight fair. Shoot-and-scoot, ambush from defilade,
   RPG and PKM teams on the high ground, IEDs, melding into the civilian population,
   fighting on their timeline. You have firepower (mortars, CAS, MEDEVAC) but using it
   wrong kills civilians and loses the valley.
5. **Counterinsurgency is the real game.** Killing fighters is easy; winning the valley is
   not. Atmospherics, shuras with elders, CERP projects, patient presence, restraint.
   Civilian casualties radicalize. The campaign is won or lost in attitudes, not body count.
6. **Unpredictability.** Seeded but stochastic. Weather, intel quality, enemy initiative,
   equipment failure, the fog of war. No two patrols feel the same.
7. **Time is continuous.** There are no turns and no phases. One clock runs the valley — the
   sun, the weather, fatigue, the enemy's tempo, construction, and combat — all at once.
   Everything takes time: kitting up, walking the ground, building a well. You pause and
   time-warp, but the valley never stops.

## 2. One continuous world

A single real-time simulation (`lib/sim/world/`). The whole platoon, the civilians, and any
active fighters all live in one persistent unit-level sim; a master clock layers the strategic
systems on top. The player is the outpost commander, and everything below happens on the same
timeline — quiet hours fast-forward, firefights slow to readable speed.

**What you command, continuously:**
- **Personnel** — roster, squads/fireteams, rest/fatigue that recover at the wire and drain in
  the field, morale, wounds & recovery over real days, specialties (medic, JTAC/RTO, SAW/240
  gunners, marksman). Losses are permanent.
- **Operations** — select soldiers and order them directly (move with a posture, assault, hold,
  suppress, smoke, frag, withdraw), or **plan a patrol**: pick a mission and posture, draw a
  route, and the element musters in the yard, files out the gate, and moves to its objective **as a
  squad** — a squad leader and two fire teams in a doctrinal formation (file/wedge/column/dispersed
  chosen from mission, terrain and whether contact is expected), point man navigating the ground,
  every man pulling a security sector. Missions: presence, recon, ambush/interdiction, census,
  cordon-and-search, establish OP.
- **Influence** — send an element for a **shura** (KLE) with a village elder, fund **CERP
  projects** (wells, schools, roads) that require materials trucked in, a contractor, and a
  squad keeping the site secure for days, or they stall and get sabotaged.
- **Logistics** — ammo by caliber, water, food, fuel, medical, batteries, mortar rounds, and
  construction materials, burning continuously. Resupply by convoy (risky/IED) or air
  (weather-dependent).
- **Fires & MEDEVAC** — 60/81 mortars, CAS gun runs and Hellfire, 9-line MEDEVAC, with delays,
  danger-close risk, and weather/availability constraints. Available the moment you need them.
- **Intel** — SIGINT (ICOM), HUMINT (informants of varying reliability), drone hits, pattern of
  life. An often-wrong picture of enemy disposition.
- **Higher** — battalion issues directives and judges you on stability and losses.

**Combat** is just what happens when hostile units perceive each other. The clock clamps to
combat speed; you fight with the same selection-and-orders interface, and the fight resolves
through the ballistics + LOS + cover model. The enemy maneuvers, breaks contact, or is destroyed,
and your patrol resumes its task on the lull.

## 3. Simulation systems (engine: `lib/sim`)

| System | Module | Summary |
|---|---|---|
| RNG | `rng.ts` | Seeded mulberry32 + helpers (range, gauss, chance, pick, weighted). Deterministic. |
| Math | `vec.ts` | Grid/world vectors, distance, bresenham, hex/grid helpers. |
| Terrain | `terrain.ts` | Procedural 5 m valley (ridges/draws/river/villages), 24 landcover classes, a fortified **COP layout** (HESCO wall, gate, structures, LZ, fighting positions), queries: elevation, slope, cover, concealment, move cost, passability. |
| Pathfinding | `path.ts` | Hierarchical A* (cheap coarse route + fine repair only where it would clip a wall) with concealment / road / cover biases; reused scratch; funnels through the COP gate. |
| LOS | `los.ts` | Elevation raycast with observer/target height + vegetation occlusion → visible/partial, exposure fraction; posture-aware detection. |
| Weapons | `weapons.ts` | Full weapon table (US + insurgent) with ballistic & handling stats. |
| Ballistics | `ballistics.ts` | Per-projectile flight, hit resolution vs exposure/skill/suppression, wound model. |
| Entities | `entities.ts` | Soldier/insurgent/civilian types, stats, state, factories, **move postures**. |
| Combat | `combat.ts` | The fixed-timestep unit tick (orders → AI → movement → fire → projectiles → morale); runs in persistent mode inside the World. |
| AI | `ai/*.ts` | Insurgent (ambush/shoot-scoot/withdraw), civilian (routine/flee/atmospherics), friendly (autonomy under orders). |
| Names | `names.ts` | US roster + Afghan name generation. |
| Campaign | `campaign.ts` | Shared strategic types + helpers (supplies, villages, weather, scoring). |
| Squad movement | `world/formation.ts` | Doctrinal squad movement composed on the squad-leader + two fire-team echelon: formation by mission/terrain/threat, point navigation, security sectors, pace governor. |
| Garrison | `world/garrison.ts` | Garrison life inside the wire: rotating guard roster, gun crews, chow/barracks/TOC/aid by time of day, whole-COP stand-to. |
| World | `world/*.ts` | The continuous clock + orchestration: time-of-day, tasks, projects, resupply, enemy director, intel, events, metrics, save/load. |

### 3.1 Coordinate model
World is a square grid of **cells** (default 512×512), each cell **5 m** → a ~2.56 km valley
resolved to high fidelity. Heightmap stored as Float32 elevation (meters). Units live at
continuous world coordinates (meters) for smooth ballistics; the grid is sampled bilinearly for
elevation. Landform-generation frequencies are expressed per-meter so the valley looks right at
any resolution. LOS marches a fixed ~6 m step (decoupled from cell size) to stay cheap.

### 3.2 Line of sight & concealment
- LOS samples the terrain profile between observer eye and target center/limbs.
- An intervening terrain sample above the sightline → blocked (dead ground / defilade).
- Vegetation (forest, holly/oak scrub of the Korengal) and structures add probabilistic
  occlusion and **concealment** (can't be seen) distinct from **cover** (stops bullets).
- Output: `{visible, exposure∈[0..1], rangeM, concealment, cover}`.

### 3.3 Ballistics & hit model
For each shot: pick aimpoint, apply dispersion (shooter MOA × stance × suppression × motion
× fatigue), spawn a projectile with velocity vector. Each tick advances it; on reaching the
target's vicinity, resolve hit probability = f(exposure, cover, range vs effective range,
target motion, posture). Suppression accrues to anyone near the round's path/impact. Hits roll
location & severity → KIA / wounded (bleeding, mobility/accuracy penalty) / armor save.

### 3.4 Morale & human factors
Each combatant has **composure** (drains under fire, restored by leadership/cover/cohesion)
and **suppression** (spikes, decays). Low composure → reduced accuracy, hesitation, seeking
cover, refusal to move, panic/rout. Leaders project composure in a radius. Fatigue from
movement/altitude/heat/heavy loads degrades everything. Over a deployment: stress, the
boredom/terror cycle, and bonds between soldiers.

### 3.5 Insurgent doctrine (AI)
- Prefer high ground & defilade; engage at the edge of effective range; mass RPG+PKM at
  the kill zone; use spotters and ICOM.
- "Shoot and scoot": fire a few magazines, displace before mortars/CAS arrive.
- Break contact when suppressed, when taking casualties, or when air shows up.
- Use complex ambush: initiate with IED/RPG, L-shaped small arms.
- Meld into civilians; cache weapons; fight harder defending home villages.
- Difficulty & "valley heat" scale numbers, skill, aggression, and coordination.

### 3.6 Civilian model (AI)
- Daily pattern of life (fields at dawn, mosque, market, herding, home by dusk).
- **Atmospherics**: sudden absence of civilians/children = imminent contact (the "calm
  before"). Player can read this. Presence near fighters complicates fire.
- Attitude per village ∈ hostile…neutral…friendly, shifted by: civcas, property damage,
  respectful behavior, projects delivered, security provided, broken promises, night raids.
- Flee under fire; can be hit by stray/indirect fire → major attitude & higher-command hit.

### 3.7 Squad movement (doctrine, not dots)
A patrol moves as a **US infantry squad** — a squad leader plus two four-man fire teams (team
leader, automatic rifleman, grenadier, rifleman) — composed on that structure:
- The element musters in the COP yard, files out the **gate**, and moves to its objective in a
  **formation** chosen by doctrine: *file* in restrictive ground or moving stealthy, *staggered
  column* on an admin road march, *wedge* for movement to contact, *dispersed* (teams abreast) when
  contact is expected. Interval opens up when contact is likely and tightens in close terrain.
- The lead team's leader navigates the terrain (A*) with a rifleman on point; his SAW and grenadier
  hold the flanks; the squad leader follows controlling with the medic/RTO; the trail team watches
  the backtrail. Every man pulls a **security sector** — 360° coverage on the move.
- The rest of the squad moves in **trace**: the point man's route is recorded as a breadcrumb, and
  each man keeps to it a set distance back, opening out to his fire-team position with a lateral
  offset taken from the *local* trail tangent. So the element follows the leader's real path through
  the ground — collapsing to single file at a choke or river crossing and spreading again after —
  instead of swinging rigid geometric slots around his heading (which made the formation pivot like a
  turnstile whenever he turned).
- The point man **paces** the element so it stays together by easing the throttle when the squad
  strings out — a smooth slowdown, never a dead stop, so a man hung up on an obstacle is left to
  chase and rejoin rather than freezing the whole patrol. Routing honors the posture (hug cover when
  stealthy, take the road when fast, never the obvious road into an ambush). On the objective each
  fire team sets a sector of a 360° security halt. Contact dissolves the formation into the combat
  AI; it re-forms on the lull.

### 3.8 The combat outpost
The COP is a **place**, not a marker: a HESCO-walled perimeter with a single entry-control point,
interior structures (TOC, barracks, aid station, armory, chow hall), a motor pool and helicopter
LZ, and crew-served fighting positions and towers on the wall — all stamped into the terrain so
cover, sight and pathing respect the wire. It is sited like the real Korengal Outpost — on a
**commanding bench or low spur near the valley** (a few tens of metres above the floor, close enough
to be supplied by road), not an alpine perch — and reached by a **narrow switchbacked access road**
that follows the terrain down to the valley road, grading the ground only enough to keep the tread
walkable instead of bulldozing a straight ramp. Off-task soldiers **live** there: a rotating guard pulls
security, gun crews stay on their guns, the platoon eats at the chow hall on the meal hours and
sleeps in the barracks after dark, and the whole COP **stands to** when the wire takes fire.

## 4. Campaign loop
A deployment of configurable length (e.g., 60–270 in-game days) on one continuous clock.
- Order soldiers directly or plan patrols/KLEs/projects; everything takes time on the map.
- Quiet hours fast-forward (press to skip to the next event); combat slows to readable speed.
- Random decision points pause time for a choice. Battalion directives create objectives
  (presence in every village, meet the elders, census, interdict, build).
- Scoring across: **Valley Stability**, **Village Attitudes**, **Enemy Strength**,
  **Your Combat Power** (men & materiel), **Higher Command Confidence**. No simple "win" —
  a reflective end-of-tour after-action that grades the deployment, heavily penalizing losses.

## 5. Rendering & UI
- **One live surface** (`WorldView`): Canvas 2D. Hillshade (relief) + contour lines + landcover
  tint + grid + markers (COP, villages, project sites, suspected enemy, patrol route, intel) +
  units, facing, stance, LOS lines, tracer fire, smoke, impacts, suppression/morale state, fog of
  war. Pan/zoom, select (click/box), order tools, plan-mode waypoints, fire-support targeting.
- **Aesthetic**: dark tactical "command post" theme — desaturated olive/tan/charcoal, mono
  for data, map ink for the topo. Readable, dense, military map symbology (MIL-STD-2525-ish).
- **HUD**: top command bar (clock/light/weather/metrics + pause/speed/warp), left column
  (active elements, directives, intel, log), right column (patrol planner / village panel +
  logistics), bottom order bar & fire-support panel.

## 6. Documentation deliverables
- This design doc + a **wiki** (`docs/wiki/`) covering systems, weapons, tactics, glossary.
- **HTML user manual** (`public/manual/index.html`) — full reference.
- **HTML tutorial** (`public/manual/tutorial.html`) — guided walkthrough.
- **In-game interactive tutorial** — scripted first patrol that teaches the controls.
- A **glossary** of the milspeak (TIC, QRF, CASEVAC, danger close, KLE, defilade, …).

## 7. Build order
1. Engine foundation: rng, vec, terrain, los. ✅ first
2. Weapons, ballistics, entities. 
3. Combat tick + AI (insurgent/civilian/friendly).
4. Campaign + patrol + events.
5. Zustand store + React bridge.
6. Topo map renderer + tactical renderer.
7. HUD, screens, order flow, fire support.
8. In-game tutorial.
9. Docs: wiki, HTML manual, HTML tutorial.
10. Polish, balance, build & verify.
