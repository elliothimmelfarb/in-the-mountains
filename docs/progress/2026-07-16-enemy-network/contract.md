# Build contract — the enemy becomes a NETWORK (persistent order of battle)

**Date:** 2026-07-16 · **Wave:** enemy-network · **Status:** authoritative build contract
**Baseline:** commit `a14da77` (relief evidence file). Recon map with exact seams: this
directory's `recon.md` sibling (produced same day; file:line anchors verified).

## Why (the design thesis)

The insurgency today is a WEATHER SYSTEM: `enemyStrengthAbs` (a scalar rolled 40–70 at
world init) + a memoryless director tempo clock. Fighters spawn from nothing at
director-chosen points, fight, and despawn into nothing (`cullEnemies` is the single
chokepoint — an exfiltrated fighter vanishes at zero cost). The game already has a
sourced, reliability-scored intel feed (`campaign.ts:89`, `addIntel world.ts:205`) and
map markers for located intel — but intel about a weather system cannot accumulate into
anything. **You can't hunt a weather system.**

After this wave the insurgency is an ORGANIZATION: persistent named cells with home
areas, physical munitions caches, and a memory of the player's habits. The director
spends cells instead of a scalar; exfiltrated fighters flow BACK into their cell;
killing a named leader forces succession; winning villages makes them give the network
up (HUMINT), so the FM 3-24 loop — win the population → they expose the network → you
dismantle it → the valley calms — becomes mechanical, not flavor. This is the
transformation that makes the game playable for hours: the time between fights becomes
hypothesis-forming about REAL nodes, and every tour becomes a duel with someone who has
a name.

## The model (keep it this simple — resist adding fields)

New types (in `lib/sim/campaign.ts` next to VillageState, or `world/types.ts` — builder's
call, but exported from the barrel):

```ts
interface EnemyCell {
  id: string;
  leaderName: string;      // Afghan name; survives between activities
  leaderAlive: boolean;
  homeCx: number; homeCy: number;   // reachability-snapped (terrain invariant!)
  strength: number;        // fighters THIS cell can field (sums ≈ old enemyStrengthAbs)
  aggression: number;      // 0..1 personality: weights ambush vs harass vs IED in the director roll
  iedSkill: number;        // 0..1, grows on successful IED activities → weights future IED choice
  grudge: number;          // 0..1, rises when the cell takes KIA → tempo vs the player
  villageIds: string[];    // recruiting/intimidation base (drives per-cell regen share)
  intelLevel: 0 | 1 | 2 | 3; // what the PLAYER has learned: unknown → named → located → mapped
  lastActivityClock: number;
}
interface EnemyCache {
  id: string; cx: number; cy: number;
  munitions: number;       // IED/ambush activities near it spend from it
  found: boolean;          // revealed to the player (event/intel)
  destroyed: boolean;      // seized/blown — permanently out
  cellId: string;          // owner
}
// WorldState gains: network: { cells: EnemyCell[]; caches: EnemyCache[] };
//                   patrolHeat: number[] (32×32 coarse grid, decaying — see §Adaptation)
```

## Mechanics (each maps to a recon seam)

1. **Creation** (`create.ts:130` area). Build 3–5 cells from the most
   sympathetic/hostile villages + terrain: home areas in draws/high ground NEAR their
   villages, snapped with `reachablePoint`-family helpers (spawn invariant). 4–8 caches
   near villages/trails, same snapping. Distribute the rolled 40–70 strength across
   cells. **RNG discipline:** use `rng.fork("network")`-keyed streams AFTER the existing
   draw sequence, or append draws at the end of createWorld — the draw-order pinning
   comment at `create.ts:172-174` is law; a mid-sequence draw breaks same-seed
   determinism. Leader names: reuse the existing Afghan/civilian name source used for
   elders (find it in entities.ts / names data — do NOT invent a new list format).

