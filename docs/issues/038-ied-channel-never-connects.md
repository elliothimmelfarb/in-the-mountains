# 038 — The IED channel never connects: placement/trigger geometry makes the signature opener a dud

> **Ledger status (filed 2026-07-16 @ post-network wave, measured):** OPEN — design/sim change
> needed; requires its own COIN-gate cycle. Entries here are dated claims; code outranks the ledger.

**Severity: Medium-High (a shipped design pillar is causally inert; realism gap).**

## What was measured

`scripts/patrol-predictability-probe.ts` (3 gate seeds × 8 days × fixed/varied approach axes —
the COIN gate's full careful commander): **6 IEDs planted, 0 detonated, 0 IED casualties across
48 tour-days.** Every charge dudded or was culled with its cell. The enemy-network wave's
"IED-initiated complex ambush — the signature valley opener" (`director.ts spawnIedAmbush`)
does not function as a threat, so the patrol-heat adaptation (a design centerpiece of the wave:
"high-heat road/trail cells become preferred IED ground") is real, working code with **no causal
effect on outcomes**. Evidence: `docs/progress/2026-07-16-patrol-predictability/`.

## The mechanism (verified at the code)

1. **Placement is a radial guess.** `spawnIedAmbush` (`lib/sim/world/director.ts:117-175`)
   extrapolates `dir = norm(patrol − cop)` and samples 5 candidates 30–95 m ahead of the
   patrol's CURRENT position along that ray (heat-biased pick among them). The patrol's actual
   A* path curves with terrain; a doglegged (varied) route isn't radial at all.
2. **The trigger is 8 m** (`plantIED`, `lib/sim/combat.ts:1574` — victim-initiated within
   `triggerRadius: 8`). A ≥8 m miss between guess and path = no detonation, ever.
3. **The cell's patience is ~104 s** (`lib/sim/ai/insurgent.ts:64` — iedInit holds fire until
   `brainTimer ≤ −90`, i.e. ~90 s past the initial 4–14 s), then it opens up (compromising the
   ambush) or exfils; the cull (`combat.ts stepIeds`) removes the charge when the cell is gone.
   IED_TTL is 600 s. A patrol 200+ m out when the charge is laid may not even ARRIVE in time.
4. Channel preconditions are themselves narrow: `enemyHeat > 0.45` + a living cache within
   600 m + the activity roll — a well-run COIN valley (survey-2) never crosses the heat floor,
   which is GOOD design (the reward for winning attitudes); the problem is 1–3.

## Why it matters

- FM 3-24's IED logic — predictability is lethal, route variety and population intel are the
  counters — is the mechanic the network wave set out to build. With 0% connection, route
  hygiene is worthless (measured: KIA/day 5.14 vs 5.00 fixed-vs-varied), the found-cache /
  cache-destruction loop loses its payoff (denying munitions to a gun that never fires), and
  the triggerman role (`ied_team`) is set dressing.
- The player-facing consequence surface ("why did I lose men — what do I change?") loses its
  best teachable lever.

## Design directions (for the fix wave — pick ONE mechanism, not patches)

- **Command detonation at closest approach:** the triggerman (`ied_team`, already spawned)
  fires the charge when a friendly reaches the local minimum of distance-to-charge (or within
  a widened radius, e.g. 15–20 m with damage falloff) — kills the knife-edge 8 m geometry
  while keeping the counter-play (spot the triggerman, vary routes so the charge is far from
  your actual path).
- **Place on the historical corridor, not the forward guess:** site the charge on the hottest
  heat bucket ALONG the patrol's likely path network (e.g. the A*-corridor between COP and the
  patrol's apparent objective), so heat genuinely predicts placement and route variety
  genuinely defeats it — the FM 3-24 loop becomes mechanical.
- **Patience/TTL honest to doctrine:** real emplacement teams overwatch for hours; ~104 s of
  patience + 600 s TTL are combat-pacing constants applied to a stakeout mechanic.

Any change here is a sim/balance change: full COIN gate + `patrol-predictability-probe`
before/after (the probe is the purpose-built instrument — expect plants > 0, dets > 0, and a
REAL fixed-vs-varied hit-rate gap when the channel works; never tune casualties to a target).

## Repro

`npx tsx scripts/patrol-predictability-probe.ts 3 8` (or per-seed single-policy runs in
parallel: `survey-1 8 fixed` / `survey-1 8 varied`) — read plants/dets/duds.
