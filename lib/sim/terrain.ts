import { RNG, ValueNoise, clamp, clamp01, smoothstep, lerp } from "./rng";
import { Vec2 } from "./vec";

/** Landcover classes. Drive cover (stops bullets), concealment (blocks sight),
 *  movement cost, and rendering tint. At 5 m fidelity the valley is resolved
 *  down to terrace risers, compound walls, boulder fields and dry washes — the
 *  micro-terrain that decides who lives in a Korengal firefight. */
export enum Land {
  River = 0, // flowing water — slow to cross, exposed
  Marsh = 1, // irrigated / boggy ground on the floor
  DryWash = 2, // seasonal streambed & re-entrant bottom — concealed lane / dead ground
  Cropland = 3, // irrigated valley-floor fields
  Terrace = 4, // terraced hillside fields
  TerraceWall = 5, // stone/earth retaining risers — linear hard cover
  Orchard = 6, // walnut/mulberry — concealment + light cover
  Meadow = 7, // upland pasture
  Grass = 8, // open dry grass / pasture
  Scrub = 9, // holly-oak scrub, the choking Korengal brush
  Forest = 10, // cedar / oak forest on mid-upper slopes
  Scree = 11, // loose rock, steep
  Boulders = 12, // boulder fields — scattered hard cover
  Rock = 13, // bare rock, crests
  Cliff = 14, // near-vertical rock — impassable
  Compound = 15, // qalat interior (buildings / courtyard)
  CompoundWall = 16, // mud perimeter walls — heavy hard cover
  Cemetery = 17, // walled graveyard — cover + cultural sensitivity
  Road = 18, // graded road / MSR
  Trail = 19, // foot / goat trail
  Footbridge = 20, // crossing over the river / a wash
}

export const LAND_COUNT = 21;

export interface Village {
  id: string;
  name: string;
  cx: number;
  cy: number; // cell coords of village center
  size: number; // rough radius in cells
  population: number;
}

export interface NamedFeature {
  name: string;
  cx: number;
  cy: number;
  kind: "peak" | "saddle" | "draw" | "spur" | "bridge" | "junction";
  elevation?: number;
}

export interface TerrainConfig {
  size: number; // cells per side
  cellSize: number; // meters per cell
  seed: number | string;
  floorSouth: number; // elevation at south mouth (m)
  floorNorth: number; // elevation at north head (m)
  ridgeHeight: number; // height of crests above local floor (m)
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  size: 512, // 512 × 5 m = 2.56 km valley resolved to 5 m
  cellSize: 5,
  seed: "korengal",
  floorSouth: 1550,
  floorNorth: 2000,
  ridgeHeight: 780,
};

/**
 * A procedurally generated Afghan mountain valley. North is -y (top of map),
 * the river runs down the valley floor, ridgelines rise steeply east and west,
 * cut by draws (re-entrants) and spurs. Villages sit on benches above the river;
 * the COP sits on a defensible knob with fields of fire.
 */
export class Terrain {
  readonly size: number;
  readonly cellSize: number;
  readonly worldSize: number;
  readonly elev: Float32Array;
  readonly land: Uint8Array;
  readonly cover: Float32Array; // 0..1 hard cover (stops rounds) at this cell
  readonly conceal: Float32Array; // 0..1 visual concealment / canopy density
  readonly slope: Float32Array; // gradient magnitude (rise/run)
  minElev = Infinity;
  maxElev = -Infinity;

