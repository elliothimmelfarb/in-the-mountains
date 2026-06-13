// The WebGL2 terrain underlayer. Sits on its own opaque canvas BELOW the existing 2D canvas
// and renders the relief in one fullscreen-triangle draw, lit by the live clock sun with cast
// ridge shadows. If WebGL2 is unavailable or the context is lost unrecoverably, `ok` goes
// false and WorldView falls back to the byte-identical 2D bake path.
//
// Per-frame: one terrain draw (1 draw call). The cast-shadow visibility map is ray-marched
// into a 1024² R8 FBO ONLY when the sun direction moves past a threshold (≤ a few Hz), so at
// 1× it rebakes about once a game-minute and at time-warp the shadow line visibly sweeps the
// valley — the master clock made literal.

import type { Terrain } from "../../sim/terrain";
import type { Camera } from "../topo";
import type { SkyState } from "../sky";
import { bakeAlbedo } from "../topo";
import { TERRAIN_VERT, TERRAIN_FRAG_LIT, SHADOW_VERT, SHADOW_FRAG } from "./shaders";

export interface TerrainEnv {
  /** camera-punch offset in CSS px — same value applied to the 2D ctx transform */
  shakePx: { x: number; y: number };
  /** the single sun/moon/light state from lib/render/sky.ts */
  sky: SkyState;
}

const BG: [number, number, number] = [0x0c / 255, 0x0d / 255, 0x0a / 255];
const SHADOW_SIZE = 1024; // 2.5 m / texel across the 2.56 km map
const REBAKE_COS = Math.cos((0.25 * Math.PI) / 180); // rebake when the key dir moves > 0.25°
const REBAKE_MIN_MS = 200; // wall-clock rate limiter only (output stays angle-determined → deterministic at a pinned clock)

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
  private shadowProg: WebGLProgram | null = null;
  private tU: Record<string, WebGLUniformLocation | null> = {};
  private sU: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private albedoTex: WebGLTexture | null = null;
  private heightTex: WebGLTexture | null = null;
  private shadowTex: WebGLTexture | null = null;
  private shadowFbo: WebGLFramebuffer | null = null;
  private terrain: Terrain | null = null;
  private worldSize = 2560;
  private cell = 5;
  private grid = 512;
  private minElev = 0;
  private elevRange = 1;
  private lastKeyDir: [number, number, number] | null = null;
  private lastBakeMs = -1e9;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onLost as EventListener, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored as EventListener, false);
    this.init();
  }

  get ok(): boolean {
    return !!this.gl && !!this.terrainProg;
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
    const tp = link(gl, TERRAIN_VERT, TERRAIN_FRAG_LIT);
    const sp = link(gl, SHADOW_VERT, SHADOW_FRAG);
    if (!tp || !sp) {
      this.gl = null;
      return;
    }
    this.terrainProg = tp;
    this.shadowProg = sp;
    this.tU = uniforms(gl, tp, [
      "u_camCenter", "u_viewCss", "u_ppm", "u_shakePx", "u_worldSize", "u_bgColor",
      "u_albedo", "u_shadow", "u_height", "u_cell", "u_grid", "u_minElev", "u_elevRange",
      "u_sunDir", "u_sunColor", "u_sunI", "u_moonDir", "u_moonColor", "u_moonFactor",
      "u_skyColor", "u_groundColor", "u_skyI",
      "u_keyGain", "u_formLightNW", "u_warmLow", "u_coolHigh", "u_hazeBase", "u_hazeFalloff", "u_hazeColor",
      "u_exposure", "u_whiteBalance", "u_saturation", "u_lift",
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
    if (this.terrain) this.uploadTextures(this.terrain);
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

  private onLost = (e: Event) => {
    e.preventDefault();
    this.gl = null;
    this.terrainProg = null;
  };

  private onRestored = () => {
    this.albedoTex = null;
    this.heightTex = null;
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
    if (!this.ok || !gl || !this.terrainProg || !this.albedoTex || !this.heightTex) return;
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
    gl.uniform1f(this.tU.u_keyGain, 1.0);
    gl.uniform1f(this.tU.u_formLightNW, 0.32); // relief-inversion guard (P4); tuned by the noon squint gate
    gl.uniform1f(this.tU.u_warmLow, 0.08);
    gl.uniform1f(this.tU.u_coolHigh, 0.13);
    gl.uniform1f(this.tU.u_hazeBase, 0.1);
    gl.uniform1f(this.tU.u_hazeFalloff, 0.16);
    gl.uniform3f(this.tU.u_hazeColor, 164 / 255, 170 / 255, 166 / 255);
    const g = sky.grade;
    gl.uniform1f(this.tU.u_exposure, g.exposure);
    gl.uniform3f(this.tU.u_whiteBalance, g.whiteBalance[0], g.whiteBalance[1], g.whiteBalance[2]);
    gl.uniform1f(this.tU.u_saturation, g.saturation);
    gl.uniform3f(this.tU.u_lift, g.lift[0], g.lift[1], g.lift[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost as EventListener);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored as EventListener);
    const gl = this.gl;
    if (!gl) return;
    for (const t of [this.albedoTex, this.heightTex, this.shadowTex]) if (t) gl.deleteTexture(t);
    if (this.shadowFbo) gl.deleteFramebuffer(this.shadowFbo);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.terrainProg) gl.deleteProgram(this.terrainProg);
    if (this.shadowProg) gl.deleteProgram(this.shadowProg);
    this.gl = null;
    this.terrainProg = null;
  }
}
