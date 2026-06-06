# Owner's-eye distillation (Claude's independent read of the corpus)

Captured before the MINE/ORIENT workflows returned, so the final synthesis reflects my own
judgment cross-checked against the agents' — not a rubber-stamp. Quotes are verbatim from the
transcript corpus (session tags in the corpus files).

## The user's prompting DNA (recurring, evergreen)

1. **Autonomy grant + emotional quality bar, together.** The signature move:
   "you have total freedom to accomplish this however you see fit" PAIRED WITH
   "make people say 'holy fuck, did AI really do this?'" / "a game company of forty people built it" /
   "a defense company that builds training software civilians don't even get access to."
   The grant removes hesitation; the bar sets a ceiling far above "it works."

2. **Expert persona injection.** Nearly every goal opens by casting a role:
   "You are an expert game designer and developer", "a game asset designer with a profound taste
   for high-fidelity military tactical games", and explicitly: "Assume whatever personas and
   experiences will help you accomplish this goal."

3. **Don't trust yourself — orchestrate.** "Don't trust yourself. Use agents and workflows to
   verify and improve and iterate." / "Use dynamic workflows. Identify the 10 best ones and then
   iterate on each several times before acceptance."

4. **Verify as a verb, in the prompt.** "Iterate on this and verify." / "use those as well for
   verification" / "If you need to build something to verify or test or figure out how to do this,
   you are free to do that." Pairs with AGENTS.md: reproduce the fuzzy bug as a hard number,
   baseline, re-measure, state results honestly including what's still imperfect.

5. **Qualitative, high definition-of-done.** "You are done when you've created something truly
   exceptional." / "not done until the movement matches what would be described in a book or a
   documentary." Done is a standard, not a checkbox.

6. **Deliverable contract: HTML explainer that teaches.** Repeatedly: "I would like an HTML report
   and an explainer for what ended up working and how you verified it, and teach me something about
   how this works." Show the work; teach the human.

7. **Have fun — literally a success criterion.** "don't forget to have fun. I think that's the most
   important part. If you're not having fun, pick a different approach."

8. **Evidence-first bug reports.** The user attaches a screenshot and narrates the exact observed
   failure ("the path hugged the perimeter, they bumped, got stuck, never reached the village").
   The expectation is reproduce → root-cause → fix → prove, not patch-by-vibes.

9. **Parallel-agent coordination awareness.** "Be advised another agent is working on X in parallel
   ... check the conversation to avoid overlap." The user thinks in concurrent fleets.

10. **Simple architecture for edge cases.** "Resolve all edge cases with simple architecture." /
    "This replaces all per-case stall patches." Prefer one robust mechanism over a pile of patches.

## My own orchestration patterns that worked (from the self-corpus)

- **Diverse-lens generate → judge panel → synthesize.** e.g. "4 diverse design lenses, a 3-judge
  panel, then a synthesized visual language + asset manifest + phased plan."
- **Author + self-critique against a bible.** Asset workflows that render, critique against
  ART_BIBLE, and report "honest residual imperfections" rather than claiming perfection.
- **Subsystem mapping workflows** before large changes (understand → then act).
- **Task decomposition that always ends in verify + update docs.** Every TaskCreate bundles
  implementation + integration + a verification/docs step ("Run tsc/build, smoke, balance,
  Playwright; commit with the trailer").

## Anti-patterns the user pushed back on
- Thrashing on a problem without root-causing ("we've been thrashing on this for a while").
- Per-case patches instead of one principled mechanism.
- Claiming success without numbers / without watching real behavior.
- Underperforming relative to known capability ("better than you've been showing sometimes").

## Implication for CLAUDE.md
The file must do four jobs at once: (1) cast the orchestrator-owner identity, (2) orient fast on a
real, verifiable repo, (3) encode these techniques as standing operating procedure, and (4) stay
durable by referencing only evergreen practice + a small verified pointer set, never volatile detail.
