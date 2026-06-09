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

## Resolution — DRAWN=SIM object layer shipped 2026-06-09 (cover-objects commit); combat-cover DEFERRED on the numbers

The 2026-06-09 terrain-realism campaign shipped the **object layer** half and, after measuring, deliberately
deferred the **combat-cover** half.

**Shipped:** boulders and rock outcrops are now sim **objects** (`terrain.coverObjects`, ~11,600/valley) —
a single deterministic source of truth that `decoration.ts` draws (promoted from a cosmetic, independently-
scattered overlay). On rocky ground, where the landcover already encodes real cover, this closes the loop:
the rock you see is exactly where the engine's cover is (drawn=sim, verified per-object in `cover-probe.ts`).
Plus the owner's "more on the map" — a strew of erratic boulders down the OPEN slopes that were bare. The
cover field is **byte-identical to before** (provably balance-neutral; `cover-probe` openCov% unchanged 25%).

**Deferred + restraint-logged (the combat-cover half):** the plan was for the open-ground erratics to add
*usable* cover (target openCov 25→43%). Measured, it was wrong. Cover is the most balance-sensitive thing on
the map: more of it makes *both* sides survive longer, so firefights drag and casualties RISE. Same-seed
12×50 A/Bs were unambiguous — even a light, dialed-back open-ground stamp pushed **WIA 3.92→7.42 (+89%)**; a
broad first version (raising Scree everywhere) was ~3× worse. The 5 m cell scalar is too coarse to add
ambient cover without grinding every firefight near a rock. So the open-ground combat-stamp was **cut**.

**Still OPEN (the real fix this issue scoped):** **sub-cell directional** cover — "behind *this* rock,
exposed from *that* angle" — and **posture-dependent** cover, on a vector-LOS tactical patch. Only that can
make open-ground cover both USABLE and non-grinding (a man is covered when he's behind the rock from the
threat, not whenever he's in its 5 m cell). The `stampNew` seam in `generateCoverObjects` is left in place
for it. See `docs/progress/2026-06-09-terrain-realism/`.
