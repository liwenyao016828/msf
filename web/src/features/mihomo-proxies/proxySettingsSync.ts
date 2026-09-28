import { api, apiData } from "@/lib/api";
import { hasStoredProxySettings, normalizeProxySettings, readProxySettings, writeProxySettings } from "./settings";
import type { ProxyPageSettings } from "./types";

export const PROXY_PAGE_SETTINGS_API = "/api/v1/settings/proxy-page";

/** A missing server snapshot is the only case where legacy browser settings may be imported. */
export async function loadProxyPageSettings(isAdmin: boolean): Promise<ProxyPageSettings> {
  const payload = await api(PROXY_PAGE_SETTINGS_API);
  const serverValue = apiData<ProxyPageSettings | null>(payload, null);
  if (serverValue !== null) return writeProxySettings(normalizeProxySettings(serverValue));
  if (isAdmin && hasStoredProxySettings()) {
    const legacy = readProxySettings();
    // Another admin may have initialized the instance meanwhile. Re-read before
    // importing; server-side compare-and-set is used below for the final guard.
    const imported = await api(PROXY_PAGE_SETTINGS_API, { method: "POST", body: JSON.stringify(legacy) });
    return writeProxySettings(normalizeProxySettings(apiData(imported, legacy)));
  }
  return writeProxySettings(normalizeProxySettings({}));
}

export async function saveProxyPageSettings(settings: ProxyPageSettings): Promise<ProxyPageSettings> {
  const payload = await api(PROXY_PAGE_SETTINGS_API, { method: "PUT", body: JSON.stringify(settings) });
  return writeProxySettings(normalizeProxySettings(apiData(payload, settings)));
}
