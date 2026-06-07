# How this report was produced (reproduction recipe)

Everything here is regenerable from the live game + the build tooling in `build/`. Pipeline:

1. **Measure the model (live).** With the dev server on `:3000`:
   ```
   node scripts/scale-probe.mjs korengal
   ```
   Boots a deterministic campaign in its own headless Chrome (CDP, port 9334 — never contends with
   MCP-Playwright or `shoot.mjs`), reads world geometry from `window.__ITM`, applies the renderer's
   exact clamp formulas per zoom, and writes `scale-measurements.json` + the five `shots/*.png`
   framings (A–E) used in the report. This is also the **verification** harness for the fix.

2. **Real-world ground truth (research).** A 13-agent workflow (5 cited researchers → adversarial
   verification of 7 load-bearing numbers → synthesis). Full raw record: `research-raw.txt`.

3. **Diagrams (math-only).** 
   ```
   node docs/progress/2026-06-06-world-scale-realism/build/diagrams.mjs
   ```
   Writes `diagrams/d1…d5` (`.svg` for inlining + `.png` for self-review). Pure functions of the
   render formulas + measured/researched numbers — update the numbers in that file to regenerate.

4. **Assemble the HTML.**
   ```
   node docs/progress/2026-06-06-world-scale-realism/build/report-build.mjs
   ```
   Inlines the diagram SVGs, base64-embeds the screenshots (with viewBox-aligned scale-bar overlays —
   correct because the capture is 1:1 px:metre×ppm), renders the projection table, writes `report.html`.

5. **Self-review (the discipline that caught the layout/label issues).** The report was rendered in
   headless Chrome and captured in full-width segments, each Read and critiqued, before publication
   (diagrams ≥2 rounds; report rendered, edited, re-rendered). To re-do: launch headless Chrome on a
   spare port at `file://…/report.html`, then `Page.captureScreenshot` with `captureBeyondViewport`
   at successive `clip.y` offsets down `document.body.scrollHeight`.

Deliverables: `report.html` (self-contained), `AGENT-BRIEF.md` (the fix spec), `scale-measurements.json`
(baseline + verification target), `research-raw.txt`, `diagrams/`, `shots/`.
