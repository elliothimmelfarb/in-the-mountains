# The 5× Campaign — index (2026-06-06 → 07)

A goal-driven, agent-orchestrated pass to make the game ≥5× better / 5× more joy & awe, across realism +
player experience. Recon fan-out (12 domain experts → 63 ranked hypotheses) → five file-disjoint
implementation **waves**, each a pipeline ending in an independent adversarial verify, gated by headless
harnesses ("no fix without a number") + the determinism contract + a DO-NOT-RETRY ledger.

## The deliverable
- **`report.html`** — the capstone explainer (diagrams, charts, annotated screenshots, the 5× assessment). Open offline.

## The record (numbers-first)
- `baseline-head.md` — verbatim HEAD baselines (combat balance, COIN campaign-loop, the inverted exchange ratio).
- `results-waves-ab.md` — Wave A (combat soul) + Wave B (procedural audio).
- `results-wave-c.md` — Wave C (sensory & game-feel: weather, night-light, diurnal + calm-before, camera-punch).
- `results-wave-d.md` — Wave D (COIN soul: secure-build, projects, CERP, directives, KLE, discriminating score).
- `results-wave-e.md` — Wave E (world-map scale: figures track footprint + per-squad icon LOD).
- `phase3-realapp-verification.md` — live-app verification (audio context, screenshots, docs reconcile, done-gate).
- `shots/` — the live captures embedded in the report.

## Headline before → after
| | HEAD | After |
|---|---|---|
| Combat exchange (US cas : enemy) | ~5:1 against | ~even / US-favorable (held-out) |
| Suppression (in contact) | 0.000 | up to 1.0; 27–36% pinned |
| Enemy elevation advantage | +2.41 m | +38 m (ambush) |
| Audio | none | full procedural firefight + radio |
| COIN tour-score spread (careful vs body-count) | 0.5 | 30.3 (default) |
| Soldier figure size vs true | 36× | 3–17× (overlap → false at every zoom) |
| Night / weather / atmospherics | flat blue / none / none | muzzle-light, rain·fog·snow, the calm-before tell |

## Harnesses added/extended this campaign
`scripts/campaign-loop.ts` (COIN tour), `scripts/audio-probe.ts` (audio determinism), `scripts/atmospherics-probe.ts`
(diurnal + melt-away), 4 new probes in `scripts/realism-probe.ts` (stance/scoot/massing/two-sided-suppression),
`scripts/scene-shots.mjs` (live scenario capture).

## Honest residuals (logged, not closed)
COIN held-out 4×14 is bimodal (spread −3.0 — a coarse-harness/test-routing artifact, not the engine);
suppression element-avg peak below the guessed band; weather is render-only (gameplay consequence deferred);
world-scale Bucket 2 (valley shape / weapons-squad count / COP geometry) + R3 (village cluster) deferred.
