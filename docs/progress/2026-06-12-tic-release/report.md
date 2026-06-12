# Threat-weighted contact — the fleeing straggler no longer holds the TIC latch (issue 025)

**2026-06-12 · resolves [docs/issues/025](../../issues/025-fleeing-straggler-holds-tic-latch.md)**

## The complaint, as a number

After a firefight is decided (every enemy in `exfil`, nobody shooting), one wounded straggler
limping away in open LOS kept the squad `inContact()` — observed live for **10+ game-minutes**:
campaign clock pinned at 1×, the consolidate beat blocked, "pinned, enemy fixed" call-for-fire
re-raised 5+ times on a harmless runner. Cause at `world.ts` / `tasks.ts`: every latch surface
counted `visibleEnemyIds.length > 0` — a man running away 250 m out scored the same as a man
shooting at you.

## The probe (`scripts/tic-release-probe.ts`, kept)

Forces the enemy director (the live-repro recipe: `nextActivityAt = now` against a marching
patrol) to stage a real fight cell — shared `squadId` + leader, so the cell-combat brain breaks
contact the way live fights do; a hand-spawned leaderless mob never collectively exfils, which is
why the first staging attempt produced 8/12 never-ending fights. Measures seconds from "fight
decided" (all staged fighters dead/evac/`exfil`, no hostile rounds in flight, squad unsuppressed)
to (a) `squadState` clearing — relSquad, the consolidate beat — and (b) `world.inContact()` going
false — relGlobal, the store's 1× speed latch and warp gate. Scored from max(tDecided, lastShot)
on BOTH sides: a parting shot legitimately re-holds for 15 s. Target ≤ 25 s
(`contactHold` 10 s + `THREAT_RECENT_S` 15 s). Also counts TIC rising edges per fight (flicker
guard) and CFF asks raised after decided (carryover-corrected, denied on sight).

**Which set to believe:** the held-out stragglers flee *silently* — like the live-observed
12-minute case — so held-out is the representative measurement. On the tune set, HEAD's worst raw
holds (104 s squad / 102 s global) are partially excused by the adjustment, because the latched
squad keeps pressing the runner and provokes the very parting shots that excuse the hold.

## Baseline → after (HEAD numbers from a clean `git worktree` at 2f922ba, same probe)

| metric (s, parting-shot adjusted) | tune HEAD (10) | tune FIXED | held-out HEAD (6) | held-out FIXED |
|---|---|---|---|---|
| relSquad mean/max (raw max) | 16 / 25 (104) | 16 / 24 (30) | 29 / 68 | **10 / 29** |
| relGlobal mean/max (raw max) | 10 / 25 (102) | **5 / 15** (31) | 20 / 58 | **0 / 2** |
| over target 25 s (squad / global) | 0 / 1 | **0 / 0** | 3 / 2 | 1¹ / **0** |
| TIC rising edges mean/max | 5.2 / 8 | **2.4 / 7** | 5.3 / 13 | **3.0 / 11** |
| CFF asks after decided | 1 | 1 | 0 | 0 |

¹ the single held-out residual (29 s) had the straggler pass **30 m** from the squad — inside
decisive small-arms range, where holding contact is correct behavior, not the bug.

The minute-long silent-straggler latch is gone (68→29 / 58→2 s worst case, means 29→10 / 20→0 s),
and the edges row shows the fix *reduces* contact flicker — the adversarial reviewer's
premature-release concern, measured and refuted. Verbatim runs: `baseline-HEAD-*.txt`
(original, pre-adjustment scoring) and `after-*.txt` in this directory; corrected-scoring HEAD
numbers above from the worktree A/B.

## The fix — one mechanism

`CombatSim.threatening(e, ref)` (`lib/sim/combat.ts`): a visible enemy holds contact iff he

1. fired within **15 s** (`Unit.lastFiredS`, stamped at trigger-pull; rides serialize()'s
   whole-unit spread — no save migration, old saves read "never fired"), or
2. stands inside **125 m** (a visible armed man at decisive range is never ignorable), or
3. has **not** broken contact: `brainState "exfil"` counts as broken even paused at a rally with
   an empty path (held-out seeds caught those pauses chaining 10 s contactHolds into minute-long
   latches); otherwise a movement order ending ≥ 20 m farther away counts as broken. Stationary
   non-exfil men keep threat status — a lull-and-renew ambusher waiting in LOS still holds the
   squad in the fight.

