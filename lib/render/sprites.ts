/**
 * Sprite runtime for In the Mountains.
 *
 * Authored SVG assets (see docs/visual-overhaul/) are rasterized ONCE to offscreen
 * canvases at a generous base resolution, then blitted (scaled + rotated) into the
 * live map canvas every frame — the same bake-once/blit-many pattern as the terrain.
 *
 * Two coordinate modes:
 *  - WORLD sprites (buildings, soldiers, trees…): scale with the camera (footprint × ppm).
 *  - SCREEN sprites (markers, compass, mil-symbols): fixed pixel size regardless of zoom.
 *
 * Lighting contract (see ART_BIBLE): static sprites bake NW light + SE shadow; rotating
 * sprites (soldiers/vehicles) carry a symmetric contact shadow so any heading looks right.
 */
import { Camera, worldToScreen } from "./topo";

export interface AssetDef {
  id: string;
  svg: string;
  /** [x,y] fraction of the viewBox that pins to the world/screen point. */
  anchor: [number, number];
  /** Real-world width in meters (world sprites). null → screen-only asset. */
  footprint: number | null;
  rotating: boolean;
  family?: string;
}

interface Baked {
  def: AssetDef;
  canvas: HTMLCanvasElement; // rasterized master
  w: number; // viewBox width
  h: number; // viewBox height
  baseW: number; // raster px width
  baseH: number;
}

const registry = new Map<string, Baked>();
let ready = false;
let loadingPromise: Promise<void> | null = null;

export function spritesReady(): boolean {
  return ready;
}
export function hasSprite(id: string): boolean {
  return registry.has(id);
}

/** Parse "0 0 W H" → [W,H]; default 48×48. */
function viewBoxWH(svg: string): [number, number] {
  const m = svg.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  return [48, 48];
}

/** Choose a base raster size: ~1.6× the largest on-screen footprint we expect. */
function baseResFor(footprint: number | null): number {
  if (footprint == null) return 256; // screen markers — drawn small, but keep crisp
  if (footprint >= 12) return 512; // helos, big qalats
  if (footprint >= 5) return 384; // buildings, vehicles
  return 256; // figures, props, trees
}

function rasterize(def: AssetDef): Promise<Baked> {
  return new Promise((resolve, reject) => {
    const [w, h] = viewBoxWH(def.svg);
    const base = baseResFor(def.footprint);
    const baseW = base;
    const baseH = Math.max(1, Math.round((base * h) / w));
    const img = new Image();
    // Ensure the SVG has explicit pixel size so it rasterizes crisp at base res.
    let svg = def.svg;
    if (!/<svg[^>]*\swidth=/.test(svg)) {
      svg = svg.replace(/<svg/, `<svg width="${baseW}" height="${baseH}"`);
    }
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = baseW;
      canvas.height = baseH;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, baseW, baseH);
      resolve({ def, canvas, w, h, baseW, baseH });
    };
    img.onerror = () => reject(new Error("sprite raster failed: " + def.id));
    img.src = url;
  });
}

/** Rasterize and register a set of assets. Safe to call again to extend the registry. */
export async function loadSprites(defs: AssetDef[]): Promise<void> {
  loadingPromise = (async () => {
    const baked = await Promise.all(
      defs.map((d) =>
        rasterize(d).catch((e) => {
          console.warn("[sprites]", e);
          return null;
        })
      )
    );
    for (const b of baked) if (b) registry.set(b.def.id, b);
    ready = true;
  })();
  return loadingPromise;
}

/**
 * Blit a WORLD sprite: scaled so its footprint (m) maps to ppm pixels, anchored and
 * rotated about its anchor. `rot` in radians; 0 = the authored facing (+x / east).
 */
