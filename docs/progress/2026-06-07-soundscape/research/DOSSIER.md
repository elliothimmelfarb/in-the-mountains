All key facts verified. The reports' assumptions match reality: `solarLight()`, `windVector()` (with diurnal anabatic/katabatic), `weather` (label/wind/windDir/visibilityM), `terrain.elevAt()`, the offline render oracle (`scripts/audio-render.ts` using `node-web-audio-api`), and the probe. One important correction to note: the reports repeatedly say "there is no audio harness today" / "no reverb" — the *no-reverb* part is true, but a numeric audio oracle DOES already exist (`scripts/audio-render.ts` renders the real graph offline to PCM with peak/RMS/spectral metrics). I'll fold that into the dossier as the baseline instrument.

I have everything I need. Producing the dossier.

---

# IN THE MOUNTAINS — AUDIO RE-ARCHITECTURE DOSSIER
### Synthesis of 6 specialist reports → one implementable spec for a 20× immersion leap
*Lead audio director's cut. Every technique mapped to the real code as it exists today (verified against `lib/audio/{cue,mapper,synth,player}.ts` and `lib/sim/world/world.ts`).*

> **Grounding note (corrects a recurring claim across all six reports):** five of six reports assert "there is no numeric audio harness today." **That is false and load-bearing for Law 1.** A real headless audio oracle already exists — `scripts/audio-render.ts` renders the *live* `synthCue`/`computeSpatial`/`KIND_TRIM` graph through `node-web-audio-api`'s `OfflineAudioContext` to PCM and emits peak/RMS/spectral numbers + a listenable `.wav`. **The "before" capture is therefore free and mandatory: run it on HEAD first.** The *no-reverb* claim is true. The architecture below is an **additive restructure**, not a rewrite — the bones (shared `_noise` buffer, exp-decay `noiseBurst`/`tone`/`sub`, deterministic `cue.v` jitter, `Spatial{crackAt,thumpAt,split,cutoff}`, the pure mapper, `computeSpatial`, `KIND_TRIM`) are already correct.

---

## 1 · EXECUTIVE SUMMARY — the highest-leverage moves, ranked

| # | Move | Why it's 20× (one line) | Confidence (consensus across reports) |
|---|------|------------------------|----------------------|
| **1** | **Procedural valley reverb** — ONE shared `ConvolverNode` whose IR is a decaying-noise buffer with 3-4 baked ridge slap-taps, fed by a per-cue **wet send that scales UP with distance**. | The single biggest missing piece, named by **all 6 axes independently** — turns every flat "pop" into "pop… then rolling thunder down the valley," the one acoustic fingerprint of every Restrepo/Outpost firefight, with **zero audio assets**. | 0.88–0.95 (unanimous) |
| **2** | **Submix bus refactor** — replace the single `master` GainNode with `combat / atmos / radio / score → master → DynamicsCompressor(limiter) → destination`, plus parallel **dry + wet(reverb) sends**. | Structural prerequisite for *everything* (reverb, ducking, mix-states, HDR). Small surgical edit to `player.schedule()`; without it the other 18 techniques have no lever to grab. | 0.90 |
| **3** | **HDR window auto-mixer + control-side ducking** (DICE model) — cue loudness in dB, a window the loudest sound raises and **silence decays into**; IED ducks *everything else* for a beat. | This is how "somber" is *engineered*: power comes from ducking the world quiet, not from louder blasts. Delivers legibility AND the literal "readable silence of the calm-before" from one mechanism, and stops a 30-man TIC from clipping into arcade mush. | 0.78–0.86 |
| **4** | **Five-layer gunshot stack** (Kilborn) — restructure each `muzzle_*`/`mg_*` into TRANSIENT · BODY · SUB · MECHANICAL · TAIL, driven by a **per-weapon param table**. | Restructures the existing flat single-burst recipes into the canonical AAA gunshot architecture; makes AK-vs-M4, SAW-vs-PKM **physically principled**, not vibes. Uses primitives that already exist. | 0.86–0.92 |
| **5** | **True N-wave crack split by speed of sound** — a sub-millisecond high-passed snap at `crackAt` (the round's flight line) + the muzzle report at `thumpAt` (the shooter's bearing), gap = a **learnable ranging cue**. | `crackAt`/`thumpAt`/`split` already exist in the `Spatial` interface — wiring the report to `thumpAt` and a *real* 0.3–0.6 ms N-wave to `crackAt` is the highest-realism, lowest-cost win and the most-cited "this sounds real" detail in every soldier account. | 0.85–0.92 |
| **6** | **Three-tier ambient bed** — persistent geophony/biophony/anthrophony voices (wind bank, river, generator hum, Poisson birds/dogs/adhan) that **duck hard on TIC and exhale over ~12 s**. | Today silence reads as "audio off." A barely-there, frequency-partitioned bed makes silence *active dread*; the diesel generator + call-to-prayer are THIS setting's signature and the strongest "real place" lever the genre has. | 0.78–0.95 |
| **7** | **Terrain LOS occlusion** — raycast camera→source over `terrain.elevAt`; a ridge **lowpasses** the gun (not just quieter), snapping bright the instant it has line-of-sight. | "The valley is the enemy" applied to sound — a feature no other top-down shooter has because none have elevation data. Highest-immersion-per-line for *this specific game*. | 0.85 |
| **8** | **Priority voice-stealing + master limiter** — replace "drop the newest cue at 24 voices" with priority-weighted stealing (keep nearest+loudest, raise cap to ~32), behind one `DynamicsCompressorNode`. | Today's cap can mute the gunshot you need while a stale ricochet plays. Fixes legibility under load and is the safety net the whole HDR mix relies on. | 0.82–0.95 |

**The through-line:** the dossier collapses to *one architecture applied at every layer* — **buses (move 2)** carry **dry + wet(reverb, move 1)**, the **HDR window (move 3)** decides who's audible, **occlusion/elevation (move 7)** and the **layered stack (moves 4–5)** shape each voice, the **ambient bed (move 6)** makes silence active, and **voice-stealing+limiter (move 8)** keeps it clean. Build moves 1–2 first; they unlock the rest.

