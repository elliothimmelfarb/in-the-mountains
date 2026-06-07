import { clamp01 } from "../rng";
import { DirectiveKind } from "../campaign";
import type { World } from "./world";

/**
 * Battalion directives — the pressure from Higher. A directive is a tasking with a deadline,
 * a reward (higher confidence if delivered) and a penalty (if its deadline elapses while it's
 * still active). This module owns the per-kind specs and the completion logic for the kinds
 * whose progress is read live from the AO; the producer-driven kinds (presence/census/kle/
 * construct) are advanced from their producers (onStationEffects / tickProjects).
 *
 * The exhaustive `Record<DirectiveKind, …>` SPEC table makes the compiler fail until every
 * directive kind is handled — adding a new kind without a spec is a build error, not a silent gap.
 */
export interface DirectiveSpec {
  title: string;
  desc: string;
  reward: number; // higher-confidence gain on completion
  penalty: number; // higher-confidence loss if the deadline elapses while active
  days: number; // days from issue to deadline
}

export const DIRECTIVE_SPECS: Record<DirectiveKind, (w: World) => DirectiveSpec> = {
  presence: () => ({ title: "Establish Presence", desc: "Put boots in every village — show the flag.", reward: 12, penalty: 10, days: 14 }),
  kle: () => ({ title: "Meet the Elders", desc: "Conduct shuras with the village elders.", reward: 15, penalty: 8, days: 18 }),
  census: () => ({ title: "Census the Valley", desc: "Complete a census in at least three villages.", reward: 10, penalty: 7, days: 16 }),
  interdict: () => ({ title: "Interdict the Ratlines", desc: "Suppress enemy strength in the AO.", reward: 14, penalty: 12, days: 12 }),
  construct: () => ({ title: "Deliver a Project", desc: "Fund and complete a CERP project.", reward: 14, penalty: 9, days: 20 }),
  hold: () => ({ title: "Hold the Hostile Ground", desc: "Move every hostile village off hostile.", reward: 16, penalty: 11, days: 18 }),
  casualty: () => ({ title: "Protect the Population", desc: "Run the tour with no civilian casualties.", reward: 12, penalty: 14, days: 21 }),
};

/** The enemy-strength floor that completes an interdict directive, and the fallback baseline
 *  used when an old save has no startMetric snapshot. */
const INTERDICT_TARGET = 15;
const INTERDICT_FALLBACK_START = 45;

/**
 * Advance the live-metric directive kinds (interdict / hold / casualty). The producer-driven
 * kinds advance elsewhere. Each reads the AO and completes when its progress reaches 1.
 */
export function advanceLiveDirectives(w: World) {
  advanceInterdict(w);
  advanceHold(w);
  advanceCasualty(w);
}

function advanceInterdict(w: World) {
  const d = w.state.directives.find((x) => x.kind === "interdict" && x.status === "active");
  if (!d) return;
  const start = d.startMetric ?? INTERDICT_FALLBACK_START;
  const span = Math.max(1, start - INTERDICT_TARGET);
  d.progress = clamp01((start - w.state.enemyStrengthAbs) / span);
  if (d.progress >= 1) w.completeDirective(d);
}

function advanceHold(w: World) {
  const d = w.state.directives.find((x) => x.kind === "hold" && x.status === "active");
  if (!d) return;
  const hostile = w.state.villages.filter((v) => v.attitude < 0).length;
  d.progress = hostile === 0 ? 1 : clamp01(1 - hostile / Math.max(1, w.state.villages.length));
  if (d.progress >= 1) w.completeDirective(d);
}

function advanceCasualty(w: World) {
  const d = w.state.directives.find((x) => x.kind === "casualty" && x.status === "active");
  if (!d) return;
  // "Protect the population" completes by reaching the deadline with no US/ANA civcas since
  // issue — progress is time elapsed; a civcas after issuedDay FAILS it immediately (handled in
  // World.applyCivcasBacklash). So if it's still active at the deadline it has stayed clean.
  const span = Math.max(1, d.deadlineDay - d.issuedDay);
  d.progress = clamp01((w.day - d.issuedDay) / span);
  if (d.progress >= 1) w.completeDirective(d);
}