Consumed by every latch surface (special cases deleted): `World.inContact()` (projectiles count
only when enemy-owned — `p.faction`, not an owner lookup, so a culled shooter's rounds still
attribute), `World.seesThreat` → `tasks.ts` `rawContact`, the `reroute`/`setSOP` locks,
`fireAimpoint`'s PID list, and the DeployScreen contact/SOP-lock mirrors. Raw visibility is
deliberately untouched for perception, spotting/intel, individual fire decisions, the COP-wire
FPF check, and render FX.

Doctrine: contact ends when the **enemy** breaks contact (FM 3-21.8 ch. 7, actions on contact /
break contact), not when he finishes leaving your optics' field of view.

## Live in the real app (the issue's own repro recipe, via `window.__ITM`)

Fresh campaign `tic-live-1`, sq1+medic presence patrol, director forced until a harass cell
engaged (the staging moment itself confirmed the **rising edge live**: speed snapped 16×→1× when
the cell spawned). Fires denied throughout. After the cell broke and exfiled, through the real
`frame()` loop: `inContact()` released **1 s** after fight-decided; then asserted in one shot —
`{inContact: false, ticBadgeShown: false, speedNow: 16 (re-accepted), squadState: "clear",
sopAccepted: true}`. The exact live symptom chain from the issue (clock pinned, SOP locked, badge
stuck) is gone. Screenshot: `tic-live-released.png`.

## Cross-system verification

- `npx tsc --noEmit` · `npm run build` · `npm run lint` · `npx tsx scripts/smoke.ts` — green.
- `npx tsx scripts/balance.ts 12 50`, same-day worktree A/B (`balance-ab.txt`): HEAD
  **KIA 1.75 · WIA 9.42** → fixed **KIA 1.00 · WIA 7.25**; 12/12 contacts, 0 stranded, 0 civcas
  on both sides. The fix lowers casualties, not raises them (see Residuals).
- **Adversarial pass (fresh agent, briefed to refute):** found one real miss — the DeployScreen
  SOP-lock/contact mirrors still used the raw predicate, which would have kept the panel showing
  "IN CONTACT"/locked through the released window (fixed); confirmed determinism (no rng/clock in
  the new code, save/load restores `timeS` before any `threatening` call), fight entry (every
  director spawn pattern still latches on sight or first shot), exfil-rule soundness (terminal
  state, close-range check precedes it, peeling coverers re-stamp `lastFiredS`), COP defense
  (the world.ts:1007 FPF gate actually improves), and O(visible) perf. Its flicker concern was
  measured and refuted (edges row); its probe-carryover finding corrected the CFF claim.
- Downstream consumers audited: `formation.ts:952`'s 10-min post-contact caution window now
  starts when the fight actually ends; the director's walk-indirect check, the ● TIC HUD badge,
  and audio contact-ducking all release consistently.

## Residuals, named

- **Balance shifts DOWN, attributably**: same-day same-seed A/B reads HEAD WIA 9.42 → fixed 7.25
  (−23%), KIA 1.75 → 1.00. Direction matches the mechanism (squads release decided fights and
  consolidate instead of pressing stragglers); both runs bracket the 6.92–8.42 historical band
  and the run-to-run σ is still unquantified (standing 026 harness debt), so the magnitude is
  soft even though the direction is consistent. Friendly-side-safer drift was already flagged in
  026 — left on that watch, not re-tuned here.
- A fight can release after ~25 s of total enemy silence if every visible enemy is
  simultaneously breaking; renewed fire re-latches instantly (and re-fires the TIC interrupt).
  Cell-combat displaces by halves, so this needs genuine collective flight — accepted as
  realistic, and the edges metric shows net flicker went DOWN.
- The probe discards seeds where the director stages no fight in 40 attempts (2/12 tune, 2/8
  held-out) — disclosed coverage, not hidden.
- `threatCentroid`/`visibleEnemyCount` (squad-combat) stay raw: a runner still skews the break
  drill's aimpoint/count while a real threat holds squadState. Borderline by design ("raw for
  fire decisions"); noted by the adversarial pass, not blocking.
- The deliberate change NOT made: no hysteresis added to the global `inContact()` (the squad
  latch has `contactHold`; the global one never had any). Measured edges went down, so adding
  state there is unjustified complexity today.
