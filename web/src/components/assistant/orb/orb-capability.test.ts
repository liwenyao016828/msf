import { describe, expect, it } from "vitest";
import { isWeakDevice, resolveOrbCapability, resolveOrbStartup, type OrbCapabilityInput, type OrbStartupInput } from "./orb-capability";

const base: OrbCapabilityInput = {
  preference: "auto",
  embedded: false,
  reducedMotion: false,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  gpuRenderer: "Apple M2",
};

describe("isWeakDevice", () => {
  it("flags few cores paired with little RAM", () => {
    expect(isWeakDevice({ hardwareConcurrency: 4, deviceMemory: 4, gpuRenderer: "Intel Iris" })).toBe(true);
    expect(isWeakDevice({ hardwareConcurrency: 2, deviceMemory: 3, gpuRenderer: "Intel HD" })).toBe(true);
  });

  it("flags very small RAM on any core count", () => {
    expect(isWeakDevice({ hardwareConcurrency: 8, deviceMemory: 2, gpuRenderer: "Apple M2" })).toBe(true);
  });

  it("flags software rasterizers even on capable hardware", () => {
    expect(isWeakDevice({ hardwareConcurrency: 8, deviceMemory: 8, gpuRenderer: "SwiftShader" })).toBe(true);
    expect(isWeakDevice({ hardwareConcurrency: 8, deviceMemory: 8, gpuRenderer: "llvmpipe" })).toBe(true);
    expect(isWeakDevice({ hardwareConcurrency: 8, deviceMemory: 8, gpuRenderer: "ANGLE (Intel, Software Rendering)" })).toBe(true);
  });

  it("keeps capable hardware dynamic", () => {
    expect(isWeakDevice({ hardwareConcurrency: 8, deviceMemory: 8, gpuRenderer: "Apple M2" })).toBe(false);
    expect(isWeakDevice({ hardwareConcurrency: 16, deviceMemory: 8, gpuRenderer: "NVIDIA GeForce" })).toBe(false);
  });

  it("fails closed when the renderer string is unavailable", () => {
    // Firefox (since 2020) masks UNMASKED_RENDERER_WEBGL, and some Chromium
    // privacy modes do too. "Cannot prove hardware" must be treated as weak,
    // otherwise the heaviest shader is allowed onto an unverified device.
    expect(isWeakDevice({ hardwareConcurrency: null, deviceMemory: null, gpuRenderer: null })).toBe(true);
    expect(isWeakDevice({ hardwareConcurrency: null, deviceMemory: null, gpuRenderer: "" })).toBe(true);
  });
});

describe("resolveOrbCapability", () => {
  it("honors the explicit static preference", () => {
    expect(resolveOrbCapability({ ...base, preference: "static" }).mode).toBe("static");
  });

  it("still refuses the shader for a software rasterizer under an explicit dynamic", () => {
    // A server-forced "dynamic" used to bypass every safety check, which made
    // the page freeze on every load. A software rasterizer is a hardware
    // fact, so it now vetoes even an explicit preference.
    const result = resolveOrbCapability({
      preference: "dynamic",
      embedded: false,
      reducedMotion: true,
      hardwareConcurrency: 2,
      deviceMemory: 2,
      gpuRenderer: "SwiftShader",
    });
    expect(result.mode).toBe("static");
    expect(result.reason).toContain("软件渲染");
  });

  it("still refuses the shader when the renderer string is masked under an explicit dynamic", () => {
    const result = resolveOrbCapability({
      preference: "dynamic",
      embedded: false,
      reducedMotion: false,
      hardwareConcurrency: 16,
      deviceMemory: 8,
      gpuRenderer: null,
    });
    expect(result.mode).toBe("static");
  });

  it("honors the explicit dynamic preference on verified hardware despite weak cores/RAM", () => {
    const result = resolveOrbCapability({
      preference: "dynamic",
      embedded: false,
      reducedMotion: true,
      hardwareConcurrency: 2,
      deviceMemory: 2,
      gpuRenderer: "Apple M2",
    });
    expect(result.mode).toBe("dynamic");
  });

  it("degrades to static when embedded in an iframe", () => {
    expect(resolveOrbCapability({ ...base, embedded: true }).mode).toBe("static");
  });

  it("renders statically on auto even on a capable device (static-by-default policy)", () => {
    // Per user decision: stop detecting. Auto never picks dynamic now, no
    // matter how capable the device looks.
    expect(resolveOrbCapability(base).mode).toBe("static");
  });

  it("renders statically on auto even on a weak device", () => {
    const result = resolveOrbCapability({ ...base, hardwareConcurrency: 2, deviceMemory: 2 });
    expect(result.mode).toBe("static");
  });

  it("renders dynamically only with an explicit dynamic preference on verified hardware", () => {
    // Auto is static by policy now; dynamic requires the explicit preference
    // plus a verified real GPU.
    expect(resolveOrbCapability(base).mode).toBe("static");
    expect(resolveOrbCapability({ ...base, preference: "dynamic", gpuRenderer: "Apple M2" }).mode).toBe("dynamic");
  });
});

const startupBase: OrbStartupInput = {
  ...base,
  degraded: false,
  safeMode: false,
  explicitChoice: false,
};

describe("resolveOrbStartup", () => {
  it("keeps a server-forced dynamic static after a measured freeze on reload", () => {
    // The freeze-every-load bug: preference=dynamic was re-arming the shader
    // on every page load because the degrade record was wiped at mount.
    const decision = resolveOrbStartup({ ...startupBase, preference: "dynamic", degraded: true });
    expect(decision.mode).toBe("static");
    expect(decision.clearDegraded).toBe(false);
    expect(decision.reason).toContain("回退静态");
  });

  it("keeps auto static after a measured freeze", () => {
    const decision = resolveOrbStartup({ ...startupBase, preference: "auto", degraded: true });
    expect(decision.mode).toBe("static");
    expect(decision.clearDegraded).toBe(false);
  });

  it("allows one deliberate retry when the user re-picks dynamic in settings", () => {
    const decision = resolveOrbStartup({ ...startupBase, preference: "dynamic", degraded: true, explicitChoice: true });
    expect(decision.mode).toBe("dynamic");
    expect(decision.clearDegraded).toBe(true);
  });

  it("does not clear the degrade record when the deliberate retry is still vetoed", () => {
    const decision = resolveOrbStartup({
      ...startupBase,
      preference: "dynamic",
      degraded: true,
      explicitChoice: true,
      gpuRenderer: "SwiftShader",
    });
    expect(decision.mode).toBe("static");
    expect(decision.clearDegraded).toBe(false);
  });

  it("pins static under ?safe=1 even when the server forces dynamic", () => {
    const decision = resolveOrbStartup({ ...startupBase, preference: "dynamic", safeMode: true });
    expect(decision.mode).toBe("static");
    expect(decision.clearSafe).toBe(false);
  });

  it("lets a deliberate dynamic choice lift the safe pin", () => {
    const decision = resolveOrbStartup({ ...startupBase, preference: "dynamic", safeMode: true, explicitChoice: true });
    expect(decision.mode).toBe("dynamic");
    expect(decision.clearSafe).toBe(true);
  });

  it("never clears records for an explicit static choice", () => {
    const decision = resolveOrbStartup({ ...startupBase, preference: "static", degraded: true, safeMode: true, explicitChoice: true });
    expect(decision.mode).toBe("static");
    expect(decision.clearDegraded).toBe(false);
    expect(decision.clearSafe).toBe(false);
  });
});
