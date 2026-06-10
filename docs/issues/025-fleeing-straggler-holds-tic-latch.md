# 025 · A fleeing, visible straggler holds the TIC latch (and the clock) for 10+ game-minutes

**Status:** OPEN (observed live 2026-06-10 during the people-immersion W3 capture session)

## Symptom

After a firefight is decided — every enemy in `exfil`/`scoot`, none firing — the squad can stay
`inContact()` for 10+ game-minutes because ONE wounded straggler limps away in open ground and
stays inside someone's `visibleEnemyIds`. Effects compound:

- The TIC speed latch keeps the campaign clock pinned at 1× (the player cannot compress time
  through a fight that is functionally over — observed ~12 game-minutes of "break" while the
  last runner, hp 10, crawled away at ~200–500 m).
- `t.squadState` stays `"break"` the whole time, so `releaseCombat` (and with it the
  consolidate-and-reorganize beat, `lib/sim/world/tasks.ts:338`) never runs until the runner
  finally clears LOS.
- The squad-combat brain keeps re-raising the call-for-fire request on the runner
  ("pinned, enemy fixed" lines repeated 5+ times after the cell had broken).

## Where it lives

`lib/sim/world/world.ts:856` — `inContact` is `(t.contactHold ?? 0) > 0 || members.some(m =>
m.visibleEnemyIds.length > 0 || m.suppression > 0.3)`. A visible-but-harmless enemy
(`brainState === "exfil"`, `hasFired` long ago, fleeing AWAY) counts the same as a man shooting
at you, and on the open valley floor LOS to a fleeing runner persists for hundreds of meters.

## Reproduction (live, survey-12)

1. `newCampaign("survey-12")`, presence patrol east of the COP on the open floor.
2. Force a harass/ambush cell (`state.enemyHeat = 0.4; state.nextActivityAt = 0` while a patrol
   is out), let the fight run; deny fires.
3. When the cell breaks, watch `world.inContact()` + the task's `squadState`: with a wounded
   straggler in open LOS both stay latched (observed clock 8631 → 9796+ still `"break"`,
   `contactHold` pinned at 10, all member suppression 0, all enemies `exfil` ≥ 230 m away).
4. Teleporting the straggler 500 m (out of LOS) releases contact within the 10 s `contactHold`
   decay and the consolidate beat fires immediately — confirming the straggler's LOS was the
   only thing holding the latch.

## Suggested fix shape (for a future session)

`inContact` (or just the speed-latch/fire-request consumers) should weigh a visible enemy by
threat, not mere visibility — e.g. a sighted enemy only holds contact if he has fired within the
last N seconds OR is closing/within some range. FM-style: "contact" ends when the enemy breaks
contact, not when he finishes leaving your binoculars' field of view. Keep raw visibility for
intel/spotting; gate the TIC latch, the CFF re-raise, and `squadState` release on the
threat-weighted version. Verify with a probe asserting time-to-release after the last enemy shot
across ~20 staged fights (target: release within `contactHold` decay + ~15 s, never minutes).
