# Realism overhaul — baselines & discovery (2026-06-04)

Goal: identify and implement 10 high-impact improvements that make the simulation
more realistic and accurate to real life, discovered via a dynamic multi-agent
workflow and each iterated/verified before acceptance.

## Method

1. **Discovery workflow** (`milsim-realism-discovery`): 10 subsystem SME reader
   agents read the actual engine code (ballistics, perception, morale, enemy AI,
   friendly AI, fires/MEDEVAC, terrain/weather, logistics, medical, COIN) and
   proposed concrete realism gaps; a judge agent merged/de-duped/ranked a diverse
   shortlist. Candidates that were *already modeled* were rejected by design.
2. **Verify, don't assume**: a pure probe harness (`scripts/realism-probe.ts`)
   turns the model into hard numbers, captured below as the baseline; re-measured
   after each change.

## Standing checks

- `npx tsc --noEmit` → clean (exit 0)
- Runner: `npx tsx scripts/<x>.ts` (no tsx/ts-node in deps; tsx fetched on first use)

## Baseline metrics (pre-change)

### Ballistics probe — `realism-probe.ts ballistics`
M4, marksmanship 0.90, prone, settled aim; target standing, unarmored, fully exposed, no cover.

| range | hit% | mean eff-dmg / hit | kill% (per shot) |
|------:|-----:|-------------------:|-----------------:|
| 25 m  |100.0%| 30.7 | 0.7% |
| 100 m |100.0%| 30.7 | 0.3% |
| 200 m | 82.7%| 30.7 | 0.5% |
| 300 m | 61.7%| 30.8 | 0.3% |
| 500 m | 24.6%| 30.7 | 0.2% |
| 800 m |  4.4%| 30.2 | 0.0% |

**Finding:** hit% degrades with range correctly (dispersion model is sound), but
**mean terminal damage per hit is flat (~30.7) at every range** — a 5.56 round
wounds identically at 800 m as point-blank. No terminal-energy falloff. (Target
realism: 5.56 loses fragmentation/wounding potential as velocity drops below
~2500 fps past ~150–300 m.)

### Engagement probe — `realism-probe.ts engagement`
avg over 10 seeds, 18 game-min, sq1+medic presence patrol, heat 0.7.

- Contacts: 4/10 · time to first detection ~8.0 game-min
- **Suppression on patrol while in contact: mean 0.000 · peak 0.000** (despite ~243 rounds/run)
- Casualties: US KIA 0.10 · WIA 0.30 · enemy 1.00 · civ 0.00

**Finding:** suppression barely exists in real engagements — it only accrues from
rounds passing within a 4–11 m radius, and the valley's 300–600 m fights rarely
put incoming rounds that close to a specific man, so soldiers under fire feel
almost nothing. Corroborates the "area / crack-thump suppression" gap.

### Balance harness — `scripts/balance.ts 8 40`
- Contacts 7/8 · avg peak enemies 6.9 · US KIA 0.13 · WIA 1.13 · enemy 2.75 · civ 0 · no strands.

## Chosen 10 (from the discovery workflow: 64 candidates → judge ranked 16 → top 10)

Every pick fixes a missing physical/doctrinal system or verified dead code/data.
The judge grep-confirmed the dead-code claims (enemyFireMission unused, ied_team/
spotter never spawned, civCasualties unread by world, enemyStrengthAbs only
decremented, medevac an instant despawn, wind read by no ballistics, roundWeight
unused in movement).

