package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"gopkg.in/yaml.v3"
)

const mosDNSLearningMigrationMarker = "data/mosdns-learning-v4"

// Fingerprints cover sequence args only (canonical JSON), never upstreams or
// the whole file. Accepted versions include v0.6.6, PR #20's 608370e and v0.6.7.
// Unknown/custom sequences are left intact rather than silently replaced.
var mosDNSLearningMigrations = []struct {
	file, tag string
	legacy    []string
}{
	{"process_v4.yaml", "sequence_ipv4", []string{"3a32a653151290b7193ecb78e5a49b3434db875c150129af76eceb5055c0964f", "c23ec04cf936955b7ae6d767dc30ed844ba143c30721a2609d65e2eef3ca0eba", "643172447cc44f8905e3f64b543470b48f524b2ab5f821e636558bc3c958726d"}},
	{"process_v6.yaml", "sequence_ipv6", []string{"8462171883a7332e0ad269b6bc3ee957adbd6b349ea5dafa818d247e7bac58be", "96126ec025dd0ed38339222c38afbb29560133dc4646b32efba43eb84c98f7e1", "5e5883fe7108e55b0a23d5b0f4f7b2f1024890bf9e1b0486dddb549ee03a9ac4"}},
	{"not_in_list_ipmatch.yaml", "sequence_not_in_list_ipmatch", []string{"b0f0d5fc3ce3e33623d162a15421ed4c6b39a208760d483eef711aadeac6da13", "7e4df547512c60e188961c3d136d653c73b8e3f356fe2e013cb950c1d906529e"}},
	{"not_in_list_noleak_v4.yaml", "sequence_not_in_list_noleak_v4", []string{"f6cad30b30e1c05040f7f697807a932bac4a27f776becd39a3ef236f279e7412", "4f83618d83d4b2481e381ac4eeef9847182a05fa2f3f168f41b52fe0e50370e2", "59805e23a6b8bdf0f64aba49fd0f89ecf369f5e68d9715674d1a7af772879847"}},
	{"not_in_list_noleak_v6.yaml", "sequence_not_in_list_noleak_v6", []string{"14fe9049a86cfa9e53dfb477715e3c5057a5cce09c8d53bb6ca938c88699723c", "1a3c31abaf061c5811546c9d13ce62ce0a5d16ffbdb44f7fc6ac99cac3a14cf6", "102eedfd6eca294f3c5a3d4e875a486188975f02933097e3cd11d0cee9edd8ec"}},
	{"forward_1.yaml", "sequence_fakeip_addlist", []string{"42f5c39afe7a51c00153ae095d6e32ba7952e84ae89238fad51dceb14af6be58", "8bd389444ea3ab0dbb3ccb19c09bf48fdb79955ce9c53a39331844d272e84a37"}},
}

func mosDNSYAMLField(node *yaml.Node, name string) *yaml.Node {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		node = node.Content[0]
	}
	if node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == name {
			return node.Content[i+1]
		}
	}
	return nil
}

func mosDNSSequenceArgs(doc *yaml.Node, tag string) *yaml.Node {
	plugins := mosDNSYAMLField(doc, "plugins")
	if plugins == nil || plugins.Kind != yaml.SequenceNode {
		return nil
	}
	for _, plugin := range plugins.Content {
		name, typ := mosDNSYAMLField(plugin, "tag"), mosDNSYAMLField(plugin, "type")
		if name != nil && name.Value == tag && typ != nil && typ.Value == "sequence" {
			return mosDNSYAMLField(plugin, "args")
		}
	}
	return nil
}

func mosDNSSequenceFingerprint(args *yaml.Node) (string, error) {
	var value any
	if err := args.Decode(&value); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(encoded)), nil
}

func migrateMosDNSLearningSequence(current, template, tag string, legacy []string) (next string, custom bool, err error) {
	var doc, wanted yaml.Node
	if err := yaml.Unmarshal([]byte(current), &doc); err != nil {
		return current, true, nil
	}
	if err := yaml.Unmarshal([]byte(template), &wanted); err != nil {
		return "", false, err
	}
	args, newArgs := mosDNSSequenceArgs(&doc, tag), mosDNSSequenceArgs(&wanted, tag)
	if newArgs == nil {
		return "", false, fmt.Errorf("missing sequence %s in bundled template", tag)
	}
	if args == nil {
		return current, true, nil
	}
	hash, err := mosDNSSequenceFingerprint(args)
	if err != nil {
		return current, true, nil
	}
	wantHash, err := mosDNSSequenceFingerprint(newArgs)
	if err != nil {
		return "", false, err
	}
	if hash == wantHash {
		return current, false, nil
	}
	if !slices.Contains(legacy, hash) {
		return current, true, nil
	}
	*args = *newArgs
	next, err = encodeMosDNSMigrationYAML(&doc)
	return next, false, err
}

