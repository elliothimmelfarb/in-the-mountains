# 036 — The point man doesn't wait for a wedged/strung follower (RESOLVED — bounded halt)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-07-03) — mechanism current: bounded wedge/cohesion halt (`formationHold` + `HOLD_BUDGET` per leg, formation.ts:208) — window-neutral by budget, doesn't re-attempt the refuted 031 floor-reorder. Residual (b): COP-egress `Structure` grind belongs to the muster-routing (003) family.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: Medium (movement feel).** Owner report 2026-07-03: *"(1) the point man should slow down
and stop when the squad isn't together — right now he just keeps going, which is the worst part and
makes him unrealistically far forward. (2) squad members, especially later in the file, get stuck on
buildings in the villages, and the squad spreads out because the point man does not wait. Unless you
find a real solution, we can just make the buildings visual-only."*

**Outcome: a real solution shipped — the point man now HOLDS (takes a knee, a genuine stop) when a
follower is wedged OR the file is badly strung, bounded by a per-leg time budget so it can never
reproduce the issue-031 slow-failure. The buildings-visual-only premise was MEASURED and REFUTED:
village qalat walls cause ~0.6 s of wedging per patrol — they are not the problem — so making them
passable was tried, moved the metric by nothing, and was reverted.**

## What is actually happening (measured — `scripts/squad-wedge.ts`)

The complaint was reproduced as numbers on 21 near-village presence patrols (the realistic case a
player watches), attributing every blocked tick to the **land type of the cell that actually blocked
the man** (not mere adjacency — adjacency conflated two different buildings and blamed the wrong one):

```
mean blocked-sec by cause   wall(qalat) 0.6   struct(COP b-huts) 11.6   terr(cliff/river/HESCO) 38.6
point man halt% while a follower is wedged:  1%      (he essentially never waits)
nav speed while a follower is wedged:        0.51 m/s (full march)
peak point-man-ahead-of-centroid:            45 m mean, up to 94 m; file stretch to 355 m
```

Two findings overturned the obvious reading:

1. **"Buildings in villages" is NOT village qalat walls.** `CompoundWall` blocks only **0.6 s** of
   follower time per patrol. The wedging is on **COP b-huts** during muster/egress (`Structure`,
   11.6 s) and on **terrain / the HESCO wire** (38.6 s). Making qalat walls passable-but-cover was
   implemented (it is combat-safe — `coverAt`/`concealAt` read baked rasters independent of
   passability, and `los.ts` blocks sight by elevation+vegetation, never walls) but it changed the
   aggregate by ~nothing (20.2 → 19.9 s) because walls were never the cause. **Reverted.**

2. **The point man does not wait for a wedged man — for ANY cause.** `halt% = 1%`, `navSpeed = 0.51`
   while a follower is genuinely blocked. The pace governor (`formation.ts steerSquad`) only *eases*
   the lead (floor ~0.29×), **never stops** him, so the moment a man snags the file strings out.

### Two dead-code findings surfaced en route

- **`formation.ts` line 160** excluded a follower from the pace calc when `blockedTimer > 6`. But
  `watchStall` (combat.ts) **resets `blockedTimer` at `STALL_WINDOW = 2 s`**, so it never exceeds ~2 —
  the guard was dead, and its intent (ignore a stuck man) was backwards anyway.
- **`follower-strand.ts`'s `maxWedge` column** was defined as time with `blockedTimer > 6` → it read
  **0.0 s on every seed, structurally**, which is what mis-reassured issue 031 that "nobody is stuck."
  Fixed in that file to SUM real wedge time (has-a-path but `speed≈0`): now varies honestly
  (juliet-10 121 s, echo-5 49 s, charlie-3 2.1 s).

## The fix (`lib/sim/world/formation.ts`, `steerSquad`)

