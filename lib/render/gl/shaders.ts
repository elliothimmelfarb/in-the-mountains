// GLSL source for the WebGL2 terrain underlayer. C2 (blit parity) ships ONLY the textured-
// quad program below: it samples the existing baked relief bitmap and outputs it unchanged,
// so the GL path is pixel-comparable to the 2D drawImage path and proves the canvas stack /
// camera transform / DPR / resize / fallback before any lighting lands in C3.
//
// The vertex shader is the real, final camera transform (the inverse of worldToScreen,
// topo.ts:12) — a fullscreen triangle whose interpolated v_world is the world-meter position
// under each fragment. C3 keeps this vertex shader verbatim and only grows the fragment.

export const TERRAIN_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_clip;   // fullscreen triangle: (-1,-1) (3,-1) (-1,3)
uniform vec2  u_camCenter;             // cx, cy (world meters)
uniform vec2  u_viewCss;               // vw, vh (CSS px — DPR-independent)
uniform float u_ppm;                   // CSS px per meter
uniform vec2  u_shakePx;               // camera-punch offset (CSS px), matches the 2D transform
out vec2 v_world;
void main() {
  gl_Position = vec4(a_clip, 0.0, 1.0);
  // Invert worldToScreen: NDC +y is up, world/screen +y is south(down) → negate y.
  // Subtracting shake reproduces the 2D ctx.setTransform pixel offset (WorldView:199-201).
  vec2 fromCenter = vec2(a_clip.x, -a_clip.y) * u_viewCss * 0.5 - u_shakePx;
  v_world = u_camCenter + fromCenter / u_ppm;
}`;

// C2 fragment: sample the baked (already-lit) relief, output it, fill the page bg outside the
// world rect. No lighting — the whole point is parity with the 2D blit.
export const TERRAIN_FRAG_BLIT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_world;
uniform sampler2D u_albedo;   // the baked relief bitmap (lit, for C2)
uniform float u_worldSize;    // 2560.0
uniform vec3  u_bgColor;      // page bg-bg token, for fragments off the map
out vec4 o;
void main() {
  vec2 uv = v_world / u_worldSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    o = vec4(u_bgColor, 1.0);
    return;
  }
  o = vec4(texture(u_albedo, uv).rgb, 1.0);
}`;
