"use client";
import { useEffect, useRef } from "react";
import { useGame } from "@/state/store";
import { Land } from "@/lib/sim/terrain";
import { Camera, drawTerrain, drawGrid, worldToScreen, screenToWorld } from "@/lib/render/topo";
import { drawUnit, drawProjectiles, drawEffects, drawSmoke, drawLOSLines, drawPath } from "@/lib/render/draw";
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
};

export default function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ cx: 0, cy: 0, ppm: 0.4, vw: 800, vh: 600 });
  const lastRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number; box: boolean; pan: boolean } | null>(null);
  const hoverRef = useRef<{ wx: number; wy: number } | null>(null);
  const initCam = useRef(false);

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
    if (cam.ppm > 0.22) drawGrid(ctx, terrain, cam, cam.ppm > 0.9 ? 100 : 200);

    drawSmoke(ctx, cam, sim.smoke);

    // named features
    ctx.textAlign = "center";
    for (const f of terrain.features) {
      const c = terrain.cellCenter(f.cx, f.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      if (x < -40 || y < -40 || x > cam.vw + 40 || y > cam.vh + 40) continue;
      ctx.fillStyle = "rgba(216,214,196,0.5)";
      ctx.font = "9px var(--font-mono, monospace)";
      ctx.fillText("▲ " + f.name, x, y - 4);
    }

    // intel markers
    for (const r of w.state.intel.slice(0, 24)) {
      if (r.cx === undefined || r.cy === undefined) continue;
      const c = terrain.cellCenter(r.cx, r.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      const col = r.source === "SIGINT" ? "224,167,43" : r.source === "HUMINT" ? "111,174,84" : "200,120,60";
      ctx.fillStyle = `rgba(${col},${0.18 + r.reliability * 0.4})`;
      ctx.beginPath();
      ctx.arc(x, y, 3 + r.reliability * 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // villages
    for (const v of w.state.villages) {
      const c = terrain.cellCenter(v.cx, v.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      if (x < -60 || y < -60 || x > cam.vw + 60 || y > cam.vh + 60) continue;
      const col = v.attitude > 20 ? "#6fae54" : v.attitude < -20 ? "#c0392b" : "#e0a72b";
      ctx.fillStyle = col;
      ctx.strokeStyle = st.selectedVillage === v.id ? "#f0e4c0" : "#0c0d0a";
      ctx.lineWidth = st.selectedVillage === v.id ? 2 : 1;
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
      ctx.fillStyle = "rgba(216,214,196,0.92)";
      ctx.font = "10px var(--font-mono, monospace)";
      ctx.fillText(v.name, x, y + 18);
      if (v.lastVisitedDay >= 0) {
        ctx.fillStyle = "#6fae54";
        ctx.fillText("✓", x + 13, y - 6);
      }
      if (v.projects.length) {
        ctx.fillStyle = "#5b9bd8";
        ctx.fillText("⚒", x - 13, y - 6);
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

    // COP
    const cop = w.copWorld();
    const [cx, cy] = worldToScreen(cam, cop.x, cop.y);
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

    // selection LOS + paths
    const selSet = new Set(st.selection);
    for (const u of sim.units) {
      if (selSet.has(u.id) && u.alive) {
        drawPath(ctx, cam, u);
        const seen = u.visibleEnemyIds.map((id) => sim.unit(id)).filter((e): e is Unit => !!e && e.alive);
        drawLOSLines(ctx, cam, u, seen);
      }
    }

    // dead bodies (under living)
    for (const u of sim.units) if (!u.alive && u.faction !== "civilian") drawUnit(ctx, cam, u, {});
    // civilians (if visible)
    for (const u of sim.units) if (u.faction === "civilian" && u.alive && sim.isVisibleToPlayer(u)) drawUnit(ctx, cam, u, {});
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
      if ((u.faction === "us" || u.faction === "ana") && u.alive) {
        drawUnit(ctx, cam, u, { selected: selSet.has(u.id), showLabel: cam.ppm > 1.2 });
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
        ctx.fillStyle = "#e0a72b";
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0c0d0a";
        ctx.font = "bold 9px var(--font-mono, monospace)";
        ctx.textAlign = "center";
        ctx.fillText(String(i + 1), px, py + 0.5);
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
