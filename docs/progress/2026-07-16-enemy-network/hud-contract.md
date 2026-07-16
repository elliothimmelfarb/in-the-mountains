# Build contract — the player SEES the war: enemy picture + commander's assessment

**Date:** 2026-07-16 · **Wave:** enemy-network HUD (follow-on to the engine wave, shipped
`703a458`/`f27a9a6`/`a55a587`) · Sibling docs: `contract.md` (engine), `recon.md` (seams).

## Why

The engine now simulates a persistent enemy order of battle (cells with named leaders,
caches, patrol-heat) and a village-driven intel game that reveals it (`intelLevel` 0–3 per
cell, cache `found`). None of it is visible. And the COIN layer moves numbers the player
can't attribute ("attitude drifted +4… why?"). This wave gives the player two surfaces:

1. **THE ENEMY PICTURE** — what S-2 knows about the network, strictly intel-gated.
2. **THE COMMANDER'S ASSESSMENT** — a weekly battle-update ritual that explains
   cause→effect in words and chapters the endless clock.

## Deliverable 1 — Enemy Picture (left-column panel + map overlay)

**Panel** (new `DockPanel id="enemy"` in the left column, below Intel Feed — the
intel/directives panels at `components/screens/DeployScreen.tsx:277-283` are the exact
template). One row per cell with `intelLevel ≥ 1`, reading ONLY these fields:

- Level 1 (named): leader name + "group — location unknown". No strength, no home.
- Level 2 (located): + a strength BAND (round to nearest 4: "8–12 fighters"), villages
  it draws from, activity cue from `lastActivityClock` ("active this week" / "quiet").
- Level 3 (mapped): + exact-ish strength ("~10"), caches found/destroyed count.
- Broken cells render struck-through with "broken — survivors scattered" for the rest
  of the tour. Succession (leaderAlive=false) renders "leadership unclear" until the
  new name arrives.
- Footer line when unknown cells exist: "S-2 assesses additional groups operate in the
  valley." (count of level-0 cells NEVER shown).

**Map overlay** (inside the draw loop at `components/world/WorldView.tsx:255`; the
intel-marker block at `:319-333` and the ghost block at `:513-530` are the templates):

- Cell home marker at `intelLevel ≥ 2`: a red-bounded diamond/reticle + leader name
  label. At level 2 the position must be FUZZED ~120 m; at level 3, true position,
  tighter ring. **Fuzz must be deterministic and rng-free** (hash the cell id →
  offset; the render layer must NEVER draw from the sim rng) and stable across frames.
- Cache markers where `found && !destroyed` (small ammo-crate glyph); destroyed caches
  render faded/struck for the rest of the tour (they're a trophy — leave them visible).
- NO patrol-heat rendering this wave (it's the enemy's knowledge, not the player's).
- Sprite/glyph work: follow the existing map-marker sprite pattern (`marker-intel-*`).
  If you add SVG assets, regenerate the manifest (`node scripts/build-asset-manifest.mjs`)
  — generated files are overwritten, edit sources.

**Iron rule: the HUD renders the network EXCLUSIVELY through `intelLevel` / `found` /
`broken` / succession state. Ground truth (true strength at level<3, level-0 cells,
unfound caches, patrolHeat) must be unreachable from the DOM.** A player reading the
DOM/React tree must learn nothing the fiction hasn't told them.

## Deliverable 2 — Commander's assessment (the weekly BUB)

A modal that fires ONCE per game-week (first tick past 0700 on day 8, 15, 22…) when NOT
in contact (defer while `inContact`; fire when contact ends). Pauses the clock like a
decision event, but is dismissable (Esc/close — `components/Modal.tsx` handles a11y).

**Content — sim-truth, assembled engine-side.** Create `lib/sim/world/assessment.ts`
(NEW file, pure, React-free) exporting `buildWeeklyAssessment(w: World): Assessment` —
a structured object (typed sections, no JSX) the component renders. Sections:

1. **The valley** — per-village attitude delta since last assessment with CAUSES, in
   prose fragments the component lists: completed/sabotaged projects, kept/broken
   promises (`keptPromises`/`brokenPromises` deltas), civcas grievances (village
   `grievances`), shuras held, neglect ("no patrol in N days" via `lastVisitedDay`).
2. **The enemy** — the network picture at current intel gating (reuse Deliverable 1's
   gating rules EXACTLY — factor the gating into a shared pure helper so the two
   surfaces can't drift), plus the week's contacts/IED count from the log.
3. **Higher** — `higherConfidence` trend, directive statuses with deadlines, CERP
   balance, and the relief evidence file when a watch is open (`state.confLedger`,
   the attributed causes — "Battalion's file: casualties −12, civilian casualties −8").
4. **The men** — KIA/WIA this week by name (somber, one line each), platoon fatigue.

For "since last assessment" deltas: persist a small snapshot on WorldState (e.g.
`bubSnapshot: { day; villageAttitudes: Record<id, number>; keptPromises; brokenPromises;
kia: number } | null` + `nextBubDay: number`). Add presence-defaults in `loadWorld`
following the existing pattern (create.ts:214+). Do NOT change the serialize `v`.
**You may touch `lib/sim/world/types.ts` and `create.ts` ONLY for these fields, and the
barrel `index.ts` for exports. You may NOT touch `world.ts`, `network.ts`,
`director.ts`, `events.ts` — the orchestrator is editing engine internals in parallel.**
The store (`state/store.ts`) owns scheduling: on frame, if `world.day >= nextBubDay` and
not in contact and no pending event → build the assessment, show the modal, advance
`nextBubDay` + write the new snapshot (via a World method? NO — via a small exported
helper in assessment.ts that mutates state; keep world.ts untouched).

Voice: the game's somber, grounded register (read existing `w.log` lines and the shura
strings). The BUB is an S-3 update at a plywood table, not a dashboard: short declarative
sentences, no exclamation marks, numbers where a staff officer would use them.

## Verification (before claiming done)

- `npx tsc --noEmit` · `npm run build` · `npm run lint` (your files clean) ·
  `npx tsx scripts/smoke.ts` → SMOKE OK.
- Layer line: `assessment.ts` imports nothing from React/components; components import
  from the barrel `@/lib/sim/world`.
- **Visual proof:** run the dev server (`npm run dev`, port 3000) and capture: (a) the
  Enemy Picture panel with at least one level-≥2 cell (play time forward / use
  `window.__ITM.getState().world` to legitimately raise cooperation and let HUMINT fire
  — do NOT hand-set intelLevel for the capture if avoidable; if you must, say so),
  (b) the map markers, (c) the BUB modal. Save PNGs into
  `docs/progress/2026-07-16-enemy-network/hud/`. `node scripts/shoot.mjs` exists for
  captures (don't run it and MCP-Playwright against the same Chrome).
- Determinism guard: two same-seed worlds, run 8 game-days headless, assert
  `buildWeeklyAssessment` output deep-equals (add this as `scripts/scratch-bub-probe.ts`,
  run it, report the result, then DELETE it per scratch policy).

## Working rules

Commit as you go (`feat(hud): …`), trailer exactly
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Files you own:
`components/**`, `state/store.ts`, `lib/render/**` (markers), `lib/sim/world/assessment.ts`,
plus the narrow types/create/index exceptions above. Nothing else. If the contract
disagrees with code reality, trust the code and record the deviation in the commit body.
Final message: numbers-first report — what shipped, verbatim check lines, screenshots
taken (paths), deviations, residuals.
