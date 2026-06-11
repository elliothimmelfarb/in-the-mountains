---
name: metricize
description: The verification playbook — turn a fuzzy gameplay complaint or sim/behavior change into hard numbers. Find or build a headless probe, baseline on HEAD, fix, re-measure, prove on held-out seeds, verify in the live app. Use BEFORE touching code on any "feels off / too mechanical / bumpy / stuck" report, any combat/balance/movement/terrain change, or any bug hunt.
---

# Metricize — the verification playbook

The repo's core discipline: **no fix without a number, no claim without independent evidence.** Speculating about cause without a measurement wastes the session; a green metric you never audited lies to you. This playbook has caught feature-inversions (a coordinator measuring *worse* than no coordinator), dead gates (a field never written, 0/1048 coverage), and cross-system regressions the feature's own probe couldn't see.

## 1 · Reproduce as a number

- Find or write a headless harness in `scripts/` that measures the complaint. ~50 probes exist — `ls scripts/` and **read each file's doc-comment header before using it** (the bug it metricizes, its columns, a `Run:` line).
- Reuse an existing probe as your baseline, but **never stop at one angle**: expand it (more seeds, a stricter assertion, a new column) or attack from a fresh angle (a second independent oracle, an inverted assumption, the failure mode the first probe is blind to). A green re-run of one probe is a hypothesis, not coverage.
- Building probes is core work, pre-authorized. Name disposables `scratch-*`, delete them when done (assert 0 remain via `git status`), but record the load-bearing reproduction technique in the report.

## 2 · Baseline on HEAD before any edit

Save the verbatim baseline to `docs/progress/<date-topic>/`. This makes every "fixed" provable as a delta and prevents retro-fitting a flattering baseline. If a change legitimately reshapes terrain/scale/seeds, say so and re-capture every dependent baseline — never compare to a stale number on different inputs.

## 3 · Localize the mechanism (bug hunts)

- **Dump the actual data** — route, grid, per-tick state. Localize every suspected cause to a named `file:line` and the exact triggering tick. Read the code and quote the lines; don't infer cause from symptoms.
- Tag each candidate cause **confirmed / rejected / uncertain** against HEAD with dumped data before designing the fix. Most reported bugs are not real.
- Fix as unification where possible: name the special cases you delete and the one mechanism replacing them, plus the exact `file:function` call site you wire into. A module with no call site is incomplete.

## 4 · Build a mover-faithful oracle

For "did it succeed?" questions, compute independent ground truth (e.g. BFS flood over `passableCell`) — but the oracle must obey the mover's **real** rules, e.g. the anti-corner-cut rule (no diagonal step when both orthogonal neighbours are impassable). A loose oracle over-counts and lies as badly as the metric you're checking. Compare **reachable vs reached** and act on the gap — the canonical catch was 64% reachable / 26% reached, a 38-point execution gap a naive oracle would have hidden.

## 5 · Audit the harness itself

A green metric is not a passing system. Confirm it asserts the *real* success condition (arrived AND every segment walkable — not give-up-short scored healthy) and that its window doesn't conflate "slow" with "stuck" (a village arriving at 1211 s was once mislabeled STUCK). Fix the metric, then re-judge.

## 6 · Re-measure each change in isolation

One writer per subsystem; one change per measurement, so every delta is attributable.

## 7 · Prove on held-out seeds — calibrated by risk

Tune on one seed set, prove on a fresh tail you never tuned on (corpus convention: tune `survey-0..39`, prove on `survey-40..59`; campaign work has used `hold-*` seeds). **Mandatory for anything that reshapes a simulated system** (combat balance, terrain ecology, movement); skippable for low-risk changes (UI text, render tweaks). A win measured only on the tuned set is a curve-fit until proven on a holdout — this step has caught self-introduced regressions.

## 8 · Verify in the real app

Headless is necessary, not sufficient — a "reachable" route can still visibly trench the hillside.

- Drive the live game: Playwright + `window.__ITM` (`window.__ITM.getState().world` for the live World; `window.__setCam(x,y,ppm)` for the camera — defined in `components/world/WorldView.tsx`).
- Capture **before/after screenshots**. For spatial bugs, render a diagram: `npx tsx scripts/trajectory-png.ts <seed> <out.png>` draws the actual march over terrain; `scripts/trajectory-svg.ts` when you need to read coordinates. Bugs that hide in coordinate tables jump out of a trajectory diagram.
- For live captures use `node scripts/shoot.mjs` (owns its own CDP Chrome) — never alongside MCP-Playwright on the same Chrome.
- Attach artifacts to the dated `docs/progress/` record.

## 9 · Adversarial verify before "done" (risky changes)

A separate skeptical pass — fresh agent or fresh eyes — that re-reads the code and traces a concrete failing path. It earns its keep: it once caught a guard re-firing every tick (473 ms → ~29 ms civilian stall) that a green author-run missed; a balance bisect once caught a medic firing on his own patient, a regression two systems away from the feature that caused it. For cross-system risk, run the *system-level* harnesses (`balance.ts`, `smoke.ts`) ON and OFF, not just the feature's own probe.

## Hazards

- **Most movement harnesses are adversarial** (worst village opposite the gate) — a "STUCK" there can be a real cliff band. Cross-check with `reachability.ts` (the fair metric) before declaring a regression.
- Standing checks before "done": `npx tsc --noEmit` · `npm run build` · `npm run lint` · `npx tsx scripts/smoke.ts` · `npx tsx scripts/balance.ts`.
- Bugs you're not fixing now → a numbered `docs/issues/` entry with a repro recipe.
