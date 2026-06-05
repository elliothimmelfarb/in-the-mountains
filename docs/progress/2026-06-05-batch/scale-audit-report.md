# Scale & Realism Audit — synthesis

This is the load-bearing discovery that changes the recommendation. Building hw/hh are **fixed cell counts** (2,2 / 3,1 etc.), so doubling `size` leaves them at the same meters — good. But many *placement* constants are **size-relative fractions** (`size * 0.16` meander, `size * 0.13` village spacing, `size * 0.18` river-flat width, `place()` offsets that are fractions of R). 

This means: doubling `size` to 1024 would **double the meander amplitude, village spacing, and valley-floor flat width in meters** — making the valley floor ~460 m wide instead of ~230 m, and spreading villages 2x farther apart. The cross-valley *width* would double to 5.12 km. That contradicts the geometry audit's own finding that valley width is already realistic at 2.56 km and floor should stay 100-300 m.

So the clean lever is **non-square terrain** (lengthen the valley axis only) — but the code uses a single `size` for both axes. The pragmatic, low-risk path that keeps the whole chain consistent is the audit's **Option B**: keep the 2.56 km map, cap weapon maxRanges to the map, and treat it as a focused engagement sector. Also `topo.ts:119` divides `3000/size` — doubling size halves pxPerCell to 3, degrading the bake. I have enough to write the report with these cascades fully traced.

I've verified every line reference, the meter-vs-cell derivation chain, the size-relative placement fractions, and the harness assertions. Here is the report.

---

# SCALE & REALISM Audit — Synthesis & Engineering Plan
*Korengal-valley infantry wargame · lead-designer synthesis of five dimension audits · verified against source 2026-06-05*

## 1. Executive verdict

**The world is NOT 1:1 realistic, but it is far closer than the headline numbers suggest — and the single biggest "problem" is a trap.**

The largest raw discrepancy is map length: the map is **~4x too short** to contain the real Korengal valley (2.56 km simulated vs ~10 km real; ~2x short even against the conservative 5 km "outpost sector"). Two audits flag this as `high/high`.

But the decisive engineering finding is that **you cannot fix it by making `size` bigger.** The terrain generator scales meander amplitude, village spacing, valley-floor flat width, and COP siting as **fractions of `size`** (`terrain.ts:208,417,341,494`). Doubling `size` 512→1024 doesn't lengthen the valley — it **inflates the cross-valley width to 5.12 km and the river-floor flats to ~460 m**, breaking the one geometry the audit confirmed is *already realistic* (valley width 2.56 km, floor 100-300 m). It also halves the relief bake resolution (`topo.ts:119`, `3000/size`).

The honest verdict: **the map is correctly scaled in cross-section (width, slope avg, cell resolution, COP, buildings, vehicles, soldiers all verified realistic) but truncated along its length, and several engagement/relief constants are mis-tuned independent of map size.** The real wins are the per-constant fixes (cross-valley profile shape, ridge relief, weapon effective ranges, 5.56 lethality knee), not a map resize.

**Single biggest number to state honestly:** *The map represents a ~2.56 km focused engagement sector of a ~10 km valley — roughly 1/4 of the real AO — and that is acceptable IF weapon maxRanges (currently up to 7200 m, 2x the 3.62 km map diagonal) are capped to the map so they stop reaching off-world.*

## 2. The scale chain — one coherent target

The chain is: **map extent → weapon maxRange → engagement distance → movement time-to-contact.** Today it is internally **inconsistent**: weapons reach 7200 m on a 3.62 km-diagonal map.

**Reconciliation — keep the 2.56 km map (do NOT resize), and make the chain consistent by capping reach to the map.** This is the audit's "Option B" and it is the only low-risk option, because of how the code derives the world:

- Everything works in **meters** via `worldSize = size * cellSize` (`terrain.ts:169`); harness scripts read `terrain.size`/`worldSize`/`cop.radius` **dynamically** (`smoke.ts:12,27,82`), never hardcoding 512 or 2560. So map dimensions are not a baseline — but the **emergent stuck%/egress/ballistics-by-range** metrics ARE.
- **`size` is the wrong lever** (cascades into width/spacing/floor/relief-bake as shown above).
- **`cellSize` is also the wrong lever**: COP radius `clamp(round(85/cellSize),12,20)` and every `X_meters/cellSize` feature would *shrink in real meters* (and clamp), silently shrinking the firebase and buildings.

**Coherent realistic target for the 2.56 km sector:**

| Layer | Target | Why consistent |
|---|---|---|
| Map diagonal | 3.62 km (unchanged) | width is realistic; length is a documented sector |
| Max weapon reach | ≤ 3.7 km (cap mortars/HMG to map diagonal) | nothing fires off-world; M2/mortars still cover 100% of AO |
| Typical engagement | 300-900 m (M4 350m eff, M240 1100m, M2 1830m) | matches real Korengal firefight bands |
| Time-to-contact | 32 min road / 40-64 min cross-country over 2.56 km | already verified realistic (kinematics audit) |

