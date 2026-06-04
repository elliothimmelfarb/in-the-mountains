# Movement & Pathfinding Rebuild — 2026‑06‑04

The movement was "game‑breaking": squads ordered to a village would **orbit the COP**,
**string out into a 100 m+ accordion snake**, the point man would **grind the terrain the
whole patrol**, and the navigator would **spin in place at >400°/s** at the first awkward
waypoint. This pass diagnosed each as a hard number and rebuilt the two systems underneath:
the **pathfinder** and the **squad cohesion model**.

## How it was diagnosed (verify, don't assume)

New/used harnesses turned "it looks wrong" into metrics:

- `scripts/route-quality.ts` — route length / crow‑flies ratio, direction reversals, and
  max excursion away from the goal, over every village in many seeds. **The pathfinder's
  optimization target.**
- `scripts/cohesion.ts` — the *texture* of a march: centroid pace vs. doctrinal pace,
  the throttle (how often the lead brakes for the rear), the accordion (variance of column
  length), heading jitter (spinning), wall‑grinding. **The squad model's target.**
- `scripts/trajectory-png.ts` — renders a squad's actual march to a PNG (terrain + every
  soldier's traced path) with a tiny built‑in PNG encoder. The eyeball test.
- plus the standing `movement-diag`, `copaudit`, `egress`, `smoke`, `balance`,
  `reachability`.

The forensics found **four independent bugs**, each masked by the others:

1. **The pathfinder spiralled.** A coarse A* node is "passable if ANY 5 m subcell is", so the
   coarse line cut across a wash bank/wall that actually sealed it. The string‑pull "repair"
   then asked a fine A* to honour a coarse waypoint stranded across that barrier — and since a
   long detour on cheap trail can cost *less* than a short scramble, the fine A* looped **300 m
   around the COP to connect two points 15 m apart**. `findPath` returned a 718 m route for a
   391 m objective that wound 1½ times around the outpost. The navigator dutifully walked it.

2. **Followers couldn't hold formation.** The breadcrumb‑trace + geometric‑slot follower
   couldn't keep its slot even when the lead crawled — the nearest‑breadcrumb logic flickered
   and stalled. The squad strung out to 148 m and the centroid moved at **0.02 m/s while the
   navigator walked at 1.3 m/s**.

3. **The pace governor abandoned cohesion by design.** After ~18 s of lag the lead stopped
   waiting and walked off, permanently stringing the element out. A real squad never does this.

4. **The navigator span and the point man ground.** When a waypoint was briefly unreachable
   the steering oscillated 180°/tick (a local minimum) instead of committing — **>400°/s** of
   spin, near‑zero net progress. And the "point man" was projected *ahead* of the navigator off
   his instantaneous heading, which marched him straight into every wall the navigator curved
   around (**2 286 ground‑grinding ticks** on one patrol).

## What changed

### Pathfinding — `lib/sim/path.ts` (corridor‑constrained full resolution)

Replaced the coarse + point‑repair scheme with a two‑stage, corridor‑bounded one:

1. a cheap **coarse A\*** still lays the global line (it may be optimistic);
2. a **full‑resolution A\* confined to a corridor** around that line produces the path the
   unit actually walks.

Full resolution means the path honours every 5 m feature — it crosses the wash at the **real
ford**, threads the **ECP gate**, slips through a **qalat gap** — so it is *always genuinely
walkable*. The corridor bound makes the search cheap (a thin band, not the map) **and makes a
looping/spiralling path physically impossible**. The corridor widens (`CORRIDOR_RADII`) if the
tight one can't get through; if the goal is truly walled off, A\* returns the route to the
**closest reachable cell** (`bestEffort`) so a patrol walks up to a village's edge and sets up
there instead of being handed a path that clips a courtyard wall.

> An honest precomputed coarse‑connectivity graph was built and discarded first: getting the
> edge test strict enough to seal a wash bank also isolated villages and the gate (it fell back
> to the tunnelling graph). The corridor approach subsumes it — the full‑res pass *is* the
> honesty check, locally, every time.

### Squad cohesion — `lib/sim/world/formation.ts`

- **Followers ride the navigator's wake** as a dense path (`driveFollower`): each man is a bead
  on the leader's recorded track, handed the run of real positions from just ahead of him to his
  slot. Every segment is ground the lead already cleared, so a follower can't wedge on terrain.
  Lag is measured **along the wake** (arc length), so a file wrapped around a curve reads as
  in‑place, not strung‑out.
- **The pace governor is continuous and never abandons cohesion** — the lead eases the throttle
  the further the rearmost man trails (down to a slow creep, never a dead stop), and opens back
  up the instant the column closes. A man genuinely wedged is excluded so one trapped soldier
  can't freeze the patrol, but a man merely lagging *sets the pace*.
- **The point man leads along the navigator's planned route** (`aheadOnPath`), not a dead‑reckoned
  point off his heading — over ground the element is about to cross, so he stops grinding walls.
- **File‑dominant movement.** This valley is close, broken ground end to end; a foot squad moves
  in a single column on the leader's exact track (also doctrine for restrictive terrain). Holding
  a lateral interval (wedge) over this ground reliably wedged the flankers into walls and stalled
  the element, so open‑ground wedges are intentionally shelved pending a terrain‑fitted version.
  The column still opens/closes with the corridor, paces for the rear, and sets up all‑round on
  the objective.

## Results (headless, multi‑seed)

| metric | before | after |
|---|---|---|
| route length / crow‑flies (mean) | 1.77 | ~1.1 |
| "loopy" routes (>2.5×) | 14 % | 2 % |
| route max excursion from goal | 67 m | 22 m |
| column length variation (accordion, CV) | 0.55 | 0.27 |
| navigator heading jitter (korengal) | 443 °/s | 0–2 °/s |
| point‑man wall‑grind ticks (korengal) | 2 286 | ~16 |
| total bump ticks (korengal) | 2 443 | ~210 |
| governor throttle active (mean) | ~20–80 % | 6 % |
| `movement-diag` patrols set up on objective | 2 / 7 | 5 / 7 |
| `balance` firefights | 6 / 16 (old refactor) | 16 / 16 |

`npx tsc --noEmit`, `npm run build`, `smoke`, `egress` all clean. Balance: 16/16 contacts,
KIA ~0.7, 0 civ casualties.

See `after-korengal.png` (clean direct file to the village) vs `before-korengal.png` (the old
spiral around the wire).

## Known follow‑ups (honest)

- **Far valley villages (≥ ~900 m)** still set up at the closest approach within the test
  window (`survey-2/7`); this is route‑length/pace × window, not a routing bug — the routes to
  them are clean — and they arrive under time‑warp. `reachability.ts` is the fair metric.
- **`balance` flags ~1/16 "lingering"** — a moving element whose lead man sampled < 4 m over a
  90 s window (a hard‑seed crawl or a post‑combat resume settling). The leg/return backstops
  (`STUCK_S` 90 s, return 60 s) guarantee it isn't a permanent freeze; worth a closer look.
- **`copaudit` portal probe 3/16** routes *inside the COP → a point glued to the far wire*, an
  awkward half‑perimeter loop the optimistic coarse tunnels through the wall on. The **game never
  does this** (patrols file out the gate explicitly, `egress` is 0 blocked), so it's an over‑strict
  audit of best‑effort routing, not a gameplay regression.
- **Open‑ground wedge / echelon** — re‑introduce as a terrain‑fitted spread (per‑man lateral
  offset clamped hard to the corridor) once file movement has soaked.
