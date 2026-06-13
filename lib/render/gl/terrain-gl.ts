// The WebGL2 terrain underlayer — the 10x rebuild (attempt #2). Sits on its own opaque canvas
// BELOW the transparent 2D canvas (contours/units/HUD). Two passes per frame:
//   PASS A  terrain lit in LINEAR radiance → RGBA16F HDR target (RGBA8 fallback if a driver
//           can't render half-float — verified renderable on the headless SwiftShader path).
//   PASS C  HDR → ACES tonemap → time-of-day grade → dither → sRGB, to the visible canvas.
// The cast-shadow visibility map is ray-marched into a 1024² R8 FBO ONLY when the key dir moves
// (≤ a few Hz) — at time-warp the shadow line visibly sweeps the valley (the master clock made
// literal). If WebGL2/context is unavailable, `ok` is false and WorldView uses the 2D bake.

import type { Terrain } from "../../sim/terrain";
import type { Camera } from "../topo";
import type { SkyState } from "../sky";
import type { AtmoState } from "../atmosphere-model";
import { bakeAlbedo } from "../topo";
import { TERRAIN_VERT, TERRAIN_FRAG_LIT, COMPOSITE_VERT, COMPOSITE_FRAG, SHADOW_VERT, SHADOW_FRAG } from "./shaders";
import { buildMaterialLib, TILE, TILE_METERS, MAT_COUNT } from "./material-atlas";

export interface TerrainEnv {
  /** camera-punch offset in CSS px — same value applied to the 2D ctx transform */
  shakePx: { x: number; y: number };
  /** the single sun/moon/light state from lib/render/sky.ts */
  sky: SkyState;
  /** cloud-shadow + valley-fog state from lib/render/atmosphere-model.ts */
  atmo: AtmoState;
  /** world.secondsOfDay — water/ripple phase (sim clock: freezes on pause, races at time-warp) */
  secondsOfDay: number;
}

const FLOOR_SIZE = 128;

/** Local valley-floor elevation field (128²): the floor fog pools UP from. A fixed MSL ceiling
 *  fails because the floor climbs 1550→2000 m S→N; this min-pools the heightmap so fog fills
 *  draws and the river channel regardless of absolute altitude. Conservative 4×4-block min
 *  downsample, then a separable box-min (~240 m radius). */
function bakeLocalFloor(t: Terrain): Float32Array {
  const N = FLOOR_SIZE;
  const block = Math.max(1, Math.floor(t.size / N));
  const coarse = new Float32Array(N * N);
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      let m = Infinity;
      for (let by = 0; by < block; by++) {
        const sy = cy * block + by;
        if (sy >= t.size) break;
        for (let bx = 0; bx < block; bx++) {
          const sx = cx * block + bx;
          if (sx >= t.size) break;
          const e = t.elev[sy * t.size + sx];
          if (e < m) m = e;
        }
      }
      coarse[cy * N + cx] = m === Infinity ? t.minElev : m;
    }
  }
  const R = 12;
  const tmp = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let m = Infinity;
      for (let k = -R; k <= R; k++) {
        const xx = Math.min(N - 1, Math.max(0, x + k));
        m = Math.min(m, coarse[y * N + xx]);
      }
      tmp[y * N + x] = m;
    }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let m = Infinity;
      for (let k = -R; k <= R; k++) {
        const yy = Math.min(N - 1, Math.max(0, y + k));
        m = Math.min(m, tmp[yy * N + x]);
      }
      out[y * N + x] = m;
    }
  return out;
}

/** Bake a 512² horizon-based ambient-occlusion field ONCE at terrain load. For each cell, march
 *  K azimuths a few exponential steps and accumulate the sine of the max horizon angle — AO falls
 *  in draw bottoms, cliff bases, terrace insides, building footprints (the dead ground). Multiplies
 *  the AMBIENT term only (never direct), so it compounds correctly with cast shadows and is the one
 *  added effect that makes the terrain MORE legible. Floored so shadowed ground never goes black. */
