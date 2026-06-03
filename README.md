# In the Mountains

> A deep tactical-strategic simulation of asymmetric warfare in the mountains of
> Afghanistan, c. 2011. Command a remote combat outpost in a procedurally generated
> Korengal-like valley: manage personnel and logistics, plan patrols on a topographic
> map, fight per-bullet tactical engagements with full line-of-sight and concealment,
> and wage counterinsurgency where the terrain itself is the enemy.

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

Two read-anytime documents are served statically:

- **Field Manual** — `/manual/index.html`
- **Interactive Tutorial** — `/manual/tutorial.html`

## What's simulated

- **Procedural valley terrain** — meandering river floor, steep ridgelines, spurs, draws,
  terraced fields, orchards, forest, scree, villages, roads, and trails — with shaded-relief
  topographic rendering and contour lines. Terrain drives elevation, slope, cover, concealment,
  movement cost, and line of sight.
- **Line of sight** — elevation ray-casting with partial defilade ("heads over the ridge"),
  vegetation/canopy concealment, and dynamic smoke.
- **Every bullet** — each round is a real projectile with muzzle velocity, time of flight, and a
  dispersion folded from weapon mechanics, marksmanship, stance, fatigue, movement, and suppression.
  Cover can stop an on-target round depending on penetration. Suppression accrues from near misses.
- **People, not pieces** — named soldiers with attributes, morale/composure, suppression, fatigue,
  regional wounds (with body armor), bleeding, buddy aid, and medics.
- **AI** — insurgents that ambush from defilade, mass fire, shoot-and-scoot, and exfil up the draws;
  civilians with pattern-of-life and panic flight; friendly soldiers that execute your intent with
  autonomy (cover, return fire, reload, treat).
- **Campaign / COIN** — a full deployment: phases of day, weather and light, logistics, village
  attitudes, shuras and CERP projects, SIGINT/HUMINT intel, battalion directives, decision events,
  and an end-of-tour assessment. You can win every firefight and still lose the valley.

## Project structure

```
lib/sim/            Pure simulation engine (no React)
  rng.ts            Seeded RNG + value noise
  vec.ts            Vector / grid math
  terrain.ts        Procedural valley + terrain queries
  los.ts            Line of sight, concealment, detection
  weapons.ts        US + insurgent weapon catalog
  ballistics.ts     Projectile + hit + wound model
  entities.ts       Soldiers / insurgents / civilians + factories
  combat.ts         Tactical tick: perception, fire, projectiles, morale, fire support
  ai/               insurgent.ts · civilian.ts · friendly.ts
  campaign.ts       Strategic state, phases, attrition, metrics, intel
  patrol.ts         Mission planning, march/contact resolution, encounter building
  events.ts         Decision events
lib/render/         Canvas rendering (topo bake, markers, units, effects)
state/store.ts      Zustand store bridging React <-> engine
components/         Screens, map, tactical view, tutorial coach
app/                Next.js App Router entry
public/manual/      HTML field manual + tutorial
docs/               Design doc + wiki
scripts/            Headless smoke & balance harnesses (run with `npx tsx`)
```

## Verifying the engine

The engine runs headless. Two harnesses exercise it without a browser:

```bash
npx tsx scripts/smoke.ts        # one full campaign + encounter, prints a play-by-play
npx tsx scripts/balance.ts 30   # 30 forced engagements; reports casualties & checks for stalls
```

## Documentation

- `docs/DESIGN.md` — the master design document.
- `docs/wiki/` — systems, AI, campaign, architecture, and glossary.
- `public/manual/` — the in-world field manual and tutorial (HTML).

## Notes

- Determinism: a given seed reproduces a given valley and (given the same inputs) the same
  outcomes. The campaign-level RNG advances as you play.
- A debug handle is exposed in the browser as `window.__ITM` (the Zustand store).
