/**
 * ambient-state.ts — the PURE, HEADLESS ambient MIXER. The geophony/biophony/anthrophony
 * analogue of mapper.ts: it reads deterministic World signals (clock, sun, weather, camera
 * geometry) and DESCRIBES an {@link AmbientMix} of target numbers — per-layer gains, filter
 * brightnesses, spot densities, pans, and the contact duck. It synthesizes nothing; the
 * render-side {@link AmbientEngine} (ambient.ts) chases these targets with Web Audio nodes.
 *
 * Layer law (Law 7 / determinism contract): NO browser imports, NO wall-clock (no Date), NO
 * PRNG stream, NO Math.random. `computeAmbientMix` is a pure function of {@link AmbientSignals}
 * — same seed + same clock ⇒ byte-identical mix, forever. The only randomness in the whole
 * subsystem is the render-side persistent noise-buffer fill in ambient.ts (mirroring synth.ts).
 *
 * The design soul this serves is "the readable silence of the calm-before": the bed sits at a
 * barely-there floor (~0.04–0.08) so that between firefights the valley reads as TENSE CALM,
 * not "audio off"; then a firefight ducks the whole bus toward zero and its ABSENCE sells the
 * violence. Wildlife goes quiet when the shooting starts (true to life), then EXHALES slowly.
 *
 * ACOUSTIC-NICHE PARTITIONING (the mix-mud cure — each layer owns a reserved band, set in
 * ambient.ts, so layers never mask each other BY DESIGN):
 *   wind howl 100–400 Hz + whistle 1–3 kHz · river 0.4–6 kHz notched 3–4 kHz ·
 *   generator <250 Hz · birds 2–5 kHz · insects 4–7 kHz · adhan 0.3–2 kHz · rain bed broadband-low.
 */

import { RNG } from "@/lib/sim/world";

// ----------------------------------------------------------------------------- interface in
/** Deterministic World signals the mix derives from. Provided by the caller (store/player);
 *  this file never reaches into the World — it only reads these scalars. */
export interface AmbientSignals {
  /** 0..86400 — wall-clock seconds of the in-game day. Drives prayer marks + spot phase. */
  secondsOfDay: number;
  /** World.solarLight() 0..1 — a smooth dawn→noon→dusk ramp; the day/night crossfade axis. */
  solar: number;
  /** convenience flag (solar below the dusk threshold). Selects crickets vs birds bias. */
  isNight: boolean;
  /** weather.wind in m/s (0..~8). Drives wind base gain + whistle brightness. */
  windSpeed: number;
  /** "Clear"|"Hazy"|"Overcast"|"Rain"|"Fog"|"Snow" — coarse weather class. */
  weatherLabel: string;
  /** true when precipitation is falling (rain or snow). Pushes birds→0, raises the rain bed. */
  precip: boolean;
  /** the TIC flag. Rising edge ducks the bus HARD+FAST; falling edge EXHALES slowly. */
  inContact: boolean;
  /** metres camera→COP (Infinity if unknown). Distance-gates the diesel generator drone. */
  copDist: number;
  /** -1..1 screen pan of the COP. */
  copPan: number;
  /** metres camera→nearest village. Gates the adhan + biases dog/voice spots. */
  villageDist: number;
  /** -1..1 screen pan of the nearest village. */
  villagePan: number;
  /** metres camera→nearest river cell. Distance-gates the river layer. */
  riverDist: number;
  /** -1..1 screen pan of the river. */
  riverPan: number;
}

// ----------------------------------------------------------------------------- interface out
/** A panned spot-emitter layer: a Poisson density (events/sec) + where it sits in the field +
 *  a band selector the render side maps to its reserved filter. */
export interface SpotLayer {
  /** mean events per second (Poisson rate λ). 0 ⇒ the layer is silent (no scheduling). */
  density: number;
  /** -1..1 stereo placement of the source. */
  pan: number;
  /** 0..1 loudness trim for individual one-shots in this layer. */
  gain: number;
}

/** A continuous BED layer: a target gain the render side crossfades to (never a loop swap),
 *  plus an optional 0..1 brightness the layer maps to its own filter cutoff/mix. */
export interface BedLayer {
  /** 0..1 target gain (post acoustic-niche trim, pre-duck — the engine multiplies by `duck`). */
  gain: number;
  /** 0..1 timbre brightness for the layer's signature filter (e.g. wind whistle openness). */
  brightness: number;
}

