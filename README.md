# In the Mountains

> A deep, **continuous real-time** simulation of asymmetric warfare in the mountains of
> Afghanistan, c. 2011. Command a remote combat outpost in a procedurally generated
> Korengal-like valley resolved to **5-metre fidelity**: there are no turns and no phases —
> one clock runs everything. Soldiers kit up and step off in real time, patrols route through
> the terrain, every bullet is simulated against line-of-sight and concealment, and winning the
> valley means logistics and patience as much as firefights.

Built with **Next.js (App Router) + React 19 + TypeScript + Tailwind 4**. The entire
simulation engine is pure, deterministic TypeScript (seeded RNG); rendering is Canvas 2D.

Inspired by Sebastian Junger's *War*, the documentaries *Restrepo* and *Korengal*, Jake
Tapper's *The Outpost*, and counterinsurgency doctrine (FM 3-24).

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
# or
npm run build && npm start
```

Open the app, click **Deploy** for a new tour (or **Guided Tutorial**), and command your COP.
Time is always running — pause with **Space**, set speed with **1–5**, and press **T** to
fast-forward through the quiet hours until something needs you.

Two read-anytime documents are served statically:

- **Field Manual** — `/manual/index.html`
- **Interactive Tutorial** — `/manual/tutorial.html`

## What's simulated

- **One continuous clock.** No turn/phase layer. A single real-time world runs the sun (smooth
  dawn/dusk and a real day/night cycle), weather, supply burn, soldier fatigue and rest, the
  enemy's tempo, village projects, and combat — all on the same timeline, pausable and
  time-warpable. Combat clamps the clock to readable speed; quiet stretches fast-forward.
- **High-fidelity terrain (5 m grid).** A ~2.5 km valley resolved to 5-metre cells with 21
  landcover classes — river, marsh, dry washes (covered approaches), irrigated cropland,
  terraced fields and their stone **terrace walls**, orchards, scrub, forest, scree, boulder
  fields, cliffs, walled **compounds** and compound walls, cemeteries, roads, trails and
  footbridges — each with its own cover, concealment, and movement cost. Shaded-relief
  rendering with contour lines.
- **Terrain-aware movement & postures.** Patrols and infiltrating fighters both route with A*
  over the terrain. Choose a movement **posture** — *Concealed* (slow, low, hugs forest and
  washes, hard to detect), *Tactical*, *Patrol*, *Traveling*, or *Rush* (fast, loud, exposed) —
  trading speed for profile and detectability.
- **Everything takes time.** Forming a patrol means the element kits up at the wire before it
  steps off. A CERP project can't just be bought: materials must be trucked in, a contractor and
  labor brought on, and a squad must keep the site **secured for days** of work or the insurgents
  intimidate the crew and the job stalls.
- **Line of sight** — elevation ray-casting with partial defilade ("heads over the ridge"),
  vegetation/canopy concealment, and dynamic smoke.
- **Every bullet** — each round is a real projectile with muzzle velocity, time of flight, and a
  dispersion folded from weapon mechanics, marksmanship, stance, fatigue, movement, and suppression.
- **People, not pieces** — named soldiers with attributes, morale, suppression, fatigue, regional
  wounds (with body armor), bleeding, buddy aid, and medics. Losses are permanent.
- **AI** — insurgents that infiltrate the draws, ambush from defilade, shoot-and-scoot, and exfil;
  civilians with pattern-of-life and panic flight; friendly soldiers that execute your intent. The
  squad leader runs the firefight (base-of-fire/maneuver, bound, break contact) and raises a
  **call-for-fire** like a real forward observer — only onto a PID'd, observed enemy and never inside
  its own danger-close radius — for you to approve or deny.
- **COIN — the real game.** Village attitudes you actually *move*: show up (presence), hold shuras
  (KLE) where elders make **asks** you keep or break (broken promises hurt more than kept ones
  help), and **secure a CERP project to completion** (a clinic they asked for moves a village far
  more than a culvert nobody wanted). **CERP is a managed two-way budget** (battalion stipend +
  project refunds, not a countdown). **Battalion directives** arrive on a cadence with deadlines —
  miss one and Higher's confidence drops; a civilian casualty fails *protect-the-population* on the
  spot. The end-of-tour score grades **counterinsurgency, not body count**. You can win every
  firefight and still lose the valley.

## Project structure

```
lib/sim/            Pure simulation engine (no React)
  rng.ts            Seeded RNG + value noise
  vec.ts            Vector / grid math
  terrain.ts        Procedural 5 m valley + 21 landcover classes + queries
  path.ts           Terrain-aware A* foot pathfinding (concealment bias)
  los.ts            Line of sight, concealment, detection (posture-aware)
  weapons.ts        US + insurgent weapon catalog
  ballistics.ts     Projectile + hit + wound model
  entities.ts       Soldiers / insurgents / civilians + factories + move postures
  combat.ts         Unit-level tick: perception, fire, projectiles, morale, fire support
  ai/               insurgent.ts · civilian.ts · friendly.ts
  campaign.ts       Shared campaign types + helpers (supplies, villages, weather)
  world/            The continuous world (one package, split by concern)
    world.ts        World class — the master clock, orchestration, orders
    types.ts        WorldState, Task, Project, MissionType, ids
    create.ts       createWorld / loadWorld factories
    director.ts     Enemy activity director (ambush / infiltrate / harass / attack)
    directives.ts   Battalion directive specs + live-metric completion logic
    tasks.ts        Strategic tasks (patrol / KLE / secure-build / project security)
    projects.ts     CERP project logistics + resupply
    events.ts       Decision events
    helpers.ts      Shared free functions
