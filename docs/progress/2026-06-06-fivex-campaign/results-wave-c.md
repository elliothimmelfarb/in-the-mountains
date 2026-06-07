# 5× Campaign — Wave C results (Sensory & game-feel) — verified

5 owned files (`lib/sim/ai/civilian.ts`, `lib/render/{topo,combat-fx,draw}.ts`, `components/world/WorldView.tsx`)
+ new `scripts/atmospherics-probe.ts`. Adversarial-verified; determinism + layer purity confirmed.

## Headless-verified wins (deterministic)
| Target | Result | Verdict |
|---|---|---|
| A · Diurnal pattern-of-life | survey-7: night 0%/0% out, midday 83% out; survey-43 held-out: night 14.8%/23.9%, midday 62%; dawn rising + dusk falling edges PASS. Population constant — valley **sleeps and wakes** (day 80–98% → 19:00 10% → night 0% → 06:00 61%), does NOT read dead. | **PASS** |
| B · Pre-contact "calm-before" melt-away | survey-7: 56% of outdoor civs clear before a staged ambush, **0 shots** in window, **children first**, control 0%. survey-43 held-out: 48% closed, control gap 24, kids-first t=42s. | **PASS** |
| Determinism (A+B) | same-seed civ-position hashes byte-identical in-process AND cross-process; smoke round-trip green ×3; zero nondeterministic globals in civilian.ts. | **PASS** |

## Code-verified wins (need real-app capture in Phase 3)
| Target | What changed | Verdict |
|---|---|---|
| C · Weather rendered | `topo.ts drawWeather()`: rain streaks / drifting fog / elev-gated snow-line / blowing dust from `world.state.weather` + live `sim.weather.windX/Y` | PASS (code) / capture |
| D · Night light | `combat-fx.ts drawNightLights()`: additive warm glow from muzzle/blast/tracer (gated night>0.25, no cyan, age-faded) over the night wash | PASS (code) / capture |
| E · Wind-leaned smoke/haze | `draw.ts drawSmoke()` + `combat-fx.ts drawCombatHaze()` drift with the wind vector | PASS (code) / capture |
| F · Camera-punch + edge-flash | `combat-fx.ts noteShakeEvents()/drawEdgeFlash()` + WorldView transient transform offset (capped 7px, prox²·size, monotonic-id dedup, NOT a cx/cy write so it doesn't fight pan/audio pose); rust danger-close edge-flash (the ALLOWED felt-weight mechanic, not the reverted shockwave/recoil) | PASS (code) / capture |
| G · Off-screen contact pointer + jump-to-contact | `combat-fx.ts drawOffscreenContactPointer()` + WorldView key snap to contact centroid (ppm≥1.2) | PASS (code) / capture |

## ⚠ Cross-wave REGRESSION found by the verifier (to fix in reconciliation)
- **Space-key collision:** `WorldView.tsx` binds jump-to-contact to Space, but `DeployScreen.tsx` already binds Space→pause. Both `window` listeners fire on one press → Space pauses AND jumps the camera. **Fix:** rebind jump-to-contact to `'c'` only (drop the Space binding). The `'c'` binding itself is clean. Audio gesture-unlock + canvas order/route gestures confirmed intact.

## Done-gate (Wave C in isolation): tsc clean · build compiled · smoke OK · 0 new lint in owned files.
