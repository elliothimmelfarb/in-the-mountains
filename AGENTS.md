<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent guide — In the Mountains

A continuous-real-time counterinsurgency simulation. Next.js (App Router) + React 19 + TypeScript + Tailwind 4; the engine is pure deterministic TypeScript with seeded RNG.

## Commands

```bash
npm install
npm run dev          # dev server
npx tsc --noEmit     # typecheck — run before every commit
npm run build        # production build
npx tsx scripts/smoke.ts          # fast deterministic smoke of the whole sim
npx tsx scripts/balance.ts 3 20   # small balance sample
```

CI runs typecheck → build → smoke → balance on every push.

## Architecture in one line

Strict three layers, one bridge: pure React-free engine (`lib/sim`) → React-free Canvas/WebGL2 renderers (`lib/render`) → `state/store.ts` (Zustand), the only bridge. Read `docs/wiki/Architecture.md` first, then `docs/DESIGN.md`. Orientation, invariants, and judgment live in [CLAUDE.md](CLAUDE.md) — read it before changing anything; the invariants section is load-bearing.

## Verification culture

This repo verifies with bespoke probe scripts, not a conventional test suite. `scripts/` holds 50+ of them — `enemy-network-probe`, `cover-directional-probe`, `realism-probe`, `campaign-loop`, `combat-feel-probe`, and friends. Each probes one subsystem deterministically and prints a verdict. Before claiming a change works, run the probes that touch what you changed; when you fix a class of bug, extend the probe that should have caught it.

## Hard rules

- Determinism is a contract: same seed, same valley, same outcomes. `lib/sim` stays pure and React-free; unseeded randomness or wall-clock reads inside the engine are bugs.
- New persisted state goes in both `serialize()` and `loadWorld()`.
- Never write `enemyStrengthAbs` directly; route strength changes through a cell.
- Generated files are overwritten — edit sources and regenerate (`scripts/build-asset-manifest.mjs`, `scripts/build-asset-doc.mjs`).
