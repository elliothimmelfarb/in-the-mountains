# The People Plan — movement & interaction immersion campaign

Mission (from `docs/briefs/movement-and-interaction-immersion.md`): make every soldier, fighter,
and villager move, behave, and interact so convincingly that a skeptical infantry veteran forgets
he's watching a simulation. Six recon agents swept the code; six independent single-axis proposers
designed against the distilled CONTEXT (`context.md`); this document is the judged synthesis.

## Verbatim HEAD baselines (no-regression gates)

- `balance.ts 12 50`: contacts 12/12 · avg peak enemies 7.1 · **US KIA 1.08 · US WIA 8.58 ·
  enemy 6.25 · civCas 0 · no elements stranded**.
- `cohesion.ts` MEAN: paceEff 0.58 · paceP10 0.65 · throt 33% · lenCV 0.23 · jit 1°/s · blkd 0%.
- `security-halt.ts` MEAN: settle 30.6 s · churn 0.91 · minGap 1.29 m · ovlp 0.1% · maxGap 59°.
- `autonomy.ts 14 22`, `squad-maneuver-probe.ts`, `atmospherics-probe.ts diurnal+melt`,
  `dwell-probe.ts`, `smoke.ts`: captured in `baseline/` (running at plan time; treat files as gate).

**Determinism framing (important):** byte-identical replay is a *within-build* contract (same seed,
same code → same outcomes, serialize round-trips). Cross-build comparisons against these baselines
are *statistical* (means over 12×50 etc.) because any new seeded-rng draw legitimately shifts the
stream. Never remove or reorder an *existing* rng draw (e.g. the `rng.chance(0.5)` MAN-DOWN log in
`onWound` stays even when the callout bus duplicates it).

## The spine (one sentence)

**Group minds decide, individuals execute, everything is visible, and the valley remembers** —
the friendly squad already works this way (`squadFight` decides, `friendlyBrain` executes); we
extend the same architecture to the enemy (cell brain), to the village (civic scenes + a grievance
ledger), and add the missing presentation layer (a deterministic diegetic-event bus) so internal
state becomes watchable behavior.

## Judged merges (dedup decisions — one mechanism each)

1. **Consolidate/reorganize was invented 3× independently** (movement P2, firefight P3,
   brotherhood P3) — that convergence is evidence it's load-bearing. ONE implementation, at the
   contact→lull seam in `tasks.ts:releaseCombat`, as a march micro-FSM state on the Task
   (`t.march`), because `tickTasks` owns post-contact control flow (`squadFight` is not called
   when out of contact, so a `squadState` variant would never tick). Contents: `holdSecurity`
   kneeling ring + SL walks the line (deterministic circuit) + ACE ammo cross-level to auto
   weapons + head-count radio line + casualty carry to the ring/CCP + 30–90 s duration keyed to
   casualties/suppression. Re-contact preempts for free (`tasks.ts:79` contact check runs first).
   `squad-maneuver-probe`'s COMBAT set must exclude the new state (metric-pollution hazard).
2. **Kids ×2** (village P4, wildcard P2) → village P4 mechanism (per-village mood pushed into the
   sim like `sim.light`; trailing in friendly villages, children-absent in hostile ones); the
   wildcard's rock-toss is a tone-checked stretch garnish, not core.
3. **Memory ×3** (village P2 grievances, village P5 familiarity, wildcard P4 reception) → ONE
   persistent ledger `v.grievances[]` (named, written in `applyCivcasBacklash`, resolvable by
   solatia) feeding: the funeral scene, the named `dwell_grievance`, a sympathy floor, and a
   *derived* per-village `reception` scalar (grievances + attitude + familiarity-from-
   `lastVisitedDay` + `scarDay`) pushed to the sim and read as tier-fall-rate / kids / elder
   willingness. Derived values are never persisted.
4. **Civic summons** is one mechanism, two scenes: the elder walking out to the shura (village
   P1) and the household gathering at the funeral (village P2). Precedence is sacred:
   FLEE > MELT > SUMMONS > NIGHT-HOME > CLEAR-ROAD > WARY.