---

## 2 · PROCEDURAL GUNFIRE — the layered synthesis model

Adopt the **Kilborn 5-layer stack** (gunfire-synthesis 0.92, corroborated by Splice & the Springer physically-motivated model). Each `muzzle_*`/`mg_*` case in `synthCue` becomes five named, independently-shaped sub-graphs into the per-cue gain — *one event, five shapeable layers*. All five primitives (`noiseBurst`, `tone`, `sub`, the `tanh` WaveShaper) already exist; this is **restructuring, not new nodes**.

### The five layers (per shot)

| Layer | Role | Web Audio recipe (extends existing primitives) | Distance behavior |
|-------|------|------------------------------------------------|-------------------|
| **TRANSIENT** | the <5 ms attack click — "is it close/loud" cue | `noiseBurst(highpass 6 kHz, Q0.5, dur 0.004, attack 0.00005)` | softens (attack 0.0005→0.02), **drop past ~250 m** |
| **BODY** | broadband 1–4 kHz report — carries weapon identity | `noiseBurst(bandpass center = weapon.bodyCenterHz, Q1.5)` + a peaking burst at the formant | progressive lowpass (air absorption) |
| **SUB** | 30–120 Hz chest punch | `sub(weapon.subF0 → subF1, dur 0.05–0.08)` | reserve for **first-shot only** in bursts; drop on distant shots (mix-mud) |
| **MECHANICAL** | bolt clack 10–20 ms *after* report | `noiseBurst(bandpass ~3 kHz metallic, Q4-6, dur 0.006, peak 0.12)` at `crack+0.012..0.025` | **gate off past ~60 m** |
| **TAIL** | environment decay | **wet send into the shared valley convolver** (§3) — *not synthesized here* | send gain scales **UP** with distance |

### The N-wave crack (separate physical event, gunfire-synthesis 0.85 + reference-acoustics 0.92)

The "crack" is **not** the muzzle report — it's the ballistic shock wave, a sub-millisecond N-wave. Model the *period*, not the waveform (do **not** model the full Whitham N-wave sample-by-sample — pitfall):

```
N-wave snap = noiseBurst(highpass HP, Q0.3, dur D, attack 0.00005)
  5.56 (M4/SAW):  D=0.00035, HP=5000   (brighter, shorter)
  7.62 (AK/PKM):  D=0.0006,  HP=3500   (woodier, longer period)
```

**Wire it to the speed-of-sound split (the seam already exists):** today both crack and thump play at `crack`. The upgrade — fire the **N-wave snap at `crackAt`** (panned toward the round's flight line) and the **BODY+SUB report at `thumpAt`** (panned toward the shooter's map bearing). Gap = `dist/343`: ~0.5 s @ 300 m, ~1.0 s @ 600 m → an in-fiction **ranging cue**. Only fire the N-wave for rounds that **pass near the listener** (gate on perpendicular distance to the line of fire, not range); for distant fire NOT passing near you, suppress the crack entirely and play only the delayed, lowpassed thump (reference-acoustics 0.92). The repo's `nearmiss`/`scheduleNearmissTail` is the exact seam to upgrade.

### Per-weapon parametric table (replaces the ad-hoc `j()` constants)

Make a `Record<WeaponClass, WeaponTimbre>` and feed it into the stack — extending the RPM table already encoded in the burst step:

```ts
{ bodyCenterHz, bodyQ, reportDur, subF0, subF1, nwaveDur, nwaveHP, rpmStep }
M4   (5.56): 3500, 1.5, 0.05,  180, 90, 0.00035, 5000,  —
AK   (7.62): 2600, 1.2, 0.075, 140, 68, 0.0006,  3500,  —
SAW  (5.56): 3700, 1.8, 0.045, 180, 95, 0.00035, 5200, 0.064–0.078  (~850 RPM, tighter/brighter)
PKM  (7.62R):2400, 1.0, 0.085, 130, 60, 0.0007,  3300, 0.088–0.102  (~650 RPM, heavier sub)
```
*Caliber physics (GunZone, Springer): 7.62 = lower body formant, longer report decay, deeper sub, longer N-wave period; 5.56 = the reverse.* **Constraint:** the muzzle Effect carries faction + `size` only (no `weaponId`) — so the mapper picks weapon class from the existing `mg = size>=1.5` + faction split. Keep that; the timbre table just makes the existing 4 cases principled.

### Automatic fire = first-shot emphasis → varied loop → long-tail-off (gunfire-synthesis 0.78)

In `mg_us`/`mg_insurgent`: shot `i=0` gets the **full 5-layer stack + reverb send** (the brain locks onto the opener); shots `1..n-2` get a lighter stack (drop mechanical/brass, reduce send, apply per-shot jitter); the **last shot gets a long reverb send** (the gun ceasing). Keep the existing RPM step + falling-gain envelope.

### Deterministic per-shot variation (CRITICAL — gunfire-synthesis 0.88)

Defeat the machine-gun-repetition artifact with **golden-ratio decorrelation**, a pure function of `cue.v` + shot index — **never `Math.random` in param selection**:
```
v_i = fract(cue.v * 1.618033 + i * 0.618033)
```
Jitter per shot: body center ±8%, peak ±15%, decay ±12%, micro-timing ±4 ms, pan ±0.05. The white-noise *buffer* may use `Math.random` (render-side, already scoped in `noiseBuffer`); the **param choices feeding audible timbre must be pure** so a seed reproduces the firefight's exact sound. The probe asserts this.

### Soft-clip weight (gunfire-synthesis 0.82)

