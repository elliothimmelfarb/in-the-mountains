"use client";
import { useEffect, useRef } from "react";
import { useGame } from "@/state/store";
import { Camera, drawTerrain, drawGrid, worldToScreen, screenToWorld } from "@/lib/render/topo";
import { drawUnit, drawProjectiles, drawEffects, drawSmoke, drawLOSLines, drawPath } from "@/lib/render/draw";
import { Unit } from "@/lib/sim/entities";

const SIM_DT = 0.1;

export default function TacticalView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ cx: 0, cy: 0, ppm: 1.2, vw: 800, vh: 600 });
  const accRef = useRef(0);
  const lastRef = useRef(0);
  const syncRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number; box: boolean; pan: boolean } | null>(null);
  const initCam = useRef(false);

  useEffect(() => {
    const sim = useGame.getState().sim;
    const terrain = useGame.getState().terrain;
    if (!sim || !terrain) return;

    // center camera on the friendly centroid
    if (!initCam.current) {
      const us = sim.units.filter((u) => u.faction === "us" && u.alive);
      let cx = terrain.worldSize / 2;
      let cy = terrain.worldSize / 2;
      if (us.length) {
        cx = us.reduce((a, u) => a + u.pos.x, 0) / us.length;
        cy = us.reduce((a, u) => a + u.pos.y, 0) / us.length;
      }
      camRef.current.cx = cx;
      camRef.current.cy = cy;
      camRef.current.ppm = 1.3;
      initCam.current = true;
    }

    let raf = 0;
    lastRef.current = performance.now();
    const loop = (now: number) => {
      const st = useGame.getState();
      const sim = st.sim;
      const terrain = st.terrain;
      if (!sim || !terrain) {
        raf = requestAnimationFrame(loop);
        return;
      }
      let realDt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      realDt = Math.min(0.1, realDt);

      // step the sim
      if (!st.paused && sim.outcome === "ongoing") {
        accRef.current += realDt * st.speed;
        let steps = 0;
        while (accRef.current >= SIM_DT && steps < 12) {
          sim.tick(SIM_DT);
          accRef.current -= SIM_DT;
          steps++;
        }
      }

      // refresh HUD ~7Hz and detect end
      syncRef.current += realDt;
      if (syncRef.current > 0.14) {
        syncRef.current = 0;
        st.syncTactical();
      }

      // draw
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (canvas && wrap) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          canvas.style.width = w + "px";
          canvas.style.height = h + "px";
        }
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        camRef.current.vw = w;
        camRef.current.vh = h;
        drawScene(ctx, camRef.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function drawScene(ctx: CanvasRenderingContext2D, cam: Camera) {
    const st = useGame.getState();
    const sim = st.sim;
    const terrain = st.terrain;
    if (!sim || !terrain) return;
    const night = 1 - sim.light;
    ctx.clearRect(0, 0, cam.vw, cam.vh);
    drawTerrain(ctx, terrain, cam, night * 0.7);
    if (cam.ppm > 0.4) drawGrid(ctx, terrain, cam, 100);

    drawSmoke(ctx, cam, sim.smoke);

    // selected unit LOS + paths
    const selSet = new Set(st.selection);
    const liveEnemies = sim.units.filter((u) => u.faction === "insurgent" && u.alive);
    for (const u of sim.units) {
      if (selSet.has(u.id) && u.alive) {
        drawPath(ctx, cam, u);
        const seen = u.visibleEnemyIds.map((id) => sim.unit(id)).filter((e): e is Unit => !!e && e.alive);
        drawLOSLines(ctx, cam, u, seen);
      }
    }

    // dead bodies first (under living)
    for (const u of sim.units) if (!u.alive && u.faction !== "civilian") drawUnit(ctx, cam, u, {});

    // civilians (if visible)
    for (const u of sim.units) {
      if (u.faction === "civilian" && u.alive && sim.isVisibleToPlayer(u)) drawUnit(ctx, cam, u, {});
    }

    // enemies via fog of war
    for (const [id, r] of sim.revealed) {
      const e = sim.unit(id);
      if (!e || !e.alive) continue;
      const pos = r.confirmed ? e.pos : r.pos;
      const ghost: Unit = r.confirmed ? e : ({ ...e, pos } as Unit);
      drawUnit(ctx, cam, ghost, { selected: selSet.has(id), revealedSuspect: !r.confirmed });
    }
    void liveEnemies;

    // friendlies on top
    for (const u of sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive) {
        drawUnit(ctx, cam, u, { selected: selSet.has(u.id), showLabel: cam.ppm > 1.2 });
      }
    }

    drawProjectiles(ctx, cam, sim.projectiles);
    drawEffects(ctx, cam, sim.effects);

    // fire-support reticle follows cursor (drawn in CSS layer instead)

    // selection box
    const d = dragRef.current;
    if (d && d.box) {
      ctx.strokeStyle = "rgba(224,167,43,0.8)";
      ctx.fillStyle = "rgba(224,167,43,0.12)";
      ctx.lineWidth = 1;
      const x = Math.min(d.sx, d.x);
      const y = Math.min(d.sy, d.y);
      const w = Math.abs(d.x - d.sx);
      const h = Math.abs(d.y - d.sy);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }

  // ---- input ----
  function cursorWorld(e: React.MouseEvent): [number, number] {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(camRef.current, e.clientX - rect.left, e.clientY - rect.top);
  }
  function localXY(e: React.MouseEvent): [number, number] {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function friendlyAt(wx: number, wy: number): Unit | null {
    const sim = useGame.getState().sim;
    if (!sim) return null;
    let best: Unit | null = null;
    let bd = 14 / camRef.current.ppm;
    for (const u of sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive) {
        const d = Math.hypot(u.pos.x - wx, u.pos.y - wy);
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
    }
    return best;
  }
  function enemyAt(wx: number, wy: number): string | null {
    const sim = useGame.getState().sim;
    if (!sim) return null;
    let best: string | null = null;
    let bd = 14 / camRef.current.ppm;
    for (const [id, r] of sim.revealed) {
      const e = sim.unit(id);
      const pos = e && r.confirmed ? e.pos : r.pos;
      const d = Math.hypot(pos.x - wx, pos.y - wy);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
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

          // fire support targeting takes precedence
          if (st.fireSupport) {
            st.fireAtWorld(wx, wy);
            return;
          }

          if (d.box) {
            // box select friendlies
            const sim = st.sim;
            if (!sim) return;
            const [x0, y0] = screenToWorld(camRef.current, Math.min(d.sx, d.x), Math.min(d.sy, d.y));
            const [x1, y1] = screenToWorld(camRef.current, Math.max(d.sx, d.x), Math.max(d.sy, d.y));
            const ids = sim.units
              .filter(
                (u) =>
                  (u.faction === "us" || u.faction === "ana") &&
                  u.alive &&
                  u.pos.x >= x0 && u.pos.x <= x1 && u.pos.y >= y0 && u.pos.y <= y1
              )
              .map((u) => u.id);
            st.selectUnits(ids, e.shiftKey);
            return;
          }

          // click
          if (st.orderTool === "select") {
            const f = friendlyAt(wx, wy);
            if (f) st.selectUnits([f.id], e.shiftKey);
            else if (!e.shiftKey) st.selectUnits([]);
          } else {
            // apply current order tool; engage if clicking an enemy with assault
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
          const sim = st.sim;
          if (!sim || st.selection.length === 0) return;
          const [wx, wy] = cursorWorld(e);
          const enemyId = enemyAt(wx, wy);
          if (enemyId) {
            sim.issueOrder(st.selection, { type: "engage", targetId: enemyId });
          } else {
            sim.issueOrder(st.selection, { type: "move", point: { x: wx, y: wy }, technique: "patrol" });
          }
        }}
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const rect = canvasRef.current!.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const [wx, wy] = screenToWorld(camRef.current, sx, sy);
          camRef.current.ppm = Math.max(0.25, Math.min(8, camRef.current.ppm * factor));
          const [nsx, nsy] = worldToScreen(camRef.current, wx, wy);
          camRef.current.cx += (nsx - sx) / camRef.current.ppm;
          camRef.current.cy += (nsy - sy) / camRef.current.ppm;
        }}
      />
    </div>
  );
}