export function drawWorldSprite(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  id: string,
  wx: number,
  wy: number,
  opts: { rot?: number; alpha?: number; scale?: number; minPx?: number; maxPx?: number; widthM?: number; heightM?: number } = {}
): boolean {
  const b = registry.get(id);
  if (!b || (b.def.footprint == null && opts.widthM == null)) return false;
  const [sx, sy] = worldToScreen(cam, wx, wy);
  let pxW = (opts.widthM ?? b.def.footprint!) * cam.ppm * (opts.scale ?? 1);
  if (opts.minPx) pxW = Math.max(opts.minPx, pxW);
  if (opts.maxPx) pxW = Math.min(opts.maxPx, pxW);
  // heightM overrides intrinsic aspect (used to stretch building roofs to their data footprint).
  const pxH = opts.heightM != null ? opts.heightM * cam.ppm * (opts.scale ?? 1) : (pxW * b.baseH) / b.baseW;
  if (sx < -pxW * 2 || sy < -pxH * 2 || sx > cam.vw + pxW * 2 || sy > cam.vh + pxH * 2) return true;
  const ax = b.def.anchor[0] * pxW;
  const ay = b.def.anchor[1] * pxH;
  ctx.save();
  if (opts.alpha != null) ctx.globalAlpha *= opts.alpha;
  ctx.translate(sx, sy);
  if (opts.rot) ctx.rotate(opts.rot);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(b.canvas, -ax, -ay, pxW, pxH);
  ctx.restore();
  return true;
}

/**
 * Sun-tracked CAST shadow for a tall world object: a soft dark ellipse projecting from the
 * object's base toward the anti-sun direction, length scaling with object height / sun
 * lowness. This is the long cast shadow that sweeps with the clock (distinct from, and
 * complementary to, the tight contact shadow baked into the sprite art — a real object has
 * both). Draw it BEFORE the sprite. `sh` is SkyState.spriteShadow (dir + lengthPerM + alpha).
 */
export function drawSunShadow(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  wx: number,
  wy: number,
  heightM: number,
  footprintM: number,
  sh: { dx: number; dy: number; lengthPerM: number; alpha: number },
): void {
  if (sh.alpha < 0.02) return;
  const lenM = heightM * sh.lengthPerM;
  if (lenM < 0.5) return;
  const [sx, sy] = worldToScreen(cam, wx, wy);
  const lenPx = lenM * cam.ppm;
  const widPx = Math.max(3, footprintM * 0.85 * cam.ppm); // shadow as wide as the object's footprint
  const ang = Math.atan2(sh.dy, sh.dx);
  // a near-vertical sun makes a tiny shadow; don't bother below a couple of screen px
  if (lenPx < 3) return;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  // soft cast shadow that starts full under the base and tapers out toward the tip
  const grad = ctx.createLinearGradient(0, 0, lenPx + widPx * 0.5, 0);
  grad.addColorStop(0, `rgba(18,14,10,${Math.min(0.5, sh.alpha * 1.6)})`);
  grad.addColorStop(0.6, `rgba(18,14,10,${sh.alpha})`);
  grad.addColorStop(1, "rgba(18,14,10,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  // origin lobe (footprint) + an elongated lobe stretching down-sun
  ctx.ellipse(lenPx * 0.5, 0, lenPx * 0.5 + widPx * 0.5, widPx * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Blit a SCREEN sprite: fixed pixel width, anchored, optional rotation. */
export function drawScreenSprite(
  ctx: CanvasRenderingContext2D,
  id: string,
  sx: number,
  sy: number,
  pxW: number,
  opts: { rot?: number; alpha?: number } = {}
): boolean {
  const b = registry.get(id);
  if (!b) return false;
  const pxH = (pxW * b.baseH) / b.baseW;
  const ax = b.def.anchor[0] * pxW;
  const ay = b.def.anchor[1] * pxH;
  ctx.save();
  if (opts.alpha != null) ctx.globalAlpha *= opts.alpha;
  ctx.translate(sx, sy);
  if (opts.rot) ctx.rotate(opts.rot);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(b.canvas, -ax, -ay, pxW, pxH);
  ctx.restore();
  return true;
}

/** Linear crossfade alpha: 0 below `from`, 1 above `to`, ramped between. */
export function lodAlpha(ppm: number, from: number, to: number): number {
  if (ppm <= from) return 0;
  if (ppm >= to) return 1;
  return (ppm - from) / (to - from);
}
