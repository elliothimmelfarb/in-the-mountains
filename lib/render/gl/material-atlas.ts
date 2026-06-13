// Procedural material library for the terrain surface recomposition (C4). Generates a small
// set of tiling material TILES — one per material GROUP — each carrying a luminance-detail map
// (+ roughness) and a micro detail-NORMAL map. The terrain shader samples these at WORLD scale
// and rakes the live sun across the micro-normals, so close-zoom ground resolves into real
// scree grains / furrows / canopy lobes / gravel instead of an upscaled painted smear.
//
// Stored as two WebGL2 TEXTURE_2D_ARRAYs (one layer per material) so each tile is sampled with
// hardware REPEAT — NO atlas gutters, NO seam bleed (the packed-atlas failure mode the design
// fan-out flagged is sidestepped entirely).
//
// DETERMINISTIC + SEED-INDEPENDENT: the library is a fixed function of nothing (same bytes every
// run), so it is free of the terrain seed contract; smoke.ts asserts its hash so a regression in
// the generator is caught. Luminance-only detail (never hue) keeps the dusty ART_BIBLE palette
// exact — the materials add tooth, not colour.

export const TILE = 128; // texels per material tile
export const TILE_METERS = 11.0; // world meters one tile spans (feature scale ~1.4 m → survives tactical-zoom minification)

// Material GROUPS (texture-array layers). The 26 landcover classes map to these via MAT_SLOT.
export const MAT = {
  ROCK: 0, // scree / boulders / rock / cliff — grainy speckle + cracks, strong rake
  GRASS: 1, // grass / meadow / scrub / dry-wash — stippled tufts, soft rake
  FOREST: 2, // forest / orchard — worley canopy lobes, rounded bumps
  CROP: 3, // cropland / terrace — directional furrows along the work line
  RIVERBED: 4, // river / ford / marsh — fine wet gravel (water surface itself is C6)
  MUD: 5, // compound / wall / structure / cemetery — mud-brick, low relief
  HESCO: 6, // gabion baskets — regular cellular grid
  GRAVEL: 7, // gravel / road / track / trail / footbridge — graded gravel grain
} as const;
export const MAT_COUNT = 8;

// Land enum (terrain.ts) → material group. Index = Land value (0..25).
//  0 River 1 Marsh 2 DryWash 3 Cropland 4 Terrace 5 TerraceWall 6 Orchard 7 Meadow 8 Grass
//  9 Scrub 10 Forest 11 Scree 12 Boulders 13 Rock 14 Cliff 15 Compound 16 CompoundWall
//  17 Cemetery 18 Road 19 Trail 20 Footbridge 21 Hesco 22 Structure 23 Gravel 24 Track 25 Ford
export const MAT_SLOT: number[] = [
  /* 0 River*/ MAT.RIVERBED, /* 1 Marsh*/ MAT.RIVERBED, /* 2 DryWash*/ MAT.GRAVEL,
  /* 3 Cropland*/ MAT.CROP, /* 4 Terrace*/ MAT.CROP, /* 5 TerraceWall*/ MAT.MUD,
  /* 6 Orchard*/ MAT.FOREST, /* 7 Meadow*/ MAT.GRASS, /* 8 Grass*/ MAT.GRASS,
  /* 9 Scrub*/ MAT.GRASS, /* 10 Forest*/ MAT.FOREST, /* 11 Scree*/ MAT.ROCK,
  /* 12 Boulders*/ MAT.ROCK, /* 13 Rock*/ MAT.ROCK, /* 14 Cliff*/ MAT.ROCK,
  /* 15 Compound*/ MAT.MUD, /* 16 CompoundWall*/ MAT.MUD, /* 17 Cemetery*/ MAT.MUD,
  /* 18 Road*/ MAT.GRAVEL, /* 19 Trail*/ MAT.GRAVEL, /* 20 Footbridge*/ MAT.GRAVEL,
  /* 21 Hesco*/ MAT.HESCO, /* 22 Structure*/ MAT.MUD, /* 23 Gravel*/ MAT.GRAVEL,
  /* 24 Track*/ MAT.GRAVEL, /* 25 Ford*/ MAT.RIVERBED,
];

