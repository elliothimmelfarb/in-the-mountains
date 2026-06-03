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

## 2. Two layers

### 2.1 Command layer (the COP)
Turn-based, phase-of-day resolution (Dawn / Day / Dusk / Night). The player is the outpost
commander. Responsibilities:
- **Personnel** — roster, squads/fireteams, assignments, rest rotation, morale, fatigue,
  wounds & recovery, specialties (medic, JTAC/RTO, SAW/240 gunners, snipers, EOD, ANA partner).
- **Logistics** — ammo by caliber, water, food, fuel, medical, batteries, mortar rounds,
  Class I–IX. Resupply via convoy (risky/IED) or air (weather-dependent). Everything is heavy.
- **Defense** — guard rotation, sectors of fire, crew-served emplacements, HESCO, wire,
  claymores, range cards, standing to.
- **Operations** — plan patrols and missions on the topo map: presence patrols, ambushes,
  KLE/shura, census, overwatch, cordon-and-search, recon, resupply escort, CASEVAC.
- **Influence** — shuras with village elders, CERP money for projects (wells, schools, roads),
  solatia payments after incidents, ANA/ANP partnering, claims.
- **Intel** — SIGINT (ICOM chatter), HUMINT (informants of varying reliability), pattern of
  life, atmospherics. Builds a (often wrong) picture of enemy disposition.
- **Higher** — battalion issues directives, CONOP approval, judges you on stability and losses.

### 2.2 Contact layer (tactical sim)
Real-time-with-pause. Triggered by a patrol making contact (TIC), an enemy attack on the COP,
or a deliberate op. Squad/individual control on the topo grid:
- Orders: move (with movement technique — traveling, bounding), take cover, fire/cease fire,
  suppress, target, throw frag/smoke/willie-pete, treat casualty, regroup, withdraw.
- Fire support: call for fire (60/81/120 mortars), CAS/CCA (A-10, Apache, drone), MEDEVAC
  (9-line), with realistic delays, danger-close risk, and weather/availability constraints.
- Every shot resolved through the ballistics + LOS + cover model. Suppression and morale
  ripple through both sides. The enemy maneuvers, breaks contact, or is destroyed.

## 3. Simulation systems (engine: `lib/sim`)

| System | Module | Summary |
|---|---|---|
| RNG | `rng.ts` | Seeded mulberry32 + helpers (range, gauss, chance, pick, weighted). Deterministic. |
| Math | `vec.ts` | Grid/world vectors, distance, bresenham, hex/grid helpers. |
| Terrain | `terrain.ts` | Procedural valley heightmap (ridges/draws/river/villages), landcover, queries: elevation, slope, cover, concealment, move cost. |
| LOS | `los.ts` | Elevation raycast with observer/target height + vegetation occlusion → visible/partial, exposure fraction. |
| Weapons | `weapons.ts` | Full weapon table (US + insurgent) with ballistic & handling stats. |
| Ballistics | `ballistics.ts` | Per-projectile flight, hit resolution vs exposure/skill/suppression, wound model. |
| Entities | `entities.ts` | Soldier/insurgent/civilian types, stats, state, factories. |
| Combat | `combat.ts` | The fixed-timestep tactical tick: orders → AI → movement → fire → projectiles → morale → events. |
| AI | `ai/*.ts` | Insurgent (ambush/shoot-scoot/withdraw), civilian (routine/flee/atmospherics), friendly (autonomy under orders). |
| Names | `names.ts` | US roster + Afghan name generation. |
| Campaign | `campaign.ts` | Strategic state, phase advance, attrition, attitudes, intel, directives, scoring. |
| Patrol | `patrol.ts` | Route planning, march resolution, contact probability, encounter seeding. |
| Events | `events.ts` | Atmospheric & random events (weather, equipment, HUMINT walk-ins, IEDs). |

### 3.1 Coordinate model
World is a square grid of **cells** (default 128×128), each cell ~25 m → a ~3.2 km valley.
Heightmap stored as Float32 elevation (meters). Tactical units live at continuous world
coordinates (meters) for smooth ballistics; the grid is sampled bilinearly for elevation.

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

## 4. Campaign loop
A deployment of configurable length (e.g., 90–365 in-game days). Each day = 4 phases.
- Plan & launch patrols/ops; resolve marches; drop into tactical on contact.
- Manage the COP between events. Random & scripted events punctuate.
- Battalion directives create objectives (build the valley road, set up an OP on the
  ridge, census the villages, interdict the rat lines).
- Scoring across: **Valley Stability**, **Village Attitudes**, **Enemy Strength**,
  **Your Combat Power** (men & materiel), **Higher Command Confidence**. No simple "win" —
  a reflective end-of-tour after-action that grades the deployment.

## 5. Rendering & UI
- **Topo strategic map**: Canvas 2D. Hillshade (relief) + contour lines + landcover tint +
  grid + markers (COP, OPs, villages, known/suspected enemy, patrol routes, intel). Pan/zoom,
  click-to-route, waypoints, measure.
- **Tactical view**: Canvas 2D over the same terrain at higher zoom. Units, facing, stance,
  LOS fans, tracer fire, smoke, impacts, suppression/morale state, selection & order UI.
- **Aesthetic**: dark tactical "command post" theme — desaturated olive/tan/charcoal, mono
  for data, map ink for the topo. Readable, dense, military map symbology (MIL-STD-2525-ish).
- **HUD**: top command bar (clock/phase/weather/alerts), left roster/unit panel, right
  intel/log feed, bottom order bar & fire-support panel.

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
