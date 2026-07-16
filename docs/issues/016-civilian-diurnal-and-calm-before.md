# 016 — Civilian diurnal pattern-of-life & the pre-contact "calm before" tell

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-06) — mechanism current: `sim.light`-keyed diurnal occupancy + pre-contact melt-away (staged-insurgent sensing at civilian.ts:112) live in `ai/civilian.ts`.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Status: ✅ Resolved 2026-06-06 (atmospherics wave, civilian stream).**
Severity: Medium (soul/realism — the flagship COIN tell the tutorial promises did not exist).
Owner file: `lib/sim/ai/civilian.ts` (engine, deterministic). Probe: `scripts/atmospherics-probe.ts`.

## What was wrong (HEAD before the change)

The valley was **diurnally flat**: civilians wandered 24/7 at constant outdoor population with no
dawn/dusk/home-by-dusk rhythm. And the flagship counterinsurgency tell — civilians **melting away
before an ambush** (DESIGN §3.6; the tutorial explicitly teaches the "calm before") — **did not
exist**: the brain reacted only to *armed men nearby* (the four graduated tiers) and to *gunfire*,
never to a staged-but-not-yet-firing threat. A player could not read the absence, because there was
no absence to read.

Baseline (`scripts/atmospherics-probe.ts diurnal survey-7`, before): outdoor occupancy **flat at
100 %** across all 24 hours, day and night identical. Melt-away: **0 % drop** before contact (no
mechanism).

## The fix (one robust mechanism, deterministic)

All in `civilian.ts`, keyed to data the sim already computes — **no new persisted field**, so
`serialize()` stays bit-identical (smoke round-trip green).

1. **Diurnal occupancy from `sim.light`.** The World writes `sim.light` (ambient 0..1) every tick from
   the solar clock. The brain keys outdoor **occupancy** to that light magnitude: full pattern-of-life
   at day (≥0.85), a *home-pull* growing as light falls (children/elders lean home earlier), indoors
   at night (<0.2). Occupancy is symmetric in light, so the brain **never needs a dawn-vs-dusk
   discriminator** (the restraint logged below). The "am I home?" test uses the **snapped** home
   (`reachablePoint→civSafePoint`, the same snap `civMoveTo` applies) computed lazily/memoized — using
   the raw village center read as never-home and re-fired the path every tick (the issue-010 thrash).

2. **Night-home pre-empts Wary/Clear-road.** Hoisted above the reaction tiers: a villager merely wary
   of a distant armed man at 02:00 still wants to be inside, not frozen in a field. Yields only to a
   real **Flee** (tier 3). A mid-errand villager caught by dusk turns around at once (the pathGoal
   guard re-issues home when the current goal is a daytime errand, but not every tick once homebound).

3. **Melt-away (the calm before).** In the *same* one-pass armed scan, flag **staged** insurgents —
   `brainState==="ambush"` OR (`"patrolling"`+`technique==="concealed"`), both `faction==="insurgent"`,
   both alive but `!hasFired` — out to a **150 m** sensing radius (wider than the 45 m armed-proximity
   ring, so the gentle melt fires *before* the they're-on-top Wary/Flee). Sensed villagers quietly go
   home, **children first**, departures **staggered** by a seeded `rng.chance` so the fields *thin*
   over a few seconds (the readable "melting", not a teleport). Precedence: Flee > Melt > Night-home >
   Clear-road > Wary > diurnal-Oblivious.

Determinism: every decision derives from `RNG.hashString` (the existing `trait()` id-hash), the seeded
`sim.rng`, the deterministic `sim.light`, and sim unit state. No `Math.random`, no wall-clock.

## After (verified — tuned `survey-7`, held-out `survey-43`)

`scripts/atmospherics-probe.ts` (mover-faithful oracle: ground-truth time from `world.secondsOfDay`,
independent of the `sim.light` the brain reads; "home" = the same snapped point the mover walks to):

**Diurnal (mode A)** — outdoor by hour, before → after:
| seed | night (00–04) | midday (12) | dawn (06) | dusk (19) |
|---|---|---|---|---|
| survey-7 (tuned)   | 100 % → **0 %** of pop | 100 % (flat) → **83 %** | flat → **46 %** (rising) | flat → **33 %** (falling) |
| survey-43 (holdout)| flat → **~13 %** of pop¹ | flat → **62–90 %** | flat → **38–48 %** | flat → **16–20 %** |

¹ The hot-seed night floor is **real, not a bug**: those civilians are correctly fleeing/clearing
insurgents **infiltrating the draws after dark** (verified: an insurgent 9–15 m away), not stranded by
the diurnal logic. Gate: night ≤ 22 % of pop AND ≤ 35 % of midday — PASS on both seeds.

**Melt-away (mode B)** — staged ambush cell ~100 m off a local civ cohort, 90 s **before any shot**:
| seed | threatened cohort closes distance-home | control cohort | shots | children |
|---|---|---|---|---|
| survey-7 (tuned)    | **56 %** (out 4→2) | 0 % (barely moves) | 0 | lead |
| survey-43 (holdout) | **48 %** (out 18→9) | 24 % | 0 | kid-dist halves at t=42 s, before adults |

Determinism: same seed → identical civilian-position hash, both modes, both seeds. Standing checks:
`tsc` clean · `smoke` SMOKE OK (serialize round-trip) · `lint` exit 0 · `balance 12×50` no stall, civ
cas 0.

## Restraint logged (Law 5)

The one thing deliberately **not** built: a typed time-of-day / `sim.dayFrac` seam to distinguish a
dawn *event* from a dusk *event*. It would be the cleanest discriminator but requires editing
`combat.ts`/`entities.ts` (out of this wave's ownership). The light-magnitude design is correct for
*occupancy* (what's measured and seen) and needs no such field; a future feature that genuinely needs
the dawn/dusk distinction (e.g. roosters at dawn only) should add a sanctioned `sim.dayFrac` seam —
**not** a render-side or `WeakMap` hack (a WeakMap was rejected here because it breaks serialize-replay
determinism, Law 7).

## Reproduce

```
npx tsx scripts/atmospherics-probe.ts diurnal survey-7 2     # occupancy-by-hour curve + gates
npx tsx scripts/atmospherics-probe.ts melt    survey-7       # pre-contact melt + control + determinism
npx tsx scripts/atmospherics-probe.ts diurnal survey-43 2    # held-out
npx tsx scripts/atmospherics-probe.ts melt    survey-43      # held-out
```
