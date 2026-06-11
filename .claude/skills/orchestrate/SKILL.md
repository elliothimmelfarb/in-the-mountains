---
name: orchestrate
description: Run a multi-agent campaign for open design spaces — recon → independent proposers → judge → synthesize, with subagent contracts and file deconfliction. Use for large open-ended efforts (design overhauls, research sweeps, "make X better" with many valid approaches). Do NOT use for bug fixes or well-scoped changes — those are solo work plus the metricize skill.
---

# Orchestrate — multi-agent campaigns

For genuinely open design spaces where independent perspectives beat one context: design overhauls, research sweeps, immersion campaigns. Past campaigns here ran 7–11 agents (soundscape research, UI/UX redesign, people-immersion) and the structure paid off — the judge or adversarial agent caught real issues the proposers missed. Spend freely on these; the waste is orchestrating work that didn't need it.

## 1 · Recon first

A parallel pass over git log, the current implementation, the harnesses, and `docs/issues/`. Distill a CONTEXT block injected into every downstream agent:

- **VERIFIED CODE FACTS** — cite `file:symbol`; agents must not rediscover the codebase.
- **The verbatim baseline** numbers.
- **A DO-NOT-RE-TRY list** of reverted approaches *with their measured failure* (e.g. "REVERTED, reachability 26→13%"); agents must not re-propose dead ends.

## 2 · Fan out independent single-axis proposers

N proposers, one lens/file-set each, **no shared draft** — independence avoids groupthink and covers more of the space.

## 3 · Judge

Score all outputs against an explicit rubric; dedupe and rank. A judge panel with distinct personas beats one judge when the quality bar is subjective (the UI/UX campaign used a 5-persona panel).

## 4 · Synthesize

Take the top-ranked proposal as the **spine** and **graft** the judge-flagged best ideas in. A seam is a shared assumption two proposals conflict on, or an integration point — find seams and reconcile; do NOT concatenate.

## The subagent contract

- Shared preamble: a concrete senior persona pinned to the bar, repo facts, hazards, and a mandatory FIRST-READ file list that *is* the contract.
- One lens / file-set per agent.
- Return a strict JSON schema: `additionalProperties: false`, explicit `required[]`, a description per field (descriptions act as inline sub-prompts), plus self-skepticism fields — `confidence`, `alreadyModeled`, `evidence` as `file:line`.
- **An empty findings list is a valid honest answer.** A subagent whose output another agent consumes returns dense structured content, not chatty prose.

## Deconfliction

- Partition **one writer per file**; give each agent its do-not-touch list.
- Diagnosis agents are read-only and assert 0 `scratch-*` files remain (`git status`).
- Expect other agents' commits to land on `main` mid-campaign — normal, rebase, never rewrite shared history.

## Plan-spine for large efforts

Numbered phases with the numeric Definition-of-Done baked into each task **title** (prefer "X down from Y", e.g. "route mean <1.2, loopy 0"):

1. **Phase 0** — recon + capture verbatim baselines *before any code*.
2. **Confirm/refute** each root cause against HEAD with dumped data.
3. **Fix** — measure each change in isolation; every implementation task names what to build, the exact integration seam it wires into, and how it's verified.
4. **A standalone verification task** naming exact commands + thresholds.

## Tournament (rare variant — has never yet been needed)

When two-plus genuinely different *architectures* could win and you can't tell which: build candidates in parallel branches/worktrees, judge against a rubric, pick or graft. In practice this repo has always done better with multiple independent probes from different angles (see the metricize skill) — reach for a tournament only when the alternatives are real architectures, not parameter settings.