5. **The callout bus** (brotherhood P1) is the shared visibility substrate: firefight reverts
   ("falling back to suppress"), succession ("on me"), consolidate ("head count"), bounds
   ("covering"/"moving"), buddy-aid ("doc — over here") all emit through it. Engine-side ring
   buffer + dedup on `CombatSim` (sim.log precedent: NOT serialized); render-side presenter
   cloned from the `CueMapper` high-water-walk pattern (`lib/audio/mapper.ts`), capped at 3
   concurrent plates, lowercase ≤3 words, dedup window 8–12 s enforced sim-side. No React
   round-trip. `say()` never draws from `sim.rng` (phrase variants via `hashUnit01`).

## Waves (each independently verified + committed; engine = orchestrator, probes/render = agents)

### Wave 1 — the two coordinators + the bus (foundations)
- **W1.1 Callout bus** (combat.ts `say()`/ring buffer; `lib/render/callouts.ts` presenter;
  WorldView hook). DoD: callout-probe fingerprint identical across 2 same-seed runs ·
  manDownCov 100% · maxPerMinInContact ≤6 · dupViol 0 · balance within ±15% of baseline.
- **W1.2 Enemy cell brain** — new `lib/sim/ai/cell-combat.ts` (`cellFight`: leader DECIDES,
  fighters EXECUTE), dispatched in `combat.ts` before per-unit brains; leader flagged at spawn in
  `director.ts` (turns ON the already-built `promoteSuccessor`/leaderBonus paths). Behaviors:
  disciplined initiation (volley opens as one — MG initiates), target distribution across the L,
  group base-of-fire + displace (half bounds, half covers), coordinated peel to a shared rally
  with rear pair covering, panic contagion (a runner shocks cellmates). Leaderless fighters fall
  through to today's FSM (strict superset). Pre-contact vocabulary stays `"ambush"` /
  `"patrolling"`+concealed so the civilian melt tell keeps sensing them.
  DoD (new `cell-coordination-probe.ts`): volleySpread p50 ≤2 s (baseline expected ~8–20 s) ·
  preTriggerLeaks 0 · fireContinuity +0.15 without rounds/min +>5% · exfilSpread <0.5× baseline ·
  peelOrderRho >0.5 · melt probe PASS with non-decreasing lead time · balance KIA/WIA ±15%.
- **W1.3 Firefight humanity core** — build `drill-timeline-probe.ts` FIRST (fingerprints the
  current zero-divergence drill as its own baseline), then: pinned-revert (assault → suppress when
  ≥50% of maneuver element pinned >4 s, hysteresis 6 s, `fixSince` reset, opposite flank preferred
  next commit) + the `nerve` scalar (0.5·composure/composureMax + 0.3·experience + 0.2·aggression,
  hash-jittered) read into bound hesitation (≤1.2 s, under the 3 s bound window), pin thresholds
  (±, zero-mean), cover acceptance (±20%, zero-mean). mustBreak and the bounding clock untouched.
  DoD: moveSpread σ >0.25 s (now 0) · two same-SOP squads' timelines diverge on the same
  objective · reverts >0 at heat 0.7 and ≈0 at heat 0.3 · autonomy state mix + balance in gates.

