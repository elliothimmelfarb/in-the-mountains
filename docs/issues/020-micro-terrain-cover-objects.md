# 020 — Micro-terrain: a soldier can't use a rock, a low wall, a berm

**Status: ✅ RESOLVED 2026-06-10 — directional + posture cover shipped (the deferred heavy half). A
discrete object now stops only the round from the bearing it faces (a flanker sees you), posture-scaled;
balance A/B is the OPPOSITE of the reverted omnidirectional grind — US WIA −22% tuned / −36% held-out,
enemy preserved, 0 stranded. Object layer + drawn=sim shipped 2026-06-09. See the Resolution at the bottom.**

_(historical: 🟡 DIAGNOSED + scoped, deferred to a two-tier tactical patch — since resolved with the
simpler per-shot directional query on the existing object layer, no new terrain bake needed.)_

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

## Resolution — DIRECTIONAL + POSTURE COVER SHIPPED 2026-06-10 (the deferred heavy half)

The heavy half is **resolved** — and notably WITHOUT the "two-tier tactical patch" the scope assumed: the
existing `coverObjects` vector layer + a per-shot directional query is the simpler architecture that clears
the bar (Law 6).

- `terrain.coverOcclusion(shooter, target, targetHeight)` — a discrete boulder/outcrop BETWEEN the shooter
  and target, close in front and across the sight line, stops `min(1, objH/targetH)·intrinsicStopProb`
  (boulder 0.62, outcrop 0.72). **DIRECTIONAL** (a flanker's round isn't on the line → 0), **POSTURE-aware**
  (a low rock hides a prone man more), lazy spatial-bucket index (derived, not serialized). Frontage mirrors
  the asset footprint (drawn=sim).
- `combat.coverFor` (the FIRE-hit path only — detection unchanged) takes `max(raster, occlusion)`;
  `findCover` (both factions) scores object cover from the threat bearing, so a man MOVES to tuck behind it.

**Why it doesn't grind (the failure that deferred it twice):** directionality. Cover only screens the threat
arc, so the already-shipped autonomous flank fires from a new bearing and the fight resolves by MANEUVER.

**Numbers:** cover-directional-probe behind **0.08→0.39**, flank **0.08→0.00** (directional), prone **0.62**
vs stand **0.24** (posture). Balance A/B (12×50, `ITM_NOOBJCOVER` kill-switch) — the OPPOSITE of the
2026-06-09 +89% grind: tuned `bal-*` WIA **7.92→6.17 (−22%)**, **held-out** `holdout-*` WIA
**6.75→4.33 (−36%)**, KIA flat, enemy preserved (+1–7%), **0 stranded** both. tsc/build/lint/smoke green;
no new persisted state. Params from physical reasoning, not curve-fit.

**Adversarially verified** (2-agent workflow, both lenses `no-issue`, conf 0.9): independent A/B reproduced
the win (WIA 9.83→7.00, enemy 3.50→4.50 UP); geometry traced line-by-line (cover only when an object is on
the target→shooter ray, bounded ≤0.72, posture-scaled — not too strong); **fire-path only** (coverFor at
the hit-plane only, NOT detection/targeting/blast/civClear — ROE intact, civ cas 0 both arms); determinism
byte-identical on load (coverObjects regenerated, nothing new serialized); perf neutral (cover path ~0.5%
faster — a 3×3 bucket scan on the terminal hit only). The enemy-up result is the designed maneuver dynamic,
not an artifact. See
`docs/progress/2026-06-10-open-issues/020-directional-cover/` +
`public/manual/archive/reports/2026-06-10-directional-cover/`. _(Remaining polish, not blocking: terrace
walls / qalat walls as linear cover objects; the AI preferring a prone stance specifically behind low cover.)_
