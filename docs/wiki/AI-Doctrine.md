# AI Doctrine

Combat in the valley is **100% AI**. The player is a commander on the radio, not a trigger man: you
set where a squad goes, how it moves, what battle drill it runs on contact, and the rules of
engagement — then you read the net and live with how it plays out. Once a squad is in contact you do
not steer a single soldier. There is no man-select, no order tool, no manual target lock. Your
in-fight levers are narrow and deliberate: **approve or deny a call-for-fire**, **call the MEDEVAC**,
and the **SOP and route you set before step-off**.

Four brains in `lib/sim/ai`. Three are per-man brains — `(sim, unit, dt)` pure functions called every
tick (`friendlyBrain`, `insurgent`, `civilianBrain`). Above the friendly per-man brain sits a
squad-level coordinator, `squadFight` (`squad-combat.ts`) — the squad leader's tactical brain, run
from the world tick once per squad. The per-man brains read the sim through public helpers
(`acquireTarget`, `los`, `findCover`, `moveTo`, `nearestCasualty`, `throwSmoke/throwFrag`, `addLog`,
`enemyFireMission`, `civClear`) and mutate the unit's brain state; movement and firing are then
executed by the core tick. The coordinator decides; the per-man brains execute.

## Insurgent (`insurgent.ts`)

A small state machine modeling real valley doctrine:

- **ambush** — hold fire, concealed, low. Initiate when a target enters the kill zone (a range
  scaled by aggression) or patience runs out. If *nothing ever comes into the sights*, the fighter
  eventually melts away (exfil) or repositions — so ambushers never deadlock the engagement.
- **IED-initiated complex ambush** (`director.spawnIedAmbush`, `combat` IED system) — the signature
  valley opener: a charge is buried ahead of a patrol and an L-shaped cell lies in wait with weapons
  **tight** (`iedInit` — they will not trigger on small arms, no matter how close the patrol gets).
  The **charge** command-detonates as the point man enters the kill zone and the whole cell springs
  hold→engage at once. The device is buried (invisible); only ICOM chatter betrays it.
- **Indirect harassment** (`director.spawnIndirectHarass` → the now-live `enemyFireMission`) — in a
  hot valley a tube team lobs 82mm from defilade onto the COP or a pinned patrol (large CEP — it
  harasses and occasionally catches someone), telegraphed by ICOM. You can't storm a HESCO COP, so
  the enemy shells it.
- **engage** — fire from cover/defilade; relocate toward cover if exposed. After a spell, or when
  pressured (suppressed / rounds landing near), transition to **scoot**.
- **scoot** — hold fire, displace to a fresh covered firing position (`findCover` biased away from
  the threat), then re-engage. This is the signature "shoot and scoot."
- **patrolling** — for meeting engagements (player ambush): move along a route until taking fire or
  spotting the patrol, then engage.
- **exfil** — break contact: move away from the nearest enemy and uphill toward the map edge; leave
  the field on reaching it.

**Break-contact triggers** (`shouldBreak`): badly wounded, low composure, air on station or heavy
indirect landing nearby, or isolated (few friends, many enemies). They fight hardest near their
villages (skill/aggression scale with valley "heat").

## Civilian (`civilian.ts`)

Unarmed, and meant to read as a **lived-in valley**, not particles. Each civilian reacts to armed men
in **four graduated tiers** (a continuous read of threat proximity + count + gunfire fear, with
rise-instant / fall-slow hysteresis) — plus a **fifth, pre-contact** branch and a **diurnal rhythm**:

- **Oblivious** — no armed men close: go about the day.
- **Melt-away** (the *calm before*) — a staged hostile is nearby but **no shot has been fired yet**:
  the villager quietly leaves the open ground and goes home — children first, walking not sprinting —
  so the fields *thin* over a few seconds and an alert player can **read the absence**. See below.
- **Wary** — armed men in the middle distance: stop, look up, watch them.
- **Clear-road** — a patrol bears down: step off its line to the field edge and let it pass.
- **Flee** — gunfire, a blast, or armed men right on top of them: bolt for home / dead ground.

**Role flavour** splits the crowd into people: a curious child drifts *in* for a look (never into the
flee band); an elder withdraws toward his compound; farmers/villagers stand aside and watch.

**Diurnal pattern of life.** The valley now keeps a day. The brain reads `sim.light` (the World's
deterministic ambient, written each tick from the solar clock) and an outdoor **occupancy** that is a
pure function of that light:
- **Full day** (light ≥ 0.85): everyone works the fields/market — full pattern of life.
- **Dawn / dusk ramp** (0.2–0.85): a *home-pull* grows smoothly as light falls; villagers drift home,
  **children and elders lean home earlier**. The occupancy rides the light, so the count is high at
  midday, climbs through dawn, and falls through dusk — *without* the brain ever having to tell a dawn
  apart from a dusk (the curve is symmetric in light; we model the occupancy, not the event).