Reuse the existing `ied` `tanh` WaveShaper pattern, **milder** (`tanh(x*1.4)`) on the **BODY+SUB of near belt-fed weapons** (SAW/PKM rips) for "felt-in-the-chest" authority. Route **only dry layers** through it — never the reverb send (keep reflections clean). Scale drive up with proximity, off with distance.

### HE blasts — Farnell 4-layer staggered (gunfire-synthesis 0.83 + reference-acoustics)

Restructure `blast_large`/`ied` from flat-in-time to staggered: **SHOCKWAVE** (sharp 6 ms transient, t=0) → **BLAST** (noise through a filter sweeping 200→7000 Hz over ~0.2 s, soft-clipped) → **FIREBALL** (bandpass ~70 Hz, dur 0.4, scheduled at **+100 ms** — the timing is what makes it feel huge) → **PRESSURE-WAVE** (sine 55→22 Hz long + trailing rumble, routed through the valley convolver). The `ied` already approximates this but flat-in-time; the **+100 ms fireball + trailing rumble** is the upgrade.

---

## 3 · VALLEY REVERB & ECHO — the #1 missing piece

**Architecture (named identically by all 6 axes):** ONE shared `ConvolverNode` on a parallel **wet send**, built once at unlock, never per-voice. Never instantiate a convolver per cue (the classic perf killer).

### The procedural IR (decaying-noise, zero assets — Moorer's result)

Build once at unlock via `OfflineAudioContext(2, sr*T, sr)` or a plain buffer fill. The math is a one-liner (canyon-reverb 0.95):
```
base = (1/1000)^(1/(RT60*sr))           // amplitude hits exactly -60 dB at RT60
ir[j] = (Math.random()*2-1) * base^j    // render-side noise — allowed (Law 7)
```
Then shape it (canyon-reverb / gunfire-synthesis / reference-acoustics consensus):
- **Highpass ~250–400 Hz** so the tail is dirt/rock, not boomy.
- **Lowpass swept bright→dull across the tail** (highs die first = air absorption).
- **Short 5–15 ms fade-in** to soften onset.
- **3–4 discrete ridge slap-taps baked into the buffer** at `t ≈ 0.18 / 0.42 / 0.85 / 1.4 s` with amplitudes `0.6 / 0.35 / 0.2 / 0.12` (`ir[round(Tk*sr)] += ampK`). Physics: a cliff wall at distance D slaps at `t = 2D/343` — Korengal-scale walls (170–340 m) → 1–2 s echoes, perceptibly separate (>0.1 s). Pan taps slightly (different walls) by writing different L/R amplitudes. **This is what makes it read as MOUNTAINS, not a room.**

**RT60 ≈ 1.6–2.2 s** for a tight Korengal draw. *Optional:* regenerate per-deployment IRs ("tight draw" / "open valley" / "wadi") at unlock — IR *choice* is a pure function of the deployment seed (Law 7 holds; only the noise fill is render-side).

### Distance drives reverb (the depth cue — positional-webaudio 0.83, canyon-reverb 0.90)

Distance is **three coupled transforms, not just gain** (consensus): (1) progressive lowpass — already half-built as `cutoff`; (2) transient softening + drop N-wave/mechanical past ~250 m; (3) **rising wet/dry ratio**. The third is the missing half — without it, far events read as "quiet near events," not "distant." Reuse the `norm` already computed in `computeSpatial`:
```
dryGain  = atten                              // current behavior
wetSend  = atten * clamp(0.12 + 0.55*norm, 0, 0.7)   // near ~0.12 wet, far ~0.67
preDelay = clamp(0.02 + norm*0.12, 0.02, 0.18) s     // DelayNode on the send only
```
**Feed only the bright CRACK/BODY snap into the convolver, NOT the SUB** (Bungie/Audiokinetic) — the tail rings without low-end mud. Route the dry crack mostly dry+panned, the thump heavier-wet → the report "rolls." **Don't double-count speed-of-sound:** the existing `thumpAt = dist/343` already owns the gross offset; keep reverb pre-delay modest (≤180 ms).

### Per-kind reverb character (canyon-reverb 0.85 — mirror the `KIND_TRIM` pattern)

Add an exhaustive `KIND_WET: Record<CueKind, number>` beside `KIND_TRIM` (the compiler then forces every new CueKind to declare wetness):
```
muzzle_*: 0.35   mg_*: 0.45   blast_small: 0.6   blast_large/ied: 0.85
impact/ricochet: 0.15   splash: 0.7   smoke_pop/flare: 0.1
radio / dangerclose / tic_sting / shot: 0.0   ← in your headset, bone dry
```
`sendGain = wetSend(distance) * KIND_WET[kind]`. *Optional:* two convolvers (short RT60~1.2 s for small arms, long ~2.8 s for HE) — still only 2 nodes total.

