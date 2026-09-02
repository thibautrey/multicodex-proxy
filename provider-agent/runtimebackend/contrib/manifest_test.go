package contrib

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

func contributionFixture(t *testing.T) (string, Manifest, runtimebackend.Descriptor) {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "adapter"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"adapter/backend.go":      "package adapter\n",
		"adapter/backend_test.go": "package adapter\n",
		"profiles/example.json":   "{}\n",
	}
	roles := map[string]FileRole{
		"adapter/backend.go":      FileRoleAdapterSource,
		"adapter/backend_test.go": FileRoleContractTest,
		"profiles/example.json":   FileRoleProfile,
	}
	paths := make([]string, 0, len(files))
	for path, contents := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(path))
		if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	pins := make([]FilePin, 0, len(paths))
	for _, path := range paths {
		pin, err := PinFile(root, path, roles[path])
		if err != nil {
			t.Fatalf("pin %s: %v", path, err)
		}
		pins = append(pins, pin)
	}
	descriptor := runtimebackend.Descriptor{
		ContractVersion: runtimebackend.ContractVersion,
		ID:              "example-static",
		Priority:        500,
		Capabilities:    runtimebackend.Capabilities{ShadowOnly: true},
		Accelerators: []runtimebackend.AcceleratorConstraint{{
			Profile: "cpu-generic", OS: "linux", Architecture: "amd64", Kind: "cpu",
		}},
		Limits: runtimebackend.Limits{
			MaximumModels: 1, MaximumConcurrency: 1, MaximumModelBytes: 1024,
			MaximumMemoryBytes: 1024, MaximumContextTokens: 128,
			MaximumInputBytes: 128, MaximumOutputBytes: 128,
		},
		Provenance: runtimebackend.Provenance{
			SourceURL: "https://example.invalid/multivibe/example-static",
			Version:   "v1.0.0",
			ArtifactSHA256: map[string]string{
				"source": strings.Repeat("b", 64),
			},
		},
	}
	digest, err := DescriptorDigest(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		SchemaVersion:          ManifestSchemaVersion,
		BackendID:              descriptor.ID,
		BackendContractVersion: runtimebackend.ContractVersion,
		DescriptorSHA256:       digest,
		ManifestPath:           "adapter/contribution.json",
		Provenance: Provenance{
			SourceURL: "https://example.invalid/multivibe/example-static", LicenseSPDX: "Apache-2.0",
		},
		Files: pins,
	}
	writeFixtureManifest(t, root, &manifest)
	return root, manifest, descriptor
}

func updateFixtureManifestDigest(t *testing.T, manifest *Manifest) {
	t.Helper()
	sort.Slice(manifest.Files, func(left, right int) bool {
		return manifest.Files[left].Path < manifest.Files[right].Path
	})
	digest, err := PinnedFilesDigest(manifest.Files)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Provenance.SourceDigest = digest
}

func writeFixtureManifest(t *testing.T, root string, manifest *Manifest) {
	t.Helper()
	updateFixtureManifestDigest(t, manifest)
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(manifest.ManifestPath)), manifestJSON, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeAndPinFixtureFile(t *testing.T, root string, manifest *Manifest, relativePath string, role FileRole, contents string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	pin, err := PinFile(root, relativePath, role)
	if err != nil {
		t.Fatalf("pin %s: %v", relativePath, err)
	}
	replaced := false
	for index := range manifest.Files {
		if manifest.Files[index].Path == relativePath {
			manifest.Files[index] = pin
			replaced = true
			break
		}
	}
	if !replaced {
		manifest.Files = append(manifest.Files, pin)
	}
	writeFixtureManifest(t, root, manifest)
}

func TestParseManifestStrictAndBounded(t *testing.T) {
	_, manifest, _ := contributionFixture(t)
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseManifest(raw)
	if err != nil || parsed.BackendID != manifest.BackendID {
		t.Fatalf("valid manifest rejected: %#v %v", parsed, err)
	}

	tests := map[string][]byte{
		"duplicate key":        bytes.Replace(raw, []byte(`"backend_id": "example-static"`), []byte(`"backend_id":"example-static","backend_id":"example-static"`), 1),
		"unknown launch field": bytes.Replace(raw, []byte(`"files": [`), []byte(`"executable":"/bin/sh","files": [`), 1),
		"trailing value":       append(append([]byte(nil), raw...), []byte(` {}`)...),
		"oversize":             bytes.Repeat([]byte("x"), MaximumManifestBytes+1),
	}
	for name, candidate := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseManifest(candidate); err == nil {
				t.Fatal("malformed manifest was accepted")
			}
		})
	}
	if _, err := ParseManifest(tests["duplicate key"]); !errors.Is(err, ErrDuplicateJSONKey) {
		t.Fatalf("duplicate key was not classified: %v", err)
	}
}