function bakeHBAO(t: Terrain): Uint8Array {
  const N = t.size, cs = t.cellSize;
  const elev = t.elev;
  const out = new Uint8Array(N * N);
  const K = 16;
  const dirs: [number, number][] = [];
  for (let a = 0; a < K; a++) { const th = (a / K) * Math.PI * 2; dirs.push([Math.cos(th), Math.sin(th)]); }
  const steps = [5, 9, 15, 24, 38, 60, 95, 150]; // meters → ~150 m local horizon
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const wx = (cx + 0.5) * cs, wy = (cy + 0.5) * cs;
      const h0 = elev[cy * N + cx] + 1.0; // small bias kills self-occlusion on the home cell
      let occ = 0;
      for (let k = 0; k < K; k++) {
        const dx = dirs[k][0], dy = dirs[k][1];
        let maxTan = 0;
        for (let s = 0; s < steps.length; s++) {
          const d = steps[s];
          const sx = Math.min(N - 1, Math.max(0, Math.round((wx + dx * d) / cs)));
          const sy = Math.min(N - 1, Math.max(0, Math.round((wy + dy * d) / cs)));
          const tan = (elev[sy * N + sx] - h0) / d;
          if (tan > maxTan) maxTan = tan;
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan); // sin(atan(maxTan)) = hemisphere fraction blocked up-dir
      }
      const aoVal = 1 - (occ / K) * 1.35; // strength
      out[cy * N + cx] = Math.max(40, Math.min(255, Math.round(aoVal * 255))); // floor 40 → never black (legibility)
    }
  }
  return out;
}

/** Bake the river FLOW field (RG8: downstream direction = −∇elev at water cells) and a water
 *  MASK (R8: 255 at water cells, 0 dry — sampled LINEAR it ramps at the bank, giving a free
 *  shoreline gradient for foam). Water = River/Marsh/Ford classes. Deterministic, cached. */
function bakeWaterFlow(t: Terrain): { flow: Uint8Array; mask: Uint8Array } {
  const N = t.size, cs = t.cellSize, elev = t.elev, land = t.land;
  const flow = new Uint8Array(N * N * 2);
  const mask = new Uint8Array(N * N);
  const isWater = (i: number) => land[i] === 0 || land[i] === 1 || land[i] === 25; // River/Marsh/Ford
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const i = cy * N + cx;
      if (!isWater(i)) { flow[i * 2] = 128; flow[i * 2 + 1] = 128; mask[i] = 0; continue; }
      mask[i] = 255;
      const xm = Math.max(0, cx - 1), xp = Math.min(N - 1, cx + 1);
      const ym = Math.max(0, cy - 1), yp = Math.min(N - 1, cy + 1);
      const gx = (elev[cy * N + xp] - elev[cy * N + xm]) / (2 * cs);
      const gy = (elev[yp * N + cx] - elev[ym * N + cx]) / (2 * cs);
      let fx = -gx, fy = -gy;
      const l = Math.hypot(fx, fy) || 1;
      fx /= l; fy /= l;
      flow[i * 2] = Math.round((fx * 0.5 + 0.5) * 255);
      flow[i * 2 + 1] = Math.round((fy * 0.5 + 0.5) * 255);
    }
  }
  return { flow, mask };
}

const BG: [number, number, number] = [0x0c / 255, 0x0d / 255, 0x0a / 255];
const SHADOW_SIZE = 1024; // 2.5 m / texel across the 2.56 km map
const REBAKE_COS = Math.cos((0.25 * Math.PI) / 180); // rebake when the key dir moves > 0.25°
const REBAKE_MIN_MS = 200; // wall-clock rate limiter only (output stays angle-determined → deterministic)

