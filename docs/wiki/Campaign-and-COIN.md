# Campaign & Counterinsurgency

The strategic layer lives in `campaign.ts`, with mission/contact logic in `patrol.ts` and decision
points in `events.ts`. The Zustand store orchestrates the loop.

## State

`CampaignState` holds the seed, day/phase, tour length, weather, the `Platoon` (roster + squads),
`Supplies`, CERP funds, `VillageState[]`, an `IntelReport[]` feed, `Directive[]`, five `Metrics`,
the COP/FOB state, the absolute enemy pool (`enemyStrengthAbs`), the current `enemyHeat`, ambient
civilians, and a log.

## Phases of day

Each day is four phases (Dawn / Day / Dusk / Night), each with a light level folded with weather.
`advancePhase(state, rng)`:

- Rests & heals soldiers at the COP; recovers the wounded over days.
- Consumes water/food/batteries.
- Generates intel (SIGINT chatter scales with heat; HUMINT from cooperative villages; drone hits at
  night), updates **enemy heat** toward a target set by hostility and instability, recomputes
  metrics, checks directive deadlines, and checks for end-of-tour.

The store additionally rolls a chance of a **COP attack** (much higher at night and high heat) and
otherwise a chance of a **decision event**.

## Patrols & contact (`patrol.ts`)

A `PatrolPlan` is a mission type, a set of member ids, and a cell route. `resolveMarch` walks the
route and rolls **contact probability** per stretch from terrain danger (forest/scrub, choke
points), distance from the COP, nearby hostile villages, intel hotspots, mission type, and time of
day. On contact, `buildEncounter` clones the patrol into fresh combatants in a dispersed column,
seeds insurgents into good ambush positions (uphill, concealed, with LOS to the kill zone via real
`lineOfSight` checks), spawns a few civilians from a nearby village, wires up COP mortars in range
and weather-gated CAS, and hands a `CombatInit` to a new `CombatSim`. `buildBaseDefense` builds the
COP-attack scenario.

No-contact patrols still pay off by mission type (presence raises attitudes and progresses the
presence directive; recon/census/KLE produce intel/census/relationship gains).

## Counterinsurgency

Each `VillageState` has an attitude (−100…+100), cooperation (intel willingness), and hidden
sympathy. The player raises attitude via **shuras** (`conductShura`) and **CERP projects**
(`fundProject`), and via simply showing up. Cooperative villages feed better HUMINT. Civilian
casualties (`applyCombatResult`) are catastrophic: every village hardens, sympathy and heat rise,
and battalion confidence drops.

## Metrics & scoring

Five 0–100 metrics: **Stability** (a slow blend of attitudes, enemy strength, and combat power),
**Attitude** (mean village disposition), **Enemy Strength** (the pool; attrition lowers it),
**Combat Power** (ready troops + ammo), **Higher Confidence** (battalion's faith — zero relieves you
of command). `computeTourScore` grades the deployment, with a heavy penalty per soldier killed.

## Events (`events.ts`)

Data-driven decision points with declarative choices applied by `applyEventChoice`: walk-in
informant, sick child, ANA friction, suspected IED, elder complaint/solatia, resupply window
(convoy vs. air), detainee handling. Each trades resources, risk, attitudes, intel, or confidence —
there are no free choices.