func encodeMosDNSMigrationYAML(doc *yaml.Node) (string, error) {
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return "", err
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	return out.String(), nil
}

// Main configs contain rendered IPv6/client settings; patch only the known
// generated no-address gates. Cache settings likewise retain operator sizes,
// exclusions and paths while the strict front cache stops serving stale data.
func migrateMosDNSStrictPolicy(content string, cache bool) (string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		return content, nil
	}
	changed := false
	if cache {
		plugins := mosDNSYAMLField(&doc, "plugins")
		if plugins == nil || plugins.Kind != yaml.SequenceNode {
			return content, nil
		}
		for _, plugin := range plugins.Content {
			tag, typ := mosDNSYAMLField(plugin, "tag"), mosDNSYAMLField(plugin, "type")
			if tag == nil || tag.Value != mosDNSCacheAllNoLeakTag || typ == nil || typ.Value != "cache" {
				continue
			}
			lazy := mosDNSYAMLField(mosDNSYAMLField(plugin, "args"), "lazy_cache_ttl")
			if lazy != nil && lazy.Kind == yaml.ScalarNode && lazy.Value != "0" {
				lazy.Value, lazy.Tag = "0", "!!int"
				changed = true
			}
		}
	} else {
		for _, tag := range []string{"sequence_6666", "sequence_requery"} {
			args := mosDNSSequenceArgs(&doc, tag)
			if args == nil || args.Kind != yaml.SequenceNode {
				continue
			}
			for _, rule := range args.Content {
				action, matches := mosDNSYAMLField(rule, "exec"), mosDNSYAMLField(rule, "matches")
				if action == nil || action.Value != "reject 0" || matches == nil || matches.Kind != yaml.SequenceNode || len(matches.Content) != 3 {
					continue
				}
				values := map[string]bool{}
				for _, match := range matches.Content {
					values[match.Value] = true
				}
				if values["switch1 'A'"] && ((values["qtype 1"] && values["fast_mark 2"]) || (values["qtype 28"] && values["fast_mark 3"])) {
					matches.Content = append(matches.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "switch3 'A'"})
					changed = true
				}
			}
		}
	}
	if !changed {
		return content, nil
	}
	return encodeMosDNSMigrationYAML(&doc)
}

func (a *App) ensureMosDNSLearningSafety() error {
	marker := filepath.Join(a.DataDir, mosDNSLearningMigrationMarker)
	if _, err := os.Stat(marker); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	files := map[string]string{}
	for _, migration := range mosDNSLearningMigrations {
		rel := "mosdns/sub_config/" + migration.file
		template, ok := runtimeTemplateText(rel)
		if !ok {
			return fmt.Errorf("missing template %s", rel)
		}
		current, err := a.readTextFile("configs/" + rel)
		if err != nil {
			return err
		}
		next, custom, err := migrateMosDNSLearningSequence(current, template, migration.tag, migration.legacy)
		if err != nil {
			return err
		}
		if custom {
			a.LogWarn("mosdns/learning", "保留自定义 MosDNS 序列，未自动替换分流逻辑", map[string]any{"file": rel, "sequence": migration.tag})
		}
		if next != current {
			files["configs/"+rel] = next
		}
	}
	for _, rel := range []string{"configs/mosdns/config.yaml", "configs/mosdns/sub_config/cache.yaml"} {
		current, err := a.readTextFile(rel)
		if err != nil {
			return err
		}
		next, err := migrateMosDNSStrictPolicy(current, rel == "configs/mosdns/sub_config/cache.yaml")
		if err != nil {
			return err
		}
		if next != current {
			files[rel] = next
		}
	}
	// Only an actual upgrade invalidates old learning/caches. Retrying a marker
	// write after a successful migration must not discard newly learned state.
	if len(files) > 0 {
		for _, name := range []string{"realiplist.txt", "realiprule.txt", "fakeiplist.txt", "fakeiprule.txt", "nov4list.txt", "nov4rule.txt", "nov6list.txt", "nov6rule.txt"} {
			files["configs/mosdns/gen/"+name] = ""
		}
		var remove []string
		for _, tag := range mosDNSCachePluginTags {
			remove = append(remove, "configs/mosdns/cache/"+tag+".dump")
		}
		if err := a.applyMosDNSLearningChanges(context.Background(), files, remove); err != nil {
			return err
		}
	}
	return os.WriteFile(marker, []byte("4\n"), 0644)
}