func TestManifestRejectsUnsafePathsModesAndOrdering(t *testing.T) {
	_, manifest, _ := contributionFixture(t)
	tests := map[string]func(*Manifest){
		"traversal": func(candidate *Manifest) { candidate.Files[0].Path = "../backend.go" },
		"absolute":  func(candidate *Manifest) { candidate.Files[0].Path = "/tmp/backend.go" },
		"executable mode": func(candidate *Manifest) {
			candidate.Files[0].Mode = 0o755
		},
		"unsorted": func(candidate *Manifest) {
			candidate.Files[0], candidate.Files[1] = candidate.Files[1], candidate.Files[0]
		},
		"missing source": func(candidate *Manifest) {
			for index := range candidate.Files {
				if candidate.Files[index].Role == FileRoleAdapterSource {
					candidate.Files[index].Role = FileRoleDocumentation
				}
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			candidate := manifest
			candidate.Files = append([]FilePin(nil), manifest.Files...)
			mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, ErrInvalidManifest) {
				t.Fatalf("unsafe manifest accepted: %v", err)
			}
		})
	}
}

func TestManifestRejectsBuildInputsDisguisedAsData(t *testing.T) {
	_, manifest, _ := contributionFixture(t)
	buildExtensions := []string{
		".go", ".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".h", ".hh", ".hpp", ".hxx",
		".f", ".F", ".for", ".f90", ".s", ".S", ".sx", ".swig", ".swigcxx", ".syso",
	}
	spoofedRoles := []FileRole{FileRoleDocumentation, FileRoleProfile, FileRoleRuntimeArtifact}
	for _, extension := range buildExtensions {
		for _, role := range spoofedRoles {
			name := strings.TrimPrefix(extension, ".") + "_as_" + string(role)
			t.Run(name, func(t *testing.T) {
				candidate := manifest
				candidate.Files = append([]FilePin(nil), manifest.Files...)
				candidate.Files = append(candidate.Files, FilePin{
					Path:   "adapter/disguised" + extension,
					Role:   role,
					Mode:   0o644,
					Size:   1,
					SHA256: "sha256:" + strings.Repeat("a", 64),
				})
				updateFixtureManifestDigest(t, &candidate)
				if err := candidate.Validate(); !errors.Is(err, ErrInvalidManifest) {
					t.Fatalf("%s build input accepted as %s: %v", extension, role, err)
				}
			})
		}
	}
}

func TestManifestAcceptsOnlyNativeBuildInputsAsNativeSource(t *testing.T) {
	_, manifest, _ := contributionFixture(t)
	candidate := manifest
	candidate.Files = append([]FilePin(nil), manifest.Files...)
	candidate.Files = append(candidate.Files, FilePin{
		Path:   "adapter/reviewed.s",
		Role:   FileRoleNativeSource,
		Mode:   0o644,
		Size:   1,
		SHA256: "sha256:" + strings.Repeat("a", 64),
	})
	updateFixtureManifestDigest(t, &candidate)
	if err := candidate.Validate(); err != nil {
		t.Fatalf("reviewed native source rejected: %v", err)
	}

	for index := range candidate.Files {
		if candidate.Files[index].Path == "adapter/reviewed.s" {
			candidate.Files[index].Path = "adapter/not-source.txt"
			break
		}
	}
	updateFixtureManifestDigest(t, &candidate)
	if err := candidate.Validate(); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("non-build input accepted as native source: %v", err)
	}
}

