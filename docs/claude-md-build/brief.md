# ORIENTATION BRIEF + VERIFIED GROUND-TRUTH MANIFEST
*(Produced by the ORIENT workflow: 5 parallel readers → grounding lead that verified every artifact via Bash.)*

## Identity (what this repo IS)
"In the Mountains" is a deep, continuous real-time simulation of asymmetric warfare (counterinsurgency)
at a remote US combat outpost in a procedurally generated Korengal-like valley, Kunar Province,
Afghanistan, c. 2011. You command a COP at **squad level** (hq/1st/2nd/3rd/Weapons), never individual
men, across a campaign measured in in-game days. The defining design choice is **ONE master clock**:
no turns or phases — sun, weather, supply burn, fatigue, enemy tempo, CERP projects, and every
individually-simulated bullet advance on the same pausable, time-warpable timeline. The thesis baked
into the whole design: **"You can win every firefight and still lose the valley."** Killing fighters is
easy; winning village attitudes through patience, shuras, projects, and restraint is the real game, and
civilian casualties radicalize.

## Pillars (load-bearing)
1. **ONE continuous master clock** — no turns/phases. `World.tick(dt)` advances every subsystem on a
   single timeline; the order inside `tick()` is load-bearing (subsystems → `sim.tick(dt)` for combat →
   casualty/civilian reconciliation). Don't reason about state as turn-based.
2. **Strict three-layer split, one bridge.** Pure deterministic React-free engine (`lib/sim`) →
   React-free Canvas renderers (`lib/render`, take Terrain/CombatSim + Camera) → the ONLY bridge is
   `state/store.ts` (Zustand). Keep new code on the correct side of that line.
3. **Determinism is a contract.** A seed reproduces the valley AND outcomes; saves store full RNG state
   + live world. A same-seed run that diverges IS the bug.
4. **The valley is the enemy** — terrain dominates. 512×512 cells @ 5 m (2.56 km), 26 Land classes,
   elevation LOS, cover/concealment; everything simulated against terrain.
5. **People, not pieces** — named soldiers with morale/fatigue/wounds; losses are permanent. Tone is
   somber and serious (grounded in *War* / *Restrepo* / *The Outpost*), not a power fantasy.
6. **Combat is 100% AI** — no player order queue during a fight. The player's only in-combat levers are
   approve/deny AI-requested fires and call MEDEVAC; everything else is set beforehand via route +
   SquadSOP. "The hardest part of command is watching." Do NOT add individual-soldier micro as a "fix".
7. **Counterinsurgency is the real game** — attitudes, CERP, KLEs/shuras, restraint win, not body
   count. Every shot passes a civilian-fire gate (`civClear`); civilian casualties are the big penalty.
8. **Verify, don't assume** — turn fuzzy bugs into hard numbers with a headless harness in `scripts/`,
   capture a baseline, re-measure after each change, report honestly including what's still imperfect.

## Architecture map (read these first)
- **`lib/sim/world/world.ts`** — the World class: the master clock. `tick(dt)` is the single entry
  point. Also the player command interface: `formPatrol`, `conductKLE`, `reroute`, `setSOP`, `medevac`,
  `approveFireRequest`, `denyFireRequest`.
- **`state/store.ts`** — the ONLY engine↔React bridge (Zustand). `frame(realDt)` is the real-time loop:
  `world.tick(0.1)` in fixed `SIM_DT=0.1` slices scaled by `SPEEDS`; combat clamps speed; TIC is a
  one-way latch. Exposes `window.__ITM`.
- **`lib/sim/world/` package** — World stays lean and delegates to siblings that take the World as an
  arg: `create.ts`, `types.ts`, `tasks.ts`, `director.ts`, `formation.ts`, `garrison.ts`, `projects.ts`,
  `events.ts`, `helpers.ts`. **Import from the barrel `@/lib/sim/world`, never concrete files.**