**Restraint gate (the brief's soul):** default wet LOW, let only distance + HE push it up, keep radio/UI/sting dry. Over-wet = arcade mush, the exact failure mode. Send only a fraction of rounds to reverb in a sustained fight (let the polyphony cap + HDR thin it) — the goal is the *occasional* ridge-echo, not a wash.

> *Convolver-free fallback (canyon-reverb 0.82):* a Freeverb rig (8 lowpass-feedback combs `{1116,1188,1277,1356,1422,1491,1557,1617}` samples + 4 allpass `{556,441,341,225}`, `g = 10^(-3·delaySec/RT60)`, comb delays slowly modulated to kill metallic ring) if live-tweakable params are ever wanted. **Recommendation: ship the convolver** — cheaper, no ringing, one node for all 24 voices.

---

## 4 · AMBIENT BED — geophony · biophony · anthrophony

**Three-tier architecture (ambient-soundscape 0.95):** persistent **BED loops** + Poisson-scheduled **SPOT one-shots** + sim-driven **DYNAMIC params**. Detailed/identifiable sounds live in the spot layer precisely because a recognizable sound baked into a loop is what the ear catches as repetition.

**New modules, mirroring the existing pure/render split:**
- **`lib/audio/ambient-state.ts`** (PURE, sibling of `mapper.ts`) — a function of `(secondsOfDay, solarLight(), weather.{label,wind,visibilityM}, windVector(), isNight, camera-vs-{COP,village,river} distances)` → an `AmbientMix` of **deterministic target numbers only**. **Every signal it needs already exists deterministically on World** (verified: `solarLight()`, `windVector()` with diurnal anabatic/katabatic, `secondsOfDay`, `weather`). Zero new sim state, zero determinism risk.
- **`lib/audio/ambient.ts`** (RENDER) — a persistent voice bank wired ONCE at unlock, gains chased via `setTargetAtTime`, living on its own `atmosBus` **outside** the 24-voice combat pool (so `MAX_VOICES` never starves the bed and the bed never leaks via the combat `setTimeout` teardown).

### The layers

| Layer | Type | Synthesis | Reserved band (acoustic-niche, see below) |
|-------|------|-----------|-------------------------------------------|
| **Wind (geophony)** | bed | Brown/pink noise → **3–5 parallel biquads**: lowpass/bandpass @180 & 350 Hz (Q0.7, howl) + bandpass @900 & 2200 Hz (Q6–10, whistle). Gusts = slow 0.05–0.3 Hz LFO on `windGain`; **whistle cutoff lags loudness via a DelayNode (~0.3–0.8 s)** — the gust builds, *then* whistles. Drive base gain + brightness from `weather.wind` (0–8 m/s) so a Clear-3 day vs Snow-7 night are audibly distinct. (Farnell wind model, ambient-soundscape 0.90) | howl 100–400 Hz, whistle 1–3 kHz |
| **River** | bed + grains | Noise → bandpass center ~1.2 kHz (Q0.4) + slow LFO on center (breathing) + **peaking notch at 3–4 kHz to clear room for birds**. Burble grains = 80–160 Hz Poisson plinks at the river position. Gain scales with camera distance to the mapped river channel (the river-aware planner already knows it). | 0.4–6 kHz, notched at 3–4 kHz |
| **Generator (anthrophony)** | bed | Additive: sine @55–65 Hz fundamental + 3–5 harmonics → lowpass 250 Hz; "lope" = 3–7 Hz low-depth LFO. **Distance-gated to ~COP radius.** The COP's signature drone. | <250 Hz |
| **Birds / insects / dogs** | SPOT (Poisson) | Bird = 2–4 fast sine sweeps (3.5k→2.8k, 60–120 ms) through bandpass Q8; cricket = gated 4.5 kHz sine pulse train; dog = lowpass noise burst + 300/600 Hz formants. Spatialized at village/ridge positions through the **existing** mapper→synth→spatial pipeline. | birds 2–5 kHz, insects 4–7 kHz |
| **Adhan (call to prayer)** | SCHEDULED (deterministic, NOT random) | Sawtooth osc through vowel-formant peaking filters (~700/1200/2600 Hz) + programmed pitch contour (`setValueCurveAtTime` melisma) → lowpass ~1.5 kHz + **heavy reverb send** (cross-valley distance), panned to nearest village. Fires at fixed `secondsOfDay` prayer marks. **A firefight interrupting it lands hard.** | 0.3–2 kHz |
| **Rain** | bed + grains | Noise → intensity-shaped lowpass, gain = `weather.precip ? level : 0`; droplet grains (close/under-cover) = Poisson highpassed noise ticks. **Ducks birds toward silence.** | broadband wash |

### Deterministic Poisson scheduling (ambient-soundscape 0.85)

Each spot pool's arrival sequence is a **pure function** — reuse `RNG.hashString` (already in `cue.ts`):
```
nextFire = lastFire + (-ln(hashToUnit(layer, n)) / density)
```
where `density` comes from the pure ambient-state layer (high birds at dawn, ~0 at night/in rain; rare lone dog at night). Pitch/pan also derive from the hash. **Same seed + same clock ⇒ same birds.** No wall-clock, no `Math.random` in the scheduler.

### Acoustic-niche frequency partitioning (ambient-soundscape 0.90 — the mix-mud cure)

Krause's niche hypothesis as **mix discipline**: each layer is bandpass-limited to its reserved band (table above) so layers never mask each other *by design*, not by runtime EQ-fighting. When a foreground spot (adhan, near dog, combat) fires, duck river/wind ~3–5 dB via `setTargetAtTime(...,0.15)` and back.

### Time-of-day & weather crossfade (ambient-soundscape 0.92)

**Never swap loops** (clicks, reallocation) — keep all bed voices alive forever and crossfade *gains*, **equal-power** (cos/sin avoids the 50%-dip):
```
dayBiophony   = sin(solarLight() * π/2) * amp     // birds/insects up as sun rises
nightBiophony = cos(solarLight() * π/2) * amp     // crickets/lone dog up as it falls
ramp time-constant: setTargetAtTime(target, now, 8.0)   // weather/dawn glides over ~tens of s
```
Because `solarLight()` is already a smooth smoothstep ramp (dawn 5–7 am, dusk 17–19.5), the audio transition auto-syncs with the on-screen night-light render. Rain fades in with `weather.precip` and pushes birds → 0.

### The readable-silence contract (ambient-soundscape 0.90 + reference-acoustics 0.80)

The bed is a **dramatic instrument**, not wallpaper. Run it at a restrained floor (~0.04–0.08). On the **TIC rising edge** (the existing `inContact` latch / `tic_sting`): **duck the whole `atmosBus` hard and fast** (`setTargetAtTime(0.15, now, 0.4)`), and lower biophony density toward zero (birds go quiet when shooting starts — true to life). On falling edge, **exhale slowly** (`setTargetAtTime(1.0, now, 12.0)`). Keep generator/wind slightly present — silence-with-texture, not a dead mute. This *is* "the readable silence of the calm-before."

---

## 5 · SPATIALIZATION — for the top-down tactical listener

### Keep StereoPanner — do NOT switch to HRTF (positional-webaudio 0.92, unanimous)

HRTF `PannerNode` is the **single most expensive node in Web Audio** (continuous convolution, up to 4 convolvers per moving stereo voice), it's tuned for headphones and smears on speakers, and it buys front/back+elevation discrimination a **disembodied overhead camera cannot honestly use**. The existing hand-rolled `pan = clamp(sx, -1, 1)` is faster, zoom-coupled, and correct. Spend the saved CPU on reverb + occlusion. *(If `PannerNode` is ever adopted: `equalpower` + `distanceModel:'inverse'` + `rolloffFactor ≥ 2` — but the existing `pow((1-norm),1.6)` zoom-coupled falloff is more controllable, so keep it.)*

### Persistent bus graph; only sources are one-shot (positional-webaudio 0.95)

The current per-cue `Gain+StereoPanner+Biquad` churn + `setTimeout` teardown is exactly the allocation pattern padenot warns against. **Build the expensive/stateful nodes once** (buses, panners-per-bus, convolver, compressor, send gains); create **only** the cheap `osc`/`noise` sources + a tiny per-cue envelope gain per cue. Keep a small free-list of env gains if even that shows in profiling.

### Terrain LOS occlusion — *this game's killer feature* (positional-webaudio 0.85)

"The valley is the enemy" applies to sound. Per positional cue, **render-side in `computeSpatial`** (the camera/terrain handle lives on the render side — never feed back into `lib/sim`):
1. March ~8–12 samples along camera-center → `cue.pos`, compare straight sight-line elevation vs `terrain.elevAt` at each.
2. `occ` = fraction where terrain rises above the line (or normalized max penetration).
3. Map to the **existing air-absorption lowpass**: `cutoff = lerp(nearCutoff, 350Hz, occ)`, `gain *= lerp(1.0, 0.5, occ)` (~−6 dB — *less* than the indoor −15 dB; rock diffraction passes a lot of low end; over-muffling makes distant fire vanish).
4. **Smooth `occ` per source toward target (~5/s)** so a ridge edge crossing doesn't click.

A PKM behind a spur sounds dull/bassy, then **snaps bright the instant it has LOS** — no other top-down shooter has terrain-masked audio.

### Elevation brightness cue (positional-webaudio 0.78, reference-acoustics 0.70)

You can't *pan* elevation in 2D, so encode the **relationship the player needs**: a gun on the high ground has clear LOS and an unobstructed HF path → **brighter, more present, less wet**.
```
relElev = terrain.elevAt(cue.pos) - terrain.elevAt(cam.center)
highshelf @5kHz, gain = clamp(relElev/heightScale, -1, 1) * ±4 dB   // boost above, cut below
relElev>0 → reduce reverb send slightly + raise cutoff ~15% (high gun sits forward)
```
Subtle (3–4 dB) — doctrinally correct ("we're getting shot at from up there"), grounded in elevation perception being a >4 kHz spectral cue, not a level cue.

### Raycast throttling (positional-webaudio 0.83)

Most cues are 100 ms transients needing **one raycast at schedule time**. Cull *first* (`atten < 0.02` already culls — keep it the first gate). For repeated fire from one cell, cache `occ`/`relElev` keyed by `floor(pos.x/5),floor(pos.y/5)` with ~50 ms TTL so a SAW rip reuses one raycast. Coarse march (8–12 samples) — sub-cell precision is inaudible. Keeps added cost to a few hundred bilinear `elevAt` lookups/frame.

---

## 6 · MIXING & DYNAMICS

### Bus structure (adaptive-mixing 0.90 — the prerequisite)

```
per-cue: sources → envGain → [BUS].dry → master
                          └→ sendGain → preDelay → convolver → reverbReturn → master
buses:   combat / atmos / radio / score → master → DynamicsCompressor(limiter) → destination
```
Static bus trims set the somber balance: `combat 0 dB · atmos −6 · radio −3 · score −9`. The **radio bus gets a fixed in-handset chain** built once: `gain → highpass 550 Hz (Q0.7) → lowpass 3 kHz → tanh WaveShaper(drive 1.3–1.8) → DynamicsCompressor(thr −30, ratio 14, atk 3 ms, rel 0.1) → peaking +6 dB @1.5 kHz → master` (reference-acoustics 0.85, CRI Middleware). Today `radio` squelches but doesn't band-limit a voice element — making the net sound like a degraded speaker under the log line is a big presence win and reinforces "you command, you don't shoot."

### HDR window auto-mixer (adaptive-mixing 0.86, reference-acoustics 0.85 — compute-side, deterministic)

Give each `CueKind` a `loudnessDb` constant (augment `KIND_TRIM`):
```
ied 128 · blast_large 120 · splash 118 · mg 105 · muzzle 100 · impact 75 · ricochet 70 · ambient 45
```
Maintain a floating `windowTop` (the loudest current sound raises it; an exp release pulls it down):
```
windowTop = max(windowTop, loudnessDb - distanceDb)
each frame: windowTop += (floor - windowTop) * (1 - exp(-dt/releaseTau))   // releaseTau ~0.5–1.5 s
windowBottom = windowTop - SIZE     // SIZE ~35–40 dB
if loudnessDb < windowBottom → CULL (don't allocate) ← also the over-budget pre-filter
else outGain = pow(10, (loudnessDb - windowTop)/20)  // folded into cueGain
```
A near M4 raises the window so distant impacts vanish; as fire stops the window sinks and the valley's small sounds re-emerge. **Silence is just what the window decays into** — legibility AND the readable-calm for free. All decisions are pure (keep `ctx.currentTime`/`Math.random` out of the decision layer; only the gain ramp's wall-clock anchor lives in the player).

