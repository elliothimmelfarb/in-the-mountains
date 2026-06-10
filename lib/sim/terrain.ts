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
  Ford = 25, // a shallow gravel-bar crossing of the river — slow & exposed, but passable on foot
}

export const LAND_COUNT = 26;

export interface Village {
  id: string;
  name: string;
  cx: number;
  cy: number; // cell coords of village center
  size: number; // rough radius in cells — the HAMLET extent (its compounds spread out to here)
  population: number;
}

/** A single qalat in a village hamlet: cell offset from the village center + radius in cells. */
export interface HamletCompound {
  dx: number;
  dy: number;
  r: number;
}

/**
 * Deterministic multi-compound layout for a village — a real Korengal village is a
 * CLUSTER of stacked qalats, not one monolith (issue 014 / 007). Returns the sub-compound
 * centers (as CELL offsets from the village center) purely as a function of `v.id`, so the
 * worldgen STAMP (terrain) and the RENDERER (WorldView R3) reproduce the SAME hamlet with no
 * shared/persisted state — one source of truth. Uses an FNV-1a hash of the id to seed a tiny
 * xorshift PRNG; never touches the terrain rng (so render can recompute it offline).
 * Compounds stay within `v.size` (the hamlet radius), which is exactly the footprint COP
 * siting reserves clearance against — so a hamlet can never grow into the wire.
 */
export function villageHamlet(v: { id: string; size: number; population: number }): HamletCompound[] {
  let h = 2166136261 >>> 0;
  for (let k = 0; k < v.id.length; k++) h = Math.imul(h ^ v.id.charCodeAt(k), 16777619) >>> 0;
  const rnd = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
  // DISCRETE walled qalats ringing an open central courtyard — NOT a merged wall maze.
  // The first cut scattered OVERLAPPING compounds that filled the whole footprint and fused
  // their walls into a labyrinth with 1-cell slots, trapping a returning patrol in a
  // path-vs-steering oscillation (issue-010 class — bal-6 / Loy Kalay). Spreading the qalats
  // EVENLY on a ring and capping the count to TARGET ~8-cell arcs keeps them mostly separate
  // with an open, SKIRTABLE exterior — the angular/radial jitter still lets an occasional
  // neighbour pair land close, but a ring you can walk AROUND never re-forms the fill-the-
  // footprint trap (empirically: balance 0 stranded). The open centre also puts the patrol's
  // village objective on clear ground. 2–5 qalats in practice (ring capacity binds before the
  // population count at the 6–10-cell village radii). Deterministic from v.id; bounded ~v.size.
  const ringRad = 0.72 * v.size;
  const want = Math.max(2, Math.min(5, Math.round(v.population / 38)));
  const n = Math.max(2, Math.min(want, Math.floor((2 * Math.PI * ringRad) / 8))); // target ~8-cell arc/qalat
  const out: HamletCompound[] = [];
  const base = rnd() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const ang = base + (k + (rnd() - 0.5) * 0.35) * ((2 * Math.PI) / n);
    const rad = ringRad * (0.82 + 0.36 * rnd());
    out.push({
      dx: Math.round(Math.cos(ang) * rad),
      dy: Math.round(Math.sin(ang) * rad),
      r: 2 + Math.round(rnd()), // 2–3 cells (10–15 m family qalat)
    });
  }
  return out;
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

/** Crew-served weapon (or a rifleman's position) on the wire — see analyzeFightingPositions. */
export type CopWeapon = "m2" | "m240" | "mk19" | "rifle";

export interface CopFightingPosition {
  id: string;
  cx: number;
  cy: number;
  facing: number; // radians, outward — the position's PRIMARY direction of fire (PDF)
  tower: boolean;
  /** Crew-served weapon sited here by terrain geometry (ATP 3-21.8): the M2 takes the
   *  longest open avenue, the M240 the next, the Mk19 plunges into the worst dead space. */
  weapon: CopWeapon;
  /** Sector-of-fire bounds (radians, absolute bearings). Adjacent sectors interlock. */
  leftLimit: number;
  rightLimit: number;
  /** Mean unobstructed grazing reach down the sector (m) — how far this gun dominates. */
  avenueScore: number;
  /** Fraction (0..1) of the sector masked by terrain into dead space (defilade). */
  deadSpaceFrac: number;
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
  mortarPit: { cx: number; cy: number }; // dug-in indirect-fire pit (rear defilade) — the firing origin
  fpf: { cx: number; cy: number }; // registered Final Protective Fire point, just outside the wire on the most dangerous avenue
  buildings: CopBuilding[];
  fightingPositions: CopFightingPosition[];
}

export interface TerrainConfig {
  size: number; // cells per side
  cellSize: number; // meters per cell
  seed: number | string;
  floorSouth: number; // elevation at the SOUTH head — the HIGH end (m)
  floorNorth: number; // elevation at the NORTH mouth — the LOW end; the valley drains north into the Pech (m)
  ridgeHeight: number; // height of crests above local floor (m)
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  size: 512, // 512 × 5 m = 2.56 km valley resolved to 5 m
  cellSize: 5,
  seed: "korengal",
  // Korengal drains NORTH into the Pech: the north mouth is the LOW end, the
  // south head the HIGH end. North is y=0 (see line ~145 / floorElevAtRow), and
  // generation lerps floorNorth→floorSouth over y — so the low end sits at the
  // north, matching the real valley. (These values + the lerp arg order were
  // previously transposed: the names read "inverted" though the terrain drained
  // north correctly. Renamed truthfully; the generated elevation is unchanged.)
  floorSouth: 2000,
  floorNorth: 1550,
  ridgeHeight: 780,
};

/**
 * Coarse pathfinding factor: a coarse A* node spans COARSE_F × COARSE_F fine cells
 * (15 m at 5 m resolution). Shared with path.ts (the coarse pass + its corridor stamping)
 * so the two files can never drift apart on the value.
 */
export const COARSE_F = 3;
/**
 * Legacy foot-slope reference (rise/run, ≈51°). This was the hard passability cutoff; it is now the
 * START of a steep-but-slow climbing band, not a wall. Kept exported for probes that measure the old
 * regime (e.g. passability-probe's recover%). The TRUE impassable line is FOOT_CLIFF_SLOPE below.
 */
export const FOOT_MAX_SLOPE = 1.25;
/**
 * The TRUE foot-impassable slope (rise/run, ≈54.5°). Above this a loaded infantryman is on a rope, not
 * his feet — and it stays a hard, OBVIOUS cliff (the slope-keyed render shades everything above this as
 * a sheer wall). The band 1.25–1.40 (≈51–54.5°) is Rock/Scree/Boulder faces a soldier switchbacks up
 * slowly: now PASSABLE, which is what reconnects the steep terrain. The very steepest 1.40–1.50 (and the
 * Land.Cliff promotion at slope>1.5) stays impassable, so the genuine cliffs/real barriers remain.
 *
 * Why softening here is SAFE where the reverted issue-019 attempt was not, and why it is a PURE
 * passability change: passableCell is changed GLOBALLY, so the planner and the mover share ONE truth
 * (no planner/mover divergence — the cause of the reverted attempt's movement freeze), and the movement
 * COST curve (moveCostAt) is left bit-identical to HEAD (STEEP_COST_FLOOR stays 0.1). Measured: reach%
 * (gate-connected map) 48→61, route-quality flat (1.13→1.12), 0 stranded, and combat balance UNMOVED
 * (12×50 balance WIA 3.75→3.50, KIA 1.42→1.25). A first attempt that also lowered the cost floor to
 * widen the steep-band gradient was reverted — it slowed the sim ~1.5× and bloodied WIA +71% for no
 * op-route win (route-quality up a face is a directional-cost problem, handled separately). See
 * docs/issues/019.
 */
export const FOOT_CLIFF_SLOPE = 1.4;
/** Cost floor for the steepest passable cell. Kept at the original 0.1 so the movement-cost CURVE is
 *  bit-identical to HEAD — Change A reconnects the steep band via passability ONLY, leaving the
 *  hard-won movement economy and combat balance untouched (see FOOT_CLIFF_SLOPE note). */
export const STEEP_COST_FLOOR = 0.1;

