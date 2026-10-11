package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteGeneratedConfigsPreservesMosDNSRuleSourceState(t *testing.T) {
	app := newTestApp(t)
	customFiles := map[string]string{
		"configs/mosdns/adguard/config.json": `[
  {
    "id": "custom-adguard-source",
    "name": "custom-adguard-source",
    "url": "https://example.com/custom-adguard.txt",
    "enabled": true
  }
]
`,
		"configs/mosdns/adguard/259df415-c0c9-402d-844e-37eec627e1c7.rules": "||custom-adguard.example^\n",
		"configs/mosdns/srs/geositecn.json": `[
  {
    "name": "custom-routing-source",
    "url": "https://example.com/custom-routing.srs",
    "files": "srs/custom-routing.srs",
    "enabled": true
  }
]
`,
	}
	for rel, content := range customFiles {
		path := filepath.Join(app.DataDir, filepath.FromSlash(rel))
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}

	structuralRel := "configs/mosdns/sub_config/rule_set.yaml"
	structuralPath := filepath.Join(app.DataDir, filepath.FromSlash(structuralRel))
	if err := os.WriteFile(structuralPath, []byte("stale structural template\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := SetupConfig{
		SelectedInterface: "eth0",
		LinuxProxyMode:    "tun",
		EnableIPv6:        true,
		ProxyCore:         "mihomo",
		MosDNSEnabled:     true,
	}
	if err := app.writeGeneratedConfigs(cfg); err != nil {
		t.Fatal(err)
	}

	for rel, want := range customFiles {
		got, err := os.ReadFile(filepath.Join(app.DataDir, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		if string(got) != want {
			t.Fatalf("generated config refresh changed user-managed %s\ngot:\n%s\nwant:\n%s", rel, got, want)
		}
	}

	wantStructural, ok := runtimeTemplateText("mosdns/sub_config/rule_set.yaml")
	if !ok {
		t.Fatal("missing embedded MosDNS structural template")
	}
	gotStructural, err := os.ReadFile(structuralPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotStructural) != wantStructural {
		t.Fatalf("structural MosDNS template was not refreshed\ngot:\n%s\nwant:\n%s", gotStructural, wantStructural)
	}
}

func TestRuntimeStructuralTemplateClassification(t *testing.T) {
	tests := map[string]bool{
		"mosdns/sub_config/rule_set.yaml": true,
		"mosdns/webinfo/clientname.json":  true,
		"mosdns/nft/nft.conf":             true,
		"mosdns/adguard/config.json":      false,
		"mosdns/adguard/custom.rules":     false,
		"mosdns/srs/geositecn.json":       false,
		"mosdns/srs/geosite-cn.srs":       false,
		"mosdns/rule/whitelist.txt":       false,
	}
	for rel, want := range tests {
		t.Run(rel, func(t *testing.T) {
			if got := isRuntimeStructuralTemplate(rel); got != want {
				t.Fatalf("isRuntimeStructuralTemplate(%q) = %t, want %t", rel, got, want)
			}
		})
	}
}