### Wave 2 — the seams of march and fight
- **W2.1 Unified consolidate** (merge #1). DoD (`transitions-probe.ts` + timeline probe):
  follows ≥90% of contacts with ≥1 casualty · ring forms <40 s · resume <120 s · ammo
  cross-levelled when auto roles below threshold · gotHome/stuck unchanged (autonomy + balance).
- **W2.2 Medic scene** — the securing buddy: when the medic arrives, the aid buddy kneels 2.5 m
  off FACING OUT (threatDir), `securing` state with 4 s hysteresis. DoD: sceneCov ≥80% of
  treat episodes ≥6 s · zero episodes with the buddy facing the casualty · balance in gates.
- **W2.3 Movement texture bundle** — point-man caution (corridor look-ahead eases pace; one-shot
  2.5 s halt at <5 m chokes, arc-latched), individual line-picking (hash-keyed ±0.3–0.8 m wake
  meander, λ 18–30 m), halt posture (settled-in-cover >60 s → prone, out of contact only),
  weather/night interval (rain/night closes spacing ×0.8–0.9; pace floor ×0.85), return-leg
  fatigue legibility (slot error scales with fatigue; ≤1 rest halt on returning leg when mean
  fatigue >0.6). DoD (cohesion.ts extended): lineSpread 0.3–0.9 m (now ~0) · cautionFrac >0 ·
  chokeHalts ≥1 on choke seeds · jit ≤ baseline+1°/s · blkd 0% · paceEff ≥0.53 · reach deltas
  <8% · interval(rain-night) < interval(clear-day) by ≥15% · security-halt gates hold.

### Wave 3 — the village
- **W3.1 The shura staged** — elder guaranteed as a real Unit per village (spawn i=0,
  `VillageState.elder` bound to his name, `elderUnitId` persisted; succession on death), civic
  summons walks him to a point inside the ring, SL steps out to meet him; KLE ask-roll + dwell
  events gated on `elderMet` (15-game-min grace: "the elder sends his regrets" — itself a tell);
  elder nameplate at tactical zoom. Dwell timer/band untouched (dwell-probe reads `t.timer` at
  phase entry). DoD (`encounter-probe.ts shura`): departs ≤300 s · meets ≤1200 s · no dwell event
  before elderMet · injected staged ambush mid-walk aborts the summons (melt wins) · det hash
  identical · dwell-probe bands verbatim.
- **W3.2 Households, grievances, the funeral** — households of 2–4 assigned at creation
  (`householdId`, forked rng stream); `v.grievances[]` written in `applyCivcasBacklash` with the
  victim's name; funeral = summons `mode:"gather"` at next first light (household + elder stand
  at the home 20 game-min, one log line); `dwell_grievance` becomes named when unresolved;
  solatia resolves the entry; unresolved grievances impose a capped sympathy floor; grieving
  households clear-road from US patrols and their children never trail. DoD: ≥2 household members
  within 15 m at first light · log contains the name · serialize→loadWorld mid-gathering resumes ·
  balance civCas 0 · atmospherics PASS verbatim.
- **W3.3 Kids + reception** (merges #2, #3) — mood/reception pushed per tick; trailing in
  friendly villages (≤2–3 kids, 9 m standoff, weapons-tight un-fired patrols only, tier<3 gated);
  hostile/grieving villages: children simply not out near patrols; reception scales tier-FALL
  rate only (rise logic untouched, ×0.6–1.4 cap). DoD (`encounter-probe.ts kids` + atmospherics
  `familiarity` mode): trail-minutes(+40) ≥3× (−40) · kids-near-patrol(−40) ≈0 · relax-time
  (visited daily) <0.5× (absent 10 days) · melt + diurnal PASS verbatim.

### Wave 4 — pattern of life (stretch, in order; un-reached items become numbered issues)
1. Cookfire smoke at meal hours (render-only, suppressed when the village is melting/fled).
2. Compound dogs (1–2/village real units; alarm field nudges perception alertness; the tell cuts
   both ways). Probe-gated: diurnal filter excludes role "dog"; civClear exempts animals.
3. Trap repositioning (director re-look every ~45 s; cell slips concealed to new firingPositions
   against the projected route; **the melt follows the moving cell** — meltFollowLeadS asserted).
4. Succession beat (deferred `takesChargeAt`, 6–18 s command gap, sag then "on me").
5. Cross-squad fix-and-flank (task-array blackboard, opposite flank signs, fires ownership).
6. Danger-area crossing drill · SLLS halts · terrain-fitted wedge (hysteretic, quadruple-guarded,
   dies if wedgeBlocked regresses) · MEDEVAC staged scene · bait-and-reattack · blend-into-
   population · goat herds · prayer clock.

## Risk register (top hazards, from proposers — each has a named guard)
- **Melt tell**: SUMMONS sits below MELT; enemy pre-contact states keep the sensed vocabulary;
  kids/reception gated out of the melt path; every wave re-runs `atmospherics-probe melt`.
- **Stuck/stranding**: consolidate + halts call `resetProgress` on entry (never disable the
  watchdog); caps (consolidate ≤90 s, halts ≤2/leg, shared per-leg texture budget).
- **Probe pollution**: squad-maneuver-probe excludes "consolidate"; diurnal filter excludes
  animals; dwell-probe timer path untouched.
- **Load-bearing constants**: mustBreak floor, bounding 3–5 s clock, suppression crackR — frozen.
- **rng streams**: new draws OK (statistical gates); existing draws never removed/reordered;
  per-man variance via `hashUnit01`; civilian traits stay hash-derived.
- **Save/load**: every new persisted field (summons, householdId, grievances, scarDay,
  elderUnitId, march/cell fields riding Task/Unit spreads) gets a `loadWorld` default; mid-scene
  save round-trip is asserted by probes.
- **Elder deadlock**: 15-min grace force-sets elderMet with a logged regret.
- **Balance**: every wave ends with `balance.ts 12 50` + the wave's probes; Wave 1.2/1.3 also
  `autonomy.ts 14 22`. Tune on survey-0..39; final proof on survey-40..59 (untouched until then).

## Adversarial review amendments (folded in — the review verified every seam against HEAD)

1. **Consolidate driver (W2.1)**: `t.march` gets zero ticks unless each non-contact phase branch
   in `tickTasks` dispatches `tickConsolidate(...)` INSTEAD of `drivePatrol`/`driveReturn`/dwell.
   Exit must replay `releaseCombat`'s member-reset (`releaseFormation`, brainState) +
   `resetProgress(t)`; `t.march` cleared whenever `contact` is true (stale-resume trap); casualty
   bodies looked up via `t.memberIds → sim.unit(id)` (the `members` array excludes the dead);
   coverage DoD exempts contacts ending within the wire.
2. **Cell brain (W1.2)**: ≥6-man cells ALREADY have `isLeader` commanders (helpers.ts:66) — the
   work is extending flagging to 2–5-man cells; key all leader detection on `isLeader`, never
   role (`spawnIedAmbush` overwrites role to "ied_team" post-spawn). The coordinator must flip
   `brainState = "engage"` (the ambush case re-stamps `rof = "hold"` every tick, so stamping rof
   alone is reverted). `preTriggerLeaks 0` requires a small guard in insurgent.ts's ambush case:
   a led+coordinated fighter defers initiation to the leader — KEEP the per-tick
   `sim.acquireTarget(u)` call (preserves existing rng draws). Engage dwell burns at 2×dt
   (double decrement quirk at insurgent.ts:21+89) — stamp dwell values accordingly. Tolerate
   same-second squadId collisions (grouping picks the first flagged leader).
3. **Elder/kids vs FLEE (W3.1/3.3) — the fatal one**: proximity threat (civilian.ts:96-98) hits
   tier 3 inside ~19 m of 3+ armed men; the KLE ring is 9 m. While a summons/trail behavior is
   active AND panic is low, exclude un-fired us/ana from that unit's threat inputs (FLEE on
   `panic > 0.45` stays — gunfire always wins). Summons abort on `stagedThreat > 0.18` must be
   LATCHED (set + suppress re-issue), not per-tick precedence, or the melt stagger fall-through
   oscillates him between home and shura.
