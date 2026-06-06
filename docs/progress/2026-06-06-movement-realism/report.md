# Squad / soldier / civilian movement realism overhaul — 2026-06-06

**Goal.** Level up squad and soldier movement and their interaction with civilians.
The brief: it felt *too mechanical*; soldiers **got stuck on each other**, especially
when setting up **360° security**; and the **spacing scale** looked wrong (doctrine is
~5 m between soldiers, ~10–15 m between fire teams with the squad leader between them).
Make it feel like watching the real thing with a graphics overlay.

This was done **research-first** (a multi-agent workflow of three subject-matter experts),
**verify-don't-assume** (every fuzzy complaint turned into a hard metric with a headless
harness, baselined, re-measured after each change), and **iterated once more** after it
looked done.

---

## 1. What was wrong (measured, not guessed)

Two new/updated headless harnesses turned the complaints into numbers:

- `scripts/security-halt.ts` (**new**) — isolates the 360° set-up: places a squad in a
  realistic strung-out file, hands it a security halt, and measures how the occupation
  resolves (settle time, **churn** = distance walked ÷ straight-line = how much men cross
  the ring, **minGap** = closest two bodies ever get, perimeter **maxGap°**, standoff
  **radCV**, and settled **jitter**).
- `scripts/cohesion.ts` (existing) — the march "texture": pace efficiency, the accordion
  (`lenCV`), and **heading jitter** (the robotic-dither tell).

**Baselines (the smoking guns):**

| Symptom | Metric | Baseline |
|---|---|---|
| Robotic dither while moving | cohesion `jit°/s` | **110 mean, 729 peak** (survey-9) |
| Frozen-turret 360 (no scan) | security-halt `jit°/s` | **0** (faceLock snapped, dead still) |
| Men march across the circle | security-halt `maxChurn` | **3.7 mean, 18.8** (survey-7) |
| Crossing / orbiting for a spot | security-halt `churn` | **1.70 mean** |
| Element never closes up (end-to-end) | security-halt v1 (full march) `settle` | **0 / 7 seeds ever settled** |
| Spacing too loose | `planFormation` interval / inter-team gap | **9 m / ~18 m** (doctrine ~5 m / ~11–14 m) |

Root causes, found by reading the code + dumping the actual per-tick state:

1. **`holdSecurity` assigned ring slots by raw member index** (`a = (i/n)·2π`), so a man on
   the east was routinely ordered to the *west* slot — straight through everyone. No
   bearing-optimal assignment, no de-confliction, slots not snapped to passable/cover.
2. **No separation while halted.** Local steering separation only runs for a man following a
   path; once `path = []` the integrator just `halt()`s him — two settling men interpenetrate.
3. **Facing snapped instantly every tick** (`u.facing = faceLock ?? angle(dir)`), producing
   700°/s spins — the dominant "mechanical" tell — and a frozen turret at the halt.
4. **Spacing constants** were ~2× doctrine, and the pace governor's slow-zone was tied to the
   (now tighter) interval, so it over-braked a normally-strung column.

## 2. Research (multi-agent workflow)

`Workflow` ran three domain experts in parallel — US Army light-infantry small-unit tactics
(FM/ATP 3-21.8, FM 7-8), game-AI / character-movement engineering, and crowd-simulation /
ambient-NPC behaviour — each reading the actual source so its recommendations cited real
functions and gave exact parameters. Reports are archived under `research/`. They converged
tightly on the diagnosis above and on the fixes below (notably the **cigar-perimeter
near-side occupation** and the **rotate-the-ring min-rotation assignment**).

## 3. What changed

All variation is **deterministic** — derived from a pure hash of the unit id
(`RNG.hashString`), never per-tick randomness — so headless replays stay bit-exact
(verified by double-running and diffing).

**Soldier / squad (`lib/sim/world/formation.ts`, `lib/sim/combat.ts`, `lib/sim/world/tasks.ts`):**

- **Bearing-optimal 360° occupation.** `holdSecurity` now lays evenly-spaced ring slots and
  rotates that ring against the men (sorted by current bearing) to **minimise total angular
  travel** — a crossing-free, near-side occupation. Each slot is nudged per-man off the
  geometric ideal, snapped to **passable + cover**, and snapped to **reachable** ground; an
  awkward (walled-off) sector falls back to a **hasty position on the man's own bearing**
  rather than a 60 m detour. The **squad leader holds the inside** of the cigar. The
  perimeter **radius fits the terrain** (shrinks in a draw) and is sized to a squad
  (deliberate 14 m / KLE 9 m, down from 20/14). Assignment is cached on the task so a contact
  flicker doesn't reshuffle the whole perimeter.
- **Hard de-overlap at the halt.** A cheap per-tick pass eases any two interpenetrating,
  non-hostile, *halted* bodies apart (≤0.25 m/tick, onto passable ground only) — the
  separation steering can't provide once a man stops. Keeps a settled perimeter from
  collapsing into a pile and stops a soldier from standing inside a civilian.