/** The complete target field the render engine chases. Every number is a TARGET the engine
 *  reaches via setTargetAtTime — this struct is a snapshot, not a stream of events. */
export interface AmbientMix {
  // ---- persistent geophony/anthrophony beds (always alive; gains crossfaded) ----
  /** wind bed: gain rises with windSpeed, brightness opens the whistle band as gusts build. */
  wind: BedLayer;
  /** river bed: gain falls with camera distance to water; brightness ≈ proximity. */
  river: BedLayer;
  /** diesel generator drone: distance-gated to the COP; brightness unused (kept for symmetry). */
  generator: BedLayer;
  /** rain bed: broadband-low hiss that fades in with precip; brightness ≈ intensity. */
  rain: BedLayer;

  // ---- Poisson-scheduled biophony/anthrophony spots (detail lives here) ----
  /** day birds (2–5 kHz). density follows the day biophony envelope; → 0 in rain/contact. */
  birds: SpotLayer;
  /** night crickets/insects (4–7 kHz). density follows the night biophony envelope. */
  insects: SpotLayer;
  /** dogs (rare, esp. night) — village/ridge anthrophony. */
  dogs: SpotLayer;
  /** rain droplet ticks (highpassed) — only when precip; density ≈ intensity. */
  drops: SpotLayer;
  /** thunder rolls (rare, Rain only) — a long valley rumble. NOT gated by contact: the storm
   *  doesn't care about the firefight (geophony keeps rolling where biophony freezes). */
  thunder: SpotLayer;

  // ---- scheduled (NOT Poisson) call to prayer ----
  /** true within a prayer window — the engine arms one adhan melisma at the window's start. */
  adhanActive: boolean;
  /** which prayer mark we are inside (0..4: fajr/dhuhr/asr/maghrib/isha; -1 if none). Identity
   *  for the engine's "fire once per window" latch, so the same call doesn't retrigger. */
  adhanMark: number;
  /** -1..1 pan of the adhan (nearest village). */
  adhanPan: number;

  // ---- global mix controls ----
  /** 0..1 master multiplier on the WHOLE ambient bus. 1 = calm-before; → ~0.15 on contact. */
  duck: number;
  /** the readable floor (~0.04–0.08): the minimum the bed sits at so calm ≠ "audio off". */
  bedFloor: number;
}

// ----------------------------------------------------------------------------- tuning
/** Wind reaches full howl at ~8 m/s; the readable floor keeps a whisper even at dead-calm. */
const WIND_MAX = 8;
/** River audible within ~120 m of a water cell; inaudible past ~400 m. */
const RIVER_NEAR = 120;
const RIVER_FAR = 400;
/** The diesel generator is a COP signature — audible within the wire, gone past ~250 m. */
const GEN_NEAR = 60;
const GEN_FAR = 250;
/** Spot anthrophony (dogs/voices) keys off the nearest village within ~600 m. */
const VILLAGE_NEAR = 150;
const VILLAGE_FAR = 600;
/** Prayer marks in seconds-of-day (fajr/dhuhr/asr/maghrib/isha) — fixed, NOT random, so a
 *  firefight interrupting the adhan lands on a SCHEDULED beat. Approx. Korengal-latitude times. */
const PRAYER_MARKS = [5 * 3600, 12.5 * 3600, 15.75 * 3600, 18.5 * 3600, 20 * 3600];
/** Seconds after a mark the adhan window stays armed (the call lasts ~2 min; the engine plays
 *  one melisma and latches, so the window only needs to be wide enough to never miss a tick). */
const ADHAN_WINDOW_S = 120;
/** The readable-silence floor. Bed beds never fully die — silence-with-texture. */
const BED_FLOOR = 0.06;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smooth 1→0 proximity falloff over [near,far] metres (1 at/inside near, 0 past far). */
function distGain(dist: number, near: number, far: number): number {
  if (!isFinite(dist)) return 0;
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  const t = (dist - near) / (far - near);
  return clamp01(1 - t * t); // ease-out: holds presence close in, drops off toward the edge
}

// ----------------------------------------------------------------------------- the mapper
/**
 * PURE: AmbientSignals → AmbientMix. Same inputs ⇒ same struct. The engine treats every
 * number as a setTargetAtTime destination, so this never needs to know dt — it describes the
 * STEADY STATE the mix should be heading toward at this instant of the sim clock.
 */
