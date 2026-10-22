import { describe, expect, it } from "vitest";
import { SlowRenderGuard } from "./render-guard";

describe("SlowRenderGuard", () => {
  it("degrades after two consecutive expensive frames", () => {
    const guard = new SlowRenderGuard(33, 150);
    expect(guard.observe(200, 1000).degrade).toBe(false);
    expect(guard.observe(210, 1100).degrade).toBe(true);
  });

  it("does not degrade for a single spike followed by a fast frame", () => {
    const guard = new SlowRenderGuard(33, 150);
    guard.observe(500, 1000);
    expect(guard.observe(20, 1033).degrade).toBe(false);
  });

  it("degrades on a sustained dropped-frame streak even when callbacks are fast", () => {
    // 33ms interval, gapFactor 3 -> a gap over 99ms counts as dropped.
    const guard = new SlowRenderGuard(33, 150, 3);
    let last = 1000;
    // Seed the baseline so every loop iteration is a real gap observation.
    guard.observe(5, last);
    let degrade = false;
    for (let i = 0; i < 10; i += 1) {
      last += 400; // compositor is producing ~2.5fps
      degrade = guard.observe(5, last).degrade;
    }
    expect(degrade).toBe(true);
  });

  it("treats a long tab wake-up gap as a one-off, not jank", () => {
    const guard = new SlowRenderGuard(33, 150, 3);
    guard.observe(5, 1000);
    // A 60s hidden gap must not seed the dropped-frame streak.
    guard.observe(5, 61000);
    // Then steady fast frames -> no degrade.
    let last = 61000;
    let degrade = false;
    for (let i = 0; i < 10; i += 1) {
      last += 40;
      degrade = guard.observe(5, last).degrade;
    }
    expect(degrade).toBe(false);
  });

  it("keeps healthy frame pacing below the thresholds", () => {
    const guard = new SlowRenderGuard(33, 150, 3);
    let last = 0;
    let degrade = false;
    for (let i = 0; i < 60; i += 1) {
      last += 40; // ~25fps delivered, each cheap
      degrade = guard.observe(30, last).degrade;
    }
    expect(degrade).toBe(false);
  });
});
