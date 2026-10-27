import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App";
import { AuthProvider } from "@/lib/auth";
import { LanguageProvider } from "@/lib/localization";
import {
  CONTENT_PLATE_SETTINGS_STORAGE_KEY,
  DEFAULT_CONTENT_PLATE_OPACITY,
  LEGACY_CONTENT_PLATE_OPACITY_STORAGE_KEY,
  applyContentPlateOpacityCss,
  migrateLegacyContentPlateOpacity,
  parseStoredContentPlateOpacity,
  type ContentPlateOpacity,
} from "@/lib/content-plate-opacity";
import { getInitialSkin, restoreCachedCustomCSS } from "@/lib/skin";
import { restoreCachedAccentColor } from "@/lib/accent";
import { restoreCachedSkinTint } from "@/lib/skinTint";
import { isSoftwareGpu } from "@/lib/gpu-probe";
import { ORB_DEGRADED_KEY, readLowPowerMode } from "@/lib/perf-watchdog";
import { ORB_SAFE_MODE_KEY } from "@/components/assistant/orb/orb-capability";
import "@/app/globals.css";

const root = document.documentElement;
const savedLanguage = localStorage.getItem("msf-language");
root.lang = savedLanguage === "en-US" || savedLanguage === "en" ? "en-US" : "zh-CN";
const savedTheme = localStorage.getItem("msf-theme");
const useDarkTheme = savedTheme === "dark" || (savedTheme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
root.classList.toggle("dark", useDarkTheme);
root.classList.toggle("light", !useDarkTheme);
// Support escape hatch: opening MSF with ?safe=1 forces the light/static look
// even when an older explicit "dynamic" choice is stored, and persists it so
// the next plain visit stays smooth. No menus, no devtools required. It also
// pins the orb to its poster: the freeze-every-load bug was a stored
// server-side "dynamic" orb preference re-arming the heavy shader each visit.
try {
  if (new URLSearchParams(window.location.search).get("safe") === "1") {
    localStorage.setItem("msf-glass-scene", "static");
    localStorage.setItem("msf-glass-quality", "reduced");
    localStorage.setItem(ORB_SAFE_MODE_KEY, "1");
  }
} catch {
  // URL/storage access can fail in hardened webviews; ignore.
}
const savedScene = localStorage.getItem("msf-glass-scene");
const savedQuality = localStorage.getItem("msf-glass-quality");
root.dataset.garyScene = savedScene === "static" || savedScene === "neutral" ? savedScene : "dynamic";
root.dataset.garyQuality = savedQuality === "full" || savedQuality === "reduced" ? savedQuality : "balanced";
// First-visit default. The animated full-screen scene stalls the main thread
// *synchronously* on wide desktop viewports: a single huge raymarched first
// frame can block rAF long enough that the runtime watchdog never gets its
// first sample — which is why "phone fine / desktop frozen in BOTH Chrome and
// Firefox" was never caught by device-class guessing (deviceMemory is
// Chromium-only, Firefox masks renderer strings, and desktop GPUs look
// "capable" regardless). Phones pass their small canvas cheaply and keep the
// animated default; screen.width is the un-rotated logical width, so landscape
// phones are not mislabeled as desktops. Unknown (never-chosen) wide devices
// start static + reduced + static orb; one click in 设置→外观·场景背景
// switches them back to dynamic permanently.
const wideDevice = (window.screen?.width || window.innerWidth || 0) >= 900;
if (savedScene === null && (wideDevice || isSoftwareGpu() || window.matchMedia("(prefers-reduced-motion: reduce)").matches || readLowPowerMode())) {
  root.dataset.garyScene = "static";
  if (savedQuality === null) root.dataset.garyQuality = "reduced";
  // Seed the orb's degrade record for the same first visit, otherwise opening
  // the AI panel still pays the orb shader freeze behind a static scene.
  // AssistantOrb clears this when the user picks an explicit orb mode.
  try {
    if (localStorage.getItem(ORB_DEGRADED_KEY) === null) {
      localStorage.setItem(ORB_DEGRADED_KEY, "1");
      localStorage.setItem(`${ORB_DEGRADED_KEY}-reason`, "宽屏设备首次访问默认静态（可在设置→系统→AI 助手切回动态）");
    }
  } catch {
    // Storage blocked: the static scene bootstrap still applies this session.
  }
}
root.dataset.skin = getInitialSkin();
restoreCachedAccentColor();
restoreCachedSkinTint();
restoreCachedCustomCSS();

function readInitialContentPlateOpacity(): ContentPlateOpacity {
  try {
    const cached = parseStoredContentPlateOpacity(localStorage.getItem(CONTENT_PLATE_SETTINGS_STORAGE_KEY));
    if (cached) return cached;

    const migrated = migrateLegacyContentPlateOpacity(localStorage.getItem(LEGACY_CONTENT_PLATE_OPACITY_STORAGE_KEY));
    const initial = migrated || DEFAULT_CONTENT_PLATE_OPACITY;
    // A migrated value is written once so subsequent loads never depend on the
    // legacy key. Defaults are cached as well to make the first paint stable.
    localStorage.setItem(CONTENT_PLATE_SETTINGS_STORAGE_KEY, JSON.stringify(initial));
    return initial;
  } catch {
    return DEFAULT_CONTENT_PLATE_OPACITY;
  }
}

// Restore plate opacity before React mounts, avoiding a visible first-paint
// transition while the settings page is still loading from the API.
applyContentPlateOpacityCss(readInitialContentPlateOpacity(), root);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