// ---- deterministic periodic value noise (wraps at `period` so tiles are seamless) ----
function hashP(xi: number, yi: number, period: number, seed: number): number {
  const x = ((xi % period) + period) % period;
  const y = ((yi % period) + period) % period;
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + seed * 2246822519;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function pnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hashP(xi, yi, period, seed), b = hashP(xi + 1, yi, period, seed);
  const c = hashP(xi, yi + 1, period, seed), d = hashP(xi + 1, yi + 1, period, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbmP(x: number, y: number, baseP: number, seed: number, oct = 4): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * pnoise(x * freq, y * freq, baseP * freq, seed + o * 17);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
// Worley/cellular F1 (periodic) — for canopy lobes & gabion cells.
function worleyP(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      const gx = xi + ox, gy = yi + oy;
      const fx = gx + hashP(gx, gy, period, seed);
      const fy = gy + hashP(gx, gy, period, seed + 91);
      const dx = fx - x, dy = fy - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  return Math.min(1, Math.sqrt(best));
}

/** Per-material height field h(x,y) ∈ ~[0,1] in TILE space, periodic over `freqCells`. The
 *  detail normal is the gradient of this; the luminance detail is a tinted function of it. */
function heightFor(slot: number, x: number, y: number): number {
  const P = 8; // lattice period in tile-units (the noise wraps here → seamless)
  const nx = (x / TILE) * P, ny = (y / TILE) * P; // tile-normalized × lattice period
  switch (slot) {
    case MAT.ROCK: {
      // grainy speckle + a few sharp cracks (low worley ridges)
      const grain = fbmP(nx * 3.1, ny * 3.1, P * 3, 11, 4);
      const crack = 1 - Math.min(1, worleyP(nx * 1.5, ny * 1.5, P, 23) * 2.4);
      return grain * 0.7 + crack * crack * 0.5;
    }
    case MAT.GRASS: {
      const tuft = fbmP(nx * 4.2, ny * 4.2, P * 4, 31, 3);
      return 0.4 + tuft * 0.45;
    }
    case MAT.FOREST: {
      // canopy lobes: inverted worley = rounded crowns, dark gaps between
      const lobe = 1 - worleyP(nx * 1.8, ny * 1.8, P, 47);
      const rough = fbmP(nx * 5, ny * 5, P * 5, 53, 2) * 0.25;
      return lobe * 0.8 + rough;
    }
    case MAT.CROP: {
      // directional furrows (ridge + valley) along x, with gentle wander
      const wob = fbmP(nx * 0.7, ny * 0.7, P, 61, 2) * 1.2;
      const furrow = 0.5 + 0.5 * Math.sin((y / TILE) * P * Math.PI * 2 * 1.0 + wob);
      const tilth = fbmP(nx * 6, ny * 6, P * 6, 67, 2) * 0.18;
      return furrow * 0.7 + tilth;
    }
    case MAT.RIVERBED: {
      const gravel = fbmP(nx * 5.5, ny * 5.5, P * 5, 71, 3);
      return 0.5 + gravel * 0.3;
    }
    case MAT.MUD: {
      // mud-brick: low broad undulation + faint blocky seams
      const broad = fbmP(nx * 2, ny * 2, P * 2, 83, 3);
      const seam = Math.min(
        0.5 + 0.5 * Math.sin((x / TILE) * P * Math.PI * 2 * 2),
        0.5 + 0.5 * Math.sin((y / TILE) * P * Math.PI * 2 * 2),
      );
      return broad * 0.7 + seam * 0.12;
    }
    case MAT.HESCO: {
      // gabion grid: regular cells with dark wire seams
      const gx = 0.5 + 0.5 * Math.sin((x / TILE) * P * Math.PI * 2 * 2.0);
      const gy = 0.5 + 0.5 * Math.sin((y / TILE) * P * Math.PI * 2 * 2.0);
      const cell = Math.min(gx, gy);
      const fill = fbmP(nx * 6, ny * 6, P * 6, 97, 2) * 0.2;
      return cell * 0.75 + fill;
    }
    case MAT.GRAVEL:
    default: {
      const g = fbmP(nx * 4.5, ny * 4.5, P * 4, 103, 3);
      return 0.45 + g * 0.4;
    }
  }
}

// per-material luminance-detail contrast and roughness (packed into albedo.a). Contrast is high:
// from altitude, the surface reads through METER-scale luminance structure (furrows, fracture,
// canopy lobes), so the texture must be bold to survive minification — not photoreal-subtle.
const MAT_CONTRAST = [0.95, 0.66, 0.92, 0.82, 0.58, 0.52, 0.85, 0.72]; // ROCK..GRAVEL
const MAT_ROUGH = [0.92, 0.82, 0.86, 0.74, 0.55, 0.74, 0.82, 0.86];
// micro-normal gradient amplification (per material) — how hard the live sun rakes the facets
const MAT_NRM_AMP = [7.5, 4.0, 6.5, 6.0, 3.0, 3.2, 5.5, 5.0];

export interface MaterialLib {
  albedo: Uint8Array; // MAT_COUNT layers × TILE² × RGBA8 (rgb = luma detail ~0.5 neutral, a = roughness)
  normal: Uint8Array; //  MAT_COUNT layers × TILE² × RG8  (xy = micro-normal, +0.5 encoded)
  tile: number;
  layers: number;
}

let cached: MaterialLib | null = null;

/** Build the material library (cached — deterministic, terrain-independent). */
export function buildMaterialLib(): MaterialLib {
  if (cached) return cached;
  const N = TILE;
  const albedo = new Uint8Array(MAT_COUNT * N * N * 4);
  const normal = new Uint8Array(MAT_COUNT * N * N * 2);
  for (let slot = 0; slot < MAT_COUNT; slot++) {
    const contrast = MAT_CONTRAST[slot];
    const rough = Math.round(MAT_ROUGH[slot] * 255);
    const aBase = slot * N * N * 4;
    const nBase = slot * N * N * 2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const h = heightFor(slot, x, y);
        // periodic gradient (wrap at N) → micro normal in tangent space
        const hX = heightFor(slot, (x + 1) % N, y);
        const hY = heightFor(slot, x, (y + 1) % N);
        const amp = MAT_NRM_AMP[slot]; // amplify into a visible facet slope
        const dzx = (hX - h) * amp;
        const dzy = (hY - h) * amp;
        const inv = 1 / Math.hypot(dzx, dzy, 1);
        const nx = -dzx * inv, ny = -dzy * inv;
        // luminance detail centered on 0.5 (→ ×1.0 in-shader), contrast per material
        const lum = Math.max(0, Math.min(1, 0.5 + (h - 0.5) * contrast));
        const L = Math.round(lum * 255);
        const ai = aBase + (y * N + x) * 4;
        albedo[ai] = L; albedo[ai + 1] = L; albedo[ai + 2] = L; albedo[ai + 3] = rough;
        const ni = nBase + (y * N + x) * 2;
        normal[ni] = Math.round((nx * 0.5 + 0.5) * 255);
        normal[ni + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      }
    }
  }
  cached = { albedo, normal, tile: N, layers: MAT_COUNT };
  return cached;
}

/** FNV-1a hash of the generated library — asserted in smoke.ts so a generator regression trips. */
export function materialLibHash(): number {
  const lib = buildMaterialLib();
  let h = 0x811c9dc5;
  for (let i = 0; i < lib.albedo.length; i += 257) { h ^= lib.albedo[i]; h = Math.imul(h, 0x01000193); }
  for (let i = 0; i < lib.normal.length; i += 257) { h ^= lib.normal[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
