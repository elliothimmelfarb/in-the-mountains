# 2026-06-11 — Calibre voices: every weapon gets its real sound + the missing battle sounds

**Goal (owner):** make all sounds more realistic and add sounds where they are missing.

**The load-bearing change:** the sim now stamps `weapon` (weapons.ts id) on muzzle/blast/reload
effects (`combat.ts` fireRound/detonate), so the audio layer finally knows WHAT fired — before
this, an M2 .50, an RPG launch, an M9 pistol and an M4 all collapsed into two faction rifle cues
(`synth.ts`'s own comment: "we have no per-weapon id on the Effect"). Effects are transient
(not in `serialize()`), so the save schema is untouched.

## What shipped

**New cue kinds (sounds that did not exist):**
- `hmg_us` / `hmg_insurgent` — the M2 / DShK: body an octave below the 7.62 guns, weapon-tinted
  transient (the shared 6 kHz click had made every gun equally bright), concussive wash.
- `rocket_launch` — RPG-7 pop + departing booster whoosh; AT4/SPG-9 = recoilless single bang +
  heavy backblast wash. "RPG!" is finally audible as a launch, not just an arrival.
- `gl_launch` — M320 hollow bloop / Mk19 deep bolt-thunk.
- `reload` — mag-out, mag-seat, bolt-release at −51.6 dB RMS: a near-field whisper (sim emits a
  `reload` effect at `combat.ts` reload site; renderers ignore the kind).

**Per-weapon voice rows (`WEAPON_VOICES`, cue.wpn refinement):** M9 (sharp short bark, no sub),
M110/M24 (7.62 NATO authority), SVD, Enfield; M24+Enfield get the two-clack **bolt cycle**
~0.45 s after the report. Mortar **calibre gradation** (`BLAST_SCALE`): 60/81/82/120 mm scale
sub onset + rumble length (120 ROLLS, kd = k^1.4).

**Realism upgrades to existing sounds:** IED gains the **seismic ground wave** (26→16 Hz, 1.1 s)
+ **soil-lag** transient (+8 ms) + duller rumble (350→280 Hz, longer) — centroid 5233→**3951 Hz**,
LF-share 37.9%. Incoming shell gains an incommensurate fast wobble + broadband shrill fused to
the tone (chaotic, not musical). Near miss gains the **rarefaction lobe** (+1.5 ms) + wake
sizzle. Radio gains sparse v-keyed net texture (crosstalk >0.85, dropout <0.10 — most squelches
stay clean by design).

## Verbatim numbers (oracle `scripts/audio-render.ts`; baseline/ = HEAD@54a3091, after/ = this pass)

The calibre ladder, measurable (centroid Hz, near/solo): **M9 7701 > M4 6860 > M24 6450 >
Enfield 5876 > DShK 5242** — and the M24 spans 920 ms (shot + bolt cycle) vs the M4's 900 ms tail.

| scene | rms dB | centroid Hz | audible ms | lf200 % |
|---|---|---|---|---|
| palette-ied | −21.06 → −19.23 | 5233 → **3951** | 1300 → 1300 | — → **37.9** |
| palette-incoming | −29.5 → −29.3 | 1707 → 1675 | 2260 → **2400** | — |
| palette-nearmiss | −38.72 → −38.84 | 7794 → **8443** (wake) | 420 → 420 | — |
| palette-hmg_insurgent (NEW) | — → −30.27 | — → 5242 | — → 1120 | — |
| palette-rocket_launch (NEW) | — → −35.36 | — → 5063 | — → **1100** | — |
| palette-gl_launch (NEW) | — → −40.14 | — → 3905 | — → 740 | — |
| palette-reload (NEW) | — → **−51.59** | — → 6559 | — → 520 | — |
| blast-m60 vs blast-m120 (NEW) | −26.17 / −23.25 | — | — | **14.1 vs 19.9** |
| firefight (scene now incl. M2+RPG) | −26.74 → −25.29 | 5334 → 5184 | 18140 → 18280 | — |

**Unchanged stays unchanged (restraint proof):** palette-radio, palette-blast_large (default),
palette-muzzle_us byte-identical metrics (rms/centroid/audible all equal) — texture variants
only fire at hash extremes; default voices untouched.

Oracle: **RENDER OK, 39 scenes (12 new), 13/13 assertions** incl. 5 new (hmg darker by 772 Hz ·
rocket sustains 1100 ms · reload whisper · mortar LF gradation 19.9 vs 14.1% · M24 bolt 920 ms).
New `lf200Pct` metric added (centroid/HF are bin-count-dominated by broadband noise; a blast's
calibre lives below 200 Hz — duration assertions drowned in the shared reverb tail, 1140 vs 1160 ms).

## Held-out proof (3 fresh seeds, organic combat, `scratch-cue-kinds-holdout.ts`, deleted after)

hmg_us 75/900/900 cues (the COP's M2), gl_launch 34 (Mk19), reload 5/121/151, wpn fidelity incl.
m9 sidearms 42–130. rocket_launch didn't occur organically in these runs (RPG gunners carry 1
round) — routing proven by direct mapper check instead: rpg7/spg9/at4→rocket_launch,
dshk→hmg_insurgent, m320→gl_launch, enfield→muzzle_insurgent+wpn.

## Verification trail

- `audio-probe.ts` AUDIO OK (1:1 incl. reload effects, determinism, layer purity).
- Standing: tsc ✓ · build ✓ · smoke ✓ (`SMOKE OK`) · balance exit 0 (see commit) ·
  lint: 0 problems in lines authored this pass (combat.ts 1204/1902 findings pre-exist outside my hunks).

## Deliberately NOT done (and why)

- **Synthesized screams / wounded vocalizations** — extends the recorded negative on synthesized
  radio voice ("band-limited gibberish reads cheesy faster than squelch reads sparse"); a formant
  scream is the same trap with higher stakes. The casualty's weight stays visual/radio.
- **MEDEVAC rotor** — still no aircraft entity (recorded negative, sound-pass README).
- **SAW vs M4 distinct voice** — same 5.56 calibre; not an audible distinction at combat ranges.
- **Backblast as a separate directional cue** — folded the wash into the launch sound; a
  listener-relative backblast cone needs facing-aware spatialization (renderer work, deferred).
