# CONTEXT block — people-immersion campaign (recon distillation, 2026-06-10)

Source brief: `docs/briefs/movement-and-interaction-immersion.md`. Six read-only recon agents
swept the code, the probe suite, and the institutional memory. This file is the distilled
CONTEXT injected into every downstream agent. Facts below were cite-checked against HEAD.

## Corrections to the brief (recon caught the brief being wrong)

1. **Civilians do NOT respawn.** They are persistent individuals across the whole tour; killed
   civilians stay dead on the map (`lib/sim/combat.ts:362`, `lib/sim/ballistics.ts:305`). They
   already have Pashtun names (never displayed) and hash-derived traits. Identity is much closer
   than the brief believes — what's missing is *families, visible names, and named consequence*.
2. **Enemy cells DO exist** — every spawn shares a `squadId` (`acm-<clock>`,
   `lib/sim/world/director.ts:220`), with casualty-shock contagion and leader promotion
   (`lib/sim/combat.ts:1203,1221`). What's missing is *group decisions*: no coordinated ambush
   initiation, no crossfire geometry, no group maneuver/withdrawal, no repositioning.
3. **Men DO react individually to near-misses** — the suppression field is real physics along
   bullet trajectories (`lib/sim/combat.ts:1109`), and `suppression > 0.18` visibly changes
   stance/formation per man. The rigid part is the *squad-level* drill (no pinned-revert,
   no cross-squad awareness, drill sequence identical between squads).

## VERIFIED CODE FACTS

- **Architecture**: pure deterministic React-free engine `lib/sim` → React-free Canvas renderers
  `lib/render` → single bridge `state/store.ts`. Master clock `World.tick(dt)` order:
  squad/task AI (`tickTasks` → `squadFight`) → director (enemy spawns) → `sim.tick` (combat
  execution) → casualty/civilian reconciliation. SIM_DT=0.1. Consumers import the barrel
  `@/lib/sim/world`.
- **Determinism**: per-man variance must use `hashUnit01(id)`-style pure hashes or the seeded
  `w.rng` — never Date/Math.random. New persisted state goes in BOTH `serialize()` AND
  `loadWorld()`. Same-seed divergence IS the bug.
- **FRIENDLY**: `ai/squad-combat.ts` = squad-leader brain (react/hold/suppress/assault/break;
  reconsider ~1.2 s; assault commits on fire-superiority + 2 teams + flank; only exit is
  mustBreak effFrac<0.6; NO pinned-revert-to-suppress; NO cross-squad coordination; flank
  searched once per commit). `ai/friendly.ts` executes per man (underFire = suppression>0.18;
  pinned = composure<0.25 || suppression>0.55; buddy-aid one man ≤24 m; medic treat loop;
  leaderless hunker if no leader within 35 m). Morale: composure lerps to
  composureMax*(0.55+0.25*cohesion+0.2*leaderBonus[45 m]) − suppression*0.6 − fatigue*0.15.
  Leader succession on death only (`promoteSuccessor`).
- **MOVEMENT**: `world/formation.ts` — wake-following (navigator breadcrumbs every 2.5 m,
  170 m trail; followers project onto trail, arc-length lag); corridor-adaptive width
  widthScale=clamp01((corridor−6)/14); two-stage pace governor off rearmost lag;
  wedge/dispersed DEFINED but NEVER SELECTED (historic failure: open-ground wedge wedged
  flankers into walls and stalled — any wedge must be terrain-fitted via the corridor sensor);
  `holdSecurity` bearing-optimal 360 ring is the ONLY halt type; bounding fields (boundPair)
  exist only inside assault; techniques crawl/concealed/tactical/patrol/traveling/rush.
- **ENEMY**: `ai/insurgent.ts` per-fighter FSM (ambush→engage→scoot→exfil; patrolling for
  infiltrators; kill-zone trigger = effRange*(0.45+0.35*aggression); shouldBreak on
  composure<0.25 / wounds / CAS / isolation). `director.ts` scores firingPositions 80–260 m
  off the patrol centroid, reads the route ONCE at spawn, never repositions. IED cells hold
  fire (`iedInit`) until the charge initiates. Exfil = away-from-nearest-enemy + uphill.
- **CIVILIANS**: ~12/village (farmer/herder/villager/child/elder); 4-tier graduated reaction
  (oblivious/wary/clear-road/flee; rises instantly, falls 1 step/2.5 s); MELT = staged threat
  (un-fired ambushers/infiltrators ≤150 m) > 0.18 → staggered children-first walk home — THE
  gold-standard tell, `ai/civilian.ts:77-152`, DO NOT BREAK. Diurnal light-keyed home-pull.
  Villages: attitude/cooperation/sympathy scalars; elder is a NAME STRING on VillageState;
  KLE/census = on-station 360 hold + attitude drip + throttled text-modal dwell events
  (`world/tasks.ts:431`, `world/events.ts`, modal in `components/screens/DeployScreen.tsx:1302`).
  No families, no named grievances; backlash is scalar swings guarded by casualtyCounted flags.
- **RENDER**: LOD sprite crossfade (NATO symbol ↔ figure), per-role civ sprites exist; no
  speech/callout layer; `WorldView.tsx` draws qalat compounds + attitude banners + `__setCam`.

## NO-REGRESSION GATES (baselines captured on HEAD this session, see baseline/)

balance.ts 12×50 (KIA/WIA/civCas/stuck) · cohesion.ts · autonomy.ts 14×22 ·
squad-maneuver-probe.ts · atmospherics-probe.ts (diurnal + melt) · security-halt.ts ·
dwell-probe.ts · smoke.ts · tsc/build/lint. Tune survey-0..39, prove on survey-40..59.

## DO-NOT-RE-TRY (measured failures — sacred)

- Open-ground lateral wedge as-is (flankers wedged into walls, element stalled).
- Coarse cover-raster stamps for combat usability (+89% WIA).
- Anisotropic/Tobler cost on the 8-dir grid (detour worse + flat-ground stall).
- Aspect-vegetation strength >0.05 without a rebalance pass (+56% KIA).
- HVT dispersion + threat-weighted COP posture (net regression, reverted).
- Straight-line siting rays; largest-component COP constraint (reachability 26→13%).
