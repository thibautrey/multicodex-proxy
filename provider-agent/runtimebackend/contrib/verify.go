package contrib

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

const (
	providerAgentModulePath  = "github.com/thibautrey/multivibe/provider-agent"
	runtimeBackendImportPath = providerAgentModulePath + "/runtimebackend"
	contribImportPath        = runtimeBackendImportPath + "/contrib"
	contractTestImportPath   = runtimeBackendImportPath + "/contracttest"
)

type verifyHook func(string) error

type rootedVerifier struct {
	path     string
	root     *os.Root
	identity os.FileInfo
}

type pathSnapshot struct {
	path string
	info os.FileInfo
}

// PinFile builds one manifest pin for an explicitly named review input. It
// never walks root or discovers contributions.
func PinFile(rootPath, relativePath string, role FileRole) (FilePin, error) {
	rooted, err := openRootedVerifier(rootPath)
	if err != nil {
		return FilePin{}, err
	}
	defer rooted.root.Close()
	pin, err := inspectPinnedFile(rooted, relativePath, role, nil, nil)
	if err != nil {
		return FilePin{}, err
	}
	if err := rooted.stable(); err != nil {
		return FilePin{}, err
	}
	return pin, nil
}

// VerifyPinnedFiles re-attests every named file, closes module-local imports,
// and closes every Go package tree containing adapter, native, or test source.
// Every regular file below those package directories must be pinned, because
// any neighboring data can become a go:embed input. The sole exception is
// ManifestPath: its bytes are compared semantically with manifest, avoiding an
// impossible self-hash.
func VerifyPinnedFiles(rootPath string, manifest Manifest) error {
	return verifyPinnedFiles(rootPath, manifest, nil)
}

func verifyPinnedFiles(rootPath string, manifest Manifest, hook verifyHook) error {
	if err := manifest.Validate(); err != nil {
		return err
	}
	rooted, err := openRootedVerifier(rootPath)
	if err != nil {
		return err
	}
	defer rooted.root.Close()
	for _, expected := range manifest.Files {
		actual, err := inspectPinnedFile(rooted, expected.Path, expected.Role, &expected, hook)
		if err != nil {
			return err
		}
		if actual.Mode != expected.Mode || actual.Size != expected.Size ||
			actual.SHA256 != expected.SHA256 || actual.Role != expected.Role {
			return fmt.Errorf("%w: %s", ErrPinnedFileMismatch, expected.Path)
		}
	}
	if err := verifyManifestSelf(rooted, manifest); err != nil {
		return err
	}
	if err := verifyGoImportClosure(rooted, manifest); err != nil {
		return err
	}
	if err := verifyClosedPackageTrees(rooted, manifest); err != nil {
		return err
	}
	// Re-read every pin and the self-describing manifest after package closure
	// so a replacement during enumeration cannot become the returned state.
	for _, expected := range manifest.Files {
		if _, err := inspectPinnedFile(rooted, expected.Path, expected.Role, &expected, nil); err != nil {
			return err
		}
	}
	if err := verifyManifestSelf(rooted, manifest); err != nil {
		return err
	}
	return rooted.stable()
}

func openRootedVerifier(rootPath string) (*rootedVerifier, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) || filepath.Clean(rootPath) != rootPath {
		return nil, ErrPinnedFileMismatch
	}
	before, err := os.Lstat(rootPath)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, ErrPinnedFileMismatch
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, ErrPinnedFileMismatch
	}
	rooted := &rootedVerifier{path: rootPath, root: root, identity: before}
	if err := rooted.stable(); err != nil {
		root.Close()
		return nil, err
	}
	return rooted, nil
}

func (rooted *rootedVerifier) stable() error {
	if rooted == nil || rooted.root == nil {
		return ErrPinnedFileMismatch
	}
	anchored, err := rooted.root.Stat(".")
	if err != nil || !anchored.IsDir() || !os.SameFile(rooted.identity, anchored) {
		return ErrPinnedFileMismatch
	}
	current, err := os.Lstat(rooted.path)
	if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(anchored, current) {
		return ErrPinnedFileMismatch
	}
	return nil
}

func inspectPinnedFile(rooted *rootedVerifier, relativePath string, role FileRole, expected *FilePin, hook verifyHook) (FilePin, error) {
	pin, _, err := inspectPinnedFileWithContents(rooted, relativePath, role, expected, hook, false)
	return pin, err
}

func inspectPinnedFileContents(rooted *rootedVerifier, expected FilePin) (FilePin, []byte, error) {
	return inspectPinnedFileWithContents(rooted, expected.Path, expected.Role, &expected, nil, true)
}

