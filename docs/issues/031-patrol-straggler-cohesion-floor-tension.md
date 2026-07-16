# 031 — Patrol straggler cohesion: hustle from the trail (floor reorder REFUTED, hustle SHIPPED)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-27) — mechanism current: straggler HUSTLE (`driveFollower` `paceScale` up to 1.6×, formation.ts:158) closes the gap from the trail. Do-not-retry (refuted at 01fd640, hustle shipped 83e4256): reordering the never-freeze floor vs the pace governor to slow the lead — regressed india-9 out of the window; binds while the never-freeze floor + pace governor are unchanged. See 036 for the complementary bounded halt.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: Low (cohesion texture on the hardest objectives).** Investigated 2026-06-27 under the
goal "soldiers … always stick together as a squad." **Outcome: the obvious fix (slow the lead to
wait) is a refuted slow-failure and is NOT to be re-attempted; the cohesion is instead paid from the
TRAIL side — a lagging follower HUSTLES to close the interval — which tightens the gap without
touching the lead's arrival. Shipped. See the Resolution at the bottom.**

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

## Standing guidance

- The **never-freeze floor is load-bearing.** Do NOT reorder it vs the pace governor to chase the
  mid-climb straggler gap — it reintroduces the slow-failure on hard far villages (the table above).
  Pay cohesion from the **trail**, never by slowing the lead.

## Resolution (2026-06-27) — straggler HUSTLE

The lever the floor-reorder section ruled out — *the trailing man double-times, the lead keeps pace* —
turned out NOT to be a non-problem. Implemented as a follower **hustle** (`lib/sim/world/formation.ts`
`driveFollower` + `combat.ts` `PACE_MAX`): a follower whose projected lag along the wake exceeds
`HUSTLE_LAG` (5 m) sets `paceScale = 1 + (lag−5)·0.03`, capped at **1.6×** — he picks up the pace to
regain his interval (FM 3-21.8 "close it up"), a spent man double-timing, never sprinting. The
navigator is **untouched** (his `paceScale ≤ 1`, floored at 0.5 exactly as before), so the lead's
arrival — and the tactical window — cannot regress. Pure geometry, zero RNG, no new persisted state.

| metric | baseline | floor-reorder (reverted) | **HUSTLE (shipped)** |
|---|---:|---:|---:|
| `follower-strand` worstGap: india-9 / mike-13 / foxtrot-6 / oscar-15 | 108 / 78 / 70 / 71 m | NO-ARRIVE / 78 / 23 / 53 | **64 / 25 / 31 / 37 m** |
| seeds with worstGap > 50 m (23-seed sweep) | 5+ | — | **2** (india-9 64, kilo-11 81 — the 369/552 m far villages) |
| `squad-arrival` within tactical window | 24/27 (89 %) | **broke india-9** | **25/27 (93 %)** ↑ |
| `squad-arrival` worst straggler @ objective | 33 m | — | **29 m** ↓ |
| `squad-arrival` squadCoh / homeOK | 100 % / 89 % | 100 % / 85 % | **100 % / 89 %** |

Closing stragglers from the trail consolidates the element *sooner*, so the window **improves** (89→93 %)
— the opposite of the lead-slowing approach. The two residual >50 m gaps are the farthest worst-opposite
villages (a long climb a hustling SAW gunner still can't fully erase); both still consolidate to 100 %
at the halt. Verified: `tsc` · `smoke` (determinism + serialize) · `balance` (combat-neutral — the
hustle only runs during the patrol move; combat resets `paceScale`).

## Reproduce

```
npx tsx scripts/squad-arrival.ts          # authoritative: within-window 25/27, squadCoh 100%, maxStrag 29m
npx tsx scripts/follower-strand.ts        # worstGap distribution: only india-9/kilo-11 > 50m
```

## Follow-up note (2026-07-03, issue 036)

This issue's `maxWedge = 0.0 s on every seed → nobody is stuck` reassurance rested on a **dead metric**:
`follower-strand`'s `maxWedge` was defined as time with `blockedTimer > 6`, but `watchStall` caps
`blockedTimer` at `STALL_WINDOW = 2 s`, so it was structurally always 0.0 s. Fixed in `follower-strand.ts`
(sums real wedge time now). Men **do** wedge on the march (COP b-huts, the wire, broken ground) — see
[036](036-point-man-doesnt-wait-for-wedged-follower.md), which adds a **bounded halt** so the point man
waits for a wedged/strung follower. Crucially it does NOT re-attempt the refuted floor-reorder: it is a
discrete, per-leg-budgeted stop (gated on being *blocked*, not merely *slow*), so it stays window-neutral
(`squad-arrival` identical) and the hustle here still owns the slow-climber case.