func TestVerifyPinnedFilesRejectsSymlinkMutationAndTOCTOU(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		root, manifest, _ := contributionFixture(t)
		target := filepath.Join(root, "adapter", "backend.go")
		if err := os.Remove(target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(root, "adapter", "backend_test.go"), target); err != nil {
			t.Fatal(err)
		}
		if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
			t.Fatalf("symlink was not rejected: %v", err)
		}
	})

	t.Run("parent symlink", func(t *testing.T) {
		root, manifest, _ := contributionFixture(t)
		adapter := filepath.Join(root, "adapter")
		moved := filepath.Join(root, "adapter-real")
		if err := os.Rename(adapter, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(moved, adapter); err != nil {
			t.Fatal(err)
		}
		if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
			t.Fatalf("parent symlink was not rejected: %v", err)
		}
	})

	t.Run("swap after inspection", func(t *testing.T) {
		root, manifest, _ := contributionFixture(t)
		victim := filepath.Join(root, "adapter", "backend.go")
		called := false
		err := verifyPinnedFiles(root, manifest, func(path string) error {
			if path != victim || called {
				return nil
			}
			called = true
			moved := path + ".original"
			if err := os.Rename(path, moved); err != nil {
				return err
			}
			return os.Symlink(moved, path)
		})
		if !called || !errors.Is(err, ErrPinnedFileMismatch) {
			t.Fatalf("TOCTOU swap was not rejected: called=%t err=%v", called, err)
		}
	})
}

func TestVerifyPinnedFilesRejectsDigestAndModeChanges(t *testing.T) {
	root, manifest, _ := contributionFixture(t)
	path := filepath.Join(root, "profiles", "example.json")
	if err := os.WriteFile(path, []byte("{\"changed\":true}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("digest change was not rejected: %v", err)
	}

	root, manifest, _ = contributionFixture(t)
	path = filepath.Join(root, "adapter", "backend.go")
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("mode change was not rejected: %v", err)
	}
}

func TestVerifyPinnedFilesRejectsUnpinnedPackageInputs(t *testing.T) {
	for name, relativePath := range map[string]string{
		"go source":       "adapter/unreviewed_linux.go",
		"embeddable data": "adapter/prompt-template.bin",
	} {
		t.Run(name, func(t *testing.T) {
			root, manifest, _ := contributionFixture(t)
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(relativePath)), []byte("unreviewed\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
				t.Fatalf("unpinned package input was accepted: %v", err)
			}
		})
	}
}

func TestVerifyPinnedFilesRejectsUnpinnedLocalImport(t *testing.T) {
	root, manifest, _ := contributionFixture(t)
	writeAndPinFixtureFile(t, root, &manifest, "adapter/backend.go", FileRoleAdapterSource, `package adapter

import _ "github.com/thibautrey/multivibe/provider-agent/runtimehelper/unreviewed"
`)
	helper := filepath.Join(root, "provider-agent", "runtimehelper", "unreviewed", "helper.go")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("package unreviewed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("unpinned module-local import was accepted: %v", err)
	}
}

func TestVerifyPinnedFilesClosesRecursiveLocalImportsAndEmbedInputs(t *testing.T) {
	root, manifest, _ := contributionFixture(t)
	writeAndPinFixtureFile(t, root, &manifest, "adapter/backend.go", FileRoleAdapterSource, `package adapter

import _ "github.com/thibautrey/multivibe/provider-agent/runtimehelper/first"
`)
	writeAndPinFixtureFile(t, root, &manifest, "provider-agent/runtimehelper/first/first.go", FileRoleAdapterSource, `package first

import _ "github.com/thibautrey/multivibe/provider-agent/runtimehelper/second"
`)
	writeAndPinFixtureFile(t, root, &manifest, "provider-agent/runtimehelper/second/second.go", FileRoleAdapterSource, "package second\n")
	if err := VerifyPinnedFiles(root, manifest); err != nil {
		t.Fatalf("recursively pinned local imports were rejected: %v", err)
	}

	writeAndPinFixtureFile(t, root, &manifest, "provider-agent/runtimehelper/second/second.go", FileRoleAdapterSource, `package second

import _ "github.com/thibautrey/multivibe/provider-agent/runtimehelper/third"
`)
	third := filepath.Join(root, "provider-agent", "runtimehelper", "third")
	if err := os.MkdirAll(third, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(third, "third.go"), []byte("package third\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("transitive unpinned local import was accepted: %v", err)
	}
	if err := os.RemoveAll(third); err != nil {
		t.Fatal(err)
	}

	writeAndPinFixtureFile(t, root, &manifest, "provider-agent/runtimehelper/second/second.go", FileRoleAdapterSource, `package second

import _ "embed"

//go:embed prompt.txt
var prompt string
`)
	if err := os.WriteFile(filepath.Join(root, "provider-agent", "runtimehelper", "second", "prompt.txt"), []byte("unreviewed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("unpinned go:embed neighbor in a local import was accepted: %v", err)
	}
}

func TestVerifyPinnedFilesParsesBuildTaggedGoSources(t *testing.T) {
	root, manifest, _ := contributionFixture(t)
	writeAndPinFixtureFile(t, root, &manifest, "adapter/hidden_plan9.go", FileRoleAdapterSource, `//go:build plan9 && multivibe_never

package adapter

import _ "github.com/thibautrey/multivibe/provider-agent/runtimehelper/hidden"
`)
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("local import hidden by a build tag was accepted: %v", err)
	}
}

func TestVerifyPinnedFilesRejectsCgoImports(t *testing.T) {
	root, manifest, _ := contributionFixture(t)
	writeAndPinFixtureFile(t, root, &manifest, "adapter/cgo.go", FileRoleAdapterSource, `package adapter

import "C"
`)
	if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
		t.Fatalf("cgo import was accepted: %v", err)
	}
}

