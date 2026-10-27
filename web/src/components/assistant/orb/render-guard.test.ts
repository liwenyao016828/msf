import { describe, expect, it } from "vitest";

import { SlowRenderGuard } from "./render-guard";

describe("SlowRenderGuard", () => {
  it("degrades immediately when the very first frame is expensive", () => {
    // First frame compiles the shader and can block for seconds; the watchdog
    // runs on the blocked thread, so waiting for a second frame never works.
    const guard = new SlowRenderGuard(33);
    expect(guard.observe(200, 1000).degrade).toBe(true);
  });

  it("needs two consecutive expensive frames after a healthy first frame", () => {
    const guard = new SlowRenderGuard(33);
    expect(guard.observe(10, 1000).degrade).toBe(false); // healthy first frame
    expect(guard.observe(200, 1100).degrade).toBe(false); // first expensive frame
    expect(guard.observe(210, 2200).degrade).toBe(true); // second consecutive
  });

  it("does not degrade for a single late spike followed by a fast frame", () => {
    const guard = new SlowRenderGuard(33);
    expect(guard.observe(10, 1000).degrade).toBe(false);
    expect(guard.observe(200, 1100).degrade).toBe(false);
    expect(guard.observe(5, 1133).degrade).toBe(false);
  });

  it("degrades on a sustained gap streak (dropped frames / saturated compositor)", () => {
    const guard = new SlowRenderGuard(33);
    expect(guard.observe(5, 1000).degrade).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      const verdict = guard.observe(5, 1400 + i * 400);
      if (i < 9) expect(verdict.degrade).toBe(false);
      else expect(verdict.degrade).toBe(true);
    }
  });

  it("does not degrade on a one-off long tab-wake gap", () => {
    const guard = new SlowRenderGuard(33);
    expect(guard.observe(5, 1000).degrade).toBe(false);
    expect(guard.observe(5, 1000 + 60_000).degrade).toBe(false);
  });

  it("does not degrade when the pace stays healthy", () => {
    const guard = new SlowRenderGuard(33);
    for (let i = 0; i < 20; i += 1) {
      expect(guard.observe(10, 1000 + i * 33).degrade).toBe(false);
    }
  });
});
