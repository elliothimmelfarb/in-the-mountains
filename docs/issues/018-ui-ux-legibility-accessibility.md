# 018 — Command UI: sub-12px type, zero keyboard accessibility, flat hierarchy

**Status: ✅ Largely resolved 2026-06-08 (UI/UX 20× campaign). Residuals tracked below.**
Severity: High (the HUD is the surface a commander reads for a whole deployment).
Owner files: `app/globals.css`, `components/screens/DeployScreen.tsx`, `components/Modal.tsx`, `components/world/WorldView.tsx`, `state/store.ts`.
Oracle: `scripts/ux-audit.mjs` (zero-dep CDP harness — walks the live DOM across 4 states, counts WCAG/usability defects; `--shots` captures, `--a11y` asserts keyboard behaviour, `--demo` stages toasts/help).
Full writeup + charts + annotated crops: `docs/progress/2026-06-07-ui-ux-20x/report.html` (served at `public/manual/archive/reports/2026-06-08-ui-ux/`).

## What was wrong (HEAD before the change)
The command UI was dense and handsome but quietly hostile to read and impossible to operate by keyboard. The audit (4 states: menu / HUD / village / soldier dossier) measured **461 UX defects**:

- `tinyText` **262** (121 sub-11px) — the whole HUD was built on an 8–11px mono ramp.
- `noFocusRing` **152** — no `:focus-visible` rule anywhere; keyboard focus was invisible.
- `tinyTarget` **33** — controls under the 24px hit floor (WCAG 2.5.8).
- `unlabeled` **10** — dock resize separators with no accessible name.
- `contrast` **2** — warning text + one secondary tone below AA (theme was otherwise contrast-safe).
- `reducedMotion` **2** — blink/pulse/scanline with no `prefers-reduced-motion` escape.

Independent baseline read: a 5-persona expert panel scored the HUD **40/100** overall (legibility 26, accessibility-feel 12).

## The fix (four rounds, each re-measured in isolation)
- **R1 a11y foundations:** one global `:focus-visible` amber ring (152→0); `@media(prefers-reduced-motion)` (motion-safe); aria-labels on separators + glyph buttons (10→0); `.tac-btn{min-height:24px}` + dock-header fill (33→1); palette nudges `--ink-dim`→#aaaa90, `--rust`→#c75f33 (contrast 2→0).
- **R1 legibility floor:** centralized override remapping 8/9/10px→12px, 11px→13px (262→0), density preserved (hierarchy carried by colour/weight/stencil-caps). Verified no overflow via a `scrollWidth>clientWidth` oracle (0 clipped).
- **R2 hierarchy + feedback:** five campaign metrics promoted from identical slivers to a labelled meter cluster with a colour-blind-safe ENEMY hazard hatch; `tabular-nums`; `data-contact` posture; severity-typed command toasts (`store.toasts`, UI-only) so no action is a dead click.
- **R3 discoverability + modal a11y:** shared `Modal` (role=dialog, aria-modal, focus-trap, Esc, focus-restore) for the event + dossier dialogs; an in-game controls + map-legend overlay (`?`/`H`); focusable canvas; disabled-reason tooltips.
- **R4 (feedback-driven):** `--ink-2` brightens left-column running narrative (the re-judge's top residual).
- **Owner feedback:** collapsible squads (toggle to close), tighter right column + taller Squad-Orders panel, tooltips on every icon/abbreviation.

## After (same harness, same states)
- **461 → 1** total defects (−99.8%; the lone residual is a 16px checkbox whose real target is its label).
- Paired adversarial re-judge (5 personas, unanimous for the redesign): overall **58.6 → 82.4**, legibility **51 → 82**, accessibility-feel **40 → 74.6**, hierarchy **56.8 → 84.2**; mean perceived lift **2.3×**.
- Keyboard-behaviour harness: **6/6 pass** (dialogs trap focus, move focus in, close on Esc).
- `tsc` / `npm run build` / `npx tsx scripts/smoke.ts` green.

## Residuals (for a future session — NOT done)
1. **Colour-only status in a few places.** Roster readiness dots and village attitude bars encode state by hue (dots have hover tooltips; meters have numbers + the ENEMY hatch, but the dots/bars lack an always-visible shape/letter cue). Add a glyph fallback for full WCAG 1.4.1.
2. **Full HUD still dense at game scale.** The ≥12px floor is real, but the bottom fire-support / contact-feed strip remains tight at 1280-wide; the hi-detail crops read best.
3. **Right column can still scroll** when a 9-man roster is expanded (mitigated by collapse + resize, not eliminated).
4. **Focus visibility is proven behaviourally, not in a still** (the ring only shows during live keyboard nav).

## Relevant code
- `scripts/ux-audit.mjs` — the metric (run with the dev server up on :3000).
- `app/globals.css` — type-floor override, `:focus-visible`, reduced-motion, `--ink-2`, `.tac-btn` floor, contact-posture + hazard-hatch utilities.
- `components/screens/DeployScreen.tsx` — CommandBar meters, ToastStack, HelpOverlay, collapsible Task Org, tooltips.
- `components/Modal.tsx` — the accessible dialog shell.