lib/render/         Canvas rendering: topo bake + ~160-asset SVG sprite/LOD system
  sprites.ts        Rasterize SVGs once → blit scaled/rotated (bake-once/blit-many)
  draw.ts           Units (symbol→figure LOD), COP structures, effects
  decoration.ts     Stable-hash vegetation/rock scatter by landcover
lib/audio/          Procedural battle audio (render-side observer; no assets, no deps)
  mapper.ts         PURE: sim events (effects/log/fire-missions/TIC) → AudioCue[] (headless)
  synth.ts/player.ts BROWSER: Web-Audio synthesis (osc + filtered noise + envelopes) + 3D mix
state/store.ts      Zustand store bridging React <-> the World (the real-time frame loop)
components/
  world/WorldView.tsx     The single live map (terrain + units + orders + planning)
  Icon.tsx                Authored UI icons throughout the chrome
  screens/                MenuScreen · LoadingScreen · DeployScreen · TourEndScreen
  TutorialCoach.tsx       In-game guided tutorial
app/                Next.js App Router entry
docs/visual-overhaul/   Map art bible (ART_BIBLE.md), 160 SVG assets, asset-bible.html
public/manual/      HTML field manual + tutorial
docs/               Design doc + wiki
scripts/            Headless smoke & balance harnesses (run with `npx tsx`)
```

## Verifying the engine

The engine runs headless. Two harnesses exercise it without a browser:

```bash
npx tsx scripts/smoke.ts          # build a world, send a patrol, run 30 game-min, print a play-by-play
npx tsx scripts/balance.ts 12 45  # 12 continuous deployments x 45 game-min; casualties & stall check
```

## Documentation

- `docs/DESIGN.md` — the master design document.
- `docs/wiki/` — systems, AI, campaign, architecture, and glossary.
- `public/manual/` — the in-world field manual and tutorial (HTML).

## Notes

- Determinism: a given seed reproduces a given valley and (given the same inputs) the same
  outcomes. The world RNG advances as you play; saves store the RNG state and the full live world.
- A debug handle is exposed in the browser as `window.__ITM` (the Zustand store);
  `window.__ITM.getState().world` is the live `World`.
