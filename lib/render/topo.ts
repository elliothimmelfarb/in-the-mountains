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

/** Base landcover color (RGB) before hillshade/texture. A richer, field-guide palette:
 *  cool irrigated greens on the floor, dusty holly-scrub and ochre rock up the slopes,
 *  deep cedar forest in the draws, tan HESCO and mud-brown qalats. */
function landColor(l: Land): [number, number, number] {
  switch (l) {
    case Land.River:
      return [64, 104, 122];
    case Land.Marsh:
      return [92, 116, 84];
    case Land.DryWash:
      return [146, 134, 104];
    case Land.Cropland:
      return [138, 152, 78]; // bright irrigated green-gold
    case Land.Terrace:
      return [124, 142, 76];
    case Land.TerraceWall:
      return [132, 110, 80];
    case Land.Orchard:
      return [82, 110, 56]; // orchard canopy
    case Land.Meadow:
      return [142, 150, 92];
    case Land.Grass:
      return [144, 140, 90];
    case Land.Scrub:
      return [132, 122, 78]; // dusty holly-oak scrub
    case Land.Forest:
      return [50, 76, 48]; // deep cedar
    case Land.Scree:
      return [156, 146, 128];
    case Land.Boulders:
      return [140, 132, 120];
    case Land.Rock:
      return [164, 156, 142];
    case Land.Cliff:
      return [118, 108, 98];
    case Land.Compound:
      return [166, 134, 94];
    case Land.CompoundWall:
      return [140, 106, 70];
    case Land.Cemetery:
      return [146, 138, 120];
    case Land.Road:
      return [122, 110, 92];
    case Land.Trail:
      return [140, 126, 100];
    case Land.Footbridge:
      return [128, 102, 74];
    case Land.Hesco:
      return [168, 150, 104]; // tan bastion baskets
    case Land.Structure:
      return [104, 96, 84]; // dark roofs / b-huts
    case Land.Gravel:
      return [134, 126, 114]; // graded gravel pad
    default:
      return [128, 124, 96];
  }
}

/** Fast hash-based value noise (no allocation) for per-pixel texture in the bake. */
function hash2(x: number, y: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x: number, y: number): number {
  return vnoise(x, y) * 0.6 + vnoise(x * 2.13, y * 2.13) * 0.27 + vnoise(x * 4.7, y * 4.7) * 0.13;
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

  // KEY light from the NW (classic shaded relief) + a soft SE FILL so shadowed slopes
  // keep form instead of going dead-black — like a hazy mountain afternoon.
  const norm3 = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l] as const;
  };
  const [kx, ky, kz] = norm3(-0.55, -0.62, 0.56);
  const [fx, fy, fz] = norm3(0.6, 0.55, 0.35);

  const range = terrain.maxElev - terrain.minElev || 1;
  const cs = terrain.cellSize;
  const snowLine = terrain.minElev + range * 0.68; // permanent snow on the high crests

  for (let py = 0; py < W; py++) {
    const wy = (py / pxPerCell) * cs;
    for (let px = 0; px < W; px++) {
      const wx = (px / pxPerCell) * cs;
      const e = terrain.elevAt(wx, wy);
      // gradient → surface normal (central-ish difference, in meters)
      const eX = terrain.elevAt(wx + cs, wy);
      const eY = terrain.elevAt(wx, wy + cs);
      const dzx = (eX - e) / cs;
      const dzy = (eY - e) / cs;
      const slope = Math.hypot(dzx, dzy);
      const nl = Math.hypot(dzx, dzy, 1);
      const nx = -dzx / nl;
      const ny = -dzy / nl;
      const nz = 1 / nl;

      // two-light relief + a sky-ambient term that doubles as cheap ambient occlusion
      // (flat ground catches sky → bright; steep faces see less sky → darker).
      const key = Math.max(0, nx * kx + ny * ky + nz * kz);
      const fill = Math.max(0, nx * fx + ny * fy + nz * fz) * 0.34;
      const sky = 0.5 + 0.5 * nz; // 1 on flat, →0.5 on vertical
      let shade = key * 1.05 + fill + sky * 0.24;
      shade = clamp01(shade * 0.94 + 0.02);

      const alt = clamp01((e - terrain.minElev) / range);
      const land = terrain.landAt(wx, wy);
      let [r, g, b] = landColor(land);

      // ---- per-landcover procedural texture (world-space, so it pans with the map) ----
      const nxw = wx * 0.08;
      const nyw = wy * 0.08;
      let tex = 1; // brightness multiplier
      switch (land) {
        case Land.Forest:
        case Land.Orchard: {
          // dappled canopy: clumps of light & shadow, a touch bluer in the deep shade
          const m = fbm2(nxw * 0.7, nyw * 0.7);
          tex = 0.78 + m * 0.5;
          if (land === Land.Orchard) {
            // planted rows
            const rows = 0.5 + 0.5 * Math.sin(wx * 0.6 + wy * 0.18);
            tex *= 0.88 + 0.18 * rows;
          }
          g += (m - 0.5) * 14;
          break;
        }
        case Land.Cropland:
        case Land.Terrace: {
          // patchwork fields (low-freq tint) + furrows along the contour
          const field = fbm2(nxw * 0.25, nyw * 0.25);
          r += (field - 0.5) * 34;
          g += (field - 0.5) * 26;
          const along = dzx === 0 && dzy === 0 ? wx * 0.5 : (wx * -dzy + wy * dzx) * 1.1;
          tex = 0.9 + 0.12 * (0.5 + 0.5 * Math.sin(along));
          break;
        }
        case Land.Scrub:
        case Land.Grass:
        case Land.Meadow:
        case Land.DryWash: {
          tex = 0.86 + fbm2(nxw, nyw) * 0.34;
          break;
        }
        case Land.Scree:
        case Land.Boulders:
        case Land.Rock:
        case Land.Cliff: {
          // grainy rock speckle
          const s = vnoise(wx * 1.3, wy * 1.3);
          tex = 0.8 + s * 0.46;
          break;
        }
        case Land.River: {
          // flowing water: brighter ripples crossing the channel, glints
          const ripple = 0.5 + 0.5 * Math.sin(wy * 0.7 + fbm2(nxw, nyw) * 6);
          tex = 0.82 + ripple * 0.4;
          b += 14;
          break;
        }
        case Land.Compound:
        case Land.Cemetery: {
          tex = 0.86 + fbm2(nxw * 1.4, nyw * 1.4) * 0.3;
          break;
        }
        default:
          tex = 0.94 + fbm2(nxw, nyw) * 0.12;
      }

      // ---- snow on the high crests (low-slope, high ground) ----
      let snow = 0;
      if (e > snowLine && land !== Land.River) {
        snow = clamp01((e - snowLine) / (range * 0.24)) * clamp01(1 - slope * 0.8);
      }
      if (snow > 0) {
        r = r * (1 - snow) + 236 * snow;
        g = g * (1 - snow) + 240 * snow;
        b = b * (1 - snow) + 250 * snow;
        tex = tex * (1 - snow * 0.7) + 1.0 * snow * 0.7;
      }

      // ---- saturation lift (push colour away from grey so the valley reads vivid,
      //      not muddy military-grey) — except snow, which stays neutral white ----
      if (snow < 0.5) {
        const grey = (r + g + b) / 3;
        const sat = 1.22;
        r = grey + (r - grey) * sat;
        g = grey + (g - grey) * sat;
        b = grey + (b - grey) * sat;
      }

      // ---- compose: texture × relief (high contrast), then atmospheric grading ----
      const sh = (0.34 + 0.95 * shade) * tex;
      // altitude grading: low ground warm, high ground cool & clear
      const warm = 1 - alt * 0.08;
      const cool = 1 + alt * 0.13;
      let R = r * sh * warm;
      let G = g * sh;
      let B = b * sh * cool;
      // light valley haze: just enough atmospheric depth in the deepest ground without
      // graying out the mid-tones.
      const haze = clamp01(0.1 - alt * 0.16) * (land === Land.River ? 0.3 : 1);
      R = R * (1 - haze) + 164 * haze;
      G = G * (1 - haze) + 170 * haze;
      B = B * (1 - haze) + 166 * haze;

      const o = (py * W + px) * 4;
      data[o] = R < 0 ? 0 : R > 255 ? 255 : R;
      data[o + 1] = G < 0 ? 0 : G > 255 ? 255 : G;
      data[o + 2] = B < 0 ? 0 : B > 255 ? 255 : B;
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