- **Night** (light < 0.2): **indoors.** A still-out villager walks home (a far-caught one routes the
  track network back). The night-home drive **pre-empts Wary/Clear-road** — a villager merely wary of
  a distant armed man at 02:00 still wants to be inside, not frozen in a field — but yields to a real
  **Flee** (active danger wins). The residual handful still out at night are civilians correctly
  fleeing/clearing **infiltrators moving through the draws after dark**, not stranded by the logic.

**The melt-away tell (`#calm-before`).** In the *same* O(units) armed scan, the brain also flags
**staged** insurgents — an ambush cell holding (`brainState==="ambush"`) or an infiltrator moving
concealed (`"patrolling"`+`technique==="concealed"`), both alive but **not yet firing** — out to a
150 m sensing radius (wider than the 45 m armed-proximity ring, so the gentle melt fires at the
mid-distance *before* the they're-on-top Wary/Flee). Departures are **staggered** by a seeded
`rng.chance`, so the fields thin rather than teleport. This is the flagship COIN tell the tutorial
teaches; the engine now produces it. Verify with `scripts/atmospherics-probe.ts melt <seed>`.

Every trait/decision is derived from a pure hash of the unit id or the seeded RNG and the
deterministic `sim.light`, so the world stays **replay-deterministic** and `serialize()` is unchanged
(no new persisted fields). Their sudden absence is still the oldest tell in the valley; from the
friendly side a patrol **eases its pace (escalation of force)** to let a villager on the track clear
rather than barging through. All of it complicates fire and risks the COIN catastrophe of civilian
casualties. Headless metric: `scripts/atmospherics-probe.ts diurnal <seed>` (outdoor occupancy by hour)
and `… melt <seed>` (pre-contact drop).

## Friendly per-man brain (`friendly.ts`)

The per-man brain is the soldier filling the gaps the way trained infantry do: he reads the standing
intent the coordinator stamped on him (his fire posture, his brain state, his bound objective, the
ROE) and executes it — return fire, hit the dirt when rounds snap past, reload, drag and treat the
wounded, keep fighting unless he is pinned and leaderless. When a patrol is *moving without contact*
the squad is steered as a composed echelon by `world/formation.ts` (point navigation, fire-team
formation, security sectors, pace governor) and the garrison routine runs at the COP
(`world/garrison.ts`); the instant rounds crack those release, the squad coordinator wakes, and this
brain takes over each man individually, re-forming on the lull.

- **Posture** down in contact (prone/crouch by cover), stand only when moving without contact.
- **Pinned & leaderless** → hunker and crawl to the nearest cover; leaders within ~35 m steady them.
- **moving** → the instant rounds are effective or an enemy is seen, bound off the X to cover, go
  prone, and return fire (`suppressed_halt`), then resume the move once the suppression eases.
- **assault** (`orderType: "assault"`, set by the coordinator's maneuver split) → *fire and maneuver*,
  not a banzai walk: a man carrying an automatic weapon (SAW/240) holds cover and adds to the **base
  of fire** suppressing the objective while riflemen and leaders **bound** onto it under that fire.
- **withdrawing** → bound back toward the rally point the coordinator set, peeling fire as you go.
- **Casualty care is every soldier's job** (TCCC), not just the medic's: when a buddy goes down the
  nearest able man (one per casualty) breaks to him, **drags him to cover**, and applies a tourniquet.
- **Medics** auto-seek and stabilize the nearest casualty; they alone can stop **internal/junctional**
  bleeds, which a buddy's tourniquet cannot (the medic is essential for the wounds that kill slowly).
- **Buddy-down shock**: a man hit nearby drops the composure of his fire team and gives them a few
  seconds of the shakes; a string of losses can break an element. A squad that loses every leader
  **promotes its steadiest survivor**.

Target acquisition (`CombatSim.acquireTarget`) prefers close, exposed, and dangerous targets
(MG/RPG/sniper crews first), with a randomized weighting so an element's fire **spreads** across the
enemy instead of every gun converging on one man. Thermal-equipped men (marksman, sniper, JTAC,
weapons-squad gunners) acquire through foliage and in the dark where the naked eye and NVGs cannot.
Every individual shot then passes the **civilian-fire gate** (`CombatSim.civClear`) before it goes
out — see the squad-combat doctrine below.

## Friendly squad-combat doctrine (`squad-combat.ts`)

`squadFight` is the squad leader the player used to be. It is invoked once per deployed squad from the
world tick (`tickTasks`), which runs **before** `sim.tick`, so a decision lands the same tick the men
act on it. It only **decides**: it stamps the same per-man intent fields (`rof`, `brainState`,
`orderType`, `orderTarget`, `roe`) that `friendlyBrain` already executes. Squad-level decisions are
throttled (`RECONSIDER`, ~1.2 s) — the per-man brains fill the gaps every tick. Every pass it also
pushes the squad ROE onto each man (the civ-fire gate reads it) and drops the march locks, because the
parade formation does not hold in a firefight.

The whole command surface for a fight is set **before** step-off, in the squad's standing SOP
(`world/types.ts:SquadSOP`), and **locks** once the squad is in contact. Three settings, seeded with
sensible defaults by mission type (`defaultSOP`):

- **MOVEMENT** — Stealth / Patrol / Fast — how the squad moves to its waypoints (slow & hugging cover,
  balanced, or a road march).
- **ON CONTACT** — Hold & Return Fire / Suppress & Call Fires / Assault / Break Contact — the standing
  battle drill the coordinator runs the instant it makes contact.
- **ROE** — Weapons Hold / Tight / Free — the civilian-fire rules every friendly shot is vetted against.

### The contact FSM — react → hold / suppress / assault / break

The coordinator mirrors the state-machine shape of `insurgent.ts` (FM 3-24 / Battle Drill 1A,
React to Contact):

- **react** — first contact. *Everyone* orients on the threat, gets into the nearest cover, and
  returns fire as the ROE allows while the leader sizes up the fight (CONTACT report on the net,
  bearing to the threat). The next pass commits to the SOP's standing drill.
- **hold** (Hold & Return Fire) — fight in place from cover. Automatic weapons build a base of fire;
  riflemen engage PID'd targets. Holds the ground; does not maneuver.
- **suppress** (Suppress & Call Fires) — as *hold* but with everyone leaning on suppressive fire to
  pin the enemy, and the JTAC/leader raising a **call-for-fire** (below).
- **assault** (Assault Through) — the base-of-fire element pins the enemy while the maneuver element
  fire-and-moves onto the objective.
- **break** (Break Contact / Battle Drill 3) — leapfrog back to a rally toward home under covering
  fire and smoke.

### Base of fire vs. maneuver — the two fire teams

On an assault the coordinator splits the squad's **two fire teams** (`assignElements`, reading
`buildSquad`): each team is scored on automatic weapons (a SAW/240 weights heavily), the cover it is
already in, and how close its eyes-on is to the enemy. The higher-scoring team becomes the **base of
fire** — it stays in cover and hoses the objective (`rof: "suppress"`); the other becomes the
**maneuver element**. The SL and the HQ attachments (PL, medic, RTO, JTAC, if officers were sent) are
neither — they hold the center, self-defense only, ready to consolidate casualties. A single or broken
team can't bound safely, so everyone holds as base of fire.

### Bounding & screening smoke

The maneuver element **bounds** onto the objective: each man gets `orderType: "assault"` and
`friendlyBrain`'s assault path runs the per-man fire-and-move (auto-riflemen set their own local base
of fire, riflemen close under it), routing around walls and terrain with A* when a lane is blocked. If
a bound crosses open ground (`exposedRun`), the coordinator pops **one screening smoke** partway to
the enemy — a screen between the maneuver run and the enemy guns. Smoke is throttled on the world
clock (`SMOKE_COOLDOWN_S`, ~28 s; a screen lasts ~67 s) so a sustained drill doesn't burn the squad's
whole smoke load. Break Contact screens the same way — smoke between the squad and the enemy as the
peel goes back.

