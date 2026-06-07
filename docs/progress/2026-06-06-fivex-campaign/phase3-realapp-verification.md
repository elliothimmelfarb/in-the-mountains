# 5× Campaign — Phase 3: real-app verification + capture record

Driven against the LIVE app (dev server :3000) via CDP/`shoot.mjs` + `scripts/scene-shots.mjs` (new, the
documented capture technique) and MCP Playwright. Determinism/headless proofs are in the per-wave docs; this
records what was confirmed in the actual running game.

## Audio — verified live (Wave B)
- `window.__audio` engine present + configured: volume 0.6, unmuted, fields {ctx, master, mapper, cam,
  unlocked, muted, volume, activeVoices, debugCues}.
- **No autoplay violation:** AudioContext is `null` before any user input.
- **Unlocks on gesture:** after a pointerdown/keydown the context resumes → **state "running", 48 kHz,
  unlocked=true**. Correct browser-policy lifecycle.
- Sound *quality* is inherently a human-ear judgment (out of automated scope) — the headless probe already
  proved the event→cue mapping is deterministic, 1:1 per effect-id, and voice-pool-bounded.

## Screenshots captured (docs/progress/2026-06-06-fivex-campaign/shots/)
Staged deterministically on the live world (`__ITM` + `__setCam`), paused to hold the tableau:
- `night-firefight.png` — **night-light win**: warm muzzle-flash glow + blast bloom against the dark night
  wash; suppression crescents; fire-mission beaten-zone rings. (clock 16h, ambient 0.05.)
- `combat-day.png` — daytime reference (day/night pair with the above).
- `combat-tableau.png` — combat legibility (suppression cues, casualty/bleed, buddy-aid, MEDEVAC prompt).
- `weather-rain.png` — **weather render win**: diagonal rain streaks across the frame (Rain state).
- `weather-fog.png` — fog haze (subtler top-down; present but less dramatic than rain).
- `coin-hud.png` — **command layer**: directives feed, SOP settings, fire support, logistics — the strategic
  HUD made rich (a project building, attitudes moved, CERP spent+regained).

## Docs reconciled (first-class deliverable)
The waves updated README.md, docs/wiki/{AI-Doctrine, Campaign-and-COIN, Simulation-Systems}.md,
public/manual/index.html, and the docs/issues/README.md status table now carries 014 (world-scale, open/
specified), 015 (COIN, largely resolved + numbers), 016 (atmospherics, resolved + numbers). Coherent.

## Done-gate (settled, reconciled tree)
tsc 0 · build 0 (1413ms) · smoke OK (serialize round-trip clean) · audio-probe OK · atmospherics-probe OK ·
balance 12×50 KIA 0.58 / WIA 4.33 / enemy 5.67 / civ 0 (vs HEAD 0.75/5.58/1.25 — KIA down, enemy 4.5×) ·
campaign-loop all 8 gates PASS (careful 60.0 − body-count 29.7 = spread 30.3) · lint at pre-existing baseline
(no new app/engine errors; one campaign-introduced unused-import tidied). Space-key cross-wave collision fixed.