1. **Range-dependent terminal energy** — 5.56 sheds lethality past ~150–300 m; 7.62/.50 hold it. `ballistics.ts`, `weapons.ts`
2. **Thermal optics** — CLU/LRAS3 distinct sensor channel that beats veg & dark. `los.ts`, `combat.ts`, `entities.ts`
3. **Buddy-down / leader-loss shock + NCO succession** — casualties hit nearby composure; SL death special. `combat.ts`, `entities.ts`, `ai/friendly.ts`
4. **Enemy indirect/DShK harassment** — activate the dead `enemyFireMission`. `world/director.ts`, `combat.ts`, `weapons.ts`, `ai/insurgent.ts`
5. **Insurgent regeneration from the population.** `world/director.ts`, `world/world.ts`, `campaign.ts`
6. **Civilian-casualty backlash loop** with faction attribution. `combat.ts`, `world/world.ts`, `world/events.ts`, `campaign.ts`
7. **Buddy-aid (CLS) by every soldier + bleed split.** `ai/friendly.ts`, `combat.ts`, `entities.ts`, `ballistics.ts`
8. **Combat-load weight drives speed + fatigue.** `entities.ts`, `combat.ts`, `weapons.ts`
9. **Base-of-fire + bounding overwatch.** `ai/friendly.ts`, `combat.ts`, `entities.ts`
10. **IED-initiated complex ambush** — activate the dead `ied_team` role. `world/director.ts`, `ai/insurgent.ts`, `combat.ts`, `world/helpers.ts`

**Bonus (rank 11):** wind as a vector deflecting bullets/smoke/indirect — folded into #1's ballistics pass.

## Per-improvement results

### #1 Range-dependent terminal energy — `ballistics.ts` `retainedLethality()`
Added a per-kinetic-class lethality-vs-range curve (inferred from caliber, no
weapon-table churn), applied to a ball round's damage at spawn. 5.56 has a sharp
fragmentation knee; 7.62 full-power holds; .50 ~flat; 9mm cliffs.

Ballistics probe — mean eff-dmg/hit (M4, unarmored target):

| range | before | after |
|------:|-------:|------:|
| 25 m  | 30.7 | 30.7 |
| 200 m | 30.7 | 25.9 (0.85×) |
| 300 m | 30.8 | 20.8 (0.68×) |
| 500 m | 30.7 | 14.2 (0.46×) |
| 800 m | 30.2 | 11.0 (0.36×) |

Hit% unchanged (separate dispersion mechanism). Effect: 5.56 is now decisive up
close and weak at the valley's 400–800 m ranges — exactly why the fight demanded
7.62/CAS.

**Matched-seed balance A/B (12 seeds, 40 min, hot):** iterated the 5.56 curve to a
slightly gentler (non-zero) tail after the first cut proved too punishing.

| | baseline | #1 (first cut) | #1 (accepted, gentler) |
|---|---|---|---|
| US KIA | 0.08 | 0.42 | 0.33 |
| US WIA | 1.33 | 2.00 | 2.75 |
| enemy accounted | 3.08 | 3.00 | 4.08 |

Valley fights are now bloodier both ways (the realism): a light 5.56 squad can't end
contact at range, so fights drag and the platoon takes attrition — raising the value
of the 240/marksman/mortars/CAS. Platoon still very lethal (enemy 4.08). No strands.

