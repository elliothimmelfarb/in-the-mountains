/**
 * Deterministic seeded RNG (mulberry32) plus the distributions the sim needs.
 * The entire simulation draws from instances of this so a given seed reproduces
 * a given deployment exactly — essential for save/replay and for fair difficulty.
 */
export class RNG {
  private s: number;

  constructor(seed: number | string = 1) {
    this.s = typeof seed === "string" ? RNG.hashString(seed) : seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  static hashString(str: string): number {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return (h ^ (h >>> 16)) >>> 0;
  }

  /** Raw uniform [0,1). */
  next(): number {
    this.s |= 0;
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Sign-correct gaussian (Box–Muller), mean/std configurable. */
  gauss(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + n * std;
  }

  /** Gaussian clamped to [min,max]. */
  gaussClamped(mean: number, std: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, this.gauss(mean, std)));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick: items with parallel weights array. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** A point uniformly inside a disc of given radius around (cx,cy). */
  inDisc(cx: number, cy: number, radius: number): { x: number; y: number } {
    const r = radius * Math.sqrt(this.next());
    const a = this.next() * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  }

  /** Current internal state — for save/restore. */
  getState(): number {
    return this.s >>> 0;
  }

  /** Restore internal state from getState(). */
  setState(s: number) {
    this.s = s >>> 0;
  }

  /** Fork a child RNG with a derived seed — for independent subsystems. */
  fork(salt: number | string): RNG {
    const saltN = typeof salt === "string" ? RNG.hashString(salt) : salt;
    return new RNG((this.s ^ Math.imul(saltN, 0x85ebca6b)) >>> 0);
  }
}

/** Cheap value-noise for terrain — seeded, smooth, tileable-ish. */
export class ValueNoise {
  private perm: Uint8Array;
  constructor(seed: number | string = 1) {
    const rng = new RNG(seed);
    const p = new Uint8Array(512);
    const base = Array.from({ length: 256 }, (_, i) => i);
    const sh = rng.shuffle(base);
    for (let i = 0; i < 512; i++) p[i] = sh[i & 255];
    this.perm = p;
  }
  private fade(t: number) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  private grad(hash: number, x: number, y: number) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
  }
  /** Perlin-style noise in [-1,1]. */
  noise2(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = this.fade(xf);
    const v = this.fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u);
    const x2 = lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 0.5;
  }
  /** Fractal Brownian motion — layered noise. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