func TestVerifyPinnedFilesRestrictsTestSupportImportsToTests(t *testing.T) {
	for _, importPath := range []string{contribImportPath, contractTestImportPath} {
		t.Run(filepath.Base(importPath)+" in production", func(t *testing.T) {
			root, manifest, _ := contributionFixture(t)
			writeAndPinFixtureFile(t, root, &manifest, "adapter/backend.go", FileRoleAdapterSource, "package adapter\n\nimport _ \""+importPath+"\"\n")
			if err := VerifyPinnedFiles(root, manifest); !errors.Is(err, ErrPinnedFileMismatch) {
				t.Fatalf("test support import was accepted in production source: %v", err)
			}
		})
	}

	root, manifest, _ := contributionFixture(t)
	writeAndPinFixtureFile(t, root, &manifest, "adapter/backend.go", FileRoleAdapterSource, "package adapter\n\nimport _ \""+runtimeBackendImportPath+"\"\n")
	writeAndPinFixtureFile(t, root, &manifest, "adapter/backend_test.go", FileRoleContractTest, `package adapter

import (
	_ "github.com/thibautrey/multivibe/provider-agent/runtimebackend/contrib"
	_ "github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)
`)
	if err := VerifyPinnedFiles(root, manifest); err != nil {
		t.Fatalf("exact runtime and test-only baselines were rejected: %v", err)
	}
}

func TestVerifyPinnedFilesAnchorsRootAndParentsAcrossReplacement(t *testing.T) {
	t.Run("root replaced", func(t *testing.T) {
		root, manifest, _ := contributionFixture(t)
		moved := root + "-original"
		t.Cleanup(func() { _ = os.RemoveAll(moved) })
		called := false
		err := verifyPinnedFiles(root, manifest, func(string) error {
			if called {
				return nil
			}
			called = true
			if err := os.Rename(root, moved); err != nil {
				return err
			}
			return os.Mkdir(root, 0o755)
		})
		if !called || !errors.Is(err, ErrPinnedFileMismatch) {
			t.Fatalf("root replacement was not rejected: called=%t err=%v", called, err)
		}
	})

	t.Run("parent replaced by symlink", func(t *testing.T) {
		root, manifest, _ := contributionFixture(t)
		adapter := filepath.Join(root, "adapter")
		moved := filepath.Join(root, "adapter-original")
		called := false
		err := verifyPinnedFiles(root, manifest, func(path string) error {
			if called || path != filepath.Join(adapter, "backend.go") {
				return nil
			}
			called = true
			if err := os.Rename(adapter, moved); err != nil {
				return err
			}
			return os.Symlink("adapter-original", adapter)
		})
		if !called || !errors.Is(err, ErrPinnedFileMismatch) {
			t.Fatalf("parent replacement was not rejected: called=%t err=%v", called, err)
		}
	})
}

func TestDescriptorAndManifestDigestsAreDeterministic(t *testing.T) {
	_, manifest, descriptor := contributionFixture(t)
	first, err := DescriptorDigest(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	second, err := DescriptorDigest(descriptor)
	if err != nil || first != second || first != manifest.DescriptorSHA256 {
		t.Fatalf("descriptor digest is unstable: %q %q %v", first, second, err)
	}
	manifestFirst, err := ManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestSecond, err := ManifestDigest(manifest)
	if err != nil || manifestFirst != manifestSecond {
		t.Fatalf("manifest digest is unstable: %q %q %v", manifestFirst, manifestSecond, err)
	}
}
