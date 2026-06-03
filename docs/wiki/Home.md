# In the Mountains — Wiki

The developer-and-designer companion to the game. For the player-facing reference, see the
in-world **[Field Manual](../../public/manual/index.html)** and **[Tutorial](../../public/manual/tutorial.html)**.

## Contents

- **[Simulation Systems](Simulation-Systems.md)** — terrain (5 m), pathfinding, postures, LOS, ballistics, the world tick.
- **[AI Doctrine](AI-Doctrine.md)** — how insurgents, civilians, and friendlies think.
- **[Campaign & COIN](Campaign-and-COIN.md)** — the continuous clock, tasks, projects, metrics, intel, events.
- **[Weapons](Weapons.md)** — the catalog and how stats feed the model.
- **[Architecture](Architecture.md)** — code layout, data flow, rendering, determinism.
- **[Glossary](Glossary.md)** — the milspeak.
- **[Design Document](../DESIGN.md)** — pillars and the full design.

## One-paragraph overview

A **single continuous real-time** game — no turns, no phases. One master clock (`World`,
in `lib/sim/world/`) drives the sun, weather, logistics, soldier fatigue, the enemy's tempo,
village construction, and combat on the same timeline. The `World` owns a persistent `CombatSim`
(the unit-level engine: perception, AI, ballistics, morale) and layers strategic subsystems on
top — an enemy director, time-gated tasks (patrols/KLE/projects), CERP project logistics, intel,
directives, and decision events. A procedurally generated valley (`Terrain`) resolved to 5-metre
cells is shared by everything. The whole engine under `lib/sim` is pure, deterministic TypeScript
seeded by a string; `state/store.ts` (Zustand) runs the real-time frame loop, holds the live
`World`, and exposes every player action; one React surface (`DeployScreen` + `WorldView`) renders
and drives input, with Canvas 2D doing the topographic and tactical drawing.

## Design pillars (short form)

1. The valley is the enemy — terrain dominates, now at 5 m fidelity.
2. Time is real and continuous — everything takes time; the valley never stops.
3. Every bullet matters — finite, heavy, individually simulated.
4. People, not pieces — named soldiers with fear and fatigue; losses are permanent.
5. Asymmetry — the enemy fights on his ground and his timeline.
6. COIN is logistics and patience — attitudes and projects win the valley, not body count.
7. Unpredictability — seeded but stochastic.
