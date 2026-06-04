"use client";
import { useEffect, useRef } from "react";
import { useGame } from "@/state/store";
import { Land } from "@/lib/sim/terrain";
import { Camera, drawTerrain, drawGrid, worldToScreen, screenToWorld } from "@/lib/render/topo";
import { drawUnit, drawProjectiles, drawEffects, drawSmoke, drawLOSLines, drawPath, drawCop } from "@/lib/render/draw";
import { drawDecoration } from "@/lib/render/decoration";
import { loadSprites, drawScreenSprite, drawWorldSprite, hasSprite, lodAlpha } from "@/lib/render/sprites";
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
  [Land.Trail]: "Trail",
  [Land.Footbridge]: "Footbridge",
  [Land.Hesco]: "HESCO wall",
  [Land.Structure]: "Structure",
  [Land.Gravel]: "Gravel pad",
};

export default function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ cx: 0, cy: 0, ppm: 0.4, vw: 800, vh: 600 });
  const lastRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number; box: boolean; pan: boolean } | null>(null);
  const hoverRef = useRef<{ wx: number; wy: number } | null>(null);
  const initCam = useRef(false);

  // Rasterize the authored SVG asset library once on mount (bake-once / blit-many).
  useEffect(() => {
    if (ASSETS.length) loadSprites(ASSETS);
    // dev: programmatic camera control for screenshot verification
    (window as unknown as { __setCam?: (x: number, y: number, ppm?: number) => void }).__setCam = (x, y, ppm) => {
      camRef.current.cx = x;
      camRef.current.cy = y;
      if (ppm) camRef.current.ppm = ppm;
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
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        camRef.current.vw = cw;
        camRef.current.vh = ch;
        draw(ctx, camRef.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function draw(ctx: CanvasRenderingContext2D, cam: Camera) {
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

    drawSmoke(ctx, cam, sim.smoke);

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

    // COP marker — fortified-base pin, fading out at high zoom where the built COP shows
    const cop = w.copWorld();
    const [cx, cy] = worldToScreen(cam, cop.x, cop.y);
    const copPinA = 1 - lodAlpha(cam.ppm, 1.3, 2.4);
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

    // selection LOS + paths
    const selSet = new Set(st.selection);
    for (const u of sim.units) {
      if (selSet.has(u.id) && u.alive) {
        drawPath(ctx, cam, u);
        const seen = u.visibleEnemyIds.map((id) => sim.unit(id)).filter((e): e is Unit => !!e && e.alive);
        drawLOSLines(ctx, cam, u, seen);
      }
    }

    // At STRATEGIC zoom the COP garrison collapses into the cop-pin (per the LOD policy),
    // so the sheet shows a clean base icon, not a pile of mil-symbols. Field patrols stay.
    const copR2 = (terrain.cop ? (terrain.cop.radius + 6) * terrain.cellSize : 0);
    const copR2sq = copR2 * copR2;
    const inGarrison = (u: Unit) => cam.ppm < 0.5 && copR2 > 0 && (u.pos.x - cop.x) ** 2 + (u.pos.y - cop.y) ** 2 < copR2sq;

    // dead bodies (under living)
    for (const u of sim.units) if (!u.alive && u.faction !== "civilian" && !inGarrison(u)) drawUnit(ctx, cam, u, {});
    // civilians (if visible)
    for (const u of sim.units) if (u.faction === "civilian" && u.alive && sim.isVisibleToPlayer(u) && !inGarrison(u)) drawUnit(ctx, cam, u, {});
    // enemies via fog of war
    for (const [id, r] of sim.revealed) {
      const e = sim.unit(id);
      if (!e || !e.alive) continue;
      const pos = r.confirmed ? e.pos : r.pos;
      const ghost: Unit = r.confirmed ? e : ({ ...e, pos } as Unit);
      drawUnit(ctx, cam, ghost, { selected: selSet.has(id), revealedSuspect: !r.confirmed });
    }
    // friendlies on top
    for (const u of sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive && !inGarrison(u)) {
        drawUnit(ctx, cam, u, { selected: selSet.has(u.id), showLabel: cam.ppm > 2.5 });
      }
    }

    drawProjectiles(ctx, cam, sim.projectiles);
    drawEffects(ctx, cam, sim.effects);

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

    // selection box
    const d = dragRef.current;
    if (d && d.box) {
      ctx.strokeStyle = "rgba(224,167,43,0.8)";
      ctx.fillStyle = "rgba(224,167,43,0.12)";
      ctx.lineWidth = 1;
      const x = Math.min(d.sx, d.x);
      const y = Math.min(d.sy, d.y);
      ctx.fillRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
      ctx.strokeRect(x, y, Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
    }

    drawHud(ctx, cam);
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
  function enemyAt(wx: number, wy: number): string | null {
    const w = useGame.getState().world;
    if (!w) return null;
    let best: string | null = null;
    let bd = 16 / camRef.current.ppm;
    for (const [id, r] of w.sim.revealed) {
      const e = w.sim.unit(id);
      const pos = e && r.confirmed ? e.pos : r.pos;
      const dd = Math.hypot(pos.x - wx, pos.y - wy);
      if (dd < bd) {
        bd = dd;
        best = id;
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

          if (st.fireSupport) {
            st.fireAtWorld(wx, wy);
            return;
          }

          // planning route: clicks drop waypoints
          if (st.planning) {
            const cell = { cx: Math.floor(wx / st.world!.terrain.cellSize), cy: Math.floor(wy / st.world!.terrain.cellSize) };
            if (st.world!.terrain.inBounds(cell.cx, cell.cy)) st.addWaypoint(cell.cx, cell.cy);
            return;
          }

          if (d.box) {
            const w = st.world;
            if (!w) return;
            const [x0, y0] = screenToWorld(camRef.current, Math.min(d.sx, d.x), Math.min(d.sy, d.y));
            const [x1, y1] = screenToWorld(camRef.current, Math.max(d.sx, d.x), Math.max(d.sy, d.y));
            const ids = w.sim.units
              .filter(
                (u) =>
                  (u.faction === "us" || u.faction === "ana") && u.alive &&
                  u.pos.x >= x0 && u.pos.x <= x1 && u.pos.y >= y0 && u.pos.y <= y1
              )
              .map((u) => u.id);
            st.selectUnits(ids, e.shiftKey);
            return;
          }

          if (st.orderTool === "select") {
            const f = friendlyAt(wx, wy);
            if (f) {
              st.selectUnits([f.id], e.shiftKey);
              return;
            }
            const vid = villageAt(wx, wy);
            if (vid) {
              st.selectVillage(vid);
              return;
            }
            if (!e.shiftKey) st.selectUnits([]);
          } else {
            const enemyId = enemyAt(wx, wy);
            if (enemyId && (st.orderTool === "assault" || st.orderTool === "suppress")) {
              st.orderTarget(enemyId);
            } else {
              st.orderAtWorld(wx, wy);
            }
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const st = useGame.getState();
          if (!st.world || st.selection.length === 0) return;
          const [wx, wy] = cursorWorld(e);
          const enemyId = enemyAt(wx, wy);
          if (enemyId) st.orderTarget(enemyId);
          else st.orderAtWorld(wx, wy);
        }}
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const rect = canvasRef.current!.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const [wx, wy] = screenToWorld(camRef.current, sx, sy);
          camRef.current.ppm = Math.max(0.18, Math.min(8, camRef.current.ppm * factor));
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
