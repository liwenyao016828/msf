/**
 * Shared GPU probe.
 *
 * Several places need to know whether the browser is rasterizing in software
 * (SwiftShader / llvmpipe / ANGLE software): the assistant orb capability
 * check and the appearance bootstrap that decides the global scene default.
 * One cheap, defensive probe, one canonical renderer test.
 */

/** Software/emulated rasterizers: no real GPU, shader cost lands on the CPU. */
const SOFTWARE_RENDERER_RE =
  /swiftshader|llvmpipe|software rasterizer|software renderer|software rendering|basic render|microsoft basic|softpipe|mesa software|google swiftshader|angle.*software|vulkan.*swiftshader/i;

export function looksLikeSoftwareRenderer(renderer: string | null): boolean {
  return renderer !== null && SOFTWARE_RENDERER_RE.test(renderer);
}

/**
 * Ask the GPU for its real renderer string. Context creation on a 1×1 canvas
 * is a cheap, one-off probe. Returns null when unavailable (no WebGL, or the
 * browser masks UNMASKED_RENDERER_WEBGL — Firefox does since 2020).
 */
export function detectGpuRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return null;
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    if (!extension) return null;
    const renderer = gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === "string" ? renderer : null;
  } catch {
    return null;
  }
}

export function isSoftwareGpu(): boolean {
  return looksLikeSoftwareRenderer(detectGpuRenderer());
}
