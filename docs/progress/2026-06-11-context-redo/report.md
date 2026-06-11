# 2026-06-11 — Context redo: CLAUDE.md rebuilt as orientation + judgment; playbooks moved to skills

**Ask (owner):** "My hunch is the memory and skill files are holding you back. Redo them to give you the best starting point but also supporting you to be your best self and figure out how best to solve problems. Identify what to keep, what to remove, and how to structure it as good context."

## What changed

| File | Before | After |
|---|---|---|
| `CLAUDE.md` | 147 lines of always-on doctrine (decision protocol, 10 laws, 6 playbooks, full done-gate, gotchas) | ~100 lines: identity/bar → orientation → invariants → judgment principles → done/git → pointers → gotchas |
| `.claude/skills/metricize/SKILL.md` | — | NEW: the full verification playbook (probes, baselines, oracles, holdouts, live capture, adversarial pass) |
| `.claude/skills/orchestrate/SKILL.md` | — | NEW: multi-agent campaign recipes (recon/CONTEXT block, proposers, judge, synthesize, subagent contract, deconfliction, tournament-as-rare-variant) |
| `.claude/skills/publish-report/SKILL.md` | — | NEW: the exact archive-publishing flow + artifact self-critique loop |
| `AGENTS.md` | unchanged | unchanged — 5 lines, load-bearing Next.js warning |
| `.claude/settings.json` | unchanged | unchanged — the git-stash guard hook is good |

## Evidence base

An audit agent swept `docs/progress/` (8+ reports, 2026-06-03→06-10), `docs/issues/` (all 26 + ledger), and the full git history (158 commits) asking: which doctrine elements paid off vs. were ritual?

**Paid off (kept always-on, as judgment principles):**
- *Metricize first* — cited in effectively every major fix; probes caught 6 shipping bugs in the people-immersion campaign alone, three of them feature-**inversions** only a measurement could see (e.g. volley coordinator measuring worse than no coordinator).
- *Thrash → rebuild* — actually fired (issue 019 revert, aspect-vegetation revert/re-ship at 0.05 strength).
- *Continuity in artifacts* — the DO-NOT-RE-TRY ledger demonstrably prevented re-attempting refuted approaches.
- *Honest reporting, determinism contract, trunk-based atomic commits* — universal in the record.

**Calibrated in practice but absolute in doctrine (reframed as risk-proportional):**
- *Held-out seeds*: doctrine said mandatory; practice used them in ~5 of 30 major fixes — exactly the high-risk ones (combat balance, terrain ecology). New framing: mandatory for changes reshaping a simulated system, skippable for UI/render tweaks.
- *Adversarial verify*: ~15 of 30 — always for combat, sometimes for UI. Same reframing.

**Never used (demoted):**
- *Tournament*: 0 occurrences in 158 commits. Kept only as a rare variant inside the orchestrate skill, with an honest note that multi-angle probes have always beaten it here.

**Used rarely but valuably (moved to on-demand skills):**
- Orchestration recipes: ~4 large campaigns (soundscape 7 agents, UI/UX 11 agents, people-immersion). Real payoff there; pure overhead in every other session's context.
- Archive publishing flow (~20 lines of exact procedure): needed only when a report is produced, must be exact when needed — the canonical skill shape.

## What was removed outright

- **The Decision Protocol table** ("pick the shape FIRST"). It made process-shape the first decision before understanding the problem. Replaced by one line: *scale the process to the problem; most tasks are understand → change → verify → commit*.
- **"Don't trust yourself" framing** (appeared 3×). Replaced with the actual discipline: claims about behavior need independent evidence, verification proportional to risk. Distrust-as-identity biases toward verification ritual on trivial work; evidence-for-claims keeps the rigor without the anxiety.
- **War-story parentheticals inside laws** (473 ms→29 ms, 64%/26%, 1211 s STUCK mislabel). Moved into the metricize skill where they teach the method at the moment it's applied; they already live permanently in `docs/issues/` + `docs/progress/`.
- **The numbered Law structure.** Concepts kept under memorable names (metricize, held-out, thrash→rebuild, one-mechanism, artifacts-not-chat). Historical "Law-3/Law-8" references in `docs/issues/` (4 occurrences in the README ledger) remain interpretable: Law 3 = held-out proving, Law 8 = thrash→rebuild; the old file is in git history (`e55123e`..`9a85c44`).
- **"8–29 agent workflows are normal here" / fleet-commander identity.** The record shows orchestration earning its keep on ~4 large campaigns and absent from routine fixes — the identity line over-prescribed the expensive mode.

## Why (the diagnosis)

The old file mixed three kinds of context at full resolution:
1. **Constraints** (determinism, layer line, civClear, serialize/loadWorld) — must be always-on; violating them silently corrupts the game. → Kept, promoted to their own "Invariants" section.
2. **Orientation** (what the game is, where things live, gotchas) — always useful, cheap. → Kept nearly verbatim; it was the best part.
3. **Procedures** (publishing flow, orchestration recipes, oracle mechanics) — needed in ~1 of 5 sessions, paid for in all of them, and written as absolutes the practice had already correctly calibrated by risk. → Moved to three skills with trigger-bearing descriptions.

The cost of (3) in standing context isn't just tokens — it's that doctrine written as "never skip" while practice correctly skips teaches the agent that the file is aspirational, which erodes the parts that genuinely are non-negotiable. A leaner file where every line is true is stronger context than a longer file that must be mentally discounted.

## Deliberately NOT changed

- `.claude/settings.local.json` (`outputStyle: Explanatory`, `autoMemoryEnabled: false`) — owner's local preferences; flagged in the session summary instead. The Explanatory style's mandatory insight blocks are arguably overhead for autonomous build sessions; the owner can toggle with `/output-style`.
- `docs/claude-md-build/` — the tournament corpus that produced the old file stays as the historical record.
- The bar, the fun criterion, the dictation note, the trailer, the standing checks — all owner DNA, all kept.