- **Rate-limited facing + idle scan.** Facing now **slews** toward its target (≈170°/s
  marching, 80°/s holding, fast onto an acquired threat) instead of snapping, and a halted man
  **scans his sector** (a slow deterministic sweep) that freezes the instant he has a real
  threat to look at. Plus **arrival ease-in** (decelerate onto the slot) and a **never-freeze
  speed floor** so a patrol always reads as moving.
- **Doctrinal spacing.** Interval retuned to the "5 and 10": ~5 m between men, ~11–14 m
  between fire teams with the SL between. Per-soldier ±10% interval personality so the file
  reads as men, not a lattice. The pace governor's slow-zone is decoupled from the interval
  (floored at 15 m) with a two-stage brake that eases gently for normal lag but waits harder
  for a genuine straggler.
- **Cohesion-on-arrival.** The lead holds on the objective until the element genuinely closes
  up (≥80% within 55 m, was 70%/90 m) before setting up — so the 360 forms with the squad
  *together* instead of with a fire team 100 m back.

**Civilians (`lib/sim/ai/civilian.ts`):**

- **Four graduated reaction tiers** replacing the binary panic switch:
  *oblivious → wary (stop & watch) → clear-road (step off the patrol's line) → flee*, with
  rise-instant / fall-slow hysteresis.
- **Role flavour:** curious children drift in for a look; elders withdraw home; others step
  aside and watch the patrol pass.
- **Pattern-of-life:** per-civ amble pace (≈0.75–1.4 m/s, child/elder skewed), dwell at a
  node (work/chat for 10–40 s), and a slow idle look-around — no more uniform 2 m/s shuffle.
- **Soldier escalation-of-force yield:** the point man eases the throttle (never stops) when
  an unalarmed civilian is on the patrol's track ahead, letting him clear.

## 4. Results (after, same harnesses)

Security-halt set-up (direct placement; new harness, old vs new code):

| metric | before | after | meaning |
|---|---:|---:|---|
| `maxChurn` | 3.7 (18.8 worst) | **1.1** | men no longer march across the circle |
| `churn` | 1.70 | **0.89** | everyone peels straight to a near sector |
| `settle` | 40.1 s | **27.4 s** | resolves faster |
| `jit°/s` | 0 (frozen) | **8** | live sector scan, not a dead turret |
| `radCV` | 0.11 | 0.19 | *slightly* looser — men set up on cover, by design |

March texture (`cohesion.ts`):

| metric | before | after |
|---|---:|---:|
| heading `jit°/s` | 110 (729 peak) | **16** |
| `paceEff` | 0.35 | **0.44** |
| `lenCV` (accordion) | 0.35 | **0.31** |

The assignment fix itself is shown in `security-halt-before-after.png` (`scripts/security-halt-render.ts`):
the same strung-out file, BEFORE walking across the formation to raw-index slots (red crossing
lines), AFTER each man peeling to his nearest sector (no crossing the circle).

End-to-end, live (`window.__ITM` + Playwright, `live/`): a presence patrol reaches its
objective and the **squad coheres** (radii 8–40 m, min pair 6.9 m — *was* bimodal with a
fire team at ~100 m) into a clean outward-facing 360, screenshot `live/02-security-halt-360.png`.

Civilians move naturally (3-seed check): **every** civ moves, ~0.5 m/s mean ambling pace with
dwells, **0–1 frozen**, and **no perf stall** (327–634 ms for a 300 s sim — issue-010's
470 ms/tick civilian stall is *not* reintroduced).

Standing checks all green: `npx tsc --noEmit` ✓ · `npm run build` ✓ · `scripts/smoke.ts` ✓ ·
`scripts/balance.ts` (12 runs, 0 civ-cas, healthy) ✓ · determinism (double-run diff) ✓.

## 5. The extra iteration — what it kept and what it rejected

After it looked done, one more pass:

- **Kept:** the cohesion-on-arrival tightening (real win — fixed the live strung-out 360) and
  the two-stage far-lag governor brake (tightened the marching main body; harness-neutral).
- **Rejected (with evidence):** a discrete *rally-and-form-up-at-the-gate* hold. It is
  doctrinally correct and rescued the worst seed (survey-9 `paceEff` 0.09→0.58), but the
  harness showed it **bunched-then-surged** the element — `lenCV` 0.31→0.45 and korengal's
  reach slipped past the tactical window — so it was reverted. (Noted in `tasks.ts`.)

## 6. Known limitations (honest)

- **survey-9** still marches slowly (`paceEff` 0.09) on a pathologically winding route — it
  arrives (~480 s), it just detours hard; this is terrain/pathfinding, not the movement layer.
- On genuinely **broken ground** (survey-2/7: a fifth of the perimeter is cliff/river) the 360
  keeps an honest hole (`maxGap°` ~130) — you can't guard a cliff face, and the men correctly
  cluster on the trafficable ground.
- The march still **transiently strings out** from the fast gate egress; it closes up by the
  objective (cohesion-on-arrival), but the rally-hold that would prevent it from opening was
  rejected on the metrics above.

## 7. Reproduce

```
npx tsx scripts/security-halt.ts        # 360° set-up quality
npx tsx scripts/cohesion.ts             # march texture / jitter
npx tsx scripts/smoke.ts                # full continuous world + serialization
npx tsx scripts/balance.ts              # 12-run campaign sanity
```
