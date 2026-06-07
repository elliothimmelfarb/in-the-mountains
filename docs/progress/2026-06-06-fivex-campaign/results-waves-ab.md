# 5× Campaign — Waves A & B results (verified)

Both waves landed on `main`, file-disjoint, each independently adversarial-verified. Combined done-gate
on the merged tree: `tsc` exit 0 · `SMOKE OK` (124.3 KB, 79 units, serialize round-trip clean) · `AUDIO OK`.
Scratch swept to 0.

## Wave A — Combat soul (the firefight now reads true)
Six `lib/sim` files: combat / weapons / ballistics / ai/friendly / ai/insurgent / world/director.
Adversarial verifier reproduced every number (balance run **twice → byte-identical**; determinism intact;
`civClear` intact; no DO-NOT-RETRY violation).

### The headline: the inverted exchange ratio is fixed — the right way
| balance.ts metric | HEAD | After (12×50) | Held-out (20×50, fresh seeds) |
|---|---|---|---|
| US KIA | 0.75 | **0.33** ↓ | 0.30 |
| US WIA | 5.58 | **3.92** ↓ | 2.70 |
| Enemy accounted | 1.25 | **4.42** ↑ (3.5×) | 5.40 |
| Exchange ratio | ~5:1 **against** | **~even** | **US-favorable** |
| Civ cas | 0 | 0 | 0 |
| Stalls | none | none | none |

US now *wins firefights tactically* with **KIA falling, not spiking** — no turkey-shoot (still ~3 WIA/run).

### Realism wins (verified)
| # | Metric | HEAD | After |
|---|---|---|---|
| 1 | Suppression reachable / pinned fraction | 0.000 / ~0 | up to **1.0** / **27–36%** pinned |
| 2 | Stance: standing / prone under fire | 73% / 0% | **~10% / 1.7–4%** (crouch ~87%) |
| 5/18 | 5.56 kill% @25 m / terminal dmg | 0.7% / 30.7 | **2.1% / 42.2** (gentle tail preserved, no cliff) |
| 9 | Enemy mean elevation advantage | +2.41 m | **+38 m** (ambush) — real plunging fire |
| 4 | Shoot-and-scoot displacement | 0.02% | **~81%** of engage entries (isolation) |
| 11 | Frags (`grenade & clear`) | dead code | **wired live** (civ-gated, ≤35 m close) |
| 12 | Enemy within-40 m massing | 0.00 | **1.4–2.1** (L firing line) |
| 30 | Night tempo | inverted (1.67× at night) | **flipped** (deep-night ×1.8 delay; dawn/dusk ×0.75) |
| — | Wind drift (bonus) | flat ~0.23 m | **grows 0.31→2.45 m** with range |

**Honest residuals (logged, not forced — Law 5/8):** suppression *element-average* peak (0.43–0.48) sits below
the guessed 0.6–0.85 band (per-contact mechanism is decisive; fights are short/sharp; pushing harder risks the
KIA guardrail — calibrated ~35% it converges without breaking balance, so logged); mean enemy pairwise not
reliably down; elevation above the guessed band but deemed *more* Korengal-faithful. Process finding: the
committed `realism-probe.ts` lacked stance/scoot/massing/elevation probes → being closed by a follow-up agent.

## Wave B — Procedural audio (the absent transformative dimension)
New `lib/audio/` (cue/mapper/synth/player/index) + wiring in `state/store.ts` + `components/world/WorldView.tsx`
+ HUD volume/mute + `scripts/audio-probe.ts`. Render-side, determinism-safe.

Verified: `AUDIO OK` — **1:1 cue per effect-id** (1252 cues == 1252 non-blood effect ids, 0 dropped, 0
double-fired across 1480 cues), **mapper is pure & deterministic** (two replays byte-identical, 7394 cues),
**`lib/sim` has ZERO audio imports** (determinism contract intact), bounded **24-voice** pool, AudioContext
**unlocks only on user gesture** (no autoplay violation), audio **silent during pause/warp**. tsc/build/smoke green.

Architecture: pure `mapper.ts` (sim Effect/LogEntry/FireMission stream → `AudioCue[]`, headless-testable) +
browser `synth.ts`/`player.ts` (Web-Audio oscillators + filtered-noise + envelopes; distance attenuation,
low-pass on far sounds, speed-of-sound delay, stereo pan + zoom scaling). No new deps, no binary assets.
Final *sound-quality* judgement requires a human in a browser → orchestrator real-app capture in Phase 3.