// Base scene exposure mapping linear radiance into the ACES toe/shoulder. Calibrated so a
// noon-clear mid-gray sits where attempt-1's bake did, without crushing shadows or clipping snow.
const SCENE_EXPOSURE = 1.18;
// Legibility floor: a small constant added to the sky-hemisphere intensity so deep-shadowed
// faces never crush below the ~0.45× lit-luma read the tactical map needs (verified post-ACES).
const AMBIENT_FLOOR = 0.1;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[TerrainGL] shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("[TerrainGL] program link failed:", gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const m: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) m[n] = gl.getUniformLocation(p, n);
  return m;
}

export class TerrainGL {
  private gl: WebGL2RenderingContext | null = null;
  private terrainProg: WebGLProgram | null = null;
  private compositeProg: WebGLProgram | null = null;
  private shadowProg: WebGLProgram | null = null;
  private tU: Record<string, WebGLUniformLocation | null> = {};
  private cU: Record<string, WebGLUniformLocation | null> = {};
  private sU: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private albedoTex: WebGLTexture | null = null;
  private heightTex: WebGLTexture | null = null;
  private shadowTex: WebGLTexture | null = null;
  private shadowFbo: WebGLFramebuffer | null = null;
  private floorTex: WebGLTexture | null = null;
  private floorField: Float32Array | null = null; // CPU copy for 2D fog-coherence sampling
  private aoTex: WebGLTexture | null = null;       // 512² R8 baked horizon AO (C5)
  private flowTex: WebGLTexture | null = null;     // 512² RG8 river flow dir (C6)
  private waterMaskTex: WebGLTexture | null = null; // 512² R8 water mask (C6)
  // material spine (C3/C4)
  private landIdTex: WebGLTexture | null = null;   // 512² R8UI — Land class per cell
  private controlTex: WebGLTexture | null = null;  // 512² RGBA8 — slope/conceal/cover
  private matAlbedoTex: WebGLTexture | null = null; // MAT_COUNT-layer array — luma detail + roughness
  private matNormalTex: WebGLTexture | null = null; // MAT_COUNT-layer array — micro detail-normal
  // HDR intermediate (PASS A target → PASS C source)
  private hdrTex: WebGLTexture | null = null;
  private hdrFbo: WebGLFramebuffer | null = null;
  private hdrW = 0;
  private hdrH = 0;
  private hdrFloat = true; // RGBA16F (verified); falls back to RGBA8 if a driver can't render it
  private bloomTex: WebGLTexture | null = null; // 1×1 black placeholder until C8 wires real bloom
  private terrain: Terrain | null = null;
  private worldSize = 2560;
  private cell = 5;
  private grid = 512;
  private minElev = 0;
  private elevRange = 1;
  private lastKeyDir: [number, number, number] | null = null;
  private lastBakeMs = -1e9;
  private floatLinear = false;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onLost as EventListener, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored as EventListener, false);
    this.init();
  }

  get ok(): boolean {
    return !!this.gl && !!this.terrainProg && !!this.compositeProg;
  }

  /** Bilinear sample of the local valley-floor field (m) at a world point — the SAME field the
   *  GL fog pools from, so the 2D layer can fade sprites in step with the terrain fog (parity). */
  localFloorAt(wx: number, wy: number): number {
    const f = this.floorField;
    if (!f) return this.minElev;
    const g = FLOOR_SIZE / this.worldSize;
    const gx = Math.min(FLOOR_SIZE - 1.001, Math.max(0, wx * g));
    const gy = Math.min(FLOOR_SIZE - 1.001, Math.max(0, wy * g));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const i = (x: number, y: number) => f[y * FLOOR_SIZE + x];
    const a = i(x0, y0), b = i(x0 + 1, y0), c = i(x0, y0 + 1), d = i(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  private init() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return;
    this.gl = gl;
    // RGBA16F as a renderable color attachment needs EXT_color_buffer_float (or _half_float).
    // Probed TRUE on --use-angle=swiftshader; if absent we fall back to an RGBA8 intermediate.
    const cbf = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    this.hdrFloat = cbf;
    // R32F (height, local-floor) LINEAR filtering needs this; without it those stay NEAREST.
    this.floatLinear = !!gl.getExtension("OES_texture_float_linear");
    const tp = link(gl, TERRAIN_VERT, TERRAIN_FRAG_LIT);
    const cp = link(gl, COMPOSITE_VERT, COMPOSITE_FRAG);
    const sp = link(gl, SHADOW_VERT, SHADOW_FRAG);
    if (!tp || !cp || !sp) {
      this.gl = null;
      return;
    }
    this.terrainProg = tp;
    this.compositeProg = cp;
    this.shadowProg = sp;
    this.tU = uniforms(gl, tp, [
      "u_camCenter", "u_viewCss", "u_ppm", "u_shakePx", "u_worldSize", "u_bgColor",
      "u_albedo", "u_shadow", "u_ao", "u_height", "u_cell", "u_grid", "u_minElev", "u_elevRange",
      "u_sunDir", "u_sunColor", "u_sunI", "u_moonDir", "u_moonColor", "u_moonFactor",
      "u_skyColor", "u_groundColor", "u_skyI", "u_formLightNW", "u_ambientFloor",
      "u_warmLow", "u_coolHigh",
      "u_landId", "u_control", "u_matAlbedo", "u_matNormal", "u_detailGain", "u_tileMeters",
      "u_cloudOffset", "u_cloudScale", "u_cloudDensity", "u_cloudStrength",
      "u_localFloor", "u_fogThickness", "u_fogFade", "u_fogStrength", "u_fogColor",
      "u_hazeStrength", "u_hazeColor",
      "u_flow", "u_waterMask", "u_time",
    ]);
    this.cU = uniforms(gl, cp, [
      "u_hdr", "u_bloom", "u_bloomStrength", "u_sceneExposure",
      "u_exposure", "u_whiteBalance", "u_saturation", "u_lift", "u_res",
    ]);
    this.sU = uniforms(gl, sp, ["u_keyDir", "u_worldSize", "u_height", "u_cell", "u_grid"]);
    const tri = new Float32Array([-1, -1, 3, -1, -1, 3]);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.initShadowTarget();
    this.initBloomPlaceholder();
    this.initMaterialArrays();
    if (this.terrain) this.uploadTextures(this.terrain);
  }

  /** Upload the procedural material library (terrain-independent → built once, cached). Two
   *  TEXTURE_2D_ARRAYs (REPEAT, mipmapped) so each material tile samples seamlessly with no
   *  atlas-gutter bleed. */
  private initMaterialArrays() {
    const gl = this.gl;
    if (!gl) return;
    const lib = buildMaterialLib();
    this.matAlbedoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matAlbedoTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, TILE, TILE, MAT_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, lib.albedo);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.matNormalTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matNormalTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RG8, TILE, TILE, MAT_COUNT, 0, gl.RG, gl.UNSIGNED_BYTE, lib.normal);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  private initShadowTarget() {
    const gl = this.gl;
    if (!gl) return;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SHADOW_SIZE, SHADOW_SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastKeyDir = null; // force a rebake after (re)creation
  }

  private initBloomPlaceholder() {
    const gl = this.gl;
    if (!gl) return;
    this.bloomTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** (Re)create the HDR intermediate to match the drawing-buffer size. RGBA16F by default;
   *  RGBA8 if the driver can't render half-float (the look survives, bloom headroom shrinks). */
  private ensureHdrTarget(w: number, h: number) {
    const gl = this.gl;
    if (!gl) return;
    if (this.hdrTex && this.hdrW === w && this.hdrH === h) return;
    this.hdrW = w;
    this.hdrH = h;
    if (!this.hdrTex) this.hdrTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
    if (this.hdrFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!this.hdrFbo) this.hdrFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hdrTex, 0);
    if (this.hdrFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // driver lied about renderability — drop to RGBA8 and rebuild
      this.hdrFloat = false;
      gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hdrTex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.gl = null;
    this.terrainProg = null;
    this.compositeProg = null;
  };

  private onRestored = () => {
    this.albedoTex = null;
    this.heightTex = null;
    this.floorTex = null;
    this.aoTex = null;
    this.flowTex = null;
    this.waterMaskTex = null;
    this.hdrTex = null;
    this.hdrFbo = null;
    this.hdrW = 0;
    this.hdrH = 0;
    this.bloomTex = null;
    this.landIdTex = null;
    this.controlTex = null;
    this.matAlbedoTex = null;
    this.matNormalTex = null;
    this.init();
  };

  setTerrain(t: Terrain) {
    this.terrain = t;
    this.worldSize = t.worldSize;
    this.cell = t.cellSize;
    this.grid = t.size;
    this.minElev = t.minElev;
    this.elevRange = Math.max(1, t.maxElev - t.minElev);
    if (this.ok) this.uploadTextures(t);
  }

  private uploadTextures(t: Terrain) {
    const gl = this.gl;
    if (!gl) return;
    // albedo (unlit material) — mipmapped so it never shimmers when zoomed out
    const baked = bakeAlbedo(t);
    if (!this.albedoTex) this.albedoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); // texture row 0 = canvas top = world y 0 (north)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, baked.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // heightmap: 512² R32F, NEAREST + manual bilinear in-shader (= Terrain.elevAt, no precision trap)
    if (!this.heightTex) this.heightTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    const elev = t.elev instanceof Float32Array ? t.elev : new Float32Array(t.elev);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, t.size, t.size, 0, gl.RED, gl.FLOAT, elev);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // local valley-floor min-field (128² R32F) — what the valley fog pools up from
    this.floorField = bakeLocalFloor(t);
    if (!this.floorTex) this.floorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.floorTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, FLOOR_SIZE, FLOOR_SIZE, 0, gl.RED, gl.FLOAT, this.floorField);
    const floorFilter = this.floatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, floorFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, floorFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // material-ID spine: Land class per cell (R8UI) on the SAME lattice as the heightmap (which is
    // contour-registration-proven), so material selection lands on exactly the right cells.
    const n = t.size * t.size;
    const land = t.land instanceof Uint8Array ? t.land : new Uint8Array(t.land);
    if (!this.landIdTex) this.landIdTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.landIdTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, t.size, t.size, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, land);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // control: R = slope/2, G = conceal (canopy density), B = cover — drives slope-aware talus + (later) veg
    const ctrl = new Uint8Array(n * 4);
    const slope = t.slope, conceal = t.conceal, cover = t.cover;
    for (let i = 0; i < n; i++) {
      ctrl[i * 4] = Math.min(255, Math.max(0, (slope ? slope[i] : 0) * 0.5 * 255));
      ctrl[i * 4 + 1] = Math.min(255, Math.max(0, (conceal ? conceal[i] : 0) * 255));
      ctrl[i * 4 + 2] = Math.min(255, Math.max(0, (cover ? cover[i] : 0) * 255));
      ctrl[i * 4 + 3] = 255;
    }
    if (!this.controlTex) this.controlTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.controlTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, t.size, t.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, ctrl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // baked horizon AO (512² R8) — one-time bake (~tens of ms, hidden behind the deploy bar)
    const ao = bakeHBAO(t);
    if (!this.aoTex) this.aoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.aoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, t.size, t.size, 0, gl.RED, gl.UNSIGNED_BYTE, ao);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // river flow field (RG8) + water mask (R8, LINEAR → bank ramp) for the C6 water surface
    const { flow, mask } = bakeWaterFlow(t);
    if (!this.flowTex) this.flowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, t.size, t.size, 0, gl.RG, gl.UNSIGNED_BYTE, flow);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!this.waterMaskTex) this.waterMaskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.waterMaskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, t.size, t.size, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, null);
    this.lastKeyDir = null; // new terrain → rebake shadows
  }

  /** Rebake the sun-visibility map iff the key direction moved past the threshold. */
  private maybeBakeShadow(sky: SkyState, nowMs: number) {
    const gl = this.gl;
    if (!gl || !this.shadowProg || !this.heightTex || !this.shadowFbo) return;
    const k = sky.keyDir;
    const moved = !this.lastKeyDir || this.lastKeyDir[0] * k[0] + this.lastKeyDir[1] * k[1] + this.lastKeyDir[2] * k[2] < REBAKE_COS;
    if (!moved) return;
    if (this.lastKeyDir && nowMs - this.lastBakeMs < REBAKE_MIN_MS) return; // rate limiter
    this.lastKeyDir = [k[0], k[1], k[2]];
    this.lastBakeMs = nowMs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.useProgram(this.shadowProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(this.sU.u_height, 1);
    gl.uniform1f(this.sU.u_cell, this.cell);
    gl.uniform1f(this.sU.u_grid, this.grid);
    gl.uniform1f(this.sU.u_worldSize, this.worldSize);
    gl.uniform3f(this.sU.u_keyDir, k[0], k[1], k[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(cam: Camera, env: TerrainEnv) {
    const gl = this.gl;
    if (!this.ok || !gl || !this.terrainProg || !this.compositeProg || !this.albedoTex || !this.heightTex) return;
    const sky = env.sky;
    const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
    this.maybeBakeShadow(sky, nowMs);

    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const bw = Math.round(cam.vw * dpr);
    const bh = Math.round(cam.vh * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.ensureHdrTarget(bw, bh);

    // ── PASS A: terrain → HDR target (linear radiance) ──────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFbo);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.terrainProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.uniform1i(this.tU.u_albedo, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(this.tU.u_height, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.tU.u_shadow, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.floorTex);
    gl.uniform1i(this.tU.u_localFloor, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.landIdTex);
    gl.uniform1i(this.tU.u_landId, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.controlTex);
    gl.uniform1i(this.tU.u_control, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matAlbedoTex);
    gl.uniform1i(this.tU.u_matAlbedo, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matNormalTex);
    gl.uniform1i(this.tU.u_matNormal, 7);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.aoTex);
    gl.uniform1i(this.tU.u_ao, 8);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
    gl.uniform1i(this.tU.u_flow, 9);
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this.waterMaskTex);
    gl.uniform1i(this.tU.u_waterMask, 10);

    gl.uniform2f(this.tU.u_camCenter, cam.cx, cam.cy);
    gl.uniform2f(this.tU.u_viewCss, cam.vw, cam.vh);
    gl.uniform1f(this.tU.u_ppm, cam.ppm);
    gl.uniform2f(this.tU.u_shakePx, env.shakePx.x, env.shakePx.y);
    gl.uniform1f(this.tU.u_worldSize, this.worldSize);
    gl.uniform3f(this.tU.u_bgColor, BG[0], BG[1], BG[2]);
    gl.uniform1f(this.tU.u_cell, this.cell);
    gl.uniform1f(this.tU.u_grid, this.grid);
    gl.uniform1f(this.tU.u_minElev, this.minElev);
    gl.uniform1f(this.tU.u_elevRange, this.elevRange);

    gl.uniform3f(this.tU.u_sunDir, sky.sunDir[0], sky.sunDir[1], sky.sunDir[2]);
    gl.uniform3f(this.tU.u_sunColor, sky.sunColor[0], sky.sunColor[1], sky.sunColor[2]);
    gl.uniform1f(this.tU.u_sunI, sky.sunIntensity);
    gl.uniform3f(this.tU.u_moonDir, sky.moonDir[0], sky.moonDir[1], sky.moonDir[2]);
    gl.uniform3f(this.tU.u_moonColor, sky.moonColor[0], sky.moonColor[1], sky.moonColor[2]);
    gl.uniform1f(this.tU.u_moonFactor, sky.moonFactor);
    gl.uniform3f(this.tU.u_skyColor, sky.skyColor[0], sky.skyColor[1], sky.skyColor[2]);
    gl.uniform3f(this.tU.u_groundColor, sky.groundColor[0], sky.groundColor[1], sky.groundColor[2]);
    gl.uniform1f(this.tU.u_skyI, sky.skyIntensity);
    gl.uniform1f(this.tU.u_formLightNW, 0.32); // relief-inversion guard; tuned by the noon squint gate
    gl.uniform1f(this.tU.u_ambientFloor, AMBIENT_FLOOR);
    gl.uniform1f(this.tU.u_warmLow, 0.06);
    gl.uniform1f(this.tU.u_coolHigh, 0.1);
    // detail fades in 0→1 across ppm 0.6→2.6 (strategic stays byte-faithful; tactical/close resolve)
    gl.uniform1f(this.tU.u_detailGain, Math.max(0, Math.min(1, (cam.ppm - 0.6) / 2.0)));
    gl.uniform1f(this.tU.u_tileMeters, TILE_METERS);
    gl.uniform1f(this.tU.u_time, env.secondsOfDay);

    const a = env.atmo;
    gl.uniform2f(this.tU.u_cloudOffset, a.cloudOffset[0], a.cloudOffset[1]);
    gl.uniform1f(this.tU.u_cloudScale, a.cloudScale);
    gl.uniform1f(this.tU.u_cloudDensity, a.cloudDensity);
    gl.uniform1f(this.tU.u_cloudStrength, a.cloudStrength);
    gl.uniform1f(this.tU.u_fogThickness, a.fogThickness);
    gl.uniform1f(this.tU.u_fogFade, a.fogFade);
    gl.uniform1f(this.tU.u_fogStrength, a.fogStrength);
    gl.uniform3f(this.tU.u_fogColor, a.fogColor[0], a.fogColor[1], a.fogColor[2]);
    gl.uniform1f(this.tU.u_hazeStrength, a.hazeStrength);
    gl.uniform3f(this.tU.u_hazeColor, a.hazeColor[0], a.hazeColor[1], a.hazeColor[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ── PASS C: HDR → ACES tonemap + grade + dither → sRGB → visible canvas ─────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.compositeProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
    gl.uniform1i(this.cU.u_hdr, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex);
    gl.uniform1i(this.cU.u_bloom, 1);
    gl.uniform1f(this.cU.u_bloomStrength, 0.0); // C8 turns bloom on
    gl.uniform1f(this.cU.u_sceneExposure, SCENE_EXPOSURE);
    const g = sky.grade;
    gl.uniform1f(this.cU.u_exposure, g.exposure);
    gl.uniform3f(this.cU.u_whiteBalance, g.whiteBalance[0], g.whiteBalance[1], g.whiteBalance[2]);
    gl.uniform1f(this.cU.u_saturation, g.saturation);
    gl.uniform3f(this.cU.u_lift, g.lift[0], g.lift[1], g.lift[2]);
    gl.uniform2f(this.cU.u_res, bw, bh);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost as EventListener);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored as EventListener);
    const gl = this.gl;
    if (!gl) return;
    for (const t of [this.albedoTex, this.heightTex, this.shadowTex, this.floorTex, this.aoTex, this.flowTex, this.waterMaskTex, this.hdrTex, this.bloomTex, this.landIdTex, this.controlTex, this.matAlbedoTex, this.matNormalTex]) if (t) gl.deleteTexture(t);
    if (this.shadowFbo) gl.deleteFramebuffer(this.shadowFbo);
    if (this.hdrFbo) gl.deleteFramebuffer(this.hdrFbo);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.terrainProg) gl.deleteProgram(this.terrainProg);
    if (this.compositeProg) gl.deleteProgram(this.compositeProg);
    if (this.shadowProg) gl.deleteProgram(this.shadowProg);
    this.gl = null;
    this.terrainProg = null;
    this.compositeProg = null;
  }
}