export function computeAmbientMix(s: AmbientSignals): AmbientMix {
  // --- day / night biophony crossfade (equal-power on the solar ramp) ---------------------
  // solar 0..1 is already a smooth dawn/dusk ramp. Map it through sin/cos quarter-circles so
  // day+night power sums to a constant — no dip at the crossover (the equal-power crossfade).
  const sclamp = clamp01(s.solar);
  const dayBio = Math.sin((sclamp * Math.PI) / 2); // 0 at night → 1 at noon
  const nightBio = Math.cos((sclamp * Math.PI) / 2); // 1 at night → 0 at noon
  // Dawn/dusk birds are LOUDEST at the edges of daylight (the dawn chorus): bump density where
  // the sun is low-but-up. A gaussian-ish bump centered near solar≈0.35.
  const dawnChorus = Math.exp(-((sclamp - 0.35) ** 2) / (2 * 0.12 ** 2));

  // --- weather gates ----------------------------------------------------------------------
  const w = s.weatherLabel;
  const foggy = w === "Fog";
  const snowy = w === "Snow";
  const overcast = w === "Overcast";
  // Wildlife thins under bad weather even without precip (overcast/fog dampens the chorus).
  const weatherBio = foggy ? 0.35 : overcast ? 0.7 : snowy ? 0.5 : 1.0;
  // Rain/snow intensity proxy (the signals only give a boolean; class scales the bed/droplets).
  const precipI = s.precip ? (w === "Rain" ? 1.0 : snowy ? 0.45 : 0.7) : 0;

  // --- contact duck (the readable-silence contract) ---------------------------------------
  // The TARGET; the engine owns the asymmetric ramp tau (fast in, slow exhale). On contact the
  // whole bus collapses toward 0.15 and wildlife density goes to 0 (animals freeze when shooting
  // starts). We keep wind/generator slightly present via the engine's per-layer floors.
  const duck = s.inContact ? 0.15 : 1.0;
  const wildlifeOpen = s.inContact ? 0 : 1; // hard gate on biophony spot density during a TIC

  // --- WIND (geophony) --------------------------------------------------------------------
  // Base gain rises from the readable floor at dead-calm to full howl at WIND_MAX. Brightness
  // (the whistle band's openness) scales harder with windSpeed — a Snow-7 night WHISTLES where
  // a Clear-3 day only HOWLS. The render side LAGS brightness behind loudness (gust→then→whistle).
  const windN = clamp01(s.windSpeed / WIND_MAX);
  const wind: BedLayer = {
    gain: BED_FLOOR + windN * (1 - BED_FLOOR), // floor .. 1
    brightness: clamp01(windN * windN * 1.1), // quadratic: whistle only really bites in strong wind
  };

  // --- RIVER (geophony) -------------------------------------------------------------------
  const riverProx = distGain(s.riverDist, RIVER_NEAR, RIVER_FAR);
  const river: BedLayer = {
    gain: riverProx, // can fall to 0 when far from water — the river is local, not omnipresent
    brightness: riverProx, // closer = brighter (more high-freq babble before air absorption)
  };

  // --- GENERATOR (anthrophony: the COP diesel signature) ----------------------------------
  const genProx = distGain(s.copDist, GEN_NEAR, GEN_FAR);
  const generator: BedLayer = {
    gain: genProx * 0.9, // a steady drone — never the loudest thing, but unmistakable at the COP
    brightness: 0, // the lope/harmonics are fixed in the engine; no brightness axis
  };

  // --- RAIN (geophony bed) ----------------------------------------------------------------
  const rain: BedLayer = {
    gain: precipI, // fades in with precip; 0 otherwise
    brightness: clamp01(precipI), // harder rain = brighter hiss
  };

  // --- BIRDS (day biophony spots, 2–5 kHz) ------------------------------------------------
  // Density follows the day envelope, boosted at dawn/dusk, gated to 0 by rain AND by contact.
  const birdDensity = dayBio * (0.6 + 0.9 * dawnChorus) * weatherBio * (1 - clamp01(precipI)) * wildlifeOpen;
  const birds: SpotLayer = {
    density: clamp01(birdDensity) * 0.9, // λ ~0..0.9 calls/sec at peak chorus
    pan: s.villagePan * 0.4 + s.riverPan * 0.2, // birds favour the green line near water/village
    gain: 0.7,
  };

  // --- INSECTS / CRICKETS (night biophony spots, 4–7 kHz) ---------------------------------
  // Crickets swell at night; quieter in cold (snow) and rain. Gated by contact like the birds.
  const coldDamp = snowy ? 0.4 : foggy ? 0.7 : 1.0;
  const insectDensity = nightBio * coldDamp * (1 - clamp01(precipI) * 0.7) * wildlifeOpen;
  const insects: SpotLayer = {
    density: clamp01(insectDensity) * 1.1, // λ a touch denser than birds — a steady night chorus
    pan: 0, // diffuse, all around
    gain: 0.5,
  };

  // --- DOGS (rare anthrophony, esp. night, near a village) --------------------------------
  const villageProx = distGain(s.villageDist, VILLAGE_NEAR, VILLAGE_FAR);
  const dogDensity = villageProx * (0.3 + 0.7 * nightBio) * wildlifeOpen; // more barking after dark
  const dogs: SpotLayer = {
    density: clamp01(dogDensity) * 0.06, // RARE: λ ~0.06/sec ⇒ a bark roughly every ~17 s near a village at night
    pan: s.villagePan,
    gain: 0.6,
  };

  // --- RAIN DROPLETS (geophony spots) -----------------------------------------------------
  const drops: SpotLayer = {
    density: precipI * 14, // dense ticks: λ scales with intensity (rain is many small one-shots)
    pan: 0,
    gain: 0.3,
  };

  // --- THUNDER (geophony spots — Rain only, rare) ------------------------------------------
  // λ ≈ 0.022/s ⇒ a roll roughly every ~45 s in a rainstorm. Snow/fog get none (mountain storms
  // thunder in rain). Deliberately NOT × wildlifeOpen — a TIC silences the birds, never the sky.
  const thunder: SpotLayer = {
    density: w === "Rain" && s.precip ? 0.022 : 0,
    pan: 0, // per-event bearing comes from the event hash (each roll from a different quarter)
    gain: 0.85,
  };

  // --- ADHAN (scheduled call to prayer — NOT Poisson) -------------------------------------
  // Active within ADHAN_WINDOW_S of a prayer mark AND only when a village is within earshot.
  // adhanMark is the window identity so the engine fires exactly one melisma per call.
  let adhanMark = -1;
  if (villageProx > 0) {
    for (let i = 0; i < PRAYER_MARKS.length; i++) {
      const since = s.secondsOfDay - PRAYER_MARKS[i];
      if (since >= 0 && since < ADHAN_WINDOW_S) {
        adhanMark = i;
        break;
      }
    }
  }
  const adhanActive = adhanMark >= 0;

  return {
    wind,
    river,
    generator,
    rain,
    birds,
    insects,
    dogs,
    drops,
    thunder,
    adhanActive,
    adhanMark,
    adhanPan: s.villagePan,
    duck,
    bedFloor: BED_FLOOR,
  };
}

// ----------------------------------------------------------------------------- pure spot clock
/**
 * The PURE next-fire time for a Poisson spot stream, so render-side scheduling is
 * deterministic (same seed + clock ⇒ same birds). Mirrors cue.ts's use of RNG.hashString:
 *
 *   nextFire = lastFire + (-ln(u) / density),   u = hashToUnit(layer, n)
 *
 * with n the per-layer event index. The engine advances an internal clock by dt and fires
 * whenever the clock passes the next scheduled time, then increments n. density==0 ⇒ Infinity
 * (the stream sleeps until density returns). Pitch/pan jitter use the same hash family.
 */
export function hashToUnit(layer: string, n: number): number {
  // +1 and a salt avoid u==0 (which would make -ln(u) blow up) and decorrelate layers.
  return (RNG.hashString(layer + ":" + n) % 100000) / 100000 + 1e-6;
}

/** The interval to the next Poisson event for `(layer, n)` at the given density (events/sec).
 *  density<=0 ⇒ Infinity (no event). Pure: a function of the hash and density only. */
export function poissonInterval(layer: string, n: number, density: number): number {
  if (density <= 0) return Infinity;
  const u = Math.min(0.999999, hashToUnit(layer, n));
  return -Math.log(u) / density;
}