2. **Director spends cells, not the scalar** (`runDirector` director.ts:15-55,
   `spawnFighter` :212-232, `drawStaging`/`edgePoint` :337-360, `drawEnemy` :235-238).
   Activity roll picks a CELL weighted by strength × (0.5 + grudge) × proximity-to-target
   fit; activity type weighted by the cell's aggression/iedSkill. Staging point = the
   cell's home area (or a living cache near the target) instead of `edgePoint`/random.
   `drawEnemy` counts against the CELL's strength. Spawned fighters carry their
   `cellId` (there is already a per-batch `squadId = "acm-<clock>"` at director.ts:223 —
   keep squadId for combat grouping, add the persistent cellId reference on the Unit).
   IED ambushes REQUIRE a living cache with munitions within ~600 m of the site and
   decrement it. No living cache in range → the cell does something else.

3. **Exfil flows back** (`cullEnemies` world.ts:595-607, evac transitions
   insurgent.ts:145-158). An `evac`'d fighter increments his cell's strength (he made it
   home) — today he vanishes at zero cost, which both wastes the design and undercounts
   attrition's real effect. A KIA decrements his cell. Keep `enemyStrengthAbs` ALIVE AS A
   DERIVED SUM of cell strengths (+ a small unaffiliated infiltration trickle if you
   need one) so every existing reader (interdict directive `directives.ts:48-55`, HUD ENY
   meter, `tickInsurgency` clamp, harnesses) keeps working unchanged. Every existing
   WRITE to enemyStrengthAbs must be routed to a cell: recruit integrator
   (`tickInsurgency` world.ts:528-543 — distribute by villageIds sympathy share), civcas
   mobilization (world.ts:491 — the cell linked to that village), event decrements
   (events.ts dwell_* — the nearest cell / the cache's owner). Enumerate ALL write sites
   with grep before starting; leave none writing the scalar directly.

4. **Leaders die and it matters.** When a cell stages an activity of ≥4 fighters, the
   commander-role unit (helpers.ts:65-72 already makes man 0 of ≥6 a "commander") IS the
   cell leader if he's alive and the rng favors it (~40%): tag the unit with the cellId
   leadership flag. If that unit dies: `leaderAlive=false`, succession after 1–2 days
   (new name, −30% strength as fighters drift, grudge +0.3, tempo pause), log + intel
   emission ("HUMINT: [old name] is dead; men answer to [new name] now"). Mirror the
   elder-succession pattern (`ensureElder` world.ts) — same shape, opposite side.

5. **Adaptation: they learn YOUR habits** (the one honest adaptation, cheap). A 32×32
   `patrolHeat` grid over the map: increment cells under friendly patrol routes each
   tick (coarse downsample), decay ~weekly. IED site selection prefers high-heat
   road/trail cells reachable from the owning cache. That makes predictable patrolling
   physically dangerous and route variety a real decision — no scripted "AI learning"
   theater, just a heat field the player can reason about.

6. **The COIN loop closes: villages give up the network.** In `tickIntel`
   (world.ts:337-367): a village with attitude > ~20 and cooperation above a floor
   occasionally emits HUMINT that RAISES a linked cell's `intelLevel` or sets a cache
   `found=true` (with cx/cy intel at the true location; reliability scales with
   cooperation). Hostile villages emit nothing about their cell. The dwell_find event's
   cache (events.ts:126-133, :293-311) becomes the REAL nearest cache: seize →
   `destroyed=true` (owner loses IED capability), leave-and-watch → `found=true` +
   surveillance intel. `advanceInterdict` (directives.ts:48-55) keeps its scalar
   progress (it reads the derived sum — untouched) but ALSO counts destroyed caches as
   progress if that's a small clean addition; if not clean, leave it and note it.

7. **Intel references the network.** Existing emission sites (director.ts:73/:130/:160,
   world.ts:344-365) upgrade their text to name the acting cell's leader once
   `intelLevel ≥ 1`, and their cx/cy to noisy-true node locations (noise radius shrinks
   with reliability). The ICOM flavor lines at world.ts:344-350 stay, but at least half
   the emissions should now be ABOUT real nodes. intelLevel advancement: 0→1 on first
   leader-name emission, 1→2 when a located report lands within ~150 m of the true home,
   2→3 via high-cooperation HUMINT or interrogation-flavor events. intelLevel is
   SIM-TRUTH about what the player has been told — the HUD (next wave) renders from it;
   nothing in combat reads it.

8. **End state.** A cell at strength < 2 BREAKS: log it, survivors merge into the
   nearest living cell (or dissolve if none), its villages get a temporary calm
   (attitude +small, sympathy −). All cells broken → the valley goes quiet except a
   thin infiltration trickle from the map edge. Breaking the network must be POSSIBLE in
   a good 14-day tour but not easy.

## Hard invariants (violating any of these fails the wave)

- **Determinism:** same seed → byte-identical `serialize()` after identical inputs. The
  probe must run the same seed twice and diff. New RNG only via keyed forks or appended
  draws (§1). NO `Date.now`/`Math.random`.
- **Persistence:** `network` + `patrolHeat` in WorldState (serialize dumps state whole);
  presence-defaults in `loadWorld` following the v6/v9 pattern (create.ts:214+). A
  pre-v10 save without a network gets one REGENERATED deterministically from
  `rng.fork("network")` + its villages (mid-tour save keeps working). Bump serialize to
  `v: 10` (v9 = relief evidence file, this morning).
- **Layer line:** everything in `lib/sim`; React-free; consumers import from the barrel.
- **Combat AI untouched:** `ai/cell-combat.ts`, `ai/squad-combat.ts`, `ai/friendly.ts`
  combat logic unchanged. The network feeds the director; combat stays combat. (Adding
  the passive `cellId` field to Unit + the exfil deposit in cullEnemies is fine.)
- **No new in-combat player levers.**
- **`enemyStrengthAbs` remains correct as the derived sum** — every existing reader
  unchanged in behavior.
- **Spawn/home/cache positions reachability-snapped** (terrain.ts helpers).
- **MAX_ACTIVE_ENEMY (26) unchanged.**

## Acceptance — `scripts/network-probe.ts` (new, permanent; header doc-comment per repo law)

Headless, seeded, exits non-zero on failure. Asserts at minimum:
1. Same-seed determinism: two identical runs → byte-identical serialize.
2. Cells persist: after 3+ director activities, the acting cells are the created ones.
3. Conservation: sum(cell strengths) === enemyStrengthAbs (± the documented trickle).
4. Exfil deposit: force an activity, let fighters exfil, assert the cell regained them.
5. Cache economics: an IED ambush decremented a real cache; destroying all a cell's
   caches → it stages no further IED activities.
6. Succession: kill the leader unit → within 2 game-days the cell has a new leaderName,
   reduced strength, and an intel emission mentioning it.
7. Intel truthiness: located intel about a cell with intelLevel ≥ 2 lands within noise
   radius of the true home.
8. Save round-trip mid-activity: serialize → loadWorld → cells/caches/patrolHeat intact.

Plus the standing gates: `npx tsc --noEmit`, `npm run build`, `npm run lint`,
`npx tsx scripts/smoke.ts`, `npx tsx scripts/balance.ts` (STALL CHECK — casualties are a
diagnostic, NOT a target). Do not run campaign-loop yourself (the orchestrator runs it —
it's 40 min).

## Working rules

- Engine only. Do NOT touch `components/`, `state/store.ts`, `lib/render/` — the HUD
  wave follows separately. Do NOT touch `docs/issues/` (another agent is in there).
- Commit as you go: small conventional commits `feat(enemy): …`, evidence in bodies,
  trailer exactly `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Before coding: grep every `enemyStrengthAbs` write site and list them in your first
  commit message; that enumeration is the §3 contract.
- If a contract item is wrong against reality (recon drift), trust the code, do the
  right thing, and record the deviation in the commit body.
- Fun is a success criterion: the log lines and intel text are player-facing fiction —
  write them in the game's somber, grounded voice (read a few existing `w.log` lines
  first).
