# Campaign B — 020 sub-cell directional + posture cover · design + Phase-0 baseline

**Goal:** make a soldier covered when he is behind *this* rock from *that* threat — directional and
posture-dependent — so open-ground cover is finally USABLE without grinding every firefight (the
omnidirectional 5 m stamp was reverted on 2026-06-09 for +89% WIA: it made *both* sides survive longer).

## The key insight (why directional ≠ grinding)
`lib/sim/los.ts` already computes `terrainExposure` — how much of the target's silhouette pokes above
the **terrain horizon** along the gun→target line (defilade) — and `exposure` drives hit probability
(`combat.ts:1639`). A cover **object** on that line near the target is just a *discrete horizon-raiser*,
and it is **directional by construction**: a boulder only blocks fire arriving along *that* bearing, so a
flanking shooter still sees the target exposed. That asymmetry is exactly what the omnidirectional raster
stamp lacked — so it can be usable AND non-grinding.

## Verified seams (file:line)
- `los.ts:110-127` — `terrainExposure` → `exposure = terrainExposure·(1−concealment)`. **The hook:** fold a
  posture-aware object occlusion into `terrainExposure` (or multiply `exposure`) near the `to` end.
- `combat.ts:1639` — fire scoring uses `los.exposure`. `combat.ts:1746 civClear` uses LOS too (keep ROE honest).
- `combat.ts:1711 findCover` + `squad-combat.ts:199 findCoveredFlank` — today both query the 5 m `coverAt`
  raster + a crude threat-dot. Re-point them at the object occlusion so a man tucks behind a real object.
- `terrain.coverObjects` — `{x,y,id:"boulder"|"rock-outcrop",scale,rot,cover,conceal}`, ~12,100/seed,
  drawn=sim (decoration.ts:118). Height ≈ baseHeight(id)·scale; small-arms stop-prob ≈ `cover`.
- `combat.ts:563-579 bucketKey` — the unit spatial-bucket pattern to MIRROR for a one-time static
  cover-object index (objects are static → build once at gen, query per shot).

## Plan (one mechanism)
1. **Static spatial index** for `coverObjects` (bucketed by ~8 m cell), built once. Inert until wired.
2. `terrain.coverOcclusion(shooter, target, targetHeight) → 0..1` — nearest object just in front of the
   target on the sight line, within its frontage; occlusion = f(objHeight, targetHeight via posture, stopProb).
   Prone (low targetHeight) → a low wall covers MORE (Combat Mission calibration).
3. Fold into `los()` exposure (directional). Re-point `findCover`/`findCoveredFlank` at it.
4. **Verify:** extend `cover-probe.ts` — behind-object exposure ≤20%, open ≥80%, **posture changes the
   number**, drawn=sim. `balance.ts` A/B (ITM-style kill-switch) — must NOT drag (directional = the fix).
   Held-out + adversarial. Determinism: index is derived (not serialized).

## Phase-0 baseline (HEAD, 2026-06-10) — cover-probe (object layer, pre-combat-coupling)
```
MEAN   objs 12103   onOpen 1693   openCov% 25%   meanReach 41m   drawn=sim OK
```
Combat-cover is currently DECOUPLED (objects are visible + stamp the field byte-identically, but the
firefight reads the 5 m scalar, not the object on the line). This campaign couples them — directionally.

**Restraint to respect:** the 2026-06-09 A/B (WIA 3.92→7.42, +89%) is the cautionary baseline. Any version
that raises *omnidirectional* exposure is wrong. The win is ONLY the directional, posture-gated occlusion.

## Phase-0 baseline #2 (HEAD) — cover-directional-probe (the BUG, measured)
`npx tsx scripts/cover-directional-probe.ts 6` — exposure 0..1, lower = more covered:
```
MEAN  behind 0.418 · open 0.385 · flank 0.403 · stand 0.446 · prone 0.375
```
The object is INVISIBLE to combat: behind ≈ open ≈ flank, and posture barely moves it. That IS the bug.
NOTE: "open" ≈ 0.39 (not 0.80) because lineOfSight already folds terrain micro-relief + open-slope veg
concealment — so the DoD is RELATIVE: after the fix want **behind << open ≈ flank** (directional) and
**prone < stand** behind a low object (posture). Oracle: `scripts/cover-directional-probe.ts` (a keeper).

## AFTER #1 — directional cover in the hit roll (part A, passive) — MEASURED 2026-06-10
`coverFor(target, fromPos)` now adds `terrain.coverOcclusion(fromPos, target, postureHeight)` via Math.max.
cover-directional-probe (now measures coverOcclusion = the combat cover value, HIGHER=covered):
```
MEAN  behind 0.386 · open 0.006 · flank 0.000 · stand 0.241 · prone 0.616
```
✅ DIRECTIONAL (open~0, flank 0) and ✅ POSTURE (prone 0.62 > stand 0.24 — a low boulder hides a prone
man 2.5× more). Uses INTRINSIC stop-prob per object (boulder 0.62, outcrop 0.72), NOT o.cover (the cell
value). Fire-path only (coverFor), detection unchanged. A/B kill-switch ITM_NOOBJCOVER=1.

**Balance A/B (12×50) RUNNING** — the gate. If directional cover is balance-neutral (the flank defeats
it, so no symmetric grind), part A ships and part B (the AI actively SEEKS object cover via
findCover/findCoveredFlank → coverOcclusion) follows with its own A/B. If it drags, tune (stop-prob,
ahead-distance) before adding B. Baseline = committed combat (KIA ~1.08); delta = the directional cover.

## SHIPPED 2026-06-10 — directional + posture cover (parts A+B)
cover-directional-probe: behind 0.39 · open 0.006 · flank 0.000 · stand 0.241 · prone 0.616 ✅
Balance A/B (12×50, ITM_NOOBJCOVER kill-switch):
  TUNED bal-*:    KIA 1.25→1.17 · WIA 7.92→6.17 (−22%) · enemy 4.50→4.83 · 0 stranded
  HELD-OUT hold-*: KIA 0.50→0.50 · WIA 6.75→4.33 (−36%) · enemy 5.50→5.58 · 0 stranded
The OPPOSITE of the 2026-06-09 omnidirectional grind (+89% WIA): directional → the flank defeats the
cover → fights resolve by maneuver. Cover params from physical reasoning, NOT curve-fit. Committed a57da45.
