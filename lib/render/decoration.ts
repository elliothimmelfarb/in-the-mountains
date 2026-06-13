/**
 * Terrain decoration layer — scatters vegetation/rock sprites over the baked relief so
 * forest/orchard/scrub/scree stop being textured blobs and become actual trees and rocks
 * as you zoom in. Positions derive from a STABLE per-point hash, so decoration never jitters
 * when you pan or zoom (it's anchored in world space).
 *
 * Naturalism rules (from the art-direction critique):
 *  - CLUMPING: a low-frequency density field gates spawns, so canopies form groves and
 *    clearings instead of an even polka-dot grid.
 *  - CLEARANCE: nothing spawns on (or whose canopy would overlap) roads, trails, water,
 *    footbridges, or the COP — checked against neighbouring cells.
 *  - VARIATION: wide per-instance scale + a little rotation jitter so no two read identical.
 * Pure render overlay (no sim impact); fades in at tactical zoom so the strategic map stays clean.
 */
import { Terrain, Land } from "../sim/terrain";
import { Camera, screenToWorld } from "./topo";
import { drawWorldSprite, drawSunShadow, lodAlpha, hasSprite, type SpriteLight } from "./sprites";

const STEP = 6; // world metres between scatter candidates (fixed → deterministic)

function hash(ix: number, iy: number, salt: number): number {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (salt | 0) * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
/** Smooth low-frequency value noise (for the clump/density field). */
function valNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, 7), b = hash(xi + 1, yi, 7), c = hash(xi, yi + 1, 7), d = hash(xi + 1, yi + 1, 7);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

interface Pick { id: string; prob: number; scale: number; }

function pickDeco(land: Land, r: number): Pick | null {
  switch (land) {
    case Land.Forest:
      // mix poplar + two cedar silhouettes + a few broadleaf so the canopy isn't all identical
      return r < 0.18 ? { id: "tree-poplar", prob: 0.9, scale: 1.0 } : r < 0.5 ? { id: "tree-cedar", prob: 0.95, scale: 1.08 } : r < 0.82 ? { id: "tree-cedar-b", prob: 0.95, scale: 1.04 } : { id: "tree-walnut", prob: 0.85, scale: 0.9 };
    case Land.Orchard:
      return r < 0.5 ? { id: "tree-walnut", prob: 0.85, scale: 1.0 } : { id: "tree-walnut-b", prob: 0.85, scale: 1.0 };
    case Land.Scrub:
      return r < 0.1 ? { id: "tree-walnut-b", prob: 0.2, scale: 0.8 } : { id: "bush-scrub", prob: 0.5, scale: 1.0 };
    case Land.Meadow:
    case Land.Grass:
      // mostly open, but a few lone outlier trees break the bush monotony
      return r < 0.035 ? { id: "tree-poplar", prob: 0.45, scale: 0.95 } : r < 0.08 ? { id: "tree-walnut-b", prob: 0.4, scale: 0.9 } : { id: "bush-scrub", prob: 0.08, scale: 0.85 };
    // NOTE: boulders & rock outcrops are NO LONGER scattered here — they are real sim cover OBJECTS
    // (terrain.coverObjects), drawn by drawCoverObjects() below so the drawn rock IS the one the combat
    // takes cover behind (issue 020). pickDeco now only places vegetation.
    case Land.Marsh:
      return { id: "reeds", prob: 0.4, scale: 1.0 };
    case Land.DryWash:
      return r < 0.6 ? null : { id: "bush-scrub", prob: 0.12, scale: 0.8 };
    default:
      return null; // NO trees on compounds/roads/COP/etc — clearance handles the rest
  }
}

/** Classes that decoration must keep clear of (linear features, water, the COP). */
function isClearanceBlocker(land: Land): boolean {
  return (
    land === Land.Road || land === Land.Trail || land === Land.Footbridge || land === Land.River ||
    land === Land.Track || land === Land.Hesco || land === Land.Structure || land === Land.Gravel ||
    land === Land.Compound || land === Land.CompoundWall || land === Land.TerraceWall
  );
}

interface DecoItem { x: number; y: number; id: string; scale: number; rot: number; }

