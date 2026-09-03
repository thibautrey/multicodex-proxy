package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type managedOllamaRoundTripFunc func(*http.Request) (*http.Response, error)

func (function managedOllamaRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type managedOllamaTestCommands struct {
	mu        sync.Mutex
	run       func(context.Context, string, []string, []string, string, int64) ([]byte, error)
	start     func(string, []string, []string, string, io.Writer, io.Writer) (managedOllamaProcess, error)
	runCalls  int
	starts    int
	startEnvs [][]string
}

func (commands *managedOllamaTestCommands) Run(ctx context.Context, path string, arguments, environment []string, directory string, limit int64) ([]byte, error) {
	commands.mu.Lock()
	commands.runCalls++
	function := commands.run
	commands.mu.Unlock()
	if function == nil {
		return nil, errors.New("unexpected run")
	}
	return function(ctx, path, arguments, environment, directory, limit)
}

func (commands *managedOllamaTestCommands) Start(path string, arguments, environment []string, directory string, stdout, stderr io.Writer) (managedOllamaProcess, error) {
	commands.mu.Lock()
	commands.starts++
	commands.startEnvs = append(commands.startEnvs, append([]string{}, environment...))
	function := commands.start
	commands.mu.Unlock()
	if function == nil {
		return nil, errors.New("unexpected start")
	}
	return function(path, arguments, environment, directory, stdout, stderr)
}

type managedOllamaTestProcess struct {
	done       chan struct{}
	once       sync.Once
	mu         sync.Mutex
	signals    []os.Signal
	kills      int
	exitOnTerm bool
}

func newManagedOllamaTestProcess(exitOnTerm bool) *managedOllamaTestProcess {
	return &managedOllamaTestProcess{done: make(chan struct{}), exitOnTerm: exitOnTerm}
}

func (process *managedOllamaTestProcess) Wait() error {
	<-process.done
	return nil
}

func (process *managedOllamaTestProcess) Signal(signal os.Signal) error {
	process.mu.Lock()
	process.signals = append(process.signals, signal)
	exit := process.exitOnTerm
	process.mu.Unlock()
	if exit {
		process.once.Do(func() { close(process.done) })
	}
	return nil
}

func (process *managedOllamaTestProcess) Kill() error {
	process.mu.Lock()
	process.kills++
	process.mu.Unlock()
	process.once.Do(func() { close(process.done) })
	return nil
}

func managedOllamaTestPolicy(storagePath string, revision uint64, paused, downloads bool) *capacityPolicyStateDocument {
	gpu := uint8(80)
	vram := uint8(80)
	maxDisk := uint64(8 * 1024 * 1024 * 1024)
	maxDownload := uint64(4 * 1024 * 1024 * 1024)
	residency := uint64(60)
	changes := uint32(10)
	reserve := uint64(1024)
	return &capacityPolicyStateDocument{
		SchemaVersion: capacityPolicyStateSchemaVersion,
		Revision:      revision,
		Paused:        &paused, AutomaticDownloads: &downloads, AllowCloudWorkloads: managedOllamaTestBool(true),
		Policy: capacityPolicyDocument{
			SchemaVersion: capacityPolicySchemaVersion, GPUUtilizationPercent: &gpu, GPUVRAMPercent: &vram,
			MaxDiskBytes: &maxDisk, ModelStoragePath: storagePath, MaxDownloadBytesPerDay: &maxDownload,
			MinimumModelResidencySeconds: &residency, MaxModelChangesPerDay: &changes, ReserveFreeDiskBytes: &reserve,
		},
	}
}

func managedOllamaTestBool(value bool) *bool {
	return &value
}

func managedOllamaTestSHA(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func managedOllamaTestModelManifest() ([]byte, map[string][]byte) {
	config := []byte("{}")
	layer := []byte("modeldata")
	configDigest := "sha256:" + managedOllamaTestSHA(config)
	layerDigest := "sha256:" + managedOllamaTestSHA(layer)
	manifest := managedOllamaModelManifest{
		SchemaVersion: 2,
		MediaType:     "application/vnd.docker.distribution.manifest.v2+json",
		Config: managedOllamaManifestBlob{
			MediaType: "application/vnd.docker.container.image.v1+json", Digest: configDigest, Size: uint64(len(config)),
		},
		Layers: []managedOllamaManifestBlob{{
			MediaType: "application/vnd.ollama.image.model", Digest: layerDigest, Size: uint64(len(layer)),
		}},
	}
	encoded, _ := json.Marshal(manifest)
	return encoded, map[string][]byte{configDigest: config, layerDigest: layer}
}

func writeManagedOllamaTestModel(storage string, manifest []byte, blobs map[string][]byte) error {
	manifestPath := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		return err
	}
	blobRoot := filepath.Join(storage, "blobs")
	if err := os.MkdirAll(blobRoot, 0o700); err != nil {
		return err
	}
	for digest, content := range blobs {
		path := filepath.Join(blobRoot, strings.Replace(digest, ":", "-", 1))
		if err := os.WriteFile(path, content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func writeManagedOllamaTestDependencies(t *testing.T, directory, darwinSHA string) string {
	t.Helper()
	document := map[string]any{
		"schemaVersion": uint64(1),
		"node":          map[string]any{"version": "22.23.2"},
		"ollama": map[string]any{
			"version": managedOllamaVersion,
			"artifacts": map[string]any{
				"darwin-arm64": map[string]any{
					"url": "https://github.com/ollama/ollama/releases/download/v0.33.2/ollama-darwin.tgz", "sha256": darwinSHA, "archive": "tar-gzip",
				},
				"darwin-amd64": map[string]any{
					"url": "https://github.com/ollama/ollama/releases/download/v0.33.2/ollama-darwin.tgz", "sha256": darwinSHA, "archive": "tar-gzip",
				},
				"linux-amd64": map[string]any{
					"url": "https://github.com/ollama/ollama/releases/download/v0.33.2/ollama-linux-amd64.tar.zst", "sha256": strings.Repeat("1", 64), "archive": "tar-zstd",
				},
			},
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "dependencies.json")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func newManagedOllamaTestManager(t *testing.T, config managedOllamaConfig) *managedOllama {
	t.Helper()
	if config.ManagedRoot == "" {
		config.ManagedRoot = filepath.Join(t.TempDir(), "managed")
	}
	if config.GOOS == "" {
		config.GOOS = "darwin"
		config.GOARCH = "arm64"
	}
	if config.TarPath == "" {
		config.TarPath = "/usr/bin/tar"
	}
	manager, err := newManagedOllama(config)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func TestManagedOllamaSupportsBothMacArchitectures(t *testing.T) {
	for _, testCase := range []struct{ arch, platform string }{
		{arch: "arm64", platform: "darwin-arm64"},
		{arch: "amd64", platform: "darwin-amd64"},
	} {
		platform, err := managedOllamaPlatform("darwin", testCase.arch)
		if err != nil || platform != testCase.platform {
			t.Fatalf("unexpected macOS platform for %s: %q %v", testCase.arch, platform, err)
		}
		if _, _, err := managedOllamaTarArguments(platform, "/tmp/archive", "/tmp/staging"); err != nil {
			t.Fatalf("macOS archive arguments rejected for %s: %v", platform, err)
		}
	}
}

func installManagedOllamaTestRuntime(t *testing.T, manager *managedOllama, archiveSHA string) {
	t.Helper()
	if err := manager.ensureLayout(); err != nil {
		t.Fatal(err)
	}
	directory := manager.runtimeDirectory()
	binary := filepath.Join(directory, managedOllamaBinaryRelativePath(manager.platform))
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("test-ollama"), 0o755); err != nil {
		t.Fatal(err)
	}
	treeSHA, err := managedOllamaRuntimeTreeSHA256(directory)
	if err != nil {
		t.Fatal(err)
	}
	record := managedOllamaRuntimeRecord{
		SchemaVersion: managedOllamaRuntimeSchemaVersion, Version: managedOllamaVersion,
		Platform: manager.platform, ArchiveSHA256: archiveSHA, TreeSHA256: treeSHA,
	}
	encoded, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(directory, ".multivibe-runtime.json"), append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestManagedOllamaDependencyManifestIsStrictAndPlatformBound(t *testing.T) {
	directory := t.TempDir()
	path := writeManagedOllamaTestDependencies(t, directory, strings.Repeat("a", 64))
	document, err := openManagedOllamaDependencyManifest(path)
	if err != nil || document.Ollama.Version != managedOllamaVersion {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	badPath := filepath.Join(directory, "bad.json")
	bad := strings.Replace(string(raw), "https://github.com/ollama/ollama/", "http://example.test/ollama/", 1)
	if err := os.WriteFile(badPath, []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openManagedOllamaDependencyManifest(badPath); err == nil {
		t.Fatal("non-HTTPS/non-GitHub dependency was accepted")
	}
	if _, err := openManagedOllamaDependencyManifest("relative.json"); err == nil {
		t.Fatal("relative dependency manifest path was accepted")
	}
	if _, _, err := validateManagedOllamaListenAddress("0.0.0.0:11434"); err == nil {
		t.Fatal("non-loopback Ollama address was accepted")
	}
	if address, origin, err := validateManagedOllamaListenAddress("127.0.0.1:18081"); err != nil || address != "127.0.0.1:18081" || origin != "http://127.0.0.1:18081" {
		t.Fatalf("custom loopback rejected: %q %q %v", address, origin, err)
	}
	if err := validateManagedOllamaCUDAVisibleDevices("linux", "0"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"0,1", "1,0", "0,0", "00", "32", "gpu0"} {
		if err := validateManagedOllamaCUDAVisibleDevices("linux", invalid); err == nil {
			t.Fatalf("invalid CUDA pin %q accepted", invalid)
		}
	}
	if err := validateManagedOllamaCUDAVisibleDevices("darwin", "0"); err == nil {
		t.Fatal("CUDA pin accepted on macOS")
	}
}

func TestManagedOllamaPackagedDependencyManifestPinsExpectedRelease(t *testing.T) {
	path, err := filepath.Abs(filepath.Join("..", "packaging", "provider-host-dependencies.json"))
	if err != nil {
		t.Fatal(err)
	}
	document, err := openManagedOllamaDependencyManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"darwin-arm64": "5751e296a2cd545939bdd51b700de0c20d319f0e723c9d7f48bebb5ab0b731d4",
		"darwin-amd64": "5751e296a2cd545939bdd51b700de0c20d319f0e723c9d7f48bebb5ab0b731d4",
		"linux-amd64":  "9785247dea264d9072f09f6c9c0eb4b8e666892826a3d8388eba3e8fb9ed1db9",
	}
	for platform, digest := range expected {
		if document.Ollama.Artifacts[platform].SHA256 != digest {
			t.Fatalf("unexpected %s Ollama digest", platform)
		}
	}
}

func TestManagedOllamaAdoptsAttestedBundleWithoutNetwork(t *testing.T) {
	base := t.TempDir()
	archiveSHA := strings.Repeat("b", 64)
	dependencyPath := writeManagedOllamaTestDependencies(t, base, archiveSHA)
	bundle := filepath.Join(base, "bundle")
	if err := os.Mkdir(bundle, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "ollama"), []byte("bundled-runtime"), 0o755); err != nil {
		t.Fatal(err)
	}
	attestation, _ := json.Marshal(managedOllamaBundleRecord{
		SchemaVersion: "managed-ollama-bundle-v1", Version: managedOllamaVersion,
		Platform: "darwin-arm64", ArchiveSHA256: archiveSHA,
	})
	if err := os.WriteFile(filepath.Join(bundle, ".multivibe-bundle.json"), append(attestation, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	networkCalls := 0
	commands := &managedOllamaTestCommands{}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), BundledRuntimeRoot: bundle, Commands: commands,
		HTTPTransport: managedOllamaRoundTripFunc(func(*http.Request) (*http.Response, error) {
			networkCalls++
			return nil, errors.New("network must not be used")
		}),
	})
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
	status, err := manager.ensureRuntime(context.Background(), policy, dependencyPath)
	if err != nil || !status.RuntimeInstalled || networkCalls != 0 || commands.runCalls != 0 {
		t.Fatalf("bundle adoption failed: status=%+v network=%d runs=%d err=%v", status, networkCalls, commands.runCalls, err)
	}
	installed, err := os.ReadFile(filepath.Join(manager.runtimeDirectory(), "ollama"))
	if err != nil || string(installed) != "bundled-runtime" {
		t.Fatalf("adopted binary mismatch: %q %v", installed, err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "ollama"), []byte("changed-source"), 0o755); err != nil {
		t.Fatal(err)
	}
	installed, _ = os.ReadFile(filepath.Join(manager.runtimeDirectory(), "ollama"))
	if string(installed) != "bundled-runtime" {
		t.Fatal("managed runtime was not isolated from its bundle source")
	}
}

func TestManagedOllamaCancelledInstallCannotAdoptBundledRuntime(t *testing.T) {
	base := t.TempDir()
	archiveSHA := strings.Repeat("b", 64)
	dependencyPath := writeManagedOllamaTestDependencies(t, base, archiveSHA)
	bundle := filepath.Join(base, "bundle")
	if err := os.Mkdir(bundle, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "ollama"), []byte("bundled-runtime"), 0o755); err != nil {
		t.Fatal(err)
	}
	attestation, _ := json.Marshal(managedOllamaBundleRecord{
		SchemaVersion: "managed-ollama-bundle-v1", Version: managedOllamaVersion,
		Platform: "darwin-arm64", ArchiveSHA256: archiveSHA,
	})
	if err := os.WriteFile(filepath.Join(bundle, ".multivibe-bundle.json"), append(attestation, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), BundledRuntimeRoot: bundle, Commands: &managedOllamaTestCommands{},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.ensureRuntime(ctx, managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true), dependencyPath); err == nil {
		t.Fatal("cancelled install adopted a bundled runtime")
	}
	if _, _, err := manager.installedRuntime(); !errors.Is(err, errManagedOllamaRuntimeMissing) {
		t.Fatalf("cancelled adoption committed a runtime: %v", err)
	}
}

func TestManagedOllamaDownloadIsFreshPrivateHashedAndExtractedByAllowlistedTar(t *testing.T) {
	base := t.TempDir()
	archive := []byte("small pinned archive")
	archiveSHA := managedOllamaTestSHA(archive)
	dependencyPath := writeManagedOllamaTestDependencies(t, base, archiveSHA)
	requestCount := 0
	commands := &managedOllamaTestCommands{}
	commands.run = func(_ context.Context, path string, arguments, _ []string, _ string, _ int64) ([]byte, error) {
		if path != "/usr/bin/tar" {
			t.Fatalf("tar path was not absolute/allowlisted: %q", path)
		}
		archivePath := arguments[1]
		info, err := os.Stat(archivePath)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("archive temporary file is not private: %v %v", info, err)
		}
		if arguments[0] == "-tzf" {
			return []byte("ollama\n"), nil
		}
		var staging string
		for index := range arguments {
			if arguments[index] == "-C" && index+1 < len(arguments) {
				staging = arguments[index+1]
			}
		}
		if staging == "" {
			t.Fatal("extract command omitted staging")
		}
		return nil, os.WriteFile(filepath.Join(staging, "ollama"), []byte("downloaded-runtime"), 0o755)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), Commands: commands,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestCount++
			if request.Header.Get("Range") != "" || request.URL.Hostname() != "github.com" {
				t.Fatalf("unsafe dependency request: %s Range=%q", request.URL, request.Header.Get("Range"))
			}
			return &http.Response{
				StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Header: make(http.Header),
				Body: io.NopCloser(strings.NewReader(string(archive))), Request: request,
			}, nil
		}),
	})
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
	if _, err := manager.ensureRuntime(context.Background(), policy, dependencyPath); err != nil {
		t.Fatal(err)
	}
	if requestCount != 1 || commands.runCalls != 2 {
		t.Fatalf("unexpected download/extract counts: http=%d command=%d", requestCount, commands.runCalls)
	}
	entries, err := os.ReadDir(filepath.Join(base, "managed", "downloads"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("download temporary file remained: %v %v", entries, err)
	}

	badManager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "bad-managed"), Commands: &managedOllamaTestCommands{},
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Header: make(http.Header), Body: io.NopCloser(strings.NewReader("wrong archive payload")), Request: request}, nil
		}),
	})
	if _, err := badManager.ensureRuntime(context.Background(), managedOllamaTestPolicy(filepath.Join(base, "bad-models"), 1, false, true), dependencyPath); err == nil {
		t.Fatal("checksum mismatch was accepted")
	}
	if _, _, err := badManager.installedRuntime(); !errors.Is(err, errManagedOllamaRuntimeMissing) {
		t.Fatalf("bad archive created a runtime: %v", err)
	}
}

