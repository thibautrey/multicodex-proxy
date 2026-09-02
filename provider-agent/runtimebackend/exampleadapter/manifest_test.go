package exampleadapter

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contrib"
)

func TestReferenceContributionManifest(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate example package")
	}
	packageDirectory := filepath.Dir(sourceFile)
	repositoryRoot := filepath.Clean(filepath.Join(packageDirectory, "..", "..", ".."))
	raw, err := os.ReadFile(filepath.Join(packageDirectory, "contribution.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := contrib.ParseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := contrib.VerifyPinnedFiles(repositoryRoot, manifest); err != nil {
		t.Fatalf("example contribution pins drifted: %v", err)
	}
	backend, err := New(ReferenceConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := contrib.VerifyRegistration(contrib.Registration{Manifest: manifest, Backend: backend}); err != nil {
		t.Fatalf("example descriptor drifted: %v", err)
	}
}
