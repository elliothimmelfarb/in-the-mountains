// The WebGL2 terrain underlayer. Sits on its own opaque canvas BELOW the existing 2D canvas
// and renders the relief in one fullscreen-triangle draw. C2 ships blit parity — it samples
// the existing baked bitmap so the picture is identical to the old drawImage path — and
// proves the whole rig (canvas stack, camera transform, DPR, resize, context loss, headless
// GPU) before C3 makes the light real. If WebGL2 is unavailable or the context is lost
// unrecoverably, `ok` goes false and WorldView falls back to the byte-identical 2D path.

import type { Terrain } from "../../sim/terrain";
import type { Camera } from "../topo";
import { bakeTerrain } from "../topo";
import { TERRAIN_VERT, TERRAIN_FRAG_BLIT } from "./shaders";

export interface TerrainEnv {
  /** camera-punch offset in CSS px — same value applied to the 2D ctx transform */
  shakePx: { x: number; y: number };
}

// page bg-bg token (#0c0d0a) for fragments outside the world rect
const BG: [number, number, number] = [0x0c / 255, 0x0d / 255, 0x0a / 255];

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

export class TerrainGL {
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private albedoTex: WebGLTexture | null = null;
  private uloc: Record<string, WebGLUniformLocation | null> = {};
  private terrain: Terrain | null = null;
  private worldSize = 2560;
  private dpr = 1;
  private contextOk = false;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onLost as EventListener, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored as EventListener, false);
    this.init();
  }

  /** True iff the GL path is usable this frame. WorldView branches on this. */
  get ok(): boolean {
    return this.contextOk;
  }

  private init() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false, // opaque bottom layer → cheapest compositing
      antialias: false,
      preserveDrawingBuffer: false, // we redraw every rAF; harness composites the page, not the backbuffer
      depth: false,
      stencil: false,
    });
    if (!gl) {
      this.contextOk = false;
      return;
    }
    this.gl = gl;
    const prog = link(gl, TERRAIN_VERT, TERRAIN_FRAG_BLIT);
    if (!prog) {
      this.contextOk = false;
      return;
    }
    this.prog = prog;
    for (const name of ["u_camCenter", "u_viewCss", "u_ppm", "u_shakePx", "u_albedo", "u_worldSize", "u_bgColor"]) {
      this.uloc[name] = gl.getUniformLocation(prog, name);
    }
    // fullscreen triangle (covers NDC with one primitive, no diagonal seam)
    const tri = new Float32Array([-1, -1, 3, -1, -1, 3]);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.contextOk = true;
    // a terrain set before (re)init — re-upload its textures
    if (this.terrain) this.uploadTextures(this.terrain);
  }

  private onLost = (e: Event) => {
    e.preventDefault(); // required so a restore event can fire
    this.contextOk = false;
  };

  private onRestored = () => {
    this.gl = null;
    this.prog = null;
    this.albedoTex = null;
    this.init();
  };

  /** Upload the relief bitmap as the albedo texture (C2: the lit bake; C3: unlit albedo). */
  setTerrain(t: Terrain) {
    this.terrain = t;
    this.worldSize = t.worldSize;
    if (this.contextOk) this.uploadTextures(t);
  }

  private uploadTextures(t: Terrain) {
    const gl = this.gl;
    if (!gl) return;
    const baked = bakeTerrain(t); // cached WeakMap hit after the deploy warm-bake
    if (!this.albedoTex) this.albedoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); // texture row 0 = canvas top = world y 0 (north)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, baked.canvas);
    gl.generateMipmap(gl.TEXTURE_2D); // trilinear minification → no shimmer when zoomed out
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(cam: Camera, env: TerrainEnv) {
    const gl = this.gl;
    if (!this.contextOk || !gl || !this.prog || !this.albedoTex) return;
    // backing store in device px (cap dpr at 2, same as the 2D canvas WorldView:183)
    this.dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const bw = Math.round(cam.vw * this.dpr);
    const bh = Math.round(cam.vh * this.dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.uniform1i(this.uloc.u_albedo, 0);
    gl.uniform2f(this.uloc.u_camCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uloc.u_viewCss, cam.vw, cam.vh);
    gl.uniform1f(this.uloc.u_ppm, cam.ppm);
    gl.uniform2f(this.uloc.u_shakePx, env.shakePx.x, env.shakePx.y);
    gl.uniform1f(this.uloc.u_worldSize, this.worldSize);
    gl.uniform3f(this.uloc.u_bgColor, BG[0], BG[1], BG[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost as EventListener);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored as EventListener);
    const gl = this.gl;
    if (!gl) return;
    if (this.albedoTex) gl.deleteTexture(this.albedoTex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.prog) gl.deleteProgram(this.prog);
    this.contextOk = false;
  }
}
