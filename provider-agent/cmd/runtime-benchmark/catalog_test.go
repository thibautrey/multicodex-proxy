package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimebenchmark"
	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

func packagedBenchmarkPath(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "..", "packaging", name))
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(path)
}

func packagedRuntimeCatalog(t *testing.T) (runtimeprofile.Catalog, runtimeprofile.Profile, string) {
	t.Helper()
	path := packagedBenchmarkPath(t, "provider-runtime-profiles.json")
	catalog, err := runtimeprofile.Load(path, runtimeprofile.MigrationDefaults{})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Profiles) != 2 {
		t.Fatalf("unexpected packaged profile count: %d", len(catalog.Profiles))
	}
	return catalog, catalog.Profiles[0], path
}

func TestPackagedModelCatalogDerivesOnlyExactReviewedOllamaModel(t *testing.T) {
	runtimeCatalog, profile, runtimeCatalogPath := packagedRuntimeCatalog(t)
	modelCatalog, err := loadBenchmarkModelCatalog(packagedBenchmarkPath(t, "provider-model-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := modelCatalog.modelForProfile(runtimeCatalog, profile)
	if err != nil {
		t.Fatal(err)
	}
	if entry.OllamaModel != "qwen2.5:0.5b" || entry.CanonicalModelID != "hf:qwen/qwen2.5-0.5b-instruct" ||
		entry.ContentDigest != "sha256:a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67" ||
		entry.downloadBytes != 397821319 || entry.License.LicenseID != "Apache-2.0" ||
		entry.License.AssessmentDigest != "820d427dba05fb3ef3694ea46c991e1317dbc6de9dcededfaf7937023ebd77c8" {
		t.Fatalf("unexpected derived model: %#v", entry)
	}
	version, err := loadBenchmarkOllamaExpectation(runtimeCatalogPath, profile)
	if err != nil {
		t.Fatal(err)
	}
	if version != benchmarkOllamaVersion {
		t.Fatalf("unexpected Ollama version: %q", version)
	}
}

func TestBenchmarkProfileRequiresCompiledRuntimeContract(t *testing.T) {
	_, profile, _ := packagedRuntimeCatalog(t)
	if !supportsBenchmarkProfile(profile) {
		t.Fatal("packaged runtime profile does not match the compiled benchmark adapter")
	}
	if !supportsBenchmarkPlatform(profile, "linux", "amd64") || supportsBenchmarkPlatform(profile, "darwin", "arm64") {
		t.Fatal("runtime profile platform was not matched exactly")
	}
	for name, mutate := range map[string]func(*runtimeprofile.Profile){
		"backend":     func(profile *runtimeprofile.Profile) { profile.Runtime.BackendID = "other" },
		"contract":    func(profile *runtimeprofile.Profile) { profile.Runtime.ContractVersion = "provider-runtime-backend-v2" },
		"adapter":     func(profile *runtimeprofile.Profile) { profile.Runtime.AdapterVersion = "ollama-adapter-v2" },
		"parallelism": func(profile *runtimeprofile.Profile) { profile.Tuning.Parallelism = 2 },
		"cpu-only":    func(profile *runtimeprofile.Profile) { profile.Tuning.GPUOffloadLayers = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := profile
			mutate(&candidate)
			if supportsBenchmarkProfile(candidate) {
				t.Fatal("unsupported runtime profile was accepted")
			}
		})
	}
}

func TestModelCatalogAndProfileMismatchesFailClosed(t *testing.T) {
	runtimeCatalog, profile, _ := packagedRuntimeCatalog(t)
	modelCatalog, err := loadBenchmarkModelCatalog(packagedBenchmarkPath(t, "provider-model-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*benchmarkModelCatalog, *runtimeprofile.Catalog, *runtimeprofile.Profile)
	}{
		{name: "catalog-file-digest", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.fileDigest = "sha256:" + strings.Repeat("0", 64)
		}},
		{name: "canonical-id", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].CanonicalModelID = "hf:qwen/other"
		}},
		{name: "content-digest", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].ContentDigest = "sha256:" + strings.Repeat("0", 64)
		}},
		{name: "artifact-size", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].downloadBytes++
		}},
		{name: "license", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].License.LicenseID = "MIT"
		}},
		{name: "hosted-inference", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].License.HostedInferenceAllowed = false
		}},
		{name: "assessment", mutate: func(catalog *benchmarkModelCatalog, _ *runtimeprofile.Catalog, _ *runtimeprofile.Profile) {
			catalog.Models[0].License.AssessmentDigest = strings.Repeat("0", 64)
		}},
		{name: "profile-provenance", mutate: func(_ *benchmarkModelCatalog, _ *runtimeprofile.Catalog, profile *runtimeprofile.Profile) {
			profile.Provenance.RecommendationDigest = "sha256:" + strings.Repeat("0", 64)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidateCatalog := modelCatalog
			candidateCatalog.Models = append([]benchmarkModelCatalogEntry(nil), modelCatalog.Models...)
			candidateRuntimeCatalog := runtimeCatalog
			candidateProfile := profile
			test.mutate(&candidateCatalog, &candidateRuntimeCatalog, &candidateProfile)
			if _, err := candidateCatalog.modelForProfile(candidateRuntimeCatalog, candidateProfile); !errors.Is(err, runtimeprofile.ErrNoCompatible) {
				t.Fatalf("mismatch was accepted: %v", err)
			}
		})
	}
}