// Directional cover-object query tuning (issue 020). Footprint (m) mirrors the asset manifest so the
// cover frontage matches the DRAWN sprite (drawn = sim); height (m) is the physical block height an
// object presents to a standing/prone silhouette. COVER_AHEAD_M is how far in front of the target an
// object can sit and still be "his cover"; COVER_BUCKET_M is the spatial-index cell for the per-shot query.
const COVER_OBJ_FOOTPRINT: Record<"boulder" | "rock-outcrop", number> = { boulder: 2.5, "rock-outcrop": 5 };
const COVER_OBJ_HEIGHT: Record<"boulder" | "rock-outcrop", number> = { boulder: 0.8, "rock-outcrop": 1.2 };
// INTRINSIC small-arms stop probability of the rock itself — a boulder stops a rifle round whatever
// cell it sits on, so the directional query uses this, NOT o.cover (which carries the cell's stamped
// value, kept low on open ground for field byte-identity). This is what makes an open-slope boulder
// real, usable cover; it is gated to the FIRE path + directionality so it can't grind (issue 020).
const COVER_OBJ_STOP: Record<"boulder" | "rock-outcrop", number> = { boulder: 0.62, "rock-outcrop": 0.72 };
const COVER_AHEAD_M = 3.5;
const COVER_BUCKET_M = 8;
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
  /** World-space centerlines of every laid path (valley MSR, village tracks, the COP access road, the
   *  goat trails, and the new switchback climbing trails), captured at generation so the renderer can
   *  stroke them as scaled lines that mold to the terrain — a 0.8 m goat-trail thread, a 2.5 m track, a
   *  4 m road — instead of the barely-visible, wrongly-5-m-wide landcover tint. `kind` sizes the stroke. */
  trailLines: { kind: "road" | "track" | "trail"; pts: Vec2[] }[] = [];
  /** Discrete micro-cover objects (boulders, rock outcrops) — the SINGLE source of truth that the
   *  combat cover field is stamped from AND the renderer draws, so the rock a soldier takes cover
   *  behind is the same one on screen (issue 020). Deterministic (hash-seeded from the static terrain),
   *  so it is NOT serialized — regenerated from seed with everything else. `cover`/`conceal` are the
   *  hard-cover / concealment the object lends the cell it sits in. */
  coverObjects: { x: number; y: number; id: "boulder" | "rock-outcrop"; scale: number; rot: number; cover: number; conceal: number }[] = [];
  /** Lazily-built spatial bucket index over coverObjects (derived, not serialized) for the per-shot
   *  directional cover query (issue 020). bucketKey → object indices. */
  private coverBuckets: Map<number, number[]> | null = null;
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
      // ty=0 is the NORTH mouth (low), ty=1 the SOUTH head (high) → drains north.
      const floor = lerp(floorNorth, floorSouth, ty) + ridgeNoise.fbm(2, ty * 4, 3) * 40;
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

    this.carveFloodplain(); // issue 010: a WALKABLE valley floor — the river is an obstacle, not a chasm
    this.computeSlope();
    this.classifyLand(rng, draws);
    this.placeVillagesAndCOP(rng);
    this.placeFords(rng); // issue 010: regular crossings BEFORE roads, so the network can route over them
    this.carveRoadsAndTrails(rng);
    this.ensureGatePortal(); // issue 005: guarantee the gate connects at coarse scale (locally)
    this.ensureRiverCrossings(); // issue 010: guarantee both banks join — add fords until the valley is one piece
    this.ensureNetworkConnectivity(); // issue 008: guarantee the gate connects to the MSR + villages
    this.ensureInteriorConnectivity(); // issue 012: every COP seat/fighting-position joins the muster yard (no sealed pockets). LAST, so its findPath checks see the final terrain (river/network carving can't re-sever the yard after).
    this.deriveCoverConcealment();
    this.generateCoverObjects(); // issue 020: discrete cover objects stamp the field + are what the renderer draws
    this.nameFeatures(rng);
  }

  /**
   * Issue 010 — the WALKABLE VALLEY FLOOR. Verified root cause of most stranded patrols: the
   * river ran in a deeply incised channel (the `riverCut` above carved a ~22 m, ~48 m-wide V into
   * the floor), so the cells flanking the water classified as Cliff (slope > 1.5). The static audit
   * measured 59% of river-adjacent cells impassable, thousands of "trap" cells (wade in, never climb
   * out), zero crossings, and 28% of seeds with the two banks in SEPARATE passable components — you
   * literally could not walk across the valley. Real mountain valleys have a walkable floodplain
   * flanking the stream; the stream itself is the obstacle, crossed at fords and footbridges. This
   * bench-grades a continuous floodplain band around the meandering centerline to a gentle profile
   * (killing the incision cliffs and the worst detail-noise spikes), leaving a shallow channel down
   * the middle for the water. The river is then made a real obstacle (passableCell) crossed only at
   * the fords/footbridges placed by placeFords + ensureRiverCrossings.
   */
  private carveFloodplain() {
    const { size, cellSize } = this;
    // Reach far enough to fully override the incision (riverCut reaches 2.4*(20/cs) cells), so no
    // incised cliff survives between the flat floor and the natural valley wall.
    const incisionReach = 2.4 * (20 / cellSize);
    const floodHalf = Math.max(incisionReach + 1, 45 / cellSize); // cells each side of the river
    const channelHalf = Math.max(1.4, 8 / cellSize); // = riverHalf in classifyLand (kept in sync)
    const channelDepth = 2.0; // m: a shallow channel so the banks stay walkable (≈0.4 slope per cell)
    const featherCells = 3.5; // ease the outer rim back to the natural hillside over this many cells
    const featherStart = floodHalf - featherCells;
    for (let y = 0; y < size; y++) {
      const cx = this.centerX[y];
      const floorE = this.floorElevAtRow(y);
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - cx);
        if (dx > floodHalf) continue;
        const i = this.idx(x, y);
        // Flat floodplain at the floor elevation, dipping to a shallow channel down the middle.
        const target = dx <= channelHalf ? floorE - channelDepth : floorE;
        // Full flatten across the band; feather only the outer rim so the floor ties into the
        // natural valley wall instead of leaving a hard step we'd merely have relocated outward.
        const w = dx <= featherStart ? 1 : clamp01(1 - (dx - featherStart) / featherCells);
        this.elev[i] = lerp(this.elev[i], target, w);
        if (this.elev[i] < this.minElev) this.minElev = this.elev[i];
      }
    }
  }

  /**
   * Issue 010 — lay regular FORDS across the river down the length of the valley, so the channel
   * (now a real obstacle) is always crossable within a short detour. A ford is a shallow gravel-bar
   * crossing: it spans the FULL channel width plus a cell onto each bank, is benched flat to the
   * bank so a man can walk onto it and climb out the far side, and is a few cells wide along the
   * river so a clean 15 m COARSE pathfinding node sits on it (the planner will route over it). It
   * moves at moveCost 0.5 (wading) with almost no cover — a real killing ground, the way a fording
   * site is in the valley. Placed BEFORE the roads so layTrack/findPath can route the network over
   * them; ensureRiverCrossings adds more later wherever the two banks are still split.
   */
  private placeFords(rng: RNG) {
    const { size, cellSize } = this;
    const spacing = Math.max(20, Math.round(260 / cellSize)); // a ford roughly every ~260 m of valley
    for (let y0 = spacing; y0 < size - spacing; y0 += spacing) {
      const y = clamp(y0 + rng.int(-(spacing >> 2), spacing >> 2), 4, size - 5);
      this.carveFordAt(y, 1);
    }
  }

  /** Carve one ford crossing centred on river row `yc`, spanning the full channel + a bank cell each
   *  side, over (2*halfAlong+1) rows so it forms a clean coarse-passable patch. Returns true if any
   *  tread was laid. Benches the tread flat to the local bank elevation; never overwrites a qalat,
   *  wall, structure or the wire. */
  private carveFordAt(yc: number, halfAlong: number): boolean {
    const { size, cellSize } = this;
    const channelHalf = Math.max(1.4, 8 / cellSize);
    const span = Math.ceil(channelHalf) + 1; // channel + one bank cell each side
    const bankE = this.floorElevAtRow(yc); // the floodplain sits at the floor elevation
    let laid = 0;
    for (let dy = -halfAlong; dy <= halfAlong; dy++) {
      const y = yc + dy;
      if (y < 0 || y >= size) continue;
      const cx = this.centerX[y];
      for (let dx = -span; dx <= span; dx++) {
        const x = Math.round(cx + dx);
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y);
        const l = this.land[i] as Land;
        if (l === Land.Compound || l === Land.CompoundWall || l === Land.Structure || l === Land.Hesco) continue;
        if (l === Land.Footbridge) { laid++; continue; } // a built bridge is already a crossing — keep it
        this.land[i] = Land.Ford;
        this.elev[i] = lerp(this.elev[i], bankE, 0.7);
        laid++;
      }
    }
    if (laid) this.computeSlopeLocal(Math.round(this.centerXAt(yc)), yc, span + halfAlong + 2);
    return laid > 0;
  }

  /** Diagnostics for the river-crossing guard (issue 010). */
  riverRepair?: { fordsAdded: number; passes: number; banksJoined: boolean };

  /**
   * Issue 010 — guarantee the two BANKS are one connected piece. With the river now a real obstacle,
   * a stretch with no crossing leaves the far bank walled off. The regular fords usually join the
   * valley already, but a ford can be pre-empted by a compound, or the floodplain pinched by a spur;
   * this samples reaches down the valley, and wherever a dry cell just west of the river is in a
   * DIFFERENT passable component from a dry cell just east, it carves a ford there — repeating until
   * every sampled reach connects across (or it runs out of passes). The cheap, robust analogue of
   * the gate-portal / network guards, for the water.
   */
  private ensureRiverCrossings() {
    const { size, cellSize } = this;
    const step = Math.max(8, Math.round(110 / cellSize));
    const rows: number[] = [];
    for (let y = step; y < size - step; y += step) rows.push(y);
    let fordsAdded = 0;
    let passes = 0;
    let stillSplit = false;
    for (let pass = 0; pass < 6; pass++) {
      passes = pass + 1;
      const comp = this.passableComponentMap();
      let carvedAny = false;
      stillSplit = false;
      for (const y of rows) {
        const cx = Math.round(this.centerXAt(y));
        const west = this.firstDryFrom(cx, y, -1);
        const east = this.firstDryFrom(cx, y, 1);
        if (!west || !east) continue;
        if (comp[west.y * size + west.x] !== comp[east.y * size + east.x]) {
          stillSplit = true;
          if (this.carveFordAt(y, 1)) { fordsAdded++; carvedAny = true; }
        }
      }
      if (!carvedAny) break; // either all reaches connect, or the rest are genuinely un-fordable
      this.computeSlope(); // benching reshaped the ground; the next pass's component map sees the fords
    }
    this.riverRepair = { fordsAdded, passes, banksJoined: !stillSplit };
  }

  /** 8-connected component labels over passableCell (-1 = impassable). Used by the river guard. */
  private passableComponentMap(): Int32Array {
    const { size } = this;
    const comp = new Int32Array(size * size).fill(-1);
    let id = 0;
    const stack: number[] = [];
    for (let s = 0; s < size * size; s++) {
      if (comp[s] !== -1 || !this.passableCell(s % size, (s / size) | 0)) continue;
      comp[s] = id;
      stack.length = 0;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % size, y = (i / size) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = ny * size + nx;
            if (comp[j] !== -1 || !this.passableCell(nx, ny)) continue;
            comp[j] = id;
            stack.push(j);
          }
      }
      id++;
    }
    return comp;
  }

  /** Step off the river from (cx,cy) in direction `dir` (±x) to the first passable, non-river,
   *  non-crossing dry cell — i.e. a true bank cell on that side. */
  private firstDryFrom(cx: number, cy: number, dir: number): { x: number; y: number } | null {
    for (let s = 1; s < 40; s++) {
      const x = cx + dir * s;
      if (x < 0 || x >= this.size) return null;
      const l = this.land[this.idx(x, cy)] as Land;
      if (l !== Land.River && l !== Land.Ford && l !== Land.Footbridge && this.passableCell(x, cy)) return { x, y: cy };
    }
    return null;
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
    return lerp(this.config.floorNorth, this.config.floorSouth, ty);
  }

  /**
   * The COP perimeter (wire) radius in CELLS — the SINGLE source of truth shared by
   * COP siting (R0, which reserves the footprint + clearance from villages) and the
   * actual build (buildCop's R). They MUST agree: if siting reserves a bigger circle
   * than buildCop stamps, the outpost is sited as if larger (over-clearing villages);
   * if smaller, a village can intersect the wire. ~60 m → a 120 m platoon-OP position
   * (was 85 m / 170 m — a FOB). Clamped to a sane platoon-OP band at any cell size.
   */
  copRadiusCells(): number {
    return clamp(Math.round(60 / this.cellSize), 11, 16);
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
      // Hamlet RADIUS in cells (30–50 m → a 60–100 m village of clustered qalats, vs the
      // old single 20–40 m compound). Bounded by the 2.56 km map + ~333 m village spacing +
      // 120 m COP; a real Korengal village spans 150–400 m, but this segment can't fit that
      // without overlap — a clear cluster is the honest improvement at this map scale.
      const sizeR = rng.int(6, 10);
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
    // Stamp village landcover as a HAMLET (issue 014 / 007): a CLUSTER of walled qalats,
    // orchards/terraces filling the benches between them, and a walled cemetery on the edge
    // — not one monolithic compound. The sub-compound layout is deterministic from the
    // village id (villageHamlet), so the renderer (R3) paints the SAME cluster, and every
    // qalat stays within vil.size, the footprint COP siting reserves clearance against.
    for (const vil of placed) {
      const ext = vil.size; // hamlet radius (cells)
      const cem = {
        x: vil.cx + rng.int(-ext - 2, ext + 2),
        y: vil.cy + rng.int(-ext - 2, ext + 2),
        r: rng.int(1, 2),
      };
      // 1) Orchards / terraces fill the whole hamlet footprint (qalats overwrite below).
      for (let dy = -ext - 4; dy <= ext + 4; dy++)
        for (let dx = -ext - 4; dx <= ext + 4; dx++) {
          const x = vil.cx + dx;
          const y = vil.cy + dy;
          if (!this.inBounds(x, y)) continue;
          const d = Math.hypot(dx, dy);
          const i = this.idx(x, y);
          if (this.land[i] === Land.River || this.slope[i] > 0.7) continue;
          if (d <= ext + 4 && this.slope[i] < 0.35) this.land[i] = rng.chance(0.55) ? Land.Orchard : Land.Terrace;
        }
      // 2) Stamp each qalat in the cluster (walled perimeter + interior courtyards),
      //    leaving the orchard alleys between them passable — the hamlet never seals the
      //    valley (ensureNetworkConnectivity + reachability verify this).
      for (const cmp of villageHamlet(vil)) {
        for (let dy = -cmp.r - 1; dy <= cmp.r + 1; dy++)
          for (let dx = -cmp.r - 1; dx <= cmp.r + 1; dx++) {
            const x = vil.cx + cmp.dx + dx;
            const y = vil.cy + cmp.dy + dy;
            if (!this.inBounds(x, y)) continue;
            const d = Math.hypot(dx, dy);
            const i = this.idx(x, y);
            if (this.land[i] === Land.River || this.slope[i] > 0.7) continue;
            if (d <= cmp.r) {
              this.land[i] = d > cmp.r - 1.1 ? Land.CompoundWall : Land.Compound;
              if (this.land[i] === Land.Compound && rng.chance(0.22)) this.land[i] = Land.Grass;
            }
          }
      }
      // 3) cemetery on the edge
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
    // The perimeter radius the COP will use (the SAME copRadiusCells() buildCop stamps,
    // so siting evaluates the actual apron the wire and its ring-road will occupy).
    const R0 = this.copRadiusCells();
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
    // Perimeter radius sized to a real platoon OP, not a brigade FOB (copRadiusCells:
    // ~60 m → a 120 m position, was 85 m / 170 m). A small Korengal-era outpost
    // (Restrepo, the KOP's core) was a ~100–130 m position conforming to a single bench;
    // Wanat's VPB Kahler was 300×100 m at the big end. The interior layout, ring road,
    // ECP apron and fighting positions are all fractions of R, so the camp scales
    // self-similarly; spaceCopBuildings + ensureInteriorConnectivity still guarantee
    // walkable streets at the tighter size (verified: cop-render 0 sealed pockets,
    // copstuck ~0 grind, copaudit clean). MUST equal the siting R0 above.
    const R = this.copRadiusCells();
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
    // Camp laid out along streets, not piled in one corner: the command cluster sits
    // central-REAR on the yard (a dead-centre TOC was 93% of the old "stuck on a building"
    // grind), the chow hall fronts the yard off the TOC, the two billet rows are slimmed to
    // 2-wide and pushed wide apart so a real gravel street runs between them, and the
    // latrines sit rearmost and downwind. These hand values are only a SEED — spaceCopBuildings
    // below enforces a walkable street (>=10 m) between every pair regardless of rounding, so
    // the interior is always one connected yard (no sealed courtyard a man can grind against).
    place("toc", "TOC", 0.3, 0.0, 2, 2); // command post, central-rear of the yard
    place("dfac", "Chow Hall", 0.05, 0.32, 2, 2); // chow fronts the yard, off the spine
    place("aid", "Aid Station", 0.05, -0.32, 2, 1); // aid station front-left
    place("armory", "Armory", 0.34, 0.46, 1, 2); // right flank
    place("latrine", "Latrines", 0.34, -0.5, 1, 1); // left flank, downwind
    place("barracks", "Barracks A", 0.6, 0.3, 2, 1); // billet rows to the rear,
    place("barracks", "Barracks B", 0.6, -0.26, 2, 1); //   a gravel street between them
    place("motorpool", "Motor Pool", -0.42, 0.42, 3, 2); // vehicles up front (Gravel, passable)
    // Open guaranteed streets between footprints BEFORE stamping them solid.
    this.spaceCopBuildings(buildings, c, R, gateDir);
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
      // Doctrine fields are filled by analyzeFightingPositions below; seed them so the type holds.
      fightingPositions.push({
        id: `fp-${fp}`, cx: snap.cx, cy: snap.cy, facing: a, tower: false,
        weapon: "rifle", leftLimit: a - Math.PI / 4, rightLimit: a + Math.PI / 4, avenueScore: 0, deadSpaceFrac: 0,
      });
      fp++;
    }
    // 6a') ECP OVERWATCH — a dedicated tower BESIDE the gate, set a couple of cells off the
    //      open lane just inside the wall, so its line to the entry approach threads the gap
    //      (a flanking wall position's sightline would cross the impassable HESCO and be blocked).
    //      ATP 3-21.8: the entry-control point is overwatched by fire. Markers are passable, so
    //      this never narrows the egress lane.
    {
      const goCell = { cx: Math.round(c.cx + gateDir.x * (R + 5)), cy: Math.round(c.cy + gateDir.y * (R + 5)) };
      // Try candidate spots beside the gate (varying depth + side) and pick the FIRST with clear
      // ground LOS to the entry approach — so a one-sided lip or a steep road can't blind it.
      const cands: Array<{ back: number; side: number }> = [
        { back: 3, side: 1.5 }, { back: 3, side: -1.5 }, { back: 3, side: 1 }, { back: 3, side: -1 },
        { back: 4, side: 2 }, { back: 4, side: -2 }, { back: 2, side: 1.5 }, { back: 2, side: -1.5 },
      ];
      let chosen: { cx: number; cy: number } | null = null;
      for (const k of cands) {
        const p = this.nearestPassable(
          Math.round(c.cx + gateDir.x * (R - k.back) + perp.x * k.side),
          Math.round(c.cy + gateDir.y * (R - k.back) + perp.y * k.side),
          3
        );
        if (!this.inBounds(p.cx, p.cy)) continue;
        if (!chosen) chosen = p; // fallback: the first valid spot even if LOS is imperfect
        if (this.groundLOS(p.cx, p.cy, goCell.cx, goCell.cy)) { chosen = p; break; }
      }
      if (chosen) {
        fightingPositions.push({
          id: "fp-ecp", cx: chosen.cx, cy: chosen.cy, facing: ga, tower: true,
          weapon: "rifle", leftLimit: ga - Math.PI / 4, rightLimit: ga + Math.PI / 4, avenueScore: 0, deadSpaceFrac: 0,
        });
      }
    }
    // ATP 3-21.8 ch.5: score each position's avenue by a terrain LOS sweep, then site the
    // crew-served weapons + towers + interlocking sectors by that geometry (not blind index).
    this.analyzeFightingPositions(fightingPositions, c, R);

    // 6b) Mortar pit — dug in to the rear of the yard for defilade (ATP 3-21.8 / FM 3-22.90), but
    //     held CLOSE to centre: the 60 mm has a 70 m MIN range, the wire is only ~60 m, so an
    //     offset pit can't range its own near approaches. A ≤3-cell (15 m) rear offset keeps the
    //     whole just-outside-the-wire assault band within minimum range from the gun.
    const mortarPit = this.nearestPassable(
      Math.round(c.cx - gateDir.x * 3),
      Math.round(c.cy - gateDir.y * 3),
      5
    );
    // 6c) Final Protective Fires registered on the MOST DANGEROUS avenue — the sector with the
    //     most dead space. Pushed OUT just far enough that it clears the mortar's 70 m minimum
    //     range FROM THE PIT (else the watch would request fire the tube physically can't deliver).
    const worst = fightingPositions.reduce(
      (a, b) => (b.deadSpaceFrac > a.deadSpaceFrac ? b : a),
      fightingPositions[0] ?? { facing: ga + Math.PI, deadSpaceFrac: 0 }
    );
    const fpfBear = worst ? worst.facing : ga + Math.PI;
    let fpf = { cx: Math.round(c.cx + Math.cos(fpfBear) * (R + 4)), cy: Math.round(c.cy + Math.sin(fpfBear) * (R + 4)) };
    for (let extra = 0; extra <= 12; extra++) {
      const rr = R + 4 + extra;
      const fx = Math.round(c.cx + Math.cos(fpfBear) * rr);
      const fy = Math.round(c.cy + Math.sin(fpfBear) * rr);
      fpf = { cx: fx, cy: fy };
      const dM = Math.hypot(fx - mortarPit.cx, fy - mortarPit.cy) * this.cellSize;
      if (dM >= 85) break; // ≥ 70 m min range + margin
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
      mortarPit,
      fpf,
      buildings,
      fightingPositions,
    };

    this.computeSlopeLocal(c.cx, c.cy, FR + 1);
  }

  /**
   * Doctrine-aware fighting-position analysis (ATP 3-21.8 ch.5, "defense"). For each
   * position we sweep its outward sector with a terrain-elevation line-of-sight march and
   * measure (a) how far down its avenue the gun can graze before terrain masks the ground —
   * the *avenue score* — and (b) how much of the arc falls into dead space (defilade the
   * direct-fire guns can't reach). Crew-served weapons are then sited by that geometry, the
   * way a real platoon would emplace them:
   *   • the M2 .50 cal (1830 m) takes the LONGEST open avenue,
   *   • the M240 (1100 m) the next-longest,
   *   • the Mk19 grenade launcher — whose 40 mm PLUNGES — takes the WORST dead-space sector,
   *     exactly where direct grazing fire fails and only high-angle fire reaches.
   * Towers go on the two key crew-served avenues for observation; the rest are riflemen.
   * Interlocking sectors are set so adjacent positions overlap (no un-grazed frontage).
   * This is pure seeded geometry over the baked elevation — no rng, no wall clock — so it
   * regenerates bit-identically on load (it lives on `cop`, which is never serialized).
   */
  /** Cheap terrain-elevation line of sight from an observer (eye `eyeH` above the deck) to a
   *  ground point: blocked if any intervening cell's crest rises above the sightline. Used to
   *  site the ECP overwatch on ground that can actually SEE the entry approach. Deterministic. */
  private groundLOS(ax: number, ay: number, bx: number, by: number, eyeH = 1.6): boolean {
    if (!this.inBounds(ax, ay) || !this.inBounds(bx, by)) return false;
    const e0 = this.elev[this.idx(ax, ay)] + eyeH;
    const D = Math.hypot(bx - ax, by - ay) * this.cellSize;
    if (D < 1) return true;
    const steps = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay)));
    let maxAng = -Infinity;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cx = Math.round(ax + (bx - ax) * t);
      const cy = Math.round(ay + (by - ay) * t);
      if (!this.inBounds(cx, cy)) return false;
      const ang = (this.elev[this.idx(cx, cy)] - e0) / (D * t);
      if (ang > maxAng) maxAng = ang;
    }
    const targetAng = (this.elev[this.idx(bx, by)] - e0) / D;
    return targetAng >= maxAng - 0.02;
  }

  private analyzeFightingPositions(fps: CopFightingPosition[], c: { cx: number; cy: number }, R: number) {
    if (fps.length === 0) return;
    const REF = 1830; // m — score every gun on the .50's reach so positions are comparable
    const STEP = this.cellSize; // march one cell outward at a time
    const EYE = 1.2; // gun height above the deck (m)
    const ARC = Math.PI / 4; // ±45° primary sector swept for scoring
    const DA = ARC / 7; // angular sample step (~6.4°)
    const EPS = 0.012; // ~0.7° horizon tolerance

    // ---- (a) terrain LOS sweep: avenue reach + dead-space fraction per position ----
    for (const f of fps) {
      const e0 = this.elev[this.idx(f.cx, f.cy)] + EYE;
      let sumReach = 0, dead = 0, total = 0, rays = 0;
      for (let da = -ARC; da <= ARC + 1e-6; da += DA) {
        const a = f.facing + da;
        const dx = Math.cos(a), dy = Math.sin(a);
        let horizon = -Infinity, lastVis = 0;
        for (let r = STEP; r <= REF; r += STEP) {
          const cx = Math.round(f.cx + (dx * r) / this.cellSize);
          const cy = Math.round(f.cy + (dy * r) / this.cellSize);
          if (!this.inBounds(cx, cy)) break;
          const ang = (this.elev[this.idx(cx, cy)] - e0) / r; // elevation angle to this ground point
          total++;
          if (ang >= horizon - EPS) {
            lastVis = r; // clears every closer crest → the gun can graze ground out to here
            if (ang > horizon) horizon = ang;
          } else {
            dead++; // masked by a nearer rise → defilade
          }
        }
        sumReach += lastVis;
        rays++;
      }
      f.avenueScore = rays ? sumReach / rays : 0;
      f.deadSpaceFrac = total ? dead / total : 0;
    }

    // ---- (b) site the crew-served weapons + towers by that geometry ----
    for (const f of fps) { f.weapon = "rifle"; f.tower = false; }
    const taken = new Set<string>();
    const give = (f: CopFightingPosition | undefined, w: CopWeapon, tower: boolean) => {
      if (!f || taken.has(f.id)) return;
      f.weapon = w;
      if (tower) f.tower = true;
      taken.add(f.id);
    };
    // The ECP overwatch tower holds the gate; the heavy guns go on the perimeter avenues, sited by
    // terrain reach: the M2 on the longest open avenue, the M240 next. (A threat-weighted variant —
    // biasing the guns toward the nearest village — was built + audit-verified but REVERTED: it
    // moved guns onto lower-LOS positions and measurably raised patrol casualties for marginal gain.
    // See docs/progress/2026-06-08-cop-defense-audit/. The Mk19 still plunges into the worst dead ground.)
    const pool = fps.filter((f) => f.id !== "fp-ecp");
    const byHeavy = [...pool].sort((a, b) => b.avenueScore - a.avenueScore);
    give(byHeavy[0], "m2", true);
    give(byHeavy.find((f) => !taken.has(f.id)), "m240", true);
    const byDead = [...pool].filter((f) => !taken.has(f.id)).sort((a, b) => b.deadSpaceFrac - a.deadSpaceFrac);
    give(byDead[0], "mk19", false); // grenade launcher plunges into the worst dead ground
    const ecpFp = fps.find((f) => f.id === "fp-ecp");
    if (ecpFp) ecpFp.tower = true; // restore the ECP overwatch tower (the reset above cleared it)

    // ---- (c) interlocking sectors with NO un-grazed frontage, INCLUDING over the gate ----
    // A sector defined around a position's radial facing does NOT line up with the perimeter
    // azimuths it must cover — a position on the wire sees a wire point at a different azimuth
    // along a skewed (parallax) bearing, so naive ±half sectors leave a gap (worst at the gate,
    // where the flanking positions are far apart). Instead, aim each limit at the WIRE MIDPOINT
    // between this position and its azimuthal neighbour, expressed as the bearing FROM this
    // position — so adjacent sectors MEET exactly on the wire (with a small overlap). The two
    // gate-flanking positions therefore interlock across the open gate. (ATP 3-21.8: interlocking
    // fires, no dead frontage.)
    const TWO_PI = Math.PI * 2;
    const OVER = 0.12; // overlap at the meeting point (~7°)
    const cw = this.cellCenter(c.cx, c.cy);
    const wireR = (R + 2) * this.cellSize;
    const az = (f: CopFightingPosition) => {
      const p = this.cellCenter(f.cx, f.cy);
      return Math.atan2(p.y - cw.y, p.x - cw.x);
    };
    const sorted = [...fps].sort((a, b) => az(a) - az(b));
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      const f = sorted[i];
      if (n === 1) {
        f.leftLimit = f.facing + Math.PI / 3;
        f.rightLimit = f.facing - Math.PI / 3;
        continue;
      }
      const fpW = this.cellCenter(f.cx, f.cy);
      const next = sorted[(i + 1) % n];
      const prev = sorted[(i - 1 + n) % n];
      const azF = az(f);
      const dNext = ((az(next) - azF) % TWO_PI + TWO_PI) % TWO_PI;
      const dPrev = ((azF - az(prev)) % TWO_PI + TWO_PI) % TWO_PI;
      const mNext = azF + dNext / 2; // azimuth of the wire midpoint toward the CCW neighbour
      const mPrev = azF - dPrev / 2; // ... toward the CW neighbour
      const pNext = { x: cw.x + Math.cos(mNext) * wireR, y: cw.y + Math.sin(mNext) * wireR };
      const pPrev = { x: cw.x + Math.cos(mPrev) * wireR, y: cw.y + Math.sin(mPrev) * wireR };
      f.leftLimit = Math.atan2(pNext.y - fpW.y, pNext.x - fpW.x) + OVER; // CCW edge
      f.rightLimit = Math.atan2(pPrev.y - fpW.y, pPrev.x - fpW.x) - OVER; // CW edge
    }
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
    this._gateReachable = undefined; // carving changed terrain — drop the memoised reachability mask
  }

  /** Diagnostics for the gen-time network connectivity guard (issue 008). */
  netRepair?: { carvedCells: number; villagesConnected: number; villages: number; passes: number };

  /** Diagnostics for the COP interior connectivity guard (issue 012). */
  interiorRepair?: { passes: number; carvedCells: number; sealedCells: number; relocatedFPs: number };

  /**
   * Open guaranteed STREETS between COP building footprints (issue 012). The buildings start at
   * hand-tuned positions; this pushes any pair that is closer than MIN_GAP cells apart, outward
   * along its centre->building bearing, and keeps every footprint wholly inside R-3 (clear of the
   * HESCO wall band). If a pair still touches after the budget (a very tight wire), the lower-priority
   * footprint is shrunk a cell. Pure integer geometry over the FIXED buildings[] order and no RNG —
   * so it is bit-identical across replays and never perturbs the seeded stream the rest of gen uses.
   *
   * Why streets first, then a connectivity guard: spacing removes the CAUSE (touching footprints that
   * seal courtyards) cheaply on every seed; the guard (ensureInteriorConnectivity) is then only the
   * insurance for the residue a slope-sealed or wall-pinched pocket can still leave.
   */
  private spaceCopBuildings(buildings: CopBuilding[], c: { cx: number; cy: number }, R: number, gateDir: Vec2) {
    const MIN_GAP = 2; // >=10 m walkable street between any two footprints
    const solids = buildings.filter((b) => b.kind !== "motorpool"); // the motor pool is passable gravel
    const gap = (a: CopBuilding, b: CopBuilding) =>
      Math.max(Math.abs(a.cx - b.cx) - (a.hw + b.hw), Math.abs(a.cy - b.cy) - (a.hh + b.hh)); // matches minBuildingGap
    const farther = (b: CopBuilding) => Math.hypot(b.cx - c.cx, b.cy - c.cy);
    const clampInside = (b: CopBuilding) => {
      let guard = 0;
      while (guard++ < 40) {
        const corner = Math.max(
          Math.hypot(b.cx + b.hw - c.cx, b.cy + b.hh - c.cy),
          Math.hypot(b.cx - b.hw - c.cx, b.cy + b.hh - c.cy),
          Math.hypot(b.cx + b.hw - c.cx, b.cy - b.hh - c.cy),
          Math.hypot(b.cx - b.hw - c.cx, b.cy - b.hh - c.cy)
        );
        if (corner <= R - 3) break;
        b.cx += b.cx < c.cx ? 1 : b.cx > c.cx ? -1 : 0; // step toward centre (deterministic integer)
        b.cy += b.cy < c.cy ? 1 : b.cy > c.cy ? -1 : 0;
      }
    };
    void gateDir;
    for (let pass = 0; pass < 24; pass++) {
      let moved = false;
      for (let i = 0; i < solids.length; i++)
        for (let j = i + 1; j < solids.length; j++) {
          const a = solids[i];
          const b = solids[j];
          if (gap(a, b) >= MIN_GAP) continue;
          // gap = max(xSep, ySep): clearing EITHER axis is enough, so separate along whichever
          // axis is closest to clearing. Push both apart one cell along that axis (away from each
          // other), then re-contain. This works for any bearing — two footprints on the same radial
          // (the old failure) separate cleanly because we move along the axis, not the radius.
          const xSep = Math.abs(a.cx - b.cx) - (a.hw + b.hw);
          const ySep = Math.abs(a.cy - b.cy) - (a.hh + b.hh);
          if (xSep >= ySep) {
            const dir = a.cx <= b.cx ? -1 : 1; // a moves one way, b the other
            a.cx += dir;
            b.cx -= dir;
          } else {
            const dir = a.cy <= b.cy ? -1 : 1;
            a.cy += dir;
            b.cy -= dir;
          }
          clampInside(a);
          clampInside(b);
          moved = true;
        }
      if (!moved) break; // converged
    }
    for (const b of solids) clampInside(b); // final containment guarantee
    // If a pair STILL touches (R too small for the footprints), shrink the lower-priority one.
    const order = ["toc", "aid", "armory", "dfac", "barracks", "latrine"];
    const prio = (b: CopBuilding) => order.indexOf(b.kind);
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++) {
        let guard = 0;
        while (gap(solids[i], solids[j]) < MIN_GAP && guard++ < 4) {
          const lo = prio(solids[i]) >= prio(solids[j]) ? solids[i] : solids[j];
          if (lo.hw > 1) lo.hw--;
          else if (lo.hh > 1) lo.hh--;
          else break;
        }
      }
  }

  /**
   * The INTERIOR twin of ensureGatePortal (issue 012). Floods passable interior cells from the muster
   * yard (honouring the mover's anti-corner-cut rule, so it matches what findPath can actually walk)
   * and, for any garrison seat / fighting position NOT reached, carves the MINIMAL benched doorway
   * (Structure -> Gravel) toward the muster — NEVER the HESCO wire, a compound, the LZ or the motor
   * pool. Any residual passable pocket that still has no seat in it is filled SOLID so no wandering
   * man can ever be funnelled into a dead end. Deterministic: integer cell math, fixed iteration
   * order, zero RNG. The root cause was a man assigned (or funnelled) to ground his squad's billet
   * sat behind a wall of other buildings with no walkable route — he ground the wall forever.
   */
  private ensureInteriorConnectivity() {
    const cop = this.cop;
    if (!cop) return;
    const c = cop.center;
    const R = cop.radius;
    const size = this.size;
    const baseE = this.elev[this.idx(c.cx, c.cy)];
    const inWire = (x: number, y: number) => Math.hypot(x - c.cx, y - c.cy) <= R - 1;

    const flood = (): Uint8Array => {
      const seen = new Uint8Array(size * size);
      const s = this.nearestPassable(cop.muster.cx, cop.muster.cy, 6);
      if (!this.passableCell(s.cx, s.cy)) return seen;
      seen[this.idx(s.cx, s.cy)] = 1;
      const st = [this.idx(s.cx, s.cy)];
      while (st.length) {
        const i = st.pop()!;
        const x = i % size;
        const y = (i / size) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (!this.inBounds(nx, ny) || !inWire(nx, ny) || !this.passableCell(nx, ny)) continue;
            if (dx && dy && !this.passableCell(x + dx, y) && !this.passableCell(x, y + dy)) continue; // no corner-cut
            const j = ny * size + nx;
            if (seen[j]) continue;
            seen[j] = 1;
            st.push(j);
          }
      }
      return seen;
    };

    // The garrison sends men to building SEATS (yard-side doorways, inside R-3). These we connect by
    // carving a door. Fighting positions sit ON the berm (R-3 ring) and a gunner SPAWNS on his (the MG
    // emplacement is fps[0]/fps[1]) — we never carve to the ring (that would bleed the wall), we
    // RELOCATE an unreachable one a few cells inward to reachable berm instead.
    const seatCells = (): { cx: number; cy: number }[] => {
      const out: { cx: number; cy: number }[] = [];
      for (const b of cop.buildings) {
        if (b.kind === "motorpool") continue;
        const sW = this.buildingSeat(b);
        out.push(this.nearestPassable(Math.floor(sW.x / this.cellSize), Math.floor(sW.y / this.cellSize), 3));
      }
      return out;
    };

    // Footprints we must never seal over (passable by design) — the LZ pad and the motor pool.
    const protectedRect = (x: number, y: number): boolean => {
      for (const b of cop.buildings) {
        if (b.kind !== "motorpool") continue;
        if (Math.abs(x - b.cx) <= b.hw && Math.abs(y - b.cy) <= b.hh) return true;
      }
      const lz = cop.lz;
      return Math.abs(x - lz.cx) <= 3 && Math.abs(y - lz.cy) <= 3;
    };

    // Target cells (seat doorways + fighting positions): a region holding one must be CONNECTED, never
    // sealed — that is where the garrison actually sends men.
    const SLIVER = 9; // a passable orphan region with fewer cells than this and no post = harmless; seal it
    const centre = this.nearestPassable(c.cx, c.cy, 4);

    // 1) Make the WHOLE interior one walkable yard. Each pass: flood from the muster (anti-corner-cut,
    //    matching the planner), enumerate the unreachable passable components, and carve a widening
    //    benched lane from each LARGE one (or any holding a post) toward the centre — bridging whatever
    //    severs it (a steep internal rise split survey-44's yard in half). This is the real guarantee:
    //    no man can ever be standing in a region disconnected from his posts, because there are none.
    let passes = 0;
    let carved = 0;
    for (passes = 0; passes < 12; passes++) {
      const reach = flood();
      const targetIdx = new Set<number>();
      for (const s of seatCells()) if (this.inBounds(s.cx, s.cy)) targetIdx.add(this.idx(s.cx, s.cy));
      for (const f of cop.fightingPositions) if (this.inBounds(f.cx, f.cy)) targetIdx.add(this.idx(f.cx, f.cy));
      // enumerate unreachable passable interior components
      const seen = new Uint8Array(size * size);
      const comps: { rep: number; size: number; hasTarget: boolean; minIdx: number }[] = [];
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const x = c.cx + dx;
          const y = c.cy + dy;
          if (!this.inBounds(x, y) || !inWire(x, y) || !this.passableCell(x, y)) continue;
          const i = this.idx(x, y);
          if (reach[i] || seen[i]) continue;
          let count = 0;
          let hasTarget = false;
          let rep = i;
          let repD = Infinity;
          let minIdx = i;
          seen[i] = 1;
          const st = [i];
          while (st.length) {
            const cur = st.pop()!;
            count++;
            if (targetIdx.has(cur)) hasTarget = true;
            if (cur < minIdx) minIdx = cur;
            const cx2 = cur % size;
            const cy2 = (cur / size) | 0;
            const d = Math.hypot(cx2 - centre.cx, cy2 - centre.cy);
            if (d < repD) {
              repD = d;
              rep = cur;
            }
            for (let ey = -1; ey <= 1; ey++)
              for (let ex = -1; ex <= 1; ex++) {
                if (!ex && !ey) continue;
                const nx = cx2 + ex;
                const ny = cy2 + ey;
                if (!this.inBounds(nx, ny) || !inWire(nx, ny) || !this.passableCell(nx, ny)) continue;
                if (ex && ey && !this.passableCell(cx2 + ex, cy2) && !this.passableCell(cx2, cy2 + ey)) continue;
                const j = ny * size + nx;
                if (reach[j] || seen[j]) continue;
                seen[j] = 1;
                st.push(j);
              }
          }
          comps.push({ rep, size: count, hasTarget, minIdx });
        }
      const mustConnect = comps.filter((cm) => cm.size >= SLIVER || cm.hasTarget).sort((a, b) => a.minIdx - b.minIdx);
      if (mustConnect.length === 0) break; // only small post-free slivers remain — sealed below
      const half = Math.min(Math.floor(passes / 2), 2); // 1-cell, then 3-cell, then 5-cell lanes
      for (const cm of mustConnect) {
        const rx = cm.rep % size;
        const ry = (cm.rep / size) | 0;
        // Carve toward the NEAREST already-muster-reachable cell (not the geometric centre — the centre
        // itself may be in the disconnected half, as on survey-44). This is the shortest real bridge to
        // the muster's component, so the flood strictly grows every pass and the loop converges.
        let tgt = { cx: centre.cx, cy: centre.cy };
        let found = false;
        for (let rr = 1; rr <= 2 * R && !found; rr++)
          for (let dy = -rr; dy <= rr && !found; dy++)
            for (let dx = -rr; dx <= rr; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
              const nx = rx + dx;
              const ny = ry + dy;
              if (this.inBounds(nx, ny) && reach[ny * size + nx]) {
                tgt = { cx: nx, cy: ny };
                found = true;
                break;
              }
            }
        carved += this.carveInteriorDoor(rx, ry, tgt.cx, tgt.cy, baseE, half);
      }
      this.computeSlopeLocal(c.cx, c.cy, R + 2);
      this._gateReachable = undefined;
    }

    // 2) Relocate any fighting position not in the connected yard inward to the nearest reachable cell
    //    (using the FLOOD — the true anti-corner-cut oracle, immune to findPath's degenerate "walk
    //    straight into the wall" fallback). The MG gunner spawns on fps[0]/fps[1], so this also frees him.
    let relocated = 0;
    {
      const reach = flood();
      for (const f of cop.fightingPositions) {
        if (this.inBounds(f.cx, f.cy) && reach[this.idx(f.cx, f.cy)]) continue;
        let best: { cx: number; cy: number } | null = null;
        for (let r = 1; r <= R && !best; r++)
          for (let dy = -r; dy <= r && !best; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring at radius r
              const nx = f.cx + dx;
              const ny = f.cy + dy;
              if (this.inBounds(nx, ny) && inWire(nx, ny) && reach[this.idx(nx, ny)]) {
                best = { cx: nx, cy: ny };
                break;
              }
            }
        if (best) {
          f.cx = best.cx;
          f.cy = best.cy;
          relocated++;
        }
      }
    }

    // 3) Seal the small post-free slivers left over (passable, unreachable, no post) so a man can never
    //    be funnelled into a dead-end nook. Phase 1 already connected everything large/with-a-post, so
    //    this only ever closes tiny dead corners — never a region a man works in.
    const reach = flood();
    const nearTarget = (x: number, y: number): boolean => {
      for (const f of cop.fightingPositions) if (Math.abs(x - f.cx) <= 2 && Math.abs(y - f.cy) <= 2) return true;
      for (const s of seatCells()) if (Math.abs(x - s.cx) <= 2 && Math.abs(y - s.cy) <= 2) return true;
      return false;
    };
    let sealed = 0;
    const musterI = this.idx(cop.muster.cx, cop.muster.cy);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = c.cx + dx;
        const y = c.cy + dy;
        if (!this.inBounds(x, y) || !inWire(x, y) || !this.passableCell(x, y)) continue;
        const i = this.idx(x, y);
        if (reach[i] || i === musterI || protectedRect(x, y) || nearTarget(x, y)) continue;
        if (this.interiorComponentSize(x, y, SLIVER) >= SLIVER) continue; // never seal a large region
        this.land[i] = Land.Structure; // tiny orphan dead corner — make it solid
        this.elev[i] = baseE;
        sealed++;
      }
    if (sealed) {
      this.computeSlopeLocal(c.cx, c.cy, R + 2);
      this._gateReachable = undefined;
    }
    this.interiorRepair = { passes, carvedCells: carved, sealedCells: sealed, relocatedFPs: relocated };
  }

  /**
   * Carve a benched Gravel lane (half-width `half`: 0 => 1 cell, 1 => 3 cells, ...) from (x0,y0)
   * toward (x1,y1) (issue 012). Punches THROUGH a building's Structure (that IS the door) but never
   * the HESCO wire or a village compound, and stays inside R-3 so it can never bleed into the wall
   * band / ring road. A WIDER lane is what bridges a STEEP internal divider: a 1-cell benched line
   * stays steep because slope is a forward-difference of its still-high neighbours, so we widen the
   * lane (like ensureGatePortal) until the benched ground genuinely reads passable. Returns cells cut.
   */
  private carveInteriorDoor(x0: number, y0: number, x1: number, y1: number, baseE: number, half = 0): number {
    const cop = this.cop!;
    const c = cop.center;
    const R = cop.radius;
    const steps = (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1) * 2;
    let n = 0;
    for (let s = 0; s <= steps; s++) {
      const bx = lerp(x0, x1, s / steps);
      const by = lerp(y0, y1, s / steps);
      for (let h = -half; h <= half; h++)
        for (let g = -half; g <= half; g++) {
          const x = Math.round(bx + h);
          const y = Math.round(by + g);
          if (!this.inBounds(x, y)) continue;
          if (Math.hypot(x - c.cx, y - c.cy) > R - 3) continue; // never touch the wall band / ring
          const i = this.idx(x, y);
          const l = this.land[i] as Land;
          if (l === Land.Hesco || l === Land.Compound || l === Land.CompoundWall) continue; // never wire / qalat
          if (l !== Land.Gravel) n++;
          this.land[i] = Land.Gravel;
          this.elev[i] = lerp(this.elev[i], baseE, 0.85); // bench flat so slope<1.25 -> passable
        }
    }
    return n;
  }

  /** Size of the connected passable component containing (sx,sy), capped at `cap` (8-connected, no
   *  corner-cut) — used to tell a small orphan sliver (seal it solid) from a large severed yard
   *  (never seal — connect it instead). */
  private interiorComponentSize(sx: number, sy: number, cap: number): number {
    const size = this.size;
    if (!this.passableCell(sx, sy)) return 0;
    const seen = new Set<number>([sy * size + sx]);
    const st = [sy * size + sx];
    let count = 0;
    while (st.length && count < cap) {
      const cur = st.pop()!;
      count++;
      const x = cur % size;
      const y = (cur / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny) || !this.passableCell(nx, ny)) continue;
          if (dx && dy && !this.passableCell(x + dx, y) && !this.passableCell(x, y + dy)) continue;
          const j = ny * size + nx;
          if (seen.has(j)) continue;
          seen.add(j);
          st.push(j);
        }
    }
    return count;
  }

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
          // Honour the SAME anti-corner-cut rule the planner's coarse A* uses (path.ts): a diagonal
          // step is forbidden when both orthogonal coarse neighbours are blocked. Without this the
          // guard's flood credited a diagonal-only coarse crossing that findPath can't actually
          // transit, so it skipped carving a Track to a village the squad then couldn't reach
          // (issue 008 / hunt #8). Now the guard's "reachable" matches the planner's.
          if (dx !== 0 && dy !== 0 && !open(x + dx, y) && !open(x, y + dy)) continue;
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
    const line: Vec2[] = [this.cellCenter(sCx, sCy)]; // centerline for the renderer's scaled path stroke
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
      line.push(this.cellCenter(clamp(Math.round(nx), 0, size - 1), clamp(Math.round(ny), 0, size - 1)));
      const offAxis = (nx - (sCx + 0.5)) * -ay + (ny - (sCy + 0.5)) * ax;
      if (Math.abs(offAxis) > swHalf) side = offAxis > 0 ? -1 : 1;
      px = nx;
      py = ny;
    }
    this.gradeCorridor(Math.round(px), Math.round(py), targetX, targetY, half, land);
    line.push(this.cellCenter(targetX, targetY));
    this.trailLines.push({ kind: land === Land.Road ? "road" : "track", pts: line });
    return { cx: Math.round(px), cy: Math.round(py) };
  }

  /**
   * Grade a terrain-following foot TRAIL UP toward an arbitrary high destination (a ridgetop / OP
   * shoulder), switchbacking across the fall line where a direct climb would exceed `maxGrade`. The
   * inverse of descendTrack: the design elevation RISES toward the destination and the steep-section
   * heading follows the UPHILL gradient, so the tread is benched into the hillside at a walkable grade
   * the whole way (this is what lets the planner — and a soldier — climb a face by switchbacks instead
   * of ringing the spur). Returns the centerline (world points) for the renderer. Deterministic: the
   * initial hairpin side comes from `sideSeed` (an int), so laying trails adds NO rng draw and never
   * perturbs the seed stream.
   */
  private ascendTrail(startCx: number, startCy: number, destCx: number, destCy: number, half: number, maxGrade: number, land: Land, sideSeed: number): Vec2[] {
    const size = this.size;
    const sCx = clamp(startCx, 0, size - 1);
    const sCy = clamp(startCy, 0, size - 1);
    const startE = this.elev[this.idx(sCx, sCy)];
    const destE = this.elev[this.idx(clamp(destCx, 0, size - 1), clamp(destCy, 0, size - 1))];
    const climbTarget = Math.min(destE - startE, 180); // gain at most ~180 m — a trail, not an expedition
    const stepCells = 1.4;
    // axis = the general uphill direction (toward the destination) — switchbacks are measured off it
    const axisLen = Math.hypot(destCx - sCx, destCy - sCy) || 1;
    const ax = (destCx - sCx) / axisLen;
    const ay = (destCy - sCy) / axisLen;
    const swHalf = 11;
    let px = sCx + 0.5;
    let py = sCy + 0.5;
    let side = sideSeed & 1 ? 1 : -1;
    // Climb the local spur by switchbacks, ALWAYS staying on passable ground: at each step, if the
    // preferred heading would land on a cliff (impassable cell), deflect toward the contour / hairpin
    // until a walkable step is found; if genuinely boxed in, the trail ends there (a real trail dead-ends
    // at a cliff, it doesn't cross it). The route is then surface-laid (light conform, never a trench) —
    // Change A already made the 1.25–1.40 band it climbs through passable, so the tread is walkable.
    const line: Vec2[] = [this.cellCenter(sCx, sCy)];
    const passAt = (fx: number, fy: number) => this.passableCell(clamp(Math.round(fx), 0, size - 1), clamp(Math.round(fy), 0, size - 1));
    let bestE = startE; // highest elevation reached — a trail climbs, it doesn't wander
    let stall = 0; // steps since we last gained new height (a contour wander along a cliff base)
    for (let iter = 0; iter < 220; iter++) {
      const cxi = clamp(Math.round(px), 0, size - 1);
      const cyi = clamp(Math.round(py), 0, size - 1);
      const hereE = this.elev[this.idx(cxi, cyi)];
      if (hereE - startE >= climbTarget) break; // gained enough height — at the shoulder
      if (hereE > bestE + 0.3) { bestE = hereE; stall = 0; } else stall++;
      if (stall > 36) break; // not gaining height (boxed against a cliff band) — end the trail here
      if (hereE < bestE - 35) break; // descending well below our high point — stop, a trail doesn't drop
      const g = this.gradientCells(px, py); // points UPHILL
      const gl = Math.hypot(g.x, g.y);
      if (gl < 1e-3) break; // flat / summit — nowhere left to climb
      const fx = g.x / gl;
      const fy = g.y / gl;
      const localSlope = this.slope[this.idx(cxi, cyi)];
      // base heading: climb straight up where gentle, else traverse the contour with a little climb
      let cxr = -fy; // contour (perpendicular to fall line)
      let cyr = fx;
      if (Math.sign(cxr * -ay + cyr * ax) !== side) {
        cxr = -cxr;
        cyr = -cyr;
      }
      const climbMix = localSlope <= maxGrade ? 0.95 : 0.36; // straight up on gentle ground; on a steep
      // face, traverse with a firm ~35% climb component so the switchback gains height like a real goat
      // trail (a dozen hairpins to a shoulder), instead of an endless near-level contour scribble.
      // try the preferred heading, then progressively more contour-hugging, then a hairpin, until walkable
      const tries = [climbMix, 0.1, 0.0, -0.12];
      let stepped = false;
      for (let attempt = 0; attempt < 2 && !stepped; attempt++) {
        for (const mix of tries) {
          let hx = cxr * (1 - Math.abs(mix)) + fx * mix;
          let hy = cyr * (1 - Math.abs(mix)) + fy * mix;
          const hl = Math.hypot(hx, hy) || 1;
          hx /= hl;
          hy /= hl;
          const nx = px + hx * stepCells;
          const ny = py + hy * stepCells;
          if (!passAt(nx, ny)) continue;
          const last = line[line.length - 1];
          const ncW = this.cellCenter(clamp(Math.round(nx), 0, size - 1), clamp(Math.round(ny), 0, size - 1));
          if (ncW.x !== last.x || ncW.y !== last.y) line.push(ncW);
          const offAxis = (nx - (sCx + 0.5)) * -ay + (ny - (sCy + 0.5)) * ax;
          if (Math.abs(offAxis) > swHalf) side = offAxis > 0 ? -1 : 1;
          px = nx;
          py = ny;
          stepped = true;
          break;
        }
        if (!stepped) {
          side = -side; // boxed in on this side — try a hairpin to the other
          cxr = -cxr;
          cyr = -cyr;
        }
      }
      if (!stepped) break; // genuinely cliff-bound — the trail ends here
    }
    if (line.length < 2) return line; // never got off the trailhead
    // Surface-lay the route as a light-tread foot-trail (conform ~0.15 eases bumps toward local ground,
    // never a trench). half=0 → a single-cell trail corridor (the renderer strokes it as a thin line).
    this.layPath(line, land, half, 0.15);
    return line;
  }

  /**
   * Lay authentic switchback foot-trails UP the spurs toward high ground (ridgetop / OP shoulders)
   * from the reachable trailheads (each village + the COP gate). These are what a soldier — and the
   * enemy — actually use to climb the valley walls, instead of bushwhacking straight up a face: each
   * benched switchback reconnects the pocket it climbs into AND gives the planner a cheap, contour-
   * molded route to high ground. Deterministic (no rng): the destination is the highest walkable
   * SHOULDER in a 250–560 m uphill annulus, the hairpin side comes from the trailhead cell.
   */
  private layTrailNetwork() {
    const size = this.size;
    const cs = this.cellSize;
    const rMin = Math.round(250 / cs);
    const rMax = Math.round(560 / cs);
    const origins: { cx: number; cy: number }[] = this.villages.map((v) => ({ cx: v.cx, cy: v.cy }));
    if (this.cop?.gateOutside) origins.push({ cx: this.cop.gateOutside.cx, cy: this.cop.gateOutside.cy });
    for (const o of origins) {
      const oE = this.elev[this.idx(clamp(o.cx, 0, size - 1), clamp(o.cy, 0, size - 1))];
      const upSide = Math.sign(o.cx - this.centerX[clamp(o.cy, 0, size - 1)]) || 1; // away from the valley floor
      // Find the highest WALKABLE shoulder (slope < 1.0 — a real OP perch, not a sheer summit) in the
      // uphill annulus. A walkable destination keeps the trail's purpose honest (you can stand on it).
      let bestE = -Infinity;
      let bx = -1;
      let by = -1;
      for (let a = 0; a < 64; a++) {
        const ang = (a / 64) * Math.PI * 2;
        for (let r = rMin; r <= rMax; r += 2) {
          const x = Math.round(o.cx + Math.cos(ang) * r);
          const y = Math.round(o.cy + Math.sin(ang) * r);
          if (!this.inBounds(x, y)) continue;
          if (Math.sign(x - this.centerX[y]) !== upSide) continue; // stay on the uphill valley side
          const i = this.idx(x, y);
          if (this.slope[i] >= 1.0) continue; // want a perch, not a cliff face
          const e = this.elev[i];
          if (e - oE < 80) continue; // must be a meaningful climb (an OP, not flat ground)
          if (e > bestE) {
            bestE = e;
            bx = x;
            by = y;
          }
        }
      }
      if (bx < 0) continue;
      const pts = this.ascendTrail(o.cx, o.cy, bx, by, 0, 0.3, Land.Trail, o.cx * 31 + o.cy);
      this.trailLines.push({ kind: "trail", pts });
    }
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
    // Capture the MSR centerline (smoothed along the valley floor) so the renderer draws it as one
    // scaled road line that follows the river, not a jittery per-row landcover band.
    const msr: Vec2[] = [];
    for (let y = 0; y < size; y += 6) msr.push(this.cellCenter(clamp(Math.round(this.centerX[y]) + off, 0, size - 1), y));
    this.trailLines.push({ kind: "road", pts: msr });
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
      this.trailLines.push({ kind: "track", pts: [this.cellCenter(th.v.cx, th.v.cy), this.cellCenter(th.hx, th.hy)] });
      const tie = this.nearestRoadCell(th.hx, th.hy);
      this.layTrack(this.cellCenter(th.hx, th.hy), this.cellCenter(tie.cx, tie.cy), rng);
      // Tier-3 goat trail up the draw above the village (surface-laid, no benching).
      const upX = clamp(th.v.cx - th.dir * Math.round(size * 0.08), 0, size - 1);
      const upY = clamp(th.v.cy + rng.int(-8, 8), 0, size - 1);
      this.layPath([this.cellCenter(th.v.cx, th.v.cy), this.cellCenter(upX, upY)], Land.Trail, 0, 0);
      this.trailLines.push({ kind: "trail", pts: [this.cellCenter(th.v.cx, th.v.cy), this.cellCenter(upX, upY)] });
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
    // Switchback foot-trails UP the spurs toward high ground (OP shoulders) from every reachable
    // trailhead — "more footpaths" that mold to the terrain, climb the steep band by switchbacks, and
    // reconnect the pockets they climb into. Laid here so the trail benching is in the slope recompute
    // below (passability/movement see the new trails) and the connectivity guards see one network.
    this.layTrailNetwork();
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
      this.trailLines.push({ kind: "track", pts: [fromW, ...route] });
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

  /**
   * Discrete micro-cover (issue 020): scatter boulders and rock outcrops as real OBJECTS, stamp the
   * cover/concealment they lend into the field (so the combat cover query and the LOS see them), and
   * keep the list so the renderer draws the SAME instances — the rock a soldier hugs is the rock on
   * screen, not a cosmetic sprite decoupled from a smeared 5 m average. Two sources: the rocky ground
   * that should obviously hold cover (Boulders/Scree/Rock), and — the owner's "more on the map to use
   * for cover" — a sparse strew of erratic boulders down the OPEN slopes (Grass/Meadow/Scrub/Terrace),
   * which otherwise offer nothing to get behind. Hash-seeded from the static terrain → deterministic,
   * not serialized. Called AFTER deriveCoverConcealment so it stamps on top of the landcover base.
   */
  private generateCoverObjects() {
    const { worldSize: ws, cellSize: cs } = this;
    const STEP = 6;
    const hash = (ix: number, iy: number, salt: number): number => {
      let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (salt | 0) * 2147483647;
      h = (h ^ (h >> 13)) * 1274126177;
      return ((h ^ (h >> 16)) >>> 0) / 4294967295;
    };
    const valNoise = (x: number, y: number): number => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi, 7), b = hash(xi + 1, yi, 7), c = hash(xi, yi + 1, 7), d = hash(xi + 1, yi + 1, 7);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const blocker = (l: Land) =>
      l === Land.Road || l === Land.Trail || l === Land.Footbridge || l === Land.River || l === Land.Track ||
      l === Land.Hesco || l === Land.Structure || l === Land.Gravel || l === Land.Compound || l === Land.CompoundWall;
    const gN = Math.ceil(ws / STEP);
    const CAP = 16000; // generous — covers the whole map without spatial bias (render windows + caps anyway)
    for (let gy = 0; gy < gN && this.coverObjects.length < CAP; gy++)
      for (let gx = 0; gx < gN; gx++) {
        const jx = (gx + 0.1 + hash(gx, gy, 1) * 0.8) * STEP;
        const jy = (gy + 0.1 + hash(gx, gy, 2) * 0.8) * STEP;
        if (jx < 0 || jy < 0 || jx >= ws || jy >= ws) continue;
        const cx = Math.floor(jx / cs), cy = Math.floor(jy / cs);
        if (!this.inBounds(cx, cy)) continue;
        const l = this.land[this.idx(cx, cy)] as Land;
        const slope = this.slope[this.idx(cx, cy)];
        // Every object is DRAWN from this list (drawn=sim) and inherits the cover the LANDCOVER already
        // encodes at its cell — `stampNew` stays false everywhere, so the cover field is byte-identical to
        // the no-objects field (provably balance-neutral; verified by a field hash). On rocky ground this is
        // exactly right: the rock you see IS where the cover field's cover is. RESTRAINT (issue 020): a
        // version that ADDED cover on open ground was measured and reverted — even at low density it
        // prolonged firefights into attritional grinds (12×50 WIA 3.92→7.42, a +89% shift; an earlier broad
        // Scree raise was ~3× worse). Ambient cover via the 5 m cell scalar is too coarse to add safely;
        // making open-ground cover both USABLE and non-grinding needs the sub-cell directional model (the
        // deferred heavy half of 020). So the erratics here are visible objects to maneuver around, not yet
        // a combat-cover change. `stampNew` is kept as the seam for that future work.
        let id: "boulder" | "rock-outcrop";
        let prob: number, baseScale: number, stampNew: boolean;
        if (l === Land.Boulders) { id = "boulder"; prob = 0.5; baseScale = 1.18; stampNew = false; }
        else if (l === Land.Scree) { id = hash(gx, gy, 3) < 0.5 ? "boulder" : "rock-outcrop"; prob = 0.16; baseScale = 1; stampNew = false; }
        else if (l === Land.Rock || l === Land.Cliff) { id = "rock-outcrop"; prob = 0.12; baseScale = 1; stampNew = false; }
        else if ((l === Land.Grass || l === Land.Meadow || l === Land.Scrub || l === Land.Terrace) && slope > 0.18 && slope < 0.95) {
          id = "boulder"; prob = 0.05; baseScale = 0.95; stampNew = false; // erratic boulders strewn down the open slope — DRAWN (more on the map), but NOT field-stamped: see note below.
        } else if (l === Land.DryWash) { id = "boulder"; prob = 0.06; baseScale = 0.85; stampNew = false; }
        else continue;
        const clump = valNoise(jx * 0.012, jy * 0.012);
        if (hash(gx, gy, 4) > prob * (0.35 + clump * clump * 1.3)) continue;
        if (blocker(this.landAt(jx + 5, jy)) || blocker(this.landAt(jx - 5, jy)) || blocker(this.landAt(jx, jy + 5)) || blocker(this.landAt(jx, jy - 5))) continue;
        const scale = baseScale * (0.6 + hash(gx, gy, 5) * 0.9);
        const rot = (hash(gx, gy, 6) - 0.5) * 0.5;
        const i = this.idx(cx, cy);
        // a boulder you crouch behind is real but PARTIAL cover (light frontal, not a bunker); on rocky
        // ground the object inherits the landcover's existing cover (no re-raise)
        const objCover = stampNew ? 0.42 * Math.min(1, 0.6 + scale * 0.4) : this.cover[i];
        const objConceal = stampNew ? 0.2 * Math.min(1, 0.6 + scale * 0.4) : this.conceal[i];
        this.coverObjects.push({ x: jx, y: jy, id, scale, rot, cover: objCover, conceal: objConceal });
        if (stampNew) {
          this.cover[i] = Math.max(this.cover[i], objCover);
          this.conceal[i] = Math.max(this.conceal[i], objConceal);
        }
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

  /**
   * DIRECTIONAL, posture-aware hard-cover occlusion (issue 020): the fraction of small-arms fire a
   * discrete cover OBJECT (boulder / rock outcrop) stops for `target` against a round coming from
   * `shooter`. Unlike the 5 m raster `coverAt` (omnidirectional — every bearing equally), this is the
   * reason a man behind THIS rock is covered from THAT threat but exposed to a flanker: only an object
   * sitting BETWEEN the shooter and the target, close in front of the target and across the sight line,
   * counts. Posture-aware via `targetHeight` — a low boulder hides a prone man almost completely and a
   * standing man only partly (Combat-Mission calibration). Returns 0..1 (0 = no object on this line).
   *
   * Directionality is what makes open-ground cover USABLE without grinding: a covered man is still
   * exposed to fire from any other bearing, so the (already-shipped) autonomous flank defeats the
   * cover and the firefight resolves by maneuver, not symmetric attrition (the failure of the reverted
   * 2026-06-09 omnidirectional stamp). Queried on the FIRE path only (coverFor), never detection.
   */
  coverOcclusion(shooter: Vec2, target: Vec2, targetHeight: number): number {
    const objs = this.coverObjects;
    if (objs.length === 0) return 0;
    if (!this.coverBuckets) this.buildCoverIndex();
    const dx = shooter.x - target.x, dy = shooter.y - target.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) return 0;
    const ux = dx / d, uy = dy / d; // unit vector from the target toward the shooter
    const B = COVER_BUCKET_M;
    const bw = Math.ceil(this.worldSize / B);
    const tbx = Math.floor(target.x / B), tby = Math.floor(target.y / B);
    let best = 0;
    for (let by = tby - 1; by <= tby + 1; by++) {
      if (by < 0 || by >= bw) continue;
      for (let bx = tbx - 1; bx <= tbx + 1; bx++) {
        if (bx < 0 || bx >= bw) continue;
        const arr = this.coverBuckets!.get(by * bw + bx);
        if (!arr) continue;
        for (const idx of arr) {
          const o = objs[idx];
          const vx = o.x - target.x, vy = o.y - target.y;
          const along = vx * ux + vy * uy; // distance from target toward the shooter
          if (along < 0.15 || along > COVER_AHEAD_M) continue; // must be just in front, covering him
          const lat = Math.abs(-vx * uy + vy * ux); // perpendicular distance to the sight line
          const half = COVER_OBJ_FOOTPRINT[o.id] * o.scale * 0.5;
          if (lat > half) continue; // the line misses the object's frontage
          // geometric block: an object of height objH hides a target of height targetHeight up to
          // min(1, objH/targetHeight) of its silhouette; × the object's small-arms stop probability.
          const objH = COVER_OBJ_HEIGHT[o.id] * o.scale;
          const occ = clamp01(objH / Math.max(0.35, targetHeight)) * COVER_OBJ_STOP[o.id];
          if (occ > best) best = occ;
        }
      }
    }
    return best;
  }

  /** Build the cover-object bucket index (once, lazily). Derived from coverObjects → not serialized. */
  private buildCoverIndex() {
    const B = COVER_BUCKET_M;
    const bw = Math.ceil(this.worldSize / B);
    const m = new Map<number, number[]>();
    for (let i = 0; i < this.coverObjects.length; i++) {
      const o = this.coverObjects[i];
      const key = Math.floor(o.y / B) * bw + Math.floor(o.x / B);
      let arr = m.get(key);
      if (!arr) { arr = []; m.set(key, arr); }
      arr.push(i);
    }
    this.coverBuckets = m;
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

  /** Cached bitmap of cells genuinely reachable on foot from the gate, using the SAME
   *  anti-corner-cut connectivity the mover/router honour (a diagonal step needs an orthogonal
   *  neighbour open). This is the squad's true reachable set: everything it operates from starts
   *  inside the wire, which is in this component. Computed once on first use (the terrain is static
   *  after generation) and reused — it's the primitive that keeps objective-snapping honest. */
  private _gateReachable?: Uint8Array;
  reachableFromGate(): Uint8Array {
    if (this._gateReachable) return this._gateReachable;
    const size = this.size;
    const seen = new Uint8Array(size * size);
    const g = this.cop?.gateOutside ?? this.copCell;
    const s = this.nearestPassable(g.cx, g.cy, 16);
    if (!this.passableCell(s.cx, s.cy)) {
      this._gateReachable = seen;
      return seen;
    }
    seen[s.cy * size + s.cx] = 1;
    const st = [s.cy * size + s.cx];
    while (st.length) {
      const i = st.pop()!;
      const x = i % size, y = (i / size) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size || !this.passableCell(nx, ny)) continue;
          if (dx !== 0 && dy !== 0 && !this.passableCell(x + dx, y) && !this.passableCell(x, y + dy)) continue; // no corner-cut
          const j = ny * size + nx;
          if (seen[j]) continue;
          seen[j] = 1;
          st.push(j);
        }
    }
    this._gateReachable = seen;
    return seen;
  }

  /** Nearest cell to (cx,cy) that the squad can ACTUALLY reach (passable AND in the gate's
   *  connected component), spiralling out. This is what objective-snapping must use: plain
   *  nearestPassable can land the goal across a wall/river/cliff in a different component (a
   *  pocket on the far bank), stranding the squad halted opposite a point it can never reach. */
  nearestReachable(cx: number, cy: number, maxR = 40): { cx: number; cy: number } {
    const reach = this.reachableFromGate();
    if (this.inBounds(cx, cy) && reach[this.idx(cx, cy)]) return { cx, cy };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const nx = cx + dx, ny = cy + dy;
          if (this.inBounds(nx, ny) && reach[this.idx(nx, ny)]) return { cx: nx, cy: ny };
        }
    }
    return this.nearestPassable(cx, cy); // nothing reachable nearby — fall back to nearest passable
  }

  /** A world point snapped to the nearest cell anyone on the valley network can actually reach
   *  (passable AND in the gate's connected component). Pattern-of-life destinations across the
   *  river — a market in another village — use this so a villager is never given an errand that
   *  ends across an uncrossable barrier (issue 010): they route to a real crossing or stay home. */
  reachablePoint(wx: number, wy: number): Vec2 {
    const cs = this.cellSize;
    const c = this.nearestReachable(Math.floor(wx / cs), Math.floor(wy / cs));
    return this.cellCenter(c.cx, c.cy);
  }

  /** Is this cell passable on foot at all (cliffs/deep channels are not). */
  passableCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const l = this.land[this.idx(cx, cy)] as Land;
    if (l === Land.Cliff) return false;
    if (l === Land.CompoundWall) return false;
    if (l === Land.Hesco) return false; // the wire — only the gate is passable
    if (l === Land.Structure) return false; // buildings are solid — route around, not through (issue 004)
    // The river is a REAL OBSTACLE (issue 010): the open channel is too deep/fast to wade, so it is
    // crossed only at a Ford or a Footbridge. This is what makes "cross at the ford" a real tactical
    // act and what stops a squad wading the chasm anywhere and getting trapped between the banks.
    // placeFords + ensureRiverCrossings guarantee crossings exist so nothing is ever walled off.
    if (l === Land.River) return false;
    const s = this.slope[this.idx(cx, cy)];
    if (s > FOOT_CLIFF_SLOPE) return false; // a true cliff — no foot traffic at any pace
    // Steep-but-slow climbing band (1.25–1.50): passable, but ONLY where the neighbourhood is also
    // climbable. A lone sub-cliff cell ringed by true cliff is a fake foothold — routing a mover onto
    // it would wedge him (every onward step impassable) and the stall watchdog would re-path him
    // straight back, a freeze loop. The 3×3 mean-slope test rejects those specks while keeping
    // contiguous faces (the same recover% set passability-probe validates). The common ≤1.25 ground
    // skips this entirely (the hot mover/LOS/render path pays nothing).
    if (s > FOOT_MAX_SLOPE && this.meanSlope3(cx, cy) > FOOT_CLIFF_SLOPE) return false;
    return true;
  }

  /** Mean rise/run slope over the 3×3 neighbourhood — "is this a real foothold, or a speck in a
   *  cliff". Used only for the thin steep band in passableCell (gated behind a rare branch). */
  private meanSlope3(cx: number, cy: number): number {
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.size || ny >= this.size) continue;
        sum += this.slope[this.idx(nx, ny)];
        n++;
      }
    return n ? sum / n : 0;
  }

  /** Movement speed multiplier (1 = open flat road pace; lower = harder). */
  moveCostAt(wx: number, wy: number): number {
    const land = this.landAt(wx, wy);
    const slope = this.slopeAt(wx, wy);
    const m = LAND_MOVE[land] ?? 0.6;
    // Slope penalty (steep ground is brutal in the Korengal). The same gentle 1−slope·0.62 shape as
    // before for the ≤1.0 band (movement economy unchanged), but the cost floor is now STEEP_COST_FLOOR
    // (0.02), far below the old 0.1: this keeps a real, monotone cost GRADIENT across the 1.25–1.50
    // climbing band so the planner prefers the gentlest steep cells (and never dives straight up a fake
    // cliff — the cause of the reverted ×9.21 regression). The mover's never-freeze floor (combat.ts)
    // keeps a man on a 56° pitch creeping, not frozen.
    return clamp(m * clamp01(1 - slope * 0.62), STEEP_COST_FLOOR, 1);
  }

  /**
   * ANISOTROPIC foot speed (1 = road pace) for travel in the heading (ux,uy) at world point
   * (wx,wy) — the landcover speed modulated by the SIGNED grade ALONG the direction of travel
   * (issue 019). Unlike moveCostAt (which reads only the cell's slope MAGNITUDE, identical in
   * every heading, so a switchback never pays off), this reads the directional derivative of the
   * elevation: climbing straight up the fall line is slow, a shallow cross-slope traverse is fast,
   * descending is fast. That asymmetry is the entire reason a switchback up a face is cheaper than
   * a straight climb — the tactical planner integrates this along each leg. The slope term is the
   * engine's own 1−S·0.62 shape (proven at the right magnitude: ~2.6× the cost straight-up-vs-
   * traverse at 45°), applied to the SIGNED grade S rather than |slope|, floored at STEEP_COST_FLOOR.
   */
  dirSpeedAt(wx: number, wy: number, ux: number, uy: number): number {
    const h = this.cellSize;
    const S = (this.elevAt(wx + ux * h, wy + uy * h) - this.elevAt(wx, wy)) / h; // ∇elev · u (signed)
    const m = LAND_MOVE[this.landAt(wx, wy)] ?? 0.6;
    return clamp(m * clamp01(1 - S * 0.62), STEEP_COST_FLOOR, 1);
  }

  /** Cell center in world meters. */
  cellCenter(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * this.cellSize, y: (cy + 0.5) * this.cellSize };
  }

  worldOf(cx: number, cy: number): Vec2 {
    return this.cellCenter(cx, cy);
  }

  /** World points sampled down the meandering river/valley centerline — used render-side by the
   *  ambient bed to position the stream layer (its gain rises as the camera nears the floor). */
  riverPoints(count = 24): Vec2[] {
    const out: Vec2[] = [];
    const step = Math.max(1, Math.floor(this.size / count));
    for (let y = 0; y < this.size; y += step) out.push(this.cellCenter(this.centerX[y], y));
    return out;
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
  [Land.Ford]: [0.12, 0.06], // a crossing in open water — almost no cover, a killing ground
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
  [Land.Ford]: 0.5, // wading a shallow crossing — slow going, but it gets you across
};
