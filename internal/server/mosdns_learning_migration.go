package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const mosDNSLearningMigrationMarker = "data/mosdns-learning-v3"

// Fingerprints cover sequence args only (canonical JSON), never upstreams or
// the whole file. The two accepted versions are v0.6.6 and PR #20's 608370e.
// Unknown/custom sequences are left intact rather than silently replaced.
var mosDNSLearningMigrations = []struct {
	file, tag string
	legacy    [2]string
}{
	{"process_v4.yaml", "sequence_ipv4", [2]string{"3a32a653151290b7193ecb78e5a49b3434db875c150129af76eceb5055c0964f", "c23ec04cf936955b7ae6d767dc30ed844ba143c30721a2609d65e2eef3ca0eba"}},
	{"process_v6.yaml", "sequence_ipv6", [2]string{"8462171883a7332e0ad269b6bc3ee957adbd6b349ea5dafa818d247e7bac58be", "96126ec025dd0ed38339222c38afbb29560133dc4646b32efba43eb84c98f7e1"}},
	{"not_in_list_ipmatch.yaml", "sequence_not_in_list_ipmatch", [2]string{"b0f0d5fc3ce3e33623d162a15421ed4c6b39a208760d483eef711aadeac6da13", "7e4df547512c60e188961c3d136d653c73b8e3f356fe2e013cb950c1d906529e"}},
	{"not_in_list_noleak_v4.yaml", "sequence_not_in_list_noleak_v4", [2]string{"f6cad30b30e1c05040f7f697807a932bac4a27f776becd39a3ef236f279e7412", "4f83618d83d4b2481e381ac4eeef9847182a05fa2f3f168f41b52fe0e50370e2"}},
	{"not_in_list_noleak_v6.yaml", "sequence_not_in_list_noleak_v6", [2]string{"14fe9049a86cfa9e53dfb477715e3c5057a5cce09c8d53bb6ca938c88699723c", "1a3c31abaf061c5811546c9d13ce62ce0a5d16ffbdb44f7fc6ac99cac3a14cf6"}},
	{"forward_1.yaml", "sequence_fakeip_addlist", [2]string{"42f5c39afe7a51c00153ae095d6e32ba7952e84ae89238fad51dceb14af6be58", "8bd389444ea3ab0dbb3ccb19c09bf48fdb79955ce9c53a39331844d272e84a37"}},
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

func migrateMosDNSLearningSequence(current, template, tag string, legacy [2]string) (next string, custom bool, err error) {
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
	if hash != legacy[0] && hash != legacy[1] {
		return current, true, nil
	}
	*args = *newArgs
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&doc); err != nil {
		return "", false, err
	}
	if err := encoder.Close(); err != nil {
		return "", false, err
	}
	return out.String(), false, nil
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
	return os.WriteFile(marker, []byte("3\n"), 0644)
}
