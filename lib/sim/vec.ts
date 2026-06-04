/** 2D vector + grid math used across the simulation. Coordinates are in meters. */

export interface Vec2 {
  x: number;
  y: number;
}

export function v(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from point `p` to the segment `a`→`b` (meters). */
export function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function angle(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

export function fromAngle(rad: number, mag = 1): Vec2 {
  return { x: Math.cos(rad) * mag, y: Math.sin(rad) * mag };
}

export function rotate(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function lerpV(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Smallest signed angle difference a→b in radians, in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Compass bearing string from a direction vector (game uses screen y-down). */
export function bearing(dir: Vec2): string {
  const deg = (Math.atan2(dir.x, -dir.y) * 180) / Math.PI;
  const d = (deg + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(d / 45) % 8];
}

/** Compass degrees (0=N, clockwise) from a direction vector. */
export function compassDeg(dir: Vec2): number {
  const deg = (Math.atan2(dir.x, -dir.y) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}

/** Integer grid cell holding a world point, given cell size in meters. */
export function cellOf(p: Vec2, cellSize: number): { cx: number; cy: number } {
  return { cx: Math.floor(p.x / cellSize), cy: Math.floor(p.y / cellSize) };
}
