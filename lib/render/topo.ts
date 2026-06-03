import { Terrain, Land } from "../sim/terrain";
import { clamp01 } from "../sim/rng";

export interface Camera {
  cx: number; // world center x (m)
  cy: number; // world center y (m)
  ppm: number; // pixels per meter
  vw: number; // viewport width px
  vh: number; // viewport height px
}

export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [(wx - cam.cx) * cam.ppm + cam.vw / 2, (wy - cam.cy) * cam.ppm + cam.vh / 2];
}

export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.vw / 2) / cam.ppm + cam.cx, (sy - cam.vh / 2) / cam.ppm + cam.cy];
}

/** Base landcover color (RGB) before hillshade. Muted, map-like. */
function landColor(l: Land): [number, number, number] {
  switch (l) {
    case Land.River:
      return [60, 92, 104];
    case Land.Marsh:
      return [86, 104, 86];
    case Land.DryWash:
      return [124, 116, 96];
    case Land.Cropland:
      return [120, 124, 70];
    case Land.Terrace:
      return [112, 120, 72];
    case Land.TerraceWall:
      return [120, 104, 80];
    case Land.Orchard:
      return [78, 96, 54];
    case Land.Meadow:
      return [124, 130, 82];
    case Land.Grass:
      return [128, 126, 84];
    case Land.Scrub:
      return [120, 112, 72];
    case Land.Forest:
      return [58, 78, 50];
    case Land.Scree:
      return [138, 130, 116];
    case Land.Boulders:
      return [128, 122, 112];
    case Land.Rock:
      return [150, 144, 132];
    case Land.Cliff:
      return [108, 100, 92];
    case Land.Compound:
      return [150, 120, 86];
    case Land.CompoundWall:
      return [128, 98, 66];
    case Land.Cemetery:
      return [134, 128, 112];
    case Land.Road:
      return [110, 100, 84];
    case Land.Trail:
      return [128, 116, 92];
    case Land.Footbridge:
      return [120, 96, 70];
    default:
      return [120, 116, 90];
  }
}

interface Baked {
  canvas: HTMLCanvasElement;
  pxPerCell: number;
}

const cache = new WeakMap<Terrain, Baked>();

/**
 * Bake a high-resolution shaded-relief topographic image of the whole valley
 * once, so the live views only pan/zoom a bitmap. Hillshade + landcover tint +
 * marching-squares contour lines, drawn like a real military map sheet.
 */
export function bakeTerrain(terrain: Terrain): Baked {
  const cached = cache.get(terrain);
  if (cached) return cached;

  // Target a fixed ~2200 px sheet regardless of cell count so the high-fidelity
  // 5 m grid bakes quickly and stays sharp when zoomed.
  const pxPerCell = Math.max(2, Math.min(8, Math.round(2200 / terrain.size)));
  const W = terrain.size * pxPerCell;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, W);
  const data = img.data;

  // light from the NW, classic shaded relief
  const lx = -0.6;
  const ly = -0.6;
  const lz = 0.52;
  const ll = Math.hypot(lx, ly, lz);
  const lnx = lx / ll;
  const lny = ly / ll;
  const lnz = lz / ll;

  const range = terrain.maxElev - terrain.minElev || 1;
  const cs = terrain.cellSize;

  for (let py = 0; py < W; py++) {
    const wy = (py / pxPerCell) * cs;
    for (let px = 0; px < W; px++) {
      const wx = (px / pxPerCell) * cs;
      const e = terrain.elevAt(wx, wy);
      // gradient for hillshade
      const eX = terrain.elevAt(wx + cs, wy);
      const eY = terrain.elevAt(wx, wy + cs);
      const dzx = (eX - e) / cs;
      const dzy = (eY - e) / cs;
      // surface normal
      const nl = Math.hypot(dzx, dzy, 1);
      const nx = -dzx / nl;
      const ny = -dzy / nl;
      const nz = 1 / nl;
      let shade = nx * lnx + ny * lny + nz * lnz;
      shade = clamp01(shade * 1.05 + 0.12);

      // altitude tint: higher = lighter/cooler
      const alt = clamp01((e - terrain.minElev) / range);
      const [r, g, b] = landColor(terrain.landAt(wx, wy));
      const sh = 0.42 + 0.78 * shade;
      const cool = 1 + alt * 0.12;
      const o = (py * W + px) * 4;
      data[o] = Math.min(255, r * sh * (1 + alt * 0.18));
      data[o + 1] = Math.min(255, g * sh * cool);
      data[o + 2] = Math.min(255, b * sh * (1 + alt * 0.22));
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  drawContours(ctx, terrain, pxPerCell);

  const baked: Baked = { canvas, pxPerCell };
  cache.set(terrain, baked);
  return baked;
}

/** Marching-squares contour lines with index contours every 5th line. */
function drawContours(ctx: CanvasRenderingContext2D, terrain: Terrain, pxPerCell: number) {
  const interval = 40; // meters between contours
  const start = Math.ceil(terrain.minElev / interval) * interval;
  const cs = terrain.cellSize;
  ctx.lineCap = "round";
  for (let level = start; level < terrain.maxElev; level += interval) {
    const isIndex = Math.round(level / interval) % 5 === 0;
    ctx.strokeStyle = isIndex ? "rgba(60,40,24,0.55)" : "rgba(60,44,28,0.3)";
    ctx.lineWidth = isIndex ? 2 : 1;
    ctx.beginPath();
    for (let cy = 0; cy < terrain.size - 1; cy++) {
      for (let cx = 0; cx < terrain.size - 1; cx++) {
        const e00 = terrain.elev[terrain.idx(cx, cy)];
        const e10 = terrain.elev[terrain.idx(cx + 1, cy)];
        const e01 = terrain.elev[terrain.idx(cx, cy + 1)];
        const e11 = terrain.elev[terrain.idx(cx + 1, cy + 1)];
        const minV = Math.min(e00, e10, e01, e11);
        const maxV = Math.max(e00, e10, e01, e11);
        if (level < minV || level > maxV) continue;
        // sample crossing on the 4 edges
        const pts: [number, number][] = [];
        const ex = (a: number, b: number) => (level - a) / (b - a);
        if ((e00 <= level) !== (e10 <= level)) pts.push([cx + ex(e00, e10), cy]);
        if ((e10 <= level) !== (e11 <= level)) pts.push([cx + 1, cy + ex(e10, e11)]);
        if ((e01 <= level) !== (e11 <= level)) pts.push([cx + ex(e01, e11), cy + 1]);
        if ((e00 <= level) !== (e01 <= level)) pts.push([cx, cy + ex(e00, e01)]);
        if (pts.length >= 2) {
          const sc = pxPerCell;
          ctx.moveTo(pts[0][0] * sc, pts[0][1] * sc);
          ctx.lineTo(pts[1][0] * sc, pts[1][1] * sc);
          if (pts.length === 4) {
            ctx.moveTo(pts[2][0] * sc, pts[2][1] * sc);
            ctx.lineTo(pts[3][0] * sc, pts[3][1] * sc);
          }
        }
      }
    }
    ctx.stroke();
  }
  void cs;
}

/** Draw the baked terrain into a live canvas under the given camera. */
export function drawTerrain(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera, night = 0) {
  const baked = bakeTerrain(terrain);
  const destScale = (cam.ppm * terrain.cellSize) / baked.pxPerCell;
  const [ox, oy] = worldToScreen(cam, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(baked.canvas, ox, oy, baked.canvas.width * destScale, baked.canvas.height * destScale);

  // night / low-light wash
  if (night > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(8,14,30,${0.35 + night * 0.42})`;
    ctx.fillRect(0, 0, cam.vw, cam.vh);
    ctx.restore();
  }
}

/** A faint UTM-style grid with labels, drawn over terrain. */
export function drawGrid(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera, spacingM = 200) {
  ctx.save();
  ctx.strokeStyle = "rgba(216,214,196,0.12)";
  ctx.fillStyle = "rgba(216,214,196,0.4)";
  ctx.lineWidth = 1;
  ctx.font = "10px var(--font-mono, monospace)";
  const maxW = terrain.worldSize;
  for (let x = 0; x <= maxW; x += spacingM) {
    const [sx] = worldToScreen(cam, x, 0);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, cam.vh);
    ctx.stroke();
    ctx.fillText(String(Math.round(x / 100)).padStart(2, "0"), sx + 2, 11);
  }
  for (let y = 0; y <= maxW; y += spacingM) {
    const [, sy] = worldToScreen(cam, 0, y);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(cam.vw, sy);
    ctx.stroke();
    ctx.fillText(String(Math.round(y / 100)).padStart(2, "0"), 2, sy + 11);
  }
  ctx.restore();
}
