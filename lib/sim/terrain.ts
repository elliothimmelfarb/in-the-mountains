import { RNG, ValueNoise, clamp, clamp01, smoothstep, lerp } from "./rng";
import { Vec2 } from "./vec";

/** Landcover classes. Drive cover (stops bullets), concealment (blocks sight),
 *  movement cost, and rendering tint. */
export enum Land {
  River = 0,
  FloorField = 1, // terraced cropland on the valley floor / lower benches
  Orchard = 2, // walnut/mulberry orchards near villages — concealment + some cover
  Grass = 3, // open grass / pasture
  Scrub = 4, // holly-oak scrub, the choking Korengal brush
  Forest = 5, // cedar / oak forest on mid-upper slopes
  Scree = 6, // loose rock, steep
  Rock = 7, // bare rock, cliffs, crests
  Village = 8, // qalats (mud-walled compounds) — hard cover + concealment
  Road = 9, // the rough valley road / MSR
  Trail = 10, // foot/goat trails
}

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
  size: 160,
  cellSize: 20,
  seed: "korengal",
  floorSouth: 1550,
  floorNorth: 2050,
  ridgeHeight: 950,
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

  private generate() {
    const rng = new RNG(this.config.seed);
    const noise = new ValueNoise(rng.int(1, 1e9));
    const ridgeNoise = new ValueNoise(rng.int(1, 1e9));
    const detailNoise = new ValueNoise(rng.int(1, 1e9));
    const { size } = this;
    const { floorSouth, floorNorth, ridgeHeight } = this.config;

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
    const draws = Array.from({ length: rng.int(4, 6) }, () => ({
      y: rng.range(0.12, 0.88) * size,
      side: rng.chance(0.5) ? -1 : 1,
      width: rng.range(0.05, 0.1) * size,
      depth: rng.range(0.35, 0.6), // fraction of ridge height carved out
      reach: rng.range(0.45, 0.85), // how far up the slope it reaches
    }));

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
          ridgeNoise.fbm(x * 0.035, y * 0.035, 5) * ridgeHeight * 0.32 +
          ridgeNoise.fbm(x * 0.09, y * 0.09, 3) * ridgeHeight * 0.13;
        h += ridgeMod * smoothstep(0.15, 0.8, ndx);

        // Spurs/fingers and draws perpendicular to the valley (medium-scale).
        const finger = detailNoise.fbm(x * 0.06, y * 0.018, 4);
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
        const riverCut = smoothstep(2.4, 0, Math.abs(dxCells)) * 22;

        let e = floor + Math.max(0, h) - riverCut;
        // Fine surface roughness.
        e += detailNoise.fbm(x * 0.22, y * 0.22, 3) * 12;

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
    const { size } = this;
    const vegNoise = new ValueNoise(rng.int(1, 1e9));
    for (let y = 0; y < size; y++) {
      const cx = this.centerX[y];
      for (let x = 0; x < size; x++) {
        const i = this.idx(x, y);
        const slope = this.slope[i];
        const e = this.elev[i];
        const distRiver = Math.abs(x - cx);
        const aboveFloor = e - this.floorElevAtRow(y);

        let land: Land;
        if (distRiver < 1.4) {
          land = Land.River;
        } else if (slope > 0.95 && e > this.minElev + (this.maxElev - this.minElev) * 0.7) {
          land = Land.Rock;
        } else if (slope > 0.8) {
          land = Land.Scree;
        } else {
          // Vegetation by altitude band + moisture (draws & north are wetter).
          const moist =
            vegNoise.fbm(x * 0.05, y * 0.05, 4) * 0.5 +
            0.5 +
            this.drawProximity(x, y, draws) * 0.35 +
            (1 - y / size) * 0.1;
          const band = clamp01(aboveFloor / 850);
          if (aboveFloor < 70 && slope < 0.28 && distRiver < size * 0.16) {
            land = moist > 0.55 ? Land.FloorField : Land.Grass;
          } else if (band < 0.32) {
            land = moist > 0.62 ? Land.Forest : Land.Scrub;
          } else if (band < 0.72) {
            land = moist > 0.5 ? Land.Forest : Land.Scrub;
          } else {
            land = moist > 0.7 ? Land.Forest : slope > 0.55 ? Land.Scree : Land.Grass;
          }
        }
        this.land[i] = land;
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
    ];
    const chosen = rng.shuffle(NAMES);
    const count = rng.int(4, 6);
    const placed: Village[] = [];
    let attempts = 0;
    while (placed.length < count && attempts < 400) {
      attempts++;
      const y = rng.int(size * 0.12, size * 0.9);
      const cx = this.centerX[y];
      const side = rng.chance(0.5) ? -1 : 1;
      const off = rng.range(size * 0.04, size * 0.14) * side;
      const x = Math.round(cx + off);
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.slope[i] > 0.5) continue; // need a bench, not a cliff
      if (this.land[i] === Land.River || this.land[i] === Land.Rock) continue;
      // spacing
      if (placed.some((p) => Math.hypot(p.cx - x, p.cy - y) < size * 0.12)) continue;
      const sizeR = rng.int(3, 5);
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
    // Stamp village landcover (qalats) and surrounding orchards/fields.
    for (const vil of placed) {
      for (let dy = -vil.size - 2; dy <= vil.size + 2; dy++) {
        for (let dx = -vil.size - 2; dx <= vil.size + 2; dx++) {
          const x = vil.cx + dx;
          const y = vil.cy + dy;
          if (!this.inBounds(x, y)) continue;
          const d = Math.hypot(dx, dy);
          const i = this.idx(x, y);
          if (this.land[i] === Land.River) continue;
          if (d <= vil.size && this.slope[i] < 0.6) this.land[i] = Land.Village;
          else if (d <= vil.size + 2 && this.slope[i] < 0.35)
            this.land[i] = rng.chance(0.6) ? Land.Orchard : Land.FloorField;
        }
      }
    }

    // COP: defensible knob on a spur with observation, near (but above) a village,
    // toward the south so the valley extends north into "Indian country".
    let best: { cx: number; cy: number; score: number } | null = null;
    for (let tries = 0; tries < 1200; tries++) {
      const y = rng.int(size * 0.55, size * 0.85);
      const cx = this.centerX[y];
      const side = rng.chance(0.5) ? -1 : 1;
      const x = Math.round(cx + rng.range(size * 0.05, size * 0.16) * side);
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.slope[i] > 0.35) continue;
      if (this.land[i] === Land.River || this.land[i] === Land.Village) continue;
      // Score: some local prominence (can see around) but not a summit.
      const prom = this.localProminence(x, y, 4);
      const aboveFloor = this.elev[i] - this.floorElevAtRow(y);
      const score = prom * 2 + clamp(aboveFloor, 0, 300) * 0.01 - this.slope[i] * 2;
      if (!best || score > best.score) best = { cx: x, cy: y, score };
    }
    this.copCell = best ? { cx: best.cx, cy: best.cy } : { cx: Math.round(size / 2), cy: Math.round(size * 0.7) };
    // Flatten COP footprint a touch and mark it.
    const c = this.copCell;
    const baseE = this.elev[this.idx(c.cx, c.cy)];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = c.cx + dx;
        const y = c.cy + dy;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        this.elev[i] = lerp(this.elev[i], baseE, 0.6);
        this.land[i] = Land.Grass;
      }
    this.computeSlopeLocal(c.cx, c.cy, 3);
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
    // Valley-floor road just off the river.
    for (let y = 0; y < size; y++) {
      const cx = Math.round(this.centerX[y]) + (rng.chance(0.5) ? 2 : -2);
      for (let w = -1; w <= 1; w++) {
        const x = cx + w;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        if (this.land[i] !== Land.River && this.slope[i] < 0.6) this.land[i] = Land.Road;
      }
    }
    // Trails: connect each village down to the road and a spur up the hill.
    for (const vil of this.villages) {
      const targetY = vil.cy;
      const roadX = Math.round(this.centerX[targetY]);
      this.stampTrail(vil.cx, vil.cy, roadX, targetY);
      // up-trail toward higher ground
      const upX = vil.cx + (vil.cx > roadX ? 1 : -1) * Math.round(size * 0.08);
      const upY = vil.cy + rng.int(-4, 4);
      this.stampTrail(vil.cx, vil.cy, clamp(upX, 0, size - 1), clamp(upY, 0, size - 1));
    }
    // COP access trail down to the road.
    this.stampTrail(this.copCell.cx, this.copCell.cy, Math.round(this.centerX[this.copCell.cy]), this.copCell.cy);
  }

  private stampTrail(x0: number, y0: number, x1: number, y1: number) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(lerp(x0, x1, t));
      const y = Math.round(lerp(y0, y1, t));
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.land[i] === Land.River || this.land[i] === Land.Road || this.land[i] === Land.Village) continue;
      this.land[i] = Land.Trail;
    }
  }

  /** Per-cell cover (stops rounds) and concealment (blocks sight) from landcover. */
  private deriveCoverConcealment() {
    for (let i = 0; i < this.land.length; i++) {
      const l = this.land[i] as Land;
      let cover = 0;
      let conceal = 0;
      switch (l) {
        case Land.Village:
          cover = 0.78;
          conceal = 0.7;
          break;
        case Land.Rock:
          cover = 0.6;
          conceal = 0.15;
          break;
        case Land.Scree:
          cover = 0.32;
          conceal = 0.12;
          break;
        case Land.Forest:
          cover = 0.22;
          conceal = 0.82;
          break;
        case Land.Orchard:
          cover = 0.18;
          conceal = 0.6;
          break;
        case Land.Scrub:
          cover = 0.12;
          conceal = 0.5;
          break;
        case Land.FloorField:
          cover = 0.2; // terrace walls
          conceal = 0.35;
          break;
        case Land.Grass:
          cover = 0.05;
          conceal = 0.12;
          break;
        case Land.River:
          cover = 0.1;
          conceal = 0.05;
          break;
        default:
          cover = 0.05;
          conceal = 0.05;
      }
      this.cover[i] = cover;
      this.conceal[i] = conceal;
    }
  }

  private nameFeatures(rng: RNG) {
    const { size } = this;
    // Find a few prominent peaks along the crests.
    const peakNames = ["Hill 2610", "Sawtalo Sar", "Abas Ghar", "Gatigal Spur", "Divpalu Ridge", "Hill 2310"];
    const candidates: { x: number; y: number; e: number }[] = [];
    for (let y = 4; y < size - 4; y += 6) {
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

  /** Movement speed multiplier (1 = open flat road pace; lower = harder). */
  moveCostAt(wx: number, wy: number): number {
    const land = this.landAt(wx, wy);
    const slope = this.slopeAt(wx, wy);
    let m = 1;
    switch (land) {
      case Land.Road:
        m = 1;
        break;
      case Land.Trail:
        m = 0.9;
        break;
      case Land.Grass:
      case Land.FloorField:
        m = 0.78;
        break;
      case Land.Scrub:
        m = 0.5;
        break;
      case Land.Orchard:
        m = 0.62;
        break;
      case Land.Forest:
        m = 0.5;
        break;
      case Land.Scree:
        m = 0.42;
        break;
      case Land.Rock:
        m = 0.3;
        break;
      case Land.Village:
        m = 0.7;
        break;
      case Land.River:
        m = 0.35;
        break;
    }
    // Slope penalty (steep ground is brutal in the Korengal).
    m *= clamp01(1 - slope * 0.62);
    return clamp(m, 0.12, 1);
  }

  /** Cell center in world meters. */
  cellCenter(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * this.cellSize, y: (cy + 0.5) * this.cellSize };
  }

  worldOf(cx: number, cy: number): Vec2 {
    return this.cellCenter(cx, cy);
  }
}
