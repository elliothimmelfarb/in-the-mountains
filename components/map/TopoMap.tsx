"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Terrain, Land } from "@/lib/sim/terrain";
import { CampaignState, ambientLight } from "@/lib/sim/campaign";
import { PlanDraft } from "@/state/store";
import { Camera, drawTerrain, drawGrid, worldToScreen, screenToWorld } from "@/lib/render/topo";

interface Props {
  terrain: Terrain;
  campaign: CampaignState;
  plan: PlanDraft;
  planning: boolean;
  selectedVillage: string | null;
  onCellClick: (cx: number, cy: number) => void;
  onVillageClick: (id: string) => void;
}

const LAND_NAME: Record<number, string> = {
  [Land.River]: "River",
  [Land.FloorField]: "Terraced field",
  [Land.Orchard]: "Orchard",
  [Land.Grass]: "Open ground",
  [Land.Scrub]: "Holly scrub",
  [Land.Forest]: "Forest",
  [Land.Scree]: "Scree",
  [Land.Rock]: "Rock / cliff",
  [Land.Village]: "Village (qalats)",
  [Land.Road]: "Road",
  [Land.Trail]: "Trail",
};

export default function TopoMap({
  terrain,
  campaign,
  plan,
  planning,
  selectedVillage,
  onCellClick,
  onVillageClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ cx: terrain.worldSize / 2, cy: terrain.worldSize / 2, ppm: 0.3, vw: 800, vh: 600 });
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ cx: number; cy: number; e: number; land: string } | null>(null);
  const fitDone = useRef(false);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    camRef.current.vw = w;
    camRef.current.vh = h;
    if (!fitDone.current) {
      camRef.current.ppm = Math.min(w, h) / (terrain.worldSize * 1.05);
      camRef.current.cx = terrain.worldSize / 2;
      camRef.current.cy = terrain.worldSize / 2;
      fitDone.current = true;
    }
  }, [terrain]);

  // draw loop
  useEffect(() => {
    let raf = 0;
    const render = () => {
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
        draw(ctx, camRef.current);
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain, campaign, plan, selectedVillage, planning]);

  useEffect(() => {
    fit();
    const ro = new ResizeObserver(() => fit());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [fit]);

  function draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    const night = 1 - ambientLight(campaign);
    ctx.clearRect(0, 0, cam.vw, cam.vh);
    drawTerrain(ctx, terrain, cam, night * 0.6);
    if (cam.ppm > 0.18) drawGrid(ctx, terrain, cam, 200);

    // --- named features ---
    ctx.textAlign = "center";
    for (const f of terrain.features) {
      const c = terrain.cellCenter(f.cx, f.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      ctx.fillStyle = "rgba(216,214,196,0.55)";
      ctx.font = "9px var(--font-mono, monospace)";
      ctx.fillText("▲ " + f.name, x, y - 4);
    }

    // --- intel markers ---
    for (const r of campaign.intel.slice(0, 30)) {
      if (r.cx === undefined || r.cy === undefined) continue;
      const c = terrain.cellCenter(r.cx, r.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      const col = r.source === "SIGINT" ? "224,167,43" : r.source === "HUMINT" ? "111,174,84" : "200,120,60";
      ctx.fillStyle = `rgba(${col},${0.25 + r.reliability * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, 4 + r.reliability * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.7)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- villages ---
    for (const v of campaign.villages) {
      const c = terrain.cellCenter(v.cx, v.cy);
      const [x, y] = worldToScreen(cam, c.x, c.y);
      const att = v.attitude;
      const col = att > 20 ? "#6fae54" : att < -20 ? "#c0392b" : "#e0a72b";
      ctx.fillStyle = col;
      ctx.strokeStyle = selectedVillage === v.id ? "#f0e4c0" : "#0c0d0a";
      ctx.lineWidth = selectedVillage === v.id ? 2 : 1;
      // house cluster glyph
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
      ctx.fillStyle = "rgba(216,214,196,0.95)";
      ctx.font = "10px var(--font-mono, monospace)";
      ctx.fillText(v.name, x, y + 18);
      if (v.lastVisitedDay >= 0) {
        ctx.fillStyle = "#6fae54";
        ctx.fillText("✓", x + 12, y - 6);
      }
      if (v.projects.length) {
        ctx.fillStyle = "#5b9bd8";
        ctx.fillText("⚒", x - 12, y - 6);
      }
    }

    // --- COP ---
    const cop = terrain.cellCenter(campaign.copCell.cx, campaign.copCell.cy);
    const [cx, cy] = worldToScreen(cam, cop.x, cop.y);
    ctx.fillStyle = "#4a86c6";
    ctx.strokeStyle = "#0c0d0a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cx - 7, cy - 6, 14, 12);
    ctx.fill();
    ctx.stroke();
    // flag
    ctx.strokeStyle = "#d8d6c4";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy - 16);
    ctx.stroke();
    ctx.fillStyle = "#4a86c6";
    ctx.fillRect(cx, cy - 16, 8, 5);
    ctx.fillStyle = "rgba(216,214,196,0.95)";
    ctx.font = "bold 10px var(--font-mono, monospace)";
    ctx.fillText(campaign.fob.name, cx, cy + 20);

    // --- planning route ---
    if (plan.route.length > 0) {
      ctx.strokeStyle = "rgba(224,167,43,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const [sx, sy] = worldToScreen(cam, cop.x, cop.y);
      ctx.moveTo(sx, sy);
      let total = 0;
      let prev = campaign.copCell;
      for (const wp of plan.route) {
        const wc = terrain.cellCenter(wp.cx, wp.cy);
        const [px, py] = worldToScreen(cam, wc.x, wc.y);
        ctx.lineTo(px, py);
        total += Math.hypot(wp.cx - prev.cx, wp.cy - prev.cy) * terrain.cellSize;
        prev = wp;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      plan.route.forEach((wp, i) => {
        const wc = terrain.cellCenter(wp.cx, wp.cy);
        const [px, py] = worldToScreen(cam, wc.x, wc.y);
        ctx.fillStyle = "#e0a72b";
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0c0d0a";
        ctx.font = "bold 9px var(--font-mono, monospace)";
        ctx.fillText(String(i + 1), px, py + 0.5);
      });
      // distance label near last waypoint
      const last = plan.route[plan.route.length - 1];
      const lc = terrain.cellCenter(last.cx, last.cy);
      const [lx, ly] = worldToScreen(cam, lc.x, lc.y);
      ctx.fillStyle = "rgba(12,13,10,0.8)";
      ctx.fillRect(lx + 8, ly - 8, 70, 14);
      ctx.fillStyle = "#e0a72b";
      ctx.textAlign = "left";
      ctx.fillText(`${(total / 1000).toFixed(2)} km`, lx + 12, ly + 2);
      ctx.textAlign = "center";
    }

    // hover crosshair
    if (hover) {
      const c = terrain.cellCenter(hover.cx, hover.cy);
      const [hx, hy] = worldToScreen(cam, c.x, c.y);
      ctx.strokeStyle = "rgba(224,167,43,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx - 8, hy);
      ctx.lineTo(hx + 8, hy);
      ctx.moveTo(hx, hy - 8);
      ctx.lineTo(hx, hy + 8);
      ctx.stroke();
    }
  }

  // ---- input ----
  function eventToCell(e: React.MouseEvent): { cx: number; cy: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(camRef.current, sx, sy);
    return { cx: Math.floor(wx / terrain.cellSize), cy: Math.floor(wy / terrain.cellSize) };
  }

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden bg-bg select-none">
      <canvas
        ref={canvasRef}
        className="block"
        style={{ cursor: planning ? "crosshair" : dragRef.current ? "grabbing" : "grab" }}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          const cell = eventToCell(e);
          if (terrain.inBounds(cell.cx, cell.cy)) {
            const c = terrain.cellCenter(cell.cx, cell.cy);
            setHover({ cx: cell.cx, cy: cell.cy, e: terrain.elevAt(c.x, c.y), land: LAND_NAME[terrain.landAt(c.x, c.y)] ?? "" });
          }
          if (dragRef.current) {
            const dx = e.clientX - dragRef.current.x;
            const dy = e.clientY - dragRef.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
            camRef.current.cx -= dx / camRef.current.ppm;
            camRef.current.cy -= dy / camRef.current.ppm;
            dragRef.current.x = e.clientX;
            dragRef.current.y = e.clientY;
          }
        }}
        onMouseUp={(e) => {
          const wasDrag = dragRef.current?.moved;
          dragRef.current = null;
          if (wasDrag) return;
          const cell = eventToCell(e);
          if (!terrain.inBounds(cell.cx, cell.cy)) return;
          // village click?
          const vil = campaign.villages.find((v) => Math.hypot(v.cx - cell.cx, v.cy - cell.cy) < 3);
          if (vil && !planning) {
            onVillageClick(vil.id);
            return;
          }
          onCellClick(cell.cx, cell.cy);
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          setHover(null);
        }}
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const rect = canvasRef.current!.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const [wx, wy] = screenToWorld(camRef.current, sx, sy);
          camRef.current.ppm = Math.max(0.12, Math.min(6, camRef.current.ppm * factor));
          // keep cursor anchored
          const [nsx, nsy] = worldToScreen(camRef.current, wx, wy);
          camRef.current.cx += (nsx - sx) / camRef.current.ppm;
          camRef.current.cy += (nsy - sy) / camRef.current.ppm;
        }}
      />
      {hover && (
        <div className="absolute bottom-2 left-2 font-mono text-[10px] text-inkdim bg-bg/80 px-2 py-1 border border-line pointer-events-none">
          GRID {String(hover.cx).padStart(3, "0")}–{String(hover.cy).padStart(3, "0")} · {Math.round(hover.e)} m · {hover.land}
        </div>
      )}
    </div>
  );
}
