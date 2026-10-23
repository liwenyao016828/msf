import { describe, expect, it, vi } from "vitest";
import { degradeNow, isUnsmooth, type GapStats } from "./perf-watchdog";

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
