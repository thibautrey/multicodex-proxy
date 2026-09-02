package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const (
	managedOllamaVersion                    = "0.33.2"
	managedOllamaRuntimeSchemaVersion       = "managed-ollama-runtime-v2"
	managedOllamaModelsSchemaVersion        = "managed-ollama-models-v1"
	managedOllamaDependencyManifestMaxBytes = 64 * 1024
	managedOllamaModelManifestMaxBytes      = 4 * 1024 * 1024
	managedOllamaArchiveMaxBytes            = int64(4 * 1024 * 1024 * 1024)
	managedOllamaCommandOutputMaxBytes      = int64(8 * 1024 * 1024)
	managedOllamaMaximumArchiveEntries      = 100_000
	managedOllamaMaximumModels              = 10_000
	managedOllamaMaximumManifestLayers      = 128
	managedOllamaMaximumRedirects           = 3
	managedOllamaDefaultStartupTimeout      = 15 * time.Second
	managedOllamaDefaultShutdownTimeout     = 10 * time.Second
	managedOllamaDefaultKillTimeout         = 3 * time.Second
	managedOllamaDefaultInstallTimeout      = 2 * time.Hour
	managedOllamaDefaultPullTimeout         = 2 * time.Hour
	managedOllamaDefaultListenAddress       = "127.0.0.1:11434"
)

var (
	errManagedOllamaPolicyRequired    = errors.New("managed Ollama requires an explicit capacity policy")
	errManagedOllamaPaused            = errors.New("managed Ollama is paused by local policy")
	errManagedOllamaDownloadsDisabled = errors.New("managed Ollama automatic downloads are disabled")
	errManagedOllamaRuntimeMissing    = errors.New("managed Ollama runtime is not installed")
	errManagedOllamaBundleUnavailable = errors.New("managed Ollama bundled runtime is unavailable")
)

type managedOllamaDependencyArtifact struct {
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Archive string `json:"archive"`
}

type managedOllamaDependency struct {
	Version   string                                     `json:"version"`
	Artifacts map[string]managedOllamaDependencyArtifact `json:"artifacts"`
}

// The dependency manifest also contains the packaged Node dependency. This
// component deliberately treats it as opaque while still rejecting unknown
// top-level fields and duplicate JSON keys.
type managedOllamaDependencyManifest struct {
	SchemaVersion uint64                  `json:"schemaVersion"`
	Node          json.RawMessage         `json:"node"`
	Ollama        managedOllamaDependency `json:"ollama"`
}

type managedOllamaRuntimeRecord struct {
	SchemaVersion string `json:"schema_version"`
	Version       string `json:"version"`
	Platform      string `json:"platform"`
	ArchiveSHA256 string `json:"archive_sha256"`
	TreeSHA256    string `json:"tree_sha256"`
}

type managedOllamaBundleRecord struct {
	SchemaVersion string `json:"schema_version"`
	Version       string `json:"version"`
	Platform      string `json:"platform"`
	ArchiveSHA256 string `json:"archive_sha256"`
}

type managedOllamaModelRecord struct {
	CanonicalModelID   string `json:"canonical_model_id"`
	OllamaModel        string `json:"ollama_model"`
	OllamaManifestPath string `json:"ollama_manifest_path"`
	ManifestSHA256     string `json:"manifest_sha256"`
}

type managedOllamaManifestBlob struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      uint64 `json:"size"`
}

type managedOllamaModelManifest struct {
	SchemaVersion uint64                      `json:"schemaVersion"`
	MediaType     string                      `json:"mediaType"`
	Config        managedOllamaManifestBlob   `json:"config"`
	Layers        []managedOllamaManifestBlob `json:"layers"`
}

type managedOllamaModelState struct {
	SchemaVersion    string                     `json:"schema_version"`
	RuntimeVersion   string                     `json:"runtime_version"`
	ModelStoragePath string                     `json:"model_storage_path"`
	Models           []managedOllamaModelRecord `json:"models"`
}

type managedOllamaStatus struct {
	SchemaVersion     string   `json:"schema_version"`
	State             string   `json:"state"`
	Version           string   `json:"version"`
	Platform          string   `json:"platform"`
	RuntimeInstalled  bool     `json:"runtime_installed"`
	Running           bool     `json:"running"`
	Paused            bool     `json:"paused"`
	InstalledModelIDs []string `json:"installed_model_ids"`
}

type managedOllamaProcess interface {
	Wait() error
	Signal(os.Signal) error
	Kill() error
}

type managedOllamaCommands interface {
	Run(context.Context, string, []string, []string, string, int64) ([]byte, error)
	Start(string, []string, []string, string, io.Writer, io.Writer) (managedOllamaProcess, error)
}

type execManagedOllamaCommands struct{}

type execManagedOllamaProcess struct {
	command *exec.Cmd
}

func (execManagedOllamaCommands) Run(ctx context.Context, path string, arguments, environment []string, directory string, outputLimit int64) ([]byte, error) {
	command := exec.CommandContext(ctx, path, arguments...)
	command.Env = append([]string{}, environment...)
	command.Dir = directory
	stdout := newManagedOllamaBoundedBuffer(outputLimit)
	stderr := newManagedOllamaBoundedBuffer(outputLimit)
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if stdout.overflowed() || stderr.overflowed() {
		return nil, errors.New("managed Ollama command output exceeded its bound")
	}
	if err != nil {
		return nil, errors.New("managed Ollama command failed")
	}
	return stdout.bytes(), nil
}

func (execManagedOllamaCommands) Start(path string, arguments, environment []string, directory string, stdout, stderr io.Writer) (managedOllamaProcess, error) {
	command := exec.Command(path, arguments...)
	command.Env = append([]string{}, environment...)
	command.Dir = directory
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	return &execManagedOllamaProcess{command: command}, nil
}

func (process *execManagedOllamaProcess) Wait() error {
	return process.command.Wait()
}

func (process *execManagedOllamaProcess) Signal(signal os.Signal) error {
	return process.command.Process.Signal(signal)
}

func (process *execManagedOllamaProcess) Kill() error {
	return process.command.Process.Kill()
}

type managedOllamaBoundedBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	limit    int64
	overflow bool
}

func newManagedOllamaBoundedBuffer(limit int64) *managedOllamaBoundedBuffer {
	return &managedOllamaBoundedBuffer{limit: limit}
}

type managedOllamaContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader managedOllamaContextReader) Read(buffer []byte) (int, error) {
	select {
	case <-reader.ctx.Done():
		return 0, reader.ctx.Err()
	default:
		return reader.reader.Read(buffer)
	}
}

func (buffer *managedOllamaBoundedBuffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	remaining := buffer.limit - int64(buffer.buffer.Len())
	if remaining > 0 {
		writeLength := int64(len(value))
		if writeLength > remaining {
			writeLength = remaining
		}
		_, _ = buffer.buffer.Write(value[:writeLength])
	}
	if int64(len(value)) > remaining {
		buffer.overflow = true
	}
	return len(value), nil
}

func (buffer *managedOllamaBoundedBuffer) overflowed() bool {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.overflow
}

func (buffer *managedOllamaBoundedBuffer) bytes() []byte {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return append([]byte{}, buffer.buffer.Bytes()...)
}

type managedOllamaConfig struct {
	ManagedRoot        string
	BundledRuntimeRoot string
	ListenAddress      string
	CUDAVisibleDevices string
	GOOS               string
	GOARCH             string
	TarPath            string
	HTTPTransport      http.RoundTripper
	Commands           managedOllamaCommands
	StartupTimeout     time.Duration
	ShutdownTimeout    time.Duration
	KillTimeout        time.Duration
}

type managedOllama struct {
	mu                 sync.Mutex
	installMu          sync.Mutex
	pullMu             sync.Mutex
	lifecycleMu        sync.Mutex
	root               string
	bundledRuntimeRoot string
	listenAddress      string
	loopbackOrigin     string
	cudaVisibleDevices string
	goos               string
	goarch             string
	platform           string
	tarPath            string
	httpClient         *http.Client
	commands           managedOllamaCommands
	startupTimeout     time.Duration
	shutdownTimeout    time.Duration
	killTimeout        time.Duration
	process            managedOllamaProcess
	processDone        chan error
	state              string
	policyObserved     bool
	policyRevision     uint64
	policyFingerprint  [sha256.Size]byte
	policyPaused       bool
	policyDownloads    bool
	installCancel      context.CancelFunc
	pullCancel         context.CancelFunc
}

