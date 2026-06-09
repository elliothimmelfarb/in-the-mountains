# HEAD baselines — 2026-06-10 open-issues campaign (before any code)

Captured on `main` @ f4c68bb, verbatim. Law 1: baseline before any edit.

## op-route-probe (issue 019 — switchback efficiency)
seeds: korengal korengal-2 ridgeline restrepo kunar-3 valley-7
```
seed         | climb | crow  | route  | detour | reached | switch | impass% | meanSlope
korengal     |  228m |  585m |  1281m |  ×2.19 |     yes |      1 |     25% | 0.65
korengal-2   |  561m |  608m |  5625m |  ×9.25 |     yes |      5 |     11% | 0.97
ridgeline    |   94m |  570m |  1072m |  ×1.88 |     yes |      4 |     45% | 1.31
restrepo     |  317m |  552m |   785m |  ×1.42 |     yes |      1 |     24% | 0.64
kunar-3      |  343m |  582m |  2719m |  ×4.67 |     yes |      3 |     32% | 0.88
valley-7     |  356m |  608m |  3413m |  ×5.61 |     yes |      6 |      9% | 0.88
mean detour ×4.17 · worst ×9.25 · reached 6/6
```

## route-quality (guardrail — must stay green)
ALL: 48 villages, ratio 1.12, maxRatio 1.68, loopy 0 (0%), rev 0.0, excursion 3m

## cohesion (guardrail — must stay green)
MEAN: paceEff 0.58, paceP10 0.65, throttle 33%, lenCV 0.93, jitter 0.23, blocked 0%

## balance + reachability: captured separately (background) -> balance.txt / reach.txt
