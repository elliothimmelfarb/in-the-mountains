/**
 * Combat FX — the readable, beautiful combat layer for In the Mountains.
 *
 * This module is deliberately separate from draw.ts (units/COP/base effects) so the
 * combat-visual overhaul stays modular and out of the crowded core renderer. It owns
 * the cues that make a firefight legible at a glance, per the Combat Visual Language:
 *
 *   • a DASHED GROUND RING = indirect/CAS is landing here (with a closing telegraph +
 *     ETA countdown, and an amber/deep-shadow HAZARD ring when it's danger-close over
 *     our own men)
 *
 * Everything here is a faithful read-out of fields the sim already computes — no
 * invented data. Informational marks are flat "ink" (NO drop shadow, screen-weighted);
 * physical things obey the bible's NW-light rules. Animation is a slow, restrained
 * breath; nothing strobes. See docs/visual-overhaul/ART_BIBLE.md (§ Combat FX).
 */
import { Camera, worldToScreen } from "./topo";
import { FireMission, Effect } from "../sim/combat";
import { Unit } from "../sim/entities";
import { Projectile } from "../sim/ballistics";
import { drawWorldSprite, drawScreenSprite, hasSprite, lodAlpha } from "./sprites";

// --- locked dust palette (mirrors ART_BIBLE §3) -------------------------------------
const RUST = "181,83,42"; // #b5532a — hostile / threat
const AMBER = "224,167,43"; // #e0a72b — friendly / active
const SHADOW = "28,22,14"; // #1c160e — deep shadow / hazard bar
const INK = "232,229,212"; // map ink for the tiny ETA readout

/** Cosmetic clock (seconds). Wall-time so pulses stay smooth and pause-independent. */
function nowS(): number {
  return (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
}

/**
 * Indirect / CAS beaten-zone reticle.
 *
 * For every live fire mission (US mortars/CAS *and* enemy harassing fire — they share
 * `sim.fireMissions`), draw a dashed ground ring sized to the round's dispersion
 * (`spread`, in meters → world-scaled), so the player reads WHERE rounds will fall and
 * how big the beaten zone is. While the rounds are still inbound (`etaS > 0`) an outer
 * telegraph ring converges onto the beaten zone and a small ETA count ticks down —
 * turning "a disc teleported in" into "rounds are coming down HERE in 6… brace." When
 * the mission is danger-close to our own men, the ring switches to an amber/deep-shadow
 * hazard pattern and the at-risk friendlies get a pulsing halo.
 *
 * Styled distinct from the player's hover crosshair and any AI call-for-fire reticle:
 * this is a *dashed, world-scaled, animated* ring keyed to a real in-flight mission.
 */
export function drawFireMissions(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  fireMissions: FireMission[],
  friendlies: Unit[]
) {
  if (!fireMissions.length) return;
  const t = nowS();

  for (const fm of fireMissions) {
    if (fm.status === "complete") continue;
    const [sx, sy] = worldToScreen(cam, fm.target.x, fm.target.y);
    // beaten-zone radius: real dispersion in pixels, clamped so a far/zoomed-out
    // mission still reads as at least a small dashed ring (LOD: shrinks to a dot).
    const Rz = Math.max(9, fm.spread * cam.ppm);
    if (sx < -Rz * 3 || sy < -Rz * 3 || sx > cam.vw + Rz * 3 || sy > cam.vh + Rz * 3) continue;

    const enemy = fm.faction === "insurgent";
    const col = enemy ? RUST : AMBER;
    const firing = fm.etaS <= 0; // rounds are dropping now
    // closing telegraph: outer ring converges to the beaten zone as ETA → 0.
    const closeFrac = Math.max(0, Math.min(1.4, fm.etaS / 22));

    ctx.save();
    ctx.translate(sx, sy);
    ctx.lineCap = "round";

    if (fm.dangerClose) {
      // --- DANGER CLOSE: amber/deep-shadow hazard bars around the beaten zone -------
      const bars = 16;
      const pulse = 0.6 + 0.4 * Math.sin(t * 4.2); // urgent but not a strobe
      for (let i = 0; i < bars; i++) {
        const a0 = (i / bars) * Math.PI * 2 + t * 0.5;
        const a1 = a0 + (Math.PI * 2) / bars / 2;
        ctx.strokeStyle = i % 2 === 0 ? `rgba(${AMBER},${0.85 * pulse})` : `rgba(${SHADOW},0.8)`;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.arc(0, 0, Rz, a0, a1);
        ctx.stroke();
      }
    } else {
      // --- normal beaten-zone ring: rotating dashes (a "live", closing read) --------
      const breathe = firing ? 0.55 + 0.45 * Math.abs(Math.sin(t * 2.4)) : 0.85;
      ctx.strokeStyle = `rgba(${col},${breathe})`;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -t * 14; // dashes crawl inward
      ctx.beginPath();
      ctx.arc(0, 0, Rz, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // converging telegraph ring while inbound — visually "incoming"
    if (!firing && closeFrac > 0.02) {
      ctx.strokeStyle = `rgba(${col},${0.5 * (closeFrac / 1.4)})`;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([3, 7]);
      ctx.lineDashOffset = t * 10;
      ctx.beginPath();
      ctx.arc(0, 0, Rz * (1 + closeFrac), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // exact aimpoint pip — small cross + dot, deliberately smaller than the hover crosshair
    ctx.strokeStyle = `rgba(${col},0.95)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-5, 0); ctx.lineTo(5, 0);
    ctx.moveTo(0, -5); ctx.lineTo(0, 5);
    ctx.stroke();
    ctx.fillStyle = `rgba(${col},0.95)`;
    ctx.beginPath();
    ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // ETA countdown — map-space, tiny, only while inbound (not a HUD pill)
    if (!firing && fm.etaS > 0.4) {
      const label = Math.ceil(fm.etaS) + "s";
      ctx.font = "bold 10px var(--font-mono, monospace)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const ty = -Rz - 8;
      ctx.fillStyle = `rgba(${SHADOW},0.7)`;
      const w = ctx.measureText(label).width + 6;
      ctx.fillRect(-w / 2, ty - 6, w, 12);
      ctx.fillStyle = `rgba(${enemy ? RUST : INK},0.95)`;
      ctx.fillText(label, 0, ty + 0.5);
    }
    ctx.restore();
  }

  drawDangerCloseHalos(ctx, cam, fireMissions, friendlies, t);
}

function drawDangerCloseHalos(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  fireMissions: FireMission[],
  friendlies: Unit[],
  t: number
) {
  // --- danger-close halos on the at-risk friendlies (so the safety read is on the men) ---
  const dc = fireMissions.filter((f) => f.dangerClose && f.status !== "complete");
  if (dc.length) {
    const pulse = 0.45 + 0.4 * Math.abs(Math.sin(t * 3.6));
    for (const u of friendlies) {
      if (!u.alive) continue;
      let atRisk = false;
      for (const f of dc) {
        const dx = u.pos.x - f.target.x;
        const dy = u.pos.y - f.target.y;
        if (dx * dx + dy * dy < (f.spread * 1.25) ** 2) { atRisk = true; break; }
      }
      if (!atRisk) continue;
      const [ux, uy] = worldToScreen(cam, u.pos.x, u.pos.y);
      ctx.strokeStyle = `rgba(${AMBER},${pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ux, uy, Math.max(7, 1.4 * cam.ppm) + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// --- per-unit render cache: the SMOOTHED threat bearing so the crescent doesn't swim
// (threatDir is rewritten by every suppressing round) -------------------------------
const bearingCache = new Map<string, number>();

/** Sprite footprint in px (mirrors draw.ts figurePx) so a cue hugs the figure's base ring. */
function figurePx(ppm: number): number {
  return Math.max(15, Math.min(40, ppm * 7));
}

/** Shortest-arc lerp from a→b. */
function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Suppression cues — the "where is it coming from" and "who is pinned" reads, drawn over
 * the friendly figures. Both are faithful read-outs of the suppression model:
 *
 *   • THREAT-BEARING CRESCENT — a warm-rust arc hugging the edge of the soldier's base
 *     ring, on the bearing incoming fire is arriving from (Unit.threatDir), brighter and
 *     wider the more suppressed he is. The single clearest "contact is THAT way" cue.
 *   • PINNED RING — when suppression has broken his composure (pinned: head down, not
 *     effectively returning fire) the ring closes solid, tints rust, and pulses a slow
 *     breath. Distinguishes "taking fire but fighting" from "pinned."
 *
 * Gated to operational+ zoom (off on the strategic map sheet) and to units actually
 * under fire (suppression > 0.08), so it only ever appears in a live firefight.
 */
export function drawSuppressionCues(ctx: CanvasRenderingContext2D, cam: Camera, friendlies: Unit[]) {
  if (cam.ppm < 0.6) return; // strategic sheet stays clean
  const t = nowS();
  const live = new Set<string>();

  for (const u of friendlies) {
    if (!u.alive || u.suppression <= 0.08) continue;
    const [sx, sy] = worldToScreen(cam, u.pos.x, u.pos.y);
    if (sx < -30 || sy < -30 || sx > cam.vw + 30 || sy > cam.vh + 30) continue;
    live.add(u.id);

    // radius: hug whichever representation is on screen (symbol r at low zoom, figure ring high)
    const r = Math.max(4.5, Math.min(13, 0.95 * cam.ppm));
    const rr = Math.max(r + 3, figurePx(cam.ppm) * 0.5 + 2);

    // smoothed threat bearing
    if (u.threatDir) {
      const target = Math.atan2(u.threatDir.y, u.threatDir.x);
      const prev = bearingCache.get(u.id);
      const drawn = prev == null ? target : lerpAngle(prev, target, 0.18);
      bearingCache.set(u.id, drawn);

      // filled annular crescent on the threat bearing, with a dark keyline so it pops
      // off the dusty relief (the bible's "ink edge" trick) instead of washing out
      const half = 0.72; // ~82°
      const a0 = drawn - half;
      const a1 = drawn + half;
      const ro = rr + 5;
      const alpha = 0.34 + u.suppression * 0.5;
      ctx.beginPath();
      ctx.arc(sx, sy, ro, a0, a1);
      ctx.arc(sx, sy, rr, a1, a0, true);
      ctx.closePath();
      // dark backing keyline
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = `rgba(${SHADOW},${0.45 + u.suppression * 0.3})`;
      ctx.stroke();
      // rust fill + bright rim
      ctx.fillStyle = `rgba(${RUST},${alpha})`;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(232,150,90,${Math.min(0.95, alpha + 0.35)})`;
      ctx.stroke();
    }

    // pinned: composure broken under sustained suppression → closed, pulsing rust ring
    const pinned = u.suppression > 0.55 && u.composure < 0.4;
    if (pinned) {
      const pulse = 0.45 + 0.35 * Math.sin(t * 4.4); // slow breath ~0.7Hz
      const rp = rr + 2;
      // dark keyline backing so the closed ring reads on any terrain
      ctx.strokeStyle = `rgba(${SHADOW},0.5)`;
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.arc(sx, sy, rp, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${RUST},${0.6 + 0.35 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, rp, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // evict caches for units no longer under fire so the map doesn't grow unbounded
  if (bearingCache.size > live.size + 64) {
    for (const id of bearingCache.keys()) if (!live.has(id)) bearingCache.delete(id);
  }
}

// --- per-casualty render cache: the accumulated (capped) bleed-pool size ------------
const poolCache = new Map<string, number>();
const BLOOD = "156,44,32"; // #9c2c20-ish — venous
const ARTERIAL = "122,31,24"; // #7a1f18 — deeper, the TQ-now read
const TEAL = "111,174,159"; // #6fae9f — buddy-aid / CLS

/**
 * Casualty cues — the wounds-not-kills signature of this valley made legible. This draws
 * ONLY the states draw.ts does not already cover (it owns the KIA X, the down "✚", and the
 * hp bar), so there is never a second way to say the same thing:
 *
 *   • ARTERIAL-BLEED POOL — a dark-red ground stain that grows (CAPPED) under a man who is
 *     losing blood, with a slow pulse; deeper/redder and a touch faster when it's an
 *     arterial/TQ-now bleed. The "evac him NOW" read.
 *   • BUDDY-AID LINK — a short teal tether from a treater to the casualty he is working,
 *     bound strictly to brainState==='treating' + targetId so it can never lie.
 *
 * `units` should be the friendly roster (playerUnits) so a treater can resolve its casualty.
 */
export function drawCasualtyCues(ctx: CanvasRenderingContext2D, cam: Camera, units: Unit[]) {
  if (cam.ppm < 0.6) return;
  const t = nowS();
  const byId = new Map<string, Unit>();
  for (const u of units) byId.set(u.id, u);
  const live = new Set<string>();
  const poolCap = Math.max(5, figurePx(cam.ppm) * 0.5);

  for (const u of units) {
    if (!u.alive) continue;
    const [sx, sy] = worldToScreen(cam, u.pos.x, u.pos.y);
    if (sx < -30 || sy < -30 || sx > cam.vw + 30 || sy > cam.vh + 30) continue;

    // --- buddy-aid link (drawn first, under the pool) ---
    if (u.brainState === "treating" && u.targetId) {
      const cas = byId.get(u.targetId);
      if (cas && cas.alive) {
        const [cx, cy] = worldToScreen(cam, cas.pos.x, cas.pos.y);
        // dark backing so the teal tether reads on any terrain
        ctx.strokeStyle = `rgba(${SHADOW},0.4)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${TEAL},0.8)`;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        // a small medical cross at the casualty end
        ctx.strokeStyle = `rgba(${TEAL},0.95)`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy);
        ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3);
        ctx.stroke();
      }
    }

    // --- arterial / heavy bleed: a growing, capped, pulsing pool ---
    if (u.bleedRate > 0.4) {
      live.add(u.id);
      const arterial = (u.bleedTQable ?? 0) > 0;
      const grown = Math.min(poolCap, (poolCache.get(u.id) ?? poolCap * 0.3) + 0.05);
      poolCache.set(u.id, grown);
      const col = arterial ? ARTERIAL : BLOOD;
      ctx.fillStyle = `rgba(${col},0.55)`;
      ctx.beginPath();
      ctx.ellipse(sx, sy + grown * 0.25, grown, grown * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      // slow pulse RING (the eye-catcher) — a bright alert red so it pops on dark dirt,
      // over a dark backing; arterial pulses a touch faster
      const pulse = 0.45 + 0.4 * Math.sin(t * (arterial ? 5.0 : 3.2));
      const rad = grown + 3 + pulse * 2.5;
      ctx.strokeStyle = `rgba(${SHADOW},0.4)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(198,58,42,${0.55 + 0.4 * pulse})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (poolCache.size > live.size + 64) {
    for (const id of poolCache.keys()) if (!live.has(id)) poolCache.delete(id);
  }
}

// --- lingering scorch decals: a ground HE blast leaves a "a charge went off HERE" scar
// that persists long after the 0.6s blast effect is gone. The procedural blast is the
// flash; this is the crater. Render-only — keyed off the monotonic Effect.id so each
// detonation scars exactly once with no growing seen-set. -----------------------------
interface Scorch { x: number; y: number; rM: number; born: number; ied: boolean }
interface Spot { x: number; y: number; born: number }
const scorches: Scorch[] = [];
const reveals: Spot[] = []; // last-seen muzzle origin of an UNCONFIRMED (hidden) shooter
let lastFxEid = -1;
const SCORCH_LIFE = 9; // seconds
const REVEAL_LIFE = 6;

/**
 * Watch the live effect list for fresh combat events, deduped by the monotonic Effect.id:
 *  • ground-HE blasts → a lingering scorch crater
 *  • a HOSTILE muzzle flash whose origin is NOT near a confirmed-revealed enemy → a
 *    suspected-shooter pinpoint, so the player can act on "fire from the treeline THERE"
 *    even after the 0.12 s flash. (The flash is already drawn, so this is no x-ray.)
 * `confirmed` = world positions of enemies currently in sight (so a visible MG doesn't
 * litter pinpoints over itself).
 */
export function noteCombatEffects(effects: Effect[], confirmed: { x: number; y: number }[] = []) {
  const t = nowS();
  let maxId = lastFxEid;
  for (const e of effects) {
    if (e.id > maxId) maxId = e.id;
    if (e.id <= lastFxEid) continue;
    if (e.kind === "blast" && (e.size ?? 0) >= 0.55) {
      scorches.push({ x: e.pos.x, y: e.pos.y, rM: (e.size ?? 1) * 8, born: t, ied: !!e.ied });
      if (scorches.length > 48) scorches.shift();
    } else if (e.kind === "muzzle" && e.faction === "insurgent") {
      if (confirmed.some((c) => (c.x - e.pos.x) ** 2 + (c.y - e.pos.y) ** 2 < 100)) continue; // visible already
      const near = reveals.find((rv) => (rv.x - e.pos.x) ** 2 + (rv.y - e.pos.y) ** 2 < 36);
      if (near) near.born = t; // sustained fire keeps the pinpoint fresh
      else { reveals.push({ x: e.pos.x, y: e.pos.y, born: t }); if (reveals.length > 40) reveals.shift(); }
    }
  }
  lastFxEid = maxId;
}

/** Draw the suspected-shooter pinpoints (a rust dashed diamond fading over a few seconds). */
export function drawFogReveals(ctx: CanvasRenderingContext2D, cam: Camera) {
  if (!reveals.length) return;
  const t = nowS();
  for (let i = reveals.length - 1; i >= 0; i--) {
    const rv = reveals[i];
    const age = t - rv.born;
    if (age > REVEAL_LIFE) { reveals.splice(i, 1); continue; }
    const a = (age < 0.2 ? age / 0.2 : 1 - (age - 0.2) / (REVEAL_LIFE - 0.2)) * 0.9;
    const [px, py] = worldToScreen(cam, rv.x, rv.y);
    const s = 6;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.strokeStyle = `rgba(${RUST},0.95)`;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(px, py - s); ctx.lineTo(px + s, py); ctx.lineTo(px, py + s); ctx.lineTo(px - s, py); ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${RUST},0.95)`;
    ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// --- contact onset (TIC) ------------------------------------------------------------
let _lastContactSeenT = -999; // wall-clock of the last frame we saw any contact
let _onsetT = -999; //          when the current contact episode kicked off

/**
 * Contact-onset starburst — yanks the eye to where a firefight just kicked off, so the
 * player doesn't discover a TIC three casualties later. A brief expanding rust starburst
 * fires on the FIRST contact after a lull (debounced: a flicker or a brief pause won't
 * re-fire it). At zoomed-OUT bands — where the per-soldier cues are invisible — a small
 * pulsing contact glyph persists at the contact centroid so a distant fight stays on the
 * map sheet. Render-only: "in contact" is derived from the friendly roster, no sim state.
 */
export function drawContactMarker(ctx: CanvasRenderingContext2D, cam: Camera, friendlies: Unit[]) {
  const t = nowS();
  let sx = 0, sy = 0, n = 0;
  for (const u of friendlies) {
    if (u.alive && (u.suppression > 0.12 || (u.visibleEnemyIds && u.visibleEnemyIds.length > 0))) {
      sx += u.pos.x; sy += u.pos.y; n++;
    }
  }
  if (n === 0) return; // no contact — and the gap lets the next onset re-fire
  if (t - _lastContactSeenT > 4) _onsetT = t; // first contact after a >4s lull
  _lastContactSeenT = t;

  const [px, py] = worldToScreen(cam, sx / n, sy / n);
  // ONSET: an expanding twin-ring rust starburst over ~1.3s
  const age = t - _onsetT;
  if (age < 1.3) {
    const k = age / 1.3;
    const R = 8 + k * 46;
    ctx.strokeStyle = `rgba(${RUST},${0.85 * (1 - k)})`;
    ctx.lineWidth = 2.6 * (1 - k) + 0.4;
    ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, R * 0.58, 0, Math.PI * 2); ctx.stroke();
  }
  // PERSISTENT aggregate glyph only when zoomed out (the per-soldier cues carry it in close)
  if (cam.ppm < 1.1 && hasSprite("contact-marker")) {
    const pulse = 0.8 + 0.2 * Math.sin(t * 3.2);
    drawScreenSprite(ctx, "contact-marker", px, py, 22, { alpha: 0.85 * pulse });
  }
}

// --- LOD aggregation: combat haze ---------------------------------------------------
const HAZE_CELL = 50; // metres per bin

/**
 * Below tactical zoom, a 30-unit firefight is a mush of tiny flickering muzzle/tracer/blood
 * dots — illegible AND a draw-count spike. This collapses the small-arms layer into a few
 * warm dust-fire HAZE blobs (one per active ~50 m bin), crossfading IN exactly as the
 * per-round draws are gated OUT (see draw.ts). One shared per-frame bin pass, so at high
 * unit counts it nets FAR fewer draws (a handful of blobs vs hundreds of rounds).
 */
export function drawCombatHaze(ctx: CanvasRenderingContext2D, cam: Camera, projectiles: Projectile[], effects: Effect[]) {
  const hazeA = 1 - lodAlpha(cam.ppm, 0.45, 1.0); // full below 0.45 ppm, gone by 1.0
  if (hazeA <= 0.03) return;
  const bins = new Map<string, { sx: number; sy: number; w: number }>();
  const bin = (x: number, y: number, w: number) => {
    const k = Math.floor(x / HAZE_CELL) + ":" + Math.floor(y / HAZE_CELL);
    let b = bins.get(k);
    if (!b) { b = { sx: 0, sy: 0, w: 0 }; bins.set(k, b); }
    b.sx += x * w; b.sy += y * w; b.w += w;
  };
  for (const p of projectiles) if (!p.indirect) bin(p.pos.x, p.pos.y, 1);
  for (const e of effects) if (e.kind === "muzzle") bin(e.pos.x, e.pos.y, 1.6);
  if (!bins.size) return;
  for (const b of bins.values()) {
    if (b.w < 1.2) continue;
    const [px, py] = worldToScreen(cam, b.sx / b.w, b.sy / b.w);
    const inten = Math.min(1, b.w / 10);
    const R = 22 + inten * 30;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, R);
    grad.addColorStop(0, `rgba(210,150,92,${0.3 * inten * hazeA})`);
    grad.addColorStop(0.6, `rgba(190,120,70,${0.16 * inten * hazeA})`);
    grad.addColorStop(1, "rgba(190,120,70,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw the lingering scorch decals (call early — they sit on the ground, under units). */
export function drawScorchDecals(ctx: CanvasRenderingContext2D, cam: Camera) {
  if (!scorches.length || !hasSprite("fx-blast-scorch")) return;
  const t = nowS();
  for (let i = scorches.length - 1; i >= 0; i--) {
    const s = scorches[i];
    const age = t - s.born;
    if (age > SCORCH_LIFE) { scorches.splice(i, 1); continue; }
    // quick bloom in, slow fade out
    const a = age < 0.3 ? age / 0.3 : 1 - (age - 0.3) / (SCORCH_LIFE - 0.3);
    // an IED initiation craters bigger and dirtier than a mortar splash
    const widthM = s.rM * (s.ied ? 2.0 : 1.5);
    drawWorldSprite(ctx, cam, "fx-blast-scorch", s.x, s.y, { widthM, alpha: Math.max(0, a) * (s.ied ? 0.95 : 0.82) });
  }
}