func newManagedOllama(config managedOllamaConfig) (*managedOllama, error) {
	if config.GOOS == "" {
		config.GOOS = runtime.GOOS
	}
	if config.GOARCH == "" {
		config.GOARCH = runtime.GOARCH
	}
	platform, err := managedOllamaPlatform(config.GOOS, config.GOARCH)
	if err != nil {
		return nil, err
	}
	if !validModelStoragePath(config.ManagedRoot) {
		return nil, errors.New("managed Ollama root must be a clean absolute non-root path")
	}
	if err := ensureManagedOllamaDirectory(config.ManagedRoot, true); err != nil {
		return nil, err
	}
	if config.BundledRuntimeRoot != "" && (!filepath.IsAbs(config.BundledRuntimeRoot) || filepath.Clean(config.BundledRuntimeRoot) != config.BundledRuntimeRoot ||
		!validModelStoragePath(config.BundledRuntimeRoot)) {
		return nil, errors.New("managed Ollama bundled runtime root must be a clean absolute non-root path")
	}
	if config.ListenAddress == "" {
		config.ListenAddress = managedOllamaDefaultListenAddress
	}
	listenAddress, loopbackOrigin, err := validateManagedOllamaListenAddress(config.ListenAddress)
	if err != nil {
		return nil, err
	}
	if err := validateManagedOllamaCUDAVisibleDevices(config.GOOS, config.CUDAVisibleDevices); err != nil {
		return nil, err
	}
	tarPath, err := resolveManagedOllamaTar(config.GOOS, config.TarPath)
	if err != nil {
		return nil, err
	}
	if config.Commands == nil {
		config.Commands = execManagedOllamaCommands{}
	}
	if config.HTTPTransport == nil {
		config.HTTPTransport = http.DefaultTransport
	}
	if config.StartupTimeout <= 0 {
		config.StartupTimeout = managedOllamaDefaultStartupTimeout
	}
	if config.ShutdownTimeout <= 0 {
		config.ShutdownTimeout = managedOllamaDefaultShutdownTimeout
	}
	if config.KillTimeout <= 0 {
		config.KillTimeout = managedOllamaDefaultKillTimeout
	}
	manager := &managedOllama{
		root: config.ManagedRoot, bundledRuntimeRoot: config.BundledRuntimeRoot,
		listenAddress: listenAddress, loopbackOrigin: loopbackOrigin, cudaVisibleDevices: config.CUDAVisibleDevices,
		goos: config.GOOS, goarch: config.GOARCH, platform: platform,
		tarPath: tarPath, commands: config.Commands, startupTimeout: config.StartupTimeout,
		shutdownTimeout: config.ShutdownTimeout, killTimeout: config.KillTimeout, state: "stopped",
	}
	manager.httpClient = &http.Client{
		Transport: config.HTTPTransport,
		CheckRedirect: func(request *http.Request, previous []*http.Request) error {
			if len(previous) > managedOllamaMaximumRedirects {
				return errors.New("managed Ollama dependency redirect limit exceeded")
			}
			if !allowedManagedOllamaDownloadURL(request.URL, false) {
				return errors.New("managed Ollama dependency redirect is not allowlisted")
			}
			request.Header.Del("Range")
			request.Header.Del("Authorization")
			request.Header.Del("Cookie")
			return nil
		},
	}
	return manager, nil
}

func validateManagedOllamaListenAddress(raw string) (string, string, error) {
	host, portText, err := net.SplitHostPort(raw)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		return "", "", errors.New("managed Ollama listen address must use literal loopback")
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 || strconv.FormatUint(port, 10) != portText {
		return "", "", errors.New("managed Ollama listen port is invalid")
	}
	address := net.JoinHostPort(host, portText)
	origin := (&url.URL{Scheme: "http", Host: address}).String()
	return address, origin, nil
}

func validateManagedOllamaCUDAVisibleDevices(goos, value string) error {
	if value == "" {
		return nil
	}
	if goos != "linux" {
		return errors.New("managed Ollama CUDA device pin is invalid")
	}
	if _, err := parseNVIDIACUDADevicePin(value); err != nil {
		return errors.New("managed Ollama CUDA device pin is invalid")
	}
	return nil
}

func managedOllamaPlatform(goos, goarch string) (string, error) {
	if goos == "darwin" && goarch == "arm64" {
		return "darwin-arm64", nil
	}
	if goos == "linux" && goarch == "amd64" {
		return "linux-amd64", nil
	}
	return "", errors.New("managed Ollama supports only darwin/arm64 and linux/amd64")
}

func resolveManagedOllamaTar(goos, configured string) (string, error) {
	allowlist := []string{"/usr/bin/tar"}
	if goos == "linux" {
		allowlist = append(allowlist, "/bin/tar")
	}
	if configured != "" {
		for _, candidate := range allowlist {
			if configured == candidate {
				return configured, nil
			}
		}
		return "", errors.New("managed Ollama tar path is not allowlisted")
	}
	for _, candidate := range allowlist {
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", errors.New("managed Ollama requires tar at an allowlisted absolute path")
}

func openManagedOllamaDependencyManifest(path string) (managedOllamaDependencyManifest, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return managedOllamaDependencyManifest{}, errors.New("managed Ollama dependency manifest path must be clean and absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > managedOllamaDependencyManifestMaxBytes {
		return managedOllamaDependencyManifest{}, errors.New("managed Ollama dependency manifest must be a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return managedOllamaDependencyManifest{}, errors.New("managed Ollama dependency manifest cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, managedOllamaDependencyManifestMaxBytes+1))
	if err != nil || len(raw) > managedOllamaDependencyManifestMaxBytes || validateUniqueJSONKeys(raw) != nil {
		return managedOllamaDependencyManifest{}, errors.New("managed Ollama dependency manifest is invalid")
	}
	var document managedOllamaDependencyManifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || validateManagedOllamaDependencyManifest(document) != nil {
		return managedOllamaDependencyManifest{}, errors.New("managed Ollama dependency manifest is invalid")
	}
	return document, nil
}

func validateManagedOllamaDependencyManifest(document managedOllamaDependencyManifest) error {
	if document.SchemaVersion != 1 || len(document.Node) == 0 || document.Ollama.Version != managedOllamaVersion || len(document.Ollama.Artifacts) != 2 {
		return errors.New("managed Ollama dependency manifest is invalid")
	}
	expectedArchive := map[string]string{"darwin-arm64": "tar-gzip", "linux-amd64": "tar-zstd"}
	expectedFilename := map[string]string{"darwin-arm64": "ollama-darwin.tgz", "linux-amd64": "ollama-linux-amd64.tar.zst"}
	for platform, archive := range expectedArchive {
		artifact, exists := document.Ollama.Artifacts[platform]
		if !exists || artifact.Archive != archive || !validManagedOllamaSHA256(artifact.SHA256) {
			return errors.New("managed Ollama dependency artifact is invalid")
		}
		parsed, err := url.Parse(artifact.URL)
		if err != nil || !allowedManagedOllamaDownloadURL(parsed, true) || filepath.Base(parsed.Path) != expectedFilename[platform] ||
			!strings.Contains(parsed.Path, "/releases/download/v"+managedOllamaVersion+"/") {
			return errors.New("managed Ollama dependency artifact is invalid")
		}
	}
	return nil
}

func validManagedOllamaSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func allowedManagedOllamaDownloadURL(parsed *url.URL, initial bool) bool {
	if parsed == nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.Port() != "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if initial {
		return parsed.RawQuery == "" && host == "github.com" && strings.HasPrefix(parsed.EscapedPath(), "/ollama/ollama/releases/download/")
	}
	return (host == "github.com" && parsed.RawQuery == "") || host == "release-assets.githubusercontent.com"
}

func (manager *managedOllama) ensureRuntime(ctx context.Context, policyState *capacityPolicyStateDocument, dependencyManifestPath string) (managedOllamaStatus, error) {
	manifest, err := openManagedOllamaDependencyManifest(dependencyManifestPath)
	if err != nil {
		return manager.status(policyState), err
	}
	return manager.ensureRuntimePinned(ctx, policyState, manifest)
}

func (manager *managedOllama) ensureRuntimePinned(ctx context.Context, policyState *capacityPolicyStateDocument, manifest managedOllamaDependencyManifest) (managedOllamaStatus, error) {
	if validateManagedOllamaDependencyManifest(manifest) != nil {
		return manager.status(policyState), errors.New("managed Ollama dependency manifest is invalid")
	}
	return manager.ensureRuntimeWithManifest(ctx, policyState, manifest)
}

