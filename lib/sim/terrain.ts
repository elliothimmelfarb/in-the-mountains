import { RNG, ValueNoise, clamp, clamp01, smoothstep, lerp } from "./rng";
import { Vec2, fromAngle, angle, angleDiff, norm, dot } from "./vec";
// NB: path.ts imports Land/COARSE_F from this file, but only INSIDE functions, so this
// terrain → path → terrain cycle resolves at load time. findPath is used at generation time
// (carveRoadsAndTrails) to route the village road network over the real terrain.
import { findPath } from "./path";

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
  Road = 18, // graded road / MSR — the valley-floor main supply route
  Trail = 19, // foot / goat trail — unimproved footpath up the draws
  Footbridge = 20, // crossing over the river / a wash
  Hesco = 21, // HESCO bastion / sandbag barrier — the COP's perimeter wall
  Structure = 22, // a built structure (b-hut, TOC, conex) — enterable, blocks sight
  Gravel = 23, // graded gravel pad — motor pool / LZ / interior yard
  Track = 24, // graded secondary dirt track — village↔MSR & village↔village (Tier-2)
}

export const LAND_COUNT = 25;

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

/** Kinds of structure inside the wire. */
export type CopBuildingKind =
  | "barracks"
  | "toc"
  | "dfac"
  | "armory"
  | "aid"
  | "motorpool"
  | "latrine"
  | "tower";

export interface CopBuilding {
  kind: CopBuildingKind;
  /** Footprint center (cells) and half-extents (cells). */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  label: string;
}

export interface CopFightingPosition {
  id: string;
  cx: number;
  cy: number;
  facing: number; // radians, outward
  tower: boolean;
}

/**
 * The physical layout of the combat outpost: a HESCO-walled perimeter with a
 * single entry-control point (gate), interior structures (barracks, TOC, aid
 * station, armory, chow hall, motor pool), a helicopter LZ, and crew-served
 * fighting positions on the wall. Generated from the seed so it rebuilds on load.
 */
export interface CopLayout {
  center: { cx: number; cy: number };
  radius: number; // perimeter radius (cells)
  gate: { cx: number; cy: number }; // gate cell on the wall
  gateInside: { cx: number; cy: number }; // just inside the wire
  gateOutside: { cx: number; cy: number }; // staging point outside the gate
  gateDir: Vec2; // outward unit vector through the gate
  muster: { cx: number; cy: number }; // the yard / formation area
  lz: { cx: number; cy: number }; // helicopter landing zone
  buildings: CopBuilding[];
  fightingPositions: CopFightingPosition[];
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
 * Coarse pathfinding factor: a coarse A* node spans COARSE_F × COARSE_F fine cells
 * (15 m at 5 m resolution). Shared with path.ts (the coarse pass + its corridor stamping)
 * so the two files can never drift apart on the value.
 */
export const COARSE_F = 3;
/** The 8 coarse-grid neighbor offsets, in a fixed canonical order (used by the coarse A*). */
export const COARSE_DIR8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

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
  cop!: CopLayout;
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
    this.ensureGatePortal(); // issue 005: guarantee the gate connects at coarse scale (locally)
    this.ensureNetworkConnectivity(); // issue 008: guarantee the gate connects to the MSR + villages
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

