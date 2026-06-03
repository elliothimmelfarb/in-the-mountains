# In the Mountains — Wiki

The developer-and-designer companion to the game. For the player-facing reference, see the
in-world **[Field Manual](../../public/manual/index.html)** and **[Tutorial](../../public/manual/tutorial.html)**.

## Contents

- **[Simulation Systems](Simulation-Systems.md)** — terrain, line of sight, ballistics, morale, the tick.
- **[AI Doctrine](AI-Doctrine.md)** — how insurgents, civilians, and friendlies think.
- **[Campaign & COIN](Campaign-and-COIN.md)** — the strategic layer, metrics, intel, events.
- **[Weapons](Weapons.md)** — the catalog and how stats feed the model.
- **[Architecture](Architecture.md)** — code layout, data flow, rendering, determinism.
- **[Glossary](Glossary.md)** — the milspeak.
- **[Design Document](../DESIGN.md)** — pillars and the full design.

## One-paragraph overview

A two-layer game. The **command layer** is a turn-based COIN management sim resolved by phase of
day at a combat outpost. The **contact layer** is a real-time-with-pause tactical combat sim that
the command layer drops you into on contact. A single procedurally generated valley (`Terrain`) is
shared by both. The whole engine under `lib/sim` is pure, deterministic TypeScript seeded by a
string; `state/store.ts` (Zustand) holds the live `CampaignState` and the active `CombatSim` and
exposes every player action; React components render and drive input, with Canvas 2D doing the
topographic and tactical drawing.

## Design pillars (short form)

1. The valley is the enemy — terrain dominates.
2. Every bullet matters — finite, heavy, individually simulated.
3. People, not pieces — named soldiers with fear and fatigue; losses are permanent.
4. Asymmetry — the enemy fights on his ground and his timeline.
5. COIN is the real game — attitudes win the valley, not body count.
6. Unpredictability — seeded but stochastic.