func TestManagedOllamaPolicyChangeFencesRuntimeInstallCommit(t *testing.T) {
	base := t.TempDir()
	archive := []byte("small pinned archive")
	archiveSHA := managedOllamaTestSHA(archive)
	dependencyPath := writeManagedOllamaTestDependencies(t, base, archiveSHA)
	extractStarted := make(chan struct{})
	extractRelease := make(chan struct{})
	commands := &managedOllamaTestCommands{}
	commands.run = func(_ context.Context, _ string, arguments, _ []string, _ string, _ int64) ([]byte, error) {
		if arguments[0] == "-tzf" {
			return []byte("ollama\n"), nil
		}
		var staging string
		for index := range arguments {
			if arguments[index] == "-C" && index+1 < len(arguments) {
				staging = arguments[index+1]
			}
		}
		close(extractStarted)
		<-extractRelease // Deliberately ignore cancellation to exercise the final fence.
		return nil, os.WriteFile(filepath.Join(staging, "ollama"), []byte("downloaded-runtime"), 0o755)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), Commands: commands,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Header: make(http.Header),
				Body: io.NopCloser(bytes.NewReader(archive)), Request: request,
			}, nil
		}),
	})
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
	result := make(chan error, 1)
	go func() {
		_, err := manager.ensureRuntime(context.Background(), policy, dependencyPath)
		result <- err
	}()
	select {
	case <-extractStarted:
	case <-time.After(time.Second):
		t.Fatal("runtime install did not reach extraction")
	}
	disabled := managedOllamaTestPolicy(policy.Policy.ModelStoragePath, 2, false, false)
	if err := manager.enforcePolicy(context.Background(), disabled); err != nil {
		t.Fatal(err)
	}
	close(extractRelease)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("policy change did not fence runtime install commit")
		}
	case <-time.After(time.Second):
		t.Fatal("runtime install did not finish after cancellation")
	}
	if _, _, err := manager.installedRuntime(); !errors.Is(err, errManagedOllamaRuntimeMissing) {
		t.Fatalf("policy-revoked install committed a runtime: %v", err)
	}
}