- **`lib/sim/`** (pure engine): `rng.ts`, `terrain.ts` (512² @ 5 m, `LAND_COUNT=26`), `path.ts` (A*),
  `los.ts`, `ballistics.ts`, `weapons.ts`, `entities.ts` (the `Unit` interface), `combat.ts` (the ONE
  persistent `CombatSim`), `campaign.ts`.
- **`lib/sim/ai/`** — `squad-combat.ts` (squadFight DECIDES, stamps per-man intent), `friendly.ts`
  (EXECUTES each soldier + holds the `civClear` ROE gate), `insurgent.ts`, `civilian.ts`.
- **`lib/render/`** (Canvas 2D): `topo.ts` (bake-once relief + camera), `draw.ts`, `sprites.ts`
  (rasterize ~160 SVGs once, blit-many), `decoration.ts`, `combat-fx.ts`, `asset-manifest.generated.ts`.
- **UI**: `app/page.tsx` → `components/GameRoot.tsx` → Menu/Deploy/TourEnd; `components/world/WorldView.tsx`
  owns the RAF loop; `components/screens/DeployScreen.tsx` is the main in-game HUD.
- **Docs are authoritative & current** — read `docs/wiki/Architecture.md` first (ASCII layer diagram),
  then `docs/DESIGN.md`.

## Verification toolchain (all VERIFIED to exist/run)
| Tool | Command | What it gives you |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | strict TS, ~1.9s, keep green |
| Build | `npm run build` | `next build` (Next 16.2.7) |
| Lint | `npm run lint` | flat-config eslint (NOT `next lint`) |
| Smoke | `npx tsx scripts/smoke.ts` | builds world, runs 30 game-min, asserts no-NaN, serialize round-trip, prints `SMOKE OK` |
| Balance | `npx tsx scripts/balance.ts 12 45` | N deployments × minutes; casualties + STALL CHECK |
| Movement probes | `scripts/{movement-diag,opposite-gate,reachability,terrain-audit,squad-arrival,follower-strand,cohesion,route-quality,corridor-shortfall,thrash-probe,why-short,lead-trace}.ts` | the heavily-iterated suite; **read each file's doc-comment header first** |
| Combat/AI probes | `scripts/{autonomy,realism-probe,covertune,security-halt}.ts` | autonomy/ballistics/cover/perimeter metrics |
| Visual diag | `npx tsx scripts/trajectory-png.ts <seed> <out.png>` | draws actual march over terrain (also `trajectory-svg.ts`) |
| Live screenshot | `node scripts/shoot.mjs [out.png] [ppm]` | own CDP Chrome, avoids MCP-Playwright contention |
| Asset regen | `node scripts/build-asset-manifest.mjs` | regenerates the manifest from SVGs — generated, don't hand-edit |

## Standards & practices
- **Conventional Commits**: `type(scope): subject` (fix/docs/perf/feat/test/recon/chore; scope = subsystem).
- **Mandatory trailer (exact)**: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Evidence-heavy commit bodies**: numbered root causes, before→after metrics (e.g. `473ms → ~29ms`),
  which harness proved it, a `tsc/build/smoke/balance green` line.
- **Linear history** (no merge commits; rebase/ff). `git rebase -i` / `git add -i` are blocked here.
- **Branch or worktree per theme**; don't commit/push to main unless asked.
- **Docs are a first-class deliverable** — keep README, the relevant `docs/wiki/` page, `docs/issues/`
  (append a Resolution section; update the README status table; never delete), and `public/manual/`
  current with EVERY change.
- **Records**: dated `docs/progress/YYYY-MM-DD-<topic>/` folders with `report.md`/`report.html`,
  `baseline/`, `after/`, and before/after/live images. Use Playwright + `window.__ITM` for captures.
- **Modular, small, well-documented files.** Sim stays pure/deterministic/React-free; renderers stay
  React-free; `state/store.ts` is the only bridge.
