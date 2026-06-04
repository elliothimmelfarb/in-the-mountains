# AI Doctrine

Three brains in `lib/sim/ai`, each a pure function `(sim, unit, dt)` called every tick. They read
the sim through public helpers (`acquireTarget`, `los`, `findCover`, `moveTo`, `nearestCasualty`,
`throwSmoke/throwFrag`, `addLog`, `enemyFireMission`) and mutate the unit's order/brain state;
movement and firing are then executed by the core tick.

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

Unarmed. Accumulate **fear** from nearby gunfire, explosions, and armed men who have fired; above a
threshold they **panic** and flee — away from the nearest shooter, blended toward their home
compound. When calm they amble along their pattern of life. Their flight is the atmospheric tell a
sharp player learns to read; their presence near a fight complicates fire and risks the COIN
catastrophe of civilian casualties.

## Friendly (`friendly.ts`)

The player gives intent; soldiers fill the gaps. When a patrol is *moving without contact* the squad
is steered as a composed echelon by `world/formation.ts` (point navigation, fire-team formation,
security sectors, pace governor) and the garrison routine runs at the COP (`world/garrison.ts`);
the instant rounds crack those release and this combat brain takes over each man individually,
re-forming on the lull.

- **Posture** down in contact (prone/crouch by cover), stand only when moving without contact.
- **Pinned & leaderless** → hunker and crawl to the nearest cover; leaders within ~35 m steady them.
- **moving** → the instant rounds are effective or an enemy is seen, bound off the X to cover, go
  prone, and return fire (`suppressed_halt`), then resume the move once the suppression eases.
- **assault** → *fire and maneuver*, not a banzai walk: the automatic weapons (SAW/240) hold cover
  and set a **base of fire** suppressing the objective while the riflemen and leaders **bound** onto
  it under that fire. **withdraw / hold / engage / suppress / frag** → the corresponding behavior.
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

## Strategic / COIN feedback (`world/`)

- **The insurgency regenerates from the population** (`tickInsurgency`): hostile/high-sympathy
  villages recruit and a thin infiltration trickles in, while pacified villages turn men away — you
  cannot kill your way to zero, only pacify (CERP/KLE/restraint bend sympathy and so bend strength).
- **Civilian casualties** are reconciled (`reconcileCivilians`) and **attributed to the firing
  faction**: a CIVCAS by *our* fires hardens the nearest village, mobilizes fighters and costs higher
  confidence; the enemy killing locals is a small information-operations win for us.
- **Enemy cells** share a `squadId`, so they feel each other's losses and a fallen commander's cell
  promotes a successor — the enemy side of buddy-down shock and NCO succession.
