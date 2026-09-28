import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useAuth } from "@/lib/auth";
import { normalizeProxySettings, readProxySettings, writeProxySettings } from "./settings";
import { loadProxyPageSettings, saveProxyPageSettings } from "./proxySettingsSync";
import type { ProxyPageSettings } from "./types";

/** Server-authoritative instance preferences. localStorage is only a first-paint cache. */
export function useProxySettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [settings, setSettingsState] = useState<ProxyPageSettings>(() => readProxySettings());
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState("");
  const settingsRef = useRef(settings);
  const confirmedRef = useRef(settings);
  const writesRef = useRef<Promise<unknown>>(Promise.resolve());
  const revisionRef = useRef(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setReady(false);
    void loadProxyPageSettings(isAdmin).then((serverSettings) => {
      if (!active) return;
      confirmedRef.current = serverSettings;
      settingsRef.current = serverSettings;
      setSettingsState(serverSettings);
      setReady(true);
    }).catch(() => {
      if (active) setSaveError("读取代理页面设置失败，请刷新后重试");
    });
    return () => { active = false; };
  }, [user?.id, isAdmin]);

  const setSettings = useCallback((action: SetStateAction<ProxyPageSettings>) => {
    if (!isAdmin || !ready) return;
    const candidate = typeof action === "function" ? action(settingsRef.current) : action;
    const next = normalizeProxySettings(candidate);
    const revision = ++revisionRef.current;
    settingsRef.current = next;
    setSettingsState(next);
    setSaveError("");
    // Serialize snapshots so a slow earlier PUT cannot overwrite a later choice.
    writesRef.current = writesRef.current.catch(() => undefined).then(() => saveProxyPageSettings(next)).then((saved) => {
      confirmedRef.current = saved;
    }).catch(() => {
      if (revision !== revisionRef.current) return;
      settingsRef.current = confirmedRef.current;
      setSettingsState(confirmedRef.current);
      writeProxySettings(confirmedRef.current);
      setSaveError("代理页面设置保存失败，已恢复到上次保存的值");
    });
  }, [isAdmin, ready]);

  const resetSettings = useCallback(() => setSettings(normalizeProxySettings({})), [setSettings]);

  return { settings, setSettings, resetSettings, ready, canEditSettings: ready && isAdmin, saveError };
}
