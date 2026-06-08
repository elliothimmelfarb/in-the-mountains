# 023 — Combat feel: teleporting bullets, missing muzzle flash, suppression with no consequence

**Severity:** Medium (feel/realism) · **Status:** ✅ **5 shipped 2026-06-08**

## What

The owner played a firefight and named five defects — none a crash, all "feel." Turned into measurements
(`scripts/combat-feel-probe.ts`: a 60 fps render loop over the 0.1 s sim tick, plus two single-variable
micro-probes), four of the five traced to **one root cause**: the sim advances on a fixed 0.1 s tick but
the renderer reads its state *verbatim* at ~60 fps, with no interpolation.

1. **Bullets "appear midway / don't travel."** An 880 m/s round moves ~88 m per tick, so over a 200 m
   flight it takes only ~2 on-screen positions, each frozen ~6 frames then teleported. Measured: per-frame
   screen jump **123 px**, **93%** of frames frozen, **1.9** distinct positions per bullet.
2. **Flickery / "doesn't look right."** A muzzle flash (`ttl 0.12 s`) is aged a whole tick the instant it's
   born (effect aging runs after firing in the same tick), landing at `k=0.83` — past the `k>0.6` draw
   cutoff — before any frame samples it. Measured: **0 / 453** muzzle flashes ever reached a drawable frame.
3. **Suppressed soldiers fire just as much.** Suppression only widened dispersion; the firing *cadence*
   ignored it. Measured (one rifleman, suppression swept): fire rate **flat** (≈2.2 rds/s at suppression
   0.0 *and* 0.8).
4. **Every combatant feels the same.** Burst length came from the weapon alone; `composure`/`aggression`
   were inert in a firefight (disciplined 4.55 vs ragged 4.33 = no effect).
5. **Audio: the MG buzzes.** (Found by the survey workflow, not the recon.) The sim emits one muzzle event
   per round and the mapper makes one cue per round — but the synth then expanded *each* belt-fed cue into a
   5–9 round burst, so an 8-round M240 burst became ~40–70 cracks: a roar, not a hammer.

## Shape

A six-specialist survey→judge workflow ranked the best five fixes spanning visual + sim + audio; the
bullet-smoothness and suppression fixes were owner-forced. Implemented one writer per subsystem, each
re-measured in isolation on tuned **and** held-out seeds.

## Outcome — numbers first (3-seed firefight + 2 controlled micro-probes; HEAD vs after)

| # | fix | layer | before → after |
|---|-----|-------|----------------|
| 1 | render interpolation (sub-tick `getSimFrac`) | render | bullet jump **123→~20 px**, frozen **93→0%**; muzzle flashes drawable **0/453→453/453** |
| 2 | suppression cadence gate (cooldown ×, burst −) | sim | suppressed fire rate **flat → −48%** (2.2→1.05 rds/s pinned) |
| 3 | MG one-crack-per-round (delete synth burst loop) | audio | cracks per 8-round burst **~56 → 8**; mapper 1:1 invariant intact |
| 4 | tracer colour (insurgent green) + ratio by class | render+sim | rifle tracer **~25% → ~8%**, belts ~24%; green-in / amber-out |
| 5 | burst by composure+aggression (+panic spray) | sim | traits inert→active: disciplined vs ragged **4.55/4.33 → 4.06/4.33** (same-weapon gap bounded for balance; bigger read is cross-faction US~4.3 vs insurgent~5.0) |

## Safety

- **Determinism:** both sim edits reshape the *existing* `rng` draw (no added call); adversarial pass
  confirmed same-seed serialized state byte-identical on 3 combat seeds. Render interpolation is a pure
  read of the loop accumulator — sim untouched (Law 7).
- **Balance** (`balance.ts`, 16 deployments × 50 game-min, HEAD → after): US KIA `1.69 → 1.50`,
  US WIA `4.94 → 4.75`, enemy `5.50 → 4.88`, civ `2 → 0` — all within ±15% (slightly *fewer*
  casualties on both sides — suppression makes firefights more of a standoff). The personality
  "panic spray" was tuned *down* twice: stronger settings (panic 0.5–0.7 / aggressive gamma) measured
  US WIA +35% or KIA +30%, so the same-weapon personality is bounded and the visible read leans on
  the cross-faction difference + the suppression cadence (Law 3/5/8 — stop tuning, ship the safe one).
- `tsc` · `npm run build` · `smoke.ts` green; no new lint errors in production code.

## Deliberately deferred (logged for a future pass)

Deeper overlay de-clutter (merge the 3 contact cues, freeze cosmetic pulses on pause), a supersonic
*snap* for incoming rounds at the listener, a heavy-calibre .50 audio tier, and a probabilistic hold-fire
gate (deferred specifically because it would *add* an rng draw and shift the deterministic stream).

## Verified by

`scripts/combat-feel-probe.ts` (firefight + micro-probes A/B), `scripts/balance.ts`, `scripts/smoke.ts`,
`scripts/audio-probe.ts`, an adversarial-verification agent, and live CDP firefight captures.
Report: `public/manual/archive/reports/2026-06-08-combat-feel/report.html`.
