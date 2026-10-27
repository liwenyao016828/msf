import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { getAssistantStatus } from "@/features/assistant/api";
import { useAuth } from "@/lib/auth";
import { AssistantOrb } from "./orb/AssistantOrb";
import { AssistantPanel } from "./AssistantPanel";
import type { OrbRenderState } from "./orb/OrbRenderer";
import type { OrbMode } from "./orb/orb-capability";
import "./assistant.css";

/**
 * Escape hatch for a browser that freezes before settings can be reached:
 * opening MSF with `?ai=off` hides the assistant (orb + panel) on this
 * browser until `?ai=on` is opened. The kill persists in localStorage so
 * plain visits stay smooth; it is per-browser, and the server-side 启用
 * toggle in 设置→AI 助手 remains the real off switch.
 */
const AI_DISABLED_KEY = "msf-assistant-disabled";

function readAiKilled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("ai");
    if (param === "off") window.localStorage.setItem(AI_DISABLED_KEY, "1");
    else if (param === "on") window.localStorage.removeItem(AI_DISABLED_KEY);
    return window.localStorage.getItem(AI_DISABLED_KEY) === "1";
  } catch {
    // Hardened webviews can block URL/storage access; never break startup.
    return false;
  }
}

export function AssistantWidget() {
  const [enabled, setEnabled] = useState(false);
  const [orbEnabled, setOrbEnabled] = useState(false);
  const [orbMode, setOrbMode] = useState<OrbMode>("auto");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OrbRenderState>("idle");
  const [aiKilled] = useState(readAiKilled);
  const { user } = useAuth();

  useEffect(() => {
    if (aiKilled || user?.role !== "admin") {
      setEnabled(false);
      setOrbEnabled(false);
      setOrbMode("auto");
      return;
    }
    let active = true;
    const refresh = () => {
      getAssistantStatus().then((status) => {
        if (!active) return;
        const assistantOn = Boolean(status.admin && status.enabled);
        setEnabled(assistantOn);
        setOrbEnabled(assistantOn && Boolean(status.orb_enabled));
        setOrbMode(status.orb_mode === "dynamic" || status.orb_mode === "static" ? status.orb_mode : "auto");
      }).catch(() => {
        if (active) {
          setEnabled(false);
          setOrbEnabled(false);
        }
      });
    };
    refresh();
    window.addEventListener("msf-assistant-settings-updated", refresh);
    return () => {
      active = false;
      window.removeEventListener("msf-assistant-settings-updated", refresh);
    };
  }, [aiKilled, user?.role]);

  const handleStateChange = useCallback((next: OrbRenderState) => setState(next), []);
  if (!enabled) return null;

  return (
    <>
      {orbEnabled ? <AssistantOrb state={state} mode={orbMode} onClick={() => setOpen(true)} /> : null}
      {/*
        When the orb is switched off (or a static-only configuration hides it),
        the AI panel still needs an entry point. Show a compact button in the
        same bottom-right slot so the assistant is never unreachable.
      */}
      {!orbEnabled ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开 AI 助手"
          title="打开 AI 助手"
          className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-4 z-[65] grid h-12 w-12 place-items-center rounded-full border border-primary/40 bg-primary/15 text-primary shadow-[0_12px_32px_rgb(99_102_241_/_0.24)] backdrop-blur-xl transition hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:bottom-6 md:right-6 md:h-[52px] md:w-[52px]"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      ) : null}
      <AssistantPanel open={open} onClose={() => setOpen(false)} onStateChange={handleStateChange} />
    </>
  );
}
