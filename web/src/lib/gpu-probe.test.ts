import { describe, expect, it } from "vitest";

import { looksLikeSoftwareRenderer } from "./gpu-probe";

describe("looksLikeSoftwareRenderer", () => {
  it("fails closed when the renderer string is unavailable", () => {
    // Firefox masks WEBGL_debug_renderer_info (since 2020), and some Chromium
    // privacy modes do too: null is a normal return value, not proof of a
    // hardware GPU. The orb must degrade rather than run the heavy shader.
    expect(looksLikeSoftwareRenderer(null)).toBe(true);
    expect(looksLikeSoftwareRenderer("")).toBe(true);
  });

  it("flags software rasterizers", () => {
    expect(looksLikeSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(looksLikeSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(looksLikeSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))")).toBe(true);
  });

  it("keeps real hardware fast paths", () => {
    expect(looksLikeSoftwareRenderer("Apple M2")).toBe(false);
    expect(looksLikeSoftwareRenderer("ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
  });
});
