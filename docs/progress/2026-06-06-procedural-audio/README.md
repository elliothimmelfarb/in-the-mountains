# Procedural Battle Audio — render-side observer (2026-06-06)

The single highest-leverage absent dimension. A player who turns sound on now gets the
genre's spine: the crack-thump of incoming, the SAW's rip vs a PKM hammer from the high
ground, the radio net under the log, the mortar's shot/splash, the danger-close klaxon, the
readable silence of the calm-before, and a rare low TIC sting when a firefight kicks off.
Every sound is **synthesized procedurally** — no binary assets, no npm audio dependency.

## What was built

A new `lib/audio/` package in a strict two-half split (Law 7):

| File | Layer | Role |
|---|---|---|
| `cue.ts` | PURE | `AudioCue`/`CueKind` wire format + `cueVar` (per-cue variation = pure hash of the source id). |
| `mapper.ts` | PURE, headless | `CueMapper.collect()` — walks `effects`/`log`/`fireMissions`/`inContact` against monotonic high-water marks → ordered `AudioCue[]`. Owns ALL dedup. |
| `synth.ts` | BROWSER | `AudioCue` → Web-Audio node graph (oscillators + filtered-noise bursts + envelopes). One recipe per cue kind. |
| `player.ts` | BROWSER | `AudioEngine`: AudioContext lifecycle + unlock-on-gesture, master vol/mute, 24-voice cap, distance/pan/low-pass-far/speed-of-sound mix, pause/warp gate. |
| `index.ts` | barrel | pure exports (mapper/cue) vs browser export (AudioEngine). |

Wiring (the seams, all verified live):
- **`state/store.ts` `frame()`** — `audio.tick(sim-streams, {running,paused,warp,inContact})` after `world.tick`. Always advances the mapper marks; schedules sound only when live.
- **`components/world/WorldView.tsx`** — pushes the camera (the listener) each RAF; wires the unlock-on-gesture (`pointerdown`/`keydown`, `once:true`); exposes `window.__audio` for the harness.
- **`components/screens/DeployScreen.tsx`** — mute button (🔊/🔇) + a volume slider in the time-control bar; an `M` keybind.
- **`lib/sim/world/index.ts`** — re-exports `RNG` so the mapper pulls `hashString` through the barrel.

## Determinism boundary (the load-bearing fact)

The mapper is a **pure function of its inputs** — same event sequence in ⇒ byte-identical cue
list out, no wall-clock, no PRNG-stream advance (per-cue `v` is `RNG.hashString(id+salt)`).

REALITY the plan didn't anticipate (the code wins): `Effect`/`Log`/`FireMission` ids come from
**module-scope** counters in `combat.ts` (`_eid`/`_lid`/`_fmid`, lines 204–206) that are
monotonic across *all* CombatSim instances in a process — NOT reset per world. So two worlds
built back-to-back get different absolute ids, which would make the plan's "two same-seed
worlds" comparison differ on `srcId`/`v` even though the sim is identical — a property of the
engine's id allocation, not of the audio layer. The probe therefore **records one real
firefight's per-tick snapshots and replays them through two fresh mappers** — isolating the
thing the audio layer actually owns. That is the faithful Law 7 proof.

Two other plan-vs-reality corrections made during implementation:
1. **No `inbound` status is ever set** by the sim (verified: `combat.ts` walks
   `requested → firing → complete`; `inbound` is in the union but dead). The `shot` cue now
   fires on **first sighting** of a mission (matching the "Shot, over." log line); `splash`
   on entering `firing`.
2. **A fire mission legitimately yields multiple cues** (shot + splash + dangerclose, same
   `fm.id`). The probe's no-double-fire key is `(stream, srcId, KIND)`, not `(stream, srcId)`.

## Verification

### Headless — `npx tsx scripts/audio-probe.ts` → `AUDIO OK`
```
  ok — no double-fire across 1520 cues (1344 distinct stream:src:kind keys)
  ok — 1:1 fx mapping: 1314 cues == 1314 non-blood effect ids (0 blood, 0 dropped)
  ok — every cue's srcId corresponds to a real event
  ok — indirect + TIC cues fired: tic_sting, shot, splash
  ok — small-arms cues present (mg_us, muzzle_us)
  ok — mapper is a pure deterministic function: two replays of one recording are byte-identical (5983 cues, no wall-clock/PRNG leak)
  ok — lib/sim has ZERO lib/audio imports
  ok — lib/audio/mapper.ts is browser-free
  ok — lib/audio/cue.ts is browser-free
  ok — lib/audio/mapper + cue load on Node without a browser global

AUDIO OK
```

### Live (Playwright + `window.__audio` debug ring buffer) on a real deploy
- `AudioContext` created+resumed on a user gesture → `state: "running"`, master gain `0.6` (default).
- Staged firefight (12 muzzles across factions, an MG, a blast, an enemy mortar) + unpause →
  **15 cues scheduled through the real `frame()` loop**: `muzzle_us×5, muzzle_insurgent×4,
  mg_us×1, mg_insurgent×2, blast_large×1, splash×1, radio×1`. `activeVoices` returned to 0
  (clean teardown, no node leak).
- **Pause gating**: 8 effects emitted while paused → 0 new cues (`afterPause === beforePause`).
- **Mute**: master gain ramped to ~0.002 (ramped, not stepped → no click); unmute → 0.598.
- **Volume**: slider → 0.3 sets master gain 0.301.
- **Two-localStorage separation**: prefs persist in `itm-ui-v1` (`audioVolume`/`audioMuted`);
  the campaign save `itm-save-v2` contains **neither** (regex-checked live).
- HUD controls render in the time-control bar: mute button + 64px volume slider (DOM rects confirmed).

### Standing checks
- `npx tsc --noEmit` — clean for all app/lib/audio code. (The only errors are in
  `scripts/campaign-loop.ts`, an **untracked** scratch file from a parallel agent — not mine,
  not on HEAD, not in my diff.)
- `npm run build` — Turbopack "Compiled successfully"; the typecheck phase trips only on that
  same foreign untracked file.
- `npm run lint` — `lib/audio/*`, `state/store.ts`, `DeployScreen.tsx` lint-clean. `WorldView.tsx`
  carries 2 pre-existing errors (`draw` accessed-before-declared, `performance.now` impure) that
  exist on HEAD; my edits added zero new lint problems.
- `npx tsx scripts/smoke.ts` — `SMOKE OK` (no-NaN + serialize round-trip).

## Restraint logged
- **Did NOT add `weaponId` to the `Effect` type** for per-weapon timbre — it would touch
  `lib/sim` + the serialize/determinism contract for a marginal audio gain. Faction +
  MG/rifle (`size≥1.5`) is the maximum fidelity the existing effect carries.
- **Did NOT touch `scripts/campaign-loop.ts`** — it is a parallel agent's untracked work
  (one-writer-per-file). It breaks the shared build's typecheck independent of this change.

## Files
Created: `lib/audio/{cue,mapper,synth,player,index}.ts`, `scripts/audio-probe.ts`,
this folder. Edited: `lib/sim/world/index.ts`, `state/store.ts`,
`components/world/WorldView.tsx`, `components/screens/DeployScreen.tsx`,
`docs/wiki/Simulation-Systems.md`, `README.md`.
