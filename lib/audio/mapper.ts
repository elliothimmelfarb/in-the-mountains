/**
 * CueMapper — the PURE, HEADLESS event->AudioCue[] translator. The audio analogue of
 * combat-fx.ts's `noteCombatEffects`: it reads live sim state (effects, the combat log,
 * fire missions, the TIC flag) and DESCRIBES the sounds to play, deduped against monotonic
 * high-water marks so every event voices exactly once. It owns ALL the marks, so dedup is
 * headless-testable (scripts/audio-probe.ts).
 *
 * Layer law (Law 7): no browser imports, no wall-clock, no PRNG stream. The only per-cue
 * variation is `cueVar` — a pure hash of the source id. Two same-seed worlds ticked the
 * same way yield byte-identical ordered cue lists (probe assertion B).
 *
 * Render-side convention: it imports the pure Effect/LogEntry/FireMission TYPES directly
 * from ../sim/combat exactly as the sibling renderer lib/render/combat-fx.ts does
 * (combat-fx.ts:18). The reverse never happens — lib/sim imports nothing from lib/audio
 * (probe assertion C).
 */
import type { Effect, LogEntry, FireMission } from "../sim/combat";
import { type AudioCue, cueVar } from "./cue";

/** Log kinds that earn a radio-bed cue. Plain "info" is intentionally silent so chatter
 *  doesn't carpet the net — only contact-relevant traffic squelches. */
const RADIO_KINDS = new Set<LogEntry["kind"]>([
  "contact",
  "radio",
  "support",
  "kia",
  "casualty",
  "objective",
]);

/** The minimal read surface the mapper needs from a CombatSim — kept structural so the
 *  probe can feed a hand-built object and the real `world.sim` both satisfy it. */
export interface CueSource {
  effects: Effect[];
  log: LogEntry[];
  fireMissions: FireMission[];
  inContact: boolean;
}

export class CueMapper {
  private lastFxId = -1;
  private lastLogId = -1;
  /** fm.id -> last status we already voiced, so a transition fires once. */
  private readonly fmSeen = new Map<number, FireMission["status"]>();
  private wasContact = false;

  /**
   * Pure: same inputs -> same ordered AudioCue[]. Mirrors `noteCombatEffects`'s
   * high-water-mark walk (combat-fx.ts:392-409): take the max id across the whole array
   * (robust to the 400-cap splice that shifts old entries out) and skip anything at or
   * below the previous mark. Each NEW effect id yields 0 or 1 cue (blood => 0 by design).
   */
  collect(sim: CueSource): AudioCue[] {
    const out: AudioCue[] = [];

    // 1) EFFECTS — muzzle/blast/impact/ricochet/smoke/frag/flare.
    let maxFx = this.lastFxId;
    for (const e of sim.effects) {
      if (e.id > maxFx) maxFx = e.id;
      if (e.id <= this.lastFxId) continue;
      const c = this.effectCue(e);
      if (c) out.push(c);
    }
    this.lastFxId = maxFx;

    // 2) LOG — a radio squelch+beep bed under contact-relevant traffic.
    let maxLog = this.lastLogId;
    for (const l of sim.log) {
      if (l.id > maxLog) maxLog = l.id;
      if (l.id <= this.lastLogId) continue;
      if (RADIO_KINDS.has(l.kind)) {
        out.push({ kind: "radio", v: cueVar(l.id, "rad"), gain: 1, srcId: l.id, srcStream: "log" });
      }
    }
    this.lastLogId = maxLog;

    // 3) FIRE MISSIONS — keyed by a per-id status MEMORY, not an id high-water mark, because a
    //    mission walks through several statuses. REALITY (verified combat.ts): the sim sets
    //    "requested" -> "firing" -> "complete"; the "inbound" status in the union is NEVER
    //    assigned. So:
    //      • "shot" (the tube report, "Shot, over.") fires the FIRST time we see a mission, in
    //        ANY pre-firing status — matching the request-time log line.
    //      • "splash" (+ danger-close klaxon) fires on entering "firing" (rounds landing).
    for (const fm of sim.fireMissions) {
      const prev = this.fmSeen.get(fm.id);
      if (prev !== fm.status) {
        if (prev === undefined && fm.status !== "firing" && fm.status !== "complete") {
          out.push({ kind: "shot", pos: { ...fm.target }, v: cueVar(fm.id, "shot"), gain: 1, srcId: fm.id, srcStream: "fm" });
        }
        if (fm.status === "firing") {
          out.push({ kind: "splash", pos: { ...fm.target }, v: cueVar(fm.id, "splash"), gain: 1, srcId: fm.id, srcStream: "fm" });
          if (fm.dangerClose) {
            out.push({ kind: "dangerclose", v: cueVar(fm.id, "dc"), gain: 1, srcId: fm.id, srcStream: "fm" });
          }
        }
        this.fmSeen.set(fm.id, fm.status);
      }
    }
    // GC completed/culled missions so the memory map doesn't grow unbounded across a tour.
    if (this.fmSeen.size) {
      const live = new Set(sim.fireMissions.map((fm) => fm.id));
      for (const id of this.fmSeen.keys()) if (!live.has(id)) this.fmSeen.delete(id);
    }

    // 4) TIC ONSET — the chills beat, fired once on the rising edge of contact (mirrors the
    //    store's _wasInContact latch, but mapper-owned so it stays headless-deterministic).
    if (sim.inContact && !this.wasContact) {
      out.push({ kind: "tic_sting", v: 0, gain: 1, srcId: -1, srcStream: "tic" });
    }
    this.wasContact = sim.inContact;

    return out;
  }

