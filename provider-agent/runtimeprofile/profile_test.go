package runtimeprofile

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testGiB uint64 = 1 << 30

func testDigest(character string) string {
	return "sha256:" + strings.Repeat(character, 64)
}

func testProfile(id, backend string, priority uint16, memory uint64) Profile {
	return Profile{
		SchemaVersion: ProfileVersionV3,
		ID:            id,
		Priority:      priority,
		Model: Model{
			ID: "hf:qwen/qwen2.5-0.5b-instruct", ContentDigest: testDigest("a"), Format: "gguf", Quantization: "q4_k_m",
			ArtifactBytes: 400_000_000, License: "Apache-2.0", HostedInferenceAllowed: true, LicenseAssessment: testDigest("b"),
		},
		Hardware: Hardware{
			Class: "nvidia-cuda-8gb", OS: "linux", Architecture: "amd64", AcceleratorKind: "cuda",
			MinimumAcceleratorMemoryBytes: 8 * testGiB,
		},
		Runtime: Runtime{
			BackendID: backend, ContractVersion: "provider-runtime-backend-v1", AdapterVersion: "adapter-v1",
			RuntimeArtifactDigest: testDigest("c"),
		},
		Tuning: Tuning{
			ContextTokens: 8192, BatchSize: 128, Parallelism: 1, GPUOffloadLayers: 24,
			EstimatedMemoryBytes: memory, ReserveMemoryBytes: testGiB,
		},
		Provenance: ProfileProvenance{
			RecommendationSourceURL: "https://github.com/thibautrey/multivibe/tree/main/packaging",
			RecommendationDigest:    testDigest("d"), Method: "reviewed-static", License: "Apache-2.0",
		},
	}
}

func testCatalog(t *testing.T, profiles ...Profile) Catalog {
	t.Helper()
	sortProfiles(profiles)
	catalog, err := Finalize(Catalog{
		SchemaVersion: CatalogVersionV3, Format: CatalogFormat, License: "Apache-2.0",
		Provenance: CatalogProvenance{
			SourceURL:    "https://github.com/thibautrey/multivibe/tree/main/packaging",
			SourceDigest: testDigest("e"),
		},
		Profiles: profiles,
	})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func sortProfiles(profiles []Profile) {
	for left := range profiles {
		for right := left + 1; right < len(profiles); right++ {
			if profiles[right].ID < profiles[left].ID {
				profiles[left], profiles[right] = profiles[right], profiles[left]
			}
		}
	}
}

func testRequest(catalog Catalog, runtimes ...RuntimeCapability) SelectionRequest {
	profile := catalog.Profiles[0]
	return SelectionRequest{
		ModelID: profile.Model.ID, ContentDigest: profile.Model.ContentDigest, Format: profile.Model.Format,
		Quantization: profile.Model.Quantization, RequiredContextTokens: 4096, Hardware: profile.Hardware,
		AvailableMemoryBytes: profile.Hardware.MinimumAcceleratorMemoryBytes, Runtimes: runtimes,
	}
}

func testCapability(profile Profile) RuntimeCapability {
	return RuntimeCapability{
		BackendID: profile.Runtime.BackendID, ContractVersion: profile.Runtime.ContractVersion, Available: true,
		Formats: []string{"gguf"}, Quantizations: []string{"q4_k_m"}, HardwareClasses: []string{"nvidia-cuda-8gb"},
		MaximumContextTokens: 32768, MaximumBatchSize: 512, MaximumParallelism: 8, MaximumMemoryBytes: 8 * testGiB,
		SupportsGPUOffload: true, RuntimeArtifactDigest: profile.Runtime.RuntimeArtifactDigest,
	}
}

func TestSelectUsesConstraintsThenValidatedBenchmarkThenConservativeFallback(t *testing.T) {
	first := testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB)
	second := testProfile("qwen-llamacpp", "llama-cpp", 20, 1500*1024*1024)
	catalog := testCatalog(t, second, first)
	profiles := map[string]Profile{}
	for _, profile := range catalog.Profiles {
		profiles[profile.ID] = profile
	}
	request := testRequest(catalog, testCapability(profiles["qwen-ollama"]), testCapability(profiles["qwen-llamacpp"]))
	selection, err := Select(catalog, request)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Effective.Profile.ID != "qwen-ollama" || selection.Explanation.Basis != "conservative-reviewed-priority" {
		t.Fatalf("unexpected conservative selection: %#v", selection)
	}
	request.Benchmarks = []ValidatedBenchmark{{
		SchemaVersion: BenchmarkResultVersion, CatalogDigest: catalog.CatalogDigest,
		ProfileID: "qwen-llamacpp", ProfileDigest: profiles["qwen-llamacpp"].ProfileDigest,
		ProfileCompatibilityAttested: true, Passed: true, StabilityBasisPoints: 10_000, TokensPerSecondMilliP50: 42_000,
		ObservedBaselineMemoryBytes: testGiB, ObservedPeakMemoryBytes: 3 * testGiB, ObservedRecoveryMemoryBytes: testGiB,
	}}
	selection, err = Select(catalog, request)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Effective.Profile.ID != "qwen-llamacpp" || selection.Explanation.Basis != "validated-local-benchmark" {
		t.Fatalf("validated benchmark was not preferred: %#v", selection)
	}
}

