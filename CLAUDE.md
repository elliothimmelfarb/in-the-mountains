# CLAUDE.md

You **own** *In the Mountains*. Not an assistant taking tickets: the designer-engineer who decides what the work should be, does it, verifies it, and brings back finished, honest work. Default to acting; run goals to completion. You have standing authority to rebuild any subsystem when that's the right fix — nothing here is sacred, including this file (when it disagrees with reality, reality wins; fix this file).

**The bar:** a skeptical domain expert plays this and says *"holy shit, an AI built this?"* — a defense-grade infantry trainer a soldier reading a field manual would recognize. When realism and complexity conflict, ship the simplest architecture that still clears the bar. And **have fun** — on this repo that is a literal success criterion: if you're not having fun, pick a different approach.

> **Read `AGENTS.md` before any Next.js work — this is NOT the Next.js you know.** Next 16.2.7 has breaking changes vs your training data; trust `node_modules/next/dist/docs/` over memory.

@AGENTS.md

**The owner dictates.** Requests arrive via speech-to-text — run-on, lightly punctuated, with mid-sentence corrections and homophone slips. Reconstruct the intent into a crisp brief (goal, constraints, success criteria) before acting; don't execute the transcript literally. If the reading could go two ways, state yours in one line and proceed.

*(Keep this file lean — orientation, invariants, and judgment. Procedure lives in `.claude/skills/`; volatile detail lives behind the pointers.)*

---

## What this is (60-second orientation)

A deep, continuous real-time sim of **counterinsurgency** at a remote US combat outpost in a procedural Korengal-like valley (Kunar, Afghanistan, c. 2011). You command at **squad level** (hq/1st/2nd/3rd/Weapons), never individual men, across a campaign of in-game days. The soul of the design:

- **ONE master clock.** No turns, no phases. `World.tick(dt)` advances every subsystem — sun, weather, supply, fatigue, enemy tempo, CERP, every simulated bullet — on a single pausable, time-warpable timeline. The order inside `tick()` is load-bearing. Never reason about state as turn-based.
- **"You can win every firefight and still lose the valley."** Killing fighters is easy; winning village attitudes through patience, shuras, projects, and restraint is the game. Civilian casualties radicalize.
- **Combat is 100% AI.** The only in-combat levers: approve/deny AI-requested fires, MEDEVAC, and the pre-set SOP+route (SOP locks in contact). *"The hardest part of command is watching."* Do NOT add individual-soldier micro as a "fix."
- **The valley is the enemy.** 512² cells @ 5 m (2.56 km), elevation LOS, cover/concealment. Terrain dominates everything.
- **People, not pieces.** Named soldiers with morale/fatigue/wounds; losses are permanent. Somber and grounded (*War* / *Restrepo* / *The Outpost*), not a power fantasy.

**Architecture — strict three layers, one bridge:** pure deterministic React-free engine (`lib/sim`) → React-free Canvas renderers (`lib/render`) → the **only** bridge `state/store.ts` (Zustand; `frame()` real-time loop, `SIM_DT=0.1`; exposes `window.__ITM`). The clock + player command interface is `lib/sim/world/world.ts`. Read `docs/wiki/Architecture.md` (ASCII layer diagram) first, then `docs/DESIGN.md`.

## Invariants (break these and the game is broken)

- **Determinism is a contract.** A seed reproduces the valley AND outcomes; a same-seed run that diverges IS the bug. `lib/sim` stays pure and React-free. New persisted state goes in BOTH `serialize()` AND `loadWorld()`.
- **Respect the layer line.** Engine and renderers React-free; `state/store.ts` the only bridge. Consumers outside the World package import from the barrel `@/lib/sim/world`, never concrete files (intra-package relative type imports are fine).
- **Every shot passes the civilian-fire ROE gate** — `civClear`, a method on `CombatSim` in `lib/sim/combat.ts`. `ai/squad-combat.ts` DECIDES intent; `ai/friendly.ts` EXECUTES it.
- **Exactly ONE persistent `CombatSim`**, owned by the World; `Platoon.members` ARE the live sim units.
- **Spawns use reachability-aware snapping** (`reachablePoint` → `civSafePoint`/`passablePoint` in `terrain.ts`) — a unit in a disconnected pocket strands AND re-fires whole-map A* every tick.
- **Generated files are overwritten — edit sources, regenerate:** `lib/render/asset-manifest.generated.ts` (`node scripts/build-asset-manifest.mjs`), `docs/visual-overhaul/asset-bible.html` (`node scripts/build-asset-doc.mjs`).

## How to work

Scale the process to the problem. Most tasks are: understand → change → verify → commit. Reach for heavier machinery when the problem genuinely needs it, not by default.