### Ducking — control-side, NOT sidechain (adaptive-mixing 0.88, unanimous)

`DynamicsCompressorNode` **cannot be sidechained** (no external trigger; an AudioWorklet would break determinism + add cost). The correct, cheap, deterministic substitute: ramp the **target bus gain** with two `setTargetAtTime` calls (attack + release) when a trigger cue fires — duck amount/timing is a pure function of *which cue* fired.
```
duck(bus, amount, atkTau, holdS, relTau, now):
  bus.gain.cancelScheduledValues(now)
  bus.gain.setTargetAtTime(base*amount, now, atkTau)
  bus.gain.setTargetAtTime(base, now+holdS, relTau)

RADIO:        atmos→0.5, combat→0.7,  atk 0.02, hold 0.15, rel 0.25
IED/blast_lg: atmos+radio+score→0.25, combat→0.5, atk 0.004, hold 0.18, rel 0.4–1.2  (long swell back = ears recovering)
```
`setTargetAtTime` is click-free and self-chaining, so overlapping ducks compose. Use full-mix duck **rarely** (genuine over-pressure only) — over-ducking every radio squelch reads as an arcade whoosh.

### Master limiter (adaptive-mixing 0.95)

ONE `DynamicsCompressorNode` between master and destination as a **conservative brickwall safety net** (`threshold −6, knee 0, ratio 20, attack 0.003, release 0.25`). Let per-cue HDR gains do the level work; the limiter only catches coincident MG+IED peaks. Park typical peaks ~−6 dBFS for headroom so an IED *feels* +20 dB bigger instead of both pinning the limiter. **Don't let it pump** (too-aggressive = audible breathing on every burst, flattening the somber dynamics).

