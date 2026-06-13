# 2026-06-13 — Trail / road / switchback render cleanup

Owner report: "the paths and switchbacks simply don't look realistic and in some cases are two or
more lines that squigalize over each other." Full mechanism + numbers in
`docs/issues/029-switchback-trails-render-as-squiggle-tangle.md`.

## Screenshots

- `before-wide-tactical.png` — true baseline (no fixes), 1.2 ppm at the COP. The village trail fans
  and the spur-climbing trails read as doubled/overlapping lines.
- `after-wide-tactical.png` — same camera, after the generation + render fixes. Clean single dirt
  tracks; the MSR is one graded road; switchback fans are legible.
- `after-clean-switchback.png` — 7 ppm on a real climbing switchback (trail[22], an 84-pt, 385 m
  climb to a shoulder). Reads as clean hairpin zig-zags following the terrain.
- `after-knot-zoom.png` — the worst village trail-fan knot, after all fixes (compare against the
  baseline tangle visible in `before-wide-tactical.png`'s top-right and the village fans).

## What changed

1. `lib/sim/terrain.ts` — `ascendTrail` / `lateralTrail`: visited-cell guard, dropped the downhill
   recovery candidate, tightened the stall break (36→12), and a net-climb gate so a shuffle-in-place
   lays nothing. **Pure cosmetic — trails are conform-0 landcover, so the passable graph is
   bit-identical; smoke (serialize round-trip + no-NaN) and reachability confirm determinism.**
2. `lib/render/topo.ts` — `drawPathsLive`: `cleanPath()` de-stack + collinear prune (cached per
   polyline), and a per-kind world-cell occupancy merge so a braided trail stem strokes once.

## Verification

`tsc` clean · `eslint` no new errors · `smoke.ts` SMOKE OK · `npm run build` green ·
`reachability.ts` unregressed (no village stranded). Probe: trail polylines with ≥25% self-overlap
**10 → 0** across three seeds; median switchback leg-to-leg distance **0.0 m → eliminated**.
