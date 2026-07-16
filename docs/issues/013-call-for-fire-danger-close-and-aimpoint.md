# 013 — Squad called fire missions on itself / nowhere near the enemy (RESOLVED 2026-06-06)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-06) — mechanism current: `fireAimpoint` densest-cluster PID + danger-close withhold (squad-combat.ts:499) + FDC check-fire in `stepFireMissions` (combat.ts:1632) live.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity: High** (fratricide + immersion-breaking). Player report: *"a squad called a [mortar]
mission much too close to them, nowhere near the enemy."* Both halves of that complaint were real,
reproducible, and measurable. Found, fixed, and verified in the 2026-06-06 call-for-fire pass.
See `docs/progress/2026-06-06-firemission-realism/` for the full write-up, before/after diagram, and
the held-out numbers.

## What was wrong

The squad-combat AI's call-for-fire (`lib/sim/ai/squad-combat.ts:maybeRequestFires`) computed the
aimpoint from `threatCentroid` and gated it only with `threatIsReal` — neither of which is what a
real FO does:

1. **"Nowhere near the enemy" — centroid averaging.** `threatCentroid` averaged the positions of
   **all** visible enemies. On a two-sided / L-shaped contact (enemy fire from two positions) the
   average lands *between* the groups — often right on the squad. And `threatIsReal` returned true on
   a `threatDir`-only contact (shot at, nothing seen), so `threatCentroid` would fire on a **projected
   120 m guess** with no PID.
2. **"Much too close" — no danger-close gate.** Nothing stopped the AI from proposing a grid inside
   its own danger-close radius. `CombatSim.isDangerClose` only *labelled* the round "DANGER CLOSE";
   it never prevented the call. Because `detonate` damages all factions in radius and tags
   `casualtyByFaction = "us"`, this was real **fratricide**, not cosmetic.

### Evidence — `scripts/fire-mission-probe.ts` (40 seeds `bal-0..39`, 30 game-min each)

The probe intercepts every AI call-for-fire at raise-time and scores the aimpoint against ground
truth (nearest friendly, nearest observed/living enemy, danger-close radius), and in `approve` mode
counts real US fratricide.

| metric | HEAD (deny) | HEAD (approve, rounds land) | meaning |
|---|---:|---:|---|
| `d_friendly` min | 23 m | **10 m** | closest a round was called to a friendly (81 mm lethal = 24 m) |
| `dangerClose%` | 3% | 4% | aimpoint inside `blast×2.5` of a friendly |
| `onFriendlies%` | 0% | 1% | aimpoint inside the **lethal** blast of a friendly |
| `projection%` | 9% | 32% | fired on a grid with **no enemy observed** |
| `offTarget%` (vs observed enemy) | 18% | 52% | aimpoint >60 m from the nearest *seen* enemy |
| **US fratricide / 40 deployments** | — | **1** | a friendly wounded/killed by an AI-called mortar |

## The fix (one mechanism: keep HE off your own troops, on an observed target)

`lib/sim/ai/squad-combat.ts`
- **New `fireAimpoint`** — the aimpoint is the centroid of the **densest cluster of currently-observed
  enemies** (cluster radius 35 m). Never the global centroid (which on a split contact lands on the
  squad); never a projection (returns `null` with no PID → no mission). Deterministic (stable
  iteration + first-max tie-break).
- **Danger-close gate in `maybeRequestFires`** — withhold the request if the aimpoint is within
  `blast × 2.5` of **any** friendly (`playerUnits()`, not just the requesting squad). Deleted the old
  `threatIsReal`. `threatCentroid` is unchanged and still used for orientation/cover only.

`lib/sim/combat.ts`
- **FDC check-fire in `stepFireMissions`** — abort a US mission's remaining rounds if a friendly is
  within `blast × 1.3` of the actual impact point (the dynamic case the call-time gate can't foresee:
  troops maneuvering into the beaten zone after the mission is cleared). Enemy missions unaffected.

## Resolution — after the fix (same probe, same seeds)

| metric | HEAD → After (deny) | HEAD → After (approve) |
|---|---|---|
| `d_friendly` min | 23 → **40 m** | 10 → **69 m** |
| `dangerClose%` | 3% → **0%** | 4% → **0%** |
| `onFriendlies%` | 0% → **0%** | 1% → **0%** |
| `offLive%` (>60 m from any **living** enemy, tick-robust) | — → **0%** | — → **0%** |
| **US fratricide / 40 deployments** | — | **1 → 0** |

The aimpoint now sits on a living enemy in every case (`d_enemy_live` median ~2 m). The residual
~5% `projection%`/`offTarget%` is a **measurement artifact** (PID existed at decision-time mid-tick
but lapsed by end-of-tick when the probe samples one tick later) — proven by the tick-robust
`offLive% = 0%`. The AI never fires on a guess.

**Held-out proof** (entirely different valleys, `hold-0..29`, never measured on): 88 requests →
`dangerClose 0%`, `onFriendlies 0%`, `offLive 0%`, min standoff 55 m. The win generalizes.

**Verified by:** `scripts/fire-mission-probe.ts` (deny+approve, baseline/after/held-out) · standing
checks `tsc`/`build`/`smoke`/`balance` green (balance: KIA 0.75, 0 civcas, no stall) · an independent
adversarial code review (verdict "fix is sound", 90% confidence) · a live-app capture (app boots,
fire-support HUD intact).

**Restraint logged (Law 5):** I deliberately did **not** add an "in-extremis danger-close override"
that would let the AI propose fire on itself when about to be overrun — that reintroduces exactly the
reported failure mode, and the automatic break-contact safety already covers being overrun.
