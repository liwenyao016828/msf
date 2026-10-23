import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../../app/settings/SettingsClient.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../components/AppShell.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8");
const scene = readFileSync(new URL("../../components/liquid-glass/SceneBackdrop.tsx", import.meta.url), "utf8");
const waves = readFileSync(new URL("../../components/react-bits/GradientWaves.tsx", import.meta.url), "utf8");
const sceneStyles = readFileSync(new URL("../../styles/liquid-glass-scenes.css", import.meta.url), "utf8");
const skin = readFileSync(new URL("../../lib/skin.ts", import.meta.url), "utf8");
const amberSkin = readFileSync(new URL("../../styles/skin-amber.css", import.meta.url), "utf8");

describe("appearance initialization contract", () => {
  it("resizes the persistent waves without remounting on route or quality changes", () => {
    expect(scene).not.toContain("key={");
    expect(waves).toContain("const { options, maxDpr, maxRenderPixels } = current.current");
    expect(waves).toContain("syncRef.current = sync");
    expect(waves).toContain("syncRef.current();");
    expect(waves).toContain("}, [powerPreference]);");
    expect(waves).not.toContain("}, [maxDpr, maxRenderPixels, powerPreference]);");
  });
  it("defaults new browsers to dynamic balanced without overriding explicit quality", () => {
    expect(main).toContain('root.dataset.garyScene = savedScene === "static" || savedScene === "neutral" ? savedScene : "dynamic"');
    expect(main).toContain('savedQuality === "full" || savedQuality === "reduced" ? savedQuality : "balanced"');
    // Never-chosen wide (desktop) viewports default to the light mode, because
    // the animated scene blocks the main thread *synchronously* there and the
    // runtime watchdog can never get a first sample to react to. Phones keep
    // the animated default; screen.width avoids mislabeling landscape phones.
    expect(main).toContain('const wideDevice = (window.screen?.width || window.innerWidth || 0) >= 900;');
    expect(main).toContain('if (savedScene === null && (wideDevice || isSoftwareGpu() || window.matchMedia("(prefers-reduced-motion: reduce)").matches || readLowPowerMode()))');
    expect(main).toContain('root.dataset.garyScene = "static"');
    // The same first visit must seed the orb's degrade record, otherwise the
    // AI panel still pays the orb shader freeze behind a static scene.
    expect(main).toContain('localStorage.setItem(ORB_DEGRADED_KEY, "1")');
    // No-menu escape hatch for a machine stuck on a stored "dynamic" choice.
    expect(main).toContain('new URLSearchParams(window.location.search).get("safe") === "1"');
    // Settings hydration must never clobber the weak-device bootstrap with the
    // server's "dynamic"/"balanced" never-chosen fallback: local choice wins,
    // then the capability-decided bootstrap, then the server value.
    expect(settings).toContain('const localScene = localStorage.getItem("msf-glass-scene")');
    expect(settings).toContain('const bootstrapScene = document.documentElement.dataset.garyScene');
    expect(settings).toContain('const localQuality = localStorage.getItem("msf-glass-quality")');
    expect(login).toContain("normalizeGlassQuality(root.dataset.garyQuality)");
    expect(login).toContain("maxRenderPixels={qualityProfile.pixels}");
    expect(login).toContain("maxDpr={qualityProfile.dpr}");
  });

  it("keeps classic glass as the default skin and lets login waves follow skin tokens", () => {
    expect(skin).toContain('DEFAULT_SKIN: SkinId = "classic"');
    expect(login).toContain('attributeFilter: ["class", "data-gary-scene", "data-gary-quality", "data-skin"]');
    expect(login).toContain('getPropertyValue("--gary-scene-wave-horizon")');
    expect(login).toContain('getPropertyValue("--gary-scene-wave")');
    expect(login).toContain('getPropertyValue("--gary-scene-wave-crest")');
    expect(amberSkin).toContain('--gary-scene-wave: #7a4a24');
    expect(amberSkin).toContain('--gary-scene-wave-crest: #fb923c');
  });

  it("uses the complete v0.4.7.x scene on both the app shell and login", () => {
    expect(settings).toContain("主页与登录页恢复 v0.4.7.5 / v0.4.7.7 的静态背景特效");
    expect(shell).not.toContain("<SceneBackdrop />");
    expect(readFileSync(new URL("../../App.tsx", import.meta.url), "utf8")).toContain("<SceneBackdrop />");
    expect(login).toContain("<SceneBackdrop />");
    expect(scene).toContain('className="gary-scene__legacy-gradient"');
    expect(scene).toContain('className="gary-scene__legacy-silk"');
    expect(sceneStyles).toContain(".gary-scene__legacy-gradient::before");
    expect(sceneStyles).toContain("radial-gradient(ellipse 56% 44% at 18% 18%, var(--gary-scene-a), transparent 72%)");
    expect(sceneStyles).toContain(".gary-scene__legacy-gradient::after");
    expect(sceneStyles).toContain(".gary-scene__legacy-silk");
    expect(sceneStyles).toContain("color-mix(in srgb, var(--gary-scene-a) 66%, transparent)");
  });
});
