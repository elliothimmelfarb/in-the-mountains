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
  **returns** through the gate. **Dwell is hours, not minutes** (`dwellFor` — census/cordon a
  population-driven 2–8 h half-day, KLE 1–2 h, an OP 5 h, ambush 4 h, presence ~1 h): real operations
  take real time, and the player **warps** the patient hours (skip-to-event halts on a decision). The
  **census is progressive** (`village.censusProgress` climbs with time on station; "done" trips only at
  1) — recall early and it's partial, and it persists for a follow-up. While an element works a
  census/cordon/shura, a throttled **dwell event-roll** surfaces a decision — a weapons-cache find, a
  biometric watch-list hit, the FET gap at the women's quarters, a herder's solatia grievance (the
  *Restrepo* "Cow Incident"), a squirter bolting the cordon — each a `PendingEvent` the warp loop stops
  on. The squad carries a **SOP** — its standing orders for the patrol. If a
  `sop` is supplied it is **authoritative** (the movement technique derives from it via `sopTechnique`,
  overriding the bare `technique` argument); otherwise the SOP is seeded from the mission type
  (`defaultSOP`). Combat AI takes over the instant rounds crack — it runs the SOP's on-contact drill
  (see Simulation Systems → Squad combat) — and the task resumes on the lull. Missions: presence,
  recon, ambush/interdiction, census, cordon & search, establish OP.
- **KLE** — `conductKLE(ids, village, technique, sop?)`: send a squad to a village to hold a shura;
  attitude/cooperation and intel accrue over the dwell. As with patrols a supplied `sop` is
  authoritative and drives the movement technique; without one a KLE goes in friendly by default —
  patrol tempo, hold on contact, weapons tight. A shura also yields an **elder ASK** (see *Asks &
  promises* below).
- **Secure-build** — `secureBuild(ids, village, technique, sop?)`: assign an element to **garrison a
  CERP project site**. It routes to the village via the normal reachability-aware pathing (no
  beeline), then holds an **open-ended all-round overwatch** — no dwell timer; it returns only when
  the project it's securing **completes or is sabotaged**, or you recall it. This is the order that
  drives a project to completion: `tickProjects`' security gate counts a held secure element.
- Elements can be **recalled** at any time.

## Projects — logistics & patience (`projects.ts`)

`startProject(village, type)` spends CERP up front, then a `Project` runs through stages on the
clock: **awaiting materials** (construction supplies must be trucked in — short stocks delay it) →
**awaiting contractor** (local labor brought on) → **building**. Building only progresses while a
friendly element is **securing the site** — a dedicated **secure-build** element holding the village,
or any ≥2 soldiers within ~80 m. Leave it unsecured and the insurgents intimidate the crew — the work
**stalls and can be sabotaged**, regressing progress and hardening the village. Finishing wins an
attitude swing that **depends on the project type and whether the village wanted it** (`PROJECT_PAYOFF`
× 1.6 for a wanted/asked-for type, × 0.6 off-want — FM 3-24: deliver what they *need*), partially
**reimburses CERP** (+$1,500), nudges higher confidence, and feeds the construct directive. A clinic
the elder asked for moves a village far more than a culvert nobody wanted. A well or clinic is days of
secured work, not a purchase.

## CERP — a managed budget, not a countdown

CERP is **two-way**. It drains when you fund projects (−$5,000) and pay solatia/informants, and it
**refills** from two income paths: a **battalion stipend** on a steady ~weekly cadence (`tickCerp`,
$5,000–$11,000, scaled by higher confidence — a commander Higher trusts gets more discretionary
funds), and a **+$1,500 reimbursement** for each delivered project. So CERP is a budget to manage
across the tour, not a one-way meter that runs dry.

## Asks & promises (the broken-promises mechanic)

A shura can produce an **elder ask** (`raiseElderAsk`): a concrete request — a specific **project**,
a **security** presence, patrol **restraint**, or a **prisoner** release — with a deadline a few days
out. Follow through and it's a **kept promise** (`fulfillAsk`: attitude +10, cooperation +8, a little
higher confidence). Let the deadline lapse and it's a **broken promise** (`tickPromises`: attitude
−12, sympathy +8) — deliberately **asymmetric**, because a broken promise costs more trust than a kept
one buys. Building the asked-for project or holding a secure element on the village for ~an hour
fulfills the matching ask automatically.

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

## Directives — pressure from Higher (`directives.ts`)

Battalion **tasks you on a deadline**. Two directives are issued at deploy (presence, KLE), then a
**steady cadence** (`tickDirectives`/`issueDirective`, ~1 per 6–9 days) draws fresh ones from the AO:
**interdict** when the enemy is strong, **hold** when a village is hostile, **construct** when CERP is
on hand, plus a rotation of **census / presence / KLE / casualty** (protect-the-population). Each
carries a **reward** (higher confidence if delivered) and a **penalty** (if its deadline elapses while
still active — `status → "failed"`, confidence docked). Completion is real for every kind: presence by
visiting all villages, census by 3, KLE/construct by their producers, **interdict** by driving
`enemyStrengthAbs` down from its issue-time snapshot, **hold** by clearing all hostile villages,
**casualty** by reaching the deadline with **no civilian casualty since issue** (one civcas fails it
immediately). Neglecting the valley to chase body count now **costs you Higher's trust**.

## Metrics & scoring

Five 0–100 metrics: **Stability** (a slow blend of attitudes, enemy strength, and combat power),
**Attitude** (mean village disposition), **Enemy Strength** (the pool; attrition lowers it),
**Combat Power** (ready troops + ammo), **Higher Confidence** (battalion's faith — zero relieves you
of command). The tour ends when the clock passes the tour length (or confidence hits zero).

`computeTourScore` grades **COIN, not kills**: attitude, stability and higher confidence dominate the
base, **enemy attrition is a small term** (you can win every firefight and still lose the valley);
delivered **projects**, completed **directives** and **kept promises** are direct rewards; **civilian
casualties** (the heaviest), **broken promises**, **failed directives** and **KIA** are penalties. A
patient hearts-and-minds tour and a reckless body-count tour produce **meaningfully different scores**.

## Events (`events.ts`)

Occasional decision points that **pause time** until you choose: walk-in informant, sick child,
elder complaint/solatia, resupply window. Each trades resources, risk, attitudes, intel, or
confidence — there are no free choices. A second pool, `makeDwellEvent`, fires **on-station** while a
squad works a census/cordon/shura (cache find, biometric hit, FET gap, grievance, squirter, MEDCAP,
tip) — same modal machinery, gated by mission and never the same kind twice in a row.
