package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutableLayoutIsBoundedToReleaseShape(t *testing.T) {
	mac, err := executableLayout("/Applications/MultiVibe Host.app/Contents/MacOS/multivibe-host", "darwin")
	if err != nil || mac.Node != "/Applications/MultiVibe Host.app/Contents/Frameworks/node" ||
		mac.Agent != "/Applications/MultiVibe Host.app/Contents/Helpers/multivibe-provider-agent" ||
		mac.BundledOllama != "/Applications/MultiVibe Host.app/Contents/Resources/ollama-runtime" ||
		mac.ModelCatalog != "/Applications/MultiVibe Host.app/Contents/Resources/provider/provider-model-catalog.json" {
		t.Fatalf("unexpected macOS layout: %#v %v", mac, err)
	}
	linux, err := executableLayout("/opt/multivibe-host/bin/multivibe-host", "linux")
	if err != nil || linux.Node != "/opt/multivibe-host/bin/node" || linux.App != "/opt/multivibe-host/app" ||
		linux.BundledOllama != "/opt/multivibe-host/runtime/ollama" ||
		linux.DependencyManifest != "/opt/multivibe-host/resources/provider/provider-host-dependencies.json" {
		t.Fatalf("unexpected Linux layout: %#v %v", linux, err)
	}
	for _, invalid := range []struct{ path, goos string }{
		{"/tmp/multivibe-host", "darwin"},
		{"/tmp/multivibe-host", "linux"},
		{"/opt/multivibe-host/bin/multivibe-host", "windows"},
	} {
		if _, err := executableLayout(invalid.path, invalid.goos); err == nil {
			t.Fatalf("accepted invalid layout %#v", invalid)
		}
	}
}

func TestDataDirectoryKeepsHosterChoiceExplicit(t *testing.T) {
	mac, err := defaultDataDirectory("darwin", "/Users/provider", "")
	if err != nil || mac != "/Users/provider/Library/Application Support/MultiVibe" {
		t.Fatalf("unexpected macOS data path: %q %v", mac, err)
	}
	linux, err := defaultDataDirectory("linux", "/home/provider", "/mnt/fast/provider-data")
	if err != nil || linux != "/mnt/fast/provider-data/multivibe" {
		t.Fatalf("unexpected Linux data path: %q %v", linux, err)
	}
	if _, err := defaultDataDirectory("linux", "/home/provider", "relative"); err == nil {
		t.Fatal("accepted a relative hoster data path")
	}
}

func TestCredentialsAreAtomicPrivateAndStable(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	first, err := loadOrCreateCredentials(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateCredentials(first); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(credentialPath(directory))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials permissions are unsafe: %#v %v", info, err)
	}
	second, err := loadOrCreateCredentials(directory)
	if err != nil || second != first {
		t.Fatalf("credentials changed across restart: %#v %#v %v", first, second, err)
	}
	raw, err := os.ReadFile(credentialPath(directory))
	if err != nil || !json.Valid(raw) || strings.Contains(string(raw), ".new") {
		t.Fatalf("invalid credential state: %q %v", raw, err)
	}
}

func TestCredentialsRejectTrailingJSON(t *testing.T) {
	directory := t.TempDir()
	path := credentialPath(directory)
	raw := `{"schema_version":"multivibe-host-credentials-v1","admin_token":"` +
		strings.Repeat("a", 32) + `","proxy_api_key":"` + strings.Repeat("b", 32) + `"}` + "\n{}\n"
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateCredentials(directory); err == nil {
		t.Fatal("accepted a second JSON value after the credential object")
	}
}

func TestCoreEnvironmentIsAllowlistedAndPinsAllState(t *testing.T) {
	t.Setenv("UNRELATED_SECRET", "must-not-leak")
	t.Setenv("MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS", `{"ed25519:production":"public-spki"}`)
	t.Setenv("MULTIVIBE_PROVIDER_OLLAMA_LISTEN", "127.0.0.1:18081")
	t.Setenv("MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES", "0")
	layout := bundleLayout{
		Agent: "/opt/multivibe/bin/agent", Security: "/opt/multivibe/app/modules/security",
		BundledOllama:      "/opt/multivibe/runtime/ollama",
		ModelCatalog:       "/opt/multivibe/resources/provider/provider-model-catalog.json",
		DependencyManifest: "/opt/multivibe/resources/provider/provider-host-dependencies.json",
	}
	environment := coreEnvironment(layout, "/var/lib/multivibe", localCredentials{AdminToken: "admin", ProxyAPIKey: "proxy"})
	joined := strings.Join(environment, "\n")
	for _, expected := range []string{
		"HOST=127.0.0.1", "STORE_PATH=/var/lib/multivibe/accounts.json",
		"PROVIDER_AGENT_ENABLED=true", "PROVIDER_AGENT_BINARY=/opt/multivibe/bin/agent",
		"PROVIDER_AGENT_CAPACITY_POLICY_PATH=/var/lib/multivibe/provider-agent-capacity-policy.json",
		"PROVIDER_AGENT_MANAGED_ROOT=/var/lib/multivibe/provider-agent-managed",
		"PROVIDER_AGENT_BUNDLED_OLLAMA_ROOT=/opt/multivibe/runtime/ollama",
		"PROVIDER_AGENT_DEPENDENCY_MANIFEST_PATH=/opt/multivibe/resources/provider/provider-host-dependencies.json",
		"PROVIDER_AGENT_MANAGED_PLANNER_STATE_PATH=/var/lib/multivibe/provider-agent-managed-planner-state.json",
		"PROVIDER_AGENT_MODEL_CATALOG_PATH=/opt/multivibe/resources/provider/provider-model-catalog.json",
		`PROVIDER_AGENT_DEMAND_TRUSTED_KEYS={"ed25519:production":"public-spki"}`,
		"PROVIDER_AGENT_OLLAMA_LISTEN=127.0.0.1:18081",
		"PROVIDER_AGENT_CUDA_VISIBLE_DEVICES=0",
		"TRACE_INCLUDE_BODY=false", "BUNDLED_SECURITY_MODULE_PATH=/opt/multivibe/app/modules/security",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing environment contract %q in %s", expected, joined)
		}
	}
	if strings.Contains(joined, "UNRELATED_SECRET") || strings.Contains(joined, "must-not-leak") {
		t.Fatalf("parent environment leaked: %s", joined)
	}
}
