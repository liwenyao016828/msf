import { describe, expect, it, vi, afterEach } from "vitest";
import {
  degradeNow,
  isUnsmooth,
  startPerfWatchdog,
  LOW_POWER_KEY,
  type GapStats,
} from "./perf-watchdog";

describe("isUnsmooth", () => {
  it("condemns sustained stalls but forgives isolated hitches", () => {
    const atBudget: GapStats = { stallCount: 5, maxGapMs: 320 };
    const below: GapStats = { stallCount: 4, maxGapMs: 900 };
    expect(isUnsmooth(atBudget, 5)).toBe(true);
    expect(isUnsmooth(below, 5)).toBe(false);
  });
});

describe("degradeNow", () => {
  it("persists the decision and freezes the animated scene immediately", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { documentElement: root });

    degradeNow({ stallCount: 5, maxGapMs: 320 });

    expect(store.get("msf-low-power-mode")).toBe("1");
    expect(store.get("msf-assistant-orb-degraded")).toBe("1");
    expect(root.dataset.garyScene).toBe("static");
    expect(root.dataset.garyQuality).toBe("reduced");
  });

  it("survives blocked storage without throwing", () => {
    vi.stubGlobal("window", {
      localStorage: { setItem: () => { throw new Error("blocked"); } },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(() => degradeNow({ stallCount: 6, maxGapMs: 500 })).not.toThrow();
  });
});

describe("startPerfWatchdog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Drives the detection loop by feeding rAF callbacks timestamps the test
  // controls, so a hard freeze vs a mild jank streak can be asserted directly.
  function harness(initialStore: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initialStore));
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let rafCb: ((t: number) => void) | null = null;
    let clock = 0;
    const raf = (cb: (t: number) => void) => { rafCb = cb; return 1; };
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: vi.fn(),
      setTimeout: (fn: () => void, _ms: number) => { fn(); return 0; },
      clearTimeout: () => {},
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} }, visibilityState: "visible" });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", () => { rafCb = null; });
    const pump = (stepMs: number, times: number) => {
      for (let i = 0; i < times && rafCb; i += 1) {
        clock += stepMs;
        const cb = rafCb;
        rafCb = null;
        cb(clock);
      }
    };
    return { store, pump };
  }

  it("degrades on a single multi-second freeze during steady sampling", () => {
    const h = harness();
    startPerfWatchdog({ hardStallMs: 2500, stallBudget: 5, sampleFrames: 90 });
    h.pump(16, 2);            // baseline + one smooth frame
    h.pump(4000, 1);          // one hard freeze -> immediate degrade
    expect(h.store.get(LOW_POWER_KEY)).toBe("1");
  });

  it("degrades on a sustained mild-jank streak", () => {
    const h = harness();
    startPerfWatchdog({ hardStallMs: 2500, stallThresholdMs: 150, stallBudget: 3, sampleFrames: 90 });
    h.pump(16, 1);            // baseline
    h.pump(300, 3);           // three 300ms stalls -> over budget
    expect(h.store.get(LOW_POWER_KEY)).toBe("1");
  });

  it("stays silent when pacing is smooth", () => {
    const h = harness();
    startPerfWatchdog({ hardStallMs: 2500, stallThresholdMs: 150, stallBudget: 5, sampleFrames: 60 });
    h.pump(33, 60);           // steady ~30fps, every gap < threshold
    expect(h.store.get(LOW_POWER_KEY)).toBeUndefined();
  });

  it("skips entirely when the user already picked a look", () => {
    const h = harness({ "msf-glass-scene": "dynamic" });
    const dispose = startPerfWatchdog({});
    h.pump(4000, 3);          // even a hard freeze must not trip it
    expect(h.store.get(LOW_POWER_KEY)).toBeUndefined();
    expect(typeof dispose).toBe("function");
  });
});
