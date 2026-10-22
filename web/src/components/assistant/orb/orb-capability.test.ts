import { describe, expect, it } from "vitest";
import { isWeakDevice, resolveOrbCapability, type OrbCapabilityInput } from "./orb-capability";

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

  it("does not flag unknown values as weak", () => {
    expect(isWeakDevice({ hardwareConcurrency: null, deviceMemory: null, gpuRenderer: null })).toBe(false);
  });
});

describe("resolveOrbCapability", () => {
  it("honors the explicit static preference", () => {
    expect(resolveOrbCapability({ ...base, preference: "static" }).mode).toBe("static");
  });

  it("honors the explicit dynamic preference even on a weak device", () => {
    const result = resolveOrbCapability({
      preference: "dynamic",
      embedded: false,
      reducedMotion: true,
      hardwareConcurrency: 2,
      deviceMemory: 2,
      gpuRenderer: "SwiftShader",
    });
    expect(result.mode).toBe("dynamic");
  });

  it("degrades to static when embedded in an iframe", () => {
    expect(resolveOrbCapability({ ...base, embedded: true }).mode).toBe("static");
  });

  it("degrades to static under prefers-reduced-motion", () => {
    expect(resolveOrbCapability({ ...base, reducedMotion: true }).mode).toBe("static");
  });

  it("degrades to static on a weak device", () => {
    const result = resolveOrbCapability({ ...base, hardwareConcurrency: 2, deviceMemory: 2 });
    expect(result.mode).toBe("static");
    expect(result.reason).toContain("弱设备");
  });

  it("renders dynamically on a capable device", () => {
    expect(resolveOrbCapability(base).mode).toBe("dynamic");
  });
});