### The automatic break-contact safety

This is the one piece of "when to break" that is **not** a player dial. Every reconsider pass the
coordinator measures the squad's **effectiveness** (`effectiveness`): the fraction of the *assigned*
strength still conscious, un-evac'd, and not fully suppressed (the denominator is the strength at
step-off, so attrition still counts even as casualties are dragged off or MEDEVAC'd). If the squad has
become **combat-ineffective** — effectiveness below ~60%, or below ~78% with the squad leader down, or
a small element badly outnumbered — the coordinator **forces a break contact**, overriding the SOP.
You never feed a destroyed element into the fight; a squad that is being killed always disengages
itself.

The break drill leapfrogs: the men nearest the enemy lay a base of fire while the rest bound to a
**rally point** ~70 m back (`rallyPoint`, blending "away from the enemy" with "toward home" and
snapping to cover). Once the squad closes on that rally and is still in contact, the rally jumps
another bound back — without the leapfrog the squad froze at one rally and ate fire forever.

### Casualty handling & MEDEVAC

The per-man TCCC behavior is unchanged (buddy-aid, drag to cover, tourniquet; medics for the
slow-killing internal bleeds). What changed is who calls the bird: **MEDEVAC is AI-surfaced,
player-approved**. When a man is hit hard enough to need evacuation the AI raises it on the net (the
"WIA / MEDEVAC" interrupt); the **commander calls the 9-line** (`World.medevac`). The coordinator
keeps the squad fighting around the casualty — the effectiveness count already knows a man is down, so
a squad bleeding out trends toward the automatic break.

