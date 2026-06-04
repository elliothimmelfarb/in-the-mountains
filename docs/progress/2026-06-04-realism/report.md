# Realism Overhaul — After-Action (2026-06-04)

Ten high-impact improvements to make the simulation more realistic and accurate to
real life, discovered by a dynamic multi-agent workflow and each iterated against
hard numbers before acceptance. Full per-improvement detail and metrics are in
[`baseline.md`](baseline.md).

## Method

1. **Discovery workflow** — 10 subsystem-SME reader agents read the real engine and
   proposed realism gaps; a judge merged/de-duped/ranked **64 candidates → top 10**,
   rejecting anything already modeled. Every pick is a missing physical/doctrinal
   system or verified **dead code** (`enemyFireMission`, `ied_team`, `spotter` were
   fully built but never invoked; `civCasualties`/`enemyStrengthAbs`/wind were
   tallied/stored but never read).
2. **Verify, don't assume** — a pure probe harness (`scripts/realism-probe.ts`) turns
   each change into a hard number; matched-seed A/Bs isolate effects; the standing
   checks (`tsc`, `npm run build`, `balance.ts`, `smoke.ts`) gate every commit.
3. **Adversarial review** — two multi-agent review workflows read the diffs and ran
   their own experiments to break the changes; their findings were fixed (a save/load
   NaN **blocker** and a thermal-blinded-in-forest **major** among them).

## The ten (each committed, probe-verified, tsc + build clean)

| # | Improvement | Proof |
|---|---|---|
| 1 | **Range-dependent terminal energy** (+wind bonus) | M4 hit 30.7 dmg point-blank → 14 at 500 m; wind drift 1.5 m at 500 m |
| 2 | **Thermal optics** as a sensor channel | dense canopy night: naked eye 0%, thermal 41% |
| 3 | **Buddy-down shock + NCO succession** | composure dips on casualties; decapitated squad promotes |
| 4 | **Enemy indirect harassment** (dead code live) | 0 → fires in 5/8 hot runs; CEP-tuned |
| 5 | **Insurgent regeneration** | hostile valley 66→80, pacified 59→44 (no combat) |
| 6 | **Civilian-casualty backlash** | CIVCAS → village attitude −23→−35, sympathy +10 |
| 7 | **Buddy-aid (CLS) + bleed split** | extremity+aid LIVED, extremity+alone DIED |
| 8 | **Combat-load weight** | rifleman 30 kg / 240 gunner 56 kg; gunner +20% fatigue |
| 9 | **Fire-and-maneuver + casualty drag** | buddy reaches & saves a downed man (no medic) |
| 10 | **IED-initiated complex ambush** (dead role live) | charge initiates as point man enters kill zone |

## Emergent result (full-stack balance, max-heat stress test)

The systems compose into a strikingly accurate picture of the real valley:
**many wounded, few killed.** 5.56 wounds-not-kills at range (#1), body armor stops
torso frag, and buddy-aid/casualty-drag/CLS (#7/#9) keep the wounded alive — so
casualties shift from KIA into survivable WIA. Patrol scenario: **KIA ~0.1–0.3, WIA
mostly walking-wounded, 0 serious/ineffective.** Thermal (#2) lets the platoon find
the enemy; enemy indirect (#4) and IEDs (#10) are the new threats; the population
(#5/#6) is the prize you can't kill your way out of. No element ever stranded; no NaN.

This is not a number that was tuned — it falls out of the systems interacting, which
is the point: realism by mechanism, not by fiat.

## Files

Engine: `lib/sim/{ballistics,combat,los,entities,weapons,campaign}.ts`,
`lib/sim/ai/{friendly,insurgent}.ts`, `lib/sim/world/{world,director,create}.ts`.
Tooling: `scripts/realism-probe.ts`. Docs: this folder + `docs/wiki/`.
