# Click-to-zoom image lightbox for all user-facing docs (2026-06-07)

**Goal:** in every user-facing doc and manual, the reader should be able to click an image and view
it full-screen with the UI/UX a reader expects (dark backdrop, Esc/backdrop/× to close, prev/next +
arrows, captions) — not a raw browser image-open.

## What was built

- **`public/manual/lightbox.js`** — one dependency-free, ~340-line mechanism, namespaced `itm-lb-*`,
  injected on every served page via `<script src="/manual/lightbox.js" defer></script>`. Features:
  click/keyboard-open → full-screen overlay; close via ×/Esc/backdrop-click; Prev/Next + ←/→ + swipe
  with an "n / m" counter; click-or-`Z` to toggle fit↔actual on rasters with drag/arrow panning;
  captions from the nearest `figcaption`/`.cap`/alt; focus trap + background `inert` + restored focus;
  robust iOS scroll-lock (position-fixed body).
- **Wired into all 12 user-facing pages** (manual index, tutorial, archive index, 9 published reports);
  the `_dev/` asset-gallery is excluded (developer tool, not player-facing).
- **Correctness rules baked in (one mechanism, not per-page patches):**
  - images inside `<a>` (e.g. archive report-thumbnails) are **left alone** → the link navigates;
  - annotated screenshots (`.shotwrap` + an absolutely-positioned `.ov` overlay SVG) resolve a click to
    the **photo underneath**, and the overlay never becomes its own slide;
  - inline SVG diagrams are zoomable only above a size gate (so the art-bible's 480 sprite thumbnails are
    not), and a cloned SVG gets its `id`s namespaced so `url(#…)`/`href=#…` never collide with the page.

## How it was verified (the load-bearing technique)

1. **Adversarial 5-lens Workflow review** of `lightbox.js` + integration (correctness/a11y/css-isolation/
   touch/integration), each lens running its own live DOM probes. It surfaced a **blocker I had missed**:
   on the world-scale report the `.ov` scale-bar overlay sits *on top of* each screenshot, so clicks hit
   the overlay — every photo would have opened a transparent scale-bar, and 4 junk overlay slides
   polluted the gallery. Three lenses caught it independently.
2. **Fixed every blocker + major + the cheap minors in one coherent pass**, then **live-verified** with
   Playwright over a real static server (`python3 -m http.server --directory public`, mirroring the deploy
   path `/manual/...`):
   - world-scale: clicking the `.ov` overlay now opens the **photo** (`openedThePhoto: true`); gallery
     counter `4 / 9` (4 photos + 5 diagrams; 4 overlay slides excluded); background `inert` true→false.
   - archive index: linked thumbnail = `cursor:pointer`, not decorated, does **not** open the lightbox
     (navigates); bare chapter image = `cursor:zoom-in`, opens itself; counter `1 / 13` (9 linked excluded).
   - firemission: the leaked `img{width:100%;border}` no longer distorts the viewer — `borderTop:0px`,
     aspect preserved (1.067 = 1.067).
   - fivex: SVG diagram opens and renders with **namespaced markers** (`arr`→`arr-lb1`, arrows draw);
     clicking the diagram interior does **not** close; backdrop click **does**.
   - Captured screenshots of a photo and an SVG diagram open in the viewer.
3. **Standing checks:** `tsc`, `lint`, `build` green (the only compiled change was the menu link added in
   the prior archive task; the lightbox is static JS).

## Before → after

| | Before | After |
|---|---|---|
| Click an image in a manual/report | raw browser behavior (nothing / new tab) | full-screen lightbox w/ nav, captions, close, zoom |
| World-scale screenshots | (would have) opened a transparent scale-bar overlay | open the actual photo; overlays excluded from gallery |
| Coverage | none | all 12 user-facing pages, one shared mechanism |
| New reports | — | practice-enforced: include `/manual/lightbox.js` (CLAUDE.md §4) |

## Honest residue

- Inline SVG diagrams are zoom-to-**fit** only (vectors are crisp at fit; the click/`Z`-to-actual zoom is
  raster-only). The art-bible's 480 sprite thumbnails are intentionally **not** zoomable (sub-threshold).
- `touch-action:none` on the overlay disables native pinch-zoom in favour of the built-in zoom/pan; a
  future pass could add pinch if desired.
- Verified on desktop Chromium + an emulated mobile viewport via the review's probes; not yet on physical
  iOS/Android hardware.
