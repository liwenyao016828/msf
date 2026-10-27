/**
 * Runtime render guard.
 *
 * Static capability probing (cores / deviceMemory / renderer string) has blind
 * spots: deviceMemory is Chromium-only, Firefox masks UNMASKED_RENDERER_WEBGL,
 * and some webviews expose nothing useful. This guard measures the actual
 * rendering cost on the current device and asks the owner to degrade when the
 * heavy orb shader demonstrably blocks the main thread.
 */

export type SlowRenderVerdict = {
  /** True when the orb must stop rendering and fall back to the static poster. */
  degrade: boolean;
};

export class SlowRenderGuard {
  private lastRenderAt = 0;
  private slowCostStreak = 0;
  private slowGapStreak = 0;

  /**
   * @param frameIntervalMs expected minimum spacing between rendered frames (1000/targetFps).
   * @param costThresholdMs main-thread cost of one frame above which the frame is "expensive".
   * @param gapFactor how many intervals of overrun counts the frame as dropped.
   */
  constructor(
    private readonly frameIntervalMs: number,
    private readonly costThresholdMs = 150,
    private readonly gapFactor = 3,
  ) {}

  /** Call at the end of every rendered frame with the values measured.
   * `costMs` = wall time spent inside the render callback.
   * `nowMs`  = the rAF timestamp of this frame. */
  observe(costMs: number, nowMs: number): SlowRenderVerdict {
    // The first rendered frame compiles the shader and can block the main
    // thread for seconds — and this watchdog runs on that same blocked thread,
    // so waiting for a second frame may never happen. Decide on the first
    // frame, then keep requiring two consecutive expensive frames afterwards.
    const isFirstFrame = this.lastRenderAt === 0;

    // Frame cost: a SwiftShader/software-rendered submit blocks the main
    // thread inside the callback.
    if (costMs >= this.costThresholdMs) {
      this.slowCostStreak += 1;
    } else {
      this.slowCostStreak = 0;
    }

    // Inter-frame gap: a heavily-loaded compositor drops frames even when the
    // callback itself returns fast. Ignore the first frame (no baseline).
    const interval = this.frameIntervalMs > 0 ? this.frameIntervalMs : 33;
    if (this.lastRenderAt > 0) {
      const gap = nowMs - this.lastRenderAt;
      // A tab hidden/restored (or resize) gap is a one-off event, not a
      // render-rate problem: anything beyond ~30s cannot indicate jank.
      if (gap > 30_000) {
        this.slowGapStreak = 0;
      } else if (gap > interval * this.gapFactor) {
        this.slowGapStreak += 1;
      } else {
        this.slowGapStreak = 0;
      }
    }
    this.lastRenderAt = nowMs;

    return {
      degrade:
        (isFirstFrame && this.slowCostStreak >= 1) ||
        this.slowCostStreak >= 2 ||
        this.slowGapStreak >= 10,
    };
  }
}
