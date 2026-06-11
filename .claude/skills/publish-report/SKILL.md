---
name: publish-report
description: Publish an HTML report/explainer into the shipped Field Manual archive (public/manual/archive/) — copy the report, rewrite links, wire in the shared lightbox, add a timeline chapter and a catalog card. Use whenever an HTML report or explainer has been produced; a report that lives only under docs/ is never seen by players. Also covers the self-critique loop for any renderable artifact (SVG, diagram, screenshot-bearing page).
---

# Publish-report — the archive flow

The owner's standing deliverable: an **HTML report/explainer that shows what worked, how you verified it, and teaches him how it works**. The archive is part of the product — it sits in the Field Manual and tells the chronological story of how the game was built (transparency is a feature). `public/` is served at deploy; `docs/` is not.

## The flow, every time you produce a report

1. **Keep the raw record** in `docs/progress/<date-topic>/` as always — the engineering source of truth, never deleted.
2. **Copy** the polished `report.html` + only the images it references into `public/manual/archive/reports/<date-slug>/`.
   - Rewrite any `../` or `.md` cross-links so they resolve in the new home — reports must be self-contained or link only within the archive.
   - **Include the shared image lightbox**: add `<script src="/manual/lightbox.js" defer></script>` before `</body>`. The lightbox is the one mechanism — it auto-finds content images, skips ones inside `<a>`/`.no-zoom`, and is wired into ALL served manual/archive/report pages. Never write a per-page image viewer.
3. **Add a chapter** to `public/manual/archive/index.html` (the development-story timeline): date, punchy title, the human-facing problem, the shape of the work, **verbatim before→after numbers**, a hero thumbnail, and a "read the full report" link. Keep it chronological.
4. **Add a card to the "All full reports" catalog** near the top of that index page, so every report stays reachable from one place (the owner's rule: *all HTML reports featured in full and linked from the summary*).

Publish forward, don't move: `docs/progress/` keeps the raw record; `public/manual/archive/` gets the curated, served copy.

## Report quality bar

- Show the work — make a skeptic ask *"did AI really do this?"* in the writeup too.
- Numbers-first, residuals named: lead with the unflattering figure; partial wins stated as partial.
- Teach: the report should leave the owner understanding how the system works, not just that it changed.

## Self-critique loop for any renderable artifact

Every returned asset must have been **seen and refined by you** (this catches the frying-pan-handle weapon, the floating sticker):

1. Write the artifact.
2. Render it — `node scripts/svg2png.mjs <in.svg> <out.png>` for SVGs, or a screenshot (give the exact command).
3. **Read the output image.**
4. Judge against named criteria; revise.
5. **At least 2 rounds** before returning.
