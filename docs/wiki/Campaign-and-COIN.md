# Campaign & Counterinsurgency

The strategic layer lives in the `lib/sim/world/` package, built on shared types in `campaign.ts`.
There are **no turns and no phases** — one continuous clock runs the whole deployment, and the
Zustand store's real-time `frame` loop drives it.

## State

`WorldState` holds the seed, tour length (days), the master `clock` (game-seconds since 0600 day 1),
weather, `Supplies` (now including **construction** materials), CERP funds, `VillageState[]`, an
`IntelReport[]` feed, `Directive[]`, five `Metrics`, the COP/FOB state, the absolute enemy pool
(`enemyStrengthAbs`), current `enemyHeat`, active `Task[]` and `Project[]`, inbound resupplies, and a
log. The `Platoon` members **are** the live sim units, so combat mutates the roster directly.

## The continuous clock

`World.tick(dt)` (stepped in fixed 0.1 s slices by the store) advances `clock`, recomputes the sun
(smooth dawn/dusk ramps and a real day/night cycle that drives light and detection), and runs each
subsystem at continuous rates:

- **Supplies** burn with headcount (water/food/batteries) over time.
- **Soldiers** at the COP recover rest and fatigue (faster at night); tasked soldiers tire.
  Long-arc morale drifts toward the state of the fight. Wounded recover over real days.
- **Weather** re-rolls every few game-hours, gating air support.
- **Intel** generates on a heat-scaled cadence (SIGINT chatter, HUMINT from cooperative villages,
  night drone hits).
- **Metrics** and **enemy heat** ease toward targets set by attitudes, stability, and instability.

Time is **pausable** and **time-warpable**: combat clamps the clock to readable speed, and "skip to
next event" fast-forwards the quiet hours, stopping on the first thing that matters.

## Tasks — everything takes time (`tasks.ts`)

Strategic orders are `Task`s that progress on the clock:

- **Patrol** — `formPatrol(ids, route, mission, technique, sop?)`. You pick a fixed squad and draw a
  waypoint route; the element **musters** in the COP yard and kits up for a minute or three, **files
  out the gate**, then **moves to its objective as a squad** — the squad leader and two fire teams in
  a doctrinal formation (see Simulation Systems → Squad movement), terrain-routed (A*) at the squad's
  movement tempo — **dwells** in a 360° security halt on the objective (mission effects accrue), then
  **returns** through the gate. The squad carries a **SOP** — its standing orders for the patrol. If a
  `sop` is supplied it is **authoritative** (the movement technique derives from it via `sopTechnique`,
  overriding the bare `technique` argument); otherwise the SOP is seeded from the mission type
  (`defaultSOP`). Combat AI takes over the instant rounds crack — it runs the SOP's on-contact drill
  (see Simulation Systems → Squad combat) — and the task resumes on the lull. Missions: presence,
  recon, ambush/interdiction, census, cordon & search, establish OP.
- **KLE** — `conductKLE(ids, village, technique, sop?)`: send a squad to a village to hold a shura;
  attitude/cooperation and intel accrue over the dwell. As with patrols a supplied `sop` is
  authoritative and drives the movement technique; without one a KLE goes in friendly by default —
  patrol tempo, hold on contact, weapons tight.
- Elements can be **recalled** at any time.

## Projects — logistics & patience (`projects.ts`)

`startProject(village, type)` spends CERP up front, then a `Project` runs through stages on the
clock: **awaiting materials** (construction supplies must be trucked in — short stocks delay it) →
**awaiting contractor** (local labor brought on) → **building**. Building only progresses while a
friendly element is **securing the site** (≥2 soldiers within ~80 m); leave it unsecured and the
insurgents intimidate the crew — the work **stalls and can be sabotaged**, regressing progress and
hardening the village. Finishing wins a big attitude swing and feeds the construct directive. A well
or clinic is days of secured work, not a purchase.

## Resupply

`requestResupply("convoy" | "air")` schedules an inbound run with an ETA. A **convoy** brings a full
load but can be **ambushed on the road** (spawning a live fight); **air** is partial and scrubbed by
weather. Resupply restocks ammo, mortars, medical, food/water, and construction materials.

## Enemy director (`director.ts`)

`runDirector` sets the valley's tempo. On a clock that quickens at night and with heat, it stages:
**ambushes** astride your patrols (or near hostile villages), **infiltrations** through the draws
toward villages (concealed movement you can intercept), **harassment** from distance, and the
occasional **complex attack** on the COP. Spawn positions are chosen for elevation, concealment,
cover, and LOS to the target; fighters route in through the terrain.

## Counterinsurgency

Each `VillageState` has an attitude (−100…+100), cooperation (intel willingness), hidden sympathy,
and what it `wants` (a project type). Raise attitude by showing up (presence), shuras, and finished
projects. Cooperative villages feed better HUMINT. Civilian casualties are catastrophic: villages
harden, sympathy and heat rise, and battalion confidence drops.

The fight feeds this ledger too, through the squad's **ROE**. Every friendly shot passes a
**civilian-fire gate** (`civClear`): under **Tight** ROE — the COIN default — a soldier holds fire
rather than put a round near a civilian in the kill zone, where **Free** lets it fly and **Hold**
keeps weapons cold. Each held shot is recorded as a **restraint** event, and the nearest village
notices — a small, slow gain in attitude and cooperation and a dip in sympathy. It will never offset
a single civcas (an order of magnitude larger), but disciplined patrols that eat fire rather than
risk the qalat are how you actually buy the valley's trust. You set ROE in the squad SOP before
step-off; it locks once the squad is in contact.

## Metrics & scoring

Five 0–100 metrics: **Stability** (a slow blend of attitudes, enemy strength, and combat power),
**Attitude** (mean village disposition), **Enemy Strength** (the pool; attrition lowers it),
**Combat Power** (ready troops + ammo), **Higher Confidence** (battalion's faith — zero relieves you
of command). The tour ends when the clock passes the tour length (or confidence hits zero);
`computeTourScore` grades it with a heavy penalty per soldier killed.

## Events (`events.ts`)

Occasional decision points that **pause time** until you choose: walk-in informant, sick child,
elder complaint/solatia, resupply window. Each trades resources, risk, attitudes, intel, or
confidence — there are no free choices.
