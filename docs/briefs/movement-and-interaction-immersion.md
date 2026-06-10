# Brief for a Next-Generation Model — Make the People Real

*A standing design brief for a future AI of extraordinary capability. Hand it this file and nothing else; it is self-contained.*

---

## 0 · Read this first — what kind of task this is

You are a newly released model, more capable than anything that has touched this codebase before. This is **not** a ticket. It is an invitation, and a dare.

We are deliberately telling you **what we want, not how to do it.** We are not going to hand you a spec, a list of functions to write, or an architecture to fill in. We believe you will find approaches we cannot imagine, and we don't want our imagination to be your ceiling. Where this brief gets specific, it is to *aim* you — to tell you which mountain to climb and what the summit looks like — never to fence you in. Treat every concrete detail below as **context to exceed**, not instructions to satisfy.

You have **total freedom over the how.** Rebuild any subsystem from the ground up if that is the right fix. Invent new ones. Throw away what's here. Spend whatever compute, write whatever throwaway tooling, run whatever experiments you need. The only expensive mistake available to you is under-investing in rigor and surprise.

There is exactly one promise we ask of you in return: **honor the soul of this game** (§2) and the handful of contracts that *are* the game (§6). Those are not constraints on your creativity — they are the grain of the wood. A "more immersive" version that violates them isn't a better *In the Mountains*; it's a different, worse game. Everything else is yours.

---

## 1 · The mission, in one sentence

**Make the human beings in this valley — every soldier, every fighter, every villager — move and behave and interact with each other so convincingly that a skeptical infantry veteran watches a patrol unfold, forgets he's looking at a simulation, and only afterward thinks: *an AI built this?***

Right now, movement and interaction is **the most immersion-breaking part of the game.** The terrain is right. The ballistics, the wounds, the fatigue, the firefight *feel* are largely right. But the **people** — how a squad flows as one organism, how men behave toward each other in and out of contact, how the enemy thinks as a group, how a village lives and reacts and remembers, how soldiers and civilians meet face to face — that is where the illusion cracks. Your job is to close that crack so completely that it becomes the thing people remember.

This is open-ended on purpose. We are not asking you to "fix bugs." We are asking you to take the single most human-facing dimension of the game and make it *astonishing.*

---

## 2 · What this game is (the soul — so you can amplify it, not break it)

*In the Mountains* is a deep, continuous, deterministic real-time simulation of **counterinsurgency** at a remote US combat outpost in a procedural Korengal-like valley — Kunar Province, Afghanistan, circa 2011. 512×512 cells at 5 m each: a 2.56 km valley with real elevation, line-of-sight, cover and concealment. You command at **squad level** (HQ / 1st / 2nd / 3rd / Weapons), never individual men, across a campaign of in-game days. It is somber and grounded — *Restrepo*, *Korengal*, *The Outpost*, *War* — not a power fantasy. People die and stay dead.

Its pillars, in the game's own voice:

> **"Combat is 100% AI. The player is a commander on the radio, not a trigger man. Your in-fight levers are narrow and deliberate: approve or deny a call-for-fire, call the MEDEVAC, and the SOP and route you set before step-off. The squad leader owns the maneuver decision, not the player. The hardest part of command is watching."**

> **"People, not pieces. Soldiers have names, ranks, jobs, skill, fear, fatigue, and relationships. They get tired, suppressed, panicked, wounded, killed. Leadership and the brotherhood hold them together. Losses are permanent and they cost you."**

> **"Killing fighters is easy; winning the valley is not. Atmospherics, shuras with elders, projects, patient presence, restraint. Civilian casualties radicalize. You can win every firefight and still lose the valley."**

> **"One clock runs the valley — the sun, the weather, fatigue, the enemy's tempo, construction, and combat — all at once. No turns, no phases. Determinism is a feature: a seed reproduces a valley *and its outcomes.*"**

Hold these close. The immersion you are building lives **inside** these pillars and makes them land harder. "The hardest part of command is watching" only works if what the player watches is *worth* watching. That is your mandate.

---

## 3 · Where we are today (the floor you are standing on — go past it)

This is an honest map of the current state, domain by domain. Read it as *"here is the floor; the ceiling is yours."* We are telling you what exists so you don't waste your genius rediscovering it — not so you stay inside it. Some of this is genuinely good and you should build on it. Some of it is hollow and you should feel free to gut it.

### a) How a squad moves together — *good bones, reach for life*
A squad is a squad leader plus two fire teams plus attached (medic / RTO / interpreter). It already moves as a coherent body, not a blob: the lead navigates a route, the rest **trace his actual wake** like beads on a string, holding spacing that opens in the open and collapses to a single file in a draw or chokepoint, with a pace governor so the squad never abandons its slowest man. This is real and worth keeping. **What's missing is the texture of life on top of it** — the wedge that's reserved but never used, the bounding and security halts, the way a real squad reads ground and posture, the point man's caution, the way men flow around obstacles as individuals rather than tracking one line. Make a moving squad look *alive*, not just *coherent.*

