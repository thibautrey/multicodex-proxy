package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProviderModelCatalogIsPinnedAndMatchesDemandOnlyExactly(t *testing.T) {
	path := filepath.Clean(filepath.Join("..", "packaging", "provider-model-catalog.json"))
	absolute, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := openProviderModelCatalog(absolute)
	if err != nil {
		t.Fatal(err)
	}
	entry, found := catalog.entry("hf:qwen/qwen2.5-0.5b-instruct")
	if !found {
		t.Fatal("pinned test model is missing")
	}
	artifact := providerDemandArtifact{
		CanonicalModelID: entry.CanonicalModelID, ContentDigest: entry.ContentDigest, DownloadBytes: entry.DownloadBytes,
		License: providerDemandLicense{LicenseID: entry.License.LicenseID, HostedInferenceAllowed: true, AssessmentDigest: entry.License.AssessmentDigest},
	}
	if _, ok := entry.candidateFor(artifact, 8192); !ok {
		t.Fatal("exact signed artifact did not match the local catalog")
	}
	artifact.ContentDigest = "sha256:" + "0" + entry.ContentDigest[len("sha256:")+1:]
	if _, ok := entry.candidateFor(artifact, 8192); ok {
		t.Fatal("content digest mismatch was accepted")
	}
}

func TestProviderModelCatalogRejectsTrailingOrUnpinnedFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":"provider-model-catalog-v1","models":[],"download_url":"https://evil.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openProviderModelCatalog(path); err == nil {
		t.Fatal("unreviewed catalog field was accepted")
	}
}

func TestProviderModelCatalogAssessmentPathIsBoundedAndRelative(t *testing.T) {
	for _, valid := range []string{
		"provider-model-license-assessments/qwen2.5-0.5b.md",
		"provider-model-license-assessments/vendor/model.md",
	} {
		if !safeAssessmentPath(valid) {
			t.Fatalf("expected assessment path to be valid: %q", valid)
		}
	}
	for _, invalid := range []string{
		"assessment.md",
		"provider-model-license-assessments/../assessment.md",
		"provider-model-license-assessments/model.txt",
		"provider-model-license-assessments/model\\escape.md",
		"/provider-model-license-assessments/model.md",
	} {
		if safeAssessmentPath(invalid) {
			t.Fatalf("unsafe assessment path was accepted: %q", invalid)
		}
	}
}
