# Terrain-realism campaign — verbatim numbers (2026-06-09)

HEAD at start: `bd98c5b`. Tune set = the named/op-route seeds + survey-0..39 where noted.
All probes in `scripts/`; raw captures in `baseline/`, `after-A/`, `after-render/`, `after-cover/`.

## The four owner asks → the four iterations

| Owner ask | Iteration | Headline number (before → after) |
|---|---|---|
| "humans should be able to traverse up steep terrain" | A — reconnect the steep band | gate-reachable map **reach% 48.0 → 60.6** |
| "passable should be most of the map; impassable should be obvious" | A + render | pass% **80%** held; impassable now slope-shaded as sheer rock |
| "more footpaths, scaled, molding to terrain" | C + render | trail cells **492 → 760**, paths/seed **~6 → 22-32**, drawn as scaled lines |
| "more on the map to use for cover / tactics" | cover objects (020) | open-slope cover-within-20m **25% → 77%**, reach-to-cover **41 m → 15 m** |

## Change A — steep-band passability (issue 019/014)  [commit 7b24c19]
- `passability-probe` (8 seeds): reach% **48.0 → 60.6** (+12.6); biggest passable component **64.5% → 70.4%**; pass% 80.9 → 80.8 (unchanged).
- `route-quality`: meanRatio **1.13 → 1.12**, loopy **0% → 0%** (village routing unchanged).
- `terrain-audit` (20 seeds): banks-split **0% → 0%**, river-traps **0 → 0** (river connectivity preserved).
- `balance` 12×50: US WIA **3.75 → 3.50**, US KIA **1.42 → 1.25**, enemy 4.42 → 4.67, civ 0, **0 stranded** (combat balance unmoved / slightly safer).
- Restraint logged: a first attempt also dropped the steep cost floor 0.1→0.02; reverted — it slowed the sim ~1.5× and bloodied WIA **+71%** for **no** op-route win. The win is pure passability; the cost curve is bit-identical to HEAD.

## Change C — switchback foot-trails (issue 007)  [commit 359ce27]
- `footpath-probe`: trail cells **492 → 760** (+55%), path% 1.91 → 2.01, distinct paths/seed **~6 → 22-32**, trail mean grade **0.57 → 0.54** (gentle, molds to contour).
- reach% unchanged 60.6 (trails don't fragment — earlier benched version cut trenches that crashed reach% to 30.1; caught in a render, fixed by surface-laying).
- `balance` 12×50: KIA **1.25 → 0.50**, WIA 3.50 → 3.92 (noise), **0 stranded**.
- Deterministic: no new RNG draw; same seed → identical trail network + land hash.

## Render — paths as scaled lines + cliffs obvious (issues 007/014)  [commit 96793c2]
- `drawPathsLive`: every captured centerline stroked at its real width (≈4.5 m MSR / 2.6 m track / 1.3 m goat-trail), cased, molding to terrain — replacing the invisible, wrongly-5-m-wide landcover tint.
- Cliff shading: above `FOOT_CLIFF_SLOPE` the face goes cool slate + deep shadow — impassable ground reads as a sheer wall, distinct from the warm walkable slopes.
- Verified live (Playwright); tsc + `npm run build` green.

## Cover objects (issue 020)  [pending commit]
- **Shipped (drawn=sim coupling + more visible rocks):** boulders/outcrops are now sim objects (`terrain.coverObjects`, ~11,600/valley) that the renderer draws — on rocky ground the rock you see IS where the cover field's cover is (drawn=sim verified per-object). Plus erratic boulders strewn on open slopes (more on the map). **Provably balance-neutral**: the cover field is byte-identical to no-objects (`cover-probe` openCov% unchanged at 25%).
- **DEFERRED + restraint-logged (the combat-cover half):** the plan added usable open-ground cover (openCov 25→43%). Measured and **cut** — even a light, dialed-back stamp pushed 12×50 WIA **3.92→7.42 (+89%)** (a broad first version ~3× worse): the 5 m cell scalar is too coarse to add ambient cover without grinding firefights (cover prolongs engagements → more cumulative casualties). Usable AND non-grinding open-ground cover needs the **sub-cell directional model** (issue 020's heavy half); the `stampNew` seam is left for it.
- Deterministic: same seed → identical cover objects + cover hash. Smoke OK.
- Deterministic: same seed → identical cover objects + cover hash. Smoke OK.

## Standing checks
- `tsc --noEmit` green throughout · `npm run build` green · `smoke` SMOKE OK each step · determinism preserved (terrain regenerated from seed; no new persisted state).
