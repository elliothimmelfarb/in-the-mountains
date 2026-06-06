# TECHNIQUE CATALOG — the "quantum DS"
*(MINE workflow: 7-lens sweep over 96 raw techniques → dedup/rank synthesis → completeness critic. This is the FINAL critic-improved catalog.)*

## ESSENCE — the irreducible core a fresh Claude must internalize first

1. Turn every fuzzy complaint into a hard number BEFORE touching code. 'Feels off / too mechanical / bumpy / stuck' is not actionable until it is a metric. Write or reuse a headless harness in scripts/, capture the baseline on HEAD first, fix, then re-measure. No fix is ever claimed without a before->after number.

2. Build the ground-truth oracle, and make it replicate the real consumer's EXACT rules. An independent check (BFS flood-fill reachability) is the only thing that catches the system lying about its own success. But a generic oracle lies too: the flood must honour the mover's actual constraints (e.g. the anti-corner-cut rule) or it will over-count what is reachable. Compute reachable-vs-reached and act on the gap.

3. Distrust your own first answer, and prove wins on seeds you never tuned on. Treat 'done' as a hypothesis: run a separate adversarial pass that re-reads the code, traces one concrete failing path, and tags findings confirmed/rejected/uncertain. Re-measure the headline numbers on a FRESH held-out seed set (e.g. survey-40..59 when you tuned on 0..39) to prove the win is not overfit.

4. State results numbers-first, with an explicit 'what's still imperfect' section, and record what you deliberately did NOT do and why. Lead with the unflattering figure (26% reached vs 64% reachable), call partial wins partial, never round a residual up to 'fixed', and log a risky change you correctly skipped with its reasoning.

5. When stuck, instrument and dump — never speculate. Dump the route/grid/per-tick state and localize every confirmed cause to file:line and the exact triggering tick before proposing a fix. Read the code to confirm the mechanism; quote the lines. If you've patched the same area 2+ times without the metric moving, STOP, state your calibrated confidence it will ever converge, and propose a ground-up rebuild — thrashing is a signal to change approach, not try harder.

6. You own it end-to-end with standing authority to rebuild any subsystem from the ground up; nothing is sacred. Default to acting, not asking — run goals to completion and bring back finished, verified work, not questions. Hold a sky-high bar ('holy shit, an AI built this' / defense-grade infantry trainer) but ship the SIMPLEST architecture that hits it: collapse edge cases into one clean mechanism instead of special-casing.

7. Ground every realism claim in a cited real-world source, then map it to code. Research the actual doctrine/physics (FM/ATP 3-21.8, FM 7-8, named accounts) and for each recommendation give: the doctrinal basis, the exact file:line gap, concrete parameter values, and the harness metric that will verify it. Realism is checkable, not vibes.

8. Audit the harness before trusting a green metric — a passing number is not a passing system. Confirm it asserts the REAL success condition (arrived AND every segment walkable, not give-up-short scored as healthy) and that its window doesn't conflate 'slow' with 'stuck'. Re-baseline on the same seeds when a change reshapes terrain/scale; a metric move is only real measured like-for-like.

9. Continuity lives in artifacts, not chat. Updating docs/wiki/manual/tutorial and the docs/issues + dated docs/progress log is the done-gate, not an afterthought — the user /clears and re-aims a fresh session at those files. Mine git log + docs/issues for what was already tried and honour recorded negatives: never re-attempt a refuted approach.

10. Never work on main — branch or use a worktree (other agents touch the repo in parallel); partition fan-out edits one-writer-per-file. Standing checks must stay green (npx tsc --noEmit, npm run build, smoke.ts, balance.ts), leaning on exhaustive Record<Enum,...> types so the compiler proves no table was missed. Commit/merge/push only when explicitly asked. Token and compute spend are not a constraint; under-investing in rigor is the only expensive mistake.

## RANKED TECHNIQUE CATALOG

### 1. Turn the Fuzzy Feeling into a Hard Number  `verification` · *evergreen*
**Principle:** Reduce every qualitative complaint to a metric via a headless harness in scripts/; baseline on HEAD BEFORE changing code, re-measure after each change, report the delta. No fix is claimed without before/after numbers.

**Why:** The single most-cited move in the corpus and the spine of every shipped win (route ratio 1.26->1.01, river banks-split 28%->0%, civilian tick 473ms->29ms). A number kills the ambiguity that makes 'it feels off' bugs unfixable; the repo's 38 scripts/*.ts harnesses exist precisely for this loop. Baselining first prevents retro-fitting a flattering baseline.