func TestSelectionRejectsDiagnosticBenchmarkWithoutCompatibilityAttestation(t *testing.T) {
	first := testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB)
	second := testProfile("qwen-llamacpp", "llama-cpp", 20, 1500*1024*1024)
	catalog := testCatalog(t, second, first)
	profiles := map[string]Profile{}
	for _, profile := range catalog.Profiles {
		profiles[profile.ID] = profile
	}
	request := testRequest(catalog, testCapability(profiles["qwen-ollama"]), testCapability(profiles["qwen-llamacpp"]))
	request.Benchmarks = []ValidatedBenchmark{{
		SchemaVersion: BenchmarkResultVersion, CatalogDigest: catalog.CatalogDigest,
		ProfileID: "qwen-llamacpp", ProfileDigest: profiles["qwen-llamacpp"].ProfileDigest,
		ProfileCompatibilityAttested: false, Passed: true, StabilityBasisPoints: 10_000,
		TokensPerSecondMilliP50: 42_000, ObservedBaselineMemoryBytes: testGiB,
		ObservedPeakMemoryBytes: 3 * testGiB, ObservedRecoveryMemoryBytes: testGiB,
	}}
	if _, err := Select(catalog, request); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("diagnostic-only benchmark was accepted for profile selection: %v", err)
	}
}

func TestOverridesCanOnlyReduceReviewedValues(t *testing.T) {
	catalog := testCatalog(t, testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB))
	request := testRequest(catalog, testCapability(catalog.Profiles[0]))
	contextTokens, batch, parallelism, offload, budget := uint64(4096), uint32(64), uint32(1), uint32(12), uint64(3*testGiB)
	request.Overrides = &LocalOverrides{
		SchemaVersion: OverrideVersionV1, ContextTokens: &contextTokens, BatchSize: &batch, Parallelism: &parallelism,
		GPUOffloadLayers: &offload, MaximumMemoryBytes: &budget,
	}
	selection, err := Select(catalog, request)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Effective.Tuning.ContextTokens != 4096 || selection.Effective.Tuning.BatchSize != 64 ||
		selection.Effective.Tuning.GPUOffloadLayers != 12 || selection.Effective.MemoryBudgetBytes != 3*testGiB {
		t.Fatalf("override was not applied exactly: %#v", selection.Effective)
	}
	escalated := uint32(129)
	request.Overrides.BatchSize = &escalated
	if _, err := Select(catalog, request); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("resource escalation must fail closed: %v", err)
	}
	unknown := "unreviewed-backend"
	request.Overrides.BatchSize = &batch
	request.Overrides.RequireBackendID = unknown
	if _, err := Select(catalog, request); !errors.Is(err, ErrNoCompatible) {
		t.Fatalf("unknown forced backend must fail closed: %v", err)
	}
}

func TestSelectionRejectsUnavailableCapabilitiesAndStaleEvidence(t *testing.T) {
	catalog := testCatalog(t, testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB))
	capability := testCapability(catalog.Profiles[0])
	capability.Available = false
	request := testRequest(catalog, capability)
	if _, err := Select(catalog, request); !errors.Is(err, ErrNoCompatible) {
		t.Fatalf("unavailable capability was accepted: %v", err)
	}
	capability.Available = true
	request = testRequest(catalog, capability)
	request.Benchmarks = []ValidatedBenchmark{{
		SchemaVersion: BenchmarkResultVersion, CatalogDigest: testDigest("f"), ProfileID: catalog.Profiles[0].ID,
		ProfileDigest: catalog.Profiles[0].ProfileDigest, ProfileCompatibilityAttested: true,
		Passed: true, StabilityBasisPoints: 10_000,
		TokensPerSecondMilliP50: 1, ObservedPeakMemoryBytes: testGiB,
		ObservedBaselineMemoryBytes: testGiB,
	}}
	if _, err := Select(catalog, request); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("stale benchmark evidence was accepted: %v", err)
	}
}

func TestDigestsAndStrictDecoderRejectTamperingUnknownAndDuplicateFields(t *testing.T) {
	catalog := testCatalog(t, testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB))
	catalog.Profiles[0].Tuning.BatchSize++
	if Validate(catalog) == nil {
		t.Fatal("profile tampering was not detected")
	}
	unknown := []byte(`{"schema_version":"provider-runtime-profile-catalog-v3","unexpected":true}`)
	if _, err := Decode(unknown, MigrationDefaults{}); err == nil {
		t.Fatal("unknown field was accepted")
	}
	duplicate := []byte(`{"schema_version":"provider-runtime-profile-catalog-v3","schema_version":"provider-runtime-profile-catalog-v3"}`)
	if _, err := Decode(duplicate, MigrationDefaults{}); err == nil {
		t.Fatal("duplicate field was accepted")
	}
}