func (manager *managedOllama) ensureRuntimeWithManifest(ctx context.Context, policyState *capacityPolicyStateDocument, manifest managedOllamaDependencyManifest) (managedOllamaStatus, error) {
	manager.installMu.Lock()
	defer manager.installMu.Unlock()
	installContext, cancel := managedOllamaBoundContext(ctx, managedOllamaDefaultInstallTimeout)
	manager.mu.Lock()
	manager.installCancel = cancel
	manager.mu.Unlock()
	defer func() {
		cancel()
		manager.mu.Lock()
		manager.installCancel = nil
		manager.mu.Unlock()
	}()
	if _, err := manager.authorizePolicy(policyState, true); err != nil {
		return manager.status(policyState), err
	}
	artifact := manifest.Ollama.Artifacts[manager.platform]
	if _, record, err := manager.installedRuntime(); err == nil {
		if record.ArchiveSHA256 != artifact.SHA256 {
			return manager.status(policyState), errors.New("managed Ollama installed runtime does not match the pinned dependency")
		}
		return manager.status(policyState), nil
	} else if !errors.Is(err, errManagedOllamaRuntimeMissing) {
		return manager.status(policyState), err
	}
	if err := manager.ensureLayout(); err != nil {
		return manager.status(policyState), err
	}
	if manager.bundledRuntimeRoot != "" {
		if err := manager.adoptBundledRuntime(installContext, policyState, artifact); err == nil {
			return manager.status(policyState), nil
		} else if !errors.Is(err, errManagedOllamaBundleUnavailable) {
			return manager.status(policyState), err
		}
	}
	archivePath, err := manager.downloadDependency(installContext, artifact)
	if err != nil {
		return manager.status(policyState), err
	}
	defer os.Remove(archivePath)
	if _, err := manager.authorizePolicy(policyState, true); err != nil {
		return manager.status(policyState), err
	}
	if err := manager.extractRuntime(installContext, policyState, archivePath, artifact); err != nil {
		return manager.status(policyState), err
	}
	return manager.status(policyState), nil
}

func (manager *managedOllama) adoptBundledRuntime(ctx context.Context, policyState *capacityPolicyStateDocument, artifact managedOllamaDependencyArtifact) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sourceInfo, err := os.Lstat(manager.bundledRuntimeRoot)
	if errors.Is(err, os.ErrNotExist) {
		return errManagedOllamaBundleUnavailable
	}
	if err != nil || !sourceInfo.IsDir() || sourceInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed Ollama bundled runtime root is unsafe")
	}
	record, err := openManagedOllamaBundleRecord(manager.bundledRuntimeRoot)
	if err != nil || record.SchemaVersion != "managed-ollama-bundle-v1" || record.Version != managedOllamaVersion ||
		record.Platform != manager.platform || record.ArchiveSHA256 != artifact.SHA256 {
		return errors.New("managed Ollama bundled runtime attestation is invalid")
	}
	if err := validateManagedOllamaExtractedTree(manager.bundledRuntimeRoot); err != nil {
		return errors.New("managed Ollama bundled runtime tree is unsafe")
	}
	if err := validateManagedOllamaBinary(filepath.Join(manager.bundledRuntimeRoot, managedOllamaBinaryRelativePath(manager.platform))); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Join(manager.root, "runtime"), ".ollama-adoption-*")
	if err != nil {
		return errors.New("managed Ollama adoption staging cannot be created")
	}
	defer os.RemoveAll(staging)
	if err := os.Chmod(staging, 0o700); err != nil {
		return errors.New("managed Ollama adoption staging cannot be secured")
	}
	if err := copyManagedOllamaTree(ctx, manager.bundledRuntimeRoot, staging); err != nil {
		return err
	}
	if err := validateManagedOllamaExtractedTree(staging); err != nil {
		return errors.New("managed Ollama adopted runtime tree is unsafe")
	}
	binaryPath := filepath.Join(staging, managedOllamaBinaryRelativePath(manager.platform))
	if err := validateManagedOllamaBinary(binaryPath); err != nil {
		return err
	}
	if err := os.Chmod(binaryPath, 0o755); err != nil {
		return errors.New("managed Ollama adopted runtime binary cannot be made executable")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := manager.lockAuthorizedPolicy(policyState, true); err != nil {
		return err
	}
	defer manager.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return manager.commitStagedRuntime(staging, artifact.SHA256)
}

func openManagedOllamaBundleRecord(root string) (managedOllamaBundleRecord, error) {
	path := filepath.Join(root, ".multivibe-bundle.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 4096 {
		return managedOllamaBundleRecord{}, errors.New("managed Ollama bundled runtime attestation is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return managedOllamaBundleRecord{}, errors.New("managed Ollama bundled runtime attestation cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(raw) > 4096 || validateUniqueJSONKeys(raw) != nil {
		return managedOllamaBundleRecord{}, errors.New("managed Ollama bundled runtime attestation is invalid")
	}
	var record managedOllamaBundleRecord
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&record) != nil || ensureJSONEOF(decoder) != nil {
		return managedOllamaBundleRecord{}, errors.New("managed Ollama bundled runtime attestation is invalid")
	}
	return record, nil
}

func copyManagedOllamaTree(ctx context.Context, source, destination string) error {
	var totalBytes int64
	entries := 0
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if path == source {
			return nil
		}
		entries++
		if entries > managedOllamaMaximumArchiveEntries {
			return errors.New("managed Ollama bundled runtime has too many entries")
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || !safeManagedOllamaArchivePath(filepath.ToSlash(relative)) {
			return errors.New("managed Ollama bundled runtime path is unsafe")
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case info.IsDir():
			return os.Mkdir(target, info.Mode().Perm()&0o755)
		case info.Mode().IsRegular():
			if info.Size() < 0 || totalBytes > managedOllamaArchiveMaxBytes-info.Size() {
				return errors.New("managed Ollama bundled runtime exceeds its size bound")
			}
			totalBytes += info.Size()
			return copyManagedOllamaFile(ctx, path, target, info.Mode().Perm())
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil || filepath.IsAbs(link) || strings.ContainsRune(link, '\x00') {
				return errors.New("managed Ollama bundled runtime symlink is unsafe")
			}
			return os.Symlink(link, target)
		default:
			return errors.New("managed Ollama bundled runtime contains an unsupported file type")
		}
	})
	if err != nil {
		return errors.New("managed Ollama bundled runtime cannot be copied safely")
	}
	return nil
}

func copyManagedOllamaFile(ctx context.Context, source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode&0o755)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = output.Close()
		if !ok {
			_ = os.Remove(destination)
		}
	}()
	if _, err := io.Copy(output, managedOllamaContextReader{ctx: ctx, reader: input}); err != nil || output.Sync() != nil || output.Close() != nil {
		return errors.New("managed Ollama bundled runtime file cannot be copied")
	}
	ok = true
	return nil
}

// lockAuthorizedPolicy validates the exact policy document, observes its
// monotonic revision, and returns with manager.mu held on success. Holding that
// lock across a final filesystem commit gives policy enforcement a real
// linearization point: either the commit precedes a newer policy revision or
// that revision is observed and the commit is rejected.
func (manager *managedOllama) lockAuthorizedPolicy(document *capacityPolicyStateDocument, needsDownload bool) (capacityPolicy, error) {
	if document == nil || validateCapacityPolicyState(*document) != nil {
		return capacityPolicy{}, errManagedOllamaPolicyRequired
	}
	policy, err := validateCapacityPolicy(document.Policy)
	if err != nil {
		return capacityPolicy{}, errManagedOllamaPolicyRequired
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return capacityPolicy{}, errManagedOllamaPolicyRequired
	}
	fingerprint := sha256.Sum256(encoded)
	manager.mu.Lock()
	if manager.policyObserved {
		if document.Revision < manager.policyRevision || (document.Revision == manager.policyRevision && fingerprint != manager.policyFingerprint) {
			manager.mu.Unlock()
			return capacityPolicy{}, errors.New("managed Ollama capacity policy revision is stale or conflicting")
		}
	}
	if !manager.policyObserved || document.Revision > manager.policyRevision {
		manager.policyObserved = true
		manager.policyRevision = document.Revision
		manager.policyFingerprint = fingerprint
		manager.policyPaused = *document.Paused
		manager.policyDownloads = *document.AutomaticDownloads
	}
	paused := manager.policyPaused
	downloads := manager.policyDownloads
	if paused {
		manager.mu.Unlock()
		return capacityPolicy{}, errManagedOllamaPaused
	}
	if needsDownload && !downloads {
		manager.mu.Unlock()
		return capacityPolicy{}, errManagedOllamaDownloadsDisabled
	}
	return policy, nil
}

func (manager *managedOllama) authorizePolicy(document *capacityPolicyStateDocument, needsDownload bool) (capacityPolicy, error) {
	policy, err := manager.lockAuthorizedPolicy(document, needsDownload)
	if err != nil {
		return capacityPolicy{}, err
	}
	manager.mu.Unlock()
	return policy, nil
}

func managedOllamaBoundContext(parent context.Context, maximum time.Duration) (context.Context, context.CancelFunc) {
	if deadline, ok := parent.Deadline(); ok && time.Until(deadline) <= maximum {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, maximum)
}

