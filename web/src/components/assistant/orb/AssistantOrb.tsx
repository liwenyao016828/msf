import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { OrbRenderer, type OrbRendererBackend, type OrbRenderState } from "./OrbRenderer";
import { resolveOrbMode, type OrbMode, type ResolvedOrbMode } from "./orb-capability";
import { LOW_POWER_EVENT, ORB_DEGRADED_KEY } from "@/lib/perf-watchdog";
import "./assistant-orb.css";

interface AssistantOrbProps {
  state?: OrbRenderState;
  onClick?: () => void;
  disabled?: boolean;
  /** Server-persisted preference; auto still probes the device at runtime. */
  mode?: OrbMode;
}

/** Set once the runtime guard measures unusable frame costs on this device +
 * browser. `auto` then starts static immediately instead of re-freezing the
 * page on every visit. Cleared when the user makes an explicit mode choice.
 * Same key the whole-page watchdog writes in perf-watchdog.ts. */
const DEGRADED_KEY = ORB_DEGRADED_KEY;

function readDegraded(): boolean {
  try {
    return window.localStorage.getItem(DEGRADED_KEY) === "1";
  } catch {
    return false;
  }
}

function markDegraded(reason: string): void {
  try {
    window.localStorage.setItem(DEGRADED_KEY, "1");
    window.localStorage.setItem(`${DEGRADED_KEY}-reason`, reason);
  } catch {
    // Storage can be blocked; the in-session degrade still applies.
  }
}

function clearDegraded(): void {
  try {
    window.localStorage.removeItem(DEGRADED_KEY);
    window.localStorage.removeItem(`${DEGRADED_KEY}-reason`);
  } catch {
    // Ignore blocked storage.
  }
}

function initialCapability(mode: OrbMode): { mode: ResolvedOrbMode; reason: string } {
  if (mode === "auto" && readDegraded()) {
    return { mode: "static", reason: "本机上次渲染过慢，已降级为静态悬浮球" };
  }
  return resolveOrbMode(mode);
}

export function AssistantOrb({ state = "idle", onClick, disabled = false, mode = "auto" }: AssistantOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dockedSide, setDockedSide] = useState<"left" | "right" | null>(null);
  const [rendererBackend, setRendererBackend] = useState<OrbRendererBackend | null>(null);

  // Probe once at mount and whenever the server preference changes. The
  // weak-device check creates a small WebGL context, so it must not run on
  // every render; a lazy state initializer keeps it out of the render phase.
  const [capability, setCapability] = useState(() => initialCapability(mode));
  useEffect(() => {
    // An explicit server choice (dynamic/static) supersedes the runtime
    // degrade record; auto keeps it.
    if (mode !== "auto") clearDegraded();
    setCapability(initialCapability(mode));
  }, [mode]);
  // The whole-page watchdog can decide mid-session that this device can't
  // sustain the animated scene; flip the orb to static immediately rather
  // than only on the next load.
  useEffect(() => {
    const onLowPower = () => {
      if (mode === "auto") setCapability({ mode: "static", reason: "页面实测掉帧，已降级为静态悬浮球" });
    };
    window.addEventListener(LOW_POWER_EVENT, onLowPower);
    return () => window.removeEventListener(LOW_POWER_EVENT, onLowPower);
  }, [mode]);
  const staticOrb = capability.mode === "static";

  const getBounds = () => {
    const size = 72;
    const mobile = window.innerWidth <= 767;
    const bottomClearance = mobile ? 96 : 16;
    return {
      size,
      minX: -size / 2,
      maxX: Math.max(-size / 2, window.innerWidth - size / 2),
      minY: 8,
      maxY: Math.max(8, window.innerHeight - size - bottomClearance),
    };
  };

  const clampPosition = (x: number, y: number) => {
    const bounds = getBounds();
    return {
      x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
      y: Math.min(bounds.maxY, Math.max(bounds.minY, y)),
    };
  };

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("msf-assistant-orb-position");
      if (!raw) return;
      const saved = JSON.parse(raw) as { x?: number; y?: number };
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPosition(clampPosition(Number(saved.x), Number(saved.y)));
    } catch {
      // A blocked storage area should not prevent the assistant from opening.
    }
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => current ? clampPosition(current.x, current.y) : current);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;
    // Degraded/static path: skip GPU init entirely so a weak device or an
    // embedded host iframe can never freeze the page behind the orb.
    if (staticOrb) {
      setRendererBackend(null);
      return;
    }
    const renderer = new OrbRenderer(canvas);
    rendererRef.current = renderer;
    let disposed = false;
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(canvas);
    const handleVisibility = () => renderer.setPaused(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", handleVisibility);
    // Cap the frame rate and bound the WebGPU adapter request so a hung GPU
    // init falls back to WebGL2 instead of blocking first paint forever. The
    // onTooSlow guard measures real frame cost on devices the static probe
    // cannot classify (masked deviceMemory / renderer strings) and, once it
    // trips, marks this device degraded so future visits start static.
    renderer
      .init({
        targetFps: 30,
        initTimeoutMs: 2000,
        onTooSlow: (detail) => {
          if (disposed) return;
          markDegraded(detail);
          setCapability({ mode: "static", reason: `检测到渲染过慢（${detail}），已降级为静态悬浮球` });
          setRendererBackend(null);
        },
      })
      .then((backend) => {
        if (!disposed) setRendererBackend(backend);
      })
      .catch(() => {
        if (!disposed) setRendererBackend(null);
      });
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      observer.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [disabled, staticOrb]);

  useEffect(() => {
    rendererRef.current?.setState(state);
  }, [state]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const origin = position || { x: rect.left, y: rect.top };
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
    element.setPointerCapture?.(event.pointerId);
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.left = `${origin.x}px`;
    element.style.top = `${origin.y}px`;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const next = clampPosition(drag.originX + dx, drag.originY + dy);
    const element = event.currentTarget;
    element.style.left = `${next.x}px`;
    element.style.top = `${next.y}px`;
    element.classList.add("assistant-orb--dragging");
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const bounds = getBounds();
    let next = clampPosition(rect.left, rect.top);
    let side: "left" | "right" | null = null;
    const dockThreshold = Math.max(40, bounds.size * 0.55);
    if (next.x <= dockThreshold) {
      next = { ...next, x: bounds.minX };
      side = "left";
    } else if (next.x >= bounds.maxX - dockThreshold) {
      next = { ...next, x: bounds.maxX };
      side = "right";
    }
    setPosition(next);
    setDockedSide(side);
    try {
      window.localStorage.setItem("msf-assistant-orb-position", JSON.stringify(next));
    } catch {
      // Position persistence is optional.
    }
    element.releasePointerCapture?.(event.pointerId);
    element.classList.remove("assistant-orb--dragging");
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick?.();
  };

  return (
    <button
      type="button"
      ref={orbRef}
      className={cn("assistant-orb", `assistant-orb--${state}`, rendererBackend ? "assistant-orb--rendered" : "assistant-orb--fallback", position && "assistant-orb--positioned", dockedSide && `assistant-orb--docked-${dockedSide}`, staticOrb && "assistant-orb--static")}
      data-renderer={rendererBackend || "fallback"}
      style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      disabled={disabled}
      aria-label="打开 AI 助手，可拖动到屏幕边缘"
      title="打开 AI 助手，拖动可贴边隐藏"
    >
      <canvas ref={canvasRef} className="assistant-orb__canvas" aria-hidden="true" />
      <span className="assistant-orb__fallback" aria-hidden="true" />
      <span className="assistant-orb__edge" aria-hidden="true" />
    </button>
  );
}
