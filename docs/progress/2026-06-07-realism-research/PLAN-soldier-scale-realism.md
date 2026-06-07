# Campaign brief — Soldier-Scale Realism (the next iteration)

**Status:** research-only (this campaign made NO code changes — a parallel scale campaign owns the tree).
**Date:** 2026-06-07 · **Author:** lead orchestrator · **Companion:** `report.html` (diagrams + annotated renders).
**Hand-off:** paste this file as the `/goal` for the next campaign. Every workstream below names the exact
`file:line` seam, the verified mechanism, a numeric Definition-of-Done, and the harness that proves it.

---

## 0 · The one idea that ties all four complaints together

The owner's four "doesn't feel right" notes are **one root cause wearing four hats: a resolution mismatch.**
The sim is tuned for the **operational scale** (a 2.56 km valley, multi-hour patrols, 5 m cells) but the player now
*watches at the **soldier scale*** — and at that scale the seams show:

| # | Complaint | Aliasing | One-line root cause |
|---|-----------|----------|---------------------|
| 1 | Census/village dwell feels too short | **temporal** | dwell is hard-coded in seconds (`census=300`), ~70× shorter than reality, and the census effect fires *instantly* on arrival |
| 2 | Squad sits on a base of fire, one man moves | **doctrinal** | the *default* on-contact drill is "hold" → the whole squad stamps a base of fire; it only maneuvers if you hand-pick "Assault," and even then it rushes the **front**, not a flank |
| 3 | Can't see a soldier use a rock / low wall | **spatial** | cover is a single averaged number per 5 m cell; the rock he'd hide behind is smaller than one cell, and the *rendered* rocks are cosmetic décor decoupled from cover |
| 4 | Squad rings the spur instead of climbing | **spatial** | the movement cost is **isotropic** (depends on a cell's slope *magnitude*, same in every heading) so a switchback never pays off, and `slope>1.25` cells are hard-blocked, fragmenting a climbable face into fake cliffs |

**The cheapest architecture that clears the bar:** a **two-tier terrain representation** — keep today's 5 m grid as the
*operational* layer (strategic map, cross-valley routing), and instantiate a **fine tactical patch (~1 m) with discrete
cover objects and an anisotropic cost surface** *only around active units*. That one decision fixes items 3 and 4 together
without re-baking the whole 512² world. Items 1 and 2 are smaller, self-contained changes on top.

> **Sequencing recommendation:** do **Item 1 first** (small, high-felt-impact, no architecture), then **Item 2**
> (medium, AI-only), then the shared **two-tier terrain** foundation, then **Items 3 & 4** on top of it. Do not start
> 3/4 until the in-flight *scale* campaign has landed — they depend on the final cell size and elevation field.

---

## Workstream 1 — Village/activity dwell is ~70× too short (and the census is instant)

### Verified mechanism
- `lib/sim/world/helpers.ts:30` `dwellFor(t)` — the only knob: **KLE 360 s · census 300 s · cordon 300 s ·
  overwatch 900 s · ambush 1100 s · recon 150 s · default 180 s** (all GAME-seconds).
- At the **default 4× speed** (`state/store.ts:341` `speed:4`; `SPEEDS=[1,2,4,8,16]`) a 300 s census passes in **75 real
  seconds**; at 16× in ~19 s; with skip-to-event warp the whole on-station flashes by.
- The census *effect* is **instantaneous**: `lib/sim/world/tasks.ts:443` — `t.missionType==="census" && near` → `near.censusDone=true; w.advanceCensus()` the moment the squad arrives. The dwell that follows is a static wait, not work.
- Attitude gain is the whole-dwell `+3` (`tasks.ts:437` `near.attitude += (3/dwellFor(t))*dt`); KLE advances its
  directive at `0.5/360` per second (`tasks.ts:435`).

### What reality says (doctrine + first-hand — see report for citations)
- **Cordon-and-search / census = half-to-full day (≈4–10 h).** Biometric enrollment alone is **up to 30 min *per person***
  (CALL *Commander's Guide to Biometrics*); a 4-element task org (cordon/search/support/command) works each qalat
  room-by-room (FM 3-06.11 Ch.14).
- **KLE/shura = 1–3 h per meeting, but the real mechanic is *cumulative*** across a **weekly** cadence over months
  (CALL 12-18; marines.mil COIN accounts). One shura barely moves the needle. Model the *Restrepo* "Cow Incident"
  disappointment branch.
- **OP/overwatch = hours (24 h patrol-base cap). Ambush = hours of waiting, 8 h rotation, contact is seconds.
  Recon ≥ 1 h.** Presence patrols run hours, the COIN gold standard is **3×/day saturation**, not one big sweep.

### Definition of Done (numeric)
1. Dwell durations raised toward reality (game-time): **census/cordon ≈ 2–8 h** (population-driven, see below),
   **KLE ≈ 1–2 h**, **overwatch ≈ 3–8 h** (24 h cap), **ambush occupation ≈ hours**, **recon ≥ 1 h**.
2. **Census becomes progressive, not instant:** `censusDone` flips only after the element works each compound /
   enrolls each fighting-age person (drive it off `village.population`); a partial census on early recall is partial.
3. **A dwell event-roll table** so a long, realistic dwell *surfaces decisions* instead of a progress bar: roll on a
   timeline for {a find · a biometric hit · a tip · an elder grievance (Cow Incident) · a med/MEDCAP moment · an FET
   gap (women can't be enrolled by men) · a squirter / crowd}. Each is a small `PendingEvent`.
4. **Warp is the intended way to pass the dwell** — verify skip-to-event already *stops* on these new events
   (`state/store.ts` warp loop, `w.pendingEvent`); the player warps through the patient hours and is pulled back the
   instant something matters. This is what makes long-but-realistic dwell *fun* rather than tedious.

### Approach & seam
- Replace the constant table in `dwellFor` with a function of mission + `village.population` (+ a small RNG spread).
- Add the event-roll inside `onStationEffects` (`tasks.ts:380`+) on a throttled clock; reuse the existing
  `PendingEvent`/`interrupt` machinery so warp halts on them.
- Determinism: any new persisted dwell/enrollment progress goes in **both** `serialize()` AND `loadWorld()`.

### Verify
- A headless `scripts/dwell-probe.ts`: for each mission type, assert on-station seconds ∈ the target band and that
  `censusDone` tracks population, not arrival. Re-run `smoke.ts` + `balance.ts` (a 2–8 h census must not stall the
  campaign tempo — tune the event cadence so warp keeps the day moving).

### Restraint / risk
- **Do not** simply 70× the numbers and call it done — a static 6-h wait at 4× is *worse*. The win is
  longer dwell **+ progressive work + event rolls + warp-through**. Log the risk you *don't* take (e.g. full
  per-person enrollment animation) and why.

---

## Workstream 2 — The squad fixes in place and never flanks (unless hand-told)

### Verified mechanism
- `lib/sim/world/types.ts:67` `defaultSOP` — census/presence/cordon default to **`contact:"hold"`**; overwatch/ambush
  to **`"suppress"`**. **None default to `"assault"`.**
- Both `hold` and `suppress` route to `stampBaseOfFire()` (`lib/sim/ai/squad-combat.ts:145`) which stamps
  `brainState="holding"` on **every** member → the whole squad is a base of fire, **zero maneuver**.
- A maneuver element is split **only** in the assault path (`assignElements` `squad-combat.ts:357`, called from
  `:90`). So the squad maneuvers *only if the player explicitly selects "Assault."*
- Even then the maneuver is a **frontal beeline at the threat centroid**: `stampAssault` sets
  `orderTarget={...threat}` and `walkTo(m, threat)` (`squad-combat.ts:178–182`) — straight at the enemy, not a covered
  flank — and the whole maneuver team moves at once (no bounding overwatch, no buddy-team leapfrog).
- The "one man moving" the owner saw is most likely `seekCover()` relocating an individual within 18 m
  (`squad-combat.ts:285–299`) or a buddy-aid drag (`friendly.ts:46`) — **cover-seeking, not a maneuver element.**

### What reality says
- A rifle squad is built as **two fire teams precisely so one suppresses while the other moves** (ATP/FM 3-21.8 BD 2A).
- The maneuver element is a **whole fire team (~4 men), never a lone rifleman** — one man can't generate the assault's
  own fire superiority the drill requires.
- It moves to a **vulnerable FLANK via a covered/concealed route** (often peeling *back* first, then swinging wide) and
  closes by **fire-and-movement: 3–5 s buddy-team rushes** while the base of fire shifts to the far side.
  **A frontal rush at the centroid is doctrinally wrong.**
- **Battle drills trigger WITHOUT an order.** A squad that just holds in place until told to maneuver has failed the most
  basic infantry standard. The squad leader's *default* is *develop-and-assault if he can gain fire superiority and finds
  a flank; hold/break only if he can't.*

### Definition of Done (numeric — measured baseline, `gen-combat-movers.ts`)
- **Baseline (measured, NOT zero — the probe corrected my guess):**
  - *Light contact* (heat 0.30): the squad stays **holding ~92%** of contact time; while fixed, a mean of **~3 of 9** men
    move (median 2) — individual cover-seeks / buddy-aid, **not** a maneuver element. (This IS the owner's "sit + a couple
    shuffle" regime.)
  - *Hot contact* (heat 0.62–0.86): the break-safety dominates — **~77%** of contact time is spent **breaking contact**
    (≈6 of 8 moving rearward). The squad runs, it doesn't close.
  - The chosen SOP (Hold/Suppress/Assault) is **nearly cosmetic** — behaviour is near-identical because the break-safety
    overrides it; the squad **never autonomously flank-assaults** in any setting.
- **Target:** the squad-leader AI **autonomously commits a maneuver fire team when fire superiority is achievable and a
  covered flank exists** — mean maneuvering men ≈ a **fire team (~3–4)** moving by **bounds** (only one element moving at a
  time), along a route whose **mean cover/concealment is meaningfully higher than the straight-line-to-centroid** (prove
  the flank is covered, not a frontal rush). The SOP must become a real lever (Hold ≠ Assault in the metrics).

### Approach & seam (one mechanism, not a pile of flags)
- Promote the squad-leader decision to a real gate in `squadFight` (`squad-combat.ts:79`): `react → assess fire
  superiority → if (superiority achievable && covered flank exists) assault-via-flank, else hold/suppress, else break`.
  This replaces "only assault if the player picked it" — the drill becomes autonomous, matching the design soul
  ("combat is 100% AI; the hardest part of command is watching"). The player's SOP becomes *guidance/permission*
  (e.g. "weapons hold" still gates ROE), not the on/off switch for maneuvering.
- Make the maneuver path a **flank, not a beeline**: route the maneuver team with the engine's existing
  cover/conceal-biased `findPath` (`concealBias`/`coverBias`) to a point on the enemy's flank, not `threat`. The
  corridor planner already favors covered ground — point it at the flank.
- Add **bounding overwatch**: split the maneuver team into two buddy pairs that alternate moving/overwatching (3–5 s
  rushes), only one moving at a time. This is the `friendly.ts` assault path (`:101`) extended with a bound cadence.
- Keep smoke (already modeled, `smokeIfNeeded` `squad-combat.ts:419`) screening each bound.

### Verify
- Extend `gen-combat-movers.ts` (this campaign's probe) into `scripts/squad-maneuver-probe.ts`: mean maneuvering men,
  fraction of in-contact time with exactly-one-element-moving (bounding discipline), and **flank-cover ratio** (mean
  cover along the maneuver route ÷ mean cover along the straight line to centroid; want > 1). Re-run `balance.ts` —
  maneuvering must not spike KIA (the flank should *reduce* exposure).

### Restraint / risk
- **Do NOT add individual-soldier micro as the "fix"** (CLAUDE.md hard rule). The player still only sets SOP +
  approves fires; the squad-leader *AI* gains the maneuver decision, not the player.
- Frontal assault is occasionally correct (a close ambush, no flank available) — keep it as the *fallback when no
  covered flank exists*, not the default.

---

## Workstream 3 — Micro-terrain: let a soldier use a rock, a low wall, a berm

### Verified mechanism
- Cover/concealment are a **single averaged scalar per 5 m cell**: `COVER_CONCEAL` table (`lib/sim/terrain.ts:2614`)
  by landcover class; `coverAt(wx,wy)` (`:2480`) samples the one cell. A "Boulders" cell is a uniform 5×5 m blob of
  `cover 0.66`.
- The Land enum **already names the right micro-features** — `TerraceWall` (linear hard cover), `Boulders`, `DryWash`
  (dead ground), `CompoundWall` (`terrain.ts:12–39`) — but only at 5 m blob granularity, and `decoration.ts` rocks/trees
  are explicitly a **"Pure render overlay (no sim impact)"** (`lib/render/decoration.ts:13`): the *drawn* rock is
  **decoupled** from the cover field, so a soldier can't get behind *that* rock.
- A rock is ~0.5 m; a 5 m cell is **100× its footprint** — the cover objects that decide a firefight are sub-cell and
  average out.

### What reality says
- Cover (stops bullets) ≠ concealment (blocks sight); **"even the smallest depression or fold in the ground can give
  some cover"** (FM 21-75). The Korengal was won/lost on micro-terrain: terrace walls, sangars, rock outcrops, "the one
  wall that couldn't get hit," the L-shaped ambush sprung from the draws.
- **Serious-game precedent is unanimous: model discrete cover objects, not a cover raster.** Combat Mission uses 8 m
  action spots **plus** walls/foxholes as *objects* with **posture-dependent** cover (a low wall = partial standing,
  *full prone*). VBS uses placed "biotopes" + wall penetration. The elevation grid carries *form*; cover lives in a
  *separate object layer* with material/penetration.

### Definition of Done
1. A **discrete cover-object layer** (vector, not raster): each object = `{frontage m, height m, material→small-arms
   stop-prob, conceal value}`. Seed the valley with **boulders (0.5–1.5 m), low rock/terrace walls (h 0.5–1.2 m,
   len 3–15 m), qalat walls (h 2–2.5 m), sangars, berms/ditches, fighting positions.**
2. **Cover is posture-dependent** (Combat Mission calibration): a low wall/terrace riser = partial cover standing,
   **full cover prone**; rocky/scrub *ground* stays weak (~50% exposed); behind a boulder/wall ≈ foxhole-grade (≤20%
   exposed). Wire into the existing `stance`/`prone` behavior in `friendly.ts`.
3. **The combat AI snaps to the nearest cover object** on contact (Combat Mission's "smartly position along walls/
   ridgelines"). `seekCover`/`findCover` (`squad-combat.ts:285`, `friendly.ts:88`) query the object layer, not just the
   raster.
4. **Render the objects** so the player *sees* the man behind the rock — promote the decoration layer (or a tactical
   cover-object layer) from cosmetic to sim-backed at tactical zoom; the object the engine uses for cover IS the one
   drawn.

### Approach & seam (shared with WS4 — the two-tier terrain)
- Build the cover-object layer on the **fine tactical patch** (below). Generate objects deterministically from the
  existing landcover (a `Boulders`/`TerraceWall`/`CompoundWall` cell seeds N objects with a stable hash, mirroring
  `decoration.ts`'s deterministic scatter) so the same seed reproduces the same cover field (determinism contract).
- LOS/fire gate (`lib/sim/los.ts`, `civClear`/exposure in `combat.ts`) queries objects + dead-ground relief, not the
  5 m raster, for units inside an active patch.

### Verify
- `scripts/cover-probe.ts`: assert behind-object exposure ≈ ≤20%, open ≈ ≥80%, posture changes the number; assert the
  drawn object and the cover-query object are the same instance (no decoupling). Visual: a tactical-zoom screenshot
  showing men tucked behind walls/rocks (verify-in-the-real-app).

### Restraint / risk
- **Don't raster cover at 1 m over the whole 512² map** (25× memory, determinism budget). Objects are sparse vectors on
  a fine patch — far cheaper. Log this restraint.

---

## Workstream 4 — Elevation pathing: switchback up the mountain, don't ring the spur

### Verified mechanism (with hard numbers)
- The foot-movement cost is **isotropic**: `moveCostAt = clamp(landMult * clamp01(1 - slope*0.62), 0.1, 1)`
  (`lib/sim/terrain.ts:2586`). It reads only the cell's **slope magnitude** — *identical in every heading* — so a
  switchback only adds distance and never pays off.
- `slope > 1.25` (≈51°) is **hard-impassable** (`terrain.ts:2581`), and slope is a forward-difference over 5 m
  (`computeSlope` `:520`), so procedural roughness scatters `>1.25` cells across a climbable face, fragmenting it into
  **fake cliffs**.
- The planner's per-node cost is `1/avg-move-cost` plus a **road discount up to 62%** (`lib/sim/path.ts:355`
  `roadBias`), and "Establish OP" defaults to patrol movement → **`roadBias 0.55`** (`lib/sim/world/formation.ts:90`).
  Coarse grid is `COARSE_F=3` (15 m, 8-direction).
- **Empirical (this campaign's `gen-oproute.ts`, seed `korengal-2`):** OP 443 m crow-flight from the gate, route
  **3,060 m — a ×6.91 detour**, because **46%** of the straight-line ascent is "impassable" (mean slope **1.04**).
  Other seeds: `ridgeline` 58% blocked / ×1.45; `restrepo` 41% / ×1.23. **Road bias is nearly irrelevant** — the
  `roadBias 0.55` and `roadBias 0` routes are essentially identical, so the detour is driven by the **slope cutoff +
  isotropic cost**, not road preference.

### What reality says
- Walking speed/energy depends on the **signed grade *along the direction of travel*** (Naismith; **Tobler**
  `W = 6·e^(−3.5·|S+0.05|)`; Minetti). Cost is intrinsically **anisotropic**.
- **Isotropic per-cell cost mathematically cannot switchback** (a diagonal traverse "buys nothing"); **anisotropic cost
  makes the diagonal genuinely cheaper → switchbacks emerge above a ~25% critical slope** (Tobler). Mountain doctrine
  (ATTP 3-21.50): ascend by **diagonal traverse / switchback** on 15–45° slopes; **avoid the canalized road** (the
  predictable, observed approach — exactly where the Korengal ambushes were sprung).
- A coarse 15 m, 8-direction grid **also** can't represent switchback geometry (Crowe/NPS): the traverse angle falls
  between grid headings, so even with anisotropic cost a coarse grid snaps to straight-up-or-around.

### Definition of Done (numeric)
1. **A squad ordered to a peak OP switchbacks up the face** (visible zigzag legs tens of metres long), it does **not**
   ring the spur. On the `gen-oproute.ts` seed sweep, the detour ratio for reachable elevated OPs drops from
   **×6.91 (worst) toward ≈ ×1.2–1.6**, and the "% of direct ascent impassable" no longer forces a circumnavigation.
2. **Switchbacks appear only above ~25% grade**; below it the route stays near-direct (no pathological zigzag on gentle
   ground — guarded by a turn penalty).

### Approach & seam (one robust mechanism)
- **Replace the isotropic cost with a Tobler-based anisotropic step cost** keyed on the signed grade between the two
  cells of each move: `S = Δelev / horizontal_dist`, step-time `= len / (6·e^(−3.5·|S+0.05|))`, × off-trail 0.6,
  modulated by the existing landcover surface factor. This is the single change that makes switchbacks emerge.
  Seam: the `nodeCost`/step cost in `lib/sim/path.ts:309` (it currently averages an *isotropic* `clampMove`; make the
  step cost a function of the *from→to* grade, which means moving the slope term out of `moveCostAt` and into the
  A* edge evaluation).
- **Soften the foot impassability cutoff:** infantry climb steeper than 51°, slowly. Add a *climbable-but-very-slow*
  band (e.g. `1.25 < slope < ~1.7` passable at heavy cost) so a steep face has a through-line; reserve true
  impassability for genuine cliffs. Optionally **smooth the slope field** (or compute slope at the patch resolution)
  so 5 m roughness stops faking cliffs.
- **Finer + better-connected planning where it matters:** plan the *tactical* legs on the **~5 m or finer patch with
  ≥16-direction / any-angle (Theta\*)** connectivity so a shallow traverse is representable; keep the 15 m coarse pass
  for the global line only. Add a **turn penalty** so switchbacks are few-bend and realistic, not single-cell jitter.
- Keep the road's honest advantage (gentle grade + on-trail speed) — the planner will still *sometimes* take it; the
  point is it now *also* finds the switchback, and picks by true directional cost.

### Verify
- `gen-oproute.ts` (kept as `scripts/op-route-probe.ts`): detour ratio + impassable-% across the seed sweep, before/after.
  A trajectory render (`scripts/trajectory-png.ts` style) of an actual squad climbing — eyeball the zigzag.
  Prove on **held-out seeds** you didn't tune on (Law 3). Re-run movement harnesses (`reachability.ts`,
  `route-quality.ts`, `cohesion.ts`) — anisotropic cost must not regress cross-valley routing or reachability.

### Restraint / risk
- Anisotropic cost can produce **narrow zigzag**; the turn penalty is mandatory, not optional.
- This touches the most load-bearing, hard-won system in the repo (corridor-A\*, river-aware planner — the wins were
  *rebuilds*). **Metricize on HEAD first, change one thing at a time, re-measure each in isolation**, and keep every
  movement harness green. If anisotropic-cost-on-the-existing-grid thrashes (patched twice, metric flat), that's the
  signal to do the finer-patch/any-angle planner as a *rebuild*, not more patches (Law 8).

---

## Cross-cutting foundation — the two-tier terrain (enables WS3 + WS4)

- **Operational layer:** today's 5 m grid (post the in-flight scale campaign). Strategic map, cross-valley routing,
  village/COP siting. Unchanged.
- **Tactical patch:** a **~1 m relief + discrete cover-object + anisotropic-cost** patch instantiated *only around active
  units / active firefights*. Deterministic generation from the operational layer (stable-hash scatter, like
  `decoration.ts`) so the contract holds: **a seed reproduces the valley AND the cover field AND the routes.**
- This is the **simplest** architecture that lets a man hide behind a rock and a squad switchback a face without paying
  1 m resolution over 6.5 million cells. Build it once; WS3 and WS4 both consume it.

## Done-gate for the campaign
`tsc --noEmit` · `npm run build` · `npm run lint` · `smoke.ts` (SMOKE OK) · `balance.ts` (no stall) all green;
new persisted state in **both** `serialize()` + `loadWorld()`; before→after numbers in
`docs/progress/<date>/`; issues updated; and an **HTML report published into `public/manual/archive/`** with the
development-story chapter (per CLAUDE.md §4 ▶ Delivery). Prove every win on held-out seeds.

---

### Reproduction (this research)
- `docs/progress/2026-06-07-realism-research/tools/gen-oproute.ts <seed>` — OP-route detour render + metrics (item 4).
- `docs/progress/2026-06-07-realism-research/tools/gen-combat-movers.ts <seeds> <min>` — maneuver-vs-hold counts (item 2).
- `docs/progress/2026-06-07-realism-research/tools/svgrender.mjs <in.svg> <out.png>` — native-size SVG→PNG (diagrams).
- Seeds that show item 4 worst: `korengal-2` (×6.91), `ridgeline` (58% blocked), `restrepo` (41% blocked).
  `korengal` (default) barely shows it (gentle 223 m peak) — pick a steep objective to reproduce.