### Voice priority (adaptive-mixing 0.88, positional-webaudio 0.82)

Replace "drop the newest cue at 24" (backwards — can mute the gunshot you need while a stale ricochet plays) with **priority-weighted stealing**:
```
priority = classWeight[kind]*1000 + postHDRgain*100
classWeight: ied/dangerclose/tic_sting=4(Permanent) · blast/mg/splash=3 · muzzle/radio=2 · impact/ricochet/nearmiss/smoke=1
```
Fill high→low; when at cap, if the incoming cue **strictly outranks** the quietest live voice, fade it out (5 ms ramp to 0, never hard-disconnect) and take the slot, else cull the new cue. Track live voices as `{priority, cleanup}`. **Raise `MAX_VOICES` 24 → ~32** now that HDR pre-culls and the limiter protects the sum. Only steal when strictly outranked (prevents voice-steal thrash/chatter).

### Loudness target (adaptive-mixing 0.82)

Chase **quiet, cinematic** targets — a somber sim wants WIDE dynamic range so a held breath vs an IED actually lands: **~−24 LUFS** (console norm), leaning toward Netflix −27 dialog-gated; **−1 dBTP** ceiling (limiter enforces); **calm-vs-blast RMS spread > 15 dB**. The **radio line is the dialog anchor** (0 dB ref); atmos sits 12–15 dB below combat in CALM so silence reads. **Validate headlessly** in `scripts/audio-render.ts`: assert busiest-frame true-peak < −1 dBTP and calm/loud RMS spread > 15 dB — turns "somber dynamic range" into a checkable number (Law 1).

### Mix-states (adaptive-mixing 0.78) — *optional, high-payoff*

Derive a `CALM / CONTACT / OVERWHELM` enum from the sim's deterministic intensity (`inContact` + a decaying fire-rate counter), crossfading bus levels + HDR window params over ~1–3 s. CALM: wide window, atmos+reverb up, silence between events. OVERWHELM (heavy TIC/danger-close/IED): tight window, atmos/score gone, the 45 Hz `tic_sting` drone sustained, combat reverb tightened. *The transition itself is the drama.*

---

## 7 · REFERENCE FEEL — the moments that say "they were there"

**The 8 sonic moments to nail** (each grounded in a first-hand/film reference):

1. **The crack-thump ranging beat** — a flash on the ridge, then ~1 s later the *thump* rolls in. Soldiers literally range the enemy this way (SA80 study: 94 ms @50 m, 507 ms @300 m). The most-cited "this sounds real" detail. *(reference-acoustics 0.92)*
2. **Rolling valley thunder** — a single PKM burst from the high ground becomes pop… *then* a multi-second tail of discrete slaps bouncing off named cliff faces (acoustics.org: a pristine pop becomes "a loud bang with reverberation lasting over a second"). *(canyon-reverb / reference-acoustics)*
3. **The IED over-pressure dump** — not a louder blast, but the world going *quiet around it*: everything ducks for a beat, the soft-clipped sub hits the chest, the tail rolls out. HDR makes it *felt*. *(adaptive-mixing)*
4. **Post-blast subjective deafness** — a near large-HE / danger-close round drops the master to a muffled lowpassed roar + a steady ~4–6 kHz tinnitus ring that lifts over 3–6 s (the world clarifying). The Saving-Private-Ryan codifier. **Gate to genuinely close + large HE only.** *(reference-acoustics 0.82)*
5. **The readable silence of the calm-before** — a barely-there wind/insect/distant-stream bed, then the TIC yanks it to near-zero. Restrepo's "unnerving stillness… 100 mph into a dead hole." Silence as *active dread*. *(ambient-soundscape / reference-acoustics)*
6. **The diesel generator + the adhan** — the COP's ever-present drone and the call to prayer drifting up the valley at fixed times; a firefight interrupting the adhan lands hard. THIS setting's signature. *(ambient-soundscape 0.78)*
7. **The degraded combat-net** — band-limited (550 Hz–3 kHz), softly saturated, compressed squelch-bracketed traffic under the log line. "Radios flying around" carrying you between silence and chaos. *(reference-acoustics 0.85)*
8. **Directional incoming** — "every snap is very directional" (Ray Mendoza, *Warfare*): enemy fire panned hard to its bearing (left ridge vs right village), your squad's outgoing centered/softer — bearing-to-threat becomes audible, the top-down tactical read made sonic. *(reference-acoustics 0.72)*