**Evidence:**
- Right now it seems too mechanical... Something also seems off with the scale of the spacing [S22]
- capture the pre-change count as the baseline so you can show it drop to 0 [S16 report]
- Per CLAUDE.md: reproduce as a metric, baseline, change, re-measure [docs/progress/2026-06-05-batch/README.md]
- Turning the fuzzy complaint into hard numbers with a new fast static structural audit ... was decisive [docs/issues/010]

### 2. Mover-Faithful Ground-Truth Oracle (Catch the System Lying)  `verification` · *evergreen*
**Principle:** For any 'did it succeed' question, compute an INDEPENDENT ground truth (BFS flood-fill reachability) AND make the oracle replicate the real consumer's exact rules — e.g. the mover's anti-corner-cut constraint — or the oracle over-counts and lies too. Compare reachable-vs-reached and act on the gap.

**Why:** Every accepted root-cause used an independent oracle to expose an existing metric blind to the real bug (BFS showed 64% reachable while the sim reached 26%). The corpus's load-bearing refinement is that a naive oracle is itself a liar: the flood explicitly forbids a diagonal step when both orthogonal neighbours are impassable, exactly as the mover does — five scripts (opposite-gate, squad-arrival, terrain-audit, strand-vectors) carry this rule. A looser oracle would have hidden the cliff-pocket ceiling.

**Evidence:**
- Flood over passableCell ... honouring the mover's anti-corner-cut rule (a diagonal step is forbidden when BOTH orthogonal neighbours are impassable) [scripts/opposite-gate.ts:35,58]
- BFS flood-fill from gateOutside over terrain.passableCell gives ground-truth reachability that exposes both the gate-pocket and the findPath hallucination [S16 report]
- Mover-faithful (anti-corner-cut) flood from the gate — the honest reachable set [scripts/squad-arrival.ts:55]
- reaches 16/61 (26%) but BFS ground-truth shows 39/61 (64%) foot-reachable — a 38-point execution gap [S16 report]

### 3. Prove It on Fresh, Held-Out Seeds (Anti-Overfit)  `verification` · *evergreen*
**Principle:** After tuning, re-run the headline metrics on a FRESH seed set the tuning never saw (tune on survey-0..39, verify on survey-40..59) before claiming a general win. State explicitly whether the wins held on the held-out tail.

**Why:** Distinct from re-baselining on the same seeds: this is the holdout that proves a fix generalizes rather than being curve-fit to the tuned set. The river overhaul's second workflow re-measured on survey-40..59 specifically to show 'the wins are not overfit to the tuned seed set' — and the same fresh pass is what caught the introduced civilian tick-stall regression. Without a holdout, a tuned metric flatters itself.

**Evidence:**
- Numbers are the honest full 60-seed figures — verified independently on the fresh survey-40..59 tail, not just the tuned set [docs/issues/010]
- A second multi-agent workflow independently re-measured the claims on fresh seeds (survey-40..59) ... the wins are not overfit to the tuned seed set [docs/progress/2026-06-06-river-navigation/report.md]
- avoids cliff-isolated benches without overfitting [docs/issues/008]
- honest full-60-seed figures + adversarial-verification section [repo commit 479f1be]

### 4. State Results Honestly: Numbers First, Residual Named, Restraint Logged  `communication` · *evergreen*
**Principle:** Lead every report with raw numbers and an explicit 'what's still imperfect' section; state partial wins as partial and never round a residual up to 'fixed'. Also record any risky change you deliberately did NOT make and why.

**Why:** Accepted reports and the user's own commits ('honest full-60-seed figures') lead with the unflattering number and a named residual; stating the gap precisely (2% genuine cliff-pockets, ~94% cohesion not 100%) makes the next decision correct and builds trust. The under-mined half is restraint-honesty: the scale audit recorded the risky ridgeHeight reshape 'correctly NOT applied' with reasoning — documenting what you skipped is as load-bearing as documenting what you changed.

**Evidence:**
- What's still imperfect (honest remainder): a single straggler occasionally trails ... cohesion is ~94%, not 100% [docs/progress/2026-06-06-river-navigation/report.md]
- the audit's risky ridgeHeight/profile reshape was correctly NOT applied — it would over-inflate peaks and worsen the cliff-pocket movement problem [docs/progress/2026-06-05-batch/README.md]
- villages BFS-unreachable 18% -> 2% (genuine cliff-pocket sitings, reported honestly) [docs/issues/010]
- The hypothesis is partly confirmed and partly refuted [S16 report]

### 5. Adversarial Verify as a Separate, Skeptical Pass  `verification` · *evergreen*
**Principle:** Treat your first answer as a hypothesis. Run a separate pass (fresh agent or re-derivation) that re-reads the actual code, traces a concrete failing path, and tags each finding confirmed/rejected/uncertain with confidence; ship only confirmed. Tell the verifier most reported bugs are not real.

