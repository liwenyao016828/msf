import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROXY_SETTINGS, PROXY_SETTINGS_KEY_V2 } from "./settings";
import { loadProxyPageSettings, saveProxyPageSettings } from "./proxySettingsSync";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock, apiData: (payload: { data: unknown }) => payload.data }));

const originalWindow = globalThis.window;
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  apiMock.mockReset();
});

describe("instance proxy page preference sync", () => {
  it("server wins over a stale browser cache", async () => {
    values.set(PROXY_SETTINGS_KEY_V2, JSON.stringify({ ...DEFAULT_PROXY_SETTINGS, sortBy: "name-asc" }));
    apiMock.mockResolvedValue({ data: { ...DEFAULT_PROXY_SETTINGS, sortBy: "delay-desc" } });
    expect((await loadProxyPageSettings(true)).sortBy).toBe("delay-desc");
    expect(JSON.parse(values.get(PROXY_SETTINGS_KEY_V2)!).sortBy).toBe("delay-desc");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("imports an old cache only when the instance has no settings and the user is admin", async () => {
    values.set(PROXY_SETTINGS_KEY_V2, JSON.stringify({ ...DEFAULT_PROXY_SETTINGS, groupOrder: ["B", "A"] }));
    apiMock.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: { ...DEFAULT_PROXY_SETTINGS, groupOrder: ["B", "A"] } });
    expect((await loadProxyPageSettings(true)).groupOrder).toEqual(["B", "A"]);
    expect(apiMock.mock.calls[1][1].method).toBe("POST");
  });

  it("non-admin cannot import local settings into a new instance", async () => {
    values.set(PROXY_SETTINGS_KEY_V2, JSON.stringify({ ...DEFAULT_PROXY_SETTINGS, sortBy: "delay-desc" }));
    apiMock.mockResolvedValue({ data: null });
    expect((await loadProxyPageSettings(false)).sortBy).toBe("default");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("only caches a save after the backend confirms it", async () => {
    const value = { ...DEFAULT_PROXY_SETTINGS, sortBy: "name-desc" as const };
    apiMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: value });
    await expect(saveProxyPageSettings(value)).rejects.toThrow("offline");
    expect(values.has(PROXY_SETTINGS_KEY_V2)).toBe(false);
    await saveProxyPageSettings(value);
    expect(JSON.parse(values.get(PROXY_SETTINGS_KEY_V2)!).sortBy).toBe("name-desc");
  });
});