**Hollywood excesses to AVOID** (the arcade failure modes — restraint is a literal success criterion):
- **Don't make blasts louder to feel powerful** — power comes from ducking everything *else* (HDR). Loud-blast = arcade.
- **Don't overuse the tinnitus/muffle trope** — "one of the most overused tropes in film." A handful of times per engagement, close+large HE only.
- **No over-bright, over-compressed "pew-pew"** — keep peaks low; let the TAIL and the crack-thump GAP carry weight.
- **No over-wet reverb** — drowning every rifle crack in tail kills the calm-before. Default wet low; radio/UI bone dry.
- **No musical stings beyond `tic_sting`** — it's the *only* musical element, rare, gated to the TIC rising edge.
- **No always-on full-volume nature bed** — reads as a theme-park ride. Restrained floor; let silence breathe.

---

## 8 · CONCRETE PARAMETER TABLE — starting values

### Gunshot 5-layer stack (per shot)
| Layer | M4 (5.56) | AK (7.62) | SAW | PKM |
|-------|-----------|-----------|-----|-----|
| TRANSIENT | HP6k Q0.5 dur0.004 atk0.00005 | same | same | same |
| BODY center / Q / dur | 3500 / 1.5 / 0.05 | 2600 / 1.2 / 0.075 | 3700 / 1.8 / 0.045 | 2400 / 1.0 / 0.085 |
| SUB f0→f1 / dur | 180→90 / 0.06 | 140→68 / 0.07 | 180→95 / 0.05 | 130→60 / 0.07 |
| MECHANICAL | BP3k Q5 dur0.006 peak0.12 @crack+0.012–0.025 | same | same | same |
| N-wave dur / HP | 0.00035 / 5000 | 0.0006 / 3500 | 0.00035 / 5200 | 0.0007 / 3300 |
| RPM step (burst) | — | — | 0.064–0.078 s (~850) | 0.088–0.102 s (~650) |

### Per-shot deterministic jitter (golden-ratio): `v_i = fract(cue.v*1.618 + i*0.618)` → body ±8%, peak ±15%, decay ±12%, timing ±4 ms, pan ±0.05

### Reverb IR
| Param | Value |
|-------|-------|
| RT60 | 1.8 s (short bus) / 2.6 s (HE bus, optional) |
| `base` | `(1/1000)^(1/(RT60*sr))` |
| IR shaping | HP 350 Hz, LP swept 6 kHz→1.2 kHz across tail, 8 ms fade-in |
| Slap taps (s / amp) | 0.18/0.6 · 0.42/0.35 · 0.85/0.2 · 1.4/0.12 (HE only) |
| Wet send (distance) | `atten*clamp(0.12+0.55*norm,0,0.7)` |
| Pre-delay | `clamp(0.02+norm*0.12,0.02,0.18)` s |

### `KIND_WET` (reverb send) / `loudnessDb` (HDR) / priority class
| Kind | wet | loudnessDb | class |
|------|-----|-----------|-------|
| ied | 0.85 | 128 | 4 |
| blast_large / splash | 0.85 / 0.7 | 120 / 118 | 3 |
| blast_small | 0.6 | 110 | 3 |
| mg_us/insurgent | 0.45 | 105 | 3 |
| muzzle_us/insurgent | 0.35 | 100 | 2 |
| nearmiss | 0.25 | 95 | 1 |
| impact / ricochet | 0.15 | 75 / 70 | 1 |
| smoke_pop / frag_air / flare | 0.1 | 65 | 1 |
| radio | 0.0 | (anchor 0 dB) | 2 |
| dangerclose / tic_sting / shot | 0.0 | high | 4 |

### Spatialization / occlusion / elevation
| Param | Value |
|-------|-------|
| Occlusion lowpass | `lerp(nearCutoff, 350Hz, occ)`, gain `*lerp(1.0,0.5,occ)` |
| Occlusion smoothing | lerp ~5/s toward target |
| Raycast samples / throttle | 8–12 / cache per 5 m cell, 50 ms TTL |
| Elevation high-shelf | @5 kHz, `clamp(relElev/heightScale,-1,1)*±4 dB` |
| Drop N-wave/mechanical | past ~250 m / ~60 m |

### Buses / dynamics
| Param | Value |
|-------|-------|
| Bus trims | combat 0 / atmos −6 / radio −3 / score −9 dB |
| Master limiter | thr −6, knee 0, ratio 20, atk 3 ms, rel 250 ms |
| Radio chain | HP 550 Hz Q0.7 → LP 3 kHz → tanh(1.3–1.8) → comp(−30,14,3ms,100ms) → peak +6 dB @1.5 kHz |
| HDR window | SIZE 35–40 dB, releaseTau 0.5–1.5 s |
| Duck (radio) | atmos→0.5 combat→0.7, atk 0.02, hold 0.15, rel 0.25 |
| Duck (IED) | atmos/radio/score→0.25 combat→0.5, atk 0.004, hold 0.18, rel 0.4–1.2 |
| TIC duck / exhale | atmos→0.15 atk0.4 / restore tau 12 s |
| MAX_VOICES | 24 → 32 |
| Loudness / ceiling / spread | −24 LUFS / −1 dBTP / >15 dB |

### Ambient bed
| Layer | Key params |
|-------|-----------|
| Wind biquads | LP/BP 180 & 350 Hz Q0.7 (howl) + BP 900 & 2200 Hz Q6–10 (whistle); whistle cutoff lag DelayNode 0.3–0.8 s |
| Gust LFO | 0.05–0.3 Hz; drive base gain + brightness from `weather.wind` 0–8 m/s |
| Generator | sine 55–65 Hz + 3–5 harmonics → LP 250 Hz; lope LFO 3–7 Hz; COP-radius gate |
| River | BP center ~1.2 kHz Q0.4 + breathing LFO 0.05–0.1 Hz + notch 3–4 kHz |
| Irrational LFO rates | wind 0.13, river 0.077, insect 0.19, generator 0.043 Hz (mutually prime — never repeat) |
| Crossfade | equal-power cos/sin on `solarLight()`, ramp tau 8 s |
| Bed floor | 0.04–0.08 gain |
| Poisson | `nextFire = lastFire + (-ln(hash(layer,n)) / density)` |

