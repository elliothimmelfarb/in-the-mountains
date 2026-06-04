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
