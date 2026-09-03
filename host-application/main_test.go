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
		mac.Updater != "/Applications/MultiVibe Host.app/Contents/Helpers/multivibe-host-updater" ||
		mac.BundledOllama != "/Applications/MultiVibe Host.app/Contents/Resources/ollama-runtime" ||
		mac.ModelCatalog != "/Applications/MultiVibe Host.app/Contents/Resources/provider/provider-model-catalog.json" {
		t.Fatalf("unexpected macOS layout: %#v %v", mac, err)
	}
	linux, err := executableLayout("/opt/multivibe-host/bin/multivibe-host", "linux")
	if err != nil || linux.Node != "/opt/multivibe-host/bin/node" || linux.App != "/opt/multivibe-host/app" ||
		linux.Updater != "/opt/multivibe-host/bin/multivibe-host-updater" ||
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
	t.Setenv("MULTIVIBE_HOST_CONTAINER", "")
	layout := bundleLayout{
		Agent: "/opt/multivibe/bin/agent", Security: "/opt/multivibe/app/modules/security",
		Updater:            "/opt/multivibe/bin/updater",
		BundledOllama:      "/opt/multivibe/runtime/ollama",
		ModelCatalog:       "/opt/multivibe/resources/provider/provider-model-catalog.json",
		DependencyManifest: "/opt/multivibe/resources/provider/provider-host-dependencies.json",
	}
	environment := coreEnvironment(
		layout,
		"/var/lib/multivibe",
		"/srv/multivibe-managed",
		localCredentials{AdminToken: "admin", ProxyAPIKey: "proxy"},
		coreNetworkConfiguration{
			BindAddress: "0.0.0.0", Port: "1455", PublicBaseURL: "https://multivibe.home.example.com",
		},
	)
	joined := strings.Join(environment, "\n")
	for _, expected := range []string{
		"HOST=0.0.0.0", "PORT=1455", "PUBLIC_BASE_URL=https://multivibe.home.example.com",
		"OAUTH_REDIRECT_URI=https://multivibe.home.example.com/auth/callback",
		"STORE_PATH=/var/lib/multivibe/accounts.json",
		"PROVIDER_AGENT_ENABLED=true", "PROVIDER_AGENT_BINARY=/opt/multivibe/bin/agent",
		"MULTIVIBE_HOST_APPLICATION=true",
		"MULTIVIBE_HOST_UPDATER_BINARY=/opt/multivibe/bin/updater",
		"APP_VERSION=dev",
		"PROVIDER_AGENT_CAPACITY_POLICY_PATH=/var/lib/multivibe/provider-agent-capacity-policy.json",
		"PROVIDER_AGENT_MANAGED_ROOT=/srv/multivibe-managed",
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

func TestHostBindAddressPreservesLoopbackDefaultAndBoundsExposure(t *testing.T) {
	for input, expected := range map[string]string{
		"": "127.0.0.1", "127.0.0.1": "127.0.0.1", "::1": "::1", "0.0.0.0": "0.0.0.0", "::": "::",
	} {
		if actual, err := hostBindAddress(input); err != nil || actual != expected {
			t.Fatalf("unexpected bind address for %q: %q %v", input, actual, err)
		}
	}
	for _, input := range []string{"localhost", "127.0.0.2", "192.168.1.20", "*", " 0.0.0.0"} {
		if _, err := hostBindAddress(input); err == nil {
			t.Fatalf("accepted unsafe or ambiguous bind address %q", input)
		}
	}
}

func TestHostPublicBaseURLRequiresAnExplicitCleanOriginWhenExposed(t *testing.T) {
	for _, test := range []struct {
		value, bind, port, expected string
	}{
		{"", "127.0.0.1", "1455", "http://127.0.0.1:1455"},
		{"", "::1", "1455", "http://[::1]:1455"},
		{"http://192.168.1.20:1455", "0.0.0.0", "1455", "http://192.168.1.20:1455"},
		{"https://multivibe.home.example.com/", "0.0.0.0", "1455", "https://multivibe.home.example.com"},
	} {
		actual, err := hostPublicBaseURL(test.value, test.bind, test.port)
		if err != nil || actual != test.expected {
			t.Fatalf("unexpected public URL for %#v: %q %v", test, actual, err)
		}
	}
	for _, test := range []struct{ value, bind string }{
		{"", "0.0.0.0"},
		{"ftp://multivibe.example.com", "0.0.0.0"},
		{"http://user:pass@multivibe.example.com", "0.0.0.0"},
		{"https://multivibe.example.com/app", "0.0.0.0"},
		{"https://multivibe.example.com?redirect=elsewhere", "0.0.0.0"},
		{"https://multivibe.example.com#fragment", "0.0.0.0"},
		{"https://multivibe.example.com:01455", "0.0.0.0"},
		{"https://multivibe.example.com:", "0.0.0.0"},
		{"https://[::1]:", "0.0.0.0"},
		{" http://192.168.1.20:1455", "0.0.0.0"},
	} {
		if _, err := hostPublicBaseURL(test.value, test.bind, "1455"); err == nil {
			t.Fatalf("accepted invalid public URL %q", test.value)
		}
	}
}

func TestManagedDirectoryDefaultsToStateAndAllowsASeparateContainerMount(t *testing.T) {
	t.Setenv("MULTIVIBE_HOST_MANAGED_DIR", "")
	if actual, err := managedDirectory("/data"); err != nil || actual != "/data/provider-agent-managed" {
		t.Fatalf("unexpected managed directory default: %q %v", actual, err)
	}
	t.Setenv("MULTIVIBE_HOST_MANAGED_DIR", "/models/runtime")
	if actual, err := managedDirectory("/data"); err != nil || actual != "/models/runtime" {
		t.Fatalf("unexpected separate managed directory: %q %v", actual, err)
	}
	for _, invalid := range []string{"relative", "/", "/models/../data"} {
		t.Setenv("MULTIVIBE_HOST_MANAGED_DIR", invalid)
		if _, err := managedDirectory("/data"); err == nil {
			t.Fatalf("accepted invalid managed directory %q", invalid)
		}
	}
}

func TestHostPortIsBoundedAndCanonical(t *testing.T) {
	for input, expected := range map[string]string{"": "1455", "1": "1", "1455": "1455", "65535": "65535"} {
		if actual, err := hostPort(input); err != nil || actual != expected {
			t.Fatalf("unexpected host port for %q: %q %v", input, actual, err)
		}
	}
	for _, input := range []string{"0", "01", "65536", "-1", "1455 ", "http://127.0.0.1:1455"} {
		if _, err := hostPort(input); err == nil {
			t.Fatalf("accepted invalid host port %q", input)
		}
	}
}