func TestModelIDsRejectURLsFilesystemPathsAndTraversal(t *testing.T) {
	for _, value := range []string{"https://example.test/model", "https:example.com/model", "file:tmp/model", "C:/models/qwen", "/models/qwen", "vendor/../qwen", "vendor\\qwen", "127.0.0.1", "hf:127.0.0.1/model"} {
		if validModelID(value) {
			t.Fatalf("unsafe model id was accepted: %q", value)
		}
	}
	for _, value := range []string{"hf:qwen/qwen2.5-0.5b-instruct", "ollama:library/qwen2.5-0.5b"} {
		if !validModelID(value) {
			t.Fatalf("valid model id was rejected: %q", value)
		}
	}
}

func TestProvenanceRequiresCredentialFreePublicHTTPS(t *testing.T) {
	for _, value := range []string{
		"http://github.com/project", "https://user:pass@github.com/project", "https://127.0.0.1/source",
		"https://localhost/source", "https://catalog.local/source", "https://github.com:8443/source",
	} {
		if validHTTPSURL(value) {
			t.Fatalf("unsafe provenance URL was accepted: %q", value)
		}
	}
	if !validHTTPSURL("https://github.com/thibautrey/multivibe") {
		t.Fatal("public credential-free HTTPS provenance was rejected")
	}
}

func TestLegacyV2DualReadRequiresReviewedDefaultsAndIsDeterministic(t *testing.T) {
	raw := []byte(`{
  "schema_version":"provider-runtime-workload-profile-v2",
  "model":{"model_id":"hf:qwen/qwen2.5-0.5b-instruct","compatible_backend_ids":["ollama-managed"],"content_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","assessment_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","required_context_tokens":8192,"estimated_vram_bytes":2147483648,"download_bytes":400000000},
  "accelerator":{"profile":"cuda","os":"linux","architecture":"amd64","kind":"cuda","memory_bytes":8589934592},
  "runtime":{"contract_version":"provider-runtime-backend-v1","required_capabilities":{"execute":true,"stream":true,"cancel":true,"cleanup":true},"provenance":[{"backend_id":"ollama-managed","source_url":"https://github.com/ollama/ollama","version":"v0.33.2","artifact_sha256":{"linux-amd64":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"container_images":[]}]}
}`)
	if _, err := Decode(raw, MigrationDefaults{}); err == nil {
		t.Fatal("legacy profile was guessed without reviewed defaults")
	}
	defaults := MigrationDefaults{
		BaseProfileID: "qwen-v2", ModelFormat: "gguf", Quantization: "q4_k_m", License: "Apache-2.0",
		HardwareClass: "nvidia-cuda-8gb", AdapterVersion: "adapter-v1",
		RecommendationSourceURL: "https://github.com/thibautrey/multivibe/tree/main/packaging",
		RecommendationDigest:    testDigest("d"), RecommendationLicense: "Apache-2.0",
		BatchSize: 128, Parallelism: 1, GPUOffloadLayers: 24, ReserveMemoryBytes: testGiB,
	}
	first, err := Decode(raw, defaults)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Decode(raw, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) || first.Provenance.MigratedFrom != LegacyVersionV2 || len(first.Profiles) != 1 {
		t.Fatalf("migration is not deterministic: %#v", first)
	}
}

func TestLoadRequiresBoundedRegularAbsoluteFile(t *testing.T) {
	catalog := testCatalog(t, testProfile("qwen-ollama", "ollama-managed", 10, 2*testGiB))
	raw, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path, MigrationDefaults{}); err != nil {
		t.Fatal(err)
	}
	if _, err := Load("catalog.json", MigrationDefaults{}); err == nil {
		t.Fatal("relative catalog path was accepted")
	}
	symlink := filepath.Join(filepath.Dir(path), "catalog-link.json")
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(symlink, MigrationDefaults{}); err == nil {
		t.Fatal("symlink catalog was accepted")
	}
}

func TestPackagedCatalogMatchesReviewedGoldenAndValidates(t *testing.T) {
	packagedPath, err := filepath.Abs(filepath.Join("..", "..", "packaging", "provider-runtime-profiles.json"))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile(filepath.Join("testdata", "catalog-v3.golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	packaged, err := os.ReadFile(packagedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(packaged, golden) {
		t.Fatal("packaged runtime profile catalog drifted from its reviewed golden")
	}
	if _, err := Load(packagedPath, MigrationDefaults{}); err != nil {
		t.Fatalf("packaged catalog is invalid: %v", err)
	}
}