- Each `scripts/` harness opens with a doc-comment: the fuzzy bug it metricizes, columns, a `Run:` line.

## Gotchas (hard-won)
- **This is NOT the Next.js you know** (AGENTS.md): Next 16.2.7 has breaking changes vs training data —
  read `node_modules/next/dist/docs/` before writing any Next/App-Router code.
- **No test framework** (no jest/vitest, no `npm test`). Verify via `npx tsx scripts/<name>.ts`.
- **tsx isn't installed locally** — `npx tsx` downloads on first use (one-time delay). No `timeout`
  binary on macOS.
- **Agent cwd resets between Bash calls**; harness imports + default output paths are RELATIVE — run
  from repo root or use absolute paths.
- **TIC is a one-way speed latch** (`_wasInContact`): contact drops to 1× and never auto-restores.
- **Exactly ONE persistent `CombatSim`** owned by the World; `Platoon.members` ARE the live sim units.
- **SOP locks in contact.** Player in-combat levers are exactly: approve/deny fires, MEDEVAC, pre-set SOP+route.
- **Two localStorage concerns**: campaign save `itm-save-v2` (versioned, serialize/loadWorld + migrations)
  vs UI layout `itm-ui-v1`. New persisted state goes in BOTH `serialize()` AND `loadWorld()`.
- **Spawns MUST use reachability-aware snapping** (`reachablePoint`→`civSafePoint`/`passablePoint`) — a
  unit in a disconnected pocket strands AND re-fires whole-map A* every tick (issue 010 stall).
- **Most movement harnesses are ADVERSARIAL** (worst village opposite the gate) — a "STUCK" there can be
  a real cliff band; cross-check with `reachability.ts` (the fair metric) before declaring a regression.
- **Doc drift**: README says 21 / DESIGN says 24 landcover classes — real is `LAND_COUNT=26` in
  `terrain.ts`. Trust the code.
- **Generated files** (`lib/render/asset-manifest.generated.ts`, `docs/visual-overhaul/asset-bible.html`)
  are overwritten — edit sources + regenerate.

## Debug handles (runtime)
- `window.__ITM` — the Zustand store. `window.__ITM.getState().world` — the live World.
- `window.__setCam(x, y, ppm)` — camera control for screenshots.

## DO-NOT list (repo-specific anti-patterns)
- No turn/phase layer; no individual-soldier in-combat order tools (combat is 100% AI).
- No jest/vitest/`npm test`. No Next.js code from memory. No importing World from concrete files (use barrel).
- No nondeterminism in `lib/sim`. No hand-editing generated files. No spawning without reachability snap.
- No new persisted state without updating `loadWorld()`. No commit/push to main unless asked; trailer mandatory.
- No standalone report `.md`s for findings — use dated `docs/progress/` folders + `docs/issues/` Resolutions.
- Don't run `shoot.mjs` and MCP-Playwright against the same Chrome. Don't trust README/DESIGN landcover counts.

## Ground-truth manifest (verified to exist — safe to reference)
- **Standing checks**: `npx tsc --noEmit` · `npm run build` · `npm run lint` · `npx tsx scripts/smoke.ts`
  · `npx tsx scripts/balance.ts 12 45`
- **~38 harnesses** in `scripts/` (smoke, balance, reachability, terrain-audit, opposite-gate, autonomy,
  realism-probe, trajectory-png/svg, shoot.mjs, build-asset-manifest.mjs, …).
- **Docs**: `README.md`, `AGENTS.md`, `docs/DESIGN.md`, `docs/wiki/{Home,Architecture,Simulation-Systems,
  AI-Doctrine,Campaign-and-COIN,Weapons,Glossary}.md`, `docs/issues/`, `docs/progress/`,
  `docs/visual-overhaul/{ART_BIBLE.md,asset-bible.html}`, `public/manual/{index,tutorial}.html`.
- **Debug handles**: `window.__ITM`, `window.__ITM.getState().world`, `window.__setCam`.