func TestModelCatalogReaderRejectsUntrustedJSONAndPaths(t *testing.T) {
	directory := t.TempDir()
	validRaw, err := os.ReadFile(packagedBenchmarkPath(t, "provider-model-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{
		"unknown.json":   append(validRaw[:len(validRaw)-2], []byte(`,"download_url":"https://evil.example"}\n`)...),
		"duplicate.json": []byte(`{"schema_version":"provider-model-catalog-v1","schema_version":"provider-model-catalog-v1","models":[]}`),
		"trailing.json":  append(append([]byte(nil), validRaw...), []byte(` {}`)...),
	} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadBenchmarkModelCatalog(path); !errors.Is(err, runtimebenchmark.ErrInvalid) {
			t.Fatalf("%s was accepted: %v", name, err)
		}
	}
	if _, err := loadBenchmarkModelCatalog("relative.json"); !errors.Is(err, runtimebenchmark.ErrInvalid) {
		t.Fatalf("relative catalog path was accepted: %v", err)
	}
	symlink := filepath.Join(directory, "catalog-link.json")
	if err := os.Symlink(packagedBenchmarkPath(t, "provider-model-catalog.json"), symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := loadBenchmarkModelCatalog(symlink); !errors.Is(err, runtimebenchmark.ErrInvalid) {
		t.Fatalf("symlinked catalog was accepted: %v", err)
	}
}

func TestOllamaDependencyVersionAndArtifactMustMatchProfile(t *testing.T) {
	_, profile, runtimeCatalogPath := packagedRuntimeCatalog(t)
	if _, err := loadBenchmarkOllamaExpectation(runtimeCatalogPath, profile); err != nil {
		t.Fatal(err)
	}
	tamperedProfile := profile
	tamperedProfile.Runtime.RuntimeArtifactDigest = "sha256:" + strings.Repeat("0", 64)
	if _, err := loadBenchmarkOllamaExpectation(runtimeCatalogPath, tamperedProfile); !errors.Is(err, runtimeprofile.ErrNoCompatible) {
		t.Fatalf("runtime artifact mismatch was accepted: %v", err)
	}
	directory := t.TempDir()
	tamperedDependencies := []byte(`{
		"schemaVersion":1,
		"node":{"version":"22.23.2","artifacts":{"linux-amd64":{"url":"https://example.test/node","sha256":"61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6","archive":"tar-gzip"}}},
		"ollama":{"version":"0.33.1","artifacts":{"linux-amd64":{"url":"https://example.test/ollama","sha256":"9785247dea264d9072f09f6c9c0eb4b8e666892826a3d8388eba3e8fb9ed1db9","archive":"tar-zstd"}}}
	}`)
	if err := os.WriteFile(filepath.Join(directory, "provider-host-dependencies.json"), tamperedDependencies, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadBenchmarkOllamaExpectation(filepath.Join(directory, "provider-runtime-profiles.json"), profile); !errors.Is(err, runtimebenchmark.ErrInvalid) {
		t.Fatalf("unsupported Ollama version was accepted: %v", err)
	}
}
