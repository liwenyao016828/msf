package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func completeProxyPageSettings() map[string]any {
	return map[string]any{
		"version": 3, "groupProxiesByProvider": false, "hideUnavailable": false,
		"showHiddenProxies": false, "manageHiddenGroups": false,
		"autoDisconnectOnSwitch": true, "displayFinalOutbound": false,
		"disableProxiesPageTextSelect": true, "doubleColumn": true,
		"displayGlobalByMode": true, "minProxyCardWidth": 145,
		"delayTimeoutMs": 5000, "delayLowMs": 400, "delayHighMs": 800,
		"proxyGroupIconSize": 24, "proxyGroupIconMargin": 12,
		"sortBy": "default", "nodeNameDisplay": "truncate",
		"proxyPreviewType": "auto", "proxyCardSize": "comfortable",
		"delayTestUrl": "https://example.org/generate_204",
		"groupOrder":   []string{}, "hiddenGroups": []string{},
	}
}

func TestProxyPageSettingsInstancePersistenceAndPermissions(t *testing.T) {
	app := newTestApp(t)
	admin := tokenForRole(t, app, "admin")
	viewer := tokenForRole(t, app, "viewer")
	path := "/api/v1/settings/proxy-page"
	read := requestJSON(t, app, http.MethodGet, path, viewer, nil)
	if read.Code != http.StatusOK || read.Body.String() != "{\"data\":null,\"success\":true}\n" {
		t.Fatalf("initial GET = %d %s", read.Code, read.Body.String())
	}
	settings := completeProxyPageSettings()
	settings["sortBy"] = "delay-desc"
	settings["groupOrder"] = []string{"B", "A"}
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		denied := requestJSON(t, app, method, path, viewer, settings)
		if denied.Code != http.StatusForbidden {
			t.Fatalf("viewer %s = %d", method, denied.Code)
		}
	}
	imported := requestJSON(t, app, http.MethodPost, path, admin, settings)
	if imported.Code != http.StatusOK {
		t.Fatalf("admin import = %d %s", imported.Code, imported.Body.String())
	}
	other := completeProxyPageSettings()
	other["sortBy"] = "name-asc"
	if res := requestJSON(t, app, http.MethodPost, path, admin, other); res.Code != http.StatusOK {
		t.Fatalf("repeat import = %d", res.Code)
	}
	read = requestJSON(t, app, http.MethodGet, path, viewer, nil)
	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(read.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data["sortBy"] != "delay-desc" {
		t.Fatalf("repeat import overwrote saved order: %v", body.Data)
	}
	invalid := completeProxyPageSettings()
	invalid["minProxyCardWidth"] = -1
	if res := requestJSON(t, app, http.MethodPut, path, admin, invalid); res.Code != http.StatusBadRequest {
		t.Fatalf("invalid PUT = %d", res.Code)
	}
	updated := requestJSON(t, app, http.MethodPut, path, admin, other)
	if updated.Code != http.StatusOK {
		t.Fatalf("admin PUT = %d %s", updated.Code, updated.Body.String())
	}
	read = requestJSON(t, app, http.MethodGet, path, viewer, nil)
	if err := json.Unmarshal(read.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data["sortBy"] != "name-asc" {
		t.Fatalf("updated order not shared: %v", body.Data)
	}
}
