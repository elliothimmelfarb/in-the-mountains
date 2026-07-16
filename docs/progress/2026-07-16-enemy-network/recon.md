# Recon map — enemy lifecycle / persistence / intel / HUD seams (2026-07-16, @ a14da77)

Produced by a read-only recon pass; file:line anchors verified against HEAD on the date
above. Summary of load-bearing findings (full detail lives in the contract's citations):

## Enemy lifecycle
- `runDirector` (director.ts:15-55): heat drift → activity clock → roll routes to spawn
  fns. Hard gates: MAX_ACTIVE_ENEMY (:35), enemyStrengthAbs>1 (:36).
- Spawns: indirect :64-76 (no units), ambush :79-95, IED :103-138, infiltration
  :141-161, harass :164-179, complex :182-197, road :200-210. `spawnFighter` :212-232
  (per-batch squadId "acm-<clock>" :223; first man isLeader :229). `drawEnemy` :235-238
  is the ONLY scalar→bodies coupling.
- Fighters DESPAWN: exfil FSM terminal (insurgent.ts:130-160; evac=true at :145-158);
  `cullEnemies` (world.ts:595-607) removes KIA (−1 strength) and evac (NO strength cost).
  No persistent enemy state exists beyond enemyStrengthAbs + enemyHeat scalars.
- Cell-at-combat = shared squadId grouped fresh each tick (cell-combat.ts:52-59); leader
  state on Unit fields; kill-switch ITM_NOCELL=1.

## Persistence + determinism
- serialize (world.ts:85-104): { v, rngState, state (WHOLE), units, combat{...} }. v was
  7, now 9 (relief wave). No reader branches on v — migrations are field-presence
  defaults in loadWorld (create.ts:206-244).
- createWorld draw order is PINNED (create.ts:172-174 comment); enemyStrengthAbs =
  rng.int(40,70) at :130. RNG.fork is hash-based (rng.ts:111-114) — does NOT consume
  parent state; keyed forks are draw-order-safe.

## Intel
- IntelReport (campaign.ts:85-94): source/text/reliability/optional cx,cy. addIntel
  (world.ts:205-208) unshifts, cap 120, persisted.
- Emitters: director.ts:73/:130-137/:160; world.ts tickIntel :337-367; events.ts
  informant/dwell_* :194-382.
- Consumers: NONE in sim. Display only: Intel Feed panel (DeployScreen.tsx:568-582) +
  map markers for located intel (WorldView.tsx:319-333). Suspected-enemy ghosts are a
  SEPARATE transient system (sim.revealed; WorldView.tsx:513-530; 25 s fade).

## Villages / COIN glue
- VillageState (campaign.ts:52-83): attitude/cooperation/sympathy/grievances/ask/…
- `tickInsurgency` (world.ts:528-543): villages ARE enemy regen (sympathy/attitude +
  grievance floor → recruit → enemyStrengthAbs, clamp 0..80). Civcas mobilization
  world.ts:491. Caches exist ONLY as event flavor (events.ts:126-133, :293-311).
- Interdict directive reads the scalar (directives.ts:48-55, target 15).

## Relief / score (post-a14da77)
- Relief: evidence-file pattern test + grace + trend credit (world.ts checkTourEnd).
- computeTourScore (world.ts:~652-690): base(attitude .20 + rawVillageAtt .30 +
  stability .20 + conf .26 + attrition .06) + coin(proj*11 + dir*4 + kept*3 + won*3)
  − penalties(kia*1.5 + civcas*8 + broken*5 + dirFailed*4).

## HUD seams (for the follow-on wave)
- Left column DockPanels (DeployScreen.tsx:277-283) — intel/directives panels are the
  add-a-panel template (:280). EventModal :1383-1406 (decision-forcing).
- Map overlay template: intel-marker loop WorldView.tsx:319-333 inside draw()
  (WorldView.tsx:255); ghosts :513-530.