4. **Dwell-event gating**: gate on `elderMet` only when `t.kind === "kle"` — the roll is shared
   with census/cordon (tasks.ts:488) and would silently starve them.
5. **Spawn loop**: burn the `rng.weighted` draw at i=0 (`const r = ...; role = i===0 ? "elder" : r`).
6. **Serialization — confirmed cheap**: serialize spreads units whole and dumps `state`;
   `loadWorld` consumes objects wholesale (no whitelist) — new fields survive; only loadWorld
   defaults needed.
7. **Callout presenter**: clone the audio seam's always-tick discipline (store.ts:615-630 calls
   `audio.tick` every frame with running/paused/warp gates; warp runs up to 700 slices/frame) —
   advance high-water marks every frame, render plates only when live. Use `RNG.hashString`
   (rng.ts) for phrase variety, not formation.ts's hashUnit01 (avoids combat→world import).
8. **Nerve must be centered by construction**: use STATIC traits only (composureMax, experience,
   aggression — never live composure, which double-counts suppression); pin-threshold deltas as
   exact zero-mean hash jitter (e.g. `0.12·(hash01(id+"pin") − 0.5)`); bound hesitation cap
   0.9 s and scaled by remaining bound window (window is 3–5 s, rng.range(3,5)).
9. **Securing buddy (W2.2)**: re-derived per tick like the aiding/treating states — squadFight's
   per-tick stamps overwrite stored one-shots.
10. **Grievance/funeral village identity**: key BOTH on `u.villageId` when defined (fall back to
    `nearestVillage`) so the ledger entry and the funeral happen in the same village.

## File ownership (one writer per file)
- Engine (`lib/sim/**`): the orchestrator, sequentially.
- Probes (`scripts/*-probe.ts`, extensions), render presenter (`lib/render/callouts.ts` +
  `WorldView.tsx` hook), HTML report: delegated agents, disjoint files.