### The civilian-ROE gate & the restraint reward

Every friendly shot — return fire, suppression, a bounding rifleman's burst — passes
`CombatSim.civClear` before it leaves the muzzle. The gate keeps a **keep-out bubble** around the
aimpoint and a **corridor** along the gun→target line, sized by the squad ROE: *Free* shrinks to
danger-close, *Tight* (the COIN default) keeps a generous bubble, *Weapons Hold* wider still and a man
opens up only in self-defense. Area weapons (the MGs, anything on `suppress`) and blast weapons widen
the bubble further. A civilian inside it **fouls the shot** and the soldier holds fire rather than risk
the qalat.

That restraint is a real **COIN reward**, not just a missed shot. Each held shot is recorded
(`restraintEvents`); the world (`tickRestraint`) turns it into a small, slow gain in the nearest
village's **attitude** and **cooperation** and a dip in **sympathy**. It will never offset a single
civilian casualty — a CIVCAS is an order of magnitude larger and hardens the village — but disciplined
patrols that eat fire rather than spray a compound are how you actually buy the valley's trust. This
is the doctrinal heart of the fight: the squad that wins the firefight by leveling the village has
lost the campaign.

### AI-requested fires (call-for-fire)

Fires are **AI-requested, player-approved**. When the SOP calls for it (*Suppress & Call Fires*) or
the squad is pinned and losing ground, the JTAC/leader raises a call-for-fire (`maybeRequestFires` →
`World.requestSquadFires`). A real FO obeys two hard rules, and the AI now enforces both so it
**never proposes a grid a commander would refuse**:

1. **PID the target.** The aimpoint (`fireAimpoint`) is the centroid of the **densest cluster of
   currently-observed enemies** (cluster radius ~35 m) — never a projected guess, and crucially
   **not the centroid of *all* visible enemies**. On a two-sided / L-shaped contact that global
   centroid lands *between* the enemy groups — i.e. on the squad ("nowhere near the enemy"); a
   densest-cluster aimpoint instead sits squarely on a real group. No eyes on → no mission.
2. **Danger close is the commander's call, not a default.** The AI **withholds** the request if the
   aimpoint falls inside the weapon's danger-close radius (`blast × 2.5`) of *any* friendly — so the
   squad never proposes dropping HE on itself (the old behaviour produced real fratricide). When the
   only target is danger-close the squad fights with organic weapons / breaks contact instead. This
   also stops calling fire onto an objective the maneuver element is assaulting onto.

Behind that, the FDC keeps a final safety: **check-fire** (`stepFireMissions`) aborts a friendly
mission's remaining rounds if troops have maneuvered within a round's lethal blast of the impact
point after the mission was cleared — the dynamic case the call-time gate can't foresee.

The request surfaces to the commander with the squad, the reason (pinned / enemy fixed), and the
proposed grid; one request pending at a time, with a cooldown. The commander **approves**
(`approveFireRequest`, optionally adjusting the aimpoint) and rounds fly, or **denies** it
(`denyFireRequest`). The same approve/deny pattern, plus calling the MEDEVAC, plus the SOP and route
set beforehand, is the player's entire in-combat toolkit. *(Note: the AI gate withholds at the wider
danger-close radius `blast×2.5`; the FDC check-fire aborts only at the narrower lethal radius
`blast×1.3` — a deliberate asymmetry so the AI never proposes danger-close, yet a player who
knowingly calls danger-close fire still gets it unless a round would actually land on a man.)*

## Strategic / COIN feedback (`world/`)

- **The insurgency regenerates from the population** (`tickInsurgency`): hostile/high-sympathy
  villages recruit and a thin infiltration trickles in, while pacified villages turn men away — you
  cannot kill your way to zero, only pacify (CERP/KLE/restraint bend sympathy and so bend strength).
- **Civilian casualties** are reconciled (`reconcileCivilians`) and **attributed to the firing
  faction**: a CIVCAS by *our* fires hardens the nearest village, mobilizes fighters and costs higher
  confidence; the enemy killing locals is a small information-operations win for us.
- **Enemy cells** share a `squadId`, so they feel each other's losses and a fallen commander's cell
  promotes a successor — the enemy side of buddy-down shock and NCO succession.
