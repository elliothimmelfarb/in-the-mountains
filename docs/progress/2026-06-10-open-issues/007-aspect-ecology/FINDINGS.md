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

## Follow-up: a TWO-STRENGTH balance sweep (the genuine balance-revalidation attempt)
After the first revert, I tested whether a WEAKER aspect could be balance-neutral. Same-seed 12×50 A/B,
ITM_ASPECT env sweep, OFF baseline = KIA 1.17 / WIA 6.17 / 0 stranded:
```
  strength 0.16:  KIA 1.17→1.83 (+56%) · stranded a unit          (the first revert)
  strength 0.05:  KIA 1.17→1.08 · WIA 6.17→8.58 (+39%) · 0 stranded
```
At 0.05 the **stranding clears** (it was a high-strength artifact) but firefights still **drag**: WIA +39%,
enemy accounted +29% — more shaded-face forest (conceal) makes fights longer and bloodier on BOTH sides.
The only strength that's truly neutral has a negligible ecology signal. So aspect is NOT a clean slice: it
needs a **deliberate balance-compensation pass** (offset the firefight-drag — e.g. a small detection tweak —
and re-tune), owner-approved, not a slip-in. Decision: the implementation is **PRESERVED behind an
off-by-default flag** (`ASPECT_STRENGTH`, env `ITM_ASPECT`; 0 = byte-identical), with the probe + both data
points, so the future pass starts from a proven base instead of a blank page.