  villages: Village[] = [];
  features: NamedFeature[] = [];
  copCell: { cx: number; cy: number } = { cx: 0, cy: 0 };
  /** Centerline x (in cells) of the valley floor at each row y. */
  private centerX: Float32Array;
  readonly config: TerrainConfig;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN, ...config };
    const { size, cellSize } = this.config;
    this.size = size;
    this.cellSize = cellSize;
    this.worldSize = size * cellSize;
    const n = size * size;
    this.elev = new Float32Array(n);
    this.land = new Uint8Array(n);
    this.cover = new Float32Array(n);
    this.conceal = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.centerX = new Float32Array(size);
    this.generate();
  }

  idx(cx: number, cy: number): number {
    return cy * this.size + cx;
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.size && cy < this.size;
  }

  /** Convert a per-meter spatial frequency to the fbm cell-space argument, so
   *  landform scale is independent of grid resolution. */
  private mfreq = (wavelengthM: number) => this.cellSize / wavelengthM;

  private generate() {
    const rng = new RNG(this.config.seed);
    const noise = new ValueNoise(rng.int(1, 1e9));
    const ridgeNoise = new ValueNoise(rng.int(1, 1e9));
    const detailNoise = new ValueNoise(rng.int(1, 1e9));
    const { size } = this;
    const { floorSouth, floorNorth, ridgeHeight } = this.config;
    void noise;

    // Per-meter feature frequencies, converted to cell-space (resolution-free).
    const fRidge = this.mfreq(950);
    const fRidge2 = this.mfreq(360);
    const fFinger = this.mfreq(520);
    const fDetail = this.mfreq(70);

    // --- Meandering valley centerline (the river/floor) ---
    const meanderAmp = size * 0.16;
    const meanderFreq = 2.3;
    const meanderPhase = rng.range(0, Math.PI * 2);
    for (let y = 0; y < size; y++) {
      const t = y / (size - 1);
      const m =
        Math.sin(t * Math.PI * meanderFreq + meanderPhase) * meanderAmp * (0.6 + 0.4 * t) +
        ridgeNoise.fbm(t * 3, 10, 3) * meanderAmp * 0.5;
      this.centerX[y] = size * 0.5 + m;
    }

    // Side-draw channels: a few re-entrants cutting into the ridges where forest
    // grows thick and the enemy moves. Each is a centerline-bearing on one side.
    const draws = Array.from({ length: rng.int(4, 7) }, () => ({
      y: rng.range(0.12, 0.88) * size,
      side: rng.chance(0.5) ? -1 : 1,
      width: rng.range(0.04, 0.085) * size,
      depth: rng.range(0.35, 0.6), // fraction of ridge height carved out
      reach: rng.range(0.45, 0.85), // how far up the slope it reaches
    }));
    this.drawChannels = draws;

    for (let y = 0; y < size; y++) {
      const ty = y / (size - 1);
      const floor = lerp(floorSouth, floorNorth, ty) + ridgeNoise.fbm(2, ty * 4, 3) * 40;
      const cx = this.centerX[y];
      for (let x = 0; x < size; x++) {
        const dxCells = x - cx;
        const half = size * 0.5;
        const ndx = clamp01(Math.abs(dxCells) / half); // 0 at river → 1 at edge

        // Cross-valley profile: steep V near floor, broadening to ridges.
        let h = Math.pow(ndx, 0.78) * ridgeHeight;

        // Ridge crest irregularity (spurs and notches along the crest).
        const ridgeMod =
          ridgeNoise.fbm(x * fRidge, y * fRidge, 5) * ridgeHeight * 0.32 +
          ridgeNoise.fbm(x * fRidge2, y * fRidge2, 3) * ridgeHeight * 0.13;
        h += ridgeMod * smoothstep(0.15, 0.8, ndx);

        // Spurs/fingers and draws perpendicular to the valley (medium-scale).
        const finger = detailNoise.fbm(x * fFinger, y * fFinger * 0.3, 4);
        h += finger * ridgeHeight * 0.18 * smoothstep(0.1, 0.6, ndx);

        // Carve side-draws (lower elevation channels reaching up the slope).
        for (const d of draws) {
          if (Math.sign(dxCells) !== d.side) continue;
          const dyc = Math.abs(y - d.y);
          if (dyc > d.width * 2) continue;
          const along = smoothstep(d.width * 2, 0, dyc); // 1 at draw axis
          const reach = ndx < d.reach ? 1 : smoothstep(d.reach + 0.15, d.reach, ndx);
          h -= along * reach * ridgeHeight * d.depth;
        }

        // River incision near the centerline.
        const riverCut = smoothstep(2.4 * (20 / this.cellSize), 0, Math.abs(dxCells)) * 22;

        let e = floor + Math.max(0, h) - riverCut;
        // Fine surface roughness (kept modest so 5 m slopes aren't all cliffs).
        e += detailNoise.fbm(x * fDetail, y * fDetail, 3) * 7;

        const i = this.idx(x, y);
        this.elev[i] = e;
        if (e < this.minElev) this.minElev = e;
        if (e > this.maxElev) this.maxElev = e;
      }
    }

    this.computeSlope();
    this.classifyLand(rng, draws);
    this.placeVillagesAndCOP(rng);
    this.carveRoadsAndTrails(rng);
    this.deriveCoverConcealment();
    this.nameFeatures(rng);
  }

  /** Re-entrant channels cut into the ridges — the enemy's covered approaches. */
  drawChannels: { y: number; side: number; width: number; depth: number; reach: number }[] = [];

  private computeSlope() {
    const { size, cellSize } = this;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const e = this.elev[this.idx(x, y)];
        const ex = this.elev[this.idx(Math.min(size - 1, x + 1), y)];
        const ey = this.elev[this.idx(x, Math.min(size - 1, y + 1))];
        const dzdx = (ex - e) / cellSize;
        const dzdy = (ey - e) / cellSize;
        this.slope[this.idx(x, y)] = Math.hypot(dzdx, dzdy);
      }
    }
  }

  private classifyLand(rng: RNG, draws: { y: number; side: number; width: number }[]) {
    const { size, cellSize } = this;
    const vegNoise = new ValueNoise(rng.int(1, 1e9));
    const patchNoise = new ValueNoise(rng.int(1, 1e9));
    const fVeg = this.mfreq(170);
    const fPatch = this.mfreq(45);
    const riverHalf = Math.max(1.4, 8 / cellSize); // ~8 m of channel
    for (let y = 0; y < size; y++) {
      const cx = this.centerX[y];
      for (let x = 0; x < size; x++) {
        const i = this.idx(x, y);
        const slope = this.slope[i];
        const e = this.elev[i];
        const distRiver = Math.abs(x - cx);
        const aboveFloor = e - this.floorElevAtRow(y);
        const drawProx = this.drawProximity(x, y, draws);

        let land: Land;
        if (distRiver < riverHalf) {
          land = Land.River;
        } else if (slope > 1.5) {
          land = Land.Cliff;
        } else if (slope > 1.15 && e > this.minElev + (this.maxElev - this.minElev) * 0.6) {
          land = Land.Rock;
        } else if (slope > 0.95) {
          // steep loose ground; the odd boulder field for cover
          land = patchNoise.fbm(x * fPatch, y * fPatch, 2) > 0.6 ? Land.Boulders : Land.Scree;
        } else {
          const moist =
            vegNoise.fbm(x * fVeg, y * fVeg, 4) * 0.5 +
            0.5 +
            drawProx * 0.35 +
            (1 - y / size) * 0.1;
          const band = clamp01(aboveFloor / 850);
          const wet = distRiver < riverHalf + 3 && aboveFloor < 30 && slope < 0.22;
          if (wet && moist > 0.5) {
            land = Land.Marsh;
          } else if (drawProx > 0.62 && slope < 0.5) {
            land = Land.DryWash; // re-entrant bottom — a covered approach
          } else if (aboveFloor < 60 && slope < 0.26 && distRiver < size * 0.18) {
            land = moist > 0.5 ? Land.Cropland : Land.Grass;
          } else if (slope > 0.22 && slope < 0.6 && band < 0.55 && moist > 0.45) {
            land = Land.Terrace; // terraced hillside cropping
          } else if (band < 0.32) {
            land = moist > 0.62 ? Land.Forest : Land.Scrub;
          } else if (band < 0.72) {
            land = moist > 0.5 ? Land.Forest : Land.Scrub;
          } else {
            land = moist > 0.7 ? Land.Forest : slope > 0.5 ? Land.Scree : Land.Meadow;
          }
        }
        this.land[i] = land;
      }
    }

    // Terrace risers: cells on terraced slopes whose downhill drop is sharp read
    // as stone retaining walls — contour-parallel linear hard cover.
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = this.idx(x, y);
        if (this.land[i] !== Land.Terrace) continue;
        const e = this.elev[i];
        let drop = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          drop = Math.max(drop, e - this.elev[this.idx(x + dx, y + dy)]);
        }
        if (drop > cellSize * 0.5 && rng.chance(0.6)) this.land[i] = Land.TerraceWall;
      }
    }
  }

  private drawProximity(
    x: number,
    y: number,
    draws: { y: number; side: number; width: number }[]
  ): number {
    let best = 0;
    const cx = this.centerX[Math.round(y)] ?? this.size / 2;
    for (const d of draws) {
      if (Math.sign(x - cx) !== d.side) continue;
      const dyc = Math.abs(y - d.y);
      best = Math.max(best, smoothstep(d.width * 2, 0, dyc));
    }
    return best;
  }

  floorElevAtRow(y: number): number {
    const ty = clamp01(y / (this.size - 1));
    return lerp(this.config.floorSouth, this.config.floorNorth, ty);
  }

  /** Valley-floor centerline x (cells) at a given row — the river's track. */
  centerXAt(y: number): number {
    return this.centerX[clamp(Math.round(y), 0, this.size - 1)] ?? this.size / 2;
  }

  private placeVillagesAndCOP(rng: RNG) {
    const { size } = this;
    const NAMES = [
      "Aliabad",
      "Babiyal",
      "Darbart",
      "Kandlay",
      "Loy Kalay",
      "Yaka China",
      "Donga",
      "Marastanau",
      "Chichal",
      "Korangal",
      "Landigal",
    ];
    const chosen = rng.shuffle(NAMES);
    const count = rng.int(4, 6);
    const placed: Village[] = [];
    let attempts = 0;
    const minSpacing = size * 0.13;
    while (placed.length < count && attempts < 600) {
      attempts++;
      const y = rng.int(size * 0.12, size * 0.9);
      const cx = this.centerX[y];
      const side = rng.chance(0.5) ? -1 : 1;
      const off = rng.range(size * 0.045, size * 0.15) * side;
      const x = Math.round(cx + off);
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.slope[i] > 0.5) continue; // need a bench, not a cliff
      if (this.land[i] === Land.River || this.land[i] === Land.Rock || this.land[i] === Land.Cliff) continue;
      if (placed.some((p) => Math.hypot(p.cx - x, p.cy - y) < minSpacing)) continue;
      const sizeR = rng.int(4, 8); // qalats cover more cells at 5 m
      placed.push({
        id: `vil-${placed.length}`,
        name: chosen[placed.length % chosen.length],
        cx: x,
        cy: y,
        size: sizeR,
        population: rng.int(40, 320),
      });
    }
    this.villages = placed;
    // Stamp village landcover: walled compounds, perimeter walls, surrounding
    // orchards/terraces, and the occasional walled cemetery on the edge.
    for (const vil of placed) {
      const cem = {
        x: vil.cx + rng.int(-vil.size - 2, vil.size + 2),
        y: vil.cy + rng.int(-vil.size - 2, vil.size + 2),
        r: rng.int(1, 2),
      };
      for (let dy = -vil.size - 4; dy <= vil.size + 4; dy++) {
        for (let dx = -vil.size - 4; dx <= vil.size + 4; dx++) {
          const x = vil.cx + dx;
          const y = vil.cy + dy;
          if (!this.inBounds(x, y)) continue;
          const d = Math.hypot(dx, dy);
          const i = this.idx(x, y);
          if (this.land[i] === Land.River || this.slope[i] > 0.7) continue;
          if (d <= vil.size) {
            // compound interior with a walled perimeter ring
            this.land[i] = d > vil.size - 1.1 ? Land.CompoundWall : Land.Compound;
            // interior courtyards / alleys
            if (this.land[i] === Land.Compound && rng.chance(0.22)) this.land[i] = Land.Grass;
          } else if (d <= vil.size + 4 && this.slope[i] < 0.35) {
            this.land[i] = rng.chance(0.55) ? Land.Orchard : Land.Terrace;
          }
        }
      }
      // cemetery
      for (let dy = -cem.r; dy <= cem.r; dy++)
        for (let dx = -cem.r; dx <= cem.r; dx++) {
          const x = cem.x + dx;
          const y = cem.y + dy;
          if (!this.inBounds(x, y)) continue;
          const i = this.idx(x, y);
          if (this.land[i] === Land.Orchard || this.land[i] === Land.Terrace || this.land[i] === Land.Grass)
            this.land[i] = Land.Cemetery;
        }
    }

    // COP: defensible knob on a spur with observation, near (but above) a village,
    // toward the south so the valley extends north into "Indian country".
    let best: { cx: number; cy: number; score: number } | null = null;
    for (let tries = 0; tries < 1600; tries++) {
      const y = rng.int(size * 0.55, size * 0.85);
      const cx = this.centerX[y];
      const side = rng.chance(0.5) ? -1 : 1;
      const x = Math.round(cx + rng.range(size * 0.06, size * 0.17) * side);
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.slope[i] > 0.35) continue;
      if (this.land[i] === Land.River || this.land[i] === Land.Compound || this.land[i] === Land.CompoundWall) continue;
      const prom = this.localProminence(x, y, 8);
      const aboveFloor = this.elev[i] - this.floorElevAtRow(y);
      const score = prom * 2 + clamp(aboveFloor, 0, 300) * 0.01 - this.slope[i] * 2;
      if (!best || score > best.score) best = { cx: x, cy: y, score };
    }
    this.copCell = best ? { cx: best.cx, cy: best.cy } : { cx: Math.round(size / 2), cy: Math.round(size * 0.7) };
    // Flatten COP footprint a touch and mark it.
    const c = this.copCell;
    const baseE = this.elev[this.idx(c.cx, c.cy)];
    const fr = Math.round(18 / this.cellSize);
    for (let dy = -fr; dy <= fr; dy++)
      for (let dx = -fr; dx <= fr; dx++) {
        const x = c.cx + dx;
        const y = c.cy + dy;
        if (!this.inBounds(x, y)) continue;
        if (Math.hypot(dx, dy) > fr) continue;
        const i = this.idx(x, y);
        this.elev[i] = lerp(this.elev[i], baseE, 0.6);
        this.land[i] = Land.Grass;
      }
    this.computeSlopeLocal(c.cx, c.cy, fr + 1);
  }

  private localProminence(cx: number, cy: number, r: number): number {
    const e = this.elev[this.idx(cx, cy)];
    let lower = 0;
    let total = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.inBounds(x, y) || (dx === 0 && dy === 0)) continue;
        total++;
        if (this.elev[this.idx(x, y)] < e) lower++;
      }
    return total ? lower / total : 0;
  }

  private computeSlopeLocal(cx: number, cy: number, r: number) {
    const { size, cellSize } = this;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.inBounds(x, y)) continue;
        const e = this.elev[this.idx(x, y)];
        const ex = this.elev[this.idx(Math.min(size - 1, x + 1), y)];
        const ey = this.elev[this.idx(x, Math.min(size - 1, y + 1))];
        this.slope[this.idx(x, y)] = Math.hypot((ex - e) / cellSize, (ey - e) / cellSize);
      }
  }

  /** Lay a rough road down the valley floor and goat trails up to villages/draws. */
  private carveRoadsAndTrails(rng: RNG) {
    const { size } = this;
    const off = Math.round(10 / this.cellSize);
    const halfW = Math.max(1, Math.round(4 / this.cellSize));
    // Valley-floor road just off the river.
    for (let y = 0; y < size; y++) {
      const cx = Math.round(this.centerX[y]) + (rng.chance(0.5) ? off : -off);
      for (let w = -halfW; w <= halfW; w++) {
        const x = cx + w;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        if (this.land[i] !== Land.River && this.slope[i] < 0.6 && this.land[i] !== Land.CompoundWall)
          this.land[i] = Land.Road;
      }
    }
    // Trails: connect each village down to the road and a spur up the hill.
    for (const vil of this.villages) {
      const targetY = vil.cy;
      const roadX = Math.round(this.centerX[targetY]);
      this.stampTrail(vil.cx, vil.cy, roadX, targetY);
      const upX = vil.cx + (vil.cx > roadX ? 1 : -1) * Math.round(size * 0.08);
      const upY = vil.cy + rng.int(-8, 8);
      this.stampTrail(vil.cx, vil.cy, clamp(upX, 0, size - 1), clamp(upY, 0, size - 1));
    }
    // COP access trail down to the road.
    this.stampTrail(this.copCell.cx, this.copCell.cy, Math.round(this.centerX[this.copCell.cy]), this.copCell.cy);
  }

  private stampTrail(x0: number, y0: number, x1: number, y1: number) {
    const steps = (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1) * 2;
    let bridged = false;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(lerp(x0, x1, t));
      const y = Math.round(lerp(y0, y1, t));
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.land[i] === Land.River) {
        // a footbridge where a trail crosses the channel
        if (!bridged) {
          this.land[i] = Land.Footbridge;
          bridged = true;
        }
        continue;
      }
      if (this.land[i] === Land.Road || this.land[i] === Land.Compound || this.land[i] === Land.CompoundWall) continue;
      this.land[i] = Land.Trail;
    }
  }

  /** Per-cell cover (stops rounds) and concealment (blocks sight) from landcover. */
  private deriveCoverConcealment() {
    for (let i = 0; i < this.land.length; i++) {
      const [cover, conceal] = COVER_CONCEAL[this.land[i] as Land] ?? [0.05, 0.05];
      this.cover[i] = cover;
      this.conceal[i] = conceal;
    }
  }

  private nameFeatures(rng: RNG) {
    const { size } = this;
    const peakNames = ["Hill 2610", "Sawtalo Sar", "Abas Ghar", "Gatigal Spur", "Divpalu Ridge", "Hill 2310", "Sautalo"];
    const candidates: { x: number; y: number; e: number }[] = [];
    const stepY = Math.max(4, Math.round(size / 26));
    for (let y = 4; y < size - 4; y += stepY) {
      for (const side of [-1, 1] as const) {
        let bx = -1;
        let be = -Infinity;
        const cx = this.centerX[y];
        for (let x = 4; x < size - 4; x++) {
          if (Math.sign(x - cx) !== side) continue;
          const e = this.elev[this.idx(x, y)];
          if (e > be) {
            be = e;
            bx = x;
          }
        }
        if (bx >= 0) candidates.push({ x: bx, y, e: be });
      }
    }
    candidates.sort((a, b) => b.e - a.e);
    const used: { x: number; y: number }[] = [];
    let n = 0;
    for (const c of candidates) {
      if (n >= peakNames.length) break;
      if (used.some((u) => Math.hypot(u.x - c.x, u.y - c.y) < size * 0.18)) continue;
      used.push(c);
      this.features.push({
        name: peakNames[n],
        cx: c.x,
        cy: c.y,
        kind: "peak",
        elevation: Math.round(c.e),
      });
      n++;
    }
  }

  // ---------------------------------------------------------------------------
  //  Queries (world coordinates in meters)
  // ---------------------------------------------------------------------------

  /** Bilinearly interpolated elevation (meters) at world point. */
  elevAt(wx: number, wy: number): number {
    const gx = clamp(wx / this.cellSize, 0, this.size - 1.001);
    const gy = clamp(wy / this.cellSize, 0, this.size - 1.001);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const e00 = this.elev[this.idx(x0, y0)];
    const e10 = this.elev[this.idx(x0 + 1, y0)];
    const e01 = this.elev[this.idx(x0, y0 + 1)];
    const e11 = this.elev[this.idx(x0 + 1, y0 + 1)];
    return lerp(lerp(e00, e10, fx), lerp(e01, e11, fx), fy);
  }

  private cellSample<T extends Float32Array | Uint8Array>(arr: T, wx: number, wy: number): number {
    const cx = clamp(Math.floor(wx / this.cellSize), 0, this.size - 1);
    const cy = clamp(Math.floor(wy / this.cellSize), 0, this.size - 1);
    return arr[this.idx(cx, cy)];
  }

  landAt(wx: number, wy: number): Land {
    return this.cellSample(this.land, wx, wy) as Land;
  }
  coverAt(wx: number, wy: number): number {
    return this.cellSample(this.cover, wx, wy);
  }
  concealAt(wx: number, wy: number): number {
    return this.cellSample(this.conceal, wx, wy);
  }
  slopeAt(wx: number, wy: number): number {
    return this.cellSample(this.slope, wx, wy);
  }

  /** Is this cell passable on foot at all (cliffs/deep channels are not). */
  passableCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const l = this.land[this.idx(cx, cy)] as Land;
    if (l === Land.Cliff) return false;
    if (l === Land.CompoundWall) return false;
    if (this.slope[this.idx(cx, cy)] > 1.25) return false;
    return true;
  }

  /** Movement speed multiplier (1 = open flat road pace; lower = harder). */
  moveCostAt(wx: number, wy: number): number {
    const land = this.landAt(wx, wy);
    const slope = this.slopeAt(wx, wy);
    const m = LAND_MOVE[land] ?? 0.6;
    // Slope penalty (steep ground is brutal in the Korengal).
    return clamp(m * clamp01(1 - slope * 0.62), 0.1, 1);
  }

  /** Cell center in world meters. */
  cellCenter(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * this.cellSize, y: (cy + 0.5) * this.cellSize };
  }

  worldOf(cx: number, cy: number): Vec2 {
    return this.cellCenter(cx, cy);
  }
}

