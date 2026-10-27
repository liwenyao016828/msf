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
  if (input.embedded) {
    return { mode: "static", reason: "嵌入宿主 iframe，跳过 GPU 初始化" };
  }
  // Per user decision (2026-10-27): stop detecting entirely. The dynamic orb's
  // heavy shader froze real installs even behind every fail-closed guard, so
  // the shipped behavior is static-by-default on every device. Dynamic stays
  // reachable only through an explicit settings choice AND only when the
  // capability probe verifies real hardware — auto never picks dynamic now.
  if (input.preference === "dynamic") {
    // A software rasterizer (or an unreadable renderer string — fail closed) is
    // a hardware fact: even an explicit "dynamic" preference must not put the
    // multi-second shader onto the CPU rasterizer.
    if (looksLikeSoftwareRenderer(input.gpuRenderer)) {
      return { mode: "static", reason: "检测到软件渲染（或无法确认硬件 GPU），已降级为静态悬浮球" };
    }
    return { mode: "dynamic", reason: "已强制动态悬浮球" };
  }
  // preference === "auto": static, unconditionally. No GPU probing, no weak-
  // device heuristics, no first-frame gamble.
  return { mode: "static", reason: "默认静态悬浮球（如需动画请在设置中手动选择动态球）" };
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

/**
 * Set by the `?safe=1` URL hatch: this browser explicitly asked for a
 * guaranteed-static page. Vetoes every dynamic path (including a
 * server-forced `dynamic` orb mode) until the user re-picks dynamic.
 */
export const ORB_SAFE_MODE_KEY = "msf-assistant-orb-safe";

export interface OrbStartupInput extends OrbCapabilityInput {
  /** ORB_DEGRADED_KEY: a previous run measured unusable frame costs here. */
  degraded: boolean;
  /** ORB_SAFE_MODE_KEY: `?safe=1` pinned this browser to static. */
  safeMode: boolean;
  /**
   * True only when the preference changed *while the orb was mounted* (the
   * user just made an explicit choice in settings), never on a plain page
   * load. Gates the one deliberate dynamic retry so a reload of a
   * server-forced "dynamic" can no longer wipe the degrade record on every
   * visit (the freeze-every-load bug).
   */
  explicitChoice: boolean;
}

export interface OrbStartupDecision {
  mode: ResolvedOrbMode;
  reason: string;
  /** Wipe the degrade record: granted only for a deliberate dynamic retry. */
  clearDegraded: boolean;
  /** Wipe the `?safe=1` pin: granted only for a deliberate dynamic retry. */
  clearSafe: boolean;
}

export function resolveOrbStartup(input: OrbStartupInput): OrbStartupDecision {
  if (input.preference === "static") {
    return { mode: "static", reason: "已设置为静态悬浮球", clearDegraded: false, clearSafe: false };
  }
  if (input.preference === "dynamic" && input.explicitChoice) {
    // Deliberate retry after a settings change: one fresh attempt. Hardware
    // facts (software rasterizer, embedded iframe) still veto inside the
    // capability resolve, and records are only wiped when the retry actually
    // starts a renderer.
    const resolved = resolveOrbCapability(input);
    return { ...resolved, clearDegraded: resolved.mode === "dynamic", clearSafe: resolved.mode === "dynamic" };
  }
  if (input.safeMode) {
    return { mode: "static", reason: "safe 模式：已锁定静态悬浮球", clearDegraded: false, clearSafe: false };
  }
  if (input.degraded) {
    return {
      mode: "static",
      reason: input.preference === "dynamic"
        ? "本机上次动态球渲染过慢，已回退静态（在设置里重新选择动态球可再试一次）"
        : "本机上次渲染过慢，已降级为静态悬浮球",
      clearDegraded: false,
      clearSafe: false,
    };
  }
  const resolved = resolveOrbCapability(input);
  return { ...resolved, clearDegraded: false, clearSafe: false };
}

/**
 * Which renderer actually came up on the last orb init, written for
 * self-diagnosis (devtools: localStorage['msf-assistant-orb-backend']).
 * "static" means the orb is the poster, so no GPU context was created.
 */
export const ORB_BACKEND_KEY = "msf-assistant-orb-backend";
/** Why that backend was chosen (e.g. "webgpu-adapter-null"). */
export const ORB_BACKEND_REASON_KEY = "msf-assistant-orb-backend-reason";

export type OrbActualBackend = "webgpu" | "webgl2" | "static";

/** Best-effort: blocked storage must never break orb startup. */
export function writeOrbBackend(backend: OrbActualBackend, reason?: string): void {
  try {
    window.localStorage.setItem(ORB_BACKEND_KEY, backend);
    if (reason) window.localStorage.setItem(ORB_BACKEND_REASON_KEY, reason);
  } catch {
    // Diagnostics only; nothing to do.
  }
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
