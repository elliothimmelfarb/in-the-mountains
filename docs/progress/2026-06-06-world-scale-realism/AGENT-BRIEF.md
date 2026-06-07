# Agent Change Brief — World-Map Scale Authenticity

> **Mission for the implementing agent.** Make the world map *true to life* in scale: a skeptical
> infantry veteran should look at the map and recognize the **proportions** of a real Korengal-era
> outpost, its villages, and the men. Work the fixes **in priority order**. Each item below gives:
> the **doctrinal/real-world basis**, the exact **`file:line` gap** on HEAD, **concrete parameter
> values**, the **integration seam**, and the **harness metric** that proves it. Re-measure with
> `scripts/scale-probe.mjs` after every change (baseline saved in `scale-measurements.json`).
>
> **Two buckets, deliberately separated:**
> - **Bucket 1 — REPRESENTATION (render-only, do these first).** The simulation's numbers are
>   mostly *correct*; the **renderer** lies about them. These are low-risk, high-impact, and fix
>   ~90% of the "feels wrong" the owner reported. **Touch only `lib/render/` and `components/world/`.**
> - **Bucket 2 — SIM SCALE (worldgen, do these second, with care).** Genuine model choices about
>   valley size, village structure, and standoff distances. Higher blast radius; each is a deliberate
>   realism-vs-playability call. **Touches `lib/sim/terrain.ts` + serialize/load + determinism.**
>
> **The North Star number:** at the default zoom (ppm 0.7) the game paints a soldier **≈21 m wide**
> on the ground — **36× too large** relative to the 170 m outpost, and big enough that a 9-man squad
> at correct 5.5 m spacing **fuses into one blob**. Reality: a soldier is 0.6 m. The clamp
> `figurePx = clamp(ppm·7, 15, 40)` never lets a man render smaller than **5 m** at any zoom.

---

## BUCKET 1 — REPRESENTATION FIXES (render only)

### R1 — Stop painting individual soldiers as 5–50 m giants  ★ highest impact
**Real-world basis.** A soldier occupies ~0.5–0.7 m top-down. On a map where the outpost is 170 m
and the valley 2.56 km, a single man is a *sub-pixel* feature at operational zoom — you do **not**
draw him 1:1, but you also must not draw him 36× too big. Tactical-map convention (NATO APP-6 /
MIL-STD-2525, and every serious operational wargame — Command Ops, Combat Mission's operational
view, Steel Beasts map view) is: **zoomed out → one small unit icon per element; zoomed in →
individual figures at near-true footprint.**

**The gap (HEAD).**
- `lib/render/draw.ts:19-21` — `figurePx(ppm) = Math.max(15, Math.min(40, ppm * 7))`.
  - Ground span = `figurePx/ppm`. At ppm 0.7 → **21.4 m**; the min-15 floor means a man is **never
    smaller than 5 m** even at max zoom (ppm 8 → 40 px → 5 m). Measured oversize: **8×–83×**.
- `lib/render/draw.ts:96` — `r = Math.max(4.5, Math.min(13, 0.95 * cam.ppm))` (NATO symbol radius).
  - At ppm 0.7 the symbol dot is 4.5 px = **12.9 m wide**; floor of 4.5 px never lets the dot shrink.
- `lib/render/draw.ts:17-18` — `FIG_FADE0 = 0.5`, `FIG_FADE1 = 0.9`. At the **default ppm 0.7 you are
  mid-crossfade**, so the renderer draws BOTH an oversized dot AND an oversized figure on each man.

**Fix (params).** Decouple icon size from a fixed pixel floor; let the figure track its *true
footprint* with only a modest legibility floor, and push the figure-LOD band to a zoom where a man
is actually legible at near-true size:
```
// draw.ts — track footprint, small legibility floor, hard cap
const SOLDIER_FOOTPRINT_M = 1.6;                 // generous shoulder-to-shoulder kit width
function figurePx(ppm: number): number {
  return Math.max(7, Math.min(26, ppm * SOLDIER_FOOTPRINT_M));  // 7px floor (legible), tracks 1.6 m
}
// NATO dot: smaller floor so a clustered garrison doesn't smear
const r = Math.max(3, Math.min(9, 0.7 * cam.ppm));             // draw.ts:96
// Push individual figures to genuinely tactical zoom; show the squad icon (R2) below it
const FIG_FADE0 = 2.5, FIG_FADE1 = 3.5;                        // draw.ts:17-18
```
At ppm 3.5 → figure = 5.6 px ≈ 1.6 m (true); at ppm 8 → 12.8 px ≈ 1.6 m. A man is now ~his real
size whenever you can see him individually, and below that he's part of a squad icon (R2).