---

## 9 · RISKS & DETERMINISM NOTES

### Determinism (Law 7 — the contract)
- **Param choices feeding audible timbre MUST be pure** — derive from `cue.v` + shot-index golden-ratio, never `Math.random` in the mapper/decision layer. `Math.random` is allowed **only** in render-side noise-buffer/IR fill (as `noiseBuffer` already scopes it). *A same-seed firefight that sounds different IS the bug.*
- **The IR, ambient loops, tinnitus oscillators, occlusion raycasts, HDR window state, duck timing, mix-state — all live render-side** (`player.ts`/`synth.ts`/`ambient.ts`) and never feed back into `lib/sim`. The cue→sound mapping and ambient-state mapping stay pure functions of sim signals. IR *choice* (per-deployment) is a pure function of the seed.
- **Ambient-state reads only existing deterministic World signals** — `solarLight()`, `windVector()`, `secondsOfDay`, `weather` — verified to exist. Zero new sim state.
- **The probe (`scripts/audio-probe.ts`) and oracle (`scripts/audio-render.ts`) are the guards.** Capture the **before** on HEAD with `audio-render.ts` first (corrects the reports' "no harness" claim). Update `audio-render.ts`'s `// MIRRORS player.ts` blocks in lockstep with `schedule()` — it duplicates the node chain + near-miss tail + voice cap. **New `KIND_WET`/`loudnessDb`/priority Records must be exhaustive `Record<CueKind,…>`** so the compiler fails until every cue declares its value.

### Performance budget (~24–32 voices)
- **ONE shared `ConvolverNode`** for all gunfire via per-cue sends — never per-voice (the classic killer). Build IR once at unlock (cache like `_noise`); regenerate only on deployment/weather change, never per frame.
- **Keep StereoPanner, never HRTF** — HRTF is up to 4 convolvers per moving voice; at 32 voices it starves a TIC.
- **Persistent bus/panner/convolver/compressor topology**; only `osc`/`noise` sources created per cue. Eliminate the current per-cue `Gain+Panner+Biquad` churn + `setTimeout` teardown (padenot's warned-against allocation pattern).
- **Cull before raycasting** (`atten<0.02` first gate); throttle occlusion to ~15–20 Hz, cache per 5 m cell. Most cues are 100 ms transients → one raycast each.
- **Master `DynamicsCompressorNode`** glues polyphony; scale bus gain down as `activeVoices` rises (mirror the LOD philosophy in `combat-fx.ts`).

### Mix-mud risks
- **Sub buildup** — high-pass the reverb send, drop SUB on distant shots, reserve full sub for first-shot emphasis. Many simultaneous subs pile into boom.
- **Feed only the bright crack/body into the convolver, not the sub** — full-shot-into-IR smears the low end into a roar.
- **Frequency-partition the ambient bed by acoustic niche** — don't rely on a master compressor to fix overlap (it pumps and flattens dynamics).
- **Stale/over-long tails** in a sustained fight pile into white noise — send only a fraction of rounds to reverb; let the polyphony cap + HDR duck thin it.

### Soul / restraint risks (the brief's literal success criterion)
- **Over-wet, over-loud, over-compressed = arcade** — the exact opposite of the brief. Default wet low; let only distance + HE bloom; keep radio/UI/sting dry. Let the HDR window sink to near-silence between events.
- **Pause/warp gate** — the bed obeys the same gate as cues (ramp atmos to 0 on pause, don't hard-stop or dump a backlog on resume; the existing `tick()` skip()/gate is the template). Decide deliberately whether long reverb tails ring out on pause so a paused screenshot isn't accidentally noisy.
- **TIC one-way latch caveat** (repo gotcha): `_wasInContact` is a one-way speed latch; the mapper's `wasContact`/`tic_sting` already mirrors it mapper-side. The ambient duck/exhale must respect that contact doesn't auto-restore speed — drive the exhale off the contact *falling* edge, not a speed signal.

### Build sequence (dependency-ordered)
1. **Bus refactor + master limiter** (move 2/8) — unblocks everything; verify no regression via `audio-render.ts` peak/RMS.
2. **Shared convolver + distance wet send** (move 1) — the biggest single immersion jump.
3. **5-layer stack + N-wave split + per-weapon table** (moves 4–5).
4. **HDR window + control-side ducking + voice priority** (moves 3/8).
5. **Occlusion + elevation** (move 7).
6. **Ambient bed** (move 6) — largest new surface (2 new modules), lowest determinism risk.

**Done-gate per phase:** `audio-render.ts` before/after numbers (peak < −1 dBTP, calm/loud RMS spread > 15 dB, per-scene A/B `.wav`), `audio-probe.ts` AUDIO OK (purity + determinism), plus the standing `tsc/build/lint/smoke`.

---

**Files this spec touches:** `/Users/elliothimmelfarb/code/in-the-mountains/lib/audio/synth.ts` (5-layer recipes, N-wave, HE staggering, weapon table), `/Users/elliothimmelfarb/code/in-the-mountains/lib/audio/player.ts` (bus graph, convolver, HDR window, ducking, voice priority, occlusion/elevation in `computeSpatial`, `KIND_WET`/`loudnessDb` Records), new `/Users/elliothimmelfarb/code/in-the-mountains/lib/audio/ambient-state.ts` (pure) + `/Users/elliothimmelfarb/code/in-the-mountains/lib/audio/ambient.ts` (render). **Baseline + verification instrument:** `/Users/elliothimmelfarb/code/in-the-mountains/scripts/audio-render.ts` (offline oracle — run on HEAD first) and `/Users/elliothimmelfarb/code/in-the-mountains/scripts/audio-probe.ts` (purity/determinism guard).