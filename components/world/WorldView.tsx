"use client";
import { useEffect, useRef } from "react";
import { useGame, getAudio } from "@/state/store";
import { Land } from "@/lib/sim/terrain";
import { Camera, drawTerrain, drawGrid, drawWeather, worldToScreen, screenToWorld } from "@/lib/render/topo";
import { drawUnit, drawSquadIcon, drawProjectiles, drawEffects, drawSmoke, drawLOSLines, drawPath, drawCop, FIG_FADE0 } from "@/lib/render/draw";
import { drawFireMissions, drawSuppressionCues, drawCasualtyCues, drawScorchDecals, drawContactMarker, drawFogReveals, drawCombatHaze, noteCombatEffects, drawNightLights, noteShakeEvents, drawEdgeFlash, drawOffscreenContactPointer, getContactCentroid } from "@/lib/render/combat-fx";
import { drawDecoration } from "@/lib/render/decoration";
import { loadSprites, spritesReady, drawScreenSprite, drawWorldSprite, hasSprite, lodAlpha } from "@/lib/render/sprites";
import { ASSETS } from "@/lib/render/asset-manifest.generated";
import { Unit } from "@/lib/sim/entities";

const LAND_NAME: Record<number, string> = {
  [Land.River]: "River",
  [Land.Marsh]: "Marsh",
  [Land.DryWash]: "Dry wash",
  [Land.Cropland]: "Cropland",
  [Land.Terrace]: "Terraced field",
  [Land.TerraceWall]: "Terrace wall",
  [Land.Orchard]: "Orchard",
  [Land.Meadow]: "Upland pasture",
  [Land.Grass]: "Open ground",
  [Land.Scrub]: "Holly scrub",
  [Land.Forest]: "Forest",
  [Land.Scree]: "Scree",
  [Land.Boulders]: "Boulders",
  [Land.Rock]: "Rock",
  [Land.Cliff]: "Cliff",
  [Land.Compound]: "Compound (qalat)",
  [Land.CompoundWall]: "Compound wall",
  [Land.Cemetery]: "Cemetery",
  [Land.Road]: "Road",
  [Land.Track]: "Track",
  [Land.Trail]: "Trail",
  [Land.Footbridge]: "Footbridge",
  [Land.Hesco]: "HESCO wall",
  [Land.Structure]: "Structure",
  [Land.Gravel]: "Gravel pad",
};

/** Screen-space centroid helper for the squad-intent overlays. */
function unitsCentroid(us: { pos: { x: number; y: number } }[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const u of us) { x += u.pos.x; y += u.pos.y; }
  const n = Math.max(1, us.length);
  return { x: x / n, y: y / n };
}

/** A capped maneuver arrow with a filled head (screen coords). */
function drawManeuverArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.min(Math.hypot(x1 - x0, y1 - y0), 95);
  if (len < 8) return;
  const ex = x0 + Math.cos(ang) * len;
  const ey = y0 + Math.sin(ang) * len;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.setLineDash([]);
  const h = 7;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - Math.cos(ang - 0.5) * h, ey - Math.sin(ang - 0.5) * h);
  ctx.lineTo(ex - Math.cos(ang + 0.5) * h, ey - Math.sin(ang + 0.5) * h);
  ctx.closePath();
  ctx.fill();
}

export default function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ cx: 0, cy: 0, ppm: 0.4, vw: 800, vh: 600 });
  const lastRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number; box: boolean; pan: boolean } | null>(null);
  const hoverRef = useRef<{ wx: number; wy: number } | null>(null);
  const initCam = useRef(false);
  // camera-punch game-feel: a transient shake (applied as a draw-time transform offset, NEVER
  // a write to cx/cy) + a danger-close rust edge-flash that decays. Set by noteShakeEvents.
  const shakeRef = useRef({ mag: 0, until: 0, durS: 0.35, edge: 0, edgeUntil: 0 });
  // TIC-onset cue: wall-clock of the last frame we saw contact, to debounce a one-shot nudge.
  const contactRef = useRef(-999);

  // Rasterize the authored SVG asset library once on mount (bake-once / blit-many).
  // The loading screen normally pre-warms this; the guard skips a redundant re-raster on
  // deploy and still covers the resume-from-memory path where no loading screen ran.
  useEffect(() => {
    if (ASSETS.length && !spritesReady()) loadSprites(ASSETS);
    // dev: programmatic camera control for screenshot verification
    (window as unknown as { __setCam?: (x: number, y: number, ppm?: number) => void }).__setCam = (x, y, ppm) => {
      camRef.current.cx = x;
      camRef.current.cy = y;
      if (ppm) camRef.current.ppm = ppm;
    };
    // AUDIO: the AudioContext must be created/resumed inside a USER GESTURE (browser autoplay
    // policy + Next 16 client rules). The first existing gesture — Deploy / Step Off / canvas
    // click / any keydown — unlocks it, then we sync the persisted mute/volume into the engine
    // (it has no context to set before unlock). once:true => self-removes after firing.
    const unlock = () => {
      const a = getAudio();
      a.unlock();
      const st = useGame.getState();
      a.setMasterVolume(st.audioVolume);
      a.setMuted(st.audioMuted);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    // expose the engine for the live audio-verification harness (debug ring buffer).
    (window as unknown as { __audio?: ReturnType<typeof getAudio> }).__audio = getAudio();

    // JUMP-TO-CONTACT: a persistent (NOT once) keydown so the player can snap the camera to
    // an active firefight on the 2.56 km map. Bound to 'c' (contact) ONLY — NOT Space, which the
    // HUD owns as the pause key (DeployScreen onKey); binding both here double-fired pause+jump.
    // Reuses the exact in-contact predicate the off-screen pointer / contact marker use. This is a
    // SEPARATE listener from the one-shot audio unlock above — do not merge; the unlock self-removes.
    const jumpToContact = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c") return;
      // don't hijack typing in inputs/textareas
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      const w = useGame.getState().world;
      if (!w) return;
      const c = getContactCentroid(w.sim.playerUnits());
      if (!c) return;
      e.preventDefault();
      camRef.current.cx = c.x;
      camRef.current.cy = c.y;
      camRef.current.ppm = Math.max(camRef.current.ppm, 1.2); // zoom in enough to fight it
    };
    window.addEventListener("keydown", jumpToContact);

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("keydown", jumpToContact);
    };
  }, []);

  useEffect(() => {
    const w0 = useGame.getState().world;
    if (!w0) return;
    if (!initCam.current) {
      const cop = w0.copWorld();
      camRef.current.cx = cop.x;
      camRef.current.cy = cop.y;
      camRef.current.ppm = 0.7;
      initCam.current = true;
    }
    let raf = 0;
    lastRef.current = performance.now();
    const loop = (now: number) => {
      const realDt = Math.min(0.1, (now - lastRef.current) / 1000);
      lastRef.current = now;
      useGame.getState().frame(realDt);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (canvas && wrap) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
          canvas.width = cw * dpr;
          canvas.height = ch * dpr;
          canvas.style.width = cw + "px";
          canvas.style.height = ch + "px";
        }
        const ctx = canvas.getContext("2d")!;
        // CAMERA-PUNCH: apply the transient shake as a draw-time TRANSFORM offset, not a
        // write to cx/cy — so it can't fight pan / __setCam / the audio listener pose. A
        // restrained, decaying jitter; zero offset when no impulse is live.
        const sh = shakeRef.current;
        const nowSr = now / 1000;
        const decay = sh.until > nowSr ? (sh.until - nowSr) / sh.durS : 0;
        const ox = decay > 0 ? Math.sin(now * 0.06) * sh.mag * decay : 0;
        const oy = decay > 0 ? Math.cos(now * 0.051) * sh.mag * decay : 0;
        ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
        camRef.current.vw = cw;
        camRef.current.vh = ch;
        draw(ctx, camRef.current, now);
        // feed the audio listener pose (positional pan + distance + zoom-scaled radius).
        getAudio().setCamera(camRef.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function draw(ctx: CanvasRenderingContext2D, cam: Camera, nowMs = 0) {
    const st = useGame.getState();
    const w = st.world;
    if (!w) return;
    const sim = w.sim;
    const terrain = w.terrain;
    const night = 1 - w.ambientLight();
    ctx.clearRect(0, 0, cam.vw, cam.vh);
    drawTerrain(ctx, terrain, cam, night * 0.7);
    drawDecoration(ctx, terrain, cam); // scattered trees/rocks fade in at tactical zoom
    if (cam.ppm > 0.22) drawGrid(ctx, terrain, cam, cam.ppm > 0.9 ? 100 : 200);

    // weather as atmosphere — over the relief/decoration, under the tactical layer, so it
    // never hides the fight. Reads world.state.weather + the live wind drift (sim.weather).
    const wx = w.state.weather;
    drawWeather(ctx, cam, {
      label: wx.label, precip: wx.precip, visibilityM: wx.visibilityM, wind: wx.wind,
      windX: sim.weather.windX ?? 0, windY: sim.weather.windY ?? 0,
      minElev: terrain.minElev, elevRange: terrain.maxElev - terrain.minElev,
      elevAt: (ex, ey) => terrain.elevAt(ex, ey),
    }, night);

    const windV = { x: sim.weather.windX ?? 0, y: sim.weather.windY ?? 0 };
    drawSmoke(ctx, cam, sim.smoke, windV);

    // named features — milspec terrain glyphs + label
    ctx.textAlign = "center";
    for (const f of terrain.features) {
      const c = terrain.cellCenter(f.cx, f.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      if (x < -40 || y < -40 || x > cam.vw + 40 || y > cam.vh + 40) continue;
      const fid = "marker-" + (f.kind === "bridge" ? "bridge" : f.kind === "junction" ? "junction" : f.kind === "saddle" ? "saddle" : f.kind === "spur" ? "spur" : f.kind === "draw" ? "draw" : "peak");
      const drew = hasSprite(fid) && drawScreenSprite(ctx, fid, x, y, 22);
      if (!drew) {
        ctx.fillStyle = "rgba(216,214,196,0.5)";
        ctx.font = "9px var(--font-mono, monospace)";
        ctx.fillText("▲ " + f.name, x, y - 4);
      } else if (cam.ppm > 0.4) {
        ctx.fillStyle = "rgba(216,214,196,0.62)";
        ctx.font = "9px var(--font-mono, monospace)";
        ctx.fillText(f.name, x, y + 16);
      }
    }

    // intel markers — source-typed milspec glyphs sized by reliability
    for (const r of w.state.intel.slice(0, 24)) {
      if (r.cx === undefined || r.cy === undefined) continue;
      const c = terrain.cellCenter(r.cx, r.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      const iid = r.source === "SIGINT" ? "marker-intel-sigint" : r.source === "HUMINT" ? "marker-intel-humint" : "marker-intel-visual";
      const drew = hasSprite(iid) && drawScreenSprite(ctx, iid, x, y, 13 + r.reliability * 9, { alpha: 0.5 + r.reliability * 0.5 });
      if (!drew) {
        const col = r.source === "SIGINT" ? "224,167,43" : r.source === "HUMINT" ? "111,174,84" : "200,120,60";
        ctx.fillStyle = `rgba(${col},${0.18 + r.reliability * 0.4})`;
        ctx.beginPath();
        ctx.arc(x, y, 3 + r.reliability * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // villages — qalat compound footprint fades in at zoom; attitude banner pin always
    for (const v of w.state.villages) {
      const c = terrain.cellCenter(v.cx, v.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      if (x < -80 || y < -80 || x > cam.vw + 80 || y > cam.vh + 80) continue;
      const sel = st.selectedVillage === v.id;
      const pid = v.attitude > 20 ? "pin-village-good" : v.attitude < -20 ? "pin-village-hostile" : "pin-village-neutral";

      // qalat compound footprint fades in at tactical zoom (pin fades out under it)
      const qA = lodAlpha(cam.ppm, 0.7, 1.6);
      const tier = v.population < 140 ? 0 : v.population < 340 ? 1 : 2;
      const qid = tier === 0 ? "qalat-small" : tier === 1 ? "qalat-medium" : "qalat-large";
      const qW = tier === 0 ? 24 : tier === 1 ? 36 : 50;
      if (qA > 0.02 && hasSprite(qid)) drawWorldSprite(ctx, cam, qid, c.x, c.y, { widthM: qW, alpha: qA });
      const pinA = 1 - qA * 0.82;

      if (sel) {
        ctx.strokeStyle = "rgba(240,228,192,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (pinA > 0.04 && hasSprite(pid)) {
        drawScreenSprite(ctx, pid, x, y - (qA > 0.1 ? qW * cam.ppm * 0.5 : 0), 28, { alpha: pinA });
      } else if (!hasSprite(pid)) {
        const col = v.attitude > 20 ? "#6fae54" : v.attitude < -20 ? "#c0392b" : "#e0a72b";
        ctx.fillStyle = col;
        ctx.strokeStyle = sel ? "#f0e4c0" : "#0c0d0a";
        ctx.lineWidth = sel ? 2 : 1;
        ctx.beginPath();
        ctx.rect(x - 5, y - 4, 10, 8);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 4);
        ctx.lineTo(x, y - 9);
        ctx.lineTo(x + 6, y - 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(232,229,212,0.95)";
      ctx.font = "10px var(--font-mono, monospace)";
      ctx.fillText(v.name, x, y + 14);
      if (v.lastVisitedDay >= 0) {
        ctx.fillStyle = "#6fae54";
        ctx.fillText("✓", x + 20, y - 8);
      }
      if (v.projects.length) {
        ctx.fillStyle = "#5b9bd8";
        ctx.fillText("⚒", x - 20, y - 8);
      }
    }

    // active project sites
    for (const p of w.state.projects) {
      if (p.stage === "complete") continue;
      const v = w.state.villages.find((x) => x.id === p.villageId);
      if (!v) continue;
      const c = terrain.cellCenter(v.cx, v.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      ctx.strokeStyle = p.stage === "building" ? "#5b9bd8" : p.stage === "sabotaged" ? "#c0392b" : "#c2a878";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 80 * cam.ppm, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // COP structure (walls/buildings are baked into the relief; this is the overlay)
    if (cam.ppm > 0.3) drawCop(ctx, cam, terrain);

    // record fresh combat events (blasts → scorch craters; hidden-shooter muzzles →
    // suspected pinpoints), then draw the surviving craters on the ground under units
    const confirmedEnemies: { x: number; y: number }[] = [];
    for (const [eid, rv] of sim.revealed) { if (rv.confirmed) { const ee = sim.unit(eid); if (ee) confirmedEnemies.push(ee.pos); } }
    noteCombatEffects(sim.effects, confirmedEnemies);
    drawScorchDecals(ctx, cam);

    // a Black Hawk on the LZ during the air-resupply landing window (the bird on station)
    if (terrain.cop && cam.ppm > 0.45 && hasSprite("helo-uh60")) {
      const clk = w.state.clock;
      const air = w.state.resupplies.find((r) => r.kind === "air" && clk > r.eta - 1500 && clk < r.eta + 600);
      if (air) {
        const lz = terrain.cellCenter(terrain.cop.lz.cx, terrain.cop.lz.cy);
        const head = Math.atan2(-terrain.cop.gateDir.y, -terrain.cop.gateDir.x); // nose toward the wire
        drawWorldSprite(ctx, cam, "helo-uh60", lz.x, lz.y, { widthM: 16, rot: head, alpha: lodAlpha(cam.ppm, 0.45, 0.95) });
      }
    }

    // COP marker — fortified-base pin at strategic zoom, handing off to the BUILT COP.
    // drawCop's building sprites fade IN over 0.32→0.7, so the pin must retire across the
    // SAME band: the old 1.3→2.4 fade left a full pin floating on top of finished barracks
    // for the whole default-zoom (0.7) range — two representations of the base at once.
    const cop = w.copWorld();
    const [cx, cy] = worldToScreen(cam, cop.x, cop.y);
    const copPinA = 1 - lodAlpha(cam.ppm, 0.35, 0.7);
    const drewCop = copPinA > 0.02 && hasSprite("cop-pin") && drawScreenSprite(ctx, "cop-pin", cx, cy, 34, { alpha: copPinA });
    if (!drewCop && copPinA > 0.02) {
      ctx.save();
      ctx.globalAlpha *= copPinA;
      ctx.fillStyle = "#4a86c6";
      ctx.strokeStyle = "#0c0d0a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(cx - 7, cy - 6, 14, 12);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#d8d6c4";
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy - 16);
      ctx.stroke();
      ctx.fillStyle = "#4a86c6";
      ctx.fillRect(cx, cy - 16, 8, 5);
      ctx.restore();
    }

    // active-squad highlight + LOS (you command the squad, so the whole squad lights up)
    const selSet = new Set<string>();
    if (st.activeSquadId) {
      const sq = w.platoon.squads.find((s) => s.id === st.activeSquadId);
      if (sq) for (const id of sq.memberIds) selSet.add(id);
    }
    for (const u of sim.units) {
      if (selSet.has(u.id) && u.alive) {
        drawPath(ctx, cam, u);
        const seen = u.visibleEnemyIds.map((id) => sim.unit(id)).filter((e): e is Unit => !!e && e.alive);
        drawLOSLines(ctx, cam, u, seen);
      }
    }

    // At STRATEGIC zoom the COP garrison collapses into the cop-pin (per the LOD policy),
    // so the sheet shows a clean base icon, not a pile of mil-symbols — but it CROSSFADES
    // back in over 0.42→0.62 instead of snapping on at a hard 0.5 gate (the old pop, where
    // ~5 garrison squad icons appeared at full strength in a single zoom step). Field
    // patrols outside the wire always show at full strength.
    const copR2 = (terrain.cop ? (terrain.cop.radius + 6) * terrain.cellSize : 0);
    const copR2sq = copR2 * copR2;
    const inGarrisonRegion = (u: Unit) => copR2 > 0 && (u.pos.x - cop.x) ** 2 + (u.pos.y - cop.y) ** 2 < copR2sq;
    const GARR_FADE0 = 0.42, GARR_FADE1 = 0.62;
    const garrisonRevealA = lodAlpha(cam.ppm, GARR_FADE0, GARR_FADE1); // 0 below .42 → 1 above .62
    // dead bodies / civilians inside the wire stay collapsed into the pin until the reveal
    const hideGarrison = (u: Unit) => cam.ppm < GARR_FADE1 && inGarrisonRegion(u);

    // dead bodies (under living)
    for (const u of sim.units) if (!u.alive && u.faction !== "civilian" && !hideGarrison(u)) drawUnit(ctx, cam, u, {});
    // civilians (if visible)
    for (const u of sim.units) if (u.faction === "civilian" && u.alive && sim.isVisibleToPlayer(u) && !hideGarrison(u)) drawUnit(ctx, cam, u, {});
    // enemies via fog of war — confirmed sightings are solid; a SUSPECTED ghost (last
    // known position) fades as the intel goes stale toward the 25 s cull, so the player
    // reads "this is where he WAS, a while ago" not "he is here now."
    for (const [id, r] of sim.revealed) {
      const e = sim.unit(id);
      if (!e || !e.alive) continue;
      const pos = r.confirmed ? e.pos : r.pos;
      const ghost: Unit = r.confirmed ? e : ({ ...e, pos } as Unit);
      if (r.confirmed) {
        drawUnit(ctx, cam, ghost, { selected: selSet.has(id), revealedSuspect: false });
      } else {
        const fade = Math.max(0.18, 1 - (sim.timeS - r.lastSeenS) / 25);
        ctx.save();
        ctx.globalAlpha = fade;
        drawUnit(ctx, cam, ghost, { selected: selSet.has(id), revealedSuspect: true });
        ctx.restore();
      }
    }
    // suspected-shooter pinpoints (hidden enemies revealed by their muzzle flash)
    drawFogReveals(ctx, cam);
    // friendlies on top — LOD: below tactical zoom (FIG_FADE0) a squad is ONE unit icon at
    // its centroid (you track elements, not men); at/above it the individuals resolve so the
    // real 5.5 m dispersion becomes visible. Crossfade so the icon→figures swap doesn't pop.
    const liveFriendlies = sim.units.filter(
      (u) => (u.faction === "us" || u.faction === "ana") && u.alive
    );
    const iconA = 1 - lodAlpha(cam.ppm, FIG_FADE0 - 0.4, FIG_FADE0); // 1 below band, 0 above
    if (iconA > 0.02) {
      // group by squadId (the real element: hq/sq1/sq2/sq3/wpn), centroid each, one icon.
      const groups = new Map<string, Unit[]>();
      for (const u of liveFriendlies) {
        const key = u.squadId ?? (u.faction === "ana" ? "ana" : "us");
        let g = groups.get(key);
        if (!g) { g = []; groups.set(key, g); }
        g.push(u);
      }
      for (const [key, men] of groups) {
        const c = unitsCentroid(men);
        const sqName = w.platoon.squads.find((s) => s.id === key)?.name ?? (men[0].faction === "ana" ? "ANA" : key.toUpperCase());
        const engaged = men.some((m) => m.suppression > 0.12 || m.visibleEnemyIds.length > 0);
        // a squad still inside the wire fades in with the garrison reveal (0.42→0.62);
        // a patrol outside it shows at full icon strength — no pop at the 0.5 boundary.
        const garrisoned = men.filter(inGarrisonRegion).length > men.length / 2;
        drawSquadIcon(ctx, cam, c, {
          count: men.length,
          label: sqName.replace(/\s*Squad$/i, "").replace(/\s*Sqd$/i, ""),
          faction: men[0].faction,
          selected: men.some((m) => selSet.has(m.id)),
          engaged,
          alpha: garrisoned ? iconA * garrisonRevealA : iconA,
        });
      }
    }
    if (iconA < 0.98) {
      // individuals fade IN exactly as the squad icon fades OUT (no pop at the swap zoom).
      const figFadeIn = 1 - iconA;
      ctx.save();
      if (figFadeIn < 0.999) ctx.globalAlpha *= figFadeIn;
      for (const u of liveFriendlies) {
        drawUnit(ctx, cam, u, { selected: selSet.has(u.id), showLabel: cam.ppm > 2.5 });
      }
      ctx.restore();
    }

    // squad intent banners — read each tasked squad's drill straight off the map (the
    // hands-off model lives or dies on legibility: you watch the fight, you don't click it)
    for (const t of w.state.tasks) {
      if (t.phase === "complete") continue;
      const mem = t.memberIds.map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
      if (mem.length === 0) continue;
      const lead = (t.leadId ? sim.unit(t.leadId) : null) ?? mem[0];
      const [bx, byTop] = worldToScreen(cam, lead.pos.x, lead.pos.y);
      if (bx < -80 || byTop < -40 || bx > cam.vw + 80 || byTop > cam.vh + 40) continue;
      // base-of-fire arc + maneuver arrow — literally see the fire-and-movement you authored:
      // a shaded suppression cone from the base-of-fire team, an arrow for the maneuver team.
      if (t.threatPt && (t.squadState === "assault" || t.squadState === "suppress" || t.squadState === "hold" || t.squadState === "break")) {
        const bof = (t.bofIds ?? []).map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && u.conscious);
        const mnvr = (t.mnvrIds ?? []).map((id) => sim.unit(id)).filter((u): u is Unit => !!u && u.alive && u.conscious);
        const [tx, ty] = worldToScreen(cam, t.threatPt.x, t.threatPt.y);
        if (bof.length) {
          const bc = unitsCentroid(bof);
          const [bcx, bcy] = worldToScreen(cam, bc.x, bc.y);
          const ang = Math.atan2(ty - bcy, tx - bcx);
          const r = Math.min(Math.hypot(tx - bcx, ty - bcy), 230);
          ctx.fillStyle = "rgba(224,167,43,0.09)";
          ctx.beginPath();
          ctx.moveTo(bcx, bcy);
          ctx.arc(bcx, bcy, r, ang - 0.32, ang + 0.32);
          ctx.closePath();
          ctx.fill();
        }
        const objPt = t.squadState === "break" ? t.rallyPt : t.threatPt;
        if (mnvr.length && objPt) {
          const mc = unitsCentroid(mnvr);
          const [mcx, mcy] = worldToScreen(cam, mc.x, mc.y);
          const [ox, oy] = worldToScreen(cam, objPt.x, objPt.y);
          drawManeuverArrow(ctx, mcx, mcy, ox, oy, t.squadState === "break" ? "rgba(224,80,40,0.75)" : "rgba(120,200,120,0.85)");
        }
      }
      const sqName = w.platoon.squads.find((s) => s.id === lead.squadId)?.name ?? t.label;
      const ss = t.squadState;
      let txt = sqName;
      let col = "rgba(150,168,110,0.92)";
      if (ss === "assault") { txt = `${sqName} · ASSAULT`; col = "rgba(224,80,40,0.96)"; }
      else if (ss === "break") { txt = `${sqName} · BREAKING`; col = "rgba(224,80,40,0.96)"; }
      else if (ss === "suppress") { txt = `${sqName} · SUPPRESSING`; col = "rgba(224,167,43,0.96)"; }
      else if (ss === "hold" || ss === "react") { txt = `${sqName} · CONTACT`; col = "rgba(224,167,43,0.96)"; }
      else if (cam.ppm < 0.4) continue; // out of contact: only label at closer zoom to avoid clutter
      ctx.font = "bold 9px var(--font-mono, monospace)";
      const wpx = ctx.measureText(txt).width + 8;
      const ly = byTop - 24;
      ctx.fillStyle = "rgba(12,13,10,0.72)";
      ctx.fillRect(bx - wpx / 2, ly - 9, wpx, 12);
      ctx.fillStyle = col;
      ctx.textAlign = "center";
      ctx.fillText(txt, bx, ly);
    }

    // civilian no-fire rings — the civClear ROE gate made visible. When a fight is near,
    // each visible civilian wears an amber keep-out bubble: that is the ground your soldiers
    // will NOT fire across under Tight/Hold ROE. It is the answer to "why isn't he shooting?"
    {
      const fighting = sim.playerUnits().filter((u) => u.suppression > 0.2 || u.visibleEnemyIds.length > 0);
      if (fighting.length) {
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (const c of sim.units) {
          if (c.faction !== "civilian" || !c.alive || !c.conscious || c.evac) continue;
          if (!sim.isVisibleToPlayer(c)) continue;
          let roe: string | null = null;
          let nd = 130;
          for (const f of fighting) {
            const d = Math.hypot(f.pos.x - c.pos.x, f.pos.y - c.pos.y);
            if (d < nd) { nd = d; roe = f.roe ?? "tight"; }
          }
          if (!roe || roe === "free") continue; // free ROE shrinks the bubble to danger-close — nothing to show
          const guard = roe === "hold" ? 28 : 22;
          const [cx2, cy2] = worldToScreen(cam, c.pos.x, c.pos.y);
          ctx.strokeStyle = "rgba(224,167,43,0.42)";
          ctx.beginPath();
          ctx.arc(cx2, cy2, guard * cam.ppm, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }

    drawProjectiles(ctx, cam, sim.projectiles);
    drawEffects(ctx, cam, sim.effects);
    // indirect / CAS beaten-zone reticles (ETA countdown + danger-close hazard on our men)
    drawFireMissions(ctx, cam, sim.fireMissions, sim.playerUnits());
    // threat-bearing crescent + pinned ring on friendlies actually under fire
    drawSuppressionCues(ctx, cam, sim.playerUnits());
    // arterial-bleed pools + buddy-aid links (the wounds-not-kills medical read)
    drawCasualtyCues(ctx, cam, sim.playerUnits());
    // LOD aggregation: below tactical zoom, small-arms fire collapses to a warm haze (drifts downwind)
    drawCombatHaze(ctx, cam, sim.projectiles, sim.effects, windV);
    // NIGHT LIGHT: at night, muzzle flashes / tracers / blasts emit additive light into the
    // dark so a firefight is dramatic and readable (drawn over units — light spills over them).
    drawNightLights(ctx, cam, sim.effects, sim.projectiles, night);
    // contact-onset (TIC) starburst + zoomed-out aggregate marker
    drawContactMarker(ctx, cam, sim.playerUnits());
    // off-screen contact pointer — never lose your own fight on the 2.56 km map
    drawOffscreenContactPointer(ctx, cam, sim.playerUnits());

    // CAMERA-PUNCH game-feel: detect a fresh big detonation (deduped by Effect.id) and feed
    // a proximity/size-scaled impulse into the shake + danger-close edge-flash. Restrained,
    // decaying; NOT the reverted recoil-jolt / shockwave-ring.
    {
      const imp = noteShakeEvents(sim.effects, { x: cam.cx, y: cam.cy }, cam.ppm);
      if (imp.mag > 0) {
        const nowSr = nowMs / 1000;
        const cur = shakeRef.current;
        // take the stronger of the still-live shake and the new impulse (don't stack to nausea)
        const liveMag = cur.until > nowSr ? cur.mag * ((cur.until - nowSr) / cur.durS) : 0;
        if (imp.mag >= liveMag) {
          cur.mag = imp.mag;
          cur.durS = imp.durS;
          cur.until = nowSr + imp.durS;
        }
        if (imp.edge > cur.edge || cur.edgeUntil <= nowSr) { cur.edge = imp.edge; cur.edgeUntil = nowSr + 0.4; }
      }

      // TIC-ONSET NUDGE: a gentle one-shot shake when a fight kicks off after a lull, so the
      // player FEELS contact begin (pairs with combat-fx's contact-onset starburst). Detected
      // from the same in-contact centroid; debounced by a >4 s gap (mirrors drawContactMarker).
      const onset = getContactCentroid(sim.playerUnits());
      const nowSr2 = nowMs / 1000;
      if (onset) {
        if (nowSr2 - contactRef.current > 4) {
          const cur = shakeRef.current;
          if (cur.until < nowSr2) { cur.mag = 2.2; cur.durS = 0.28; cur.until = nowSr2 + 0.28; }
        }
        contactRef.current = nowSr2;
      }
    }

    // planning route
    if (st.planning && st.planRoute.length > 0) {
      ctx.strokeStyle = "rgba(224,167,43,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const [ox, oy] = worldToScreen(cam, cop.x, cop.y);
      ctx.moveTo(ox, oy);
      let total = 0;
      let prev = { cx: w.state.copCell.cx, cy: w.state.copCell.cy };
      for (const wp of st.planRoute) {
        const wc = terrain.cellCenter(wp.cx, wp.cy);
        const [px, py] = worldToScreen(cam, wc.x, wc.y);
        ctx.lineTo(px, py);
        total += Math.hypot(wp.cx - prev.cx, wp.cy - prev.cy) * terrain.cellSize;
        prev = wp;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      st.planRoute.forEach((wp, i) => {
        const wc = terrain.cellCenter(wp.cx, wp.cy);
        const [px, py] = worldToScreen(cam, wc.x, wc.y);
        const drewWp = hasSprite("flag-waypoint") && drawScreenSprite(ctx, "flag-waypoint", px, py, 22);
        if (!drewWp) {
          ctx.fillStyle = "#e0a72b";
          ctx.beginPath();
          ctx.arc(px, py, 7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = drewWp ? "#1c160e" : "#0c0d0a";
        ctx.font = "bold 9px var(--font-mono, monospace)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), px, drewWp ? py - 2 : py + 0.5);
        ctx.textBaseline = "alphabetic";
      });
      const last = st.planRoute[st.planRoute.length - 1];
      const lc = terrain.cellCenter(last.cx, last.cy);
      const [lx, ly] = worldToScreen(cam, lc.x, lc.y);
      ctx.fillStyle = "rgba(12,13,10,0.8)";
      ctx.fillRect(lx + 8, ly - 8, 70, 14);
      ctx.fillStyle = "#e0a72b";
      ctx.textAlign = "left";
      ctx.fillText(`${(total / 1000).toFixed(2)} km`, lx + 12, ly + 2);
      ctx.textAlign = "center";
    }

    // pending AI call-for-fire: show the JTAC's proposed grid as a pulsing reticle
    if (w.state.fireRequest) {
      const fc = terrain.cellCenter(w.state.fireRequest.cx, w.state.fireRequest.cy);
      const [fx, fy] = worldToScreen(cam, fc.x, fc.y);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
      ctx.strokeStyle = `rgba(224,80,40,${0.55 + 0.4 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(fx, fy, 16 + pulse * 5, 0, Math.PI * 2);
      ctx.moveTo(fx - 24, fy); ctx.lineTo(fx - 8, fy);
      ctx.moveTo(fx + 8, fy); ctx.lineTo(fx + 24, fy);
      ctx.moveTo(fx, fy - 24); ctx.lineTo(fx, fy - 8);
      ctx.moveTo(fx, fy + 8); ctx.lineTo(fx, fy + 24);
      ctx.stroke();
      ctx.fillStyle = "rgba(12,13,10,0.8)";
      ctx.fillRect(fx + 12, fy - 22, 96, 13);
      ctx.fillStyle = "#e05028";
      ctx.font = "bold 9px var(--font-mono, monospace)";
      ctx.textAlign = "left";
      ctx.fillText("CALL FOR FIRE", fx + 16, fy - 12);
      ctx.textAlign = "center";
    }

    // fire-support reticle
    if (st.fireSupport && hoverRef.current) {
      const [hx, hy] = worldToScreen(cam, hoverRef.current.wx, hoverRef.current.wy);
      ctx.strokeStyle = "rgba(224,80,40,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 14, 0, Math.PI * 2);
      ctx.moveTo(hx - 20, hy);
      ctx.lineTo(hx + 20, hy);
      ctx.moveTo(hx, hy - 20);
      ctx.lineTo(hx, hy + 20);
      ctx.stroke();
    }


    drawHud(ctx, cam);

    // danger-close edge-flash — a brief rust inner-vignette on a near detonation, drawn LAST
    // (over the HUD) so the felt-weight read frames the whole screen. Decays over ~0.4 s.
    {
      const cur = shakeRef.current;
      const nowSr = nowMs / 1000;
      if (cur.edgeUntil > nowSr && cur.edge > 0.01) {
        const k = (cur.edgeUntil - nowSr) / 0.4;
        drawEdgeFlash(ctx, cam, cur.edge * k);
      }
    }
  }

  // Cartographic HUD: compass rose (top-right) + an accurate, zoom-aware scale bar.
  function drawHud(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (hasSprite("compass-rose")) drawScreenSprite(ctx, "compass-rose", cam.vw - 52, 54, 68, { alpha: 1 });

    // scale bar: a "nice" round distance occupying ~120 px
    const targetM = 120 / cam.ppm;
    const pow = Math.pow(10, Math.floor(Math.log10(targetM)));
    const niceM = (targetM / pow >= 5 ? 5 : targetM / pow >= 2 ? 2 : 1) * pow;
    const barPx = niceM * cam.ppm;
    const bx = cam.vw - barPx - 18;
    const by = 100;
    ctx.save();
    ctx.lineWidth = 1;
    const segs = 4;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = i % 2 === 0 ? "rgba(216,214,196,0.9)" : "rgba(28,22,14,0.85)";
      ctx.fillRect(bx + (i * barPx) / segs, by, barPx / segs, 4);
    }
    ctx.strokeStyle = "rgba(28,22,14,0.9)";
    ctx.strokeRect(bx, by, barPx, 4);
    ctx.fillStyle = "rgba(232,229,212,0.92)";
    ctx.font = "9px var(--font-mono, monospace)";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    const label = niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`;
    ctx.fillText(label, bx + barPx, by - 3);
    ctx.textAlign = "left";
    ctx.fillText("0", bx, by - 3);
    ctx.restore();
  }

  // ----------------------------------------------------------------- input
  function cursorWorld(e: React.MouseEvent): [number, number] {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(camRef.current, e.clientX - rect.left, e.clientY - rect.top);
  }
  function localXY(e: React.MouseEvent): [number, number] {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  function friendlyAt(wx: number, wy: number): Unit | null {
    const w = useGame.getState().world;
    if (!w) return null;
    let best: Unit | null = null;
    let bd = 16 / camRef.current.ppm;
    for (const u of w.sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive) {
        const dd = Math.hypot(u.pos.x - wx, u.pos.y - wy);
        if (dd < bd) {
          bd = dd;
          best = u;
        }
      }
    }
    return best;
  }
  function villageAt(wx: number, wy: number): string | null {
    const w = useGame.getState().world;
    if (!w) return null;
    for (const v of w.state.villages) {
      const c = w.terrain.cellCenter(v.cx, v.cy);
      if (Math.hypot(c.x - wx, c.y - wy) < 30 + 16 / camRef.current.ppm) return v.id;
    }
    return null;
  }

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden bg-bg select-none">
      <canvas
        ref={canvasRef}
        className="block"
        onMouseDown={(e) => {
          if (e.button === 1) return;
          const [sx, sy] = localXY(e);
          dragRef.current = { sx, sy, x: sx, y: sy, box: false, pan: e.button === 2 || e.altKey };
        }}
        onMouseMove={(e) => {
          const [wx, wy] = cursorWorld(e);
          hoverRef.current = { wx, wy };
          const d = dragRef.current;
          if (!d) return;
          const [x, y] = localXY(e);
          if (d.pan) {
            camRef.current.cx -= (x - d.x) / camRef.current.ppm;
            camRef.current.cy -= (y - d.y) / camRef.current.ppm;
          } else if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 5) {
            d.box = true;
          }
          d.x = x;
          d.y = y;
        }}
        onMouseUp={(e) => {
          const d = dragRef.current;
          dragRef.current = null;
          if (!d || d.pan) return;
          const st = useGame.getState();
          const [wx, wy] = cursorWorld(e);

          // fire-support targeting (place / approve the reticle on the ground)
          if (st.fireSupport) {
            st.fireAtWorld(wx, wy);
            return;
          }

          // drawing a waypoint route for the active squad
          if (st.planning) {
            const cell = { cx: Math.floor(wx / st.world!.terrain.cellSize), cy: Math.floor(wy / st.world!.terrain.cellSize) };
            if (st.world!.terrain.inBounds(cell.cx, cell.cy)) st.addWaypoint(cell.cx, cell.cy);
            return;
          }

          // a genuine drag (not a click) never changes the selection
          if (d.box) return;

          // A click selects the SQUAD a soldier belongs to — never an individual man.
          const f = friendlyAt(wx, wy);
          if (f) {
            if (f.squadId) st.selectSquad(f.squadId);
            return;
          }
          const vid = villageAt(wx, wy);
          if (vid) {
            st.selectVillage(vid);
            return;
          }
          st.selectVillage(null); // clicking open ground drops the village focus; the active squad stays
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const st = useGame.getState();
          if (st.planning) st.popWaypoint(); // right-click backs up a waypoint while drawing a route
        }}
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const rect = canvasRef.current!.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const [wx, wy] = screenToWorld(camRef.current, sx, sy);
          camRef.current.ppm = Math.max(0.3, Math.min(8, camRef.current.ppm * factor));
          const [nsx, nsy] = worldToScreen(camRef.current, wx, wy);
          camRef.current.cx += (nsx - sx) / camRef.current.ppm;
          camRef.current.cy += (nsy - sy) / camRef.current.ppm;
        }}
      />
      <div className="absolute bottom-1 left-2 font-mono text-[10px] text-inkdim bg-bg/70 px-2 py-0.5 border border-line pointer-events-none">
        {hoverHint()}
      </div>
    </div>
  );

  function hoverHint(): string {
    const st = useGame.getState();
    const w = st.world;
    const h = hoverRef.current;
    if (!w || !h) return "";
    const cx = Math.floor(h.wx / w.terrain.cellSize);
    const cy = Math.floor(h.wy / w.terrain.cellSize);
    if (!w.terrain.inBounds(cx, cy)) return "";
    const e = Math.round(w.terrain.elevAt(h.wx, h.wy));
    const land = LAND_NAME[w.terrain.landAt(h.wx, h.wy)] ?? "";
    return `GR ${String(cx).padStart(3, "0")}–${String(cy).padStart(3, "0")} · ${e} m · ${land}`;
  }
}