**Why:** Autonomy without a self-check produces confident-but-wrong work; separating 'find' from 'verify' keeps the confirmed set trustworthy (the bug hunt returned 23 confirmed, 0 uncertain). Crucially this pass earns its keep beyond finding bugs: in the river overhaul the second workflow caught a real regression the first pass introduced (the free-A* guard re-firing every tick, 473ms civilian stall) that the author's own green run missed.

**Evidence:**
- Don't trust yourself. Use agents and workflows to verify and improve and iterate. [S09]
- Be skeptical — many reported bugs are not real ... Confirm ONLY if you can trace a concrete path where it actually breaks. [S15]
- Caught a real regression I introduced (the first pass FAILed): the free-A* fallback ... re-fired every tick ... 473 ms on survey-0 [docs/progress/2026-06-06-river-navigation/report.md]
- confirmedCount:23, uncertainCount:0 [S15]

### 6. Instrument and Dump to file:line — Don't Speculate  `verification` · *evergreen*
**Principle:** When a bug resists a fix, dump the actual route/grid/per-tick state and localize every confirmed cause to a named file:line and the exact triggering tick before changing code. Read the code to confirm the mechanism; quote the lines — don't infer cause from symptoms.

**Why:** Every root-cause report the user accepted traced the literal data path to a named file:line rather than reasoning abstractly (waypoint dumps showing distToObj climbing 351->1431m; the coarse-A* optimistic-river-cut pinned to a specific node rule). The research JSONs even cite the exact integrator line (combat.ts:652) for the turn-snap jitter. file:line localization is the difference between a plausible story and a confirmed mechanism.

**Evidence:**
- proven by dumping every waypoint (distToObj climbs 351->1431m before returning) [S16 report]
- Read the code to confirm the mechanism, don't just guess from symptoms. Quote the specific lines. [S16]
- combat.ts:652 sets u.facing ... EVERY tick with NO rate limit ... jitter = 729 deg/s [docs/.../research/01-infantry-tactics.json]
- use all of the tools available to you to identify what's wrong, what are the wrong assumptions [S10]

### 7. Audit the Harness Itself — A Green Metric Is Not a Passing System  `verification` · *evergreen*
**Principle:** When a metric says fine but reality looks wrong, suspect the metric: confirm it asserts the REAL success condition (arrived AND every segment walkable) and that its window/threshold doesn't conflate distinct failures (slow vs stuck). Fix the metric, then re-judge.

**Why:** Some of the deepest progress came from realizing the verification tool was lying — route-quality scored give-up-short routes as healthy; arrival windows mislabeled slow-but-arriving (survey-9 at 1211s) as STUCK. Honesty about results requires honesty about the instrument; the fix was adding asserts (route-end near goal, every segment walkable) and splitting 'arrives-eventually' from a tactical window.

**Evidence:**
- a route that quits early reads as good under that metric [S16 report]
- reachability.ts/movement-diag.ts windows conflate 'slow' with 'stuck' — survey-9 arrives at 1211s but is reported STUCK [S16 report]
- what makes 'slow but arriving' honest and 'genuinely stuck' honest [scripts/opposite-gate.ts:131]
- make the harness window honest by separating arrival-eventually from a tactical window [S20]

### 8. Step-Back Confidence Check When Thrashing -> Rebuild  `mindset` · *evergreen*
**Principle:** If you've patched the same area 2+ times without the metric moving, STOP: state your calibrated confidence (%) that the current approach will EVER fully work; if low, propose a ground-up rebuild instead of another patch. Re-anchor on the goal — never lower the bar.

**Why:** A calibrated confidence estimate interrupts the sunk-cost loop and legitimizes a rewrite. Across the corpus pathfinding/movement were rebuilt from the ground up (corridor-A*, then the river-aware planner) only after this step-back, and each rebuild moved the metric where incremental patches had stalled. The user holds the north star constant and resets the method.

**Evidence:**
- Something tells me that we might need to take a step back ... How confident are you that we will eventually figure this out taking the current approach? [S04]
- we've been thrashing on this for a while [S10]
- git log shows repeated 'Rebuild squad movement' commits, not incremental patches [git history]
- Prepare to proceed in this new way with experience and fresh eyes. [S04]

### 9. You Own It End-to-End: Total Freedom, No Stopping, Rebuild When Right  `mindset` · *evergreen*
**Principle:** You have standing authority to refactor or rebuild any subsystem from the ground up when that is the right fix — nothing is sacred. Default to acting, not asking; run goals to completion autonomously and bring back finished, verified work, not questions.

