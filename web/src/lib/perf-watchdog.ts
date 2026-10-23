/**
 * Whole-page performance watchdog.
 *
 * Capability *probing* has blind spots: Firefox masks UNMASKED_RENDERER_WEBGL,
 * deviceMemory is Chromium-only, and a "capable-looking" desktop GPU can still
 * drop frames under the full-screen wave scene plus the orb shader. Instead of
 * guessing, this watchdog measures the main thread's actual frame pacing a
 * moment after first paint. Sustained stalls degrade the page immediately
 * (static scene + static orb) and persist the decision per browser, so the
 * very next visit starts smooth. A user who explicitly picks effects later
 * overrides the record.
 */

/** Persisted flag read by main.tsx bootstrap and the orb capability check. */
export const LOW_POWER_KEY = "msf-low-power-mode";
/** Orb-side record reused so AssistantOrb starts static on later visits. */
export const ORB_DEGRADED_KEY = "msf-assistant-orb-degraded";
/** Fired on window when a degrade decision lands, for live components. */
export const LOW_POWER_EVENT = "msf-low-power";

export type GapStats = {
  /** Inter-frame gaps above the stall threshold, excluding tab wake-ups. */
  stallCount: number;
  /** Longest gap in ms, for logging. */
  maxGapMs: number;
};

export type WatchdogOptions = {
  /** Minimum ms between frames counted as a stall. */
  stallThresholdMs?: number;
  /** A single frame gap this long is a hard freeze: degrade on the first one. */
  hardStallMs?: number;
  /** Frames to sample after the settle delay. */
  sampleFrames?: number;
  /** Delay before sampling, so cold-parse long tasks don't trip it. */
  settleMs?: number;
  /** Stall count that proves the device cannot sustain the animated page. */
  stallBudget?: number;
  onDegrade?: (stats: GapStats) => void;
};

const DEFAULTS = {
  stallThresholdMs: 150,
  // A page that stalls the main thread for a few seconds on a single frame is
  // exactly the "freeze" report; one such gap condemns the device outright,
  // without waiting for the milder jank streak below.
  hardStallMs: 2500,
  // Cold load includes hydration + first paint; require a clean baseline
  // before counting, and a sustained streak (5 stalls ≈ one per second on a
  // 30fps-capable device) so GC pauses don't condemn an otherwise smooth box.
  sampleFrames: 90,
  settleMs: 1800,
  stallBudget: 5,
};

/** Pure decision used by tests: how many stalls condemn the page? */
export function isUnsmooth(stats: GapStats, stallBudget: number): boolean {
  return stats.stallCount >= stallBudget;
}

export function readLowPowerMode(): boolean {
  try {
    return window.localStorage.getItem(LOW_POWER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Apply the degrade now + persist it for future visits. Idempotent. */
export function degradeNow(stats: GapStats): void {
  try {
    window.localStorage.setItem(LOW_POWER_KEY, "1");
    // Reuse the orb's own memory so it starts static next load without
    // waiting for its guard to re-measure.
    window.localStorage.setItem(ORB_DEGRADED_KEY, "1");
    window.localStorage.setItem(
      `${ORB_DEGRADED_KEY}-reason`,
      `页面实测掉帧（${stats.stallCount} 次卡顿，最长 ${Math.round(stats.maxGapMs)}ms）`,
    );
  } catch {
    // Storage blocked: the in-session degrade still applies.
  }
  // SceneBackdrop watches data-gary-scene via MutationObserver; static mode
  // stops the full-screen wave loop on the next frame immediately.
  document.documentElement.dataset.garyScene = "static";
  document.documentElement.dataset.garyQuality = "reduced";
  window.dispatchEvent(new CustomEvent(LOW_POWER_EVENT, { detail: stats }));
}

/**
 * Start measuring once per page load. Returns a disposer.
 * Skips work entirely when the user already saved an explicit scene choice —
 * an explicit pick is respected and only re-checked if they clear it.
 */
export function startPerfWatchdog(options: WatchdogOptions = {}): () => void {
  const { stallThresholdMs, hardStallMs, sampleFrames, settleMs, stallBudget, onDegrade } = {
    ...DEFAULTS,
    ...options,
  };
  let explicitChoice = false;
  try {
    explicitChoice = window.localStorage.getItem("msf-glass-scene") !== null;
  } catch {
    explicitChoice = false;
  }
  if (explicitChoice || readLowPowerMode()) return () => {};

  let raf = 0;
  let timer = 0;
  let cancelled = false;
  let frames = 0;
  let stallCount = 0;
  let maxGapMs = 0;
  let last = 0;

  const finish = () => {
    const stats: GapStats = { stallCount, maxGapMs };
    degradeNow(stats);
    onDegrade?.(stats);
  };

  const tick = (now: number) => {
    if (cancelled) return;
    if (document.visibilityState !== "visible") {
      // Paused while hidden: rAF stops, so the next gap is a wake artifact.
      last = 0;
      raf = requestAnimationFrame(tick);
      return;
    }
    // last===0 means the previous sample was skipped (start or wake-up); do
    // not count the frame that ends a hidden period as jank.
    if (last > 0) {
      const gap = now - last;
      if (gap > maxGapMs) maxGapMs = gap;
      if (gap >= stallThresholdMs) stallCount += 1;
      // One sustained multi-second freeze during steady state condemns the
      // device immediately; waiting for the jank streak would let the page
      // stay frozen the whole time the user is staring at it.
      if (gap >= hardStallMs || stallCount >= stallBudget) {
        finish();
        return;
      }
    }
    last = now;
    frames += 1;
    if (frames < sampleFrames) {
      raf = requestAnimationFrame(tick);
      return;
    }
  };

  timer = window.setTimeout(() => {
    raf = requestAnimationFrame(tick);
  }, settleMs);

  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
  };
}
