# 025 · A fleeing, visible straggler holds the TIC latch (and the clock) for 10+ game-minutes

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (2026-06-12) — mechanism current: one predicate `CombatSim.threatening` (combat.ts:424) + the `Unit.lastFiredS` stamp (combat.ts:1174) consumed by `inContact`, `rawContact`, SOP/reroute locks, and the CFF PID list.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Status:** RESOLVED 2026-06-12 — threat-weighted contact (see Resolution below)

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

## Resolution (2026-06-12)

**Fix: one predicate — `CombatSim.threatening(e, ref)` (`lib/sim/combat.ts`) — consumed by every
latch surface.** "Contact" now ends when the enemy breaks contact, not when he clears your optics.
A visible enemy holds contact iff he (a) fired within `THREAT_RECENT_S` (15 s) — needs the new
`Unit.lastFiredS` stamp at trigger-pull, rides serialize()'s whole-unit spread; (b) stands inside
`THREAT_CLOSE_M` (125 m); or (c) is NOT clearly breaking contact — `brainState "exfil"` is a break
(even paused at a rally with an empty path; held-out seeds showed those pauses chaining 10 s
contactHolds into minute-long latches), as is a movement order ending >=20 m farther away.
Stationary/pathless non-exfil men KEEP threat status, so a lull-and-renew ambusher waiting in LOS
still holds the squad in the fight. Raw visibility is untouched for perception/spotting/individual
fire decisions.

Wired into: `world.inContact()` (the store's 1x TIC speed latch + warp gate — enemy-owned
projectiles only now, via `p.faction`, so our own parting shots don't pin the clock), `tasks.ts`
`rawContact` (squadState release -> the consolidate beat), `reroute`/`setSOP` locks,
`fireAimpoint`'s PID list (no fire mission proposed on a broken-contact runner), and the
DeployScreen contact/SOP-lock mirrors (caught by the adversarial pass — the panel would otherwise
have kept showing "IN CONTACT"/locked through the released window). The COP-wire FPF check and
render FX stay raw deliberately.

**Probe:** `scripts/tic-release-probe.ts` (promoted from scratch) — forces the director to stage a
real fight cell against a marching patrol, then measures release-after-decided, scored from
max(tDecided, lastShot) on BOTH sides (a parting shot legitimately re-holds 15 s). Target <=25 s.
The held-out set is the representative one — its stragglers flee SILENTLY, like the live-observed
12-minute case; on the tune set HEAD's worst raw holds (104/102 s) are partially excused by
parting shots that HEAD's own pathology provokes (the latched squad keeps pressing the runner).

| metric | tune HEAD (10) | tune fixed | held-out HEAD (6) | held-out fixed |
|---|---|---|---|---|
| relSquad mean/max (raw max) | 16 / 25 (104) | 16 / 24 (30) | 29 / 68 | **10 / 29** |
| relGlobal mean/max (raw max) | 10 / 25 (102) | **5 / 15** (31) | 20 / 58 | **0 / 2** |
| over 25 s (squad / global) | 0 / 1 | **0 / 0** | 3 / 2 | 1¹ / **0** |
| TIC rising edges mean/max | 5.2 / 8 | **2.4 / 7** | 5.3 / 13 | **3.0 / 11** |

¹ the one held-out residual (29 s) is a straggler passing **30 m** from the squad — inside
decisive range, correctly held. The edges row refutes the flicker concern: the fix REDUCES
contact flicker on both sets. CFF re-raises after decided (carryover-corrected): 1->1 tune,
0->0 held-out — the probe (deny-on-sight) cannot reproduce the live 5+ re-raise chain, but the
`fireAimpoint` gate removes it structurally: a broken-contact runner can no longer be a PID
aimpoint at all.

Standing checks green: tsc - build - lint - smoke (serialize round-trip incl. `lastFiredS`) -
balance (KIA 1.00, WIA 7.25, 0 stranded; same-day HEAD A/B in the progress report). Adversarially
verified (UI-mirror bug found+fixed; determinism/serialization/entry/exfil/COP/perf audited
clean). Evidence: `docs/progress/2026-06-12-tic-release/`.
