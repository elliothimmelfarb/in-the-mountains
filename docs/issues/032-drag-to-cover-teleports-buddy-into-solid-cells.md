# 032 — dragToCover places the hauling buddy inside solid cells (permanent wedge)

**Severity: Medium (one man per incident is permanently immobilized until the garrison
self-heal catches him; the loop dominated the out-of-contact stall-wipe telemetry).**
Found 2026-07-02 (realism campaign, KOP agent) while chasing the Phase-1 side-finding of
**938 out-of-contact stall-wipes attributed `friendly:guard`** (obstacle `Structure(flank)`
945) in `docs/progress/2026-07-02-realism-campaign/baseline/combat-grind-HEAD.txt`.
**The mechanism is in `combat.ts` (owned by another agent this campaign) — a garrison-side
self-heal now contains the damage (see Resolution), but the WRITER is still unfixed.**

## The verified mechanism (dumped data, seed bal-2, balance.ts staging)

`CombatSim.dragToCover` (`lib/sim/combat.ts:1892`) checks passability for the CASUALTY's
next drag step — but then writes the hauling buddy's position **without any check**:

```ts
if (this.terrain.passableCell(Math.floor(next.x / cs), Math.floor(next.y / cs))) {
  cas.pos = next;
  buddy.pos = add(next, scale(dir, -1)); // ← 1 m behind the drag point, UNCHECKED
```

A drag along a building face (findCover loves walls — Structure carries cover 0.55) puts
the buddy's spot inside the footprint. Trace (scratch probe, since deleted — recipe below):

```
t=1110.2s us-y ENTERED SOLID cell=(256,385) land=Structure pos=(1284.87,1927.94)
          prev=(1286.49,1928.87) bs=aiding wounds=1 nearestCas=us-e@1.1m   ← 1.9 m jump
t=1110.5s us-e ENTERED SOLID cell=(256,385) ... bs=aiding nearestCas=us-y@1.0m
```

(us-e and us-y were mutually aiding; each entered the latrine footprint as the BUDDY of
the other's drag.)

Once inside a solid cell the man is frozen forever: `moveUnit` refuses every micro-step
(current cell impassable ⇒ next/slideX/slideY all impassable), the 2 s watchdog wipes his
path, and the garrison re-issues the same walkTo — `walkable()` (`path.ts:538`) samples
from k=1 and **never tests the starting cell**, so it keeps returning a "clear" straight
line. Result on bal-2: **944 of 951** out-of-contact stall-wipes were ONE man (us-e, on
guard, post 5.2 m away, wedged in the latrine).

## Repro recipe

1. World `bal-2` at 90×, `state.enemyHeat = 0.6+(run%5)*0.06`, sq1+medic presence patrol
   (mirror `scripts/balance.ts` staging), run 50 game-min.
2. Each tick, flag any US unit whose current cell fails `terrain.passableCell` — the entry
   event fires at ~t=1110 s with `brainState=aiding` and a >1.5 m single-tick jump.

## The right fix (combat.ts owner)

Check the buddy's spot before writing it; if impassable, leave the buddy at his current
position (he is adjacent and still hauling — the drag itself already moved the casualty):

```ts
const bp = add(next, scale(dir, -1));
if (passable(bp)) buddy.pos = bp;
```

Related: issue 024 (buddy-drag pacing) touches the same routine.

## Resolution (containment, 2026-07-02 — garrison side)

`lib/sim/world/garrison.ts` (tickGarrison) now snaps any off-task member standing in an
impassable cell to `terrain.reachablePoint` once (an invariant self-heal — position inside
a solid cell is a breach whoever writes it). Measured, bal-2 50 game-min balance staging:
out-of-contact garrison stall-wipes **951 → 1** (the survivor is a patrol ford-crossing
wipe, unrelated). The self-heal does NOT excuse the unchecked write: a wounded man mid-drag
can still spend the fight inside a wall until the garrison reclaims him.

## Resolution (ROOT FIX, 2026-07-03 — combat.ts owner) — ✅ FULLY RESOLVED

The unchecked writer is now guarded at the source. `CombatSim.dragToCover`
(`lib/sim/combat.ts:1988`, shipped in `fa797c5` item 3) checks the hauling buddy's spot
before writing it; if the cell is impassable the buddy simply stays where he stands and
keeps pulling from there (he is adjacent and the drag already moved the casualty):

```ts
const haul = add(next, scale(dir, -1));
if (this.terrain.passableCell(Math.floor(haul.x / cs), Math.floor(haul.y / cs))) buddy.pos = haul;
```

The buddy can no longer be teleported into a solid cell, so the eternal wipe/re-issue
loop cannot form. The garrison self-heal from `dbf317c` remains as the invariant backstop
(any off-task man found in a solid cell — whatever wrote him there — still snaps out once).
Both halves are now in place: **root writer fix + containment backstop.** Verified: smoke
SMOKE OK, `combat-grind` out-of-contact wipes across all causes **1718 → 25**
(`docs/progress/2026-07-02-realism-campaign/after/`).