    // COP: a defensible bench/low spur near the valley, with observation over the
    // road and a village — sited like the real Korengal Outpost (commanding ground
    // a short, switchbacked road off the valley floor), NOT an alpine perch. Toward
    // the south so the valley extends north into "Indian country". The scoring
    // rewards local prominence (commanding terrain) and a MODERATE rise above the
    // floor — high enough to overwatch, low and close enough that the outpost can
    // actually be resupplied by road — while penalizing steep ground and distance.
    // The perimeter radius the COP will use (kept in sync with buildCop) so siting
    // can evaluate the actual apron the wire and its ring-road will occupy.
    const R0 = clamp(Math.round(85 / this.cellSize), 12, 20);
    // HARD COP↔village footprint separation (item 1 / movement RC#3): the outpost
    // footprint is the wire radius R0 plus a clearance band (ring road + apron); a
    // village footprint is its compound radius v.size (+ cemetery a touch beyond). If
    // those overlap, buildCop bulldozes the qalat and the gate opens into the village —
    // a "village intersects the COP" generation, and a sealed-pocket cause of stranded
    // patrols. Require this many CELLS of clear ground between the wire and any compound.
    const SEP_MARGIN = 8; // cells (~40 m) — guarantees no village-core cell in the COP clearance
    let best: { cx: number; cy: number; score: number } | null = null;
    // Largest-gap site seen even if every candidate is close — so siting never fails outright.
    let fallback: { cx: number; cy: number; gap: number } | null = null;
    for (let tries = 0; tries < 1600; tries++) {
      const y = rng.int(size * 0.55, size * 0.85);
      const cx = this.centerX[y];
      const side = rng.chance(0.5) ? -1 : 1;
      const x = Math.round(cx + rng.range(size * 0.035, size * 0.12) * side);
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.slope[i] > 0.35) continue;
      if (this.land[i] === Land.River || this.land[i] === Land.Compound || this.land[i] === Land.CompoundWall) continue;
      const prom = this.localProminence(x, y, 8);
      const aboveFloor = this.elev[i] - this.floorElevAtRow(y);
      // Height band: best around a 25–95 m bench; too low is exposed, too high is an
      // unsupportable perch and gets penalized back down.
      const heightScore =
        aboveFloor < 12 ? (aboveFloor / 12) * 0.5 : aboveFloor <= 95 ? 1 : clamp01(1 - (aboveFloor - 95) / 110);
      // Logistics: commanding the valley means staying near the road, not a ridgeline.
      const distM = Math.abs(x - cx) * this.cellSize;
      const distScore = clamp01(1 - Math.max(0, distM - 90) / 320);
      // Overwatch the AO (issue 002): a real outpost is sited a tactical bound from the
      // villages it patrols — close enough to put boots there and observe, not sitting
      // in the bazaar. Reward a ~110–460 m standoff to the NEAREST village; penalize
      // being right on top of one or too far to support it.
      let nearVilM = Infinity;
      let minGapCells = placed.length ? Infinity : 999;
      for (const v of placed) {
        const dCells = Math.hypot(v.cx - x, v.cy - y);
        nearVilM = Math.min(nearVilM, dCells * this.cellSize);
        minGapCells = Math.min(minGapCells, dCells - R0 - v.size); // wire-edge → compound-edge gap
      }
      // Track the roomiest site regardless, then HARD-reject any site whose footprint+
      // clearance overlaps a village. A non-overlapping site always wins when one exists.
      if (!fallback || minGapCells > fallback.gap) fallback = { cx: x, cy: y, gap: minGapCells };
      if (minGapCells < SEP_MARGIN) continue;
      const aoScore =
        nearVilM < 90 ? Math.max(0, nearVilM / 90 - 0.2) : nearVilM <= 460 ? 1 : clamp01(1 - (nearVilM - 460) / 520);
      // Well-shaped bench (issue 001): most bearings around the wire have a passable,
      // gentle apron, so the perimeter ring-road is continuous and a clean gate exists.
      const bench = this.perimeterBenchFrac(x, y, R0);
      const score =
        prom * 1.5 + heightScore * 1.6 + distScore + aoScore * 1.4 + bench * 1.4 - this.slope[i] * 2;
      if (!best || score > best.score) best = { cx: x, cy: y, score };
    }
    // Prefer a well-scored, well-separated site; else the roomiest site found; else center.
    this.copCell = best
      ? { cx: best.cx, cy: best.cy }
      : fallback
        ? { cx: fallback.cx, cy: fallback.cy }
        : { cx: Math.round(size / 2), cy: Math.round(size * 0.7) };
    this.buildCop(rng);
  }

  /**
   * Lay out the combat outpost as a real fortified position: bench it flat,
   * ring it in HESCO with a single entry-control point, drop the interior
   * structures (TOC, barracks, aid station, armory, chow hall, motor pool),
   * grade a helicopter LZ, and site crew-served fighting positions and towers
   * around the wall. Stamped into the landcover so cover, sight and pathing all
   * respect the wire.
   */
  private buildCop(rng: RNG) {
    const c = this.copCell;
    const R = clamp(Math.round(85 / this.cellSize), 12, 20); // ~85 m perimeter radius
    const baseE = this.elev[this.idx(c.cx, c.cy)];

    // Gate direction: SCORE all 8 compass headings instead of blindly facing the
    // road (issues 001 + 002). A gate MUST open onto passable, gentle ground — never
    // a cliff face (001) — SHOULD look out over the villages the COP patrols (002),
    // and otherwise tends toward the valley road for vehicle access/logistics. The
    // apron is evaluated on the raw ground here (nothing is stamped yet).
    const roadX = this.centerXAt(c.cy);
    const toRoad = norm({ x: roadX - c.cx, y: 1 }); // downhill toward the valley road
    // Face the AO: the bearing to the NEAREST village dominates (that's the ground
    // patrolled daily and the worst case for a "march all the way around" gate),
    // softly blended with the wider village centroid so a cluster still pulls it.
    const nv = this.nearestVillageCell(c.cx, c.cy);
    const vc = this.villageCentroidNear(c.cx, c.cy);
    const toNear = nv ? norm({ x: nv.cx - c.cx, y: nv.cy - c.cy }) : toRoad;
    const toCentroid = vc ? norm({ x: vc.x - c.cx, y: vc.y - c.cy }) : toRoad;
    const toAO = norm({ x: toNear.x * 0.7 + toCentroid.x * 0.3, y: toNear.y * 0.7 + toCentroid.y * 0.3 });
    let ga = 0;
    let gateDir: Vec2 = toRoad;
    let bestGate = -Infinity;
    for (let k = 0; k < 8; k++) {
      const a = k * (Math.PI / 4);
      const d = fromAngle(a);
      // Apron: how much of a 3-wide corridor from the wall out to R+7 along d is
      // passable, gentle ground. This is the hard requirement — a gate facing broken
      // ground scores ~0 and can never win.
      let openCells = 0;
      let tot = 0;
      for (let b = 1; b <= 7; b++)
        for (let o = -1; o <= 1; o++) {
          const px = Math.round(c.cx + d.x * (R + b) + -d.y * o);
          const py = Math.round(c.cy + d.y * (R + b) + d.x * o);
          if (!this.inBounds(px, py)) continue;
          tot++;
          const l = this.land[this.idx(px, py)] as Land;
          if (l !== Land.River && l !== Land.Cliff && l !== Land.CompoundWall && this.slope[this.idx(px, py)] < 0.9)
            openCells++;
        }
      const apron = tot > 0 ? openCells / tot : 0;
      const aoAlign = (dot(d, toAO) + 1) / 2; // 0..1, 1 = straight at the AO
      const roadAlign = (dot(d, toRoad) + 1) / 2;
      const score = apron * (0.35 + 1.55 * aoAlign + 0.35 * roadAlign);
      if (score > bestGate) {
        bestGate = score;
        ga = a;
        gateDir = d;
      }
    }
    const perp = { x: -gateDir.y, y: gateDir.x };

    // 1) Bench the footprint flat and lay gravel/grass interior.
    const FR = R + 3;
    for (let dy = -FR; dy <= FR; dy++)
      for (let dx = -FR; dx <= FR; dx++) {
        const x = c.cx + dx;
        const y = c.cy + dy;
        if (!this.inBounds(x, y)) continue;
        const d = Math.hypot(dx, dy);
        if (d > FR) continue;
        const i = this.idx(x, y);
        // grade harder toward the center, feather the apron at the edge
        this.elev[i] = lerp(this.elev[i], baseE, d <= R ? 0.85 : 0.4);
        if (d <= R - 1) this.land[i] = rng.chance(0.55) ? Land.Gravel : Land.Grass;
      }

    // 2) HESCO perimeter wall (a couple of cells thick), broken only at the gate.
    const gateHalf = Math.atan2(2.6, R); // ~5-cell entry-control point
    const gateCell = { cx: Math.round(c.cx + gateDir.x * R), cy: Math.round(c.cy + gateDir.y * R) };
    for (let dy = -FR; dy <= FR; dy++)
      for (let dx = -FR; dx <= FR; dx++) {
        const x = c.cx + dx;
        const y = c.cy + dy;
        if (!this.inBounds(x, y)) continue;
        const d = Math.hypot(dx, dy);
        // Wall band ≥3 cells (15 m) thick: at the 15 m coarse pathfinding scale a node
        // centred on it is then FULLY impassable, so the ring genuinely seals and A*
        // can't tunnel a transit route through the yard (it used to, because a 2-cell
        // wall left every coarse wall-node mostly "passable"). Only the gate breaks it.
        if (d < R - 2.4 || d > R + 0.6) continue;
        if (Math.abs(angleDiff(angle({ x: dx, y: dy }), ga)) < gateHalf) continue; // gate gap
        const i = this.idx(x, y);
        this.land[i] = Land.Hesco;
        this.elev[i] = baseE + 2.2; // the wall stands above the pad
      }

    // 2.5) Perimeter track — a graded patrol road ringing the wall just outside it,
    //   like the road around a real COP. It gives movement a clean, cheap, walkable
    //   way around the outpost to ANY bearing, so a patrol bound for a village on the
    //   far side of the gate rounds the wire on a real track instead of clawing a
    //   winding path across the raw hillside (which is what stranded squads on the
    //   perimeter). It rides the already-graded apron, so it's a track — not a cut —
    //   and it simply breaks wherever a cliff or compound wall genuinely blocks it.
    for (let deg = 0; deg < 360; deg += 1.0) {
      const a = (deg * Math.PI) / 180;
      for (let band = 1; band <= 5; band++) {
        const rr = R + band; // a graded ring road outside the wall (wide enough that a
        // clean 15 m coarse pathfinding node sits ON it, clear of the wall, so routes
        // ride the road around the wire instead of fleeing onto the rough hillside
        const x = Math.round(c.cx + Math.cos(a) * rr);
        const y = Math.round(c.cy + Math.sin(a) * rr);
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        const l = this.land[i] as Land;
        if (l === Land.Hesco || l === Land.Cliff || l === Land.CompoundWall || l === Land.Structure) continue;
        this.land[i] = Land.Trail;
        // Bench the tread flat (cut-and-fill, like a real perimeter road) so the way
        // around the wire is reliably passable and cheap to ALL bearings — the squad
        // rounds the outpost on a road instead of clawing across the broken hillside.
        this.elev[i] = lerp(this.elev[i], baseE, 0.85);
      }
    }

    // 2.6) ECP apron — a flat, graded approach from the gate out past the ring road,
    //   ≥3 cells wide, eased to the pad elevation. This is the serpentine vehicle
    //   approach of a real entry-control point, and it does critical structural work:
    //   the steep downhill access road is later graded starting from the FAR END of
    //   this apron, so the gate and its immediate egress stay flat and walkable no
    //   matter how the descent falls (the diagonal-gate egress-on-broken-ground bug —
    //   issue 001 — came from the road steepening the gate cell after buildCop had
    //   already validated it). A guaranteed-flat ≥3-cell apron also keeps the gate a
    //   clean coarse portal at the 15 m pathfinding scale (issue 005).
    const APRON_END = R + 8;
    this.stampGateApron(c.cx, c.cy, gateDir, R - 3, APRON_END, baseE);

    // 3) Interior road from the gate to the center of the yard.
    const gateInside = { cx: Math.round(c.cx + gateDir.x * (R - 3)), cy: Math.round(c.cy + gateDir.y * (R - 3)) };
    const muster = { cx: Math.round(c.cx + gateDir.x * (R * 0.4)), cy: Math.round(c.cy + gateDir.y * (R * 0.4)) };
    this.stampLane(gateCell.cx, gateCell.cy, c.cx, c.cy, Land.Gravel, 1);

    // 4) Structures. Positions are relative to the gate so the layout reads the
    //    same on every valley: vehicles and the LZ up front, billets to the rear.
    const at = (back: number, side: number) => ({
      cx: Math.round(c.cx - gateDir.x * back * R + perp.x * side * R),
      cy: Math.round(c.cy - gateDir.y * back * R + perp.y * side * R),
    });
    const buildings: CopBuilding[] = [];
    const place = (kind: CopBuildingKind, label: string, back: number, side: number, hw: number, hh: number) => {
      const p = at(back, side);
      buildings.push({ kind, label, cx: p.cx, cy: p.cy, hw, hh });
    };
    place("toc", "TOC", 0.12, 0.0, 2, 2); // command post, center
    place("armory", "Armory", 0.12, 0.34, 1, 2);
    place("aid", "Aid Station", 0.12, -0.34, 2, 1);
    place("barracks", "Barracks A", 0.62, 0.34, 3, 1);
    place("barracks", "Barracks B", 0.62, -0.34, 3, 1);
    place("dfac", "Chow Hall", 0.5, 0.02, 2, 2);
    place("latrine", "Latrines", 0.74, 0.0, 1, 1);
    place("motorpool", "Motor Pool", -0.42, 0.42, 3, 2);
    for (const b of buildings) {
      const land = b.kind === "motorpool" ? Land.Gravel : Land.Structure;
      this.stampRect(b.cx, b.cy, b.hw, b.hh, land, baseE);
    }

    // 5) Helicopter LZ — a graded gravel pad opposite the motor pool, near the gate.
    const lzp = at(-0.42, -0.45);
    this.stampRect(lzp.cx, lzp.cy, 3, 3, Land.Gravel, baseE);
    const lz = { cx: lzp.cx, cy: lzp.cy };

    // 6) Crew-served fighting positions / towers — dug in just INSIDE the wall on
    //    passable ground (never on the HESCO itself, which is impassable), so the
    //    guard can actually man them.
    const fightingPositions: CopFightingPosition[] = [];
    const posAngles = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (k * Math.PI) / 4);
    let fp = 0;
    for (const a of posAngles) {
      if (Math.abs(angleDiff(a, ga)) < gateHalf + 0.25) continue; // keep the gate clear
      const fx = Math.round(c.cx + Math.cos(a) * (R - 3));
      const fy = Math.round(c.cy + Math.sin(a) * (R - 3));
      const snap = this.nearestPassable(fx, fy, 4);
      if (!this.inBounds(snap.cx, snap.cy)) continue;
      fightingPositions.push({ id: `fp-${fp}`, cx: snap.cx, cy: snap.cy, facing: a, tower: fp % 3 === 0 });
      fp++;
    }

    // gateOutside is the FAR END of the flat ECP apron (issue 001): a benched cell
    // at ~R+5, clear of the wall (so a 15 m coarse node sits cleanly on it — issue
    // 005) and guaranteed walkable because the apron grades it flat and the downhill
    // road only starts beyond it. Prefer the apron end; snap to passable as a guard.
    let gateOutside = { cx: Math.round(c.cx + gateDir.x * (R + 5)), cy: Math.round(c.cy + gateDir.y * (R + 5)) };
    if (!this.passableCell(gateOutside.cx, gateOutside.cy)) {
      for (let b = 4; b <= 10; b++) {
        const px = Math.round(c.cx + gateDir.x * (R + b));
        const py = Math.round(c.cy + gateDir.y * (R + b));
        if (this.inBounds(px, py) && this.passableCell(px, py)) {
          gateOutside = { cx: px, cy: py };
          break;
        }
      }
    }
    const goSnap = this.nearestPassable(gateOutside.cx, gateOutside.cy, 6);

    this.cop = {
      center: { cx: c.cx, cy: c.cy },
      radius: R,
      gate: gateCell,
      gateInside,
      gateOutside: goSnap,
      gateDir,
      muster,
      lz,
      buildings,
      fightingPositions,
    };

    this.computeSlopeLocal(c.cx, c.cy, FR + 1);
  }

  /**
   * Grade a flat ECP apron: a ≥3-cell-wide benched corridor along the gate axis
   * from `from` to `to` (cells from center), eased to the pad elevation. Skips the
   * wall, compounds and structures. This is what makes the gate egress robust — the
   * downhill access road starts beyond `to`, so the gate and its immediate apron
   * never get steepened by the descent.
   */
  private stampGateApron(cx: number, cy: number, dir: Vec2, from: number, to: number, baseE: number) {
    const perp = { x: -dir.y, y: dir.x };
    // Wide enough (~7 cells) that even a DIAGONAL apron keeps benched neighbors on
    // either side: the slope is a forward difference, so a narrow diagonal ramp would
    // otherwise read steep where its +x/+y neighbor falls off onto natural ground.
    for (let r = from; r <= to; r += 0.5)
      for (let o = -3; o <= 3; o += 0.5) {
        const x = Math.round(cx + dir.x * r + perp.x * o);
        const y = Math.round(cy + dir.y * r + perp.y * o);
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        const l = this.land[i] as Land;
        if (l === Land.Hesco || l === Land.CompoundWall || l === Land.Compound || l === Land.Structure) continue;
        this.elev[i] = lerp(this.elev[i], baseE, 0.82);
        if (l !== Land.Gravel && l !== Land.River) this.land[i] = Land.Trail;
      }
  }

  /**
   * Generation-time insurance for issue 005. The gate is a single ~5-cell opening in
   * a ≥3-cell-thick HESCO wall, while the pathfinder plans at 15 m (3-cell) COARSE
   * nodes — so a thin gate in a thick wall can, under unlucky alignment or harsher
   * wall/penalty tuning, SEAL at coarse resolution even though it is wide open at
   * full resolution (the interior becomes coarse-disconnected from the exterior).
   * This verifies the inside-gate coarse node actually connects to the outside-gate
   * node by a small flood fill over coarse nodes, and if it doesn't, carves the gate
   * corridor wider (overwriting the wall on the gate axis) until it does. With the
   * benched ≥7-cell ECP apron this should never fire — but it's cheap insurance, and
   * it would have caught the wall/penalty tuning regressions during the rebuild
   * instantly instead of as a mysterious "patrol can't leave" bug.
   */
  private ensureGatePortal() {
    const cop = this.cop;
    if (!cop) return;
    // Verify the gate with the ACTUAL planner, not a hand-rolled flood. The old check was a plain
    // 8-connected coarse flood with no corner-cut rule; findPath FORBIDS a diagonal step when both
    // orthogonal neighbours are blocked (anti corner-cutting). So on a DIAGONAL gate the flood said
    // "connected" (it cuts the wall corner) while findPath could not transit — the gate sealed for
    // the squad and the portal guard never fired (the "squad cannot leave the COP" bug on diagonal-
    // gate seeds, e.g. valley-5293). Probing with findPath itself guarantees the gate is genuinely
    // transitable by the planner the squad uses, diagonal or not.
    // Probe the FULL egress the squad actually performs: muster (deep in the yard) -> gateOutside.
    // On a diagonal gate the corner-cut bites not only at the gate gap but all along the diagonal
    // interior lane, so a gate that transits gateInside->gateOutside can still strand a squad that
    // can't reach the gate from the muster yard (valley-5293).
    const connected = (): boolean => {
      const muW = this.cellCenter(cop.muster.cx, cop.muster.cy);
      const goW = this.cellCenter(cop.gateOutside.cx, cop.gateOutside.cy);
      const route = findPath(this, muW, goW);
      const end = route[route.length - 1];
      return !!end && Math.hypot(end.x - goW.x, end.y - goW.y) < this.cellSize * 2;
    };
    const baseE = this.elev[this.idx(cop.center.cx, cop.center.cy)];
    let tries = 0;
    while (!connected() && tries < 5) {
      tries++;
      // Widen the egress: carve a flat passable lane along the FULL muster->gateOutside axis,
      // OVERWRITING the wall (but never a village qalat / a COP structure), so the opening — and
      // the diagonal interior approach to it — grows by a cell each pass until the planner can
      // transit it orthogonally (defeating the diagonal corner-cut at coarse resolution).
      const half = 1 + tries;
      const gi = cop.muster;
      const go = cop.gateOutside;
      const steps = (Math.max(Math.abs(go.cx - gi.cx), Math.abs(go.cy - gi.cy)) + 1) * 2;
      for (let s = 0; s <= steps; s++) {
        const bx = lerp(gi.cx, go.cx, s / steps);
        const by = lerp(gi.cy, go.cy, s / steps);
        for (let h = -half; h <= half; h++)
          for (let g = -half; g <= half; g++) {
            const x = Math.round(bx + h);
            const y = Math.round(by + g);
            if (!this.inBounds(x, y)) continue;
            const i = this.idx(x, y);
            const l = this.land[i] as Land;
            if (l === Land.Compound || l === Land.CompoundWall || l === Land.Structure) continue;
            this.land[i] = Land.Gravel;
            this.elev[i] = lerp(this.elev[i], baseE, 0.85);
          }
      }
      this.computeSlopeLocal(cop.center.cx, cop.center.cy, cop.radius + 10);
    }
  }

  /** Diagnostics for the gen-time network connectivity guard (issue 008). */
  netRepair?: { carvedCells: number; villagesConnected: number; villages: number; passes: number };

  /**
   * Generation-time NETWORK connectivity guarantee (issue 008 — the deep one). `ensureGatePortal`
   * proves the gate is a coarse portal LOCALLY (a radius+12 window); this proves the gate's
   * EXTERIOR actually connects to the area of operations. The COP can be scored onto a fine
   * commanding bench that a cliff band walls off from most of the valley — the gate then opens
   * into a pocket that the coarse pathfinder (15 m nodes) can route almost nowhere from, so far
   * villages return a best-effort "set up short" instead of a real route (measured: survey-5's
   * gate flood reaches 2% of the map, 3/4 villages walled off).
   *
   * The guard floods the 15 m COARSE graph — the resolution the patrol planner actually uses —
   * from the gate-outside node, then for the valley MSR and every village the flood does NOT
   * reach, carves a benched, >=3-cell, grade-limited Track corridor that ties it into the
   * connected component. The corridor is ROUTED over a gradeable surface (Dijkstra that goes
   * AROUND cliffs through the draws), never a straight ramp through a cliff (the reverted
   * straight-line negative). A village with no gradeable route within MAX_CARVE is left
   * genuinely unreachable — the harness then flags it honestly rather than the squad faking an
   * arrival. This is the "smart" form of the reverted raw-largest-component COP constraint: it
   * gates on NETWORK reachability (roads counted) and REPAIRS, instead of rejecting good benches.
   */
  private ensureNetworkConnectivity() {
    const cop = this.cop;
    if (!cop) return;
    const gate = this.cellCenter(cop.gateOutside.cx, cop.gateOutside.cy);
    let carvedTotal = 0;
    let passes = 0;
    // PHASE A — make every gradeably-reachable village COARSE-pathable from the gate (the 15 m
    // resolution the squad's planner actually uses). A village can be FINE-passable-connected by a
    // 1-cell thread the coarse A* can't follow — `findPath` then returns a best-effort route that
    // strands the squad hundreds of metres short. Carve a benched >=3-cell Track from such a village
    // to the gate's COARSE-reachable component (routing AROUND cliffs over gradeable ground), so the
    // planner returns a real route. Looped: each pass's carves extend the component for the next.
    for (let pass = 0; pass < 5; pass++) {
      const coarseSeen = this.coarseReachableFromGate();
      let carvedAny = false;
      for (const v of this.villages) {
        const edge = this.gradeableEdgeCell(v.cx, v.cy);
        if (!edge || coarseSeen[this.idx(edge.cx, edge.cy)]) continue; // already coarse-reachable
        const carve = this.routeToNetwork(edge.cx, edge.cy, coarseSeen);
        if (carve && carve.length >= 2) {
          carvedTotal += this.carveTrackAlong(carve);
          carvedAny = true;
        }
      }
      passes = pass + 1;
      if (!carvedAny) break; // the rest are genuinely walled off within MAX_CARVE — leave them honest
      this.computeSlope(); // benching reshaped the ground; the next pass's flood sees the new Track
    }
    // PHASE B — lay a fast benched Track along the squad's ACTUAL route to every now-reachable
    // village, so it rides moveCost 0.96 instead of clawing 0.2-0.6 cross-country (the dominant
    // "reachable but too slow to arrive" loss). Benching (flattening the tread) — not just stamping
    // Track landcover — is what removes the slope speed penalty and makes a borderline far village
    // actually arrive; the cost is some benched cut on steep sections (troughCells).
    let villagesConnected = 0;
    for (const v of this.villages) {
      const edge = this.gradeableEdgeCell(v.cx, v.cy);
      if (!edge) continue;
      const edgeW = this.cellCenter(edge.cx, edge.cy);
      const route = findPath(this, gate, edgeW, { roadBias: 0.6 });
      const end = route[route.length - 1];
      if (end && Math.hypot(end.x - edgeW.x, end.y - edgeW.y) < this.cellSize * 5) {
        carvedTotal += this.carveTrackAlong(this.densifyCells([gate, ...route]));
        villagesConnected++;
      }
    }
    this.computeSlope();
    this.netRepair = { carvedCells: carvedTotal, villagesConnected, villages: this.villages.length, passes };
  }

  /** A FINE bitmap of the cells the squad's planner can reach: a cell is set iff it is passable AND
   *  its 15 m COARSE node is in the gate's coarse flood (a node is open if ANY subcell is passable —
   *  exactly path.ts's node passability). This is the right "connected" notion for the connectivity
   *  guard: fine 8-connected passability over-credits a 1-cell thread the coarse A* can't thread. */
  private coarseReachableFromGate(): Uint8Array {
    const cop = this.cop!;
    const f = COARSE_F;
    const cw = Math.ceil(this.size / f);
    const open = (nx: number, ny: number): boolean => {
      for (let yy = 0; yy < f; yy++)
        for (let xx = 0; xx < f; xx++) {
          const cx = nx * f + xx;
          const cy = ny * f + yy;
          if (cx < this.size && cy < this.size && this.passableCell(cx, cy)) return true;
        }
      return false;
    };
    const seenNode = new Uint8Array(cw * cw);
    const gx = Math.floor(cop.gateOutside.cx / f);
    const gy = Math.floor(cop.gateOutside.cy / f);
    const fine = new Uint8Array(this.size * this.size);
    if (!open(gx, gy)) return fine;
    seenNode[gy * cw + gx] = 1;
    const stack = [gy * cw + gx];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cw;
      const y = (i / cw) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= cw) continue;
          const ni = ny * cw + nx;
          if (seenNode[ni] || !open(nx, ny)) continue;
          seenNode[ni] = 1;
          stack.push(ni);
        }
    }
    // expand reachable nodes to their passable fine cells
    for (let ny = 0; ny < cw; ny++)
      for (let nx = 0; nx < cw; nx++) {
        if (!seenNode[ny * cw + nx]) continue;
        for (let yy = 0; yy < f; yy++)
          for (let xx = 0; xx < f; xx++) {
            const cx = nx * f + xx;
            const cy = ny * f + yy;
            if (cx < this.size && cy < this.size && this.passableCell(cx, cy)) fine[cy * this.size + cx] = 1;
          }
      }
    return fine;
  }

  /** Ground a benched Track can be cut into: not a cliff/wall/structure/qalat. (classifyLand
   *  already promotes slope>1.5 to Cliff, so any non-cliff cell here is genuinely benchable.) */
  private gradeableGround(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const l = this.land[this.idx(cx, cy)] as Land;
    return l !== Land.Cliff && l !== Land.Compound && l !== Land.CompoundWall && l !== Land.Hesco && l !== Land.Structure;
  }

  /** A gradeable cell just outside a village's walled footprint, on the COP-facing side — the
   *  cell the patrol's objective actually snaps to (reachableObjective steps out of the qalat
   *  toward the COP). Connecting here means findPath's route ends ON the squad's real target, not
   *  on the far wall. Steps from the centre toward the COP first, then falls back to a ring scan. */
  private gradeableEdgeCell(vx: number, vy: number): { cx: number; cy: number } | null {
    const cop = this.cop;
    if (cop) {
      const dx = Math.sign(cop.center.cx - vx);
      const dy = Math.sign(cop.center.cy - vy);
      if (dx !== 0 || dy !== 0) {
        for (let s = 1; s <= 24; s++) {
          const cx = vx + dx * s;
          const cy = vy + dy * s;
          if (this.gradeableGround(cx, cy) && this.passableCell(cx, cy)) return { cx, cy };
        }
      }
    }
    for (let r = 1; r <= 18; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring
          const cx = vx + dx;
          const cy = vy + dy;
          if (this.gradeableGround(cx, cy) && this.passableCell(cx, cy)) return { cx, cy };
        }
    return null;
  }

  /**
   * Dijkstra from a village approach cell to the NEAREST cell already reachable on foot from the
   * gate, over a gradeable surface (anything that isn't a cliff/wall/structure/compound;
   * steep-but-benchable is allowed and gets benched flat by the carve). Cost favours gentle
   * ground and avoids the river, so it threads the draws around a cliff band rather than
   * charging it. Bounded to a box of MAX_CARVE cells so it stays cheap and never carves a
   * kilometre-long scar; returns null (honestly unreachable) if no route fits. Deterministic.
   */
  private routeToNetwork(sCx: number, sCy: number, seenNet: Uint8Array): { cx: number; cy: number }[] | null {
    const size = this.size;
    const MAX_CARVE = 140; // cells (~700 m) — beyond this it's effectively unreachable
    const x0 = Math.max(0, sCx - MAX_CARVE);
    const x1 = Math.min(size - 1, sCx + MAX_CARVE);
    const y0 = Math.max(0, sCy - MAX_CARVE);
    const y1 = Math.min(size - 1, sCy + MAX_CARVE);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const li = (cx: number, cy: number) => (cy - y0) * bw + (cx - x0);
    const cost = new Float64Array(bw * bh).fill(Infinity);
    const prev = new Int32Array(bw * bh).fill(-1);
    const gradeable = (cx: number, cy: number): boolean =>
      cx >= x0 && cy >= y0 && cx <= x1 && cy <= y1 && this.gradeableGround(cx, cy);
    const isConn = (cx: number, cy: number) => seenNet[this.idx(cx, cy)] === 1;
    // tiny binary heap of [cost, localIndex]
    const heap: number[] = []; // localIndex entries; cost read from `cost[]`
    const push = (idx: number) => {
      heap.push(idx);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (cost[heap[p]] <= cost[heap[i]]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && cost[heap[l]] < cost[heap[m]]) m = l;
          if (r < heap.length && cost[heap[r]] < cost[heap[m]]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const start = li(sCx, sCy);
    cost[start] = 0;
    push(start);
    let goal = -1;
    let expanded = 0;
    while (heap.length && expanded < 60000) {
      const cur = pop();
      expanded++;
      const cx = (cur % bw) + x0;
      const cy = ((cur / bw) | 0) + y0;
      // reached the existing network on real passable ground? (never the disconnected start)
      if (cur !== start && isConn(cx, cy) && this.passableCell(cx, cy)) {
        goal = cur;
        break;
      }
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!gradeable(nx, ny)) continue;
          const ni = li(nx, ny);
          const slope = this.slope[this.idx(nx, ny)];
          const l = this.land[this.idx(nx, ny)] as Land;
          const step = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * (1 + slope * 1.5 + (l === Land.River ? 4 : 0));
          const nc = cost[cur] + step;
          if (nc < cost[ni]) {
            cost[ni] = nc;
            prev[ni] = cur;
            push(ni);
          }
        }
    }
    if (goal < 0) return null;
    const path: { cx: number; cy: number }[] = [];
    let c = goal;
    while (c !== -1) {
      path.push({ cx: (c % bw) + x0, cy: ((c / bw) | 0) + y0 });
      if (c === start) break;
      c = prev[c];
    }
    path.reverse();
    return path;
  }

  /**
   * Bench a >=3-cell-wide graded Track along a routed cell path, easing each tread cell to a
   * grade-limited design line (max ~0.42) so the corridor is genuinely walkable (passable at
   * 5 m) AND carries a clean 15 m coarse node (so the patrol planner routes on it). On gentle
   * ground the design elevation ~ the natural ground, so it rides light (no trench); only a
   * steep pitch gets cut. Returns the number of tread cells laid. Skips qalats/structures/wire.
   */
  private carveTrackAlong(path: { cx: number; cy: number }[]): number {
    if (path.length < 2) return 0;
    const cs = this.cellSize;
    const maxGrade = 0.42;
    let designE = this.elev[this.idx(path[0].cx, path[0].cy)];
    let laid = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const natE = this.elev[this.idx(b.cx, b.cy)];
      const dM = (Math.hypot(b.cx - a.cx, b.cy - a.cy) || 1) * cs;
      const maxStep = maxGrade * dM;
      designE = natE < designE ? Math.max(natE, designE - maxStep) : Math.min(natE, designE + maxStep);
      this.gradeTreadAt(b.cx, b.cy, designE, 1, Land.Track);
      laid++;
    }
    return laid;
  }

  /** Densify a polyline of world waypoints into a contiguous run of cells (a findPath route is
   *  sparse string-pulled segments; carveTrackAlong needs every cell so the bench is continuous). */
  private densifyCells(pts: Vec2[]): { cx: number; cy: number }[] {
    const cs = this.cellSize;
    const out: { cx: number; cy: number }[] = [];
    const push = (cx: number, cy: number) => {
      if (!this.inBounds(cx, cy)) return;
      const last = out[out.length - 1];
      if (!last || last.cx !== cx || last.cy !== cy) out.push({ cx, cy });
    };
    let prev = pts[0];
    push(Math.floor(prev.x / cs), Math.floor(prev.y / cs));
    for (let k = 1; k < pts.length; k++) {
      const cur = pts[k];
      const ax = prev.x / cs, ay = prev.y / cs, bx = cur.x / cs, by = cur.y / cs;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        push(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t));
      }
      prev = cur;
    }
    return out;
  }

  /** Stamp a filled rectangle of landcover (cells), flattening it to `baseE`. */
  private stampRect(cx: number, cy: number, hw: number, hh: number, land: Land, baseE: number) {
    for (let dy = -hh; dy <= hh; dy++)
      for (let dx = -hw; dx <= hw; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        if (this.land[i] === Land.Hesco) continue; // never overwrite the wall
        this.land[i] = land;
        this.elev[i] = baseE;
      }
  }

  /**
   * Build the COP's access road: a narrow, grade-limited track from the gate down
   * to the valley-floor road. A straight cut-and-fill ramp lerps elevation from
   * the gate to the river in one shot — which gouges a deep, dead-straight trench
   * across the hillside whenever the knob stands well above the floor. Instead this
   * routes one short step at a time, *following the terrain*: it heads for the
   * valley where the grade allows, and where the fall line is too steep to descend
   * directly it traverses across the slope and switchbacks — exactly how a real
   * road gets off a spur. It reshapes the ground only enough to keep the tread
   * walkable, so a COP on a gentle bench gets a track laid on the surface (no
   * trench) while a COP on a steep face gets a road that zig-zags down it.
   */
  private gradeAccessRoad(rng: RNG) {
    const cop = this.cop;
    const gi = cop.gateInside;
    const size = this.size;

    // The descent starts at the FAR END of the flat ECP apron, not at gateOutside.
    // gateOutside (≈R+5) therefore stays in the middle of the benched apron with
    // flat ground on every side — so the downhill road can never re-steepen the gate
    // egress (the diagonal-gate egress-on-broken-ground bug). It just begins a few
    // cells further out.
    const ds = {
      cx: clamp(Math.round(cop.center.cx + cop.gateDir.x * (cop.radius + 8)), 0, size - 1),
      cy: clamp(Math.round(cop.center.cy + cop.gateDir.y * (cop.radius + 8)), 0, size - 1),
    };

    // 1) Through the ECP and across the apron: a flat graded tread from inside the
    //    gate out to the descent start (the apron is already benched, so it's gentle).
    this.gradeCorridor(gi.cx, gi.cy, ds.cx, ds.cy, 1);
    // 2) Switchback down to the valley road at a vehicle grade (road tread).
    this.descendTrack(ds.cx, ds.cy, 1, 0.32, Land.Road, rng);
  }

  /** Stamp a `half`-band graded tread around a cell, easing it to `targetE`. */
  private gradeTreadAt(cxf: number, cyf: number, targetE: number, half: number, land: Land = Land.Road) {
    const bx = Math.round(cxf);
    const by = Math.round(cyf);
    // Bench the tread to grade, and FEATHER one ring beyond it (eased partway to grade) so the
    // cut blends into the hillside like a real road cut-and-fill — instead of leaving the sharp
    // groove that made the old village descents read as ugly "troughs". Only the tread (≤half)
    // takes the road/track landcover; the feather ring stays natural ground, just smoothed.
    const reach = half + 1;
    const treadW = land === Land.Trail ? 0.6 : land === Land.Track ? 0.72 : 0.82;
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        const l = this.land[i] as Land;
        if (l === Land.Hesco || l === Land.Compound || l === Land.CompoundWall || l === Land.Structure) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.elev[i] = lerp(this.elev[i], targetE, d <= half ? treadW : 0.34);
        if (d <= half) {
          if (l !== Land.Gravel && l !== Land.River && l !== Land.Road) this.land[i] = land;
          else if (l === Land.River) this.land[i] = Land.Footbridge;
        }
      }
  }

  /** Elevation gradient in cell space (points uphill), by central difference. */
  private gradientCells(px: number, py: number): { x: number; y: number } {
    const x = clamp(Math.round(px), 1, this.size - 2);
    const y = clamp(Math.round(py), 1, this.size - 2);
    return {
      x: this.elev[this.idx(x + 1, y)] - this.elev[this.idx(x - 1, y)],
      y: this.elev[this.idx(x, y + 1)] - this.elev[this.idx(x, y - 1)],
    };
  }

  /**
   * Carve a short graded road segment between two cells: the centerline elevation
   * is eased to a straight grade between the endpoints and a `half`-cell band to
   * each side is brought down to it. Used for the gate leg and to tie the access
   * road into the valley road; the long descent itself is routed by gradeAccessRoad.
   */
  private gradeCorridor(x0: number, y0: number, x1: number, y1: number, half: number, land: Land = Land.Road) {
    const e0 = this.elev[this.idx(clamp(x0, 0, this.size - 1), clamp(y0, 0, this.size - 1))];
    const e1 = this.elev[this.idx(clamp(x1, 0, this.size - 1), clamp(y1, 0, this.size - 1))];
    const steps = (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1) * 2;
    for (let s = 0; s <= steps; s++) {
      const tn = s / steps;
      const bx = lerp(x0, x1, tn);
      const by = lerp(y0, y1, tn);
      const targetE = lerp(e0, e1, tn);
      for (let h = -half; h <= half; h++)
        for (let g = -half; g <= half; g++) {
          const x = Math.round(bx + h);
          const y = Math.round(by + g);
          if (!this.inBounds(x, y)) continue;
          const i = this.idx(x, y);
          const l = this.land[i] as Land;
          if (l === Land.Hesco || l === Land.Compound || l === Land.CompoundWall || l === Land.Structure) continue;
          this.elev[i] = lerp(this.elev[i], targetE, 0.85);
          if (l === Land.River) this.land[i] = Land.Footbridge;
          else if (l !== Land.Gravel && l !== Land.Road) this.land[i] = land;
        }
    }
  }

  /**
   * Grade a terrain-following track DOWN to the valley-floor road from a start cell.
   * It heads for the road where the grade allows and traverses/switchbacks across the
   * fall line where the direct descent would be too steep, benching a `half`-wide
   * tread to a grade-limited design line so the tread is always WALKABLE. The COP
   * access road and every village foot trail both descend this way, which is how each
   * village ends up connected to the valley road — and, through it, to the COP and to
   * every other village. That is the fix for villages stranded behind a cliff band: a
   * real graded trail threads down to the road instead of leaving a sheer drop. Returns
   * the cell where it tied into the valley.
   */
  private descendTrack(startCx: number, startCy: number, half: number, maxGrade: number, land: Land, rng: RNG): { cx: number; cy: number } {
    const size = this.size;
    const cs = this.cellSize;
    const sCx = clamp(startCx, 0, size - 1);
    const sCy = clamp(startCy, 0, size - 1);
    const targetY = sCy;
    const targetX = clamp(Math.round(this.centerX[targetY]), 0, size - 1);
    const floorE = this.floorElevAtRow(targetY);
    const stepCells = 1.4;
    const stepM = stepCells * cs;
    const axisLen = Math.hypot(targetX - sCx, targetY - sCy) || 1;
    const ax = (targetX - sCx) / axisLen;
    const ay = (targetY - sCy) / axisLen;
    const swHalf = 12;
    let px = sCx + 0.5;
    let py = sCy + 0.5;
    let designE = this.elev[this.idx(sCx, sCy)];
    let side = rng.chance(0.5) ? 1 : -1;
    for (let iter = 0; iter < 700; iter++) {
      const toTX = targetX + 0.5 - px;
      const toTY = targetY + 0.5 - py;
      const dT = Math.hypot(toTX, toTY);
      if (dT < stepCells * 1.3) break;
      const dirX = toTX / dT;
      const dirY = toTY / dT;
      const needGrade = (designE - floorE) / Math.max(1, dT * cs);
      let hx: number;
      let hy: number;
      if (needGrade <= maxGrade) {
        hx = dirX;
        hy = dirY;
      } else {
        const g = this.gradientCells(px, py);
        let fx = -g.x;
        let fy = -g.y;
        const fl = Math.hypot(fx, fy);
        if (fl < 1e-4) {
          fx = dirX;
          fy = dirY;
        } else {
          fx /= fl;
          fy /= fl;
        }
        let cxr = -fy;
        let cyr = fx;
        if (Math.sign(cxr * -ay + cyr * ax) !== side) {
          cxr = -cxr;
          cyr = -cyr;
        }
        hx = cxr * 0.82 + fx * 0.18;
        hy = cyr * 0.82 + fy * 0.18;
        const hl = Math.hypot(hx, hy) || 1;
        hx /= hl;
        hy /= hl;
      }
      const nx = px + hx * stepCells;
      const ny = py + hy * stepCells;
      designE = Math.max(floorE, designE - Math.min(maxGrade, Math.max(0, needGrade)) * stepM);
      this.gradeTreadAt(nx, ny, designE, half, land);
      const offAxis = (nx - (sCx + 0.5)) * -ay + (ny - (sCy + 0.5)) * ax;
      if (Math.abs(offAxis) > swHalf) side = offAxis > 0 ? -1 : 1;
      px = nx;
      py = ny;
    }
    this.gradeCorridor(Math.round(px), Math.round(py), targetX, targetY, half, land);
    return { cx: Math.round(px), cy: Math.round(py) };
  }

  /** Stamp a straight lane of landcover between two cells, `half` cells wide. */
  private stampLane(x0: number, y0: number, x1: number, y1: number, land: Land, half: number) {
    const steps = (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1) * 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const bx = Math.round(lerp(x0, x1, t));
      const by = Math.round(lerp(y0, y1, t));
      for (let dy = -half; dy <= half; dy++)
        for (let dx = -half; dx <= half; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (!this.inBounds(x, y)) continue;
          const i = this.idx(x, y);
          if (this.land[i] === Land.Hesco || this.land[i] === Land.Structure) continue;
          this.land[i] = land;
        }
    }
  }

  /**
   * Fraction of bearings around a prospective COP whose perimeter band (R+1..R+5)
   * has a passable, gentle natural cell — i.e. how much of the wire can be ringed
   * by a benched patrol road. Evaluated on the RAW ground (the wall isn't built
   * yet), so a knob cliffed on one side scores low and loses to a true bench.
   */
  private perimeterBenchFrac(cx: number, cy: number, R: number): number {
    let open = 0;
    const STEPS = 16;
    for (let k = 0; k < STEPS; k++) {
      const a = (k / STEPS) * Math.PI * 2;
      let any = false;
      for (let b = 1; b <= 5 && !any; b++) {
        const x = Math.round(cx + Math.cos(a) * (R + b));
        const y = Math.round(cy + Math.sin(a) * (R + b));
        if (!this.inBounds(x, y)) continue;
        const l = this.land[this.idx(x, y)] as Land;
        if (l !== Land.River && l !== Land.Cliff && this.slope[this.idx(x, y)] < 0.95) any = true;
      }
      if (any) open++;
    }
    return open / STEPS;
  }

  /**
   * The inverse-distance-weighted centroid of the villages, in cell space — the
   * outpost's area of operations. The gate is biased to face this so a real ECP
   * looks out over the ground it patrols, not away from it (issue 002).
   */
  /** The nearest village center (cells) to a point — the gate's primary AO. */
  private nearestVillageCell(cx: number, cy: number): { cx: number; cy: number } | null {
    let best: { cx: number; cy: number } | null = null;
    let bd = Infinity;
    for (const v of this.villages) {
      const d = Math.hypot(v.cx - cx, v.cy - cy);
      if (d < bd) {
        bd = d;
        best = { cx: v.cx, cy: v.cy };
      }
    }
    return best;
  }

  private villageCentroidNear(cx: number, cy: number): Vec2 | null {
    if (!this.villages.length) return null;
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const v of this.villages) {
      const d = Math.hypot(v.cx - cx, v.cy - cy);
      const w = 1 / Math.max(40, d); // nearer villages dominate the bearing
      wx += v.cx * w;
      wy += v.cy * w;
      wsum += w;
    }
    return wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null;
  }

  /**
   * A point a civilian may legitimately stand on: passable ground that is never
   * inside the COP wire or its apron. Routine waypoints, spawn points and flee
   * destinations are passed through this so villagers near an outpost amble in
   * their fields and lanes instead of pressing into the HESCO (the "villagers
   * wander into the wire" bug). Cheap: a no-op for the common case far from the COP.
   */
  /** Snap a world point to the nearest passable cell center (e.g. a building seat
   *  pushed to the doorway/yard now that structures are solid). */
  passablePoint(wx: number, wy: number): Vec2 {
    const cs = this.cellSize;
    const c = this.nearestPassable(Math.floor(wx / cs), Math.floor(wy / cs));
    return this.cellCenter(c.cx, c.cy);
  }

  /**
   * A garrison seat at a building: a passable cell on its YARD side (toward the COP
   * centre), so soldiers stand at the doorway facing the interior, never boxed
   * between the building and the wall (which would strand them when a patrol forms —
   * the issue-003 assembly deadlock, made acute once buildings are solid). The seat
   * is found by stepping off the footprint toward the centre, then snapping passable.
   */
  buildingSeat(b: CopBuilding): Vec2 {
    const ctr = this.cop ? this.cop.center : { cx: b.cx, cy: b.cy };
    let dx = ctr.cx - b.cx;
    let dy = ctr.cy - b.cy;
    const dl = Math.hypot(dx, dy);
    const off = Math.max(b.hw, b.hh) + 1.5;
    if (dl < 0.5) {
      // a building sitting on the centre (the TOC): seat it toward the gate instead.
      const g = this.cop ? this.cop.gateDir : { x: 0, y: 1 };
      dx = g.x;
      dy = g.y;
    } else {
      dx /= dl;
      dy /= dl;
    }
    return this.passablePoint((b.cx + dx * off + 0.5) * this.cellSize, (b.cy + dy * off + 0.5) * this.cellSize);
  }

  civSafePoint(wx: number, wy: number): Vec2 {
    const cs = this.cellSize;
    let cx = Math.floor(wx / cs);
    let cy = Math.floor(wy / cs);
    const cop = this.cop;
    if (cop) {
      const ex = cx - cop.center.cx;
      const ey = cy - cop.center.cy;
      const d = Math.hypot(ex, ey);
      const keep = cop.radius + 6; // wire + benched apron/ring road
      if (d < keep) {
        // push the point radially outward, past the wire, keeping its bearing
        const nd = keep + 2;
        if (d > 0.5) {
          cx = Math.round(cop.center.cx + (ex / d) * nd);
          cy = Math.round(cop.center.cy + (ey / d) * nd);
        } else {
          cy = Math.round(cop.center.cy + nd); // dead-center: shove downhill
        }
      }
    }
    const p = this.nearestPassable(cx, cy);
    return this.cellCenter(p.cx, p.cy);
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
    // ---- Village ROAD NETWORK (item 8 — replaces the old "trail trench to the water") ----
    // Each qalat is tied to the valley MSR by a graded SECONDARY TRACK, and the villages are
    // tied to ONE ANOTHER by a minimum-spanning tree of tracks — so the whole AO is one
    // connected network (villagers travel it; patrols on Fast prefer it). Tracks are ROUTED
    // OVER THE REAL TERRAIN with findPath (so they follow walkable ground — washes at the ford,
    // benches, gentle spurs — instead of bulldozing a straight line) and laid with layPath,
    // which conforms LIGHTLY to local ground and never gouges a trench. Only where a village is
    // genuinely cliff-isolated does it fall back to a switchbacked graded descent (descendTrack
    // as a Track), and a faint Tier-3 goat TRAIL climbs the draw above each village.
    const trailheads: { v: Village; hx: number; hy: number; dir: number }[] = [];
    for (const vil of this.villages) {
      const roadX = Math.round(this.centerX[vil.cy]);
      const dir = Math.sign(roadX - vil.cx) || 1;
      const hx = clamp(vil.cx + dir * (vil.size + 1), 0, size - 1);
      trailheads.push({ v: vil, hx, hy: vil.cy, dir });
    }
    // 1) Each village → the MSR (graded secondary Track).
    for (const th of trailheads) {
      this.layPath([this.cellCenter(th.v.cx, th.v.cy), this.cellCenter(th.hx, th.hy)], Land.Track, 1, 0.15);
      const tie = this.nearestRoadCell(th.hx, th.hy);
      this.layTrack(this.cellCenter(th.hx, th.hy), this.cellCenter(tie.cx, tie.cy), rng);
      // Tier-3 goat trail up the draw above the village (surface-laid, no benching).
      const upX = clamp(th.v.cx - th.dir * Math.round(size * 0.08), 0, size - 1);
      const upY = clamp(th.v.cy + rng.int(-8, 8), 0, size - 1);
      this.layPath([this.cellCenter(th.v.cx, th.v.cy), this.cellCenter(upX, upY)], Land.Trail, 0, 0);
    }
    // 2) Village ↔ village MST (graded secondary Track) — direct inter-village links.
    for (const [a, b] of this.villageMST()) {
      const va = this.villages[a];
      const vb = this.villages[b];
      this.layTrack(this.cellCenter(va.cx, va.cy), this.cellCenter(vb.cx, vb.cy), rng);
    }
    // COP access road: a narrow, switchbacked track that descends the knob to the
    // valley road, following the terrain instead of bulldozing a straight ramp.
    if (this.cop) this.gradeAccessRoad(rng);
    // Recompute slope everywhere now that the COP, its road and the valley roads
    // have reshaped the ground, so passability/movement queries see the routes.
    this.computeSlope();
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
      if (
        this.land[i] === Land.Road ||
        this.land[i] === Land.Compound ||
        this.land[i] === Land.CompoundWall ||
        this.land[i] === Land.Hesco ||
        this.land[i] === Land.Structure ||
        this.land[i] === Land.Gravel
      )
        continue;
      this.land[i] = Land.Trail;
    }
  }

  /**
   * Lay a tiered path (Track / Trail) along a polyline of WORLD waypoints WITHOUT gouging a
   * trench. It stamps the landcover and, at most, eases the tread a little toward the LOCAL
   * natural ground (`conform` ≤ ~0.2, never a far-below grade line) — so a track conforms to
   * the hillside like a real graded road instead of cutting a deep groove (the old village
   * "trail trench"). River cells become a Footbridge; the wire, qalats, structures and the MSR
   * are never overwritten.
   */
  private layPath(pts: Vec2[], land: Land, half: number, conform: number) {
    if (pts.length < 2) return;
    const cs = this.cellSize;
    let prev = pts[0];
    for (let k = 1; k < pts.length; k++) {
      const cur = pts[k];
      const ax = prev.x / cs, ay = prev.y / cs, bx = cur.x / cs, by = cur.y / cs;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const bxr = Math.round(ax + (bx - ax) * t);
        const byr = Math.round(ay + (by - ay) * t);
        for (let dy = -half; dy <= half; dy++)
          for (let dx = -half; dx <= half; dx++) {
            const x = bxr + dx;
            const y = byr + dy;
            if (!this.inBounds(x, y)) continue;
            const i = this.idx(x, y);
            const l = this.land[i] as Land;
            if (l === Land.Hesco || l === Land.Structure || l === Land.Compound || l === Land.CompoundWall || l === Land.Road || l === Land.Gravel) continue;
            if (l === Land.River) {
              this.land[i] = Land.Footbridge;
              continue;
            }
            this.land[i] = land;
            if (conform > 0) this.elev[i] = lerp(this.elev[i], this.localGroundElev(x, y), conform);
          }
      }
      prev = cur;
    }
  }

  /** Mean elevation of the natural (non-path) neighbours of a cell — the local ground level a
   *  light-tread path conforms to, so it never benches below the surrounding hillside. */
  private localGroundElev(x: number, y: number): number {
    let sum = 0;
    let cnt = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = clamp(x + dx, 0, this.size - 1);
        const ny = clamp(y + dy, 0, this.size - 1);
        const l = this.land[this.idx(nx, ny)] as Land;
        if (l === Land.Road || l === Land.Track || l === Land.Trail || l === Land.Footbridge) continue;
        sum += this.elev[this.idx(nx, ny)];
        cnt++;
      }
    return cnt ? sum / cnt : this.elev[this.idx(x, y)];
  }

  /**
   * Lay a graded secondary TRACK between two world points, routed over the REAL terrain by
   * findPath (so it follows walkable ground), then stamped light-tread (no trench). If the
   * destination is genuinely unreachable on the raw terrain (a cliff band between them), fall
   * back to a switchbacked graded descent toward the valley — which is where the MSR runs, so
   * the otherwise-isolated village still joins the road network.
   */
  private layTrack(fromW: Vec2, toW: Vec2, rng: RNG) {
    const cs = this.cellSize;
    const route = findPath(this, fromW, toW, { roadBias: 0.6 });
    const last = route[route.length - 1];
    const reached = !!last && Math.hypot(last.x - toW.x, last.y - toW.y) < cs * 3;
    if (reached && route.length >= 1) {
      this.layPath([fromW, ...route], Land.Track, 1, 0.18);
      return;
    }
    const fc = {
      cx: clamp(Math.round(fromW.x / cs), 0, this.size - 1),
      cy: clamp(Math.round(fromW.y / cs), 0, this.size - 1),
    };
    const tie = this.descendTrack(fc.cx, fc.cy, 1, 0.42, Land.Track, rng);
    // tie the graded descent explicitly into the MSR so the village is actually ON the network
    const road = this.nearestRoadCell(tie.cx, tie.cy);
    this.layPath([this.cellCenter(tie.cx, tie.cy), this.cellCenter(road.cx, road.cy)], Land.Track, 1, 0.15);
  }

  /** Nearest valley-floor MSR (Road) cell to a point — scan toward the centerline, then spiral. */
  private nearestRoadCell(cx: number, cy: number): { cx: number; cy: number } {
    const cyc = clamp(cy, 0, this.size - 1);
    const roadX = Math.round(this.centerX[cyc]);
    const dir = Math.sign(roadX - cx) || 1;
    for (let s = 0; s <= Math.abs(roadX - cx) + 8; s++) {
      const x = cx + dir * s;
      if (this.inBounds(x, cyc) && (this.land[this.idx(x, cyc)] as Land) === Land.Road) return { cx: x, cy: cyc };
    }
    for (let r = 1; r <= 40; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cyc + dy;
          if (this.inBounds(x, y) && (this.land[this.idx(x, y)] as Land) === Land.Road) return { cx: x, cy: y };
        }
    return { cx: clamp(roadX, 0, this.size - 1), cy: cyc };
  }

  /** Minimum spanning tree over the villages (complete graph, straight-line weight) as edges.
   *  Deterministic (villages in seeded order, ties by index) so the network rebuilds on load. */
  private villageMST(): [number, number][] {
    const vs = this.villages;
    const n = vs.length;
    if (n < 2) return [];
    const inTree = new Array<boolean>(n).fill(false);
    const edges: [number, number][] = [];
    inTree[0] = true;
    for (let e = 0; e < n - 1; e++) {
      let bi = -1;
      let bj = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (!inTree[i]) continue;
        for (let j = 0; j < n; j++) {
          if (inTree[j]) continue;
          const d = Math.hypot(vs[i].cx - vs[j].cx, vs[i].cy - vs[j].cy);
          if (d < bd) {
            bd = d;
            bi = i;
            bj = j;
          }
        }
      }
      if (bj < 0) break;
      inTree[bj] = true;
      edges.push([bi, bj]);
    }
    return edges;
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

  /** Nearest passable cell to (cx,cy), spiralling out — keeps objectives off cliffs. */
  nearestPassable(cx: number, cy: number, maxR = 16): { cx: number; cy: number } {
    if (this.passableCell(cx, cy)) return { cx, cy };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (this.passableCell(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
        }
    }
    return { cx, cy };
  }

  /** Is this cell passable on foot at all (cliffs/deep channels are not). */
  passableCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const l = this.land[this.idx(cx, cy)] as Land;
    if (l === Land.Cliff) return false;
    if (l === Land.CompoundWall) return false;
    if (l === Land.Hesco) return false; // the wire — only the gate is passable
    if (l === Land.Structure) return false; // buildings are solid — route around, not through (issue 004)
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
  [Land.Hesco]: [0.92, 0.85], // HESCO bastion — the hardest cover on the map
  [Land.Structure]: [0.55, 0.8], // walls of a building — cover + blocks sight
  [Land.Gravel]: [0.04, 0.05], // graded pad — open, no cover
  [Land.Track]: [0.05, 0.07], // graded dirt track — open, a hair of cover off the verge
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
  [Land.Hesco]: 0.15, // can't walk through the wall
  [Land.Structure]: 0.55, // moving through a building
  [Land.Gravel]: 0.98, // graded pad — easy going
  [Land.Track]: 0.96, // graded secondary track — just under the MSR, well above open ground
};
