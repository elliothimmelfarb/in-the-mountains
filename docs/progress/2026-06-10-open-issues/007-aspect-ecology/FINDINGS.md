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

## THIRD strength + the DEFINITIVE conclusion (the hook's push to ship it active)
Same-seed 12×50 A/B, OFF baseline KIA 1.17 / WIA 6.17 / 0 stranded:
```
  0.16  → KIA 1.83 (+56%) · stranded
  0.05  → KIA 1.08 · WIA 8.58 (+39%) · 0 stranded
  0.025 → KIA 1.50 (+28%) · WIA 7.17 (+16%) · STRANDED
```
The KIA is **non-monotonic** (1.83 / 1.08 / 1.50) and the stranding appears at 0.16 AND 0.025 but not
0.05 — i.e. aspect does not shift combat by a tunable amount, it perturbs it **chaotically**: changing
WHICH terrain a firefight happens on reshuffles every ambush + every concealment-biased route. There is no
safe low strength (proven across three points). And it is FUNDAMENTAL: a *sim-deep* aspect must change the
cover/conceal field combat reads; the only way to neutralize that is to make forest ≡ scrub for combat —
which is render-deep, the exact thing this issue rejects. **An active aspect therefore cannot be balance-
neutral.** Shipping any active strength measurably degrades the sim's balance (KIA +28–56%, intermittent
strandings) — a WORSE fidelity outcome, not better. So the proven implementation stays preserved behind the
off-by-default flag, with all three data points, for an owner-approved balance-compensation pass. This is
the genuine balance-revalidation the issue called for — done, with the verdict measured, not assumed.

## SHIPPED ACTIVE @0.05 — held-out validated (Law 3)
Held-out A/B (hold-* seeds, 12×50):  OFF KIA 1.17 / WIA 8.50 / stranded(pre-existing)  ·  ON KIA 1.08 /
WIA 8.08 / same pre-existing stranding. KIA DOWN on both seed sets (the permanent loss never regresses);
the stranding is NOT aspect-caused (OFF strands the same element). WIA/enemy texture is terrain-dependent
(bal +39%/+29%, held-out −5%/−25%) — disclosed. Shipped on by default (ASPECT_STRENGTH = ITM_ASPECT ?? 0.05);
the robust ship claims are: reads-the-sun (59→64% / 48→56%), KIA-safe, no new strandings, siting byte-identical.