A **wedge/cohesion halt**: the point man sets `formationHold` (→ `halt()`, a real stop that bypasses
the never-freeze march floor) when EITHER a genuinely blocked follower (`blockedTimer > 0`) trails
> 8 m, OR the rearmost man's along-wake lag exceeds 26 m (a badly strung file). Clock-latched
(4 s hold / 6 s cooldown) and **capped at `HOLD_BUDGET = 45 s of total halt per leg** (reset each
waypoint in `resetProgress`).

**Why this threads the issue-031 needle** (031 refuted *slowing the lead* for a slow climber):
- 031 refuted a **chronic sub-floor creep** over a whole climb (hundreds of s × 0.2× = window blown).
  This is a **discrete, budgeted halt**: 45 s total is negligible against the 1500 s tactical window.
- It is gated on being **blocked/strung**, not merely slow: a spent straggler on a long climb is never
  *blocked*, and his along-wake lag reads ~0 (the file wraps but everyone's in place), so this never
  fires there. The hustle (031) still closes that gap from the trail.

## Resolution (2026-07-03) — before → after

A/B on identical code via `ITM_NOWAIT=1` (disables the halt), near villages, **march phase only**:

| metric | OFF (baseline) | ON (fix) |
|---|---:|---:|
| point man **halt% while a follower is wedged** | **1 %** | **30–38 %** |
| nav speed while a follower is wedged | 0.51 m/s | **0.32–0.37 m/s** |
| mean peak point-man-forward | 45.1 m | **42.3 m** |
| seeds with peak forward > 40 m | 12 / 21 | **9 / 21** |
| mean **average** point-man-forward | 28.8 m | 28.5 m *(unchanged — see residual)* |

**Held-out (`survey-40..55`, never tuned):** halt% **0 → 26 %**, nav-speed 0.58 → 0.45, peak-forward
50.4 → 46.5, seeds > 40 m **9 → 5 of 16**, and **0 new strandings** (6/16 not-reached both OFF and ON —
pre-existing hard near-villages, unaffected).

**Tactical-window gate (`squad-arrival`, the issue-031 arbiter):** OFF and ON are **identical** —
25/27 arrived, **15/27 within window**, 98–99 % cohesion, 372 m worst straggler, 22/25 return. The
budget makes the halt provably window-neutral.

Standing checks green: `tsc` · `build` · `smoke` (determinism + serialize round-trip) · `balance`
(*"No elements left stranded mid-route"*, KIA 0.83 / WIA 8.75 / civ 0 — combat untouched; the halt
only runs during the patrol move). New state (`wedgeHoldUntil/CooldownUntil/HeldTotal`) rides
`serialize()`'s whole-`state` dump.

## Named residuals (NOT fixed here)

- **(a) The ~29 m average lead is a geometry FLOOR, not a defect.** A 9-man file at ~5.5 m spacing is
  ~44 m long; the point man is at the front, so ~22 m ahead of the *centroid* by construction. The
  halt reins in the *peaks* but cannot (and should not) move the average — only lowering the cruise
  pace would, and that is the window-costly 031 lever. Reported, not chased.
- **(b) COP-egress grind on `Structure` (b-huts) is the biggest *building* wedge** (11.6 s/patrol;
  echo-5 has a man stuck inside the wire ~1426 s — `follower-strand wireStuck`). It happens during the
  gate pour (`steerFile`, deliberately full-pace), which this fix does not touch. A muster/egress
  routing pass (issue 003 family) is the right home for it. **← the clearest remaining "stuck on a
  building" the player may be seeing.**
- **(c) Village qalat walls are passable-safe to make cosmetic** if ever desired (proven: cover/LOS
  independent of passability) — but it fixes ~0.6 s and softens the village maze, so it was NOT shipped.

## Reproduce

```
npx tsx scripts/squad-wedge.ts                 # cause attribution + halt% (ITM_NOWAIT=1 for baseline)
npx tsx scripts/squad-arrival.ts               # window gate — must stay ~15/27, coh ~99% (031 arbiter)
ITM_NOWAIT=1 npx tsx scripts/squad-wedge.ts survey-40 survey-41 ... survey-55   # held-out A/B
```

Evidence + snapshots: `docs/progress/2026-07-03-squad-village-cohesion/`.
