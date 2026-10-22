/**
 * Orb capability detection.
 *
 * The glass orb runs a very heavy procedural shader. On weak devices (few CPU
 * cores, little RAM, or a software/emulated GPU) a single frame can take
 * seconds, and the WebGPU adapter request may never settle — both cases freeze
 * the whole page behind the orb. We therefore resolve a render mode BEFORE the
 * first frame is drawn and degrade to the static poster orb instead.
 */

import { detectGpuRenderer, looksLikeSoftwareRenderer } from "@/lib/gpu-probe";

export type OrbMode = "auto" | "dynamic" | "static";
export type ResolvedOrbMode = "dynamic" | "static";

export interface OrbCapabilityInput {
  /** Server/user preference. `dynamic` forces animation, `static` forces poster. */
  preference: OrbMode;
  embedded: boolean;
  reducedMotion: boolean;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  gpuRenderer: string | null;
}

/** A device is "weak" when it hits one of these heuristics. */
export function isWeakDevice(input: {
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  gpuRenderer: string | null;
}): boolean {
  const cores = input.hardwareConcurrency;
  const memory = input.deviceMemory;

  // Few cores AND little RAM is the classic low-end phone / old laptop.
  if (cores !== null && cores > 0 && cores <= 4 && memory !== null && memory > 0 && memory <= 4) {
    return true;
  }
  // 2GB is below the practical floor for a GPU-backed animation.
  if (memory !== null && memory > 0 && memory <= 2) {
    return true;
  }
  // Software rasterizer = the fragment shader runs on the CPU thread by thread.
  if (looksLikeSoftwareRenderer(input.gpuRenderer)) {
    return true;
  }
  return false;
}

export function resolveOrbCapability(input: OrbCapabilityInput): { mode: ResolvedOrbMode; reason: string } {
  if (input.preference === "static") {
    return { mode: "static", reason: "已设置为静态悬浮球" };
  }
  if (input.preference === "dynamic") {
    return { mode: "dynamic", reason: "已强制动态悬浮球" };
  }
  if (input.embedded) {
    return { mode: "static", reason: "嵌入宿主 iframe，跳过 GPU 初始化" };
  }
  if (input.reducedMotion) {
    return { mode: "static", reason: "系统开启减弱动态效果" };
  }
  if (isWeakDevice(input)) {
    return { mode: "static", reason: "检测到弱设备，降级为静态悬浮球" };
  }
  return { mode: "dynamic", reason: "自动模式，启用动态渲染" };
}

/** Read the signals available from the browser. Keep it defensive: every
 * probe must fail closed (never crash the page) and never block first paint. */
export function collectOrbCapability(preference: OrbMode): OrbCapabilityInput {
  const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  return {
    preference,
    embedded: detectEmbedded(),
    reducedMotion: Boolean(media?.matches),
    hardwareConcurrency: readHardwareConcurrency(),
    deviceMemory: readDeviceMemory(),
    gpuRenderer: detectGpuRenderer(),
  };
}

export function resolveOrbMode(preference: OrbMode): { mode: ResolvedOrbMode; reason: string } {
  return resolveOrbCapability(collectOrbCapability(preference));
}

function detectEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent -> definitely embedded.
    return true;
  }
}

function readHardwareConcurrency(): number | null {
  try {
    const value = navigator.hardwareConcurrency;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readDeviceMemory(): number | null {
  try {
    const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
