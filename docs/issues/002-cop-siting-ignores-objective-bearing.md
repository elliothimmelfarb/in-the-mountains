# 002 — COP siting ignores where the villages/objectives are

**Severity:** Medium · **Confidence:** High (measured) · **Area:** COP generation (`placeVillagesAndCOP`, gate direction in `buildCop`)

## Summary

The COP is sited for prominence, a height band, and nearness to the road — but **not** with any regard
for where the villages it exists to patrol actually are. And the gate then faces the valley road,
independently of the villages. The frequent result: the gate faces 90–180° *away* from the nearest
village, so every patrol to it must file out and walk the long way around the entire wire.

This now *works* (the movement rebuild rounds the wall fine), but it's a realism/quality issue —
a real outpost's ECP faces its area of operations — and it amplifies issues 001/005 (the more
perimeter you must traverse, the more likely you hit a cliff gap or a coarse-pathfinding seam).

## Evidence (current state, 2026-06-03)

Angle between the gate direction and the bearing to the **nearest** village:

```
seed         gate→nearest-village      nearest village
bravo-2       50°                       234 m
korengal     140°                       227 m
survey-9      88°                       260 m
valley-3     176°  (almost dead opposite) 135 m
delta-5      165°                       192 m
smoke-test   170°                        86 m
```

On 8 of 10 sampled seeds the gate faces >90° away from the nearest village. `valley-3` is the
pathological case: the gate is ~176° from a village only 135 m away — a 30-second straight-line trip
becomes a ~350 m march around the wall.

## Root cause

Siting (`placeVillagesAndCOP`, `lib/sim/terrain.ts`):

```ts
const score = prom * 1.6 + heightScore * 1.8 + distScore - this.slope[i] * 2;
```

`prom` = local prominence, `heightScore` = a 25–95 m band above the valley floor, `distScore` =
nearness to the road. **No term references the villages.** Villages are placed first, but the COP
score ignores them.

Gate direction (`buildCop`) faces the road centerline (`centerXAt`) with a downhill bias — again,
independent of the villages.

## Suggested directions

- **Add an "overwatch/access" term to the COP score**: reward sites with good line-of-sight to, and a
  reasonable walking distance from, the village cluster (or at least the nearest 1–2 villages). The
  real Korengal Outpost overwatched specific villages; mirror that intent.
- **Face the gate toward the AO.** Once issue 001's "score the 8 gate directions" exists, fold in a
  term for "points toward the village centroid / the road that leads to them," not just downhill.
- Consider a **second pedestrian gate or sally port** on the AO-facing side if the main vehicle gate
  must face the road — historically common, and it removes the "march all the way around" tax cleanly.
- Keep it from over-fitting: a little awkwardness is realistic and the benched perimeter track makes
  the long way around cheap. The goal is to avoid the *systematic* gate-faces-away outcome, not to put
  the gate on the village every time.

## Related

- 001 (egress terrain), 003 (the longer the traverse, the more assembly/route edge cases bite).

## Resolution (2026-06-04)

Fixed in `lib/sim/terrain.ts`:

- **Siting now references the villages.** `placeVillagesAndCOP`'s score gained an `aoScore` term that
  rewards a ~110–460 m standoff from the **nearest** village (overwatch the AO, don't sit in the bazaar).
- **The gate faces the AO.** The 8-direction gate scoring (see 001) aims the gate at
  `0.7·(nearest-village bearing) + 0.3·(village-centroid bearing)`, with a secondary road pull and the
  passable-apron hard requirement. The nearest village dominates because that's the worst case for a
  "march all the way around" gate.
- A first over-correction aimed dead-on at the centroid and made `korengal`/`bravo-2` *worse*; a
  straight-line "village accessibility" term was tried and **reverted** (a ray over a cliff ignores the
  draw that routes around it — it destabilised good placements). The shipped weighting is the nearest-
  village blend above.

Verified — `copaudit.ts 16`: **gate faces >90° from the nearest village 0/16** (was 8/10 sampled).
Average gate→nearest-village angle dropped to ~30°.
