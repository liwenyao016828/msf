package server

import (
	"bytes"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"gopkg.in/yaml.v3"
)

type strictDNSFixture struct {
	addr, dir       string
	healthy         atomic.Bool
	domesticQueries atomic.Int64
	stop            func()
	output          *bytes.Buffer
}

// Actual forward plugins talk to loopback UDP upstreams. Negative answers carry
// a short SOA TTL so recovery exercises the real front cache as well as routing.
func startStrictDNSFixture(t *testing.T, mode string) *strictDNSFixture {
	t.Helper()
	core := os.Getenv("MSF_TEST_MOSDNS")
	if core == "" {
		t.Skip("set MSF_TEST_MOSDNS for real resolver/cache regression")
	}
	f := &strictDNSFixture{dir: t.TempDir()}
	upstream := func(domestic bool) string {
		conn, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			buf := make([]byte, 4096)
			for {
				n, peer, err := conn.ReadFrom(buf)
				if err != nil {
					return
				}
				var q dnsmessage.Message
				if q.Unpack(buf[:n]) != nil || len(q.Questions) != 1 {
					continue
				}
				if domestic {
					f.domesticQueries.Add(1)
				}
				question := q.Questions[0]
				name := question.Name.String()
				r := dnsmessage.Message{Header: dnsmessage.Header{ID: q.ID, Response: true, RecursionAvailable: true}, Questions: q.Questions}
				negative := !domestic && !f.healthy.Load()
				switch {
				case negative && strings.HasPrefix(name, "timeout-"):
					continue
				case negative && strings.HasPrefix(name, "servfail-"):
					r.RCode = dnsmessage.RCodeServerFailure
				case negative && strings.HasPrefix(name, "refused-"):
					r.RCode = dnsmessage.RCodeRefused
				case negative && (strings.HasPrefix(name, "nxdomain-") || strings.HasPrefix(name, "nodata-")):
					if strings.HasPrefix(name, "nxdomain-") {
						r.RCode = dnsmessage.RCodeNameError
					}
					r.Authorities = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeSOA, Class: dnsmessage.ClassINET, TTL: 1}, Body: &dnsmessage.SOAResource{NS: question.Name, MBox: question.Name, Serial: 1, Refresh: 1, Retry: 1, Expire: 1, MinTTL: 1}}}
				default:
					header := dnsmessage.ResourceHeader{Name: question.Name, Type: question.Type, Class: dnsmessage.ClassINET, TTL: 60}
					if question.Type == dnsmessage.TypeA {
						ip := [4]byte{198, 51, 100, 10}
						if domestic {
							ip = [4]byte{223, 5, 5, 5}
						}
						r.Answers = []dnsmessage.Resource{{Header: header, Body: &dnsmessage.AResource{A: ip}}}
					} else {
						ip := net.ParseIP("2001:db8::10").To16()
						if domestic {
							ip = net.ParseIP("2400:3200::1").To16()
						}
						var raw [16]byte
						copy(raw[:], ip)
						r.Answers = []dnsmessage.Resource{{Header: header, Body: &dnsmessage.AAAAResource{AAAA: raw}}}
					}
				}
				if packed, err := r.Pack(); err == nil {
					_, _ = conn.WriteTo(packed, peer)
				}
			}
		}()
		t.Cleanup(func() { conn.Close(); <-done })
		return conn.LocalAddr().String()
	}
	foreign, local := upstream(false), upstream(true)
	type plugin = map[string]any
	var plugins []plugin
	add := func(tag, typ string, args any) {
		plugins = append(plugins, plugin{"tag": tag, "type": typ, "args": args})
	}
	rule := func(match, action string) map[string]any {
		r := map[string]any{"exec": action}
		if match != "" {
			r["matches"] = match
		}
		return r
	}
	for _, s := range []struct{ tag, value string }{{"switch1", "A"}, {"switch3", mode}, {"switch4", "B"}, {"switch9", "A"}, {"switch13", "A"}} {
		p := filepath.Join(f.dir, s.tag)
		if err := os.WriteFile(p, []byte(s.value), 0644); err != nil {
			t.Fatal(err)
		}
		add(s.tag, s.tag, map[string]any{"initial_value": p})
	}
	add("direct_ip", "ip_set", map[string]any{"ips": []string{}})
	add("geoip_cn", "ip_set", map[string]any{"ips": []string{"223.5.5.0/24", "2400:3200::/32"}})
	add("unified_matcher3", "sequence", []any{})
	add("unified_matcher4", "sequence", []any{})
	add("unified_matcher5", "domain_mapper", map[string]any{"default_mark": 17, "rules": []any{}})
	add("old_no_address", "domain_set_light", map[string]any{"exps": []string{"full:remembered.test"}})
	add("negative_matcher", "domain_mapper", map[string]any{"rules": []any{map[string]any{"tag": "old_no_address", "mark": 2}, map[string]any{"tag": "old_no_address", "mark": 3}}})
	for _, tag := range []string{"sequence_google_node", "sequence_google", "sequence_local", "domestic"} {
		addr := foreign
		if tag == "sequence_local" || tag == "domestic" {
			addr = local
		}
		add(tag, "forward", map[string]any{"upstreams": []any{map[string]any{"addr": "udp://" + addr, "upstream_query_timeout": 100}}})
	}
	add("nocnfake", "sequence", []any{rule("", "black_hole 28.0.0.5 f2b0::5")})
	add("cnfake", "sequence", []any{rule("", "black_hole 28.0.0.6 f2b0::6")})
	for _, tag := range []string{"my_realiplist", "my_fakeiplist", "my_nov4list", "my_nov6list"} {
		add(tag, "domain_output", map[string]any{"file_stat": filepath.Join(f.dir, tag+".txt"), "file_rule": filepath.Join(f.dir, tag+".rules"), "max_entries": 1000, "dump_interval": 3600})
	}
	selected := map[string]bool{"sequence_local_exit": true, "sequence_local_fake": true, "sequence_local_divert": true, "sequence_local_fake_exit": true, "sequence_fakeip": true, "sequence_fakeip_addlist": true}
	for _, name := range []string{"cache.yaml", "forward_1.yaml", "not_in_list_ipmatch.yaml", "not_in_list_leak_v4.yaml", "not_in_list_leak_v6.yaml", "not_in_list_noleak_v4.yaml", "not_in_list_noleak_v6.yaml", "process_v4.yaml", "process_v6.yaml"} {
		var doc struct {
			Plugins []plugin `yaml:"plugins"`
		}
		if err := yaml.Unmarshal(mustMosDNSRuntimeTemplate(t, "mosdns/sub_config/"+name), &doc); err != nil {
			t.Fatal(err)
		}
		for _, p := range doc.Plugins {
			if name == "forward_1.yaml" && !selected[p["tag"].(string)] {
				continue
			}
			if name == "cache.yaml" {
				args := p["args"].(map[string]any)
				args["size"] = 64
				args["dump_file"] = filepath.Join(f.dir, p["tag"].(string)+".dump")
			}
			plugins = append(plugins, p)
		}
	}
	// Include the actual front-cache and negative-memory gates from the main
	// production entry, while omitting unrelated client/ad-block policies.
	var mainDoc struct {
		Plugins []plugin `yaml:"plugins"`
	}
	if err := yaml.Unmarshal(mustMosDNSRuntimeTemplate(t, "mosdns/config.yaml"), &mainDoc); err != nil {
		t.Fatal(err)
	}
	entry := []any{rule("", "$negative_matcher")}
	for _, p := range mainDoc.Plugins {
		if p["tag"] == "sequence_6666" {
			for _, raw := range p["args"].([]any) {
				r := raw.(map[string]any)
				action, _ := r["exec"].(string)
				include := action == "$cache_all" || action == "$cache_all_noleak" || action == "$sequence_ipv4" || action == "$sequence_ipv6"
				if action == "reject 0" {
					for _, m := range anySlice(r["matches"]) {
						if m == "fast_mark 2" || m == "fast_mark 3" {
							include = true
						}
					}
				}
				if include {
					entry = append(entry, r)
				}
			}
		}
	}
	add("main", "sequence", entry)
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.addr = c.LocalAddr().String()
	c.Close()
	add("test_dns", "udp_server", map[string]any{"entry": "main", "listen": f.addr})
	config, err := yaml.Marshal(map[string]any{"log": map[string]any{"level": "warn"}, "plugins": plugins})
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(f.dir, "config.yaml")
	if err := os.WriteFile(p, config, 0644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	f.output = &output
	cmd := exec.Command(core, "start", "-c", p)
	cmd.Dir = f.dir
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var stopOnce sync.Once
	f.stop = func() { stopOnce.Do(func() { cmd.Process.Signal(os.Interrupt); cmd.Wait() }) }
	t.Cleanup(f.stop)
	for i := 0; i < 150; i++ {
		if _, err := learningDNSQuery(f.addr, "ready.test", dnsmessage.TypeA); err == nil {
			return f
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.stop()
	t.Fatalf("test resolver did not start: %s", f.output.String())
	return f
}

func TestMosDNSSafeModePreservesFailuresWithoutDomesticFallback(t *testing.T) {
	for _, qt := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		for _, tc := range []struct {
			name string
			code dnsmessage.RCode
		}{{"servfail", dnsmessage.RCodeServerFailure}, {"refused", dnsmessage.RCodeRefused}, {"timeout", dnsmessage.RCodeServerFailure}, {"nxdomain", dnsmessage.RCodeNameError}, {"nodata", dnsmessage.RCodeSuccess}} {
			name := tc.name + "-" + strings.ToLower(qt.String()) + ".test"
			t.Run(name, func(t *testing.T) {
				// Isolate response classification from the reference core's known
				// shared-transport timeout defect, covered by the opt-in probe below.
				f := startStrictDNSFixture(t, "B")
				msg, err := learningDNSQuery(f.addr, name, qt)
				if err != nil {
					t.Fatal(err)
				}
				if msg.RCode != tc.code || len(msg.Answers) != 0 {
					f.stop()
					t.Fatalf("rcode=%s answers=%v, want %s without addresses; core: %s", msg.RCode, msg.Answers, tc.code, f.output.String())
				}
				if (tc.name == "nxdomain" || tc.name == "nodata") && len(msg.Authorities) != 1 {
					t.Fatal("negative SOA was discarded")
				}
				if got := f.domesticQueries.Load(); got != 0 {
					t.Fatalf("safe-mode error triggered %d domestic queries", got)
				}
				f.stop()
				for _, tag := range []string{"my_realiplist", "my_fakeiplist", "my_nov4list", "my_nov6list"} {
					data, err := os.ReadFile(filepath.Join(f.dir, tag+".txt"))
					if err != nil {
						t.Fatal(err)
					}
					if strings.Contains(string(data), name) {
						t.Fatalf("negative/error response persisted in %s: %s", tag, data)
					}
				}
			})
		}
	}
}

func TestMosDNSSafeNegativeMemoryAndCacheRecoverWithoutReset(t *testing.T) {
	f := startStrictDNSFixture(t, "B")
	for _, qt := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		msg, err := learningDNSQuery(f.addr, "remembered.test", qt)
		if err != nil || len(msg.Answers) != 1 {
			t.Fatalf("stale no-address memory blocked strict query: %v %v", msg, err)
		}
		name := "nodata-" + strings.ToLower(qt.String()) + ".test"
		msg, err = learningDNSQuery(f.addr, name, qt)
		if err != nil || msg.RCode != dnsmessage.RCodeSuccess || len(msg.Answers) != 0 {
			t.Fatalf("bad initial NODATA: %v %v", msg, err)
		}
	}
	f.healthy.Store(true)
	time.Sleep(1200 * time.Millisecond)
	for _, qt := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		name := "nodata-" + strings.ToLower(qt.String()) + ".test"
		msg, err := learningDNSQuery(f.addr, name, qt)
		if err != nil || msg.RCode != dnsmessage.RCodeSuccess || len(msg.Answers) != 1 {
			t.Fatalf("expired negative cache blocked recovery without reset: %v %v", msg, err)
		}
	}
}

// This probes an upstream core defect, not a fix supplied by MSF. Keep it
// explicit so normal configuration regressions can use an unmodified core.
func TestMosDNSCoreTimeoutRecovery(t *testing.T) {
	if os.Getenv("MSF_TEST_MOSDNS_TIMEOUT_PROBE") != "1" {
		t.Skip("set MSF_TEST_MOSDNS_TIMEOUT_PROBE=1 to diagnose core timeout recovery")
	}
	f := startStrictDNSFixture(t, "B")
	msg, err := learningDNSQuery(f.addr, "timeout-recovery.test", dnsmessage.TypeA)
	if err != nil || msg.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("timeout should produce SERVFAIL: %v %v", msg, err)
	}
	f.healthy.Store(true)
	msg, err = learningDNSQuery(f.addr, "recovered.test", dnsmessage.TypeA)
	if err != nil || msg.RCode != dnsmessage.RCodeSuccess || len(msg.Answers) != 1 {
		f.stop()
		t.Fatalf("upstream transport did not recover without restart: %v %v; core: %s", msg, err, f.output.String())
	}
	if f.domesticQueries.Load() != 0 {
		t.Fatal("recovery fell back to domestic resolver")
	}
}
