export { World } from "./world";
export { createWorld, createTerrain, loadWorld } from "./create";
// RNG is re-exported here so the render-side audio MAPPER can pull the pure static
// `RNG.hashString` through the package barrel (barrel-only rule) for deterministic,
// wall-clock-free per-cue variation — mirroring the per-civ trait hash in ai/civilian.ts.
export { RNG } from "../rng";
export { applyWorldEventChoice, makeWorldEvent } from "./events";
// Pure COP-layout geometry shared with the renderer (the gym props draw at the same
// anchor the garrison sends its two lifters to) — through the barrel, per the layer rule.
export { gymSpot } from "./garrison";
// The enemy-picture gate + the weekly Commander's Assessment (both HUD surfaces read these through
// the barrel; the gating helper is shared so the panel, the map markers and the BUB can't drift).
export {
  enemyPicture,
  buildWeeklyAssessment,
  assessmentDue,
  advanceBubSchedule,
  bubSnapshotOf,
} from "./assessment";
export type {
  EnemyPicture,
  EnemyCellView,
  EnemyMarker,
  CacheMarker,
  Assessment,
  ValleySection,
  AttitudeLine,
  EnemySection,
  HigherSection,
  DirectiveLine,
  MenSection,
} from "./assessment";
export type {
  WorldState,
  Task,
  TaskKind,
  Project,
  ProjectStage,
  PendingEvent,
  ResupplyRun,
  FireRequest,
  MissionType,
  SquadSOP,
  MovementSOP,
  ContactSOP,
  EnemyCell,
  EnemyCache,
  EnemyNetwork,
  BubSnapshot,
} from "./types";
export {
  MISSION_LABEL,
  MOVEMENT_SOP_LABEL,
  CONTACT_SOP_LABEL,
  ROE_LABEL,
  defaultSOP,
  sopTechnique,
} from "./types";
