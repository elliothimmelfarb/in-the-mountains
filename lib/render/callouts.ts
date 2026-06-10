/**
 * CalloutPresenter — the render-side consumer of the sim's diegetic callout bus
 * (`CombatSim.callouts`, emitted by `say()` in lib/sim/combat.ts). Draws each shout as a
 * brief dark plate just ABOVE the man who yelled it — "contact left!", "man down!",
 * "covering!" — anchored at the WORLD POSITION where it was shouted (a shout happens at a
 * place; the plate does not chase the moving figure).
 *
 * Pattern: the CueMapper high-water-mark walk (lib/audio/mapper.ts:53-64). `tick()` always
 * advances `lastId` to the max id seen — even when `ingest` is false — so a time-warp
 * (up to 700 sim slices in ONE frame, state/store.ts) or a pause/resume can never dump a
 * backlog of stale shouts onto the first live frame; warped-past callouts are consumed
 * silently. Robust to the sim's 64-cap ring-buffer splice for the same reason the mapper
 * is robust to the 400-cap log splice.
 *
 * Layer law (Law 7): React-free, no wall-clock reads (the caller passes nowMs from its
 * RAF), type-only imports from ../sim/combat — exactly the combat-fx.ts / mapper.ts
 * convention. Presentation-only state; nothing here feeds back into the sim.
 *
 * Visuals deliberately clone the nameplate look (lib/render/draw.ts:230-247): same mono
 * font family one step smaller, same dark rounded plate, and the SAME tactical-zoom gate
 * (cam.ppm > FIG_FADE0) so plates appear exactly when individual men do — never cluttering
 * the operational view where you track squads, not soldiers.
 */
import type { Callout, CombatSim } from "../sim/combat";
import { Camera, worldToScreen } from "./topo";
import { FIG_FADE0, figurePx } from "./draw";

/** At most this many plates on screen — a fight stays readable, not a comic strip. */
const MAX_ACTIVE = 3;
/** Plate lifetime (wall ms) — about how long the shout would hang in the air. */
const TTL_MS = 2400;
/** Fade-out window at the end of the lifetime (wall ms). */
const FADE_MS = 600;

export class CalloutPresenter {
  private lastId = -1;
  private active: { co: Callout; bornMs: number }[] = [];
  /** Wall-clock of the latest tick — lets draw() fade without its own clock read. */
  private nowMs = 0;

  /**
   * Walk new callouts (id > lastId) off the sim ring buffer. ALWAYS advances the mark —
   * with `ingest` false (warping) new shouts are swallowed silently, which is the
   * warp-safety. Call every RAF frame, before draw().
   */
  tick(sim: CombatSim, nowMs: number, ingest: boolean): void {
    this.nowMs = nowMs;
    let maxId = this.lastId;
    for (const co of sim.callouts) {
      if (co.id > maxId) maxId = co.id;
      if (co.id <= this.lastId) continue;
      if (ingest) this.active.push({ co, bornMs: nowMs });
    }
    this.lastId = maxId;
    // cap (cull oldest first) — only ever a couple of entries, shift is cheap and rare
    while (this.active.length > MAX_ACTIVE) this.active.shift();
    // expire in place — zero per-frame allocation (no filter/map)
    let w = 0;
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i];
      if (nowMs - a.bornMs < TTL_MS) this.active[w++] = a;
    }
    this.active.length = w;
  }

  /** Draw the live plates. Tactical zoom only — the same gate as the nameplates. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (this.active.length === 0 || cam.ppm <= FIG_FADE0) return;
    ctx.save();
    ctx.font = "8px var(--font-mono, monospace)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < this.active.length; i++) {
      const { co, bornMs } = this.active[i];
      const age = this.nowMs - bornMs;
      const alpha = age > TTL_MS - FADE_MS ? Math.max(0, (TTL_MS - age) / FADE_MS) : 1;
      if (alpha <= 0.02) continue;
      const [sx, sy] = worldToScreen(cam, co.pos.x, co.pos.y);
      if (sx < -60 || sy < -30 || sx > cam.vw + 60 || sy > cam.vh + 30) continue;
      // plate sits just above the figure (~14-24 px up depending on figure size)
      const ly = sy - figurePx(cam.ppm) * 0.5 - 11;
      const tw = ctx.measureText(co.text).width;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(12,13,10,0.78)";
      roundRect(ctx, sx - tw / 2 - 3, ly - 6, tw + 6, 12, 2);
      ctx.fill();
      ctx.fillStyle = "#f0e4c0";
      ctx.fillText(co.text, sx, ly);
    }
    ctx.restore();
  }
}

/** Same rounded plate as the nameplates (draw.ts roundRect is module-private). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
