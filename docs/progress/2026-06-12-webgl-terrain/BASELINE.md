# Baseline — visual state before the WebGL terrain rebuild (HEAD c236dbb)

Captured 2026-06-12 with `node scripts/visual-matrix.mjs docs/progress/2026-06-12-webgl-terrain/baseline`
(seed `visual-baseline`, 90-day campaign, weather pinned Clear, paused; COP at world 1227.5, 2092.5).

## Screenshot matrix (18 shots, `baseline/`)

| | strategic 0.35 | operational 0.9 | tactical 2.5 | close 4.6 |
|---|---|---|---|---|
| dawn 06:15 (ambient 0.699) | ✓ | ✓ | ✓ | ✓ |
| noon 12:00 (ambient 1.000) | ✓ | ✓ | ✓ | ✓ |
| dusk 18:30 (ambient 0.384) | ✓ | ✓ | ✓ | ✓ |
| night 23:00 (ambient 0.050) | ✓ | ✓ | ✓ | ✓ |

Plus `rain-noon-operational` (ambient 0.700), `fog-dawn-operational` (ambient 0.511).

Note: in the baseline renderer, dawn/noon/dusk differ ONLY by the flat navy wash alpha
(`rgba(8,14,30, .35+night*.42)` topo.ts:587) — terrain shading is identical at all hours
(fixed NW key light baked once). That is the thing this campaign kills.

## Performance (scripts/shoot.mjs --fps, headless Chrome, --disable-gpu software raster)

```
stage: ok n=41 proj=1
fps: {"avgMs":35.49,"worstMs":49.2,"fps":28}
```

Tactical zoom (ppm 2.8), staged combat tableau, 1440×900 @2x. Post-rebuild FPS must be
measured on the SAME harness conditions for a valid delta.

## Standing-check state at baseline

Branch main @ c236dbb, clean tree before campaign work.

## WebGL2 availability in headless capture Chrome (scripts/scratch-webgl-check.mjs, 2026-06-12)

```
--disable-gpu           → {"webgl2":false}
--use-angle=swiftshader → {"webgl2":true,"renderer":"ANGLE ... SwiftShader ...","maxTex":8192,"floatLinear":true,"colorBufFloat":true}
(no gpu flags)          → {"webgl2":true,"renderer":"ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)","maxTex":16384,"floatLinear":true,"colorBufFloat":true}
```

Consequence: harnesses must DROP `--disable-gpu` post-rebuild (headless gets the real M1 Max
GPU with no flags). The in-game 2D fallback stays for WebGL-unavailable contexts.