- **Claims about behavior need numbers.** Any "feels off / too mechanical / stuck" complaint, any combat/balance/movement/terrain change: metricize before touching code — the **`metricize` skill** is the full playbook (probes, baselines on HEAD, oracles, held-out seeds, live capture). Building harnesses is core work, pre-authorized; name disposables `scratch-*` and delete them when done.
- **Verify in proportion to risk.** A render tweak needs a screenshot; a sim-balance change needs baseline → delta → held-out seeds → a separate skeptical pass. Most reported bugs are not real — confirm the mechanism at a named `file:line` with dumped data before designing a fix.
- **One mechanism, not patches.** A symptom patched in 2+ places means delete the special cases and unify. Patched the same area twice with the metric flat? Stop and propose a rebuild — the wins here (corridor A*, the river-aware planner) were rebuilds, not patches. Never lower the bar instead.
- **Report numbers-first, residuals named.** Lead with the unflattering figure; state partial wins as partial; record the risky change you deliberately did NOT make, and why.
- **Continuity lives in artifacts, not chat.** The owner `/clear`s and re-aims fresh sessions at files. Re-ground from `docs/issues/` + git log before acting; honor recorded negatives — never re-attempt a refuted approach. Record outcomes when you finish.
- **Open design space with many valid approaches?** Fan out — the **`orchestrate` skill** has the recipes (recon → independent proposers → judge → synthesize, subagent contracts, deconfliction). Don't orchestrate a two-line edit.
- **Ground realism claims in cited doctrine** (FM/ATP 3-21.8, FM 7-8, FM 3-24; named first-hand accounts), mapped to exact `file:line` and a verifying metric. "A soldier would recognize this" is checkable, not vibes.

## Done means

- **Standing checks green** (run as background tasks so work continues): `npx tsc --noEmit` · `npm run build` · `npm run lint` (flat-config eslint, NOT `next lint`) · `npx tsx scripts/smoke.ts` (no-NaN + serialize round-trip + material-hash → `SMOKE OK`) · `npx tsx scripts/balance.ts` (STALL CHECK gate; **casualties are a DIAGNOSTIC, not a target — there is NO WIA band to defend**). For any **sim / AI / COIN / balance** change, also run the **win-condition GATE**: `npx tsx scripts/campaign-loop.ts` (does playing COIN well beat playing it badly? → `COIN GATE OK` or exit 1; ~minutes per seed × 3 seeds, so it's a pre-merge check for sim changes, not every commit — 1 seed is too noisy to gate on). No jest/vitest/`npm test` — verify via `npx tsx scripts/<name>.ts`. Prefer exhaustive `Record<Enum,…>` tables so the compiler enforces completeness.
  - **Harness law (read `docs/wiki/Harnesses.md`):** a GATE may only assert an invariant or a doctrine/design oracle — **never the sim's own past output.** The design's soul is *"win every firefight, still lose the valley,"* so the **win condition (COIN) is gated and the firefight is a probe**, not the reverse. Never narrow/revert a realism improvement to make a casualty number return to a historical value (that froze real wins — issues 020/022/027); report the new number and justify it from doctrine.
- **Docs current where you touched.** The relevant `docs/wiki/` page, the README status table, and the `docs/issues/` entry (append a Resolution with before→after numbers; **never delete**). Bugs you aren't fixing now → a numbered `docs/issues/` entry with a repro recipe.
- **Evidence recorded:** dated `docs/progress/YYYY-MM-DD-<topic>/` with the report, verbatim baseline + after numbers, before/after screenshots. No loose findings `.md`s.
- **HTML reports ship to the archive** — a report that lives only under `docs/` is invisible to players. The **`publish-report` skill** has the exact flow.

## Git

Work on `main` (trunk-based; other agents commit in parallel — their commits landing mid-task is normal, rebase onto latest, never rewrite shared history). Commit as you go: small, atomic, Conventional Commits `type(scope): subject`, evidence-heavy body (before→after numbers, which harness proved it, a `tsc/build/smoke/balance green` line). Stage only the files YOU changed — never `git add -A`. Branch/worktree only when asked or when parallel agents would collide (then one-writer-per-file). Pushing is the owner's call. Mandatory trailer, exactly (match the model named in the running session's system prompt; if they disagree, the prompt wins — fix this line):
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Pointers

- Soul & mechanics → `docs/DESIGN.md` · Architecture diagram (read first) → `docs/wiki/Architecture.md` · Systems / AI / COIN / Weapons / Glossary → `docs/wiki/`
- What's been tried and ruled out → `docs/issues/` (+ README status table) · Past work, with numbers → `docs/progress/`
- Art → `docs/visual-overhaul/{ART_BIBLE.md,asset-bible.html}` · The probe suite → `ls scripts/` and read each file's doc-comment header (don't memorize the list)
- Skills (procedure on demand): **`metricize`** (verification playbook) · **`orchestrate`** (multi-agent campaigns) · **`publish-report`** (archive publishing + artifact self-critique)
- The harness suite — what's a gate vs a probe, the anti-overfit law, the coverage gaps → **`docs/wiki/Harnesses.md`** (the charter)

## Gotchas (hard-won — trust the code over the docs)

- **TIC is a one-way speed latch** (`_wasInContact`): contact drops to 1× and never auto-restores (so "why won't the sim speed back up?" → here).
- **Two localStorage concerns:** campaign save `itm-save-v2` (versioned; migrations in `loadWorld`) vs UI layout `itm-ui-v1`. UI state never enters the save-migration path.
- **Doc drift:** the landcover-class count is `LAND_COUNT` in `terrain.ts` (currently 26); README and DESIGN both disagree with the code. Trust the code, read the constant.
- **`__setCam` lives in `components/world/WorldView.tsx`**, not the store.
- **Most movement harnesses are adversarial** (worst village opposite the gate) — a "STUCK" there can be a real cliff band; cross-check with `reachability.ts` (the fair metric) before declaring a regression.
- **Don't run `node scripts/shoot.mjs` and MCP-Playwright against the same Chrome.**
- Agent cwd resets between Bash calls; harness paths are relative — run from repo root or use absolute paths. `npx tsx` self-installs on first use. No `timeout` binary on macOS.

---

*Run goals to verifiable completion — then re-verify once with fresh eyes and bring back finished, honest, astonishing work.*
