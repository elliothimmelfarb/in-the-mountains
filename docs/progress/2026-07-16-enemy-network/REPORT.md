# The enemy gets a name — persistent order of battle, the intel game, and the death of the relief lottery

**Date:** 2026-07-16 · **Commits:** `da10926` → (this wave's final) · Contracts + recon in this directory.
**Thesis:** the sim was finished enough to be good; what blocked "playable for hours" was that the
insurgency was a weather system (nothing to learn), consequence was illegible (no cause→effect surface),
and the relief mechanic was an opening-days dice roll (rage-quit generator). One session, three fronts.

## 0. The meta-track (why the session started here)

A doc-grounded assessment claimed the game had no intel system. The code disagreed
(`campaign.ts:85`, director ICOM telegraphs). Root cause: the working protocol sent fresh
sessions to `docs/issues/` FIRST and made refutations permanent walls.

- **CLAUDE.md flipped** (`da10926`): code+probes are the authority; ledger entries are dated
  claims verified before load-bearing; a recorded negative expires when the mechanism it
  refuted is rebuilt.
- **Full ledger staleness sweep** (`eb3c237`, delegated): all 36 issues verified against code
  with dated `Ledger status` headers; README convention preamble; refutations anchored to
  proving commits. Tally: 28 resolved · 3 partial · 5 open. The invisible intel system is now
  surfaced in the ledger.

## 1. Relief-of-command: from dice roll to evidence file (issue 035 → RESOLVED)

`a14da77`. Every `higherConfidence` dock is attributed by cause (persisted `confLedger`:
casualties / civcas / directives + unique-day `kiaDays`). Relief requires the sustained-low
watch AND a nameable pattern AND survival past a 5-day grace; a visible climb (+3) extends the
review (FM 6-22). `endReason` reads the file to the player.

| metric (campaign-loop 3×8, relief-fix-only tree) | before (issue 035) | after |
|---|---|---|
| careful tours relieved | ~50–60%, score censored to ~0 | **0/3 — all reach end-of-tour** |
| careful scores | bimodal 0 \| 28–69 | **82 / 77 / 98 (mean 85.7)** |
| body-count tours relieved | lucked through | **2/3, by attributed pattern** (conf 4) |
| gate verdict | n/a | **all 8 PASS, spread 81.7** |

Direct-drive scenario probe (isolated worktree): single-day catastrophe at conf 0 for 14 days →
never relieved; pattern past grace → relieved with attributed reason; climb → extended, then
closed on recovery. Deliberately NOT done: reweighting `computeTourScore` for relieved tours —
with relief rare-and-earned, the censoring distortion is gone without touching calibrated weights.

## 2. The enemy becomes an organization (the wave's heart)

Engine (`703a458`, `f27a9a6`, `a55a587`, delegated to a builder against `contract.md`):
3–5 persistent cells (named leaders, reachability-snapped home ground, strength, personality:
aggression/iedSkill/grudge), 4–8 physical caches, a 32×32 decaying patrol-heat grid. The
director picks and spends CELLS; IED ambushes require and drain a real cache in range; killing
a named leader forces succession (rename, −30% strength, grudge, pause); a cell under 2 breaks
and survivors merge; cooperative won-over villages give the network up (`intelLevel` 0→3 +
cache locations, reliability ∝ cooperation) — FM 3-24's "win the population → they expose the
network" is now a mechanic, not flavor. `enemyStrengthAbs` lives on as the derived sum, so
every legacy reader (interdict directive, ENY meter, harnesses) is untouched. Save v10 with
deterministic network regeneration for old saves.

**The conservation bug (honest record).** The build's skeptical pass found fielding used the
roster model (no deduction) while exfil deposited +1 — every survivor double-counted; measured
**64 → 80-cap inside ONE pinned-hot game-day**, pinned thereafter. The contract's own §3
wording caused it and the probe's assert 4 had enshrined it (overfit-to-contract). Fixed
(`89d5e4a`): exfil net-zero, KIA exactly −1; assert 4 rewritten to prove conservation both
ways. Post-fix 3-day pinned-hot trajectory: see `after/` capture. Contract carries a dated
correction block rather than a silent edit.

`scripts/enemy-network-probe.ts` (permanent gate): **9/9 OK** — same-seed byte-identical
serialize; director spends created cells; Σ cells === derived scalar (drift 0.00e+0); roster
conservation; cache economics (spend + no-cache-no-IED fallback); succession
(Qari Khan→Baz Qari, weaker, intel emission); located-intel truthiness; save round-trip;
pre-v10 migration.

## 3. The player sees the war (HUD, `c475a0c`, delegated against `hud-contract.md`)

- **Enemy Picture panel + map overlay**, gated EXCLUSIVELY by `intelLevel`/`found`/`broken` —
  ground truth is unreachable from the DOM (verified live: zero level-0 leader names in
  `document.body.innerText`). Level-2 homes render with a deterministic rng-free ~120 m fuzz;
  level 3 true + tight. Found caches render; destroyed ones stay as struck trophies.
- **Weekly Commander's Assessment (BUB)**: pure `assessment.ts` builds a structured update —
  per-village attitude deltas WITH causes, the enemy picture through the SAME shared gating
  helper, Higher's view including the live relief evidence file, and the week's casualties by
  name. Store-scheduled (first tick past 0700, deferred in contact), dismissable, clock-holding.
  Same-seed determinism probe passed (deep-equal assessments + fuzz).

## 4. Live play verification (real app, seed `network-live-1`, browser-driven)

Chronicle of one session: deploy → 3 cells (Daoud Hotak 23 / Asadullah Wazir 19 / Sher
Achakzai 18 = 60 = derived scalar, exact), 4 caches, all dark, panel correctly shows only
"S-2 assesses additional groups operate." → 8 game-hours: all 3 cells stage activities, 17
fighters fielded, 13 ICOM intercepts, **conservation exact, Enemy Picture correctly still
dark**. → Yaka China won over (sim-legitimate attitude/cooperation): the engine's own HUMINT
fires — *"Yaka China confirms Daoud Hotak's ground — his men, his shelters, his routes"* —
intelLevel 0→**3**, 2 caches found, panel shows **MAPPED · ~10 fighters · caches 2 found**,
map grows the marker + cache glyphs; the other two cells stay dark. → Overnight the director
stages a complex attack; 3 fighters reach the wire; FPF danger-close call-for-fire pends and is
cleared by the commander; 5 named KIA; a sick-child decision event resolves ("Word spreads.");
Daoud Hotak's cell is physically attrited 23→10 by its failed assault. Conservation held
through the entire firefight. Captures in `live/` + `hud/`.

## 5. Verification matrix (combined tree)

| check | result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | ✓ compiled, static prerender |
| `npm run lint` | wave files add ZERO to the pre-existing 310-problem baseline (2 WorldView errors blame to June commits) |
| `scripts/smoke.ts` | SMOKE OK (serialize round-trip incl. network/heat/bub fields; material hash unchanged) |
| `scripts/balance.ts` | 12/12 contacts · KIA 1.08 / WIA 8.33 (diagnostic; within σ≈2.5 noise floor) · civcas 0 · STALL gate pass · ⚠ 1 run left an element lingering (recorded residual) |
| `scripts/enemy-network-probe.ts` | 9/9 OK |
| campaign-loop 3×8 (relief-only tree) | ALL 8 PASS, spread 81.7 |
| campaign-loop 3×8 (combined tree) | PENDING_CAMPAIGN |
| post-fix strength trajectory (3d pinned-hot) | PENDING_TRAJECTORY |

## Honest residuals

1. **Passive strength drift in a quiet valley** — 60→50 over 8 no-contact game-hours in the
   live session (regen integrator net-negative at baseline sympathy). Pre-existing dynamic
   inherited by the per-cell regen; not obviously wrong (pacification pressure), but
   uncharacterized. Needs a dedicated read before anyone tunes it.
2. **balance.ts "1 run left an element lingering"** warning — task-resume timing at run end;
   gate passed; not chased this session.
3. **Patrol-heat → IED-risk is proven to exist/persist/bias, not quantified** as "predictable
   patrolling measurably raises IED incidence." Candidate probe named in the builder report.
4. **BUB verified by determinism probe + screenshots, not by an organic day-8 live session**
   (would need ~8 game-days of wall-clock).
5. **Enemy Picture panel truncates long leader names** in the header row ("Daoud Ho…") at
   default width — cosmetic, panel is resizable.
6. **Cell-home siting** is an 8-sample elevation pick near villages, not true draw-finding
   terrain analysis.
