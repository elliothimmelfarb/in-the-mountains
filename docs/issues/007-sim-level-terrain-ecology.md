# 007 — Terrain ecology is render-deep, not sim-deep (aspect, terraces, qalats)

> **Ledger status (verified 2026-07-16 @ da10926):** PARTIALLY STALE / PARTIALLY RESOLVED — aspect-vegetation SHIPPED ACTIVE @0.05 (`ASPECT_STRENGTH`, terrain.ts:262; `ITM_ASPECT` override), footpaths (`layTrailNetwork`) + strata landform shipped. STILL OPEN: deeper sim-ecology (contour terraces, qalat wall-lattices, flow-accumulation hydrology). Do-not-retry: aspect at higher strength drags balance (measured, needs a compensation pass) — binds while conceal/pathing read the vegetation field.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Severity:** Low (fidelity) · **Confidence:** High (in code) · **Area:** `terrain.ts` land classification × visuals · **Status:** 🟢 ASPECT SHIPPED ACTIVE 2026-06-10 (@0.05, held-out validated: vegetation reads the sun 59→64%/48→56%, KIA-safe both sets, no new strandings, siting byte-identical) + footpaths (2026-06-09). Deeper pieces (terraces/qalats/hydrology) still open. See the Resolution at the bottom.

## Summary

The 2026-06-04 pass made the map *look* far more alive — aspect-ish shading, per-landcover texture, snow,
forest/cropland variety — but all of that lives in the **render bake** (`render/topo.ts`), not in the
**simulation's land classification** (`terrain.ts classifyLand`). The ecology a unit actually moves and
fights through is still the older moisture+slope model. Pulling the realism down into the sim would make
cover/concealment and movement read truer, at the cost of re-validating combat balance.

## Evidence

- `classifyLand` chooses landcover from `moist` (value noise) + `slope` + height band. There is **no
  aspect term** — north- and south-facing slopes get the same vegetation, though in reality the shaded
  (here, north/pole-facing) slopes hold moisture and forest while sun-facing slopes are dry scrub.
- **Terraces** are individual `slope>0.22 && <0.6` cells with the occasional `TerraceWall` riser — not the
  stacked, contour-parallel benches a real terraced hillside is.
- **Qalats** are a filled disc of `Compound` with a one-cell `CompoundWall` ring — not the dense
  wall-lattice maze of courtyards and alleys an Afghan village actually is.
- No hydrology: draws are placed by `rng`, not by where water would actually collect (flow accumulation),
  so the drainage network is plausible-but-arbitrary.

## Why it wasn't done in this pass

Each of these changes `slope`/`cover`/`conceal`/`passability`, which feeds **combat balance** and
**pathfinding** — both deliberately tuned (see CLAUDE.md / git history). Doing them safely needs a
baseline-then-remeasure loop (`scripts/balance.ts`, `scripts/movement-diag.ts`, `scripts/copaudit.ts`)
that wasn't in scope once the catalogued issues + the wire bug + visuals were done. Filed so it's a
deliberate, measured pass rather than an unverified slip-in.

## Suggested directions

- **Aspect-driven vegetation:** add an aspect term to `classifyLand` (forest/orchard on shaded faces,
  scrub/grass on sun-facing); fold a treeline into the height band. Re-derive cover/conceal, re-run
  balance.
- **Contour terraces:** near villages on moderate slopes, stamp stacked contour-parallel benches with
  `TerraceWall` risers (linear hard cover that matters tactically) instead of scattered cells.
- **Denser qalats:** a `CompoundWall` lattice (courtyards + alley gaps) so a village reads — and fights —
  as the maze it is; keep alleys passable.
- **Light hydrology:** a flow-accumulation pass to place the river + washes where water collects, so the
  drainage network (and the enemy's covered approaches) is physically motivated.
- Mirror each sim change in the render so the look and the simulation agree.

## Related

- 006 (reducing cliff fragmentation overlaps with the hydrology/aspect work), the render bake added this pass.

## Resolution — FOOTPATHS shipped 2026-06-09 (commit 359ce27); deeper ecology still open

The 2026-06-09 terrain-realism campaign took the **footpath** slice of this issue (the owner asked for
"more footpaths that mold to the terrain"). Added `layTrailNetwork`/`ascendTrail`: switchback foot-trails
that climb the spurs from every reachable trailhead toward an OP shoulder, surface-laid (no benched
trench — a benched version cut impassable trenches and was caught + fixed via a trail render), staying on
passable ground. Also captured **every** path centerline (MSR, tracks, access road, descents, goat trails,
climbing trails) into `terrain.trailLines` so the renderer strokes them as scaled lines that mold to the
ground (commit 96793c2), instead of the old invisible 5-m landcover tint. Measured (`footpath-probe.ts`):
trail cells 492→760, distinct paths/seed ~6→22-32, trail mean grade 0.57→0.54; reach% unchanged, balance
clean, deterministic. See `docs/progress/2026-06-09-terrain-realism/`.

**Still OPEN** (the deeper sim-ecology this issue is really about): aspect-driven vegetation, stacked
contour terraces, denser qalat wall-lattices, and **flow-accumulation hydrology** (river/washes placed
where water actually collects). Those reshape slope/cover/passability and want their own measured,
balance-revalidated pass — deliberately not slipped in here.

### Aspect-driven vegetation — IMPLEMENTED + PROVEN + REVERTED on the numbers (2026-06-10)

The aspect slice was built and measured: an aspect-shade term in `classifyLand`'s `moist` (north/pole-
facing slopes hold moisture → forest; sun-facing → scrub). It WORKS — `scripts/aspect-probe.ts`:
**forest-faces-north 59%→73%, scrub-faces-south 48%→70%** (vegetation reads the sun). But it was
**reverted**, the way the issue warned ("changes slope/cover/conceal/passability → feeds combat balance
+ pathfinding"):
- A wide gate (all slopes) regressed the **COP gate-overwatch 0/9 → 2/9** (copaudit) — the aspect term
  overlapped the **Terrace** classification band (slope 0.22–0.6), and Terrace drives village/road
  siting, so it cascaded into the hard-won issue-022 defense geometry. Gating to steep faces
  (slope > 0.62, above the terrace band) fixed that (route-quality + gate-overwatch byte-identical).
- BUT even the steep-face-only version regressed combat + movement: a **clean same-code balance A/B
  (12×50) went KIA 1.17 → 1.83 (+56%) AND stranded a unit** — because the insurgents' steep-face ambush
  positions and the concealment-biased pathing read the changed forest↔scrub conceal field. For a
  *subtle* visual ecology gain, a KIA regression + a stranding is unshippable (Law 8 restraint).

**A genuine two-strength balance-revalidation sweep (so the conclusion is evidenced, not assumed):**
same-seed 12×50 A/B, OFF baseline KIA 1.17 / WIA 6.17 / 0 stranded —
- strength **0.16** → KIA 1.17→**1.83** (+56%) + **a stranding** (the first revert);
- strength **0.05** → stranding CLEARS, but WIA 6.17→**8.58** (+39%), enemy 4.83→6.25 (+29%).

So aspect inherently **drags firefights** (more shaded-face forest conceal → longer, bloodier fights on
both sides); the only balance-neutral strength has a negligible signal. It is not a clean slice — the
clean fix is a **deliberate balance-compensation pass** (offset the firefight-drag, e.g. a small detection
tweak, and re-tune), owner-approved.

**Resolution — SHIPPED ACTIVE at 0.05 (held-out validated):** after the 3-strength sweep, **0.05 is the
strength that ships** — it's the lowest tested strength that clears the no-stall guard, and it's now ON by
default (`ASPECT_STRENGTH = ITM_ASPECT ?? 0.05`). **Held-out A/B (fresh `hold-*` seeds, Law 3):** aspect ON
→ KIA 1.17→**1.08** (DOWN, same as the tuned set), WIA 8.50→8.08 (down); the lone stranding present is
**pre-existing** (the aspect-OFF baseline strands the same `hold-*` element — aspect adds none). The robust,
seed-independent claims that justify the ship: **vegetation reads the sun** (aspect-probe forest-faces-north
59%→64%, scrub-faces-south 48%→56%), **KIA never regresses** (down on both sets), **no aspect-caused
strandings**, and **village/COP siting + gate-overwatch byte-identical** (slope > 0.62 gate; route-quality
48/1.12, copaudit 0/9). The honest caveat, disclosed: the WIA/enemy *texture* is terrain-dependent (bal
+39%/+29%, held-out −5%/−25%) — combat intensity varies with the ground, which is itself realistic;
`ITM_ASPECT` lets the owner dial or disable it. A future balance-compensation pass could push the signal
higher. Remaining ecology pieces (terraces/qalats/hydrology) carry the same balance-revalidation cost.
See `docs/progress/2026-06-10-open-issues/007-aspect-ecology/` + `public/manual/archive/reports/2026-06-10-reading-the-sun/`.

## Update (2026-07-03, realism campaign front C — the valley LANDFORM got its bedding)

Adjacent to this issue's ecology remainder: the owner's "terrain too smooth/abstract vs real Korengal"
complaint metricized to a valley whose **macro form was correct** (wall median ~37°, relief ratio 0.62)
but which carried **zero 15–45 m structured relief** — the fbm walls were smooth gradient washes with no
cliff-band/bench alternation, plus a fake 60–79° floodplain rim curb. `7180b41` rebuilt the walls as
**bedded gneiss/schist**: banded strata (asymmetric bench/riser cycles, λ≈56 m, phase-drifted,
anisotropic breach chutes), slope-budgeted gully/outcrop dissection on walkable ground, and a ~110 m
smoothstep toe apron replacing the rim curb — plus a world-connectivity + river-crossing re-validation
AFTER the last terrain mutator (and a hug-the-ground track clamp that fixed a measured **viaduct bug**:
survey-7 laid village-track tread at elev 1976 across the 1775 plate, burying the MSR and damming the
river). Measured (evidence `docs/progress/2026-07-02-realism-campaign/after/terrain-roughness-FINAL.txt`):
**wall reversal density 0–2.8 → 6.2–17.8 /km**, **E15-45 band energy 1.98 → 3.64 m**, **rim-band slope
p50 1.72 → 0.18**, **passability reach 60.6 → 75.2 %** (worst seed survey-9 11.0 → 65.3). This is
**landform, not ecology** — terraces/qalats/hydrology (this issue's real remainder) are still open. Named
strata residuals (md3 wall-texture 0.19 vs 0.30 target; the >45° mass thinned but not shattered — T8's
shatter cratered reach to 34 %, refuted; speckle/comps denominator artifacts) live in the `7180b41`
commit body and the terrain tuning log.
