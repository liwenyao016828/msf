package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func startLearningLifecycleFixture(t *testing.T, a *App, marker string) {
	t.Helper()
	quoted := "'" + strings.ReplaceAll(marker, "'", "'\\''") + "'"
	installTestMosDNSBinary(t, a, "marker="+quoted+"\ntrap 'touch \"$marker\"; sleep 0.5; exit 0' TERM\nwhile :; do sleep 0.1; done\n")
	if _, err := a.Services.Start(context.Background(), "mosdns"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Services.Shutdown(context.Background()) })
}

func TestMosDNSLearningCanceledClientStillRestoresService(t *testing.T) {
	a := newTestApp(t)
	marker := filepath.Join(t.TempDir(), "term-received")
	startLearningLifecycleFixture(t, a, marker)
	oldPID := a.Services.Status("mosdns").PID
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for ctx.Err() == nil {
			if _, err := os.Stat(marker); err == nil {
				cancel()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	if err := a.replaceMosDNSLearningFiles(ctx, map[string][]string{"fakeiprule.txt": {"full:new.test"}}); err != nil {
		t.Fatal(err)
	}
	<-stopped
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("request was not canceled during stop")
	}
	st := a.Services.Status("mosdns")
	if !st.Running || st.PID == oldPID {
		t.Fatalf("resolver was not restarted: %+v", st)
	}
	got, err := a.readTextFile("configs/mosdns/gen/fakeiprule.txt")
	if err != nil || got != "full:new.test\n" {
		t.Fatalf("replacement did not finish: %q %v", got, err)
	}
}

func TestMosDNSLearningCanceledBeforeStartLeavesServiceAndFilesAlone(t *testing.T) {
	a := newTestApp(t)
	marker := filepath.Join(t.TempDir(), "term-received")
	startLearningLifecycleFixture(t, a, marker)
	oldPID := a.Services.Status("mosdns").PID
	const rel = "configs/mosdns/gen/fakeiprule.txt"
	if err := a.writeTextFile(rel, "full:keep.test\n"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.replaceMosDNSLearningFiles(ctx, map[string][]string{"fakeiprule.txt": nil}); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if st := a.Services.Status("mosdns"); !st.Running || st.PID != oldPID {
		t.Fatalf("canceled operation touched service: %+v", st)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("canceled operation sent SIGTERM")
	}
	if got, _ := a.readTextFile(rel); got != "full:keep.test\n" {
		t.Fatalf("canceled operation modified file: %q", got)
	}
}

func TestMosDNSLearningWriteFailureRestoresService(t *testing.T) {
	a := newTestApp(t)
	startLearningLifecycleFixture(t, a, filepath.Join(t.TempDir(), "term-received"))
	const rel = "configs/mosdns/gen/fakeiprule.txt"
	if err := a.writeTextFile(rel, "full:keep.test\n"); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(a.DataDir, "configs/mosdns/gen/realiprule.txt")
	if err := os.Remove(bad); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(bad, 0755); err != nil {
		t.Fatal(err)
	}
	err := a.replaceMosDNSLearningFiles(context.Background(), map[string][]string{"fakeiprule.txt": {"full:new.test"}, "realiprule.txt": nil})
	if err == nil {
		t.Fatal("expected write preparation failure")
	}
	if !a.Services.Status("mosdns").Running {
		t.Fatal("write failure left resolver stopped")
	}
	if got, _ := a.readTextFile(rel); got != "full:keep.test\n" {
		t.Fatalf("partial write: %q", got)
	}
}

func TestMosDNSLearningReplacementDoesNotStartStoppedService(t *testing.T) {
	a := newTestApp(t)
	if err := a.replaceMosDNSLearningFiles(context.Background(), map[string][]string{"fakeiprule.txt": {"full:new.test"}}); err != nil {
		t.Fatal(err)
	}
	if a.Services.Status("mosdns").Running {
		t.Fatal("stopped resolver was started")
	}
}

func seedLegacyLearningConfig(t *testing.T, a *App) {
	t.Helper()
	if err := os.Remove(filepath.Join(a.DataDir, mosDNSLearningMigrationMarker)); err != nil {
		t.Fatal(err)
	}
	for _, migration := range mosDNSLearningMigrations {
		content, err := os.ReadFile(filepath.Join("testdata/mosdns_learning_v066", migration.file))
		if err != nil {
			t.Fatal(err)
		}
		if err := a.writeTextFile("configs/mosdns/sub_config/"+migration.file, string(content)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMosDNSLearningMigrationPreservesEditedUpstreams(t *testing.T) {
	a := newTestApp(t)
	seedLegacyLearningConfig(t, a)
	const rel = "configs/mosdns/sub_config/forward_1.yaml"
	content, err := a.readTextFile(rel)
	if err != nil {
		t.Fatal(err)
	}
	content = strings.Replace(content, "udp://127.0.0.1:6666", "udp://127.0.0.1:16666", 1)
	content = strings.Replace(content, "udp://127.0.0.1:1053", "tls://custom-resolver.test:853", 1)
	content = strings.Replace(content, "upstream_query_timeout: 2000", "upstream_query_timeout: 1234", 1)
	if err := a.writeTextFile(rel, content); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(a.DataDir, rel), 0600); err != nil {
		t.Fatal(err)
	}
	// A stale structured setting must not overrule a newer edit to the file.
	a.storeJSONSetting("mosdns_upstream_overrides", map[string]any{"nocnfake": []map[string]any{{"enabled": true, "protocol": "udp", "addr": "127.0.0.1:26666"}}})
	if err := a.EnsureBaseLayout(); err != nil {
		t.Fatal(err)
	}
	got, err := a.readTextFile(rel)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(a.DataDir, rel)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("migration must preserve private upstream file permissions")
	}
	var before, after struct {
		Plugins []map[string]any `yaml:"plugins"`
	}
	if err := yaml.Unmarshal([]byte(content), &before); err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal([]byte(got), &after); err != nil {
		t.Fatal(err)
	}
	if len(before.Plugins) != len(after.Plugins) {
		t.Fatal("plugin count changed")
	}
	for i, p := range before.Plugins {
		if p["tag"] == "sequence_fakeip_addlist" {
			continue
		}
		if !reflect.DeepEqual(p, after.Plugins[i]) {
			t.Fatalf("migration changed plugin %s", p["tag"])
		}
	}
	for _, migration := range mosDNSLearningMigrations {
		updated, err := a.readTextFile("configs/mosdns/sub_config/" + migration.file)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := runtimeTemplateText("mosdns/sub_config/" + migration.file)
		var doc, target yaml.Node
		if err := yaml.Unmarshal([]byte(updated), &doc); err != nil {
			t.Fatal(err)
		}
		if err := yaml.Unmarshal([]byte(want), &target); err != nil {
			t.Fatal(err)
		}
		hash, _ := mosDNSSequenceFingerprint(mosDNSSequenceArgs(&doc, migration.tag))
		wantHash, _ := mosDNSSequenceFingerprint(mosDNSSequenceArgs(&target, migration.tag))
		if hash != wantHash {
			t.Fatalf("legacy sequence %s was not upgraded", migration.tag)
		}
	}
}

func TestMosDNSLearningMigrationLeavesCustomSequenceIntact(t *testing.T) {
	a := newTestApp(t)
	if err := os.Remove(filepath.Join(a.DataDir, mosDNSLearningMigrationMarker)); err != nil {
		t.Fatal(err)
	}
	const rel = "configs/mosdns/sub_config/process_v4.yaml"
	const custom = "plugins:\n  - tag: sequence_ipv4\n    type: sequence\n    args:\n      - exec: reject 5\n"
	if err := a.writeTextFile(rel, custom); err != nil {
		t.Fatal(err)
	}
	if err := a.ensureMosDNSLearningSafety(); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.readTextFile(rel); got != custom {
		t.Fatal("operator sequence was replaced")
	}
}

func TestMosDNSLearningMigrationRetryDoesNotClearFreshState(t *testing.T) {
	a := newTestApp(t)
	if err := os.Remove(filepath.Join(a.DataDir, mosDNSLearningMigrationMarker)); err != nil {
		t.Fatal(err)
	}
	const rel = "configs/mosdns/gen/fakeiprule.txt"
	if err := a.writeTextFile(rel, "full:fresh.test\n"); err != nil {
		t.Fatal(err)
	}
	if err := a.ensureMosDNSLearningSafety(); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.readTextFile(rel); got != "full:fresh.test\n" {
		t.Fatal("up-to-date sequences caused repeated clearing")
	}
}

func TestMosDNSLearningConfiguredRangesReachAuditAndUpstreamAPIs(t *testing.T) {
	a := newTestApp(t)
	cfg := SetupConfig{FakeIPRangeV4: "100.64.0.0/10", FakeIPRangeV6: "fd00::/8"}
	cfg.defaults()
	if _, err := a.insertInitializedSetup(cfg); err != nil {
		t.Fatal(err)
	}
	entries := []map[string]any{}
	for i, answer := range []string{"A: 100.64.1.1", "AAAA: fd00::2", "A: 28.0.0.1", "A: 128.0.0.1", "CNAME: 28.example"} {
		entries = append(entries, map[string]any{"query_name": string(rune('a'+i)) + ".test", "domain_set": "unmatched_rule", "answers": []string{answer}, "response_code": "NOERROR"})
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"logs": entries})
	}))
	defer upstream.Close()
	a.setSetting("mosdns_api_endpoint", upstream.URL)
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{{"audit", a.handleMosDNSAuditStats}, {"upstream", a.handleMosDNSUpstreamStats}} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.handler(w, httptest.NewRequest(http.MethodGet, "/", nil))
			var payload struct {
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if tc.name == "audit" {
				if payload.Data["fakeip_queries"] != float64(2) || payload.Data["direct_queries"] != float64(3) {
					t.Fatalf("wrong configured-range counts: %s", w.Body.String())
				}
			} else {
				rows := anyMapSlice(payload.Data["upstreams"])
				if len(rows) == 0 || firstNumberAny(rows[0], "queries", "query_count", "total_queries", "count", "total") != 2 {
					t.Fatalf("wrong upstream counts: %s", w.Body.String())
				}
			}
		})
	}
}
