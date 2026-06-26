# 031 — Patrol straggler cohesion: the floor-vs-governor tension (floor reorder REFUTED)

**Severity: Low (cohesion texture on the hardest objectives).** Investigated 2026-06-27 under the
goal "soldiers … always stick together as a squad." **Outcome: no code change — the current behavior
is correct, and the obvious fix is a refuted slow-failure. This entry exists so the fix is not
re-attempted.**

## The observation

`scripts/follower-strand.ts` reports a worst-follower gap of **70–108 m** on a handful of seeds
(india-9 108 m, mike-13 78, kilo-11 76, oscar-15 71, foxtrot-6 70) — always the **worst-opposite,
far** village, always the **heaviest man** (SAW gunner / grenadier / tail rifleman). Looks like the
squad failing to "stick together."

## What is actually happening (measured)

The **authoritative** whole-squad harness disagrees that this is a defect:

```
scripts/squad-arrival.ts  →  mean squad cohesion @ objective: 100%,  worst straggler 33 m,
                              squads ≥70% closed up: 27/27,  point man arrived 27/27
```

`follower-strand` samples the gap **at the first tick on-station is declared** — i.e. the moment the
*lead* reaches the objective, while the file is still **stretched up the climb**. `squad-arrival`
measures the **settled** state, after `COHESION_GRACE` (tasks.ts) holds the lead on the objective and
the trail closes up. The squad **does** close (100%). A file that stretches on a steep climb and
re-forms at the halt is **doctrinally correct** (FM 3-21.8 — the column opens and closes with the
ground; the leader holds at the objective and the element consolidates). `maxWedge = 0.0 s` on every
seed confirms nobody is *stuck* — the trail is simply slower up the hill.

### The mechanism, for the record

The mid-climb gap *can* freeze because the never-freeze floor (`combat.ts moveUnit`,
`speed = max(0.5, speed)`) is applied **after** the navigator's pace-governor `paceScale` multiply, so
when the governor brakes the lead to wait (`paceScale → 0.29`) the floor clamps him back up to the
same 0.5 m/s the floored straggler already sits at — the gap can't close until the halt.
`scratch-strag-trace.ts` (deleted; data preserved here): india-9 had **94 %** of governor-braking
ticks pinned at the floor, **339 s** with both lead and straggler frozen at 0.5 m/s, gap > 40 m.

## The refuted fix — reorder floor vs governor (DO NOT re-attempt)

Apply the floor **before** the governor, letting the navigator ease **below** the march floor (down to
a creep floor) to genuinely wait. Measured both ways:

| seed | baseline gap | CREEP=0.12 | CREEP=0.30 |
|---|---:|---:|---:|
| foxtrot-6 | 70 m (arr) | 23 m | 23 m |
| kilo-11 | 76 m (arr) | 33 m | 34 m |
| oscar-15 | 71 m (arr) | 53 m | 54 m |
| **india-9** | 108 m (**arrived**) | **NO arrival** | **NO arrival** |

It tightens the *easy* hard-tail seeds but **regresses india-9 at every creep floor**: easing the nav
*delays the lead*, and on a 369 m worst-opposite climb the lead misses the harness window — exactly
the **slow-failure of [009](009-far-village-tactical-window-and-network-ceiling.md) / movement RC#2**
the floor was added to prevent. You cannot make the point man wait without slowing the point man.
Reverted; combat.ts is byte-identical to HEAD.

## Conclusion / standing guidance

- The **never-freeze floor is load-bearing.** Do not reorder it vs the pace governor to chase the
  mid-climb straggler gap — it reintroduces the slow-failure on hard far villages.
- Cohesion **at the objective is already 100%** (`squad-arrival`). The 70–108 m `follower-strand`
  number is a first-tick instant sample of a realistic climb-stretch, not a stranding.
- If ever revisited: the *only* lever that closes the gap without delaying the lead is a **modest
  straggler hustle-boost** (the trailing man double-times, the lead keeps pace) — but since the squad
  already consolidates at the objective, that is most likely solving a non-problem. Metricize against
  `squad-arrival` (not `follower-strand`'s instant sample) before touching it.

## Reproduce

```
npx tsx scripts/squad-arrival.ts          # authoritative: squadCoh 100%, maxStrag 33m
npx tsx scripts/follower-strand.ts        # the instant-sample gaps (india-9 108m etc.) — NOT a defect
```