  /**
   * Advance every high-water mark to "now" WITHOUT emitting — used to fast-forward through a
   * time-warp / pause so the first live frame afterward doesn't dump a backlog of skipped
   * cues. Still pure (no wall-clock); just the dedup bookkeeping with the cues discarded.
   */
  skip(sim: CueSource): void {
    for (const e of sim.effects) if (e.id > this.lastFxId) this.lastFxId = e.id;
    for (const l of sim.log) if (l.id > this.lastLogId) this.lastLogId = l.id;
    for (const fm of sim.fireMissions) this.fmSeen.set(fm.id, fm.status);
    if (this.fmSeen.size) {
      const live = new Set(sim.fireMissions.map((fm) => fm.id));
      for (const id of this.fmSeen.keys()) if (!live.has(id)) this.fmSeen.delete(id);
    }
    this.wasContact = sim.inContact;
  }

  /** Effect -> cue. One switch pass; `blood` is the deliberate null (no sound). */
  private effectCue(e: Effect): AudioCue | null {
    const v = cueVar(e.id, e.kind);
    switch (e.kind) {
      case "muzzle": {
        const us = e.faction === "us" || e.faction === "ana";
        const mg = (e.size ?? 1) >= 1.5; // size 1.6 == hmg/mmg (combat.ts:925); the only fidelity available
        return {
          kind: mg ? (us ? "mg_us" : "mg_insurgent") : us ? "muzzle_us" : "muzzle_insurgent",
          pos: { ...e.pos },
          v,
          gain: mg ? 1 : 0.8,
          srcId: e.id,
          srcStream: "fx",
        };
      }
      case "blast": {
        if (e.ied) return { kind: "ied", pos: { ...e.pos }, v, gain: 1, srcId: e.id, srcStream: "fx" };
        const big = (e.size ?? 1) >= 1.0; // size = blastRadius/8 (combat.ts:993): RPG/40mm small, mortar/120 large
        return {
          kind: big ? "blast_large" : "blast_small",
          pos: { ...e.pos },
          v,
          gain: Math.min(1, e.size ?? 1),
          srcId: e.id,
          srcStream: "fx",
        };
      }
      case "impact":
        return { kind: "impact", pos: { ...e.pos }, v, gain: 0.6, srcId: e.id, srcStream: "fx" };
      case "ricochet":
        return { kind: "ricochet", pos: { ...e.pos }, v, gain: 0.7, srcId: e.id, srcStream: "fx" };
      case "smoke_pop":
        return { kind: "smoke_pop", pos: { ...e.pos }, v, gain: 0.8, srcId: e.id, srcStream: "fx" };
      case "frag_air":
        return { kind: "frag_air", pos: { ...e.pos }, v, gain: 0.9, srcId: e.id, srcStream: "fx" };
      case "flare":
        return { kind: "flare", pos: { ...e.pos }, v, gain: 0.5, srcId: e.id, srcStream: "fx" };
      case "blood":
        return null; // no sound — kept explicit so the probe sees a deliberate decision, not a gap
    }
  }
}