func inspectPinnedFileWithContents(
	rooted *rootedVerifier,
	relativePath string,
	role FileRole,
	expected *FilePin,
	hook verifyHook,
	capture bool,
) (FilePin, []byte, error) {
	if rooted == nil || !validRelativePath(relativePath) || !validFileRoleForPath(relativePath, role) {
		return FilePin{}, nil, ErrPinnedFileMismatch
	}
	parents, err := rooted.snapshotParents(relativePath)
	if err != nil {
		return FilePin{}, nil, err
	}
	before, err := rooted.root.Lstat(relativePath)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return FilePin{}, nil, mismatch(relativePath)
	}
	if hook != nil {
		if err := hook(filepath.Join(rooted.path, filepath.FromSlash(relativePath))); err != nil {
			return FilePin{}, nil, err
		}
	}
	file, err := rooted.root.Open(relativePath)
	if err != nil {
		return FilePin{}, nil, mismatch(relativePath)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return FilePin{}, nil, mismatch(relativePath)
	}
	mode := uint32(opened.Mode().Perm())
	if mode != 0o444 && mode != 0o644 {
		return FilePin{}, nil, mismatch(relativePath)
	}
	if opened.Size() <= 0 || opened.Size() > MaximumPinnedFileSize {
		return FilePin{}, nil, mismatch(relativePath)
	}
	hash := sha256.New()
	var contents bytes.Buffer
	reader := io.Reader(file)
	if capture {
		reader = io.TeeReader(reader, &contents)
	}
	written, err := io.Copy(hash, io.LimitReader(reader, MaximumPinnedFileSize+1))
	if err != nil || written != opened.Size() || written > MaximumPinnedFileSize {
		return FilePin{}, nil, mismatch(relativePath)
	}
	if err := rooted.verifyUnchanged(relativePath, opened, parents); err != nil {
		return FilePin{}, nil, err
	}
	digestBytes := hash.Sum(nil)
	digest := "sha256:" + hex.EncodeToString(digestBytes)
	if expected != nil {
		expectedBytes, decodeErr := hex.DecodeString(expected.SHA256[len("sha256:"):])
		if decodeErr != nil || subtle.ConstantTimeCompare(digestBytes, expectedBytes) != 1 {
			return FilePin{}, nil, mismatch(relativePath)
		}
	}
	return FilePin{Path: relativePath, Role: role, Mode: mode, Size: uint64(written), SHA256: digest}, contents.Bytes(), nil
}

func (rooted *rootedVerifier) snapshotParents(relativePath string) ([]pathSnapshot, error) {
	parent := path.Dir(relativePath)
	if parent == "." {
		return nil, nil
	}
	parts := strings.Split(parent, "/")
	current := ""
	snapshots := make([]pathSnapshot, 0, len(parts))
	for _, part := range parts {
		if current == "" {
			current = part
		} else {
			current += "/" + part
		}
		info, err := rooted.root.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, mismatch(current)
		}
		snapshots = append(snapshots, pathSnapshot{path: current, info: info})
	}
	return snapshots, nil
}

func (rooted *rootedVerifier) verifyUnchanged(relativePath string, opened os.FileInfo, parents []pathSnapshot) error {
	after, err := rooted.root.Lstat(relativePath)
	if err != nil || !after.Mode().IsRegular() || after.Mode()&os.ModeSymlink != 0 || !os.SameFile(opened, after) ||
		after.Size() != opened.Size() || !after.ModTime().Equal(opened.ModTime()) {
		return mismatch(relativePath)
	}
	for _, snapshot := range parents {
		current, err := rooted.root.Lstat(snapshot.path)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(snapshot.info, current) ||
			!current.ModTime().Equal(snapshot.info.ModTime()) {
			return mismatch(snapshot.path)
		}
	}
	return rooted.stable()
}

func verifyManifestSelf(rooted *rootedVerifier, manifest Manifest) error {
	parents, err := rooted.snapshotParents(manifest.ManifestPath)
	if err != nil {
		return err
	}
	before, err := rooted.root.Lstat(manifest.ManifestPath)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 ||
		(before.Mode().Perm() != 0o444 && before.Mode().Perm() != 0o644) || before.Size() <= 0 || before.Size() > MaximumManifestBytes {
		return mismatch(manifest.ManifestPath)
	}
	file, err := rooted.root.Open(manifest.ManifestPath)
	if err != nil {
		return mismatch(manifest.ManifestPath)
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, MaximumManifestBytes+1))
	opened, statErr := file.Stat()
	closeErr := file.Close()
	if readErr != nil || statErr != nil || closeErr != nil || len(raw) > MaximumManifestBytes || !os.SameFile(before, opened) {
		return mismatch(manifest.ManifestPath)
	}
	if err := rooted.verifyUnchanged(manifest.ManifestPath, opened, parents); err != nil {
		return err
	}
	parsed, err := ParseManifest(raw)
	if err != nil || !reflect.DeepEqual(parsed, manifest) {
		return mismatch(manifest.ManifestPath)
	}
	return nil
}

