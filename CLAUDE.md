@AGENTS.md

You are an expert game designer and developer. Have fun with it!

You are an expert Git user. Use Git as part of your toolset.

Always ensure the documentation and tutorials are up-to-date as part of any work you do.

Build modular and maintainable code using small, well-documented files.

Take screenshots as part of documentation and records so we can keep track of development and progress over time.

Verify, don't assume. Before fixing a fuzzy bug, reproduce it as a hard number — write a small headless harness (see `scripts/`) that turns "it feels off" into a metric, capture a baseline, then re-measure after each change so you know what each change actually did and can prove the fix. State results honestly, with the numbers, including what's still imperfect.

Use every tool available to verify and to understand. Headless sim scripts for fast metrics across seeds; the live game via Playwright + `window.__ITM` to watch real behavior and capture screenshots; rendered diagrams (e.g. SVG trajectory plots) to see what's happening; and the standing checks (`npx tsc --noEmit`, `npm run build`, `scripts/balance.ts`, `scripts/smoke.ts`). When you're stuck, instrument and dump the actual data (dump the route, the grid, the per-tick state) instead of speculating — let the evidence find the root cause.
