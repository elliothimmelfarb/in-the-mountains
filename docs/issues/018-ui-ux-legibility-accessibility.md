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

## Right-column dock rework (2026-06-08, owner feedback — RESOLVED)
The owner reported the right column had "several issues depending on what is selected and whether things are collapsed." A 10-state matrix harness (`scripts/ux-rightpanel-matrix.mjs`) + a 5-agent workflow (23 issues → 1 unified plan) found: Logistics' fixed 182px clipped 4 of 8 supply bars in every open state; Task Org (the lone grow sink) was crushed to a ~35–103px scrolling sliver whenever a squad was selected; collapsing panels left a ~681px dead void; short viewports clipped silently. **Fix (one mechanism):** every right panel is now `auto` (content height) — Squad Orders never scrolls (owner's hard req), all 5 squads show, all 8 supply bars show; a single structural flex:1 spacer absorbs all slack (no void, shows a hint when all collapsed); the column scrolls as the graceful fallback; the village is now a real collapsible DockPanel; `DockPanel.actions` hides controls on a collapsed header. Matrix verified: per-panel scrolling 6–8 states → **0 in all 10**. Task Org no longer inline-expands; soldiers open in a dedicated accessible Roster modal (▤). (DockPanel's grow/fixed/resize branches kept — the LEFT column still uses them.)

## Residuals (for a future session — NOT done)
1. **Colour-only status in a few places.** Roster readiness dots and village attitude bars encode state by hue (dots have hover tooltips; meters have numbers + the ENEMY hatch, but the dots/bars lack an always-visible shape/letter cue). Add a glyph fallback for full WCAG 1.4.1.
2. **Full HUD still dense at game scale.** The ≥12px floor is real, but the bottom fire-support / contact-feed strip remains tight at 1280-wide; the hi-detail crops read best.
3. **Focus visibility is proven behaviourally, not in a still** (the ring only shows during live keyboard nav).
4. **Right column scrolls *as a whole* when all three panels are expanded taller than the viewport** — by design now (no panel clips; Squad Orders is never the clipped one), and the user can collapse a panel to remove it. Not a defect, noted for transparency.

## Relevant code
- `scripts/ux-audit.mjs` — the metric (run with the dev server up on :3000).
- `app/globals.css` — type-floor override, `:focus-visible`, reduced-motion, `--ink-2`, `.tac-btn` floor, contact-posture + hazard-hatch utilities.
- `components/screens/DeployScreen.tsx` — CommandBar meters, ToastStack, HelpOverlay, collapsible Task Org, tooltips.
- `components/Modal.tsx` — the accessible dialog shell.
