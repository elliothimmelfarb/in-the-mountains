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

The player gives intent; soldiers fill the gaps:

- **Posture** down in contact (prone/crouch by cover), stand only when moving without contact.
- **Pinned & leaderless** → hunker and crawl to the nearest cover; leaders within ~35 m steady them.
- **moving** → the instant rounds are effective or an enemy is seen, bound off the X to cover, go
  prone, and return fire (`suppressed_halt`), then resume the move once the suppression eases.
- **assault / withdraw / hold / engage / suppress / frag** → execute the corresponding behavior.
- **Medics** auto-seek and stabilize the nearest casualty, stopping bleeding over time at a rate set
  by their `medical` attribute; the player can also order treatment or MEDEVAC explicitly.

Target acquisition (`CombatSim.acquireTarget`) prefers close, exposed, and dangerous targets
(MG/RPG/sniper crews first), with a randomized weighting so an element's fire **spreads** across the
enemy instead of every gun converging on one man.
