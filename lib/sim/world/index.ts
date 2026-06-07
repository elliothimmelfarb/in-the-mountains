export { World } from "./world";
export { createWorld, createTerrain, loadWorld } from "./create";
// RNG is re-exported here so the render-side audio MAPPER can pull the pure static
// `RNG.hashString` through the package barrel (barrel-only rule) for deterministic,
// wall-clock-free per-cue variation — mirroring the per-civ trait hash in ai/civilian.ts.
export { RNG } from "../rng";
export { applyWorldEventChoice, makeWorldEvent } from "./events";
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
} from "./types";
export {
  MISSION_LABEL,
  MOVEMENT_SOP_LABEL,
  CONTACT_SOP_LABEL,
  ROE_LABEL,
  defaultSOP,
  sopTechnique,
} from "./types";
