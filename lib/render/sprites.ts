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
import type { SkyState } from "./sky";

/**
 * Per-frame directional FORM-LIGHT for the sprite layer — the cheap CPU answer to the GBuffer
 * relight (issue 028 item 1) that banks the visible win without the puffed-pillow risk. Computed
 * ONCE per frame from the single SkyState (so sprites sit in the SAME light as the GL terrain:
 * warm raking edge at golden hour, cool dim at dusk, flat at noon, gone at night), then threaded
 * into every world-sprite blit. The blit composites ONE `source-atop` gradient over the sprite's
 * own pixels: a warm highlight on the sun-facing edge → neutral → a cool shadow on the sun-away
 * edge. Reads as the lit roof/near-wall catching the sun and the far side falling into shade —
 * real volume on a flat top-down decal, for ~one extra fill per sprite.
 *
 * WORLD-FRAME correctness (the load-bearing constraint): the gradient axis is the sun's
 * screen-projected direction (world +y = screen-down, no flip — same convention as spriteShadow).
 * For a ROTATING sprite the blit counter-rotates this axis by the sprite heading, so a soldier's
 * lit side stays world-anchored and does NOT spin with his facing.
 */
export interface SpriteLight {
  sx: number; // unit screen vector TOWARD the sun (x), world frame
  sy: number; // ...(y); world +y is screen-down
  litR: number; litG: number; litB: number; litA: number; // sun-facing highlight
  shR: number; shG: number; shB: number; shA: number; // sun-away shade
  strength: number; // 0..1 master gate (0 ⇒ skip the pass entirely — night/overcast)
}

/** Build the per-frame SpriteLight from the single SkyState. Pure; cache it once per frame. */
export function spriteLightFrom(sky: SkyState): SpriteLight {
  // direct beam drives the directional form; below the horizon / killed by weather → no form.
  const beam = sky.sunIntensity;
  const kxy = Math.hypot(sky.sunDir[0], sky.sunDir[1]) || 1;
  // a low sun rakes hardest (long screen vector, strong side-light); a high sun flattens form.
  const altClamp = Math.max(0, Math.min(1, sky.sunAltDeg / 60)); // 0 at horizon, 1 by 60°
  const rake = 1 - 0.72 * altClamp; // strong side-light low, gentle near zenith
  const strength = Math.min(1, beam * 0.9) * (0.45 + 0.55 * rake);
  // highlight tint = the sun's own colour (warm at golden hour); shade tint = the cool sky bounce.
  const [sr, sg, sb] = sky.sunColor;
  const [kr, kg, kb] = sky.skyColor;
  return {
    sx: sky.sunDir[0] / kxy,
    sy: sky.sunDir[1] / kxy,
    litR: Math.round(255 * Math.min(1, sr * 1.0 + 0.0)),
    litG: Math.round(255 * Math.min(1, sg)),
    litB: Math.round(255 * Math.min(1, sb)),
    // highlight alpha: gentle — we are ADDING warmth/brightness, not blowing out the albedo.
    litA: 0.26 * strength,
    // shade is the cool ambient bounce, darkened — pushes the sun-away side down & blue.
    shR: Math.round(255 * kr * 0.42),
    shG: Math.round(255 * kg * 0.45),
    shB: Math.round(255 * kb * 0.5),
    shA: 0.4 * strength,
    strength,
  };
}

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
  opts: { rot?: number; alpha?: number; scale?: number; minPx?: number; maxPx?: number; widthM?: number; heightM?: number; light?: SpriteLight } = {}
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
  // FORM-LIGHT: one source-atop directional gradient over the sprite's own pixels — the lit
  // edge catches the sun's colour, the far edge falls into cool shade. The sprite is drawn in a
  // frame already rotated by `rot`; counter-rotate the sun axis by `-rot` so the lit side stays
  // WORLD-anchored (a rotating soldier's highlight does NOT spin with his heading — issue 028).
  if (opts.light && opts.light.strength > 0.02 && pxW * pxH > 30) {
    applyFormLight(ctx, opts.light, -(opts.rot ?? 0), -ax, -ay, pxW, pxH);
  }
  ctx.restore();
  return true;
}

/** Composite the directional highlight→shade gradient over the just-blitted sprite. Caller has
 *  already translated to the sprite anchor + rotated by the heading; `axisRot` un-rotates the
 *  world-frame sun vector back into this local frame so the light is world-stable under heading. */
function applyFormLight(
  ctx: CanvasRenderingContext2D,
  L: SpriteLight,
  axisRot: number,
  x: number, y: number, w: number, h: number
): void {
  // sun vector rotated into the sprite-local frame
  const ca = Math.cos(axisRot), sa = Math.sin(axisRot);
  const ux = L.sx * ca - L.sy * sa;
  const uy = L.sx * sa + L.sy * ca;
  // gradient endpoints span the sprite along the (local) sun axis, centred. Use the projected
  // half-extent of the box onto the sun axis (not the full diagonal) so the lit/shade ends land
  // ON the sprite face — a building lit side-on shows a real bright-edge → dark-edge falloff
  // across its whole width instead of the gradient stops sitting off the corners.
  const half = (Math.abs(ux) * w + Math.abs(uy) * h) * 0.5;
  const cx = x + w * 0.5, cy = y + h * 0.5;
  // lit end is TOWARD the sun; shade end AWAY from it. A wide neutral midband keeps mid-faces
  // honest while the edges clearly catch / lose the sun.
  const grad = ctx.createLinearGradient(cx + ux * half, cy + uy * half, cx - ux * half, cy - uy * half);
  grad.addColorStop(0, `rgba(${L.litR},${L.litG},${L.litB},${L.litA})`);
  grad.addColorStop(0.5, `rgba(${L.litR},${L.litG},${L.litB},0)`);
  grad.addColorStop(0.55, `rgba(${L.shR},${L.shG},${L.shB},0)`);
  grad.addColorStop(1, `rgba(${L.shR},${L.shG},${L.shB},${L.shA})`);
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
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

/**
 * Sun-INDEPENDENT contact-AO halo: a tight, soft dark ellipse hugging an object's base, the
 * ambient-occlusion darkening a real object casts into the ground it touches REGARDLESS of sun
 * angle (the long directional `drawSunShadow` collapses to nothing at noon — this is what keeps
 * the object from floating then). Drawn BEFORE the sprite. `footprintM` = the object's ground
 * width; `strength` 0..1 scales the darkness (units lighter than buildings).
 */
export function drawContactAO(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  wx: number,
  wy: number,
  footprintM: number,
  strength = 1,
  alphaMul = 1,
): void {
  const rPx = footprintM * 0.55 * cam.ppm;
  if (rPx < 2.2) return;
  const [sx, sy] = worldToScreen(cam, wx, wy);
  const a = Math.min(0.4, 0.34 * strength) * alphaMul;
  if (a < 0.02) return;
  // a squashed radial pool — dense at the contact point, feathering out. Bottom-weighted a hair
  // so it reads as the object SITTING on the ground rather than a symmetric dot under it.
  const grad = ctx.createRadialGradient(sx, sy + rPx * 0.12, 0, sx, sy + rPx * 0.12, rPx);
  grad.addColorStop(0, `rgba(14,11,8,${a})`);
  grad.addColorStop(0.55, `rgba(14,11,8,${a * 0.7})`);
  grad.addColorStop(1, "rgba(14,11,8,0)");
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(1, 0.62); // top-down foreshortening
  ctx.translate(-sx, -sy);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy + rPx * 0.12, rPx, 0, Math.PI * 2);
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
