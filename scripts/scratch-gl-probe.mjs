// scratch-gl-probe — verify the WebGL2 capabilities the 10x HDR pipeline depends on, on the
// EXACT headless path the screenshot harness uses. The whole PASS-A(HDR)→PASS-B(bloom)→
// PASS-C(ACES/grade/dither) pipeline rests on RGBA16F being a renderable FBO attachment under
// SwiftShader; the material spine rests on R8UI textures + usampler2D. Trust nothing — measure.
//
//   node scripts/scratch-gl-probe.mjs            # SwiftShader (portable / CI path)
//   node scripts/scratch-gl-probe.mjs --gpu      # real GPU (this machine's ANGLE/Metal)
import { spawn } from "node:child_process";

const GPU = process.argv.includes("--gpu");
const PORT = 9337;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  ...(GPU ? [] : ["--use-angle=swiftshader"]),
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-glprobe-profile",
  "--window-size=400,300", "about:blank",
], { stdio: "ignore" });

const pending = new Map();
let ws, id = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + method)); } }, 20000);
});
async function cdp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const t = await r.json();
      const p = t.find((x) => x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("no CDP target");
}

const PROBE = `(() => {
  const out = {};
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const gl = c.getContext('webgl2', { alpha:false, antialias:false });
  if (!gl) return JSON.stringify({ webgl2:false });
  out.webgl2 = true;
  out.vendor = gl.getParameter(gl.VENDOR);
  out.renderer = gl.getParameter(gl.RENDERER);
  out.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  out.maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  out.ext_color_buffer_float = !!gl.getExtension('EXT_color_buffer_float');
  out.ext_color_buffer_half_float = !!gl.getExtension('EXT_color_buffer_half_float');
  out.oes_texture_float_linear = !!gl.getExtension('OES_texture_float_linear');
  out.ext_float_blend = !!gl.getExtension('EXT_float_blend');

  // RGBA16F as a renderable FBO color attachment — the HDR target
  const hdr = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, hdr);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, 256, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hdr, 0);
  out.rgba16f_fbo_status = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? 'COMPLETE' : 'INCOMPLETE:'+gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  out.rgba16f_renderable = out.rgba16f_fbo_status === 'COMPLETE';
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // RGBA8 packed-exposure fallback target (must also work)
  const ldr = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, ldr);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo2 = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ldr, 0);
  out.rgba8_fbo = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // R8UI 512² integer texture (material-ID spine) + usampler2D compile/link
  gl.getError();
  const idtex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, idtex);
  const ids = new Uint8Array(512*512); ids[0]=10; ids[1]=25;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 512, 512, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ids);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  out.r8ui_upload_err = gl.getError();
  out.r8ui_upload_ok = out.r8ui_upload_err === 0;

  // RG8 (flow field) upload
  gl.getError();
  const rg = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, rg);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 512, 512, 0, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array(512*512*2));
  out.rg8_upload_ok = gl.getError() === 0;

  // compile+link a usampler2D shader (texelFetch of the material id)
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, '#version 300 es\\nvoid main(){gl_Position=vec4(0.,0.,0.,1.);}'); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, '#version 300 es\\nprecision highp float;precision highp usampler2D;uniform usampler2D u;out vec4 o;void main(){uint v=texelFetch(u,ivec2(0),0).r;o=vec4(float(v)/255.,0.,0.,1.);}');
  gl.compileShader(fs);
  out.usampler_fs_compiled = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
  const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  out.usampler_linked = gl.getProgramParameter(pr, gl.LINK_STATUS);
  if (!out.usampler_fs_compiled) out.usampler_fs_log = gl.getShaderInfoLog(fs);

  // R32F renderability (for an HBAO bake into a float FBO, if we go that route)
  const r32 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, r32);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 256, 0, gl.RED, gl.FLOAT, null);
  const fbo3 = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo3);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, r32, 0);
  out.r32f_renderable = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return JSON.stringify(out);
})()`;

(async () => {
  try {
    ws = new WebSocket(await cdp());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await send("Runtime.enable");
    const r = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
    const o = JSON.parse(r.result.value);
    console.log(`\n=== WebGL2 capability probe (${GPU ? "REAL GPU" : "SwiftShader --use-angle=swiftshader"}) ===`);
    for (const [k, v] of Object.entries(o)) console.log(`  ${k.padEnd(28)} ${v}`);
    const ok = o.webgl2 && o.rgba16f_renderable && o.r8ui_upload_ok && o.rg8_upload_ok && o.usampler_linked && o.rgba8_fbo;
    console.log(`\n  HDR-PIPELINE-VIABLE: ${ok ? "YES ✓ (RGBA16F default path)" : (o.rgba8_fbo ? "FALLBACK-ONLY (RGBA8 packed-exposure)" : "NO")}`);
  } catch (e) { console.error("PROBE FAIL", e.message); process.exitCode = 1; }
  finally { try { ws && ws.close(); } catch {} chrome.kill("SIGKILL"); }
})();
