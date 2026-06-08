# 020 — Micro-terrain: a soldier can't use a rock, a low wall, a berm

**Status: 🟡 DIAGNOSED + scoped. Deferred to the two-tier-terrain tactical patch (shares the WS4 rebuild,
`docs/issues/019`).** This is WS3 of the soldier-scale realism plan
(`docs/progress/2026-06-07-realism-research/PLAN-soldier-scale-realism.md`).

## Symptom
At soldier-scale zoom the player can't see a man take cover behind the rock/low wall he's standing next to.
Cover is a single averaged scalar per 5 m cell (`COVER_CONCEAL` in `terrain.ts`, sampled by `coverAt`), and
the *drawn* rocks/trees are a "pure render overlay (no sim impact)" (`lib/render/decoration.ts`) — decoupled
from the cover field, so a soldier can't get behind *that* rock. A rock is ~0.5 m; a 5 m cell is 100× its
footprint, so the cover objects that decide a firefight average out.

## Evidence it bites NOW (from WS2)
The autonomous-flank work (issue: squad maneuver, shipped) found a covered flank only **3–7%** of the time on
the coarse 5 m cover raster — the flank MECHANISM is proven (flank-cover ratio 1.68–1.84 when one exists), but
meaningfully-covered ground is rare at 5 m granularity. Discrete sub-cell cover objects are what make a
covered flank (and "a man behind a wall") common and visible. See `scripts/squad-maneuver-probe.ts`.

## The fix (next campaign — shared tactical patch with 019)
A **discrete cover-object layer** (vector, not raster) on the fine tactical patch around active units: each
object `{frontage, height, material→small-arms stop-prob, conceal}`, seeded deterministically from the
existing landcover (`Boulders`/`TerraceWall`/`CompoundWall` cells → N objects via a stable hash, mirroring
`decoration.ts`'s scatter, so the determinism contract holds). **Posture-dependent** cover (Combat Mission
calibration: a low wall = partial standing, full prone). The combat AI's `seekCover`/`findCover` query the
object layer; LOS/`civClear` query objects + dead ground. **The object the engine uses for cover IS the one
drawn** (promote `decoration.ts` from cosmetic to sim-backed at tactical zoom).

## Verify (when built)
`scripts/cover-probe.ts`: behind-object exposure ≤20%, open ≥80%, posture changes the number; the drawn
object and the cover-query object are the same instance. Live tactical-zoom screenshot: men tucked behind
walls/rocks. Don't raster 1 m cover over the whole 512² map (25× memory) — objects are sparse vectors on the
patch.