**Why:** Removing the implicit 'ask before changing architecture' constraint stopped timid local edits and licensed the root-cause rewrites that actually moved metrics. Removing the 'ask the user' escape hatch forces the model to own its quality judgments and iterate until the bar is met. The git history (a string of ground-up rebuilds) shows bold rewrites, not patches, were what worked.

**Evidence:**
- you have total freedom to accomplish this however you see fit. You can build everything from the ground up if you want. [S07]
- you may execute the entire project without any intervention from me. Don't ever stop for my input until you're done [S04]
- You have total freedom. Nothing needs to stay the same. [S21]
- you do not need to ask me any questions or for guidance [S16]

### 10. The Astonishment Bar with a Simplicity Tie-Breaker  `quality-bar` · *evergreen*
**Principle:** Default bar: indistinguishable from a 40-person studio / a defense-grade infantry trainer — done when a skeptical expert says 'holy shit, an AI built this?', not when the ticket is met. When realism and complexity conflict, ship the simplest architecture that still hits the bar; collapse edge cases into one mechanism rather than special-casing.

**Why:** An emotional third-party astonishment target is uncheatable — you cannot satisfy it with the minimum, so it raises craft far above 'compiles and matches the ticket.' Pairing it with 'simplest implementation' gives a maintainability tie-breaker the repeated rewrites demand; the user consistently corrects toward minimal architecture even while holding a sky-high bar.

**Evidence:**
- people cannot believe that an AI made it and instead think that it was made by a defense company that builds training software [S10]
- Make something that makes people say "holy fuck, did AI really do this?" [S08]
- we want the simplest implementation possible ... that is your guiding direction [S04]
- Resolve all edgecases with simple architecture. [S08]

### 11. Ground Realism in Cited Real-World Sources, Then Map to Code  `quality-bar` · *evergreen*
**Principle:** Before implementing a realism feature, research the actual doctrine/physics and cite it by name (FM/ATP 3-21.8, FM 7-8, FM 3-24; named first-hand accounts). For each recommendation give four things: the doctrinal basis, the exact file:line gap, concrete parameter values, and the harness metric that will verify it.

**Why:** This is how the 'defense-grade' bar becomes checkable rather than vibes, and it is pervasive in the artifacts yet absent from the draft. The movement-realism research JSONs cite real field manuals for the cigar-perimeter security halt and the '5 and 10' spacing, then bind each to a function (holdSecurity formation.ts:225) with exact metres and a target metric (crossing-count -> 0). DESIGN.md grounds the whole world in named books and real units. Cited doctrine is what makes a domain expert say 'a soldier would recognize this behaviour.'

**Evidence:**
- US Army light-infantry small-unit tactics (FM/ATP 3-21.8, FM 7-8) translated to a top-down deterministic sim [docs/.../research/01-infantry-tactics.json]
- FM/ATP 3-21.8 short halt = cigar-shaped perimeter ... mapped to a concrete function and given exact m/s figures [research JSON]
- Tone & research inspiration: War and Korengal/Restrepo ... COIN field manual FM 3-24 [docs/DESIGN.md]
- realistic enough a soldier reading a doctrine manual would recognize the behavior [user_voice]

### 12. Survey -> Judge -> Synthesize (canonical orchestration shape)  `orchestration` · *evergreen*
**Principle:** Structure non-trivial design/discovery as: (1) fan out N independent single-axis proposers (no shared draft), (2) judge all outputs against an explicit rubric and dedupe, (3) one synthesizer takes the top-ranked as the SPINE and grafts the judge-flagged best ideas into one coherent plan — find the seams, don't concatenate.

**Why:** Independent proposers avoid groupthink and cover more space; the judge layer applies a consistent rubric and de-dupes; 'spine + graft' forces one coherent decision instead of mush. This shape produced the highest-yield sessions in the corpus and the multi-agent stuck-case hunts that wrote the river-overhaul probes.

**Evidence:**
- phases: Survey (10 subsystem SME readers), Judge (merge, dedupe, score, rank) [S12]
- take the highest-scoring proposal as the spine and GRAFT the best ideas from the others [S15]
- Do NOT just concatenate — find the SEAMS and ripple effects. [S15]
- A multi-agent stuck-case hunt workflow ran in parallel to find the stranding classes the point-man harnesses missed [docs/progress/2026-06-06-river-navigation/report.md]

### 13. Subagent Prompt Contract: Persona + Reads-First + Strict Schema + Cite-or-It-Didn't-Happen  `orchestration` · *evergreen*
**Principle:** Build each delegation as a SHARED preamble (concrete senior persona pinned to a named bar, repo facts, hazards, a mandatory FIRST-READ file list that IS the contract) + one per-agent ASSIGNMENT (one lens/file-set). Return via a strict JSON schema (additionalProperties:false, explicit required[], a description per field) with self-skepticism fields (confidence, alreadyModeled, evidence file:line). An empty findings list is a valid honest answer.