/** [hard cover 0..1, concealment 0..1] per landcover class. */
const COVER_CONCEAL: Record<Land, [number, number]> = {
  [Land.River]: [0.1, 0.05],
  [Land.Marsh]: [0.12, 0.2],
  [Land.DryWash]: [0.42, 0.25], // sunken banks = good defilade
  [Land.Cropland]: [0.18, 0.32],
  [Land.Terrace]: [0.22, 0.3],
  [Land.TerraceWall]: [0.62, 0.4], // stone riser — real cover
  [Land.Orchard]: [0.18, 0.6],
  [Land.Meadow]: [0.06, 0.14],
  [Land.Grass]: [0.05, 0.12],
  [Land.Scrub]: [0.12, 0.5],
  [Land.Forest]: [0.22, 0.82],
  [Land.Scree]: [0.3, 0.12],
  [Land.Boulders]: [0.66, 0.3], // boulders stop rounds
  [Land.Rock]: [0.6, 0.15],
  [Land.Cliff]: [0.7, 0.2],
  [Land.Compound]: [0.7, 0.65],
  [Land.CompoundWall]: [0.86, 0.78], // mud walls — the best cover in the valley
  [Land.Cemetery]: [0.5, 0.35],
  [Land.Road]: [0.04, 0.06],
  [Land.Trail]: [0.05, 0.08],
  [Land.Footbridge]: [0.08, 0.05],
};

/** Base movement multiplier per landcover (before slope). */
const LAND_MOVE: Record<Land, number> = {
  [Land.River]: 0.3,
  [Land.Marsh]: 0.45,
  [Land.DryWash]: 0.72,
  [Land.Cropland]: 0.74,
  [Land.Terrace]: 0.6,
  [Land.TerraceWall]: 0.4,
  [Land.Orchard]: 0.62,
  [Land.Meadow]: 0.82,
  [Land.Grass]: 0.8,
  [Land.Scrub]: 0.5,
  [Land.Forest]: 0.5,
  [Land.Scree]: 0.42,
  [Land.Boulders]: 0.34,
  [Land.Rock]: 0.3,
  [Land.Cliff]: 0.12,
  [Land.Compound]: 0.62,
  [Land.CompoundWall]: 0.2,
  [Land.Cemetery]: 0.5,
  [Land.Road]: 1,
  [Land.Trail]: 0.92,
  [Land.Footbridge]: 0.85,
};
