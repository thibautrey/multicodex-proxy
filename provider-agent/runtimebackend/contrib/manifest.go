// Package contrib contains review-time helpers for statically compiled runtime
// backend contributions. It deliberately has no dynamic loading, filesystem
// discovery, process execution or mutable global registration mechanism.
package contrib

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const (
	ManifestSchemaVersion = "multivibe-runtime-contribution-v1"
	MaximumManifestBytes  = 256 * 1024
	MaximumPinnedFiles    = 256
	MaximumPinnedFileSize = 16 * 1024 * 1024
	MaximumPinnedTotal    = 64 * 1024 * 1024
)

var (
	ErrInvalidManifest     = errors.New("runtime contribution manifest is invalid")
	ErrDuplicateJSONKey    = errors.New("runtime contribution manifest contains a duplicate JSON key")
	ErrDescriptorMismatch  = errors.New("runtime contribution descriptor does not match its manifest")
	ErrPinnedFileMismatch  = errors.New("runtime contribution pinned file does not match its manifest")
	ErrUnsafeTrafficPolicy = errors.New("runtime contribution must remain shadow-only")

	backendIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	digestPattern    = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	spdxIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$`)
)

type FileRole string

const (
	FileRoleAdapterSource   FileRole = "adapter_source"
	FileRoleNativeSource    FileRole = "native_source"
	FileRoleContractTest    FileRole = "contract_test"
	FileRoleProfile         FileRole = "profile"
	FileRoleDocumentation   FileRole = "documentation"
	FileRoleRuntimeArtifact FileRole = "runtime_artifact"
)

// Provenance identifies the reviewed source material and its source license.
// Runtime binary and container pins remain part of runtimebackend.Descriptor;
// DescriptorSHA256 binds those values to this contribution.
type Provenance struct {
	SourceURL    string `json:"source_url"`
	SourceDigest string `json:"source_digest"`
	LicenseSPDX  string `json:"license_spdx"`
}

// FilePin describes review inputs only. Executable bits are forbidden because
// this package describes Go code compiled with the worker, not loadable files.
type FilePin struct {
	Path   string   `json:"path"`
	Role   FileRole `json:"role"`
	Mode   uint32   `json:"mode"`
	Size   uint64   `json:"size"`
	SHA256 string   `json:"sha256"`
}

// Manifest is a data-only review record for one statically linked backend.
// It intentionally contains no executable, argv, environment, socket, image
// launch instruction, init hook or discovery path.
type Manifest struct {
	SchemaVersion          string     `json:"schema_version"`
	BackendID              string     `json:"backend_id"`
	BackendContractVersion string     `json:"backend_contract_version"`
	DescriptorSHA256       string     `json:"descriptor_sha256"`
	ManifestPath           string     `json:"manifest_path"`
	Provenance             Provenance `json:"provenance"`
	Files                  []FilePin  `json:"files"`
}

// ParseManifest strictly parses a bounded manifest. Unknown fields, duplicate
// object keys and trailing JSON are rejected instead of being ignored.
func ParseManifest(raw []byte) (Manifest, error) {
	if len(raw) == 0 || len(raw) > MaximumManifestBytes {
		return Manifest{}, ErrInvalidManifest
	}
	if err := validateUniqueJSONKeys(raw); err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("%w: schema", ErrInvalidManifest)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Manifest{}, err
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (manifest Manifest) Validate() error {
	if manifest.SchemaVersion != ManifestSchemaVersion ||
		manifest.BackendContractVersion != runtimebackend.ContractVersion ||
		!backendIDPattern.MatchString(manifest.BackendID) ||
		!digestPattern.MatchString(manifest.DescriptorSHA256) ||
		!validRelativePath(manifest.ManifestPath) ||
		!digestPattern.MatchString(manifest.Provenance.SourceDigest) ||
		!spdxIDPattern.MatchString(manifest.Provenance.LicenseSPDX) ||
		!validSourceURL(manifest.Provenance.SourceURL) ||
		len(manifest.Files) == 0 || len(manifest.Files) > MaximumPinnedFiles {
		return ErrInvalidManifest
	}
	seen := make(map[string]struct{}, len(manifest.Files))
	previous := ""
	var total uint64
	hasSource := false
	hasTest := false
	packageDirectories := make(map[string]struct{})
	for _, file := range manifest.Files {
		if !validRelativePath(file.Path) || file.Path == manifest.ManifestPath || file.Path <= previous {
			return ErrInvalidManifest
		}
		if _, duplicate := seen[file.Path]; duplicate {
			return ErrInvalidManifest
		}
		seen[file.Path] = struct{}{}
		previous = file.Path
		if file.Mode != 0o444 && file.Mode != 0o644 {
			return ErrInvalidManifest
		}
		if file.Size == 0 || file.Size > MaximumPinnedFileSize || !digestPattern.MatchString(file.SHA256) {
			return ErrInvalidManifest
		}
		if total > MaximumPinnedTotal-file.Size {
			return ErrInvalidManifest
		}
		total += file.Size
		if !validFileRoleForPath(file.Path, file.Role) {
			return ErrInvalidManifest
		}
		switch file.Role {
		case FileRoleAdapterSource:
			hasSource = true
			packageDirectories[filepath.Dir(file.Path)] = struct{}{}
		case FileRoleContractTest:
			hasTest = true
			packageDirectories[filepath.Dir(file.Path)] = struct{}{}
		case FileRoleNativeSource:
			packageDirectories[filepath.Dir(file.Path)] = struct{}{}
		case FileRoleProfile, FileRoleDocumentation, FileRoleRuntimeArtifact:
		default:
			return ErrInvalidManifest
		}
	}
	if !hasSource || !hasTest {
		return ErrInvalidManifest
	}
	if _, found := packageDirectories[filepath.Dir(manifest.ManifestPath)]; !found {
		return ErrInvalidManifest
	}
	pinnedDigest, err := PinnedFilesDigest(manifest.Files)
	if err != nil || pinnedDigest != manifest.Provenance.SourceDigest {
		return ErrInvalidManifest
	}
	return nil
}

// validFileRoleForPath prevents a build input from being disguised as data or
// documentation. The native suffixes mirror the file classes recognized by
// go/build, including cgo, SWIG, assembly, and precompiled system objects.
func validFileRoleForPath(filePath string, role FileRole) bool {
	isGoSource := path.Ext(filePath) == ".go"
	isTestSource := strings.HasSuffix(filePath, "_test.go")
	isNativeSource := isGoNativeSourcePath(filePath)
	switch role {
	case FileRoleAdapterSource:
		return isGoSource && !isTestSource
	case FileRoleNativeSource:
		return isNativeSource
	case FileRoleContractTest:
		return isTestSource
	case FileRoleProfile, FileRoleDocumentation, FileRoleRuntimeArtifact:
		return !isGoSource && !isNativeSource
	default:
		return false
	}
}

func isGoNativeSourcePath(filePath string) bool {
	switch path.Ext(filePath) {
	case ".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".h", ".hh", ".hpp", ".hxx",
		".f", ".F", ".for", ".f90", ".s", ".S", ".sx", ".swig", ".swigcxx", ".syso":
		return true
	default:
		return false
	}
}

func validSourceURL(raw string) bool {
	if len(raw) == 0 || len(raw) > 512 {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.Port() == "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func validRelativePath(value string) bool {
	if value == "" || len(value) > 256 || filepath.IsAbs(value) || strings.Contains(value, "\\") {
		return false
	}
	clean := filepath.Clean(value)
	if clean != value || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// DescriptorDigest returns the canonical SHA-256 pin used by manifests. The
// descriptor contains no secret or local launch policy by contract.
func DescriptorDigest(descriptor runtimebackend.Descriptor) (string, error) {
	encoded, err := canonicalJSON(descriptor)
	if err != nil {
		return "", fmt.Errorf("%w: descriptor encoding", ErrInvalidManifest)
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func ManifestDigest(manifest Manifest) (string, error) {
	if err := manifest.Validate(); err != nil {
		return "", err
	}
	encoded, err := canonicalJSON(manifest)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

// PinnedFilesDigest binds provenance to the complete ordered review input.
func PinnedFilesDigest(files []FilePin) (string, error) {
	encoded, err := canonicalJSON(files)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func canonicalJSON(value any) ([]byte, error) {
	// encoding/json orders string map keys and struct fields are fixed. The
	// resulting compact bytes are the package's versioned canonical form.
	return json.Marshal(value)
}

func validateUniqueJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	var consume func(int) error
	consume = func(depth int) error {
		if depth > 24 {
			return ErrInvalidManifest
		}
		nodes++
		if nodes > 8192 {
			return ErrInvalidManifest
		}
		token, err := decoder.Token()
		if err != nil {
			return ErrInvalidManifest
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				key, ok := keyToken.(string)
				if err != nil || !ok {
					return ErrInvalidManifest
				}
				if _, exists := seen[key]; exists {
					return ErrDuplicateJSONKey
				}
				seen[key] = struct{}{}
				if err := consume(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return ErrInvalidManifest
			}
		case '[':
			for decoder.More() {
				if err := consume(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return ErrInvalidManifest
			}
		default:
			return ErrInvalidManifest
		}
		return nil
	}
	if err := consume(0); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidManifest
	}
	return nil
}