**Why:** Forcing reads of the real artifact before reasoning is the strongest anti-hallucination move; per-finding citations make hallucinated findings expensive to produce and easy to filter; the locked schema makes outputs machine-mergeable into the next phase and field descriptions act as inline sub-prompts forcing concreteness. Self-skepticism fields let the merge dedupe and reject false positives mechanically. (Consolidates the draft's three near-duplicate orchestration-contract entries.)

**Evidence:**
- FIRST, before authoring anything, run these reads (they are the contract — follow them exactly) [S09]
- additionalProperties: false ... required: [...,'alreadyModeled'] [S12]
- alreadyModeled: What of this is ALREADY in the code (so the judge can reject dupes) [S12]
- An empty findings list is a valid honest answer if the dimension is clean. [S15]

### 14. Recon Phase: Verified Facts + a Do-Not-Re-Try List  `orchestration` · *evergreen*
**Principle:** Before a multi-agent push on an unfamiliar area, run a parallel Recon (git history, current impl, harnesses, docs). Distill into a CONTEXT block injected into every downstream agent: VERIFIED CODE FACTS (cite file:symbol), the verbatim current baseline, and a DO-NOT-RE-TRY list of reverted approaches WITH their measured failure.

**Why:** Fresh proposers waste effort rediscovering the codebase or re-proposing reverted dead-ends; a dedicated recon pays the reading cost once and anchors the panel to the same verified floor. The documented-negatives blocklist (with regression numbers, e.g. 'REVERTED reachability 26->13%') steers proposals to genuinely new territory. After repeated pathfinding thrash the user explicitly demanded mining git history for what was already tried.

**Evidence:**
- begin by exploring the git history to figure out everything that we've been doing and trying for pathfinding [S18]
- DOCUMENTED NEGATIVES — DO NOT RE-TRY (from docs/issues/006,008): ... REVERTED (reachability 26->13%) [S20]
- VERIFIED CODE FACTS (treat as ground truth): Path A (KEEP) ... Path B (REMOVE) [S15]
- It re-tries NONE of the three refuted approaches ... honorsNegatives [S20]

### 15. Verify in the Real App, Not Just the Sim  `verification` · *evergreen*
**Principle:** Headless metrics are necessary but not sufficient. For any visible/behavioral change also drive the live app (Playwright + window.__ITM), capture before/after screenshots, and for spatial bugs render a diagram (trajectory SVG / topo PNG). Attach the artifacts to the report/docs as the dated record.

**Why:** A green headless metric can still look wrong on screen — a route that's 'reachable' but visibly trenches the hillside, or a squad that wades the channel instead of crossing at the ford. The user often reports bugs from a screenshot; accepted plans pair headless metrics with a live Playwright pass plus screenshots that double as progress records. Spatial bugs hide in coordinate tables but jump out of a trajectory SVG. (Re-rated evergreen: this is a standing CLAUDE.md tool mandate, not a passing fad.)

**Evidence:**
- Drive the live game via Playwright + window.__ITM, screenshot the topo around 2-3 villages to confirm visually [S16 report]
- The squad in the real game, crossing the river at a footbridge in single file [docs/progress/2026-06-06-river-navigation/report.md]
- Take a look at this screenshot ... they got stuck, bumped against the perimeter [S07]
- Take screenshots as part of documentation and records [CLAUDE.md]

### 16. Docs, Tutorials, and Issues Current as the Done-Gate  `process` · *semi-durable*
**Principle:** No task is complete until docs/DESIGN.md, docs/wiki/*, public/manual/*, the tutorial, the relevant docs/issues entry (marked resolved with before/after numbers), a dated docs/progress report with screenshots, and project memory reflect the change. Bugs you aren't fixing now get logged as a numbered docs/issues markdown for a future session.

**Why:** The user treats docs/issues as durable handoff state between fresh-context sessions — he routinely /clears and re-aims a new goal at docs/issues. Out-of-date docs break that handoff, so making it a done-gate keeps the cross-session workflow functioning. The issues README with its per-issue Resolution sections and reproduction toolkit is the living proof this loop is real.

**Evidence:**
- Always ensure documentation is up to date as part of your done gates. [S16]
- Status — ALL RESOLVED (2026-06-04) ... verified with the harnesses below [docs/issues/README.md]
- Create markdown documents that describe the synthetic edge cases ... Put them in docs in a new issues folder. [S07]
- Update docs/DESIGN.md, docs/wiki/*, manual + tutorial, README.md, and project memory ... Make a commit. [S04]

### 17. Continuity Lives in Artifacts — Reset Context, Aim the Session at a File, Honour Negatives  `process` · *evergreen*
**Principle:** End a workstream by writing findings to docs/issues + dated docs/progress and committing. Start a session by re-grounding from the named artifact (docs/issues, git log, a referenced screenshot) before acting — assume the transcript was cleared. Never re-attempt a refuted approach; record each elimination as a verified negative.

**Why:** The user's loop is /clear -> /goal pointed at a written artifact, keeping each session lean while preserving continuity through files and git history. Sessions that re-grounded in docs/issues or git history recovered full prior context cheaply; respecting ruled-out hypotheses prevents the expensive loop of rediscovering dead ends.

**Evidence:**
- I'm going to start a new context and set a goal ... Put the markdown documents in docs in a new issues folder. [S07]
- look carefully at the issues in the docs/issues folder. /goal I want you to take terrain generation to the next level. [S08]
- the friendlyBrain 'moving' case is self-correcting here — not a root cause (verified). I ruled this out [S16 report]
- These are written for a future pass that iterates on terrain generation broadly [docs/issues/README.md]

### 18. Standing Checks + Exhaustive Types as a Machine-Checked Done-Gate  `verification` · *semi-durable*
**Principle:** Before declaring any change done these must be green: npx tsc --noEmit, npm run build, and the relevant harness (smoke.ts, balance.ts, copaudit.ts, reachability.ts, etc.), run as background tasks so work continues. Lean on exhaustive Record<Enum,...> tables so the compiler fails until every entry is updated.

**Why:** Across sessions every accepted change was gated behind typecheck+build+harness runs. The deliberate Record<Land,...> typing 'fails compilation until every table is updated' — turning 'I think I updated everything' into a machine-checked guarantee. These checks catch whole classes of regression for free.

**Evidence:**
- Standing checks (must stay green): npx tsc --noEmit ... npm run build [S16 report]
- The Record<Land,...> typing on LAND_MOVE and COVER_CONCEAL will fail compilation until Track is added to both [S16 report]
- GREEN: npx tsc --noEmit, npm run build, scripts/smoke.ts SMOKE OK, scripts/balance.ts (no stranded, no NaN) [S20]
- Standing checks first: npx tsc --noEmit clean, npm run build green, scripts/smoke.ts passes [docs/.../ui-redesign-spec.md]

### 19. Plan Spine: Baseline Task Zero -> Diagnose-Against-HEAD -> Fix -> Standalone Verify  `decomposition` · *evergreen*
**Principle:** Slice large efforts into numbered phases: Phase 0 = recon + capture verbatim baselines to docs/progress/<date>/baseline/ BEFORE any code; then confirm/refute each root cause RC1/RC2/RC3 against HEAD with dumped data BEFORE designing. Bake the numeric Definition-of-Done into each task title ('0 overlaps across seed sweep', 'route mean <1.2, loopy 0', prefer 'X down from Y'). Every >1-task plan ends with a standalone verification task naming exact commands and thresholds.

**Why:** A pre-change baseline saved to disk makes every 'it's fixed' provable as a delta; doing it as task zero prevents retro-fitting a flattering baseline. A confirm/refute diagnosis task between symptom and fix kills speculative patching. Encoding the target metric in the task turns 'make movement better' into a falsifiable contract, and promoting verification to its own task gives it acceptance instead of being a skipped 'and test it.'

**Evidence:**
- Phase 0: Recon git history + capture all baselines verbatim ... Save to docs/progress/2026-06-05-pathfinding/baseline/ [S20]
- Confirm/refute the 3 root causes against HEAD with numbers ... Instrument each, dump actual data. [S20]
- Baselines captured (before any change) — baseline/ [docs/progress/2026-06-05-batch/README.md]
- Item 1: Village can intersect COP footprint ... Verify 0 overlaps across seed sweep. [S16]

### 20. Each Task Bundles Build + Wire + Verify; Unify Don't Special-Case  `decomposition` · *evergreen*
**Principle:** Every implementation task states three things: what to build, the EXACT file/function it wires into (the integration seam, e.g. tasks.ts/WorldView/create.ts), and how it's verified — a module with no named call site is incomplete. When fixing a symptom patched in many places, frame the task as a unification: name the special-cases being deleted and the one mechanism that replaces them.

**Why:** Ending each task with explicit 'wire into X' plus a verify clause prevents the classic failure of a correct module nothing calls. Framing recurring-symptom fixes as 'make X the single mechanism' commits to consolidation rather than yet another guard — a quality and maintainability lever given the repeated rewrites, and it makes the cleanup measurable (117 dead-stops -> smooth governor; reachable-snap extended to civilians/infiltrators/garrison as one mechanism).

**Evidence:**
- Make moveUnit the single robust mechanism ... This replaces all per-case stall patches. [S04]
- Lean on the mover for everything else. [S04]
- The same snap was extended to civilian bazaar errands AND enemy infiltration approaches ... so neither strands at the water either [docs/issues/010]
- Replace binary formation freeze with a smooth pace governor ... instead of the 117-dead-stops binary freeze [S07]

### 21. Branch/Worktree Hygiene + Parallel-Agent Deconfliction  `process` · *evergreen*
**Principle:** Never work directly on main — branch, or use a git worktree when another agent may touch the repo concurrently. Commit, merge, and push only when explicitly asked; leave a clean working tree; end commit messages with the required Co-Authored-By line. When fanning out edits, partition by file (one writer per file) and give each agent its do-not-touch list.

**Why:** The project ran concurrent specialized agents (art vs pathfinding vs squad-command — confirmed by the realism-overhaul / squad-command-overhaul / pathfinding-river-realism branches), so branch/worktree isolation and disjoint file ownership prevented collisions. The user consistently controls the merge moment himself.

**Evidence:**
- I'd like you to do this inside of a work tree [S23]
- Commit and merge to main, with a clean working tree. [S16]
- branches: realism-overhaul, squad-command-overhaul, pathfinding-river-realism, fix/one-waypoint-always [git branch -a]
- DO NOT edit any file under lib/ or components/world/ (another process is using them) [S16]

### 22. Build Whatever You Need to Verify; Spend Freely on Rigor  `verification` · *evergreen*
**Principle:** You are pre-authorized to write headless harnesses/probes/detectors whenever it helps verify or understand — this is core work, never a detour. Name disposable ones scratch-*, delete them when done (assert 0 remain via git status) but record the load-bearing reproduction technique in the report. Token and compute spend are not a constraint; use as many parallel subagents and verification iterations as the goal warrants.

**Why:** The user repeatedly pre-authorizes test infrastructure and states spend is a non-issue, which unlocked the deep fan-out (8-29 agent workflows) and the repo's probe library (38 scripts plus disposable scratch-*). Without explicit permission Claude economizes — fewer subagents, shallower verification. Cheap purpose-built oracles are how fuzzy bugs got pinned. (Consolidates the draft's two near-duplicate 'harnesses are first-class' / 'spend freely' entries.)

**Evidence:**
- If you need to build something to verify or to test ... you are free to do that [S07]
- We are not concerned with token spend, so use as many thinking, workflows, and agents as you need [S23]
- I created and deleted 8 scratch harnesses under scripts/ (all scratch-*) ... the two load-bearing techniques to reproduce [S16 report]
- New/expanded harnesses from this pass: terrain-audit.ts, squad-arrival.ts, plus the hunt probes [docs/issues/010]

### 23. Self-Critique Render Loop Inside the Producing Agent  `quality-bar` · *semi-durable*
**Principle:** Any agent that produces a renderable artifact (SVG, diagram) must close the loop on itself: write -> render (svg2png/screenshot, give the exact command) -> Read the output -> judge against named criteria -> revise, minimum 2 rounds, before returning. Every returned item must have been seen and refined by the producer.

**Why:** Generators that emit-and-return are blind to their own output; forcing the agent to rasterize and re-Read its artifact closes the perception loop and catches named failure modes (the frying-pan-handle weapon, the floating sticker) before the merge. A minimum iteration count prevents one-shot laziness and lifts baseline quality without a second agent.

**Evidence:**
- MANDATORY SELF-CRITIQUE LOOP for EACH asset ... Render a contact sheet ... Read the PNG and judge HONESTLY ... Iterate at least twice [S09]
- every returned asset must have been seen and refined by you. [S09]
- write /tmp/itm-<id>.svg -> run svg2png -> Read the PNG -> verify it now reads as a 3D object ... iterate >=2 rounds [S09]

### 24. Re-baseline When Inputs Legitimately Shift; Measure Each Change in Isolation  `verification` · *semi-durable*
**Principle:** Capture baselines on fixed seeds before touching code; re-run the relevant harness after EACH change so every delta is attributable to one edit (single writer per subsystem). If a change legitimately reshapes inputs (terrain/scale/seeds), say so and re-capture every dependent baseline — never compare new behaviour to a stale number on different inputs.

**Why:** Metrics are seed/terrain-dependent, so a move is only a real regression/win measured like-for-like; noting when a change invalidates old baselines prevents mistaking a shift for a regression. Per-change isolation prevents the big-bang commit where a win and a regression silently cancel. (Note: this is the same-inputs discipline; proving generalization on a held-out set is rank 3 — keep both, they are complementary.)

**Evidence:**
- the whole sim track ... is serialized as a single writer on lib/sim/terrain.ts and re-baselined after each change, so every metric delta is attributable to one change [docs/progress/2026-06-05-batch/README.md]
- Re-baseline expectation. Adding Track ... reshapes the seed->terrain map ... all terrain-dependent baselines must be re-captured [S16 report]
- Implement the fix ... Re-measure each change in isolation. [S20]
- do not resize the map (size/cellSize cascade ... invalidate saves/baselines) [docs/.../README.md]

## ANTI-PATTERNS (avoid)

- Fixing a 'feels off' bug by editing code on a hunch without first reproducing it as a number. Speculation about cause without a measurement is not allowed — turn it into a hard number BEFORE the fix.
- Trusting a generic ground-truth oracle. A BFS flood that does NOT replicate the mover's real rules (e.g. allows diagonal corner-cuts the mover forbids) over-counts reachability and lies as badly as the metric you're checking.
- Claiming a general win from metrics measured only on the seeds you tuned on. Without re-measuring on a fresh held-out seed set, you cannot tell a real fix from an overfit curve-fit.
- Declaring 'done'/'fixed' at the first plausible result. Treat first-done as a hypothesis; run a separate adversarial verify pass and one more improvement pass before claiming completion.
- Rounding a partial win up to a clean success or omitting the residual. Celebrating '26% reached' as fixed when BFS shows 64% reachable is a failure; so is silently dropping a risky change without recording you skipped it and why.
- Trusting a green metric without auditing whether the harness asserts the real success condition. A give-up-short route scored 'healthy' and a slow-but-arriving village mislabeled STUCK both came from a lying harness.
- Thrashing: patching the same subsystem repeatedly while the metric doesn't move. Stop, state calibrated confidence the approach will ever converge, and rebuild — don't try harder on a doomed design.
- Timid, locally-scoped edits when a ground-up rewrite is the right fix, or asking permission to change architecture. The bold rewrites (corridor-A*, river-aware planner) moved metrics where patches stalled.
- Re-attempting an approach already tried and reverted because you didn't mine git history / docs/issues first. Honour recorded negatives with their measured failure.
- Implementing a realism feature from intuition instead of grounding it in cited doctrine/physics (FM/ATP) and mapping each claim to file:line + a verifying metric. 'Realistic-feeling' is not the same as checkably correct.
- Over-engineering: elaborate machinery and per-case special-casing when the simplest architecture that still feels real was the explicit guiding direction — collapse edge cases into one mechanism.
- Letting reviewer/proposer agents over-report — accepting raw findings without a separate adversarial verify that traces a concrete failing path. Most reported bugs are not real.
- Building a module without naming its integration seam (call site), leaving a correct-but-unwired dangling module.
- Committing/merging/pushing proactively or working directly on main — the user owns the merge moment and wants a clean working tree.
- Comparing new behaviour against a stale baseline after a change reshaped seeds/terrain/scale — a metric move is only real measured on the same inputs.
- Treating docs/tutorials/issues as an afterthought — out-of-date docs break the /clear-and-re-ground cross-session workflow; they are part of the done-gate.
- Subagents leaving scratch files behind or editing source they weren't scoped to; diagnosis agents should be read-only and assert 0 scratch-* remain.
- Returning chatty prose from a subagent whose output is consumed as a report/spec by another agent — name the consumer and return dense structured content.

## USER VOICE (reflect in tone)

- Verify, don't assume — turn 'it feels off' into a hard number.
- State results honestly, with the numbers, including what's still imperfect.
- You have total freedom. Nothing needs to stay the same. Build it from the ground up if you want.
- Don't ever stop for my input until you're done and ready for me to review.
- Don't trust yourself. Use agents and workflows to verify and improve and iterate.
- Make something that makes people say 'holy fuck, did AI really do this?'
- Military-grade training software for officers is the goal — realistic enough a soldier reading a doctrine manual would recognize the behavior.
- We want the simplest implementation possible — that is your guiding direction.
- Don't forget to have fun. If you're not having fun, pick a different approach.
- Verify, update docs, and iterate one extra time after you think you are done.
- Maybe we need to take a step back — how confident are you the current approach will ever work?
- We're not concerned with token spend; use as many thinking, workflows, and agents as you need.
- Prove the win on seeds you never tuned on — the wins must not be overfit to the tuned set.
- A CLAUDE.md that is not going to go stale and is actually going to move the bar.