export function drawDecoration(ctx: CanvasRenderingContext2D, terrain: Terrain, cam: Camera, fogAt?: (wx: number, wy: number) => number, sun?: { dx: number; dy: number; lengthPerM: number; alpha: number }, light?: SpriteLight): void {
  const alpha = lodAlpha(cam.ppm, 0.9, 1.8);
  if (alpha <= 0.02) return;
  if (!hasSprite("tree-cedar") && !hasSprite("boulder")) return;

  const [aw, ah] = screenToWorld(cam, 0, 0);
  const [bw, bh] = screenToWorld(cam, cam.vw, cam.vh);
  const minx = Math.min(aw, bw) - 12, maxx = Math.max(aw, bw) + 12;
  const miny = Math.min(ah, bh) - 12, maxy = Math.max(ah, bh) + 18;
  const ws = terrain.worldSize;

  const gx0 = Math.floor(minx / STEP), gx1 = Math.ceil(maxx / STEP);
  const gy0 = Math.floor(miny / STEP), gy1 = Math.ceil(maxy / STEP);

  const items: DecoItem[] = [];
  const CAP = 1800;
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      // stronger jitter so the underlying grid is invisible
      const jx = (gx + 0.1 + hash(gx, gy, 1) * 0.8) * STEP;
      const jy = (gy + 0.1 + hash(gx, gy, 2) * 0.8) * STEP;
      if (jx < 0 || jy < 0 || jx >= ws || jy >= ws) continue;
      const land = terrain.landAt(jx, jy);
      const pick = pickDeco(land, hash(gx, gy, 3));
      if (!pick) continue;

      // clumping: a low-freq density field carves groves & clearings out of the even scatter
      const clump = valNoise(jx * 0.012, jy * 0.012); // ~80 m features
      const dens = pick.prob * (0.35 + clump * clump * 1.3);
      if (hash(gx, gy, 4) > dens) continue;

      // clearance: reject if a road/trail/water/COP cell is within ~5 m (canopy would overlap)
      if (
        isClearanceBlocker(terrain.landAt(jx + 5, jy)) || isClearanceBlocker(terrain.landAt(jx - 5, jy)) ||
        isClearanceBlocker(terrain.landAt(jx, jy + 5)) || isClearanceBlocker(terrain.landAt(jx, jy - 5))
      ) continue;

      const sc = pick.scale * (0.6 + hash(gx, gy, 5) * 0.9); // wide scale variation
      const rot = (hash(gx, gy, 6) - 0.5) * 0.5; // small rotation jitter breaks uniformity
      items.push({ x: jx, y: jy, id: pick.id, scale: sc, rot });
    }
  }
  // Discrete cover OBJECTS (boulders / rock outcrops) — drawn straight from the sim's source-of-truth
  // list, so each one is exactly where the combat cover field was stamped (issue 020). They share the
  // vegetation's clearance/clumping (baked into generation) and the same painter's sort below.
  for (const o of terrain.coverObjects) {
    if (o.x < minx || o.x > maxx || o.y < miny || o.y > maxy) continue;
    items.push({ x: o.x, y: o.y, id: o.id, scale: o.scale, rot: o.rot });
  }

  items.sort((a, b) => a.y - b.y); // painter's order
  const n = Math.min(items.length, CAP);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    // fade trees/rocks that sit in the valley fog so they recede with the terrain (parity with
    // the GL fog) instead of poking through it. fogAt returns 0 when there's no fog (cheap).
    const fog = fogAt ? fogAt(it.x, it.y) : 0;
    const a = fog > 0.001 ? alpha * (1 - 0.85 * fog) : alpha;
    if (a <= 0.02) continue;
    // sun-tracked cast shadow grounds each tree/rock on the lit terrain (trees tall → long shadow,
    // rocks short → tight contact). Faded with fog + the deco LOD alpha so it never floats.
    if (sun && sun.alpha > 0.02) {
      const tall = it.id.startsWith("tree") || it.id.includes("cedar") || it.id.includes("walnut") || it.id.includes("poplar");
      const hM = it.scale * (tall ? 5.0 : it.id.includes("scrub") || it.id.includes("bush") ? 1.4 : 1.1);
      drawSunShadow(ctx, cam, it.x, it.y, hM, it.scale * 3.0, { ...sun, alpha: sun.alpha * (a / Math.max(alpha, 0.01)) * 0.9 });
    }
    drawWorldSprite(ctx, cam, it.id, it.x, it.y, { alpha: a, scale: it.scale, rot: it.rot, light });
  }
}
