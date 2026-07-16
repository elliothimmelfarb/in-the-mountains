# 011 — The deploy-time relief bake is the dominant load cost (~seconds) (✅ USER-FACING PROBLEM RESOLVED — active fix shipped; raw-speed remainder is a browser-gated nicety)

> **Ledger status (verified 2026-07-16 @ da10926):** RESOLVED (user-facing) — mechanism current: `bakeTerrainProgressive` staged loading (topo.ts:374). Remaining raw-bake speedup is a browser-gated perf nicety, deliberately deferred. Do-not: lower `pxPerCell` (topo.ts:133) — it degrades the shaded relief.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Resolution clarification (2026-06-10):** the actual user-facing defect — a multi-second *frozen black
box* at deploy — was RESOLVED by a SHIPPED active fix (`bakeTerrainProgressive`: 40 yielding row-bands
behind a staged loading screen with a smooth progress bar, result cached so the first frame is instant —
`docs/progress/2026-06-06-deploy-loading-screen/`). The deploy no longer freezes. What remains is not a
defect but a perf *nicety* (cut the raw bake CPU), which is browser-gated (no headless canvas to measure
or verify) and whose only headless shortcut (lower resolution) would degrade the relief — so it's
correctly deferred, NOT shipped as a fidelity regression.


**2026-06-10 closeout (re-confirmed + a principled NON-fix):** the obvious optimization — lowering
`pxPerCell` 8→6 (~44% fewer pixels) — **degrades the shaded relief**, undoing the exact terrain
legibility the 2026-06 realism work added (sheer-rock cliffs, scaled paths). Trading visual fidelity for
load speed is backwards on a fidelity-first project, so resolution-lowering is explicitly a **do-not**.
The cost is already COVERED by the staged loading screen + progressive bake (the player's actual ask —
feedback, not raw speed). The right fix is **fidelity-PRESERVING + GPU-measured**: a seed-keyed IndexedDB
cache (deterministic seed → deterministic sheet → re-deploy skips the bake, zero fidelity loss) or an
OffscreenCanvas worker — both need a real GPU browser to measure, not the software-canvas headless figure.
See `docs/progress/2026-06-10-open-issues/011-009-closeout/`.

---
_(original 2026-06-06 restraint-log below)_


**Severity: Low–Medium (perf/UX, not correctness).** Surfaced while adding the deploy **loading
screen** (`docs/progress/2026-06-06-deploy-loading-screen/`). The loading screen now *covers* this
cost with smooth, honest feedback — so it is no longer a frozen black box — but the cost itself is
real and deliberately left un-optimized. Logged here for a future measured perf pass.

## What's slow

`bakeTerrain` (`lib/render/topo.ts`) renders the whole valley to a **4096×4096 (16.7 M-pixel)**
offscreen relief bitmap, one pixel at a time (hillshade + landcover tint + per-class procedural
texture + snow + haze). It is by far the single heaviest operation in a deploy.

Measured (CDP harness, **headless `--disable-gpu` → software canvas**, seed `kunar-2011`):

| phase | cost |
|---|---:|
| `createTerrain` (512² heightmap) | ~319 ms |
| `createWorld` (units, villages, COP) | ~6 ms |
| **`bakeTerrain` (4096² relief)** | **~5,900 ms** |
| `loadSprites` (164 SVGs) | ~265 ms |

The bake resolution is `pxPerCell = clamp(round(4500 / size), 3, 8)` → **8 px/cell** on the 512 grid
→ a 4096² sheet. The comment at the constant explains the intent: more pixels keep the shaded relief
crisp deeper into zoom before the bitmap upscales.

> **Caveat on the number.** This is a headless software-canvas figure. A real GPU browser's per-pixel
> JS loop is the same CPU cost, but the canvas memory ops (`createImageData`/`putImageData`) are
> cheaper, so the wall-clock is likely lower — still seconds, not milliseconds. **Re-measure in a
> real GPU browser before optimizing.**

## Why it's not fixed now

The player's request was *feedback*, not *speed*, and feedback is delivered: the bake now runs
**progressively** (`bakeTerrainProgressive`, 40 yielding row-bands) on the loading screen with a
progress bar that fills smoothly through it, and the result is cached so the first deploy frame is
instant. Cutting the bake time is a **separate trade-off with visual consequences** and deserves its
own measured pass — not a speculative change bolted onto a UX fix.

## Suggested directions (for a future measured pass — confidence noted)

1. **Lower the native bake resolution** (e.g. 6 px/cell → 3072², ~44% fewer pixels) and lean harder
   on bilinear upscale + the live vector contours that already redraw crisp. *Risk: relief looks
   softer at extreme zoom. Medium confidence it's an acceptable trade.*
2. **Tile + bake lazily / off the critical path** — bake only the tiles near the camera at deploy,
   fill the rest in idle frames. *More code; high confidence on perf, medium on complexity.*
3. **Cache the baked sheet across sessions** (IndexedDB, keyed by seed) so a re-deploy of a known
   valley skips the bake entirely. *Deterministic seed → deterministic sheet makes this clean.*
4. **Offload to an `OffscreenCanvas` in a Worker** so the main thread never blocks at all. *Biggest
   win, biggest surface; the per-pixel loop is already pure and portable.*

## Reproduce

Time the deploy phases page-side via `window.__ITM.subscribe` while `newCampaign` runs (see the
recipe in `docs/progress/2026-06-06-deploy-loading-screen/report.md`). The `enter_relief →
enter_assets` gap is the bake.