// verifyGoImportClosure parses every pinned Go file without evaluating build
// constraints. The trusted baseline is deliberately exact: production code
// may import only the public runtimebackend contract, while tests may also use
// contrib and contracttest. Any other provider-agent package must have pinned
// production Go source in its exact directory; all of its pinned Go files are
// parsed by this same pass and its complete tree is closed below.
func verifyGoImportClosure(rooted *rootedVerifier, manifest Manifest) error {
	pinnedSourcePackages := make(map[string]struct{})
	for _, file := range manifest.Files {
		if file.Role == FileRoleAdapterSource {
			pinnedSourcePackages[path.Dir(file.Path)] = struct{}{}
		}
	}

	for _, expected := range manifest.Files {
		if path.Ext(expected.Path) != ".go" {
			continue
		}
		actual, contents, err := inspectPinnedFileContents(rooted, expected)
		if err != nil || actual.Mode != expected.Mode || actual.Size != expected.Size ||
			actual.SHA256 != expected.SHA256 || actual.Role != expected.Role {
			return mismatch(expected.Path)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), expected.Path, contents, parser.ImportsOnly)
		if err != nil {
			return mismatch(expected.Path)
		}
		isTest := strings.HasSuffix(expected.Path, "_test.go")
		for _, specification := range parsed.Imports {
			importPath, err := strconv.Unquote(specification.Path.Value)
			if err != nil || importPath == "" || importPath == "C" || strings.Contains(importPath, "\\") ||
				path.Clean(importPath) != importPath || strings.HasPrefix(importPath, ".") || strings.HasPrefix(importPath, "/") {
				return mismatch(expected.Path)
			}
			if importPath == runtimeBackendImportPath {
				continue
			}
			if isTestOnlyRuntimeImport(importPath) {
				if !isTest {
					return mismatch(expected.Path)
				}
				if importPath == contribImportPath || importPath == contractTestImportPath {
					continue
				}
			}
			packageDirectory, local := localProviderPackageDirectory(importPath)
			if !local {
				continue
			}
			if packageDirectory == "" {
				return mismatch(expected.Path)
			}
			if _, pinned := pinnedSourcePackages[packageDirectory]; !pinned {
				return mismatch(expected.Path)
			}
		}
	}
	return rooted.stable()
}

func isTestOnlyRuntimeImport(importPath string) bool {
	return importPath == contribImportPath || strings.HasPrefix(importPath, contribImportPath+"/") ||
		importPath == contractTestImportPath || strings.HasPrefix(importPath, contractTestImportPath+"/")
}

func localProviderPackageDirectory(importPath string) (string, bool) {
	if importPath == providerAgentModulePath {
		return "", true
	}
	prefix := providerAgentModulePath + "/"
	if !strings.HasPrefix(importPath, prefix) {
		return "", false
	}
	relative := strings.TrimPrefix(importPath, prefix)
	if !validRelativePath(relative) || path.Clean(relative) != relative {
		return "", true
	}
	return "provider-agent/" + relative, true
}

func verifyClosedPackageTrees(rooted *rootedVerifier, manifest Manifest) error {
	pinned := make(map[string]struct{}, len(manifest.Files))
	packageSet := make(map[string]struct{})
	for _, file := range manifest.Files {
		pinned[file.Path] = struct{}{}
		if file.Role == FileRoleAdapterSource || file.Role == FileRoleNativeSource || file.Role == FileRoleContractTest {
			packageSet[path.Dir(file.Path)] = struct{}{}
		}
	}
	packages := make([]string, 0, len(packageSet))
	for packageDirectory := range packageSet {
		packages = append(packages, packageDirectory)
	}
	sort.Strings(packages)
	for _, packageDirectory := range packages {
		if err := verifyClosedPackageTree(rooted, packageDirectory, manifest.ManifestPath, pinned); err != nil {
			return err
		}
	}
	return nil
}

func verifyClosedPackageTree(rooted *rootedVerifier, packageDirectory, manifestPath string, pinned map[string]struct{}) error {
	directories := make(map[string]os.FileInfo)
	err := fs.WalkDir(rooted.root.FS(), packageDirectory, func(relativePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrPinnedFileMismatch
		}
		info, err := rooted.root.Lstat(relativePath)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return mismatch(relativePath)
		}
		if entry.IsDir() {
			if !info.IsDir() {
				return mismatch(relativePath)
			}
			directories[relativePath] = info
			return nil
		}
		if !info.Mode().IsRegular() {
			return mismatch(relativePath)
		}
		if relativePath == manifestPath {
			return nil
		}
		if _, found := pinned[relativePath]; !found {
			return mismatch(relativePath)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for relativePath, before := range directories {
		after, err := rooted.root.Lstat(relativePath)
		if err != nil || !after.IsDir() || after.Mode()&os.ModeSymlink != 0 || !os.SameFile(before, after) ||
			!after.ModTime().Equal(before.ModTime()) {
			return mismatch(relativePath)
		}
	}
	return rooted.stable()
}

func mismatch(relativePath string) error {
	return fmt.Errorf("%w: %s", ErrPinnedFileMismatch, relativePath)
}