Stable 20-seed read (#1+wind): KIA 0.65 · WIA 1.15 · enemy 2.40 · 1/20 lingering
(pre-existing rare stall — terminal-energy/wind don't touch pathfinding). This is the
worst-case test: an all-5.56 squad, 40 min sustained max-heat contact, **no fire
support called and no 7.62 on the patrol** — i.e. exactly the situation #1 makes
costly and that the player's 240/mortars/CAS (unused by the harness) exist to answer.

### Bonus — Wind as a vector — `world.windVector()`, `spawnProjectile(wind)`, smoke drift
Wind is now an effective vector: prevailing synoptic direction + a diurnal valley
flow (anabatic up-valley by day, katabatic down-valley at night), driving bullet
drift (over time-of-flight) and smoke drift/spread. Previously `wind` was a
directionless scalar read by no code.

Wind probe — mean lateral drift, 6 m/s crosswind (M4): 100m **0.31m**, 300m **0.92m**,
500m **1.54m**, 800m **2.45m** — negligible close, a real long-range factor (matches
5.56 wind tables). tsc clean.

### #2 Thermal optics — `los.detectionChance(observerThermal)`, `combat.THERMAL_ROLES`
A thermal sight is now a distinct sensor channel: light-independent (sees heat in
the dark) and sees through vegetation (heat through leaves) but NOT terrain
defilade or smoke. `LOSResult` now exposes the geometric vs veg vs smoke split so
thermal can recombine. Carried by marksmen, snipers, the JTAC, and weapons-squad
MG gunners (LRAS3) — the few, as in life. Previously NVG was a lone faction
boolean and thermal didn't exist.

Perception probe — per-moment detect p (naked / NVG / **thermal**):

| scene | naked | NVG | thermal |
|---|---|---|---|
| day, open, 400m | 39% | 39% | 39% (no edge in open daylight — right) |
| day, forest, 300m | 25% | 25% | **42%** (through foliage) |
| night, open, 300m | 14% | 32% | **43%** (beats NVG) |
| night, forest, 250m | 8% | 18% | **41%** (the overmatch) |

A fighter in the trees at night reads ~8% / ~6 s to the naked eye but ~41% / ~1.2 s
on thermal. tsc clean; smoke OK.

### #3 Buddy-down / leader-loss shock + NCO succession — `combat.casualtyShock`, `promoteSuccessor`
A casualty is no longer just a log line. When a man is hit, nearby friendlies (and
the whole same-squad) take a composure hit + a few seconds of the shakes (`shaken`
→ ×1.4 dispersion) and a brief flinch off their guns — worse for a kill, worse
inside the fire team, worst when it's the leader. A squad that loses every leader
promotes its steadiest survivor (fixes the permanently-leaderless-squad bug). New
`shaken` field; RNG-neutral, so cleanly A/B-able.

Engagement A/B (10 seeds, same RNG): lowest patrol composure in contact 0.404 →
**0.372** (shock fires), recoverable when a leader is near. Iterated: the first cut
spiraled (a 1 s squad-wide fire-freeze per kill → KIA 0.20→0.40); softening the
flinch to 0.6 s kept the morale dip but removed the spiral (KIA back to baseline,
WIA ~0.9). Succession is rare-by-design (only a fully-decapitated squad). tsc clean.

### #4 Enemy indirect harassment — `director.spawnIndirectHarass` → `enemyFireMission`
Activates the engine's enemy-indirect pipeline, which was fully built but had **zero
callers**. A hot valley (heat>0.5, strength>8) now occasionally drops 82mm from
defilade onto the COP or a pinned patrol, telegraphed by ICOM so an alert player
takes cover. The signature valley threat — you can't storm a HESCO COP, so the enemy
shells it.

Probe (heat 0.8, 8 seeds × 45 min, COP): before #4 — **0 fire missions, 0.00 KIA**
(the fortress shrugs off ground assaults); after #4 — **6 FM / 19 rounds, 5/8 runs**
saw indirect. Iterated: first cut had a too-tight 18 m CEP that precision-killed
clustered men (2.00 KIA/run); widened the enemy CEP to 38 m (unregistered hand-laid
tube) + trimmed rounds → **1.00 KIA/run** — a real threat, not a precision strike.
tsc clean.

### #5 Insurgent regeneration — `world.tickInsurgency`
`enemyStrengthAbs` was previously only ever decremented (you could grind the
insurgency to zero). Now it regenerates from the population each day: high-sympathy/
hostile villages recruit, a thin infiltration trickles via the draws (heat-scaled),
and pacified villages turn men away. CERP/KLE/restraint bend sympathy & attitude →
bend this. The central COIN truth: you can't kill your way out.

Probe (director suppressed, no combat, 14 days): **hostile valley 66 → 80** (regen ↑),
**pacified valley 59 → 44** (decay ↓). Pacification is the lever (cullEnemies still
drains 1/kill — the equilibrium of the two is the campaign).

### #6 Civilian-casualty backlash — `world.reconcileCivilians` + blast-time attribution
`civCasualties` was tallied but **never read** by the world. Now a civilian
wounded/killed is attributed to the firing faction (set at blast time) and
reconciled: a CIVCAS by *our* fires hardens the nearest village (attitude↓,
sympathy↑, cooperation↓), mobilizes fighters (couples to #5), costs higher
confidence, fires an interrupt; the enemy killing locals is a small IO win for us.
Save-safe (per-unit `casualtyCounted` flag, not a transient Set).

Probe (8 US mortar rounds on a village → 2 civ cas): attitude **−23 → −35**, sympathy
**47 → 57**, enemyStrength **43 → 44**, higherConf **60 → 58**. tsc clean.

### #7 Buddy-aid (CLS) + arterial/internal bleed split — `entities.bleedTQable`, `combat.updateTimers`
The bleed model previously had a single rate with uniform passive clotting, and only
the medic could stop it. Now bleed is split: extremity (leg/arm) wounds bleed FAST
(femoral/brachial arterial) but are **tourniquetable** — a conscious man self-aids,
an unconscious one is saved by any conscious buddy within reach (every soldier a
combat lifesaver, TCCC). Torso/junctional wounds bleed internally — slower, and only
a medic or surgery stops them (the golden hour). Save-safe field; RNG-neutral.

Controlled probe (identical wound, bare CombatSim, only aid varies):

| scenario | fate |
|---|---|
| extremity · conscious (self-TQ) | LIVED hp 66 |
| extremity · out cold, **no buddy** | **DIED** |
| extremity · out cold, buddy near | LIVED hp 63 |
| internal · buddy only (no medic) | LIVED hp 25 (barely) |
| internal · **medic** | LIVED hp 55 |

The lone death is the unattended unconscious extremity bleed — the #1 *preventable*
battlefield death, now in the model. Completes with #9 (a buddy closes to treat).
tsc clean; smoke OK.

### #8 Combat-load weight → speed & fatigue — `combat.combatLoadKg`, `moveUnit`
`roundWeight`/carried weight were unused in movement. Now every man's combat load
(kg) — US armor+water+ammo+the squad's heavy weapons vs the insurgent's light chest
rig — drags his pace above a 25 kg reference and burns him out faster, with fitness
offsetting some. Ammo dominates the variable load and lightens as he shoots. RNG-neutral.

Probe loads (real Korengal figures): rifleman **30 kg**, SAW gunner **40 kg**, 240
gunner **56 kg**. Over the same ground the 240 gunner fatigues **+20%** (0.53 vs 0.44)
— the gun team sets the tempo. Matched-seed A/B: load adds KIA 1.00→1.40, WIA
3.70→4.70 (a tired squad arrives at the fight shooting worse) — the "every man a mule"
realism, flagged for the final global calibration. tsc clean; smoke OK; no strands.

### #9 Fire-and-maneuver: base-of-fire + bounding + casualty drag — `ai/friendly.ts`, `combat.ts`
Two doctrine gaps closed. (a) **Casualty drag (completes #7):** every soldier, not
just the medic, now breaks to a downed buddy — the nearest able man peels off, drags
him to cover, and the tourniquet model saves him. (b) **Base of fire on assault:** in
a deliberate assault the automatic weapons (SAW/240) hold cover and suppress the
objective while the riflemen and leaders bound onto it — not everyone walking in.
RNG-neutral.

Rescue probe (downed man, extremity arterial bleed, NO medic): buddy 8 m away →
**LIVED hp 37**; buddy 18 m away → **LIVED hp 5** (the farther the buddy, the more
blood lost before he arrives — a real close call). Previously, with no medic adjacent,
that man bled out. tsc clean; smoke OK; no strands.

### Adversarial review (wave 1, #1–#4) — bugs found & fixed
A multi-agent adversarial review of #1–#4 read the real diffs and ran its own
experiments. Fixes applied (all verified):
- **BLOCKER — wind NaN on old saves:** new required `Weather.windDir` had no save
  migration → `Math.cos(undefined)=NaN` poisoned every projectile aimpoint (the
  `!== 0` guard passes for NaN) → direct fire silently broke. Fixed: `windDir ?? 0`
  in `windVector`, `loadWorld` backfill, `Number.isFinite` guard in `spawnProjectile`,
  save bumped to **v3**. Probe: strip windDir → windVector finite, 3000 ticks **0 NaN**.
- **MAJOR — thermal blinded in forest:** perception gated on naked-eye `los.visible`
  *before* thermal recombined, so thermal died in dense canopy (the case it's for).
  Fixed the gate to be thermal-aware. Probe: **DENSE canopy → naked eye 0%, thermal 41%**.
- **MAJOR — `promoteSuccessor`/`casualtyShock` could promote/shock an evac'd man** →
  added `!o.evac` guards (no more medevac'd squad leaders).
- Indirect wind drift k 0.6→0.18 (GL is hold-off-corrected); wind magnitude clamped
  to the rolled speed; smoke drift ×0.55; thermal now partly sees through HC smoke.
- **Enemy cells now share a `squadId`** → the previously-dead enemy `promoteSuccessor`
  works: a fallen commander's cell promotes a successor and feels its losses (the
  enemy side of #3). tsc clean; no strands; enemy indirect still fires.

### #10 IED-initiated complex ambush — `combat.ts` IED system, `director.spawnIedAmbush`
Activates the dead `ied_team` role and a new buried-IED system. A charge is buried
ahead of a patrol on its outbound axis; an L-shaped cell lies in wait with weapons
**tight** (`iedInit` — they will NOT trigger on small arms, no matter how close the
patrol gets). When the point man enters the kill zone the charge command-detonates
and the whole cell springs hold→engage at once — the signature valley opener
(previously impossible: the patrol's small arms always initiated). The buried device
is invisible (only an ICOM hint betrays it); the blast is attributed to the
insurgents (so a civilian caught in it routes through #6).

Controlled probe (squad walks onto a linked charge): **IED detonates as the
point man hits the kill zone**, cell **springs hold→engage**, ~3/9 casualties (a
maimed lead man + the ensuing firefight, not a wiped squad — US armor/cover + the
L-cell). Iterated twice: longer triggerman patience and trigger radius pulled inside
the blast. tsc clean.

### Adversarial review (wave 2, #5–#10 + fixes) — bugs found & fixed
A second multi-agent review (which ran its own headless experiments) caught what the
happy-path probes missed:
- **BLOCKER — base-of-fire was dead code:** the assault logic switched on a brainState
  (`"assaulting"`) that is never assigned (assault sets `"moving"`), so fire-and-maneuver
  never ran and the casualty-drag guard against it was inverted. Rerouted through the
  real assault path (`orderType === "assault"`). Deterministic probe: SAW `rof→suppress`
  20/20, never bounds; rifleman bounds 20/20.
- **MAJOR — civcas wound→kill undercount:** a civ wounded then killed by our fire only
  ever counted as a *wound*. Now escalates to the full kill backlash once (probe: total
  attitude −14). 
- **MAJOR — medic broke the bleed invariant** (`bleedTQable > bleedRate` let a conscious
  man self-cure an internal wound) → medic now clamps `bleedTQable ≤ bleedRate`.
- **MAJOR — IEDs leaked into invisible phantom landmines** (never culled, not serialized)
  → cull every tick (spent / dud-TTL 10 min / orphaned-cell), bounding the array.
- **MAJOR — thermal saw but couldn't shoot:** `acquireTarget`/fire still gated on naked-eye
  visibility → added `canPerceive` (thermal-aware) so a thermal-sight gunner engages what
  it sees through foliage.
- Plus evac guards and the strength-clamp unification. Final balance: no strands, no NaN,
  smoke OK, thermal intact.
