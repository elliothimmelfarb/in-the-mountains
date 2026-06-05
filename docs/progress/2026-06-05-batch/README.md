# Batch — 2026-06-05 (8-item overhaul)

A batch of eight improvements, each driven by hard numbers (headless harnesses) and/or
live Playwright verification. Per CLAUDE.md: reproduce as a metric, baseline, change,
re-measure.

## The eight items
1. **Village can intersect the COP** — generation must make this impossible.
2. **Squad pathfinding around the COP perimeter** — a squad sent to a far waypoint went
   out the gate, came back in, and got stuck. It should round the wire cleanly.
3. **TIC drops time compression to 1× (one-way)** — stop the bumpy clamp-and-restore.
4. **UI: cramped right bar, empty bottom bar** — expert redesign + iteration.
5. **Combat log above the command log; collapsible + draggable left panels.**
6. **No blur when zoomed — full LOD / more detail** (contour lines especially).
7. **Scale audit (1:1 realism)** — review all scaling; audit terrain generation; implement
   high-impact realism improvements carefully.
8. **Remove village→water troughs; add a real tiered road/path network** that interacts
   with terrain, connects villages, and affects villager + soldier movement.

## Baselines captured (before any change) — `baseline/`
- **copaudit (24 seeds)**: village/COP footprint OVERLAP **2/24**; village-core cells inside
  COP clearance **6/24 (25%)**; gate portal disconnected **5/24** (issue 005 regressing).
- **reachability (12 seeds)**: villages reached **16/61 (26%)** — patrols barely leave the
  COP (closest-approach misses 500–1472 m). The headline sim problem.
- **movement-diag (7 seeds)**: 3/7 fail to arrive; survey-9 STUCK@22 m; korengal 499 wall-bump
  ticks. Reproduces item 2 directly.
- **route-quality (49 routes)**: raw `findPath` mostly healthy (mean ratio 1.26, 6% loopy) —
  so item 2 is a **movement-execution** problem, not an A* problem.

## Status
- [x] **Item 3 — TIC one-way latch.** `state/store.ts` `frame()` now rising-edge latches
  `speed:1, warp:false` the instant `inContact` goes false→true, and never auto-restores the
  pre-contact speed. Live-verified via the store: 16×→contact→1×; player may re-raise; contact
  end keeps the player's speed; a second contact re-drops to 1×.
- [x] **Item 6 — zoom LOD / no blur.** `lib/render/topo.ts`: contours are no longer baked into
  the relief bitmap — `drawContoursLive` redraws them every frame as crisp **vectors** in screen
  space over the visible cell window, zoom-adaptive interval (10–200 m), grid-downsampled to bound
  cost. Relief bake density 6→8 px/cell; ground detail overlay strengthened; min zoom 0.18→0.3 for
  strategic legibility (`WorldView.tsx`). Verified at ppm 0.35 / 1.5 / 6 / 8 (`item6-lod/`).
- [x] **Items 4+5 — UI overhaul.** `DeployScreen.tsx` + `store.ts` + `globals.css`: a reusable
  `DockPanel` primitive (collapsible header + bottom-edge drag handle); LEFT column = 5 dock panels
  with Intel as the elastic sink (Active Elements, Directives, Intel, **Combat Log**, **Command Log**);
  RIGHT column decluttered + widened 336→344 (Squad Orders / Task Org sink / Logistics module);
  bottom **Ops Strip** spans full width with a live **Contact Feed** in the formerly-empty half;
  Combat/Command logs split by `kind` with color coding; layout persists to `itm-ui-v1`, never the
  campaign save. Live-verified: collapse, drag-resize, reload-persistence, save-isolation, the
  log split + Contact-Feed mirror, and a functionality regression pass (resupply no-toggle, mission,
  SOP, jacket). Screenshots in `item45-ui/`.
- [x] **Item 1 — village can intersect COP.** `terrain.ts placeVillagesAndCOP` now applies a HARD
  footprint-separation constraint (wire radius R0 + 8-cell clearance vs each compound radius), with a
  max-gap fallback so siting never fails. Result: footprint OVERLAP **2/24 → 0/24**, village-core
  cells in COP clearance **6/24 → 0/24** (`copaudit.ts` gained `vilGap`/`vil∩` metrics).
- [x] **Item 2 — squad pathfinding/movement.** Root-caused via instrumentation (`movement-diagnosis.md`):
  the "out the gate, loop, back in stuck" was `findPath`'s unreachable-goal fallback returning a
  valley-circling, partly-unwalkable route (and a degenerate `coarse===null` straight-line into a
  cliff). Replaced both with a **bounded-box best-effort** that advances to the genuinely nearest
  reachable cell on an optimal, walkable, non-looping path; raised the pace-governor floor 0.2×→0.6×.
  Result: route-quality **mean ratio 1.26→1.01, loopy 6%→2%**; the user's far-side-of-gate scenario
  rounds the perimeter cleanly (**0/9 loopy**); portal disconnect **5→2/24**. Aggregate village
  reachability 26%→30% (the residual is genuine cliff-pockets — an honest terrain-gen ceiling — and
  failures are now graceful advance-and-hold, not loops).
- [x] **Item 7 — scale/realism.** Audit complete (`scale-audit-report.md`). Render constants landed with
  item 6. **Weapon `maxRange` capped to the 3.7km map diagonal** (M2/M107/Javelin/81mm/120mm/DShK/82mm
  were 4.0–7.2km — firing off-world; balance-neutral on a 2.56km map). Verified the generated peaks are
  ALREADY realistic (Sawtalo Sar 2737m ≈ real ~2700m), so the audit's risky `ridgeHeight`/profile
  reshape was correctly NOT applied — it would over-inflate peaks and worsen the cliff-pocket movement
  problem. The map is an honest ~2.56km Korengal engagement sector.
- [x] **Item 8 — roads/paths network.** Added a 4th `Land.Track` tier (graded secondary road):
  **Road 1.0 > Track 0.96 > Trail 0.92 > Footbridge 0.85**. New `layPath` (no-trench, conforms to
  local ground) + a `findPath`-routed network: every village tied to the valley MSR + a village MST,
  with a feathered graded-Track descent fallback for cliff-isolated villages. The old village→water
  Trail troughs are gone (replaced by realistic graded Tracks — visually verified, `item8-spur-crop.png`).
  Soldiers on Fast prefer the network (`path.ts` road-cell test + roadBias); villagers travel
  village↔village along it (`buildRoutine` inter-village waypoints + `civMoveTo` road bias). Network
  connectivity 36%→59%; `network-probe.ts` added. (Broke a terrain↔path module cycle by making
  `path.ts`'s `COARSE_F` use lazy.)

## Method notes
- The whole sim track (terrain shape, village/COP, roads, movement) is serialized as a single
  writer on `lib/sim/terrain.ts` and re-baselined after each change, so every metric delta is
  attributable to one change (per CLAUDE.md).
- Scale audit verdict: **do not resize the map** (`size`/`cellSize` cascade into valley width,
  village spacing, and bake density, and invalidate saves/baselines). The 2.56 km map is a
  realistic ~1/4-valley engagement sector; realism wins are per-constant.