func (manager *managedOllama) ensureLayout() error {
	for _, relative := range []string{"downloads", "home", "logs", "runtime", "state", "tmp"} {
		if err := ensureManagedOllamaDirectory(filepath.Join(manager.root, relative), true); err != nil {
			return err
		}
	}
	return nil
}

func ensureManagedOllamaDirectory(path string, private bool) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return errors.New("managed Ollama directory cannot be created")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed Ollama directory is unsafe")
	}
	if private && info.Mode().Perm() != 0o700 {
		return errors.New("managed Ollama directory must use mode 0700")
	}
	return nil
}

func ensureManagedOllamaModelStorage(path string) error {
	if !validModelStoragePath(path) {
		return errors.New("managed Ollama model storage path is invalid")
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return errors.New("managed Ollama model storage cannot be created")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 || !managedOllamaOwnedByCurrentUser(info) {
		return errors.New("managed Ollama model storage is unsafe")
	}
	return nil
}

func (manager *managedOllama) downloadDependency(ctx context.Context, artifact managedOllamaDependencyArtifact) (string, error) {
	parsed, err := url.Parse(artifact.URL)
	if err != nil || !allowedManagedOllamaDownloadURL(parsed, true) {
		return "", errors.New("managed Ollama dependency URL is invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", errors.New("managed Ollama dependency request cannot be created")
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "multivibe-provider-agent/"+providerAgentVersion)
	response, err := manager.httpClient.Do(request)
	if err != nil {
		return "", errors.New("managed Ollama dependency download failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Range") != "" || response.ContentLength > managedOllamaArchiveMaxBytes {
		return "", errors.New("managed Ollama dependency response is invalid")
	}
	temporary, err := os.CreateTemp(filepath.Join(manager.root, "downloads"), ".ollama-archive-*.tmp")
	if err != nil {
		return "", errors.New("managed Ollama dependency temporary file cannot be created")
	}
	temporaryPath := temporary.Name()
	keep := false
	defer func() {
		_ = temporary.Close()
		if !keep {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return "", errors.New("managed Ollama dependency temporary file cannot be secured")
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, managedOllamaArchiveMaxBytes+1))
	if err != nil || written < 1 || written > managedOllamaArchiveMaxBytes || (response.ContentLength >= 0 && response.ContentLength != written) {
		return "", errors.New("managed Ollama dependency download is incomplete or oversized")
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return "", errors.New("managed Ollama dependency checksum mismatch")
	}
	if err := temporary.Sync(); err != nil || temporary.Close() != nil {
		return "", errors.New("managed Ollama dependency temporary file cannot be committed")
	}
	keep = true
	return temporaryPath, nil
}

func (manager *managedOllama) extractRuntime(ctx context.Context, policyState *capacityPolicyStateDocument, archivePath string, artifact managedOllamaDependencyArtifact) error {
	runtimeParent := filepath.Join(manager.root, "runtime")
	staging, err := os.MkdirTemp(runtimeParent, ".ollama-staging-*")
	if err != nil {
		return errors.New("managed Ollama staging directory cannot be created")
	}
	if err := os.Chmod(staging, 0o700); err != nil {
		_ = os.RemoveAll(staging)
		return errors.New("managed Ollama staging directory cannot be secured")
	}
	removeStaging := true
	defer func() {
		if removeStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	listArguments, extractArguments, err := managedOllamaTarArguments(manager.platform, archivePath, staging)
	if err != nil {
		return err
	}
	listing, err := manager.commands.Run(ctx, manager.tarPath, listArguments, manager.commandEnvironment(filepath.Join(manager.root, "models-unused")), manager.root, managedOllamaCommandOutputMaxBytes)
	if err != nil || validateManagedOllamaArchiveListing(listing) != nil {
		return errors.New("managed Ollama archive listing is unsafe")
	}
	if _, err := manager.commands.Run(ctx, manager.tarPath, extractArguments, manager.commandEnvironment(filepath.Join(manager.root, "models-unused")), manager.root, managedOllamaCommandOutputMaxBytes); err != nil {
		return errors.New("managed Ollama archive extraction failed")
	}
	if err := validateManagedOllamaExtractedTree(staging); err != nil {
		return err
	}
	binaryPath := filepath.Join(staging, managedOllamaBinaryRelativePath(manager.platform))
	if err := validateManagedOllamaBinary(binaryPath); err != nil {
		return err
	}
	if err := os.Chmod(binaryPath, 0o755); err != nil {
		return errors.New("managed Ollama runtime binary cannot be made executable")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := manager.lockAuthorizedPolicy(policyState, true); err != nil {
		return err
	}
	defer manager.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := manager.commitStagedRuntime(staging, artifact.SHA256); err != nil {
		return err
	}
	removeStaging = false
	return nil
}

func (manager *managedOllama) commitStagedRuntime(staging, archiveSHA256 string) error {
	treeSHA256, err := managedOllamaRuntimeTreeSHA256(staging)
	if err != nil {
		return errors.New("managed Ollama runtime tree attestation failed")
	}
	record := managedOllamaRuntimeRecord{
		SchemaVersion: managedOllamaRuntimeSchemaVersion,
		Version:       managedOllamaVersion, Platform: manager.platform, ArchiveSHA256: archiveSHA256, TreeSHA256: treeSHA256,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return errors.New("managed Ollama runtime record cannot be encoded")
	}
	recordPath := filepath.Join(staging, ".multivibe-runtime.json")
	if _, err := os.Lstat(recordPath); err == nil || !errors.Is(err, os.ErrNotExist) {
		return errors.New("managed Ollama runtime collides with managed state")
	}
	if err := os.WriteFile(recordPath, append(encoded, '\n'), 0o600); err != nil || os.Chmod(recordPath, 0o600) != nil {
		return errors.New("managed Ollama runtime record cannot be persisted")
	}
	destination := manager.runtimeDirectory()
	if _, err := os.Lstat(destination); err == nil {
		if _, installed, validationErr := manager.installedRuntime(); validationErr != nil {
			return validationErr
		} else if installed.ArchiveSHA256 != archiveSHA256 {
			return errors.New("managed Ollama installed runtime does not match the pinned dependency")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("managed Ollama runtime destination cannot be inspected")
	}
	if err := os.Rename(staging, destination); err != nil {
		return errors.New("managed Ollama runtime cannot be atomically installed")
	}
	if _, installed, err := manager.installedRuntime(); err != nil || installed.ArchiveSHA256 != archiveSHA256 {
		return errors.New("managed Ollama committed runtime failed attestation")
	}
	return nil
}

func managedOllamaTarArguments(platform, archivePath, staging string) ([]string, []string, error) {
	switch platform {
	case "darwin-arm64":
		return []string{"-tzf", archivePath}, []string{"-xzf", archivePath, "-C", staging, "--no-same-owner"}, nil
	case "linux-amd64":
		return []string{"--zstd", "-tf", archivePath}, []string{"--zstd", "-xf", archivePath, "-C", staging, "--no-same-owner"}, nil
	default:
		return nil, nil, errors.New("managed Ollama archive platform is unsupported")
	}
}

func validateManagedOllamaArchiveListing(listing []byte) error {
	if len(listing) == 0 || int64(len(listing)) > managedOllamaCommandOutputMaxBytes || bytes.IndexByte(listing, 0) >= 0 {
		return errors.New("managed Ollama archive listing is invalid")
	}
	lines := bytes.Split(listing, []byte{'\n'})
	if len(lines) > managedOllamaMaximumArchiveEntries+1 {
		return errors.New("managed Ollama archive has too many entries")
	}
	entries := 0
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		entries++
		if !safeManagedOllamaArchivePath(string(line)) {
			return errors.New("managed Ollama archive contains an unsafe path")
		}
	}
	if entries == 0 {
		return errors.New("managed Ollama archive is empty")
	}
	return nil
}

func safeManagedOllamaArchivePath(value string) bool {
	if value == "" || len(value) > 4096 || strings.Contains(value, "\\") || strings.HasPrefix(value, "/") || strings.Contains(value, "\r") {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	trimmed := strings.TrimSuffix(value, "/")
	for strings.HasPrefix(trimmed, "./") {
		trimmed = strings.TrimPrefix(trimmed, "./")
	}
	if trimmed == "" || trimmed == "." {
		return value == "./" || value == "."
	}
	cleaned := filepath.Clean(filepath.FromSlash(trimmed))
	return cleaned == filepath.FromSlash(trimmed) && cleaned != ".." && !strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) && !filepath.IsAbs(cleaned)
}

func validateManagedOllamaExtractedTree(root string) error {
	entries := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > managedOllamaMaximumArchiveEntries {
			return errors.New("managed Ollama extracted tree has too many entries")
		}
		if path == root {
			return nil
		}
		if !managedOllamaPathWithin(root, path) {
			return errors.New("managed Ollama extracted path escaped staging")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		if mode.IsRegular() || mode.IsDir() {
			return nil
		}
		if mode&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil || filepath.IsAbs(target) || strings.ContainsRune(target, '\x00') {
				return errors.New("managed Ollama archive contains an unsafe symlink")
			}
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil || !managedOllamaPathWithin(root, resolved) {
				return errors.New("managed Ollama archive symlink escapes staging")
			}
			return nil
		}
		return errors.New("managed Ollama archive contains an unsupported file type")
	})
	if err != nil {
		return errors.New("managed Ollama extracted tree is unsafe")
	}
	return nil
}

func managedOllamaPathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func managedOllamaBinaryRelativePath(platform string) string {
	if platform == "linux-amd64" {
		return filepath.Join("bin", "ollama")
	}
	return "ollama"
}

func validateManagedOllamaBinary(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Mode().Perm()&0o111 == 0 ||
		info.Mode().Perm()&0o022 != 0 || !managedOllamaOwnedByCurrentUser(info) {
		return errors.New("managed Ollama runtime binary is invalid")
	}
	return nil
}

func managedOllamaOwnedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}

func managedOllamaStableInfo(before, after os.FileInfo) bool {
	return before != nil && after != nil && os.SameFile(before, after) && before.Size() == after.Size() &&
		before.Mode() == after.Mode() && before.ModTime().Equal(after.ModTime())
}

func openManagedOllamaStableRegularFile(path string, maximum, expected int64) (*os.File, os.FileInfo, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() < 1 || before.Size() > maximum ||
		(expected >= 0 && before.Size() != expected) || before.Mode().Perm()&0o022 != 0 || !managedOllamaOwnedByCurrentUser(before) {
		return nil, nil, errors.New("managed Ollama regular file is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, errors.New("managed Ollama regular file cannot be opened")
	}
	opened, err := file.Stat()
	if err != nil || !managedOllamaStableInfo(before, opened) {
		_ = file.Close()
		return nil, nil, errors.New("managed Ollama regular file changed while opening")
	}
	return file, before, nil
}

func finishManagedOllamaStableRegularFile(path string, file *os.File, before os.FileInfo) error {
	afterHandle, handleErr := file.Stat()
	afterPath, pathErr := os.Lstat(path)
	if handleErr != nil || pathErr != nil || !managedOllamaStableInfo(before, afterHandle) || !managedOllamaStableInfo(before, afterPath) {
		return errors.New("managed Ollama regular file changed while reading")
	}
	return nil
}

func hashManagedOllamaStableRegularFile(path string, maximum, expected int64) (string, error) {
	file, before, err := openManagedOllamaStableRegularFile(path, maximum, expected)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, copyErr := io.Copy(hash, io.LimitReader(file, maximum+1))
	if copyErr != nil || written != before.Size() || written > maximum || finishManagedOllamaStableRegularFile(path, file, before) != nil {
		return "", errors.New("managed Ollama regular file cannot be verified")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func readManagedOllamaStableRegularFile(path string, maximum int64) ([]byte, string, error) {
	file, before, err := openManagedOllamaStableRegularFile(path, maximum, -1)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	raw, readErr := io.ReadAll(io.LimitReader(file, maximum+1))
	if readErr != nil || int64(len(raw)) != before.Size() || int64(len(raw)) > maximum || finishManagedOllamaStableRegularFile(path, file, before) != nil {
		return nil, "", errors.New("managed Ollama regular file cannot be verified")
	}
	digest := sha256.Sum256(raw)
	return raw, hex.EncodeToString(digest[:]), nil
}

// managedOllamaRuntimeTreeSHA256 attests every installed runtime entry except
// the attestation record itself. Paths, types, modes, sizes, symlink targets
// and regular-file contents all contribute to the deterministic digest.
func managedOllamaRuntimeTreeSHA256(root string) (string, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || rootInfo.Mode().Perm()&0o022 != 0 ||
		!managedOllamaOwnedByCurrentUser(rootInfo) {
		return "", errors.New("managed Ollama runtime tree root is unsafe")
	}
	hash := sha256.New()
	entries := 0
	var totalBytes int64
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || !safeManagedOllamaArchivePath(filepath.ToSlash(relative)) {
			return errors.New("managed Ollama runtime tree path is unsafe")
		}
		if filepath.ToSlash(relative) == ".multivibe-runtime.json" {
			return nil
		}
		entries++
		if entries > managedOllamaMaximumArchiveEntries {
			return errors.New("managed Ollama runtime tree has too many entries")
		}
		info, err := os.Lstat(path)
		if err != nil || !managedOllamaOwnedByCurrentUser(info) {
			return errors.New("managed Ollama runtime tree entry is unsafe")
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			if mode.Perm()&0o022 != 0 {
				return errors.New("managed Ollama runtime directory is writable by another user")
			}
			_, _ = fmt.Fprintf(hash, "d\x00%s\x00%o\x00", filepath.ToSlash(relative), mode.Perm())
		case mode.IsRegular():
			if info.Size() < 1 || info.Size() > managedOllamaArchiveMaxBytes || totalBytes > managedOllamaArchiveMaxBytes-info.Size() {
				return errors.New("managed Ollama runtime tree exceeds its size bound")
			}
			totalBytes += info.Size()
			digest, err := hashManagedOllamaStableRegularFile(path, managedOllamaArchiveMaxBytes, info.Size())
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "f\x00%s\x00%o\x00%d\x00%s\x00", filepath.ToSlash(relative), mode.Perm(), info.Size(), digest)
		case mode&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil || filepath.IsAbs(target) || strings.ContainsRune(target, '\x00') {
				return errors.New("managed Ollama runtime symlink is unsafe")
			}
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil || !managedOllamaPathWithin(root, resolved) {
				return errors.New("managed Ollama runtime symlink escapes its tree")
			}
			_, _ = fmt.Fprintf(hash, "l\x00%s\x00%s\x00", filepath.ToSlash(relative), filepath.ToSlash(target))
		default:
			return errors.New("managed Ollama runtime tree contains an unsupported entry")
		}
		return nil
	})
	if err != nil || entries == 0 {
		return "", errors.New("managed Ollama runtime tree cannot be attested")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (manager *managedOllama) runtimeDirectory() string {
	return filepath.Join(manager.root, "runtime", "ollama-"+managedOllamaVersion+"-"+manager.platform)
}

func (manager *managedOllama) installedRuntimeMetadata() (string, managedOllamaRuntimeRecord, error) {
	directory := manager.runtimeDirectory()
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return "", managedOllamaRuntimeRecord{}, errManagedOllamaRuntimeMissing
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", managedOllamaRuntimeRecord{}, errors.New("managed Ollama runtime directory is unsafe")
	}
	recordPath := filepath.Join(directory, ".multivibe-runtime.json")
	recordInfo, err := os.Lstat(recordPath)
	if err != nil || !recordInfo.Mode().IsRegular() || recordInfo.Mode()&os.ModeSymlink != 0 || recordInfo.Mode().Perm() != 0o600 || recordInfo.Size() < 1 || recordInfo.Size() > 4096 {
		return "", managedOllamaRuntimeRecord{}, errors.New("managed Ollama runtime record is invalid")
	}
	file, err := os.Open(recordPath)
	if err != nil {
		return "", managedOllamaRuntimeRecord{}, errors.New("managed Ollama runtime record cannot be opened")
	}
	defer file.Close()
	var record managedOllamaRuntimeRecord
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&record) != nil || ensureJSONEOF(decoder) != nil || record.SchemaVersion != managedOllamaRuntimeSchemaVersion ||
		record.Version != managedOllamaVersion || record.Platform != manager.platform || !validManagedOllamaSHA256(record.ArchiveSHA256) ||
		!validManagedOllamaSHA256(record.TreeSHA256) {
		return "", managedOllamaRuntimeRecord{}, errors.New("managed Ollama runtime record is invalid")
	}
	binaryPath := filepath.Join(directory, managedOllamaBinaryRelativePath(manager.platform))
	if err := validateManagedOllamaBinary(binaryPath); err != nil {
		return "", managedOllamaRuntimeRecord{}, err
	}
	return binaryPath, record, nil
}

func (manager *managedOllama) installedRuntime() (string, managedOllamaRuntimeRecord, error) {
	binaryPath, record, err := manager.installedRuntimeMetadata()
	if err != nil {
		return "", managedOllamaRuntimeRecord{}, err
	}
	treeSHA256, err := managedOllamaRuntimeTreeSHA256(manager.runtimeDirectory())
	if err != nil || treeSHA256 != record.TreeSHA256 {
		return "", managedOllamaRuntimeRecord{}, errors.New("managed Ollama installed runtime tree attestation is invalid")
	}
	return binaryPath, record, nil
}

func (manager *managedOllama) commandEnvironment(modelStoragePath string) []string {
	environment := []string{
		"HOME=" + filepath.Join(manager.root, "home"),
		"LANG=C",
		"LC_ALL=C",
		"OLLAMA_HOST=" + manager.listenAddress,
		"OLLAMA_MODELS=" + modelStoragePath,
		"PATH=/usr/bin:/bin",
		"TMPDIR=" + filepath.Join(manager.root, "tmp"),
		"XDG_CACHE_HOME=" + filepath.Join(manager.root, "home", ".cache"),
		"XDG_CONFIG_HOME=" + filepath.Join(manager.root, "home", ".config"),
		"XDG_DATA_HOME=" + filepath.Join(manager.root, "home", ".local", "share"),
	}
	if manager.goos == "linux" && manager.cudaVisibleDevices != "" {
		environment = append(environment, "CUDA_VISIBLE_DEVICES="+manager.cudaVisibleDevices)
	}
	sort.Strings(environment)
	return environment
}

func (manager *managedOllama) start(ctx context.Context, policyState *capacityPolicyStateDocument) (managedOllamaStatus, error) {
	policy, err := manager.authorizePolicy(policyState, false)
	if err != nil {
		return manager.status(policyState), err
	}
	if err := manager.ensureLayout(); err != nil {
		return manager.status(policyState), err
	}
	if err := ensureManagedOllamaModelStorage(policy.modelStoragePath); err != nil {
		return manager.status(policyState), err
	}
	binaryPath, _, err := manager.installedRuntime()
	if err != nil {
		return manager.status(policyState), err
	}
	manager.lifecycleMu.Lock()
	if _, err := manager.authorizePolicy(policyState, false); err != nil {
		manager.lifecycleMu.Unlock()
		return manager.status(policyState), err
	}
	manager.mu.Lock()
	if manager.process != nil {
		manager.mu.Unlock()
		manager.lifecycleMu.Unlock()
		return manager.status(policyState), nil
	}
	manager.state = "starting"
	manager.mu.Unlock()
	logPath := filepath.Join(manager.root, "logs", "ollama.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		manager.setStateIfIdle("failed")
		manager.lifecycleMu.Unlock()
		return manager.status(policyState), errors.New("managed Ollama log cannot be opened")
	}
	if err := logFile.Chmod(0o600); err != nil {
		_ = logFile.Close()
		manager.setStateIfIdle("failed")
		manager.lifecycleMu.Unlock()
		return manager.status(policyState), errors.New("managed Ollama log cannot be secured")
	}
	process, err := manager.commands.Start(binaryPath, []string{"serve"}, manager.commandEnvironment(policy.modelStoragePath), manager.root, logFile, logFile)
	if err != nil {
		_ = logFile.Close()
		manager.setStateIfIdle("failed")
		manager.lifecycleMu.Unlock()
		return manager.status(policyState), errors.New("managed Ollama runtime cannot be started")
	}
	done := make(chan error, 1)
	manager.mu.Lock()
	manager.process = process
	manager.processDone = done
	manager.mu.Unlock()
	manager.lifecycleMu.Unlock()
	go func() {
		waitErr := process.Wait()
		_ = logFile.Close()
		done <- waitErr
		close(done)
		manager.mu.Lock()
		if manager.process == process {
			manager.process = nil
			manager.processDone = nil
			if manager.state != "stopping" {
				manager.state = "failed"
			} else {
				manager.state = "stopped"
			}
		}
		manager.mu.Unlock()
	}()
	startupContext, cancel := managedOllamaBoundContext(ctx, manager.startupTimeout)
	defer cancel()
	if err := manager.waitReady(startupContext, done); err != nil {
		_ = manager.stop(context.Background())
		return manager.status(policyState), err
	}
	manager.mu.Lock()
	if manager.process == process {
		manager.state = "running"
	}
	manager.mu.Unlock()
	return manager.status(policyState), nil
}

func (manager *managedOllama) setStateIfIdle(state string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.process == nil {
		manager.state = state
	}
}

func (manager *managedOllama) waitReady(ctx context.Context, processDone <-chan error) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, manager.loopbackOrigin+"/api/version", nil)
		if err == nil {
			response, requestErr := manager.httpClient.Do(request)
			if requestErr == nil {
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
				_ = response.Body.Close()
				if response.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return errors.New("managed Ollama runtime readiness timed out")
		case <-processDone:
			return errors.New("managed Ollama runtime exited before readiness")
		case <-ticker.C:
		}
	}
}