**Constants that must change in lockstep (capping reach to map):**
- `weapons.ts:152` 120mm maxRange 7200→**3700** (covers full map + buffer)
- `weapons.ts:145` 81mm maxRange 5600→**3700**
- `weapons.ts:79` M2 maxRange 6800→**3700**; `weapons.ts:111` M107 6800→**3700**
- `weapons.ts:73` M240 maxRange 3725→keep (already ~map diagonal)
- `weapons.ts:55/61/67` M4/M16/M249 maxRange 3600→**3700** is fine (already ~map-bounded; the real fix is *effRange*, below)
- Mortar **effRange** (60mm 3500 / 82mm 4000) already exceed map → cap to 3700 too, OR leave (they're indirect, terrain-masked; lower priority).

**What MUST NOT change (would break determinism / harness baselines / saves):**
- `terrain.ts:113 cellSize=5` and `:112 size=512` — changing either shifts the cell grid → every seeded `rng.int(size*…)` placement moves → **every saved game and every harness baseline (stuck%, egress, COP survey) invalidated.**
- `store.ts:103 SIM_DT=0.1` — the kinematics audit verified 10 Hz; changing it re-times every accrual.
- `terrain.ts:1395` slope coeff `0.62` and `terrain.ts:1385` passability `1.25` — verified realistic; touching them shifts route costs → `route-quality.ts`/`reachability.ts` baselines.
- Combat **range gates** (`combat.ts:740,744,1079`) — logic is correct; only the *data* (maxRange values) should move.

## 3. Ranked changes (high-impact first, then low-risk first)

| # | Change | Current | Recommended | Impact | Risk | File:line | Cascades |
|---|---|---|---|---|---|---|---|
| 1 | Cross-valley profile exponent | `pow(ndx,0.78)` | `pow(ndx,0.52)` | high | high | `terrain.ts:240` | Re-shapes whole map → moves cliff/road/village cells → **invalidates COP siting, reachability, route-quality baselines.** Re-bake relief. |
| 2 | Ridge relief height | `780` | `1100` | high | med | `terrain.ts:117` | Peaks→~2870 m (real Sawtalo Sar). Steeper upper slopes → more cliffs; LOS masks change. Re-bake; re-run COP survey. |
| 3 | M4 effective range | `effRange:500` | `350` | high | med | `weapons.ts:55` | Dispersion grows past 350 m (`ballistics.ts:74`) → M4 hit% at 400-500m drops; shifts `realism-probe.ts` ballistics band (expected, that's the point). |
| 4 | 5.56 lethality knee | `[400,0.62],[500,0.52]…` | `[200,0.75],[300,0.48],[400,0.38],[500,0.28],[700,0.18],[1000,0.10]` | high | med | `ballistics.ts:94` | Lowers 5.56 terminal dmg past 200 m → restores 7.62 incentive. Shifts `realism-probe` kill% band (intended). |
| 5 | Cap 120mm maxRange | `7200` | `3700` | high | low | `weapons.ts:152` | None — pure data cap ≤ map diagonal. Covers full AO. |
| 6 | Cap M2 maxRange | `6800` | `3700` | med | low | `weapons.ts:79` | None — data cap. M2 still reaches >80% of AO. |
| 7 | Cap M107 maxRange | `6800` | `3700` | med | low | `weapons.ts:111` | None — data cap. |
| 8 | Cap 81mm maxRange | `5600` | `3700` | med | low | `weapons.ts:145` | None — data cap. |
| 9 | M249 effective range | `effRange:800` | `650` | med | low | `weapons.ts:67` | Volume-fire role; mild hit% drop past 650 m. |
| 10 | Rush/sprint speed | `4.2` | `3.2` | med | med | `combat.ts:127` | Re-times assault bounds → may shift `movement-diag`/`egress` timing baselines. |
| 11 | Fatigue base coeff | `0.0012` | `0.0018` | med | low | `combat.ts:671` | Multi-hour patrols fatigue faster; check `movement-diag` long-haul. |
| 12 | Valley-road slope gate | `<0.6` | `<0.18` | med | low | `terrain.ts:1222` | Shrinks road extent → **may strand COP gate/egress.** Re-run `smoke.ts`/`egress.ts` before commit. |
| 13 | Concealed speed | `0.85` | `0.65` | med | low | `combat.ts:123` | Slower recon pace; minor timing shift. |
| 14 | River incision width | `2.4*(20/cs)` | `1.6*(20/cs)` | low | low | `terrain.ts:263` | Narrower river → fewer river cells; tiny path effect. |
| 15 | COP building half-extents | `hw/hh` 2-3 | scale ~×0.5 | high(flag)/low(real) | high | `terrain.ts:678-685` | Re-tiles the COP yard jigsaw → **breaks COP layout & `copaudit`/`copsurvey` baselines.** Defer. |
| 16 | HESCO wall thickness | `d<R-2.4` | `d<R-1.4` | med | med | `terrain.ts:616` | Thinner wall → must re-verify perimeter still seals (`smoke.ts:27`). Defer. |
| 17 | Contour interval | `40 m` | `20 m`, index every 10 | med | low | `topo.ts:304` | Render-only; denser contours. |
| 18 | Min-zoom ppm clamp | `0.18` | `0.32` | high(legibility)/low | low | `WorldView.tsx:673` | Render-only; strategic view more legible. |
| 19 | Relief bake density | `3000/size` | `4500/size` (clamp 2-10) | med | med | `topo.ts:119` | Bigger first-load canvas/memory; crisper high-zoom. |
| 20 | Detail-overlay fade window | `(ppm-0.9)/1.5` | `(ppm-0.6)/2.2` | med | low | `topo.ts:384` | Render-only; masks zoom blur. Verify visually. |
| 21 | Fitness modifier spread | `0.55+0.45×fit` | `0.45+0.55×fit` | low | med | `combat.ts:623` | Widens fit/unfit speed spread → shifts every movement baseline. Low payoff; defer. |
| 22 | Map length (size or non-square) | `512` | requires non-square refactor | high | high | `terrain.ts:112` | **Do not do as a constant bump** — see §2/§5. |

## 4. Do-first set (highest impact, lowest risk — implement now)

These are **pure data caps and render constants** with no determinism/harness cascade, plus the two render-legibility wins. They make the scale *chain* consistent and the map readable without touching the seeded terrain grid.

```ts
// 1. lib/sim/weapons.ts:152 — cap 120mm to map diagonal (was off-world 7200 m)
maxRange: 3700,
// 2. lib/sim/weapons.ts:79 — M2 .50 cap (was 6800)
maxRange: 3700,
// 3. lib/sim/weapons.ts:111 — M107 cap (was 6800)
maxRange: 3700,
// 4. lib/sim/weapons.ts:145 — 81mm cap (was 5600)
maxRange: 3700,
```
```ts
// 5. components/world/WorldView.tsx:673 — strategic-zoom legibility (5.56 m/px → 3.1 m/px)
camRef.current.ppm = Math.max(0.32, Math.min(8, camRef.current.ppm * factor));
```
```ts
// 6. lib/render/topo.ts:304 — 20 m contour interval, index every 10th (200 m bold)
const interval = 20;
const isIndex = Math.round(level / interval) % 10 === 0;
```

After these six: `npx tsc --noEmit && npm run build`, then `scripts/smoke.ts` (confirm egress still OK) and `scripts/balance.ts` (confirm stuck%/casualty bands unchanged — they should be, since no terrain or movement constant moved). The four maxRange caps cannot change emergent combat on a 2.56 km map (nothing was ever >3.62 km away), so balance is provably untouched; they only stop off-world reach and document the sector model.

## 5. Defer / avoid

- **Map resize via `size` 512→1024 (`terrain.ts:112`) — AVOID.** Verified: `size` drives meander (`:208 size*0.16`), village spacing (`:417 size*0.13`), river-flat width (`:341 size*0.18`), and COP siting (`:491-494`) as fractions. Doubling `size` doubles cross-valley width to 5.12 km and floor flats to ~460 m — **breaking the one geometry the audit confirmed realistic** — and halves the relief bake (`topo.ts:119`). A real length-only fix needs a **non-square `sizeX`/`sizeY` refactor** (separate engineering task), not a constant bump. Until then, document the map as a 2.56 km sector.
- **`cellSize` change (`terrain.ts:113`) — AVOID.** COP radius `clamp(85/cellSize,…)` and every `meters/cellSize` feature shrink in real meters and clamp. Shifts the cell grid → invalidates **all saves and all harness baselines.**
- **Cross-valley profile `0.78→0.52` + ridge `780→1100` (#1,#2) — HIGH-VALUE BUT DEFER to a dedicated terrain pass.** These are the *right* realism fixes (the V is too steep, relief too low), but they re-shape the entire map: cliff/road/village/COP cells all move, the relief must be re-baked, and `copsurvey`/`reachability`/`route-quality` baselines must be re-captured. Do them together, in isolation, with before/after metrics per CLAUDE.md — not mixed into the do-first batch.
- **COP building / HESCO resize (#15,#16) — DEFER.** The `place()` offsets are a hand-tuned yard jigsaw fractioned off `R`; shrinking hw/hh re-tiles it and can un-seal the wire (`smoke.ts:27`) or block the gate. Re-derive the layout deliberately; don't bump constants blind.
- **Fitness spread `0.45×→0.55×` (#21) — AVOID for now.** Low realism payoff, but it re-times *every* unit's speed → shifts every movement/egress/balance baseline. Not worth the baseline churn.
- **Rush speed `4.2→3.2` and fatigue `0.0012→0.0018` (#10,#11) — STAGE SEPARATELY.** Legitimate fixes, but they move movement-timing baselines; capture `movement-diag.ts`/`egress.ts` before/after so the change is attributable.

**Bottom line:** ship the 6 do-first edits now (consistent, provably balance-neutral, no re-bake). Schedule the terrain-shape pass (#1,#2 + re-bake + baseline recapture) as the next focused work item. Treat the map *length* as a non-square refactor, not a tuning knob — and in the meantime, the 2.56 km map is honestly a realistic ~1/4-valley engagement sector, not a broken map.

**Verified source locations (all audit line refs confirmed accurate):** `terrain.ts:112-118,240,263,488,616,678-685,1222,1385`; `combat.ts:123-127,623,671,740,744`; `weapons.ts:55,67,73,79,111,145,152`; `ballistics.ts:74,94`; `topo.ts:119,304,384`; `WorldView.tsx:673`. Harness baselines that gate the deferred work: `scripts/{smoke,balance,realism-probe,egress,copsurvey,reachability,route-quality,movement-diag}.ts`.