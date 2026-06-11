import { Terrain, Land, FOOT_CLIFF_SLOPE } from "../sim/terrain";
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
    case Land.Track:
      return [128, 116, 96]; // graded dirt track — between the MSR and a faint footpath
    case Land.Trail:
      return [140, 126, 100];
    case Land.Footbridge:
      return [128, 102, 74];
    case Land.Ford:
      return [108, 138, 142]; // pale shallow water over a gravel bar — reads as a crossing
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
 * Set up a relief bake and return a row-band processor + a finisher. The whole 4096² sheet
 * is ~16 M pixels of hillshade + landcover shading — the single heaviest op in a deploy
 * (multiple seconds). Splitting it into `processRows(py0,py1)` lets two drivers share the
 * exact same per-pixel math: the synchronous `bakeTerrain` (one shot, used by the lazy live
 * draw) and the async `bakeTerrainProgressive` (banded + yielding, so the loading screen's
 * progress bar can fill smoothly through the bake instead of freezing).
 */
function makeBake(terrain: Terrain) {
  // Native bake density. The elevation field is bilinear-continuous, so MORE pixels
  // per cell = smoother shaded relief deep into zoom (not 5 m stairsteps). Bumped from
  // 3000/size to 4500/size (→ 8 px/cell on the 512 grid, a 4096² sheet) so the relief
  // stays crisp far longer before the bitmap upscales. Contours are NO LONGER baked in
  // here — they're redrawn live as sharp vectors (drawContoursLive), so zooming never
  // blurs a contour line.
  const pxPerCell = Math.max(3, Math.min(8, Math.round(4500 / terrain.size)));
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

  // Shade rows [py0, py1) into the shared ImageData. Identical math regardless of driver.
  const processRows = (py0: number, py1: number) => {
  for (let py = py0; py < py1; py++) {
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
      // dither the landcover SAMPLE position by a little fbm so class boundaries become
      // organic interlocking edges instead of hard 5 m nearest-neighbour stair-steps.
      const dox = (fbm2(wx * 0.34, wy * 0.34) - 0.5) * cs * 1.6 + (fbm2(wx * 1.1, wy * 1.1) - 0.5) * cs * 0.5;
      const doy = (fbm2(wx * 0.34 + 21.7, wy * 0.34 + 8.3) - 0.5) * cs * 1.6 + (fbm2(wx * 1.1 + 5, wy * 1.1 + 9) - 0.5) * cs * 0.5;
      const land = terrain.landAt(wx + dox, wy + doy);
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
        case Land.Hesco: {
          // gabion basket grid: a regular cellular pattern reads as HESCO bastion
          const gx = 0.5 + 0.5 * Math.sin(wx * 1.15);
          const gy = 0.5 + 0.5 * Math.sin(wy * 1.15);
          const cell = Math.min(gx, gy); // dark seams where the wire baskets meet
          tex = 0.82 + cell * 0.5 + vnoise(wx * 0.9, wy * 0.9) * 0.12;
          break;
        }
        case Land.Gravel: {
          tex = 0.86 + vnoise(wx * 1.4, wy * 1.4) * 0.3; // graded gravel grain
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

      // ---- saturation lift: a gentle push away from grey so the valley reads alive but
      //      stays DUSTY & warm (dust country, not a lawn). Snow & water excluded. ----
      if (snow < 0.5 && land !== Land.River) {
        const grey = (r + g + b) / 3;
        // cropland is the one irrigated note that may stay a touch more vivid
        const sat = land === Land.Cropland || land === Land.Terrace ? 1.16 : 1.08;
        r = grey + (r - grey) * sat;
        g = grey + (g - grey) * sat;
        b = grey + (b - grey) * sat;
        // warm the floor a hair toward ochre so greens read olive, not lime
        r += 4;
        g += 1;
      }

      // ---- IMPASSABLE TERRAIN, MADE OBVIOUS ----
      // Above the foot-passable slope the ground is a sheer rock wall a soldier cannot climb. Render it
      // as one: cool slate, deeper shadow, desaturated — visibly distinct from the warm dusty slopes a
      // soldier CAN traverse, so "where can I go" reads at a glance (the foot-impassable line is the same
      // FOOT_CLIFF_SLOPE the sim blocks on, so the picture tells the truth). The ramp eases in (squared)
      // so the climbable steep band (1.25–1.40) is only faintly hinted while true cliffs go full stone.
      const cliffness = clamp01((slope - (FOOT_CLIFF_SLOPE - 0.3)) / 0.6);
      if (cliffness > 0 && land !== Land.River && snow < 0.5) {
        const c = cliffness * cliffness;
        r = r * (1 - c * 0.5) + 94 * c * 0.5;
        g = g * (1 - c * 0.5) + 100 * c * 0.5;
        b = b * (1 - c * 0.5) + 112 * c * 0.5;
        shade *= 1 - c * 0.32; // the wall falls into its own shadow
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
  }; // end processRows

  // Blit the shaded ImageData onto the canvas, cache it, and return the Baked sheet.
  const finish = (): Baked => {
    ctx.putImageData(img, 0, 0);
    const baked: Baked = { canvas, pxPerCell };
    cache.set(terrain, baked);
    return baked;
  };

  return { W, processRows, finish };
}

/** One-shot synchronous relief bake — used by the lazy live draw path (drawTerrain). */
export function bakeTerrain(terrain: Terrain): Baked {
  const cached = cache.get(terrain);
  if (cached) return cached;
  const bake = makeBake(terrain);
  bake.processRows(0, bake.W);
  return bake.finish();
}

/**
 * Progressive relief bake for the deploy loading screen: shade the sheet in row-bands,
 * reporting 0→1 and yielding a frame between bands so the progress bar fills smoothly and the
 * spinner keeps turning through the multi-second bake. Populates the SAME cache the live draw
 * reads, so the first deploy frame is a pure cache hit (no first-frame freeze).
 */
export async function bakeTerrainProgressive(
  terrain: Terrain,
  onProgress?: (frac: number) => void,
): Promise<Baked> {
  const cached = cache.get(terrain);
  if (cached) { onProgress?.(1); return cached; }
  const bake = makeBake(terrain);
  const BANDS = 40; // ~40 bar updates across the bake — smooth without excessive rAF overhead
  const step = Math.max(1, Math.ceil(bake.W / BANDS));
  for (let py = 0; py < bake.W; py += step) {
    bake.processRows(py, Math.min(bake.W, py + step));
    onProgress?.(Math.min(1, (py + step) / bake.W));
    if (typeof requestAnimationFrame !== "undefined") await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  return bake.finish();
}

/** Pick a contour interval (m) for the current zoom so on-screen line density stays
 *  sane: fine 20 m lines close in, coarsening to 50/100/200 m as you pull out. Index
 *  contours are every 5th line, so the bold interval is 5×. */
function contourIntervalFor(ppm: number): number {
  if (ppm >= 2.2) return 10;
  if (ppm >= 1.1) return 20;
  if (ppm >= 0.55) return 50;
  if (ppm >= 0.3) return 100;
  return 200;
}

/**
 * Marching-squares contour lines drawn LIVE in screen space, every frame, over only the
 * visible cell window — so they are crisp mathematical strokes at ANY zoom (never the
 * blurry upscaled raster the old baked-in contours became). The interval LODs with zoom
 * (denser close in) and the grid is downsampled when zoomed out to bound the per-frame
 * cost; close in, step=1 gives full 5 m fidelity. Index contours (every 5th) are bolder.
 */
export function drawContoursLive(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera) {
  const cs = terrain.cellSize;
  const size = terrain.size;
  // visible world rect → cell window (pad by 1 so partial edge cells still draw)
  const wx0 = cam.cx - cam.vw / 2 / cam.ppm;
  const wx1 = cam.cx + cam.vw / 2 / cam.ppm;
  const wy0 = cam.cy - cam.vh / 2 / cam.ppm;
  const wy1 = cam.cy + cam.vh / 2 / cam.ppm;
  const cx0 = Math.max(0, Math.floor(wx0 / cs) - 1);
  const cy0 = Math.max(0, Math.floor(wy0 / cs) - 1);
  const cx1 = Math.min(size - 1, Math.ceil(wx1 / cs) + 1);
  const cy1 = Math.min(size - 1, Math.ceil(wy1 / cs) + 1);
  if (cx1 <= cx0 || cy1 <= cy0) return;

  // downsample the sampling grid so the work stays bounded (~30k cell-iterations max);
  // at tactical zoom the window is small so step collapses to 1 (full detail).
  const visCells = (cx1 - cx0) * (cy1 - cy0);
  const step = Math.max(1, Math.ceil(Math.sqrt(visCells / 30000)));
  const interval = contourIntervalFor(cam.ppm);
  const ox = cam.vw / 2 - cam.cx * cam.ppm;
  const oy = cam.vh / 2 - cam.cy * cam.ppm;
  const sx = (gx: number) => gx * cs * cam.ppm + ox; // grid x → screen x
  const sy = (gy: number) => gy * cs * cam.ppm + oy;

  const elev = terrain.elev;
  const idx = (x: number, y: number) => y * size + x;
  // batch minor and index contours into two paths so we stroke each style once
  const minor = new Path2D();
  const index = new Path2D();
  const ex = (a: number, b: number, L: number) => (L - a) / (b - a);

  for (let cy = cy0; cy < cy1; cy += step) {
    const cyn = Math.min(size - 1, cy + step);
    for (let cx = cx0; cx < cx1; cx += step) {
      const cxn = Math.min(size - 1, cx + step);
      const e00 = elev[idx(cx, cy)];
      const e10 = elev[idx(cxn, cy)];
      const e01 = elev[idx(cx, cyn)];
      const e11 = elev[idx(cxn, cyn)];
      let minV = e00, maxV = e00;
      if (e10 < minV) minV = e10; else if (e10 > maxV) maxV = e10;
      if (e01 < minV) minV = e01; else if (e01 > maxV) maxV = e01;
      if (e11 < minV) minV = e11; else if (e11 > maxV) maxV = e11;
      const lo = Math.ceil(minV / interval) * interval;
      for (let L = lo; L <= maxV; L += interval) {
        const pts: [number, number][] = [];
        if ((e00 <= L) !== (e10 <= L)) pts.push([cx + (cxn - cx) * ex(e00, e10, L), cy]);
        if ((e10 <= L) !== (e11 <= L)) pts.push([cxn, cy + (cyn - cy) * ex(e10, e11, L)]);
        if ((e01 <= L) !== (e11 <= L)) pts.push([cx + (cxn - cx) * ex(e01, e11, L), cyn]);
        if ((e00 <= L) !== (e01 <= L)) pts.push([cx, cy + (cyn - cy) * ex(e00, e01, L)]);
        if (pts.length < 2) continue;
        const p = Math.round(L / interval) % 5 === 0 ? index : minor;
        p.moveTo(sx(pts[0][0]), sy(pts[0][1]));
        p.lineTo(sx(pts[1][0]), sy(pts[1][1]));
        if (pts.length === 4) {
          p.moveTo(sx(pts[2][0]), sy(pts[2][1]));
          p.lineTo(sx(pts[3][0]), sy(pts[3][1]));
        }
      }
    }
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(58,40,22,0.34)";
  ctx.lineWidth = 1;
  ctx.stroke(minor);
  ctx.strokeStyle = "rgba(48,32,16,0.62)";
  ctx.lineWidth = 1.6;
  ctx.stroke(index);
  ctx.restore();
}

/** A small tiling fbm-noise tile (grayscale ~128) used as a high-zoom ground-detail
 *  overlay. Baked once: it adds crisp high-frequency "tooth" that masks the upscaling
 *  blur of the relief bitmap when you zoom in close. */
let noiseTile: HTMLCanvasElement | null = null;
function bakeNoiseTile(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const N = 256;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // tileable-ish fbm: sample at a few octaves; wrap with a low base freq
      const n = fbm2(x * 0.16, y * 0.16) * 0.6 + vnoise(x * 0.9, y * 0.9) * 0.4;
      const v = 128 + (n - 0.5) * 150; // contrasty grain around mid-grey
      const o = (y * N + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

/** Draw the baked terrain into a live canvas under the given camera. */
/**
 * Stroke the path network as SCALED dirt lines that mold to the terrain — a ~4 m graded MSR, a ~2.5 m
 * village track, a ~1 m goat trail — drawn from the centerlines the generator captured (terrain
 * .trailLines). This replaces the old read: paths were a 5 m landcover TINT, both too wide (a goat
 * trail is not 5 m) and nearly invisible (its color sat a few RGB off the ground). A real road gets a
 * dark cut-casing under a lighter tread; a goat trail is a single faint thread that only resolves as
 * you zoom into the valley. Redrawn live so the lines stay crisp at any zoom.
 */
export function drawPathsLive(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera) {
  const lines = terrain.trailLines;
  if (!lines || lines.length === 0) return;
  const widthM: Record<string, number> = { road: 4.5, track: 2.6, trail: 1.3 };
  const fadeIn: Record<string, number> = { road: 0.1, track: 0.16, trail: 0.3 }; // ppm at which it appears
  const minPx: Record<string, number> = { road: 1.4, track: 1.0, trail: 0.8 };
  const tread: Record<string, string> = {
    road: "190,160,116",
    track: "176,148,106",
    trail: "162,138,98",
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // back-to-front by importance so trails sit under tracks under roads where they meet
  const order: Array<"trail" | "track" | "road"> = ["trail", "track", "road"];
  for (const kind of order) {
    const a = clamp01((cam.ppm - fadeIn[kind]) / 0.4);
    if (a <= 0.02) continue;
    const wpx = Math.max(minPx[kind], widthM[kind] * cam.ppm);
    for (const path of lines) {
      if (path.kind !== kind || path.pts.length < 2) continue;
      // midpoint quadratic smoothing: the generator emits ~7 m straight segments, which read as
      // jagged CAD polylines at tactical zoom — routing each vertex as the control point of a
      // quadratic through the segment midpoints turns hairpins into the worn, rounded curves a
      // real foot-trail cuts, while still passing through the start/end of every path.
      const trace = () => {
        ctx.beginPath();
        const p = path.pts;
        const [sx, sy] = worldToScreen(cam, p[0].x, p[0].y);
        ctx.moveTo(sx, sy);
        if (p.length === 2) {
          const [x, y] = worldToScreen(cam, p[1].x, p[1].y);
          ctx.lineTo(x, y);
          return;
        }
        for (let i = 1; i < p.length - 1; i++) {
          const [ax, ay] = worldToScreen(cam, p[i].x, p[i].y);
          const [bx, by] = worldToScreen(cam, p[i + 1].x, p[i + 1].y);
          ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
        }
        const [ex, ey] = worldToScreen(cam, p[p.length - 1].x, p[p.length - 1].y);
        ctx.lineTo(ex, ey);
      };
      // every path sits in a faint shallow groove — a dark casing reads as that worn edge and lifts
      // the line off the busy ground texture (a road/track gets a wider, darker one than a goat trail)
      ctx.globalAlpha = a * (kind === "trail" ? 0.32 : 0.5);
      ctx.strokeStyle = "rgba(54,42,28,1)";
      ctx.lineWidth = wpx + (kind === "trail" ? 1.0 : 1.6);
      trace();
      ctx.stroke();
      ctx.globalAlpha = kind === "trail" ? a * 0.82 : a * 0.95;
      ctx.strokeStyle = `rgba(${tread[kind]},1)`;
      ctx.lineWidth = wpx;
      trace();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawTerrain(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera, night = 0) {
  const baked = bakeTerrain(terrain);
  const destScale = (cam.ppm * terrain.cellSize) / baked.pxPerCell;
  const [ox, oy] = worldToScreen(cam, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(baked.canvas, ox, oy, baked.canvas.width * destScale, baked.canvas.height * destScale);

  // high-zoom ground-detail overlay: world-anchored noise grain that gives the ground
  // crisp micro-texture ("tooth") so the upscaled relief reads as detailed rock/scrub
  // instead of a smeared bitmap. Fades in earlier and a little stronger now that the
  // relief is the only raster layer (contours are sharp vectors on top).
  const detailA = clamp01((cam.ppm - 0.6) / 2.0) * 0.5;
  if (detailA > 0.01) {
    const tile = bakeNoiseTile();
    const pat = ctx.createPattern(tile, "repeat");
    if (pat && (pat as CanvasPattern).setTransform) {
      const sc = 0.4 * cam.ppm; // ~0.4 m per noise pixel → fine grain that sharpens with zoom
      (pat as CanvasPattern).setTransform(new DOMMatrix([sc, 0, 0, sc, ox, oy]));
      ctx.save();
      ctx.globalAlpha = detailA;
      ctx.globalCompositeOperation = "overlay";
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, cam.vw, cam.vh);
      ctx.restore();
    }
  }

  // crisp vector contours, redrawn live every frame (never blur on zoom)
  drawContoursLive(ctx, terrain, cam);

  // the path network as scaled dirt lines (roads/tracks/goat-trails) molding to the terrain
  drawPathsLive(ctx, terrain, cam);

  // night / low-light wash
  if (night > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(8,14,30,${0.35 + night * 0.42})`;
    ctx.fillRect(0, 0, cam.vw, cam.vh);
    ctx.restore();
  }
}

// ---- WEATHER (atmospheric overlay, drawn over terrain + decoration, under units) ----
//
// The sim already computes a full weather model (label / precip / visibility / wind) but
// the map drew nothing but a flat night wash. This renders that weather as restrained,
// in-palette atmosphere — rain streaks, drifting fog/cloud, falling snow that thickens on
// the high crests, blowing dust — so a Rain day FEELS like rain and Fog actually closes
// the valley in. Pure render: reads world.state.weather + the live wind vector
// (sim.weather.windX/windY); writes nothing back to lib/sim.
//
// Restraint contract (ART_BIBLE §9 / wave guardrails): weather is ATMOSPHERE, exempt
// from the NW cast-shadow rule (it's not an object), but stays inside the locked dusty
// palette, NEVER strobes, and the summed alpha (veil + particles) is capped so it never
// obscures the tactical read. Particle POSITIONS are hashed off a frozen screen grid +
// a wall-clock phase, so they animate smoothly without per-frame Math.random shimmer.

/** The render-side view of the weather the sim computes (decoupled from World). */
export interface WeatherView {
  label: string;       // "Clear" | "Hazy" | "Overcast" | "Rain" | "Fog" | "Snow"
  precip: boolean;
  visibilityM: number; // 600 (Fog) … 4000 (Clear)
  wind: number;        // m/s, prevailing speed
  windX: number;       // live drift vector x (sim.weather.windX)
  windY: number;       // live drift vector y (sim.weather.windY)
  minElev: number;     // terrain.minElev — for the snow-line on the crests
  elevRange: number;   // terrain.maxElev - terrain.minElev
  elevAt?: (wx: number, wy: number) => number; // optional: real elevation sampler (snow gate)
}

/** Cosmetic wall-clock seconds (render-only; never feeds back into lib/sim). */
function wxNow(): number {
  return (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
}
/** Cheap deterministic hash → [0,1) for frozen-grid particle scatter (no shimmer). */
function whash(a: number, b: number): number {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

/**
 * Draw the active weather as an atmospheric overlay. Call AFTER drawTerrain/drawDecoration
 * (so it sits over the relief) and BEFORE the unit/tactical layer (so it never hides the
 * fight). `night` is 1-ambientLight; weather alpha is damped at night so it doesn't fight
 * the night wash.
 */
export function drawWeather(ctx: CanvasRenderingContext2D, cam: Camera, w: WeatherView, night = 0) {
  if (w.label === "Clear") return; // crisp valley — draw nothing
  const t = wxNow();
  // visibility → "thickness": Fog 600 m strongest, Hazy 2600 m faint.
  const thick = clamp01(1 - w.visibilityM / 4000);
  // night damp: weather recedes into the dark so it doesn't double up on the night wash.
  const nightK = 0.6 + 0.4 * (1 - night);
  // wind heading + speed (live drift vector), with a gentle floor so still air still drifts.
  const wmag = Math.hypot(w.windX, w.windY);
  const wang = wmag > 1e-3 ? Math.atan2(w.windY, w.windX) : 1.3; // default: down-right
  const wspd = Math.max(2.5, w.wind);

  // --- 1) ATMOSPHERIC VEIL: a flat tint that drops apparent visibility (the "weather is
  // present" read even on a precip-free Overcast/Hazy day). Fog = strong cool grey veil;
  // Hazy/Overcast = a light cool veil; Snow = a faint bright veil; blowing dust = warm. ---
  let veilCol = "176,172,162"; // smoke-grey (ART_BIBLE smoke palette)
  let veilA = 0;
  const dusty = w.label === "Hazy" && w.wind > 5; // map "blowing dust" onto a windy Hazy
  if (w.label === "Fog") veilA = 0.04 + thick * 0.16;
  else if (w.label === "Overcast") veilA = 0.06 + thick * 0.05;
  else if (dusty) { veilCol = "164,150,110"; veilA = 0.07 + thick * 0.06; } // warm haze (topo bake haze hue)
  else if (w.label === "Hazy") { veilCol = "182,176,166"; veilA = 0.05 + thick * 0.04; }
  else if (w.label === "Snow") { veilCol = "210,214,222"; veilA = 0.04 + thick * 0.05; }
  else if (w.label === "Rain") { veilCol = "150,160,170"; veilA = 0.05 + thick * 0.05; }
  if (veilA > 0.005) {
    ctx.save();
    ctx.fillStyle = `rgba(${veilCol},${(veilA * nightK).toFixed(3)})`;
    ctx.fillRect(0, 0, cam.vw, cam.vh);
    ctx.restore();
  }

  // --- 2) DRIFTING FOG / LOW CLOUD: a few big soft radial blobs panning with the wind, so
  // visibility reads as physically moving cloud, not just a flat filter. (Fog mainly; a
  // couple of lighter ones on Overcast so the ceiling feels low.) ---
  if (w.label === "Fog" || w.label === "Overcast") {
    const blobs = w.label === "Fog" ? 3 : 2;
    const span = Math.max(cam.vw, cam.vh);
    ctx.save();
    for (let i = 0; i < blobs; i++) {
      // each blob pans slowly along the wind heading; wraps across the viewport.
      const phase = (t * wspd * (w.label === "Fog" ? 3.0 : 1.6) + i * 977) ;
      const drift = ((phase % (span + 600)) - 300);
      const bx = cam.vw * (0.2 + 0.3 * i) + Math.cos(wang) * drift;
      const by = cam.vh * (0.35 + 0.22 * (i % 2)) + Math.sin(wang) * drift * 0.5
                 + Math.sin(t * 0.15 + i) * 18; // gentle vertical breathing
      const R = span * (0.45 + 0.18 * i);
      const a = (w.label === "Fog" ? 0.10 : 0.05) * (0.6 + thick) * nightK;
      const grad = ctx.createRadialGradient(bx, by, 0, bx, by, R);
      grad.addColorStop(0, `rgba(${veilCol},${a.toFixed(3)})`);
      grad.addColorStop(1, `rgba(${veilCol},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- 3) PRECIP PARTICLES: rain streaks / snow flakes on a frozen screen grid so they
  // never shimmer; each cell carries one particle that falls (down + along the wind) and
  // wraps. Density ∝ thickness; alpha low per particle so the mass reads as weather. ---
  if (w.label === "Rain" || w.label === "Snow" || dusty) {
    const snow = w.label === "Snow";
    // streak direction: rain steep along wind, snow gentle, dust near-horizontal.
    const fall = snow ? 0.9 : dusty ? 0.15 : 1.0;           // vertical bias
    const along = (w.windX / wspd) * (snow ? 0.5 : dusty ? 1.4 : 0.45); // wind shear
    // grid cell size in px → density; smaller cell = denser. Rain dense, snow medium.
    const cell = snow ? 46 : dusty ? 58 : 26;
    const cols = Math.ceil(cam.vw / cell) + 1;
    const rows = Math.ceil(cam.vh / cell) + 1;
    const fallPxS = snow ? 70 : dusty ? 90 : 520; // fall speed (px/s)
    const len = snow ? 0 : dusty ? 12 : 18;        // streak length (px); snow = dot
    ctx.save();
    ctx.lineCap = "round";
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const seed = whash(gx, gy);
        // per-cell density gate (thicker weather → more cells populated). Rain/snow keep a
        // high base so the field reads as real precipitation, not an occasional speck.
        if (seed > 0.6 + thick * 0.38) continue;
        // SNOW gates by elevation: thickens on the high crests, thins on the floor. We use
        // the screen position → world position → elevation vs the bake's snow-line constant.
        const baseX = gx * cell + seed * cell;
        const baseY = gy * cell + whash(gy, gx) * cell;
        // animate: progress down the column with a per-cell phase, wrap over the viewport.
        const phase = seed * 1000;
        const prog = (t * fallPxS + phase) % (cam.vh + 80);
        const px = baseX + along * prog + (snow ? Math.sin(t * 1.3 + phase) * 10 : 0);
        const py = (baseY + prog) % (cam.vh + 80) - 40;
        if (snow) {
          // SNOW THICKENS ON THE CRESTS: gate flake density by the real elevation under this
          // screen point vs the bake's snow-line (the same constant makeBake uses for the
          // baked snow caps), so falling snow concentrates on the high ground and thins to
          // nothing on the valley floor — the storm reads as "snowing on the peaks."
          if (w.elevAt) {
            const wx = (px - cam.vw / 2) / cam.ppm + cam.cx;
            const wy = (py - cam.vh / 2) / cam.ppm + cam.cy;
            const snowLine = w.minElev + w.elevRange * 0.55; // a touch below the bake cap → flurries reach mid-slope
            const e = w.elevAt(wx, wy);
            const hi = clamp01((e - snowLine) / Math.max(1, w.elevRange * 0.45));
            // keep a faint valley flurry (0.2) rising to full on the crests (1.0)
            if (whash(gx + 31, gy + 17) > 0.2 + hi * 0.8) continue;
          }
          const r = 1.4 + seed * 1.8;
          ctx.fillStyle = `rgba(240,244,252,${(0.8 * nightK).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const a = (dusty ? 0.18 : 0.30) * nightK;
          ctx.strokeStyle = dusty ? `rgba(176,162,124,${a})` : `rgba(176,190,200,${a})`;
          ctx.lineWidth = dusty ? 1.5 : 1.1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - along * len, py - fall * len);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

/** A faint UTM-style grid with labels, drawn over terrain. */
export function drawGrid(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera, spacingM = 200) {
  ctx.save();
  // faint cartographic reference that sits UNDER the terrain detail, not a wireframe over it
  ctx.strokeStyle = "rgba(216,214,196,0.06)";
  ctx.fillStyle = "rgba(216,214,196,0.28)";
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
