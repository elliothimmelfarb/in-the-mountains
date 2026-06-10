# Campaign D — 007 aspect-driven vegetation · findings + the blast-radius lesson

## The win
`classifyLand` decided forest vs scrub purely from `moist` (noise + draw-proximity + a crude north-y
bias) — **no aspect term**. Real hillsides are asymmetric: shaded pole/north-facing slopes hold
moisture (forest); sun-facing slopes bake dry (scrub). Added an aspect-shade term to `moist` keyed on
the slope's facing (`dzdy` normalized by slope: north-facing ⇒ wetter).

aspect-probe (forest/scrub on slopes, fraction facing the "right" way):
```
                 forest-faces-north   scrub-faces-south
  BEFORE              59.6%                48.1%      (≈ no aspect signal)
  AFTER (>0.62)       72.9%                69.6%      (vegetation reads the sun)
```

## The blast-radius lesson (why the gate is slope > 0.62, not > 0.1)
First cut (aspect on all slopes > 0.1) gave a STRONGER signal (79%/77%) but **regressed the COP**:
village count 48→49 and gate-overwatch 0/9→**2/9** (copaudit). Root cause: the aspect term overlapped
the **Terrace** classification band (slope 0.22–0.6), and Terrace drives village/road siting — so
perturbing it cascaded into the hard-won issue-022 gate-overwatch geometry. (Verified by zeroing the
term: ASPECT OFF = 48 villages / 0-9 gate; ON = 49 / 2-9.)

**Fix = gate aspect ABOVE the terrace band (slope > 0.62 ≈ 32°+).** This is both ecologically more
correct (terraced cropping is below; the forest-vs-scrub contrast is on the steep faces above) and
**byte-identical for siting**: route-quality back to 48 / ratio 1.12, gate-overwatch back to **0/9**,
while the aspect signal stays strong (73%/70%). Realism win, zero COP regression. The doctrine in action:
don't ship a combat-defense regression for a vegetation nicety — find the gate that gives the win clean.

## Validation (slope > 0.62 version)
- aspect signal 59%→73% / 48%→70% (aspect-probe). smoke OK (determinism; new terrain reproduces).
- route-quality ALL 48 ratio 1.12 — byte-identical. gate-overwatch 0/9 — byte-identical (copaudit).
- reachability + balance: [pending — floor/villages byte-identical, only steep-face forest↔scrub
  redistributed at equal move cost, so expected neutral].

## Still open (the rest of 007)
Stacked contour terraces, denser qalat wall-lattices, and flow-accumulation hydrology — each a larger,
siting-touching pass (the same blast-radius care this slice needed). Aspect was the cleanest slice.