func TestManagedOllamaConcurrentStartUsesOneProcessAndPauseWins(t *testing.T) {
	base := t.TempDir()
	process := newManagedOllamaTestProcess(true)
	commands := &managedOllamaTestCommands{}
	commands.start = func(_ string, arguments, environment []string, _ string, _, _ io.Writer) (managedOllamaProcess, error) {
		if len(arguments) != 1 || arguments[0] != "serve" {
			t.Fatalf("unexpected start args: %v", arguments)
		}
		return process, nil
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), GOOS: "linux", GOARCH: "amd64",
		ListenAddress: "127.0.0.1:18081", CUDAVisibleDevices: "0", Commands: commands,
		StartupTimeout: time.Second, ShutdownTimeout: time.Second,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.String() != "http://127.0.0.1:18081/api/version" {
				t.Fatalf("unexpected readiness URL: %s", request.URL)
			}
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"version":"0.33.2"}`)), Request: request}, nil
		}),
	})
	installManagedOllamaTestRuntime(t, manager, strings.Repeat("c", 64))
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
	const starters = 12
	errorsByStart := make(chan error, starters)
	var group sync.WaitGroup
	for range starters {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := manager.start(context.Background(), policy)
			errorsByStart <- err
		}()
	}
	group.Wait()
	close(errorsByStart)
	for err := range errorsByStart {
		if err != nil {
			t.Fatal(err)
		}
	}
	commands.mu.Lock()
	starts := commands.starts
	environment := append([]string{}, commands.startEnvs[0]...)
	commands.mu.Unlock()
	if starts != 1 {
		t.Fatalf("concurrent start launched %d processes", starts)
	}
	joined := "\n" + strings.Join(environment, "\n") + "\n"
	for _, expected := range []string{"\nCUDA_VISIBLE_DEVICES=0\n", "\nOLLAMA_HOST=127.0.0.1:18081\n", "\nOLLAMA_MODELS=" + policy.Policy.ModelStoragePath + "\n"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("child environment omitted %q: %v", expected, environment)
		}
	}
	if strings.Contains(joined, "NVIDIA_VISIBLE_DEVICES") {
		t.Fatalf("arbitrary inherited GPU environment leaked: %v", environment)
	}
	encodedStatus, _ := json.Marshal(manager.status(policy))
	for _, forbidden := range []string{"pid", "uuid", "serial", "device_id"} {
		if strings.Contains(strings.ToLower(string(encodedStatus)), forbidden) {
			t.Fatalf("status leaks forbidden identifier %q: %s", forbidden, encodedStatus)
		}
	}
	paused := managedOllamaTestPolicy(policy.Policy.ModelStoragePath, 2, true, true)
	if err := manager.enforcePolicy(context.Background(), paused); err != nil {
		t.Fatal(err)
	}
	process.mu.Lock()
	signals := append([]os.Signal{}, process.signals...)
	kills := process.kills
	process.mu.Unlock()
	if len(signals) != 1 || signals[0] != syscall.SIGTERM || kills != 0 {
		t.Fatalf("pause did not perform graceful bounded stop: signals=%v kills=%d", signals, kills)
	}
	if _, err := manager.start(context.Background(), policy); err == nil {
		t.Fatal("stale pre-pause policy restarted Ollama")
	}
}

func TestManagedOllamaPullRequiresReadyManagedServerAndPinsManifest(t *testing.T) {
	base := t.TempDir()
	manifestBytes, blobs := managedOllamaTestModelManifest()
	manifestDigest := "sha256:" + managedOllamaTestSHA(manifestBytes)
	storage := filepath.Join(base, "models")
	process := newManagedOllamaTestProcess(true)
	commands := &managedOllamaTestCommands{}
	commands.start = func(_ string, _ []string, _ []string, _ string, _, _ io.Writer) (managedOllamaProcess, error) {
		return process, nil
	}
	commands.run = func(_ context.Context, path string, arguments, environment []string, _ string, _ int64) ([]byte, error) {
		if filepath.Base(path) != "ollama" || len(arguments) != 2 || arguments[0] != "pull" || arguments[1] != "qwen2.5:0.5b" {
			t.Fatalf("pull escaped pinned command: %q %v", path, arguments)
		}
		models := ""
		for _, value := range environment {
			if strings.HasPrefix(value, "OLLAMA_MODELS=") {
				models = strings.TrimPrefix(value, "OLLAMA_MODELS=")
			}
		}
		return nil, writeManagedOllamaTestModel(models, manifestBytes, blobs)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), GOOS: "linux", GOARCH: "amd64", Commands: commands,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok")), Request: request}, nil
		}),
	})
	installManagedOllamaTestRuntime(t, manager, strings.Repeat("d", 64))
	policy := managedOllamaTestPolicy(storage, 1, false, true)
	catalogPath := writeManagedOllamaTestCatalog(t, base, manifestDigest)
	planned := plannedModelDownload{ModelID: "hf:qwen/qwen2.5-0.5b-instruct", Bytes: 16}
	if _, err := manager.pullModel(context.Background(), policy, catalogPath, planned); err == nil {
		t.Fatal("pull ran without a ready managed server")
	}
	if _, err := manager.start(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	record, err := manager.pullModel(context.Background(), policy, catalogPath, planned)
	if err != nil || record.ManifestSHA256 != manifestDigest {
		t.Fatalf("pinned pull failed: %+v %v", record, err)
	}
	rogue := filepath.Join(storage, "manifests", "rogue", "model")
	if err := os.MkdirAll(filepath.Dir(rogue), 0o700); err != nil || os.WriteFile(rogue, []byte("rogue"), 0o600) != nil {
		t.Fatal("cannot prepare rogue model")
	}
	inventory, err := manager.managedInventory(policy)
	if err != nil || len(inventory) != 1 || inventory[0] != planned.ModelID {
		t.Fatalf("managed-only inventory failed: %v %v", inventory, err)
	}
	if _, err := manager.authorizeModelActivation(policy, catalogPath, planned.ModelID); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
	if err := os.WriteFile(manifestPath, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.authorizeModelActivation(policy, catalogPath, planned.ModelID); err == nil {
		t.Fatal("tampered manifest was activated")
	}
	if err := manager.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestManagedOllamaCatalogVerificationAttestsEveryManifestBlob(t *testing.T) {
	mutations := map[string]func(*testing.T, string, []byte, map[string][]byte, *providerModelCatalogEntry){
		"missing blob": func(t *testing.T, storage string, _ []byte, blobs map[string][]byte, _ *providerModelCatalogEntry) {
			for digest := range blobs {
				if err := os.Remove(filepath.Join(storage, "blobs", strings.Replace(digest, ":", "-", 1))); err != nil {
					t.Fatal(err)
				}
				break
			}
		},
		"corrupted blob": func(t *testing.T, storage string, _ []byte, blobs map[string][]byte, _ *providerModelCatalogEntry) {
			for digest, content := range blobs {
				corrupt := bytes.Repeat([]byte{'x'}, len(content))
				if bytes.Equal(corrupt, content) {
					corrupt[0] = 'y'
				}
				if err := os.WriteFile(filepath.Join(storage, "blobs", strings.Replace(digest, ":", "-", 1)), corrupt, 0o600); err != nil {
					t.Fatal(err)
				}
				break
			}
		},
		"symlinked blob": func(t *testing.T, storage string, _ []byte, blobs map[string][]byte, _ *providerModelCatalogEntry) {
			for digest, content := range blobs {
				path := filepath.Join(storage, "blobs", strings.Replace(digest, ":", "-", 1))
				external := filepath.Join(t.TempDir(), "external-blob")
				if err := os.WriteFile(external, content, 0o600); err != nil || os.Remove(path) != nil || os.Symlink(external, path) != nil {
					t.Fatal("cannot replace blob with symlink")
				}
				break
			}
		},
		"symlinked manifest": func(t *testing.T, storage string, manifest []byte, _ map[string][]byte, _ *providerModelCatalogEntry) {
			path := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
			external := filepath.Join(t.TempDir(), "external-manifest")
			if err := os.WriteFile(external, manifest, 0o600); err != nil || os.Remove(path) != nil || os.Symlink(external, path) != nil {
				t.Fatal("cannot replace manifest with symlink")
			}
		},
		"unknown manifest field": func(t *testing.T, storage string, manifest []byte, _ map[string][]byte, entry *providerModelCatalogEntry) {
			altered := append(append([]byte{}, manifest[:len(manifest)-1]...), []byte(`,"unexpected":true}`)...)
			entry.ContentDigest = "sha256:" + managedOllamaTestSHA(altered)
			path := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
			if err := os.WriteFile(path, altered, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"noncanonical blob digest": func(t *testing.T, storage string, manifest []byte, _ map[string][]byte, entry *providerModelCatalogEntry) {
			var document managedOllamaModelManifest
			if err := json.Unmarshal(manifest, &document); err != nil {
				t.Fatal(err)
			}
			document.Layers[0].Digest = strings.ToUpper(document.Layers[0].Digest)
			altered, _ := json.Marshal(document)
			entry.ContentDigest = "sha256:" + managedOllamaTestSHA(altered)
			path := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
			if err := os.WriteFile(path, altered, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"declared blob size mismatch": func(t *testing.T, storage string, manifest []byte, _ map[string][]byte, entry *providerModelCatalogEntry) {
			var document managedOllamaModelManifest
			if err := json.Unmarshal(manifest, &document); err != nil {
				t.Fatal(err)
			}
			document.Layers[0].Size++
			altered, _ := json.Marshal(document)
			entry.ContentDigest = "sha256:" + managedOllamaTestSHA(altered)
			path := filepath.Join(storage, "manifests", "registry.ollama.ai", "library", "qwen2.5", "0.5b")
			if err := os.WriteFile(path, altered, 0o600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			storage := filepath.Join(base, "models")
			if err := ensureManagedOllamaModelStorage(storage); err != nil {
				t.Fatal(err)
			}
			manifest, blobs := managedOllamaTestModelManifest()
			if err := writeManagedOllamaTestModel(storage, manifest, blobs); err != nil {
				t.Fatal(err)
			}
			catalogPath := writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifest))
			catalog, err := openProviderModelCatalog(catalogPath)
			if err != nil {
				t.Fatal(err)
			}
			entry := catalog.Models[0]
			mutate(t, storage, manifest, blobs, &entry)
			manager := newManagedOllamaTestManager(t, managedOllamaConfig{ManagedRoot: filepath.Join(base, "managed")})
			if _, err := manager.verifyCatalogModel(storage, entry); err == nil {
				t.Fatal("unsafe model artifact was accepted")
			}
		})
	}
}

func TestManagedOllamaCatalogVerificationAcceptsStrictManifestAndBlobs(t *testing.T) {
	base := t.TempDir()
	storage := filepath.Join(base, "models")
	if err := ensureManagedOllamaModelStorage(storage); err != nil {
		t.Fatal(err)
	}
	manifest, blobs := managedOllamaTestModelManifest()
	if err := writeManagedOllamaTestModel(storage, manifest, blobs); err != nil {
		t.Fatal(err)
	}
	catalog, err := openProviderModelCatalog(writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifest)))
	if err != nil {
		t.Fatal(err)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{ManagedRoot: filepath.Join(base, "managed")})
	record, err := manager.verifyCatalogModel(storage, catalog.Models[0])
	if err != nil || record.ManifestSHA256 != catalog.Models[0].ContentDigest {
		t.Fatalf("strict model fixture rejected: %#v %v", record, err)
	}
}

func TestManagedOllamaStableFileDetectsPathReplacement(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "blob")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, before, err := openManagedOllamaStableRegularFile(path, 64, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	replacement := filepath.Join(directory, "replacement")
	if err := os.WriteFile(replacement, []byte("original"), 0o600); err != nil || os.Rename(replacement, path) != nil {
		t.Fatal("cannot atomically replace test file")
	}
	if err := finishManagedOllamaStableRegularFile(path, file, before); err == nil {
		t.Fatal("path replacement during verification was not detected")
	}
}

func TestManagedOllamaInstalledRuntimeReattestsWholeTree(t *testing.T) {
	mutations := map[string]func(*testing.T, *managedOllama, string){
		"binary corruption": func(t *testing.T, _ *managedOllama, binary string) {
			if err := os.WriteFile(binary, []byte("evil-ollama"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"binary replacement": func(t *testing.T, _ *managedOllama, binary string) {
			replacement := binary + ".replacement"
			if err := os.WriteFile(replacement, []byte("evil-ollama"), 0o755); err != nil || os.Rename(replacement, binary) != nil {
				t.Fatal("cannot replace runtime binary")
			}
		},
		"binary symlink": func(t *testing.T, _ *managedOllama, binary string) {
			external := filepath.Join(t.TempDir(), "ollama")
			if err := os.WriteFile(external, []byte("test-ollama"), 0o755); err != nil || os.Remove(binary) != nil || os.Symlink(external, binary) != nil {
				t.Fatal("cannot replace runtime binary with symlink")
			}
		},
		"missing binary": func(t *testing.T, _ *managedOllama, binary string) {
			if err := os.Remove(binary); err != nil {
				t.Fatal(err)
			}
		},
		"unexpected file": func(t *testing.T, manager *managedOllama, _ string) {
			if err := os.WriteFile(filepath.Join(manager.runtimeDirectory(), "injected"), []byte("payload"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			manager := newManagedOllamaTestManager(t, managedOllamaConfig{ManagedRoot: filepath.Join(t.TempDir(), "managed")})
			installManagedOllamaTestRuntime(t, manager, strings.Repeat("a", 64))
			binary, _, err := manager.installedRuntime()
			if err != nil {
				t.Fatal(err)
			}
			mutate(t, manager, binary)
			if _, _, err := manager.installedRuntime(); err == nil {
				t.Fatal("mutated installed runtime passed full-tree attestation")
			}
		})
	}
}

func TestManagedOllamaPolicyChangeFencesModelInventoryCommit(t *testing.T) {
	base := t.TempDir()
	manifestBytes, blobs := managedOllamaTestModelManifest()
	manifestDigest := "sha256:" + managedOllamaTestSHA(manifestBytes)
	storage := filepath.Join(base, "models")
	pullStarted := make(chan struct{})
	pullRelease := make(chan struct{})
	process := newManagedOllamaTestProcess(true)
	commands := &managedOllamaTestCommands{}
	commands.start = func(_ string, _ []string, _ []string, _ string, _, _ io.Writer) (managedOllamaProcess, error) {
		return process, nil
	}
	commands.run = func(_ context.Context, _ string, _ []string, environment []string, _ string, _ int64) ([]byte, error) {
		close(pullStarted)
		<-pullRelease // Deliberately ignore cancellation to exercise the final fence.
		models := ""
		for _, value := range environment {
			if strings.HasPrefix(value, "OLLAMA_MODELS=") {
				models = strings.TrimPrefix(value, "OLLAMA_MODELS=")
			}
		}
		return nil, writeManagedOllamaTestModel(models, manifestBytes, blobs)
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), GOOS: "linux", GOARCH: "amd64", Commands: commands,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok")), Request: request}, nil
		}),
	})
	installManagedOllamaTestRuntime(t, manager, strings.Repeat("d", 64))
	policy := managedOllamaTestPolicy(storage, 1, false, true)
	if _, err := manager.start(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	catalogPath := writeManagedOllamaTestCatalog(t, base, manifestDigest)
	planned := plannedModelDownload{ModelID: "hf:qwen/qwen2.5-0.5b-instruct", Bytes: 16}
	result := make(chan error, 1)
	go func() {
		_, err := manager.pullModel(context.Background(), policy, catalogPath, planned)
		result <- err
	}()
	select {
	case <-pullStarted:
	case <-time.After(time.Second):
		t.Fatal("model pull did not start")
	}
	disabled := managedOllamaTestPolicy(storage, 2, false, false)
	if err := manager.enforcePolicy(context.Background(), disabled); err != nil {
		t.Fatal(err)
	}
	close(pullRelease)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("policy change did not fence managed model inventory")
		}
	case <-time.After(time.Second):
		t.Fatal("model pull did not finish after cancellation")
	}
	inventory, err := manager.managedInventory(disabled)
	if err != nil || len(inventory) != 0 {
		t.Fatalf("revoked pull entered managed inventory: %v %v", inventory, err)
	}
	if err := manager.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestManagedOllamaStopEscalatesFromTermToBoundedKill(t *testing.T) {
	base := t.TempDir()
	process := newManagedOllamaTestProcess(false)
	commands := &managedOllamaTestCommands{}
	commands.start = func(_ string, _ []string, _ []string, _ string, _, _ io.Writer) (managedOllamaProcess, error) {
		return process, nil
	}
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), Commands: commands,
		StartupTimeout: time.Second, ShutdownTimeout: 5 * time.Millisecond, KillTimeout: time.Second,
		HTTPTransport: managedOllamaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok")), Request: request}, nil
		}),
	})
	installManagedOllamaTestRuntime(t, manager, strings.Repeat("a", 64))
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
	if _, err := manager.start(context.Background(), policy); err != nil {
		t.Fatal(err)
	}
	if err := manager.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	if len(process.signals) != 1 || process.signals[0] != syscall.SIGTERM || process.kills != 1 {
		t.Fatalf("stop escalation mismatch: signals=%v kills=%d", process.signals, process.kills)
	}
}

func writeManagedOllamaTestCatalog(t *testing.T, directory, digest string) string {
	t.Helper()
	document := map[string]any{
		"schema_version": providerModelCatalogSchemaVersion,
		"models": []any{map[string]any{
			"canonical_model_id": "hf:qwen/qwen2.5-0.5b-instruct", "ollama_model": "qwen2.5:0.5b",
			"ollama_manifest_path": "registry.ollama.ai/library/qwen2.5/0.5b", "content_digest": digest,
			"download_bytes_hex": "0x10", "gpu_utilization_percent": 50,
			"vram_estimates": []any{map[string]any{"context_tokens": 2048, "estimated_vram_bytes_hex": "0x1000"}},
			"license": map[string]any{
				"license_id": "Apache-2.0", "hosted_inference_allowed": true,
				"assessment_path":   "provider-model-license-assessments/test-model.md",
				"assessment_digest": strings.Repeat("e", 64),
			},
		}},
	}
	encoded, _ := json.Marshal(document)
	path := filepath.Join(directory, "catalog.json")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func TestManagedOllamaRejectsUnsafeArchivePathsAndDownloadWithoutConsent(t *testing.T) {
	for _, listing := range [][]byte{
		[]byte("../escape\n"), []byte("/absolute\n"), []byte("safe\n../../escape\n"), []byte("bad\\windows\n"),
	} {
		if err := validateManagedOllamaArchiveListing(listing); err == nil {
			t.Fatalf("unsafe archive listing accepted: %q", listing)
		}
	}
	if err := validateManagedOllamaArchiveListing([]byte("bin/ollama\nlib/ollama/library.so\n")); err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	networkCalls := 0
	manager := newManagedOllamaTestManager(t, managedOllamaConfig{
		ManagedRoot: filepath.Join(base, "managed"), Commands: &managedOllamaTestCommands{},
		HTTPTransport: managedOllamaRoundTripFunc(func(*http.Request) (*http.Response, error) {
			networkCalls++
			return nil, errors.New("unexpected network")
		}),
	})
	dependencies := writeManagedOllamaTestDependencies(t, base, strings.Repeat("f", 64))
	if _, err := manager.ensureRuntime(context.Background(), managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, false), dependencies); !errors.Is(err, errManagedOllamaDownloadsDisabled) {
		t.Fatalf("download without explicit consent did not fail closed: %v", err)
	}
	if networkCalls != 0 {
		t.Fatal("network was used without automatic-download consent")
	}
}