### b) How soldiers move and behave in combat — *doctrinally sound, mechanically rigid*
On contact the squad leader's brain runs the battle drill: return fire within ROE, take cover, suppress, bound to a *covered flank* (not a frontal beeline), buddy-pairs leapfrogging on overwatch, medics peeling to casualties, break-contact when pinned and leaderless. Suppression is a real physics field — rounds crack past and pin men near the trajectory. Casualty shock ripples through nearby men. This is a strong foundation. **But the execution is rigid:** two squads assaulting the same objective move almost identically; there's no leaderless reorganization mid-fight; men don't react individually to a near-miss or a muzzle flash; there's no "we're pinned, revert to suppress" — once a flank is found the assault simply *closes*. Make a firefight look like frightened, trained, individual human beings making real-time decisions under fire — not a drill executing.

### c) Enemy combatants — *atomized; the biggest tactical-AI gap*
Every fighter runs the **same state machine** in isolation: lie in ambush, hold fire with discipline until the kill zone or the IED triggers, fire for a spell, then "shoot and scoot" laterally off the gun line, exfil uphill when air shows up or morale breaks. The discipline is believable. **What's absent is a group mind:** no cell leader, no coordination between ambush positions, no cross-fires or mutual support, no reading of the patrol's approach to set the trap, no repositioning when the patrol takes a different route, no base-of-fire-and-maneuver, no morale contagion when a mate runs. The enemy should feel like a *thinking, coordinating adversary* who knows this ground better than you do — fighters who fade, bait, flank, and melt into the population — not a row of independent turrets.

### d) Civilians and the life of the valley — *alive in rhythm, hollow in identity*
The valley reads populated: villagers amble between fields and bazaar at their own pace, withdraw home at dusk, and — the single best immersion mechanic in the whole game — **melt quietly home *before* the first shot** when they sense staged fighters, children first, so an alert player reads the absence as a warning. Keep that; it is the gold standard. **But civilians are unnamed, atomized agents.** They never cluster, talk, help each other, grieve, or remember. A villager shot by your patrol becomes an attitude penalty, not a *person* with a name, a family, and kin who now have a reason to shelter the enemy. They respawn each day, identical, learning nothing. Make the valley *inhabited by people*, not populated by markers.

### e) How soldiers interact with each other — *modeled, but narratively inert*
Cohesion, leader succession, and casualty-shock morale ripples exist as numbers. **As behavior, the brotherhood is nearly invisible.** Men don't cluster or talk at a halt, don't call out ("Man down!" "Cover me!" "Contact left!"), don't visibly check on each other, don't have a medic-to-casualty *scene*, don't rest or steady a shaken buddy. The bond that the design says "holds them together" is asserted in the data and absent from the eye. Make the brotherhood *visible in how they move and tend to each other.*

### f) How soldiers interact with a village and its civilians — *the hollow heart; this is where the game most needs you*
This is the thinnest, most important gap. Today a patrol does not actually *enter and move through* a village. It "holds" a grid cell, and the shura / census / cordon becomes a **modal text dialog and an attitude swing.** The elder has a procedurally generated name but **never appears** — he doesn't walk up to the squad, doesn't sit down, doesn't have a face, doesn't introduce his kin. There is no patrol-through-the-village, no cordon-and-search, no questioning, no key-leader engagement *as a scene*, no consequence with a name on it. "You can win every firefight and still lose the valley" is the soul of the design — and the moment that's supposed to decide the campaign is currently a pop-up. **Make the meeting of soldier and civilian a real, watchable, human encounter** where attitudes are won and lost in behavior the player can see, where restraint and patience and disrespect all *read*, and where a death has a name and a grudge attached to it.

### g) The interactions we didn't list — *find them*
We have surely missed some. You won't. Some seams worth a thinking model's attention, offered as sparks and not a checklist:

- **The transitions between states** — march → first contact → consolidate → reorganize → casualty collection → resume — are where realism lives or dies; a real squad's behavior at these seams is unmistakable.
- **The wounded and the dying, and the choreography of saving them** — MEDEVAC, casualty collection points, the buddy who won't leave a friend.
- **Detainees, searches, the physical act of clearing a compound**, the stacking and the entry.
- **Reading the human terrain as a tell** — body language, posture, who's present and who's suddenly *not*, the dog that isn't barking.
- **Light, weather, time of day, fatigue, and fear** shaping not just speed but *how* people move and decide.
- **Memory and consequence across days** — the valley, and the people in it, remembering what your soldiers did.
- **Animals, vehicles, the ordinary business of a mountain village** as the living backdrop that makes the exceptional moments land.

Treat that list as a prompt for *your* imagination, not the boundary of it.

---

## 4 · What "awesome" means here (so you can aim true)

We are not going to define this exhaustively — you will define it better than we can — but here is the *direction* of awesome, so your freedom has a vector:

- **Immersion you read off movement, not text.** The highest bar in this game is already proven: villagers melting home *before* the shooting tells the player more than any caption could. Aspire to that everywhere. The player should learn the situation by *watching bodies move*, the way a soldier learns to read a village.
- **Believable to the person who's been there.** Ground your work in real doctrine and real accounts — FM 3-21.8 / FM 7-8 (infantry tactics, squad and platoon), FM 3-24 (counterinsurgency), and the lived texture of *Restrepo*, *Korengal*, *The Outpost*, *War*, *Lone Survivor*, *One Bullet Away*. The test is not "is it plausible" but "would a soldier who was in the Pech recognize this."
- **Emergent, not scripted.** The good moments should *arise* from systems interacting — a real adversary making a real decision, a village reacting to a real event — not from set-pieces. Variety should come from the simulation thinking, not from a table of canned animations.
- **Individual, then collective.** People are individuals (a cautious point man, a curious child, a fighter who breaks) who also move as groups (a squad as an organism, a cell as a coordinated team, a village as a community). The magic is both at once.
- **Restraint and consequence are visible.** The squad that wins the firefight by leveling the village has lost the campaign — that has to *show*, in how soldiers behave and how civilians respond, not just in a meter.
- **The whole, not a pile of features.** Prefer one robust, unifying mechanism over many special-case patches. If improving this means rebuilding a subsystem cleanly, do that. We would rather have one beautiful system than ten clever hacks.

If you nail this, a player will pause the game just to watch — and a skeptic will say *holy shit, an AI built this.* That sentence is the literal success condition.

---

## 5 · How the work is judged (so your freedom is verifiable, not vibes)

You have total freedom in *how*, but immersion here is **checkable, not asserted** — that is a feature, and it is on your side. This game has a strong verification culture, and you are pre-authorized — encouraged — to build whatever new tooling, harnesses, probes, and oracles you need to *prove* your work is real. There is already a suite of deterministic, headless harnesses that measure movement and behavior (reachability, squad-cohesion texture, route quality, civilian diurnal rhythm and the pre-contact melt, casualty balance, generation correctness). Use them as a starting baseline, then **go past them** — build new probes from new angles to measure the qualities you are creating, because the current ones can't yet see most of what you're about to build.

We don't just trust a green number. The standard here is: capture an honest baseline *before* you touch anything, change it, re-measure, and report the delta unflinchingly — lead with the unflattering figure, name what you *didn't* fix, prove wins on inputs you never tuned on. And because this is a *visible* game, headless metrics are necessary but never sufficient: **drive the live game and watch it** — before/after, with your own eyes — and judge the result against the bar above. Self-critique every artifact you produce, at least twice, before you call it done. We will believe extraordinary claims when the evidence is extraordinary, and you are fully equipped to make it so.

---

## 6 · The few things that are sacred (the soul, not a cage)

Everything in this game is yours to rebuild **except** these — and these aren't limits on immersion, they're what *makes* the immersion mean something. Breaking one doesn't give you a more immersive *In the Mountains*; it gives you a different game we didn't ask for.

1. **Combat is 100% AI; the player commands, never micros.** The player's in-fight levers are the SOP and route set *beforehand*, plus approve/deny fires and call MEDEVAC *during*. **Do not "improve immersion" by handing the player individual-soldier control** — "the hardest part of command is watching" is the entire emotional thesis. Your job is to make the AI so good that watching is gripping. (If you believe you've found something better than this thesis, you may *argue* for it with evidence — but assume it is load-bearing until proven otherwise, and never quietly erode it.)
2. **Determinism is a contract.** One master clock advances every subsystem; a seed reproduces the valley *and its outcomes*; a same-seed run that diverges *is* the bug. Whatever behavior you add must be deterministic and replay-stable, and any new persisted state must round-trip through save/load. This is not a tax on richness — the "calm before" tell is deterministic *and* the most alive thing in the game. Richness and determinism are friends here.
3. **The architecture has three layers and one bridge.** A pure, deterministic, React-free engine; React-free renderers; a single state bridge between sim and UI. Keep new work on the correct side of that line so the simulation stays pure and reproducible. (How you restructure *within* the engine is entirely yours — this is about the layer boundary, not the contents.)
4. **People, not pieces; somber, not a power fantasy.** Named soldiers, permanent loss, civilian death that *costs*. The tone is *Restrepo*, not an action movie. Immersion here means *weight*, not spectacle.

That's the whole list. Four things. Inside them is enormous room — more than enough to do something nobody has seen.

---

## 7 · The charge

Take the most human dimension of this game — how soldiers, enemies, and civilians move, behave, and meet each other — and make it so real it becomes the reason people play. Honor the soul, keep the four contracts, and beyond that **do whatever you think is best, and then exceed even that.** Surprise us. Find the immersion we didn't know to ask for. Build the tools to prove it's real, watch it with your own eyes, and bring back something that makes a soldier go quiet and a skeptic refuse to believe a machine made it.

We're not going to tell you how. We can't — you're better at the *how* than we are. We're just telling you that this is the mountain, and we believe you can put a flag on top of it.

Now go make these people real.