func (manager *managedOllama) stop(ctx context.Context) error {
	manager.lifecycleMu.Lock()
	defer manager.lifecycleMu.Unlock()
	manager.mu.Lock()
	process := manager.process
	done := manager.processDone
	if process == nil {
		manager.state = "stopped"
		manager.mu.Unlock()
		return nil
	}
	manager.state = "stopping"
	manager.mu.Unlock()
	if err := process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		_ = process.Kill()
	}
	if managedOllamaWait(ctx, done, manager.shutdownTimeout) {
		manager.markProcessStopped(process)
		return nil
	}
	if err := process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return errors.New("managed Ollama runtime cannot be killed")
	}
	if !managedOllamaWait(context.Background(), done, manager.killTimeout) {
		return errors.New("managed Ollama runtime did not exit after kill")
	}
	manager.markProcessStopped(process)
	return nil
}

func (manager *managedOllama) markProcessStopped(process managedOllamaProcess) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.process == process {
		manager.process = nil
		manager.processDone = nil
		manager.state = "stopped"
	}
}

func managedOllamaWait(ctx context.Context, done <-chan error, maximum time.Duration) bool {
	timer := time.NewTimer(maximum)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}

// enforcePolicy makes pause and missing-policy states fail closed. It never
// starts, installs, pulls, or otherwise expands local activity.
func (manager *managedOllama) enforcePolicy(ctx context.Context, policyState *capacityPolicyStateDocument) error {
	_, policyErr := manager.authorizePolicy(policyState, false)
	if policyErr != nil {
		manager.cancelDownloads()
		stopErr := manager.stop(ctx)
		if stopErr != nil {
			return stopErr
		}
		if errors.Is(policyErr, errManagedOllamaPaused) {
			return nil
		}
		return errManagedOllamaPolicyRequired
	}
	if !*policyState.AutomaticDownloads {
		manager.cancelDownloads()
	}
	return nil
}

func (manager *managedOllama) cancelDownloads() {
	manager.mu.Lock()
	installCancel := manager.installCancel
	pullCancel := manager.pullCancel
	manager.mu.Unlock()
	if installCancel != nil {
		installCancel()
	}
	if pullCancel != nil {
		pullCancel()
	}
}

func (manager *managedOllama) status(policyState *capacityPolicyStateDocument) managedOllamaStatus {
	installed := false
	if _, _, err := manager.installedRuntimeMetadata(); err == nil {
		installed = true
	}
	manager.mu.Lock()
	running := manager.process != nil && (manager.state == "starting" || manager.state == "running" || manager.state == "stopping")
	state := manager.state
	manager.mu.Unlock()
	if state == "stopped" && !installed {
		state = "not-installed"
	}
	paused := policyState != nil && policyState.Paused != nil && *policyState.Paused
	modelIDs := []string{}
	if policyState != nil && validateCapacityPolicyState(*policyState) == nil {
		if modelState, err := manager.loadModelState(policyState.Policy.ModelStoragePath); err == nil {
			for _, model := range modelState.Models {
				modelIDs = append(modelIDs, model.CanonicalModelID)
			}
		}
	}
	return managedOllamaStatus{
		SchemaVersion: "managed-ollama-status-v1", State: state, Version: managedOllamaVersion, Platform: manager.platform,
		RuntimeInstalled: installed, Running: running, Paused: paused, InstalledModelIDs: modelIDs,
	}
}

func (manager *managedOllama) pullModel(ctx context.Context, policyState *capacityPolicyStateDocument, catalogPath string, planned plannedModelDownload) (managedOllamaModelRecord, error) {
	record, _, err := manager.pullModelResult(ctx, policyState, catalogPath, planned)
	return record, err
}

func (manager *managedOllama) pullModelResult(ctx context.Context, policyState *capacityPolicyStateDocument, catalogPath string, planned plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	catalog, err := openProviderModelCatalog(catalogPath)
	if err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	return manager.pullModelResultPinned(ctx, policyState, catalog, planned)
}

func (manager *managedOllama) pullModelResultPinned(ctx context.Context, policyState *capacityPolicyStateDocument, catalog providerModelCatalog, planned plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	if validateProviderModelCatalog(&catalog) != nil {
		return managedOllamaModelRecord{}, false, errors.New("managed Ollama model catalog is invalid")
	}
	manager.pullMu.Lock()
	defer manager.pullMu.Unlock()
	pullContext, cancel := managedOllamaBoundContext(ctx, managedOllamaDefaultPullTimeout)
	manager.mu.Lock()
	manager.pullCancel = cancel
	manager.mu.Unlock()
	defer func() {
		cancel()
		manager.mu.Lock()
		manager.pullCancel = nil
		manager.mu.Unlock()
	}()
	policy, err := manager.authorizePolicy(policyState, true)
	if err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	entry, found := catalog.entry(planned.ModelID)
	if !found || planned.Bytes != entry.DownloadBytes || planned.Bytes == 0 || planned.Bytes > policy.maxDownloadBytesPerDay || planned.Bytes > policy.maxDiskBytes {
		return managedOllamaModelRecord{}, false, errors.New("managed Ollama pull is not an exact local catalog plan entry")
	}
	if err := manager.ensureLayout(); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if err := ensureManagedOllamaModelStorage(policy.modelStoragePath); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	binaryPath, _, err := manager.installedRuntime()
	if err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if record, err := manager.verifyCatalogModel(policy.modelStoragePath, entry); err == nil {
		if err := pullContext.Err(); err != nil {
			return managedOllamaModelRecord{}, false, err
		}
		if _, err := manager.lockAuthorizedPolicy(policyState, true); err != nil {
			return managedOllamaModelRecord{}, false, err
		}
		if err := pullContext.Err(); err != nil {
			manager.mu.Unlock()
			return managedOllamaModelRecord{}, false, err
		}
		recordErr := manager.recordManagedModel(policy.modelStoragePath, record)
		manager.mu.Unlock()
		if recordErr != nil {
			return managedOllamaModelRecord{}, false, recordErr
		}
		return record, false, nil
	}
	if err := manager.requireReadyRuntime(pullContext); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if _, err := manager.commands.Run(
		pullContext, binaryPath, []string{"pull", entry.OllamaModel}, manager.commandEnvironment(policy.modelStoragePath), manager.root, managedOllamaCommandOutputMaxBytes,
	); err != nil {
		return managedOllamaModelRecord{}, false, errors.New("managed Ollama model pull failed")
	}
	record, err := manager.verifyCatalogModel(policy.modelStoragePath, entry)
	if err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if err := pullContext.Err(); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if _, err := manager.lockAuthorizedPolicy(policyState, true); err != nil {
		return managedOllamaModelRecord{}, false, err
	}
	if err := pullContext.Err(); err != nil {
		manager.mu.Unlock()
		return managedOllamaModelRecord{}, false, err
	}
	recordErr := manager.recordManagedModel(policy.modelStoragePath, record)
	manager.mu.Unlock()
	if recordErr != nil {
		return managedOllamaModelRecord{}, false, recordErr
	}
	return record, true, nil
}

func (manager *managedOllama) deactivateModel(ctx context.Context, policyState *capacityPolicyStateDocument, catalogPath, modelID string) error {
	catalog, err := openProviderModelCatalog(catalogPath)
	if err != nil {
		return err
	}
	return manager.deactivateModelPinned(ctx, policyState, catalog, modelID)
}

func (manager *managedOllama) deactivateModelPinned(ctx context.Context, policyState *capacityPolicyStateDocument, catalog providerModelCatalog, modelID string) error {
	if validateProviderModelCatalog(&catalog) != nil {
		return errors.New("managed Ollama model catalog is invalid")
	}
	if _, err := manager.authorizePolicy(policyState, false); err != nil {
		return err
	}
	entry, found := catalog.entry(modelID)
	if !found {
		return errors.New("managed Ollama stop model is absent from the local catalog")
	}
	inventory, err := manager.managedInventory(policyState)
	if err != nil {
		return err
	}
	index := sort.SearchStrings(inventory, modelID)
	if index >= len(inventory) || inventory[index] != modelID {
		return errors.New("managed Ollama stop model is absent from managed inventory")
	}
	if err := manager.requireReadyRuntime(ctx); err != nil {
		return err
	}
	binaryPath, _, err := manager.installedRuntime()
	if err != nil {
		return err
	}
	stopContext, cancel := managedOllamaBoundContext(ctx, time.Minute)
	defer cancel()
	if _, err := manager.commands.Run(
		stopContext, binaryPath, []string{"stop", entry.OllamaModel}, manager.commandEnvironment(policyState.Policy.ModelStoragePath), manager.root, managedOllamaCommandOutputMaxBytes,
	); err != nil {
		return errors.New("managed Ollama model cannot be stopped")
	}
	return nil
}

// pullModel invokes the CLI only after start has made the managed loopback
// server ready. The required lifecycle order is ensureRuntime -> start -> pullModel.
func (manager *managedOllama) requireReadyRuntime(ctx context.Context) error {
	manager.mu.Lock()
	running := manager.process != nil && manager.state == "running"
	manager.mu.Unlock()
	if !running {
		return errors.New("managed Ollama pull requires its managed runtime to be running")
	}
	probeContext, cancel := managedOllamaBoundContext(ctx, time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, manager.loopbackOrigin+"/api/version", nil)
	if err != nil {
		return errors.New("managed Ollama readiness request cannot be created")
	}
	response, err := manager.httpClient.Do(request)
	if err != nil {
		return errors.New("managed Ollama runtime is not ready")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusOK {
		return errors.New("managed Ollama runtime is not ready")
	}
	return nil
}

func validManagedOllamaMediaType(value string) bool {
	if len(value) < 3 || len(value) > 160 || strings.Count(value, "/") != 1 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') ||
			character == '/' || character == '.' || character == '+' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validateManagedOllamaModelManifest(manifest managedOllamaModelManifest, maximumBytes uint64) ([]managedOllamaManifestBlob, error) {
	if manifest.SchemaVersion != 2 ||
		(manifest.MediaType != "application/vnd.docker.distribution.manifest.v2+json" && manifest.MediaType != "application/vnd.oci.image.manifest.v1+json") ||
		len(manifest.Layers) == 0 || len(manifest.Layers) > managedOllamaMaximumManifestLayers {
		return nil, errors.New("managed Ollama model manifest is invalid")
	}
	blobs := make([]managedOllamaManifestBlob, 0, len(manifest.Layers)+1)
	blobs = append(blobs, manifest.Config)
	blobs = append(blobs, manifest.Layers...)
	seen := make(map[string]struct{}, len(blobs))
	var aggregate uint64
	for _, blob := range blobs {
		if !validManagedOllamaMediaType(blob.MediaType) || !providerDemandContentDigest.MatchString(blob.Digest) || blob.Size == 0 ||
			blob.Size > maximumProviderArtifactBytes || aggregate > maximumBytes || blob.Size > maximumBytes-aggregate {
			return nil, errors.New("managed Ollama model manifest blob is invalid")
		}
		if _, duplicate := seen[blob.Digest]; duplicate {
			return nil, errors.New("managed Ollama model manifest repeats a blob")
		}
		seen[blob.Digest] = struct{}{}
		aggregate += blob.Size
	}
	return blobs, nil
}

func verifyManagedOllamaBlob(modelStoragePath, resolvedStorage string, blob managedOllamaManifestBlob) error {
	hexDigest := strings.TrimPrefix(blob.Digest, "sha256:")
	blobPath := filepath.Join(modelStoragePath, "blobs", "sha256-"+hexDigest)
	if !managedOllamaPathWithin(filepath.Join(modelStoragePath, "blobs"), blobPath) {
		return errors.New("managed Ollama blob path escaped model storage")
	}
	resolvedBlob, err := filepath.EvalSymlinks(blobPath)
	if err != nil || !managedOllamaPathWithin(resolvedStorage, resolvedBlob) {
		return errors.New("managed Ollama blob resolved outside model storage")
	}
	digest, err := hashManagedOllamaStableRegularFile(blobPath, int64(maximumProviderArtifactBytes), int64(blob.Size))
	if err != nil || digest != hexDigest {
		return errors.New("managed Ollama blob checksum mismatch")
	}
	resolvedAfter, err := filepath.EvalSymlinks(blobPath)
	if err != nil || resolvedAfter != resolvedBlob {
		return errors.New("managed Ollama blob changed while verifying")
	}
	return nil
}

func (manager *managedOllama) verifyCatalogModel(modelStoragePath string, entry providerModelCatalogEntry) (managedOllamaModelRecord, error) {
	if !safeOllamaManifestPath(entry.OllamaManifestPath) || !providerDemandContentDigest.MatchString(entry.ContentDigest) ||
		entry.DownloadBytes == 0 || entry.DownloadBytes > maximumProviderArtifactBytes {
		return managedOllamaModelRecord{}, errors.New("managed Ollama catalog entry is invalid")
	}
	storageInfo, err := os.Lstat(modelStoragePath)
	if err != nil || !storageInfo.IsDir() || storageInfo.Mode()&os.ModeSymlink != 0 || storageInfo.Mode().Perm() != 0o700 ||
		!managedOllamaOwnedByCurrentUser(storageInfo) {
		return managedOllamaModelRecord{}, errors.New("managed Ollama model storage is unsafe")
	}
	manifestPath := filepath.Join(modelStoragePath, "manifests", filepath.FromSlash(entry.OllamaManifestPath))
	manifestRoot := filepath.Join(modelStoragePath, "manifests")
	if !managedOllamaPathWithin(manifestRoot, manifestPath) {
		return managedOllamaModelRecord{}, errors.New("managed Ollama manifest path escaped model storage")
	}
	resolvedStorage, storageErr := filepath.EvalSymlinks(modelStoragePath)
	resolvedManifest, manifestErr := filepath.EvalSymlinks(manifestPath)
	if storageErr != nil || manifestErr != nil || !managedOllamaPathWithin(resolvedStorage, resolvedManifest) {
		return managedOllamaModelRecord{}, errors.New("managed Ollama manifest resolved outside model storage")
	}
	raw, manifestSHA256, err := readManagedOllamaStableRegularFile(manifestPath, managedOllamaModelManifestMaxBytes)
	if err != nil || "sha256:"+manifestSHA256 != entry.ContentDigest || validateUniqueJSONKeys(raw) != nil {
		return managedOllamaModelRecord{}, errors.New("managed Ollama model manifest checksum mismatch")
	}
	var manifest managedOllamaModelManifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || ensureJSONEOF(decoder) != nil {
		return managedOllamaModelRecord{}, errors.New("managed Ollama model manifest is invalid")
	}
	blobs, err := validateManagedOllamaModelManifest(manifest, entry.DownloadBytes)
	if err != nil {
		return managedOllamaModelRecord{}, err
	}
	for _, blob := range blobs {
		if err := verifyManagedOllamaBlob(modelStoragePath, resolvedStorage, blob); err != nil {
			return managedOllamaModelRecord{}, err
		}
	}
	resolvedManifestAfter, err := filepath.EvalSymlinks(manifestPath)
	if err != nil || resolvedManifestAfter != resolvedManifest {
		return managedOllamaModelRecord{}, errors.New("managed Ollama model manifest changed while verifying")
	}
	return managedOllamaModelRecord{
		CanonicalModelID: entry.CanonicalModelID, OllamaModel: entry.OllamaModel,
		OllamaManifestPath: entry.OllamaManifestPath, ManifestSHA256: entry.ContentDigest,
	}, nil
}

// authorizeModelActivation is the last local gate before a caller advertises
// or routes to a model. It verifies both managed inventory and the exact pinned
// Ollama manifest; it never discovers arbitrary Ollama models.
func (manager *managedOllama) authorizeModelActivation(policyState *capacityPolicyStateDocument, catalogPath, modelID string) (managedOllamaModelRecord, error) {
	catalog, err := openProviderModelCatalog(catalogPath)
	if err != nil {
		return managedOllamaModelRecord{}, err
	}
	return manager.authorizeModelActivationPinned(policyState, catalog, modelID)
}

func (manager *managedOllama) authorizeModelActivationPinned(policyState *capacityPolicyStateDocument, catalog providerModelCatalog, modelID string) (managedOllamaModelRecord, error) {
	if validateProviderModelCatalog(&catalog) != nil {
		return managedOllamaModelRecord{}, errors.New("managed Ollama model catalog is invalid")
	}
	policy, err := manager.authorizePolicy(policyState, false)
	if err != nil {
		return managedOllamaModelRecord{}, err
	}
	entry, found := catalog.entry(modelID)
	if !found {
		return managedOllamaModelRecord{}, errors.New("managed Ollama activation model is absent from the local catalog")
	}
	state, err := manager.loadModelState(policy.modelStoragePath)
	if err != nil {
		return managedOllamaModelRecord{}, err
	}
	index := sort.Search(len(state.Models), func(index int) bool { return state.Models[index].CanonicalModelID >= modelID })
	if index >= len(state.Models) || state.Models[index].CanonicalModelID != modelID {
		return managedOllamaModelRecord{}, errors.New("managed Ollama activation model is absent from managed inventory")
	}
	record, err := manager.verifyCatalogModel(policy.modelStoragePath, entry)
	if err != nil || record != state.Models[index] {
		return managedOllamaModelRecord{}, errors.New("managed Ollama activation manifest is not verified")
	}
	return record, nil
}

func (manager *managedOllama) recordManagedModel(storagePath string, record managedOllamaModelRecord) error {
	state, err := manager.loadModelState(storagePath)
	if err != nil {
		return err
	}
	index := sort.Search(len(state.Models), func(index int) bool { return state.Models[index].CanonicalModelID >= record.CanonicalModelID })
	if index < len(state.Models) && state.Models[index].CanonicalModelID == record.CanonicalModelID {
		state.Models[index] = record
	} else {
		state.Models = append(state.Models, managedOllamaModelRecord{})
		copy(state.Models[index+1:], state.Models[index:])
		state.Models[index] = record
	}
	if len(state.Models) > managedOllamaMaximumModels || validateManagedOllamaModelState(state, storagePath) != nil {
		return errors.New("managed Ollama model inventory is invalid")
	}
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > managedOllamaDependencyManifestMaxBytes {
		return errors.New("managed Ollama model inventory cannot be encoded")
	}
	if err := atomicWrite0600(manager.modelStatePath(), append(encoded, '\n')); err != nil {
		return errors.New("managed Ollama model inventory cannot be persisted")
	}
	return nil
}

func (manager *managedOllama) loadModelState(storagePath string) (managedOllamaModelState, error) {
	empty := managedOllamaModelState{
		SchemaVersion: managedOllamaModelsSchemaVersion, RuntimeVersion: managedOllamaVersion,
		ModelStoragePath: storagePath, Models: []managedOllamaModelRecord{},
	}
	path := manager.modelStatePath()
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || info.Size() < 1 || info.Size() > managedOllamaDependencyManifestMaxBytes {
		return managedOllamaModelState{}, errors.New("managed Ollama model inventory is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return managedOllamaModelState{}, errors.New("managed Ollama model inventory cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, managedOllamaDependencyManifestMaxBytes+1))
	if err != nil || len(raw) > managedOllamaDependencyManifestMaxBytes || validateUniqueJSONKeys(raw) != nil {
		return managedOllamaModelState{}, errors.New("managed Ollama model inventory is invalid")
	}
	var state managedOllamaModelState
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil || ensureJSONEOF(decoder) != nil || validateManagedOllamaModelState(state, storagePath) != nil {
		return managedOllamaModelState{}, errors.New("managed Ollama model inventory is invalid")
	}
	return state, nil
}

func validateManagedOllamaModelState(state managedOllamaModelState, storagePath string) error {
	if state.SchemaVersion != managedOllamaModelsSchemaVersion || state.RuntimeVersion != managedOllamaVersion || state.ModelStoragePath != storagePath ||
		!validModelStoragePath(state.ModelStoragePath) || state.Models == nil || len(state.Models) > managedOllamaMaximumModels {
		return errors.New("managed Ollama model inventory is invalid")
	}
	previous := ""
	for _, record := range state.Models {
		if !providerDemandModelID.MatchString(record.CanonicalModelID) || record.CanonicalModelID <= previous ||
			!ollamaModelReference.MatchString(record.OllamaModel) || !safeOllamaManifestPath(record.OllamaManifestPath) ||
			!providerDemandContentDigest.MatchString(record.ManifestSHA256) {
			return errors.New("managed Ollama model inventory is invalid")
		}
		previous = record.CanonicalModelID
	}
	return nil
}

func (manager *managedOllama) modelStatePath() string {
	return filepath.Join(manager.root, "state", "models.json")
}

func (manager *managedOllama) managedInventory(policyState *capacityPolicyStateDocument) ([]string, error) {
	policy, err := manager.authorizePolicy(policyState, false)
	if err != nil {
		return nil, err
	}
	state, err := manager.loadModelState(policy.modelStoragePath)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(state.Models))
	for _, model := range state.Models {
		result = append(result, model.CanonicalModelID)
	}
	return result, nil
}

func (manager *managedOllama) String() string {
	return fmt.Sprintf("managed Ollama %s (%s)", managedOllamaVersion, manager.platform)
}