**Integration seam.** `figurePx` is consumed at `draw.ts:193` (base ring), `:202` (sprite blit),
`:243` (label offset) — all flow from the one function, so changing it is sufficient. `drawUnit` is
called per-unit by the WorldView render loop (`components/world/WorldView.tsx`, the friendly/enemy
draw pass). No sim change.

**Verify.** `scripts/scale-probe.mjs` → projection table: `figureGroundM` must be **≤ 2.0 m for ppm ≥
3** and the `figVsTrue` column ≤ ~3×; `squadFiguresOverlap` must be **false** at ppm ≥ 4 (men resolve).

---

### R2 — At operational zoom, draw ONE icon per squad, not 35 stacked men  ★ highest impact
**Real-world basis.** On an operational map you track *units*, not individuals. A 9-man squad is one
symbol; a 35-man platoon at a COP is a handful of symbols, not 35 overlapping dots. This is the
single biggest cause of "the COP looks swarmed / soldiers dominate everything."

**The gap (HEAD).** `WorldView.tsx` loops `drawUnit` once per soldier with no aggregation; 35 men at
the muster (measured nearest-neighbour spacing **4.65 m**) become 35 clamped 12.9 m dots piled on a
170 m outpost. There is no squad-level glyph.

**Fix.** Below ppm ~2.5 (i.e. while `FIG_FADE0` says "don't draw figures"), replace per-man drawing
with **one NATO unit symbol per squad** placed at the squad centroid: a friendly rectangle with the
echelon tick (•=squad / ‖ doesn't apply — use the squad size dot) and a count badge (e.g. `1/A ×9`).
Crossfade to individual men above ppm 2.5 (reuse `lodAlpha`). Group `playerUnits()` by `squadId`
(soldier field is `squadId`, `lib/sim/entities.ts:152`), compute centroid, draw one symbol.

**Integration seam.** The unit render loops are `components/world/WorldView.tsx:345` (dead),
`:347` (civilians), `:370` (friendly US/ANA — each `drawUnit(ctx, cam, u, …)`). The codebase
**already has a low-zoom LOD instinct**: `WorldView.tsx:342` `inGarrison` *hides* COP-interior
units when `cam.ppm < 0.5`. Generalize that instinct: add `drawSquadIcon(ctx, cam, squad, centroid)`
in `draw.ts`; in the friendly pass, when `cam.ppm < FIG_FADE0`, group `playerUnits()` by `squadId`
and draw one icon per squad at the centroid *instead of* per-unit `drawUnit`; keep per-unit drawing
above the threshold. Selection/labels operate on the squad icon at low zoom.

**Verify.** New probe assertion: at ppm ≤ 2, count of distinct friendly glyphs drawn ≈ **#squads (≈5)**,
not 35. Visual: capture at ppm 0.7 — the COP shows a few unit symbols, not a swarm.

---

### R3 — Render villages as a CLUSTER of compounds, not one monolithic qalat
**Real-world basis.** *(quantified in the report from research — Korengal villages such as Aliabad/
Babiyal are clusters of dozens of stacked qalats spanning ~150–400 m, not a single compound.)*

**The gap (HEAD).** `WorldView.tsx:185-198` draws **one** sprite per village (`qalat-small/medium/
large`, `widthM` 24/36/50 m) at the village center. A whole village is a single 24–50 m building.
The sim already stamps a compound of radius `v.size` cells (20–30 m) in `terrain.ts` but the *render*
is monolithic.

**Fix (render-side first, cheap).** Scatter **N sub-compound sprites** around the village center,
N scaled by population (e.g. `Math.round(pop/25)`, clamp 3–18), deterministically placed on a
hashed jitter ring out to the village radius, varying small/medium qalat sprites + walls. This makes
a "village" read as a hamlet of buildings without any sim change. *(A deeper Bucket-2 version stamps
real multi-compound footprints into the terrain — see S-villages.)*

**Integration seam.** Replace the single `drawWorldSprite(qid …)` at `WorldView.tsx:198` with a
deterministic loop over `hashUnit01(v.id + i)`-placed sub-compounds. Determinism: derive all jitter
from `v.id` so it's stable across frames and reloads.

**Verify.** Visual at ppm 1.5 on a village: a recognizable hamlet (multiple compounds + walls) whose
extent matches the researched village span, not a lone box.

---

### R4 — Default the camera to a zoom that reads as terrain, and re-tune LOD bands
**Real-world basis.** The opening view should feel like standing off and reading the valley, with the
COP a *place* and men as *units* — not a zoomed-in diorama of giant figures.

**The gap (HEAD).** `WorldView.tsx:103` default `ppm = 0.7` lands you mid figure-crossfade (R1), the
worst zoom for scale legibility. Zoom limits `ppm ∈ [0.3, 8.0]` (`WorldView.tsx:676`).

**Fix.** Set the initial framing to fit the valley-of-interest (COP + nearest villages) at a ppm
where R2 squad icons are active (≈0.5–0.7 is fine *once R1/R2 land*; the bug is the rendering, not
the default per se). After R1–R3, re-audit every LOD fade threshold in `draw.ts`, `WorldView.tsx`,
`topo.ts`, `decoration.ts` so the **dot→squad-icon→figures** progression is monotonic and nothing
pops in oversized.

**Verify.** Capture A/B/C/D/E framings via `scale-probe.mjs` at ppm {0.3,0.7,1,2,4}; the dot→icon→
figure transitions must be smooth and every element near-true-scale at its reveal zoom.

---

## BUCKET 2 — SIM-SCALE FIXES (worldgen; do after Bucket 1)

> Real-world numbers below are from the cited research pass (`research-raw.txt`), confidence noted.
> **Determinism contract applies to everything here:** any new persisted worldgen state goes in BOTH
> `serialize()` AND `loadWorld()` (`lib/sim/world`), and a same-seed run must still reproduce
> bit-for-bit — verify with `npx tsx scripts/smoke.ts` (→ `SMOKE OK`) and re-run `scripts/balance.ts`.
> **Do these in the order S1 → S3 → S2 → S4** (cheapest/lowest-risk first). **Do NOT touch the
> already-authentic dimensions** (elevation 1,531–2,899 m / 1,368 m relief; ridge crests; engagement
> band 30–620 m; 9-man rifle squad; 5.5 m dispersion) — changing them makes the sim *less* true.

### S1 — Restore the 9-man weapons squad (platoon 35 → ~41)  ★ cheapest real-scale win
**Real basis.** FM/ATP 3-21.8: a rifle platoon = HQ + three 9-man rifle squads + **one 9-man weapons
squad** = 39 organic, ~42 with habitual attachments (medic/FO/FS-RTO). Confidence 0.9.
**Gap (HEAD).** `lib/sim/entities.ts:420-427` — weapons squad = 2 machinegunners + 1 marksman = **3**.
The HQ (5) and rifle squads (9 each) are already correct; the entire 35-vs-39/42 shortfall is here.
**Fix.** Build a 9-man weapons squad: 2× M240 gun teams (gunner + assistant gunner = 4) + 2× ammo
bearers + 2× anti-armor/Javelin (or keep 1 marksman + 1 AT) + 1 weapons-squad leader → 9. Platoon
totals ~41 (5 + 27 + 9), inside the 39–42 band.
**Seam.** `entities.ts:420-427` roster build; lean on the exhaustive `Record<Role,…>` tables so the
compiler flags every place a new role must be handled. **Determinism note:** the roster is built from
seeded `rng` draws — adding members shifts subsequent draws, so soldier *names/stats* change for a
given seed (terrain is seeded separately and is unaffected). That is intended; just re-baseline.
**Verify.** `playerUnits().length === 41`; weapons squad memberIds length === 9; `smoke.ts` round-trips;
`balance.ts` casualty/stall check still sane with the extra crew-served weapons.

### S3 — Make the playable floor a narrow slot + fix the inverted gradient  ★ low risk
**Real basis.** Korengal floor is ~0.5–1.0 km wide inside a ~9.7 km valley (a ~10:1 slot, conf 0.85);
the river drains **north** into the Pech (low end north, high end south, conf 0.6). The model is a
2.56 km **square** that rises south→north.
**Gap (HEAD).** Floodplain bench is ~45 cells ≈ 225 m each side of the river (≈450 m floor) — already
near-real; but the *square* map reads as a wide bowl, and `terrain.ts:121-122` `floorSouth:1550 /
floorNorth:2000` puts the low end in the **south** (inverted).
**Fix (cheap, honest).** (a) Keep the 2.56 km square but DOCUMENT it as one ~2.56 km *segment* of the
valley; tighten the passable corridor so the *fightable* floor is ~0.5–1.0 km wide with steep walls
filling the rest of the square (so it reads as a slot, not a bowl). (b) Swap `floorSouth`/`floorNorth`
(or relabel the axis) so the floor drains north. Defer the bigger non-square regrid (e.g. 1024×384 =
5.12×1.92 km) as a separate effort — it's a large worldgen + perf + determinism change.
**Seam.** `terrain.ts` `DEFAULT_TERRAIN` (`:117-124`) + the floodplain/centerline generation.
**Verify.** Reachability flood width of the navigable floor ≈ 0.5–1.0 km; gradient drains north;
`smoke.ts` green; `reachability.ts` unchanged-or-better.

### S2 — Reshape the COP: terrain-conforming, shorter wall (not a 170 m circle)  ★ higher risk
**Real basis.** A small Korengal OP was a **~30-HESCO fishhook, ~70–100 m of wall, a ~50–100 m
position conforming to the terrace** (Junger); the KOP "stretched several hundred yards up a
hillside" — linear/irregular. Wanat's VPB Kahler was 300×100 m. The model's footprint *scale*
(~250 m) is right; its **clean 170 m circle (~220 m of wall / ~90 HESCOs) has ~2.6× too much wall**
and the wrong geometry. Confidence 0.7–0.8.
**Gap (HEAD).** `terrain.ts:744` `buildCop` — `R = clamp(round(85/cellSize), 12, 20)` → a circular
85 m-radius perimeter; the wall is a full ring (`terrain.ts:819-823`); interior layout, gate,
fighting positions, ring-road and network connectivity are all keyed off the circular `R`.
**Fix.** Cheapest first: shrink `R` toward the low clamp (≈12 cells / 60 m) for a platoon OP so wall
extent drops to ~120 m position / ~75–110 m of wall — close to real. Bigger/optional: replace the
circular perimeter with an irregular polygon/fishhook hugging the bench contour. **This is the
highest-risk item** — the whole COP build + pathfinding + `cop-render.ts` pocket checks depend on the
perimeter; change it behind the existing `buildCop` pipeline and re-verify hard.
**Seam.** `terrain.ts:744` (`R` derivation) and `:819-823` (wall band); keep `buildCop` interior
stamping + `ensureNetworkConnectivity` intact.
**Verify.** `npx tsx scripts/cop-render.ts <seed>` shows **no new sealed interior pockets**; wall
perimeter ≈ 75–150 m; `copstuck.ts`/`copaudit.ts` clean; `smoke.ts` + `balance.ts` green;
reachability to villages preserved.

### S4 — Villages as real multi-compound hamlets (sim depth; pairs with render R3)  ★ medium risk
**Real basis.** A village is a **cluster of ~80–100 stacked houses, ~650–830 people, spanning
~150–400 m** — not one compound (conf 0.75). A single family qalat at 20–60 m/side is fine; the error
is one compound standing in for the whole settlement.
**Gap (HEAD).** `terrain.ts:627-660` stamps a **single** compound (radius `v.size` = 20–30 m) per
village; the renderer (`WorldView.tsx:198`) draws one qalat. R3 fixes the render; S4 fixes the sim.
**Fix.** Stamp **N sub-compounds** per village (`N ≈ clamp(round(pop/25), 3, 18)`) on terraced benches
within a ~150–400 m village extent, each a small qalat footprint + walls + orchard, all placed from a
deterministic `v.id` hash. Affects cover/LOS/pathing (more walls) — must NOT wall the village off from
the network.
**Seam.** `terrain.ts:627-660` village stamping; reuse the existing compound/wall/orchard stamps in a
hashed loop. New persisted layout (if any) → `serialize()`/`loadWorld()`.
**Verify.** Village extent ~150–400 m; sub-compound count scales with population; `reachability.ts` /
`terrain-audit.ts` confirm every village stays connected to the COP/MSR network; `smoke.ts` green.

---

## DONE-GATE for this work
- `npx tsc --noEmit` · `npm run build` · `npm run lint` green.
- `npx tsx scripts/smoke.ts` → `SMOKE OK` (determinism + no-NaN), and `scripts/balance.ts` stall-check clean.
- `node scripts/scale-probe.mjs` re-run; projection table meets the R1/R2 thresholds above; before/after framings captured.
- Determinism: same seed reproduces the valley AND outcomes (Bucket 2 only).
- Docs: update the README status table + the relevant `docs/wiki/` page; append a Resolution section with before→after numbers to the issue this brief is tracked under.
