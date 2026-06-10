# People-immersion W3 — LIVE-APP captures (2026-06-10)

All captures driven in the real running game (next dev on :3000, MCP-Playwright CDP browser,
1440×900) on **seed `survey-12`**, one continuous campaign (Day 1). Staging pokes used and
disclosed per image; everything else is the live engine. Crops/insets referenced below were
inspection aids only — the PNGs here are raw viewport screenshots.

| file | what it shows | verified in state at capture |
|---|---|---|
| `shura.png` | **THE SHURA, staged end-to-end live.** KLE — Kandlay dispatched via the store (`selectSquad("sq1")` → `conductKLE("vil-1")`). Radio fired in order: *"word goes to Asadullah Saifullah — the elders are coming out"* (Day 1 · 06:04) → *"Asadullah Saifullah sits down with SSG Toner — the shura begins"* (Day 1 · 06:05, +42 s of on-station — matching the headless `encounter-probe` number). Frame: Day 1 · 07:26 (run forward to daylight; the dwell holds the meeting), ppm 9 on the elder — squad ring + nameplates between the Kandlay compounds, COMMAND LOG bottom-left showing the sit-down line and the elder's follow-up ask ("…asks that patrols stop kicking in doors…"), 1ST SQUAD on station 9/9. | elder unit `civilian-1a` (vil-1 `elderUnitId`) **4.1 m from the squad leader `us-5`** (2.2 m from nearest member), `task.elderMet === true`. Staging poke: none (director suppressed `enemyHeat=0/nextActivityAt=1e12` for a clean scene). |
| `kids.png` | **Children trail a friendly patrol.** Kandlay poked to attitude **+40** (disclosed staging, per brief), 2nd Squad presence patrol (ROE tight) marched through on an out-and-back; the village's one curious child (`civilian-1d`, the pure-hash `trait(id,"cur")>0.5` check replicated page-side to pick the village) picked the file up and held the trail slot. Frame: ppm 12, the marching file (Murphy/Olson/Ayers/Ramos) on the dotted route east of the village, the child the small ringed figure off the rear man. | child `civilian-1d` **8.2 m** from nearest patrol member `us-l`, patrol `moving`, daylight. (Capture moment paused; trail re-verified live at 6.6–10.7 m over ~3 game-min. The KLE squad had to be recalled first — a stationary friendly squad in the village outcompetes the marching file for `nearTroop`.) |
| `callouts.png` | **Diegetic callout plate at tactical zoom** — *"covering!"* on a small dark plate ABOVE Tucker's figure (distinct from the name plates below the figures), 1st Squad bounding home after its fight, ppm 8. This plate is an **organic** emission (the bound-pair swap callout); the capture window was won by framing one man and shooting within the 2.4 s TTL. | fresh `sim.callouts` entry rendered by `CalloutPresenter` (`cam.ppm 8 > FIG_FADE0 2.5`); shouts verified flowing all session: "contact front!", "covering!", "moving!", "falling back!", "man down!", "he's hit!", "i got you", "head count!" (ids 1–20+ on the bus). |
| `consolidate.png` | **Post-contact consolidate, on the march.** 1st Squad (returning phase) took a harass cell's fire, broke it, and the beat fired: radio *"Presence Patrol: consolidating — head count 9 up, 4 wounded."* Frame: ppm 7, the squad collapsed into the ring on open ground SW of Kandlay, CONTACT FEED right showing the fight's lines. Shot at beat+~1 s (28 s of beat remaining). | `task.consolidateUntil` set (dur ≈ 33 s), the head-count log line is the last `state.log` entry; 8 s later 7/8 members `brainState "holding"` with the SL `moving` — the walk-the-line behavior, state-verified. Staging pokes: director armed (`enemyHeat`,`nextActivityAt`), and the broken cell teleported +600 m at scoot so the issue-025 straggler latch couldn't swallow the beat. |
| `consolidate2.png` | Second consolidate, grimmer: 3rd Squad's beat after the brutal mid-march ambush — *"consolidating — head count 8 up, 1 down, 2 wounded"* — fired at the wire after the squad's fighting withdrawal (KIA SPC Brennan visible in the CONTACT FEED, 9-LINE MEDEVAC banner up). Visually muddier (COP structures), kept as the honest record of the beat under casualties. | same beat mechanism (`consolidateUntil` 39 s, log line verbatim); 1 KIA + 2 wounded in `t.memberIds`. |
| `cff-pinned.png` | **The only in-combat lever, live:** 2nd Squad pinned at Kandlay, the squad AI raises the call-for-fire — the CLEARED HOT / DENY card ("pinned, enemy fixed. Requesting 60mm on grid 248–352") with the suppressed squad in the strip above, 9-LINE MEDEVAC bar below. | `state.fireRequest` pending; squad `squadState` pinned-cycle; this is the auto-pause moment (`autoPauseOnFire`). |
| `volley-frozen.png` | **Enemy fire frozen mid-flight** — sim paused on the volley tick (pausing freezes `sim.projectiles`, so the red tracer streaks hang in the air right of center, inbound toward the COP wall where the garrison stands). ppm 3.5. | 3 insurgent rounds in `sim.projectiles` + 1 live muzzle effect at the pause tick. |

## What did NOT get a clean capture (honest residual)

- **The massed opening volley as a spectacle shot** (muzzle line + tracer fan from a 4–6 man
  cell). Three live attempts failed for mechanical reasons, documented here so the next session
  doesn't rediscover them: (1) muzzle effects live 0.12 s and tracers ~0.3–0.5 s vs ~1.5–2 s
  MCP evaluate→screenshot latency — only the pause-freeze trick (used for `volley-frozen.png`)
  beats it; (2) ambush/harass stand-offs (80–380 m) don't fit one tactical-zoom frame — midpoint
  framing at ppm ≥ 4.5 puts BOTH parties off a 816 px canvas; frame ONE side; (3) with wounded
  in the field the bottom HUD (fire-support + 9-line) eats ~70 % of the canvas — measure
  `document.querySelector(".absolute.bottom-0").getBoundingClientRect().top` and frame into the
  strip. The cell volley/peel behavior itself is the headless-verified part
  (`cell-coordination-probe`, `after-w1/cell-coordination-w1.txt`).
- **"head count!" plate in-frame at the consolidate tick** — emitted (state-verified) but faded
  before both consolidate screenshots landed; the `callouts.png` plate covers the presenter
  visually instead.

## Repro notes (load-bearing technique)

- Drive: `window.__ITM.getState()` actions only (`newCampaign("survey-12")`, `selectSquad`,
  `conductKLE`, `setMission`/`addWaypoint`/`stepOff`, `setSpeed`, `togglePause`, `recallTask`,
  `approveFires`/`denyFires`, `resolveEvent`); camera `window.__setCam(x, y, ppm)`.
- The TIC latch re-fires per contact: re-assert `setSpeed` after each contact-clears poll tick.
- To make the director act NOW: set `state.nextActivityAt = 0` (BEHIND the clock — setting it
  `clock + 1` from a fast poll loop keeps it permanently ahead and the roll never fires) with a
  patrol out and `enemyHeat` ~0.35–0.45 (< 0.45 avoids the IED variant that never springs on a
  static squad).
- The consolidate beat only exists for a squad hit while MARCHING (`releaseCombat`,
  `tasks.ts:335` — on-station the re-secured ring IS the consolidation). Recall a squad to make
  it beat-eligible.
- New issue filed from this session: `docs/issues/025-fleeing-straggler-holds-tic-latch.md`.
