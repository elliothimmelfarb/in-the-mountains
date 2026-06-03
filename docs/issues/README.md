# Known generation issues — index

A catalog of terrain- and COP-generation problems observed while rebuilding squad movement
(2026-06-03). These are written for a future pass that iterates on **terrain generation** broadly and
should resolve them. Each issue states what's wrong, how to reproduce it, the evidence, a root-cause
hypothesis with code references, and suggested directions — with an honest confidence level.

The headline thing to internalize: **the movement system is now solid** (see
`docs/progress/2026-06-03-movement-report.html`). The remaining failures are almost all **generation**
problems — a COP gets sited or shaped such that it is hard or impossible to move around — not movement
bugs. Fix the generation and the movement follows.

## The issues

| # | Issue | Severity | Confidence |
|---|-------|----------|------------|
| [001](001-gate-egress-on-broken-ground.md) | Gate / immediate egress sited on impassable or broken ground; perimeter track has gaps | **High** | High (reproduced) |
| [002](002-cop-siting-ignores-objective-bearing.md) | COP siting ignores where the villages/objectives are (gate faces away) | Medium | High (measured) |
| [003](003-interior-assembly-deadlock.md) | Squad can't assemble/egress — members deadlock in the interior | Medium | Medium (one synthetic seed) |
| [004](004-buildings-are-passable.md) | Interior buildings are passable (you can walk through the TOC) | Low (fidelity) | High (in code) |
| [005](005-coarse-pathfinding-vs-gate-and-walls.md) | Coarse pathfinding fragility: a thin gate in a thick wall can seal at 15 m resolution | Medium | Medium |

## Reproduction toolkit

All of these reproduce from a seed, headless, in seconds. The seed is any string passed to
`createWorld(seed, days)`. Useful seeds found so far:

| seed | what it exhibits |
|------|------------------|
| `ridge-11` | **gate egress blocked** (`gateOutside` on impassable ground) — issue 001 |
| `survey-2` | long/broken route to the far village; patrol "sets up short" — issues 001/002 |
| `survey-9` | interior assembly **deadlock** (members stuck among structures) — issue 003 |
| `valley-3`, `korengal` | gate faces ~140–176° away from the nearest village (works, but via the long way around) — issue 002 |
| `smoke-test`, `delta-5` | perimeter ring 17–18% blocked (discontinuous "ring road") — issue 001 |

Harnesses (in `scripts/`):

- **`movement-diag.ts`** — forms a presence patrol to the village *most opposite the gate* (the worst
  case) across a seed list and reports: did the point man arrive, did the element set up on-station,
  wall-blocked ticks, body overlaps, and how far the squad "finished" from the objective. This is the
  fastest way to see a generation problem bite.
- **`trajectory-svg.ts <seed> <out.svg>`** — renders the squad's actual traced path around the COP. A
  bad generation shows up instantly as a route that can't get around.
- **`copsurvey.ts`** — surveys COP placement/road metrics across seeds.

A quick one-off COP audit (gate-egress passability, perimeter-ring continuity, interior open %, and
the gate-to-nearest-village bearing) is easy to write against `terrain.cop` — see the snippet in each
issue. Current-state numbers (10 seeds, 2026-06-03) are quoted in issues 001 and 002.

## Relevant code

- `lib/sim/terrain.ts` — `placeVillagesAndCOP` (siting), `buildCop` (wall, gate, perimeter track,
  structures, LZ), `passableCell`, `moveCostAt`, `gradeAccessRoad`.
- `lib/sim/path.ts` — hierarchical A*, the coarse `nodeCost` + `BARRIER_PENALTY`.
- `lib/sim/world/formation.ts`, `lib/sim/world/tasks.ts` — how patrols muster, file out, and move
  (the consumers that expose the generation problems).
