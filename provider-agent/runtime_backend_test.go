package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	runtimebackendapi "github.com/thibautrey/multivibe/provider-agent/runtimebackend"
	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)

func (runtime *managedControllerTestRuntime) ensureRuntimePinned(ctx context.Context, policy *capacityPolicyStateDocument, manifest managedOllamaDependencyManifest) (managedOllamaStatus, error) {
	if validateManagedOllamaDependencyManifest(manifest) != nil {
		return managedOllamaStatus{}, errors.New("invalid pinned dependency")
	}
	runtime.record("pinned-dependency:" + manifest.Ollama.Artifacts["darwin-arm64"].SHA256)
	return runtime.ensureRuntime(ctx, policy, "")
}

func (runtime *managedControllerTestRuntime) pullModelResultPinned(ctx context.Context, policy *capacityPolicyStateDocument, catalog providerModelCatalog, download plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	if validateProviderModelCatalog(&catalog) != nil {
		return managedOllamaModelRecord{}, false, errors.New("invalid pinned catalog")
	}
	entry, found := catalog.entry(download.ModelID)
	if !found || entry.DownloadBytes != download.Bytes {
		return managedOllamaModelRecord{}, false, errors.New("model absent from pinned catalog")
	}
	runtime.record("pinned-pull:" + entry.ContentDigest)
	record, changed, err := runtime.pullModelResult(ctx, policy, "", download)
	if err == nil {
		record.ManifestSHA256 = entry.ContentDigest
	}
	return record, changed, err
}

func (runtime *managedControllerTestRuntime) authorizeModelActivationPinned(policy *capacityPolicyStateDocument, catalog providerModelCatalog, modelID string) (managedOllamaModelRecord, error) {
	if validateProviderModelCatalog(&catalog) != nil {
		return managedOllamaModelRecord{}, errors.New("invalid pinned catalog")
	}
	entry, found := catalog.entry(modelID)
	if !found {
		return managedOllamaModelRecord{}, errors.New("model absent from pinned catalog")
	}
	runtime.record("pinned-authorize:" + entry.ContentDigest)
	record, err := runtime.authorizeModelActivation(policy, "", modelID)
	if err == nil {
		record.ManifestSHA256 = entry.ContentDigest
	}
	return record, err
}

func (runtime *managedControllerTestRuntime) deactivateModelPinned(ctx context.Context, policy *capacityPolicyStateDocument, catalog providerModelCatalog, modelID string) error {
	if validateProviderModelCatalog(&catalog) != nil {
		return errors.New("invalid pinned catalog")
	}
	entry, found := catalog.entry(modelID)
	if !found {
		return errors.New("model absent from pinned catalog")
	}
	runtime.record("pinned-deactivate:" + entry.ContentDigest)
	return runtime.deactivateModel(ctx, policy, "", modelID)
}

type mismatchedManifestRuntime struct {
	*managedControllerTestRuntime
}

func (runtime *mismatchedManifestRuntime) pullModelResultPinned(ctx context.Context, policy *capacityPolicyStateDocument, catalog providerModelCatalog, download plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	record, changed, err := runtime.managedControllerTestRuntime.pullModelResultPinned(ctx, policy, catalog, download)
	if err == nil {
		record.ManifestSHA256 = "sha256:" + strings.Repeat("f", 64)
	}
	return record, changed, err
}

type runtimeBackendContractFake struct {
	descriptor runtimeBackendDescriptor
	installed  bool
	running    bool
	models     map[string]runtimeLoadedModel
	executions map[string]struct{}
	metrics    runtimeBackendMetrics
	nextError  error
}

func newRuntimeBackendContractFake(id string, priority uint16) *runtimeBackendContractFake {
	return &runtimeBackendContractFake{
		descriptor: runtimeBackendTestDescriptor(id, priority),
		models:     map[string]runtimeLoadedModel{},
		executions: map[string]struct{}{},
		metrics:    runtimeBackendMetrics{SchemaVersion: runtimeBackendMetricsVersion},
	}
}

func runtimeBackendTestDescriptor(id string, priority uint16) runtimeBackendDescriptor {
	return runtimeBackendDescriptor{
		ContractVersion: runtimeBackendContractVersion,
		ID:              id,
		Priority:        priority,
		Capabilities: runtimeBackendCapabilities{
			Prepare: true, Load: true, Execute: true, Stream: true, Cancel: true,
			Health: true, Readiness: true, Metrics: true, Cleanup: true, Stop: true,
			ShadowOnly: true, CustomerTraffic: false,
		},
		Accelerators: []runtimeBackendAcceleratorConstraint{
			{Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda"},
		},
		Launch: runtimeBackendLaunchAllowlist{
			ExecutableRelativePaths: map[string]string{"linux-amd64": "bin/runtime"},
			ArgumentTemplates:       [][]string{{"serve"}, {"load", "{catalog_model}"}},
			Resources: runtimeBackendResourceBounds{
				MaximumModels: 8, MaximumConcurrency: 4, MaximumModelBytes: 1024, MaximumMemoryBytes: 8192,
				MaximumContextTokens: 8192, MaximumCommandOutput: 4096,
				MaximumInstallSeconds: 60, MaximumPrepareSeconds: 60,
			},
			Provenance: runtimeBackendProvenance{
				SourceURL: "https://example.test/runtime", Version: "1.0.0",
				ArtifactSHA256: map[string]string{"linux-amd64": strings.Repeat("a", 64)},
			},
		},
	}
}

func runtimeBackendTestProfile(backendIDs ...string) runtimeWorkloadProfile {
	profile := runtimeWorkloadProfile{
		SchemaVersion: runtimeWorkloadProfileVersion,
		Model: runtimeModelProfile{
			ModelID: "hf:qwen/qwen2.5-0.5b-instruct", CompatibleBackendIDs: append([]string{}, backendIDs...),
			ContentDigest: "sha256:" + strings.Repeat("b", 64), AssessmentDigest: strings.Repeat("c", 64),
			RequiredContext: 2048, EstimatedVRAMBytes: 4096, DownloadBytes: 16,
		},
		Accelerator: runtimeAcceleratorProfile{
			Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda", MemoryBytes: 8192,
		},
		Runtime: runtimeProfile{
			ContractVersion:      runtimeBackendContractVersion,
			RequiredCapabilities: runtimeCapabilityRequirements{Cleanup: true},
			Provenance:           []runtimeProvenancePin{},
		},
	}
	for _, backendID := range backendIDs {
		profile.Runtime.Provenance = append(profile.Runtime.Provenance, runtimeProvenancePinFromDescriptor(runtimeBackendTestDescriptor(backendID, 1)))
	}
	return profile
}

func runtimeBackendTestOverrides() runtimeBackendOverrides {
	return runtimeBackendOverrides{SchemaVersion: runtimeBackendOverridesVersion}
}

func (backend *runtimeBackendContractFake) ContractVersion() string {
	return runtimeBackendContractVersion
}

func (backend *runtimeBackendContractFake) Descriptor() runtimeBackendDescriptor {
	return cloneRuntimeBackendDescriptor(backend.descriptor)
}

func (backend *runtimeBackendContractFake) Capabilities(context.Context) (runtimeBackendCapabilities, error) {
	return backend.descriptor.Capabilities, nil
}

func (backend *runtimeBackendContractFake) Compatible(profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) bool {
	return validateRuntimeWorkloadProfile(profile) == nil && overrides.SchemaVersion == runtimeBackendOverridesVersion &&
		runtimeBackendSupportsProfile(backend.descriptor, profile, overrides)
}

func (backend *runtimeBackendContractFake) Prepare(context.Context, runtimePrepareRequest) (runtimeBackendHealth, error) {
	backend.installed = true
	return backend.health(), nil
}

func (backend *runtimeBackendContractFake) Load(_ context.Context, request runtimeLoadRequest) (runtimeLoadedModel, error) {
	if !backend.installed || !backend.Compatible(request.Profile, runtimeBackendTestOverrides()) {
		return runtimeLoadedModel{}, errRuntimeBackendIncompatible
	}
	backend.running = true
	loaded := runtimeLoadedModel{BackendID: backend.descriptor.ID, ModelID: request.Profile.Model.ModelID, ContentDigest: request.Profile.Model.ContentDigest}
	backend.models[loaded.ModelID] = loaded
	return loaded, nil
}

func (backend *runtimeBackendContractFake) Execute(ctx context.Context, request runtimeExecuteRequest) (runtimeExecuteResult, error) {
	if ctx.Err() != nil {
		backend.metrics.CancelledExecutions++
		return runtimeExecuteResult{}, errRuntimeBackendCancelled
	}
	if backend.nextError != nil {
		err := backend.nextError
		backend.nextError = nil
		backend.metrics.ExecutionErrors++
		switch {
		case errors.Is(err, errRuntimeBackendOutOfMemory):
			backend.metrics.OutOfMemoryErrors++
		case errors.Is(err, errRuntimeBackendCrashed):
			backend.metrics.CrashErrors++
		case errors.Is(err, errRuntimeBackendTimedOut):
			backend.metrics.TimeoutErrors++
		}
		return runtimeExecuteResult{}, err
	}
	if !backend.running || !runtimeExecutionIDPattern.MatchString(request.ExecutionID) || request.ModelID == "" || request.MaximumOutput == 0 ||
		uint64(len(request.Input)) > request.MaximumOutput {
		return runtimeExecuteResult{}, errRuntimeBackendInvalid
	}
	if _, duplicate := backend.executions[request.ExecutionID]; duplicate {
		return runtimeExecuteResult{}, errRuntimeBackendInvalid
	}
	backend.executions[request.ExecutionID] = struct{}{}
	backend.metrics.ExecutionSamples++
	backend.metrics.PrefillMillisecondsP50 = 1
	backend.metrics.TimeToFirstTokenMillisecondsP50 = 2
	backend.metrics.TokensPerSecondMilliP50 = 1000
	backend.metrics.MemoryBytes = 4096
	return runtimeExecuteResult{Output: append([]byte{}, request.Input...)}, nil
}

func (backend *runtimeBackendContractFake) ExecuteStream(ctx context.Context, request runtimeExecuteRequest, emit func(runtimeExecuteChunk) error) (runtimeExecutionSummary, error) {
	if emit == nil {
		return runtimeExecutionSummary{}, errRuntimeBackendInvalid
	}
	result, err := backend.Execute(ctx, request)
	if err != nil {
		return runtimeExecutionSummary{}, err
	}
	if err := emit(runtimeExecuteChunk{Output: result.Output, Final: true}); err != nil {
		return runtimeExecutionSummary{}, err
	}
	return runtimeExecutionSummary{OutputBytes: uint64(len(result.Output)), OutputTokens: 1}, nil
}

func (backend *runtimeBackendContractFake) Cancel(_ context.Context, executionID string) error {
	if !runtimeExecutionIDPattern.MatchString(executionID) {
		return errRuntimeBackendInvalid
	}
	if _, found := backend.executions[executionID]; !found {
		return errRuntimeBackendExecutionUnknown
	}
	delete(backend.executions, executionID)
	backend.metrics.CancelledExecutions++
	return nil
}

func (backend *runtimeBackendContractFake) Health(context.Context, *capacityPolicyStateDocument) (runtimeBackendHealth, error) {
	return backend.health(), nil
}

func (backend *runtimeBackendContractFake) health() runtimeBackendHealth {
	state := "not-installed"
	if backend.installed {
		state = "stopped"
	}
	if backend.running {
		state = "running"
	}
	return runtimeBackendHealth{State: state, Installed: backend.installed, Running: backend.running}
}

func (backend *runtimeBackendContractFake) Ready(context.Context, *capacityPolicyStateDocument) (bool, error) {
	return backend.installed && backend.running, nil
}

func (backend *runtimeBackendContractFake) Metrics(context.Context, *capacityPolicyStateDocument) (runtimeBackendMetrics, error) {
	metrics := backend.metrics
	metrics.Running = backend.running
	metrics.InstalledModels = uint32(len(backend.models))
	return metrics, nil
}

func (backend *runtimeBackendContractFake) Cleanup(_ context.Context, request runtimeCleanupRequest) error {
	for _, modelID := range request.ModelIDs {
		delete(backend.models, modelID)
	}
	if request.StopRuntime {
		backend.running = false
	}
	backend.executions = map[string]struct{}{}
	return nil
}

func (backend *runtimeBackendContractFake) Stop(context.Context) error {
	backend.running = false
	return nil
}

func runRuntimeBackendContract(t *testing.T, backend runtimeBackend, profile runtimeWorkloadProfile, policy *capacityPolicyStateDocument, download *plannedModelDownload) {
	t.Helper()
	descriptor := backend.Descriptor()
	if backend.ContractVersion() != runtimeBackendContractVersion || validateRuntimeBackendDescriptor(descriptor) != nil {
		t.Fatalf("invalid backend descriptor: %#v", descriptor)
	}
	capabilities, err := backend.Capabilities(context.Background())
	if err != nil || !reflect.DeepEqual(capabilities, descriptor.Capabilities) {
		t.Fatalf("capability contract mismatch: %#v %#v %v", capabilities, descriptor.Capabilities, err)
	}
	if !backend.Compatible(profile, runtimeBackendTestOverrides()) {
		t.Fatal("backend rejected its declared compatible profile")
	}
	mutated := backend.Descriptor()
	mutated.Accelerators[0].Profile = "mutated"
	for platform := range mutated.Launch.ExecutableRelativePaths {
		mutated.Launch.ExecutableRelativePaths[platform] = "mutated"
	}
	mutated.Launch.ArgumentTemplates[0][0] = "mutated"
	for platform := range mutated.Launch.Provenance.ArtifactSHA256 {
		mutated.Launch.Provenance.ArtifactSHA256[platform] = strings.Repeat("0", 64)
	}
	if !reflect.DeepEqual(backend.Descriptor(), descriptor) {
		t.Fatal("descriptor allowlists were mutable through a returned view")
	}
	health, err := backend.Prepare(context.Background(), runtimePrepareRequest{Policy: policy})
	if err != nil || !health.Installed {
		t.Fatalf("prepare contract failed: %#v %v", health, err)
	}
	loaded, err := backend.Load(context.Background(), runtimeLoadRequest{Policy: policy, Profile: profile, Download: download})
	if err != nil || loaded.BackendID != descriptor.ID || loaded.ModelID != profile.Model.ModelID || loaded.ContentDigest != profile.Model.ContentDigest {
		t.Fatalf("load contract failed: %#v %v", loaded, err)
	}
	ready, err := backend.Ready(context.Background(), policy)
	if err != nil || !ready {
		t.Fatalf("readiness contract failed: ready=%v err=%v", ready, err)
	}
	metrics, err := backend.Metrics(context.Background(), policy)
	if err != nil || validateRuntimeBackendMetrics(descriptor, metrics) != nil || !metrics.Running || metrics.InstalledModels != 1 {
		t.Fatalf("metrics contract failed: %#v %v", metrics, err)
	}
	request := runtimeExecuteRequest{ExecutionID: "contract-execute", ModelID: profile.Model.ModelID, Input: []byte("probe"), MaximumOutput: 16}
	result, executeErr := backend.Execute(context.Background(), request)
	if descriptor.Capabilities.Execute {
		if executeErr != nil || string(result.Output) != "probe" {
			t.Fatalf("execute contract failed: %q %v", result.Output, executeErr)
		}
	} else if !errors.Is(executeErr, errRuntimeBackendExecutionDisabled) || len(result.Output) != 0 {
		t.Fatalf("shadow-only execution did not fail closed: %q %v", result.Output, executeErr)
	}
	streamed := []byte{}
	streamRequest := request
	streamRequest.ExecutionID = "contract-stream"
	summary, streamErr := backend.ExecuteStream(context.Background(), streamRequest, func(chunk runtimeExecuteChunk) error {
		streamed = append(streamed, chunk.Output...)
		return nil
	})
	if descriptor.Capabilities.Stream {
		if streamErr != nil || string(streamed) != "probe" || summary.OutputBytes != uint64(len(streamed)) {
			t.Fatalf("stream contract failed: %q %#v %v", streamed, summary, streamErr)
		}
	} else if !errors.Is(streamErr, errRuntimeBackendExecutionDisabled) {
		t.Fatalf("disabled stream capability did not fail closed: %v", streamErr)
	}
	if descriptor.Capabilities.Cancel {
		if err := backend.Cancel(context.Background(), request.ExecutionID); err != nil {
			t.Fatalf("cancel contract failed: %v", err)
		}
	} else if err := backend.Cancel(context.Background(), request.ExecutionID); !errors.Is(err, errRuntimeBackendCapabilityMissing) {
		t.Fatalf("disabled cancel capability did not fail closed: %v", err)
	}
	if err := backend.Cleanup(context.Background(), runtimeCleanupRequest{Policy: policy, ModelIDs: []string{profile.Model.ModelID}, StopRuntime: true}); err != nil {
		t.Fatalf("cleanup contract failed: %v", err)
	}
	if err := backend.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	health, err = backend.Health(context.Background(), policy)
	if err != nil || health.Running {
		t.Fatalf("stop/health contract failed: %#v %v", health, err)
	}
}

func TestRuntimeBackendContractAgainstFakeAndOllama(t *testing.T) {
	t.Run("fake", func(t *testing.T) {
		backend := newRuntimeBackendContractFake("fake-runtime", 10)
		runRuntimeBackendContract(t, backend, runtimeBackendTestProfile("fake-runtime"), nil, nil)
	})
	t.Run("ollama", func(t *testing.T) {
		base := t.TempDir()
		manifest := []byte(`{"schemaVersion":2,"layers":[]}`)
		catalogPath := writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifest))
		dependencyPath := writeManagedOllamaTestDependencies(t, base, strings.Repeat("d", 64))
		runtime := &managedControllerTestRuntime{}
		backend, err := newOllamaRuntimeBackend(runtime, catalogPath, dependencyPath)
		if err != nil {
			t.Fatal(err)
		}
		profile := runtimeBackendTestProfile(runtimeBackendOllamaID)
		profile.Runtime.Provenance = []runtimeProvenancePin{runtimeProvenancePinFromDescriptor(backend.Descriptor())}
		profile.Model.ContentDigest = "sha256:" + managedOllamaTestSHA(manifest)
		profile.Model.AssessmentDigest = strings.Repeat("e", 64)
		policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 1, false, true)
		download := &plannedModelDownload{ModelID: profile.Model.ModelID, Bytes: profile.Model.DownloadBytes}
		runRuntimeBackendContract(t, backend, profile, policy, download)
	})
}

func TestRuntimeBackendRegistryRequiresExplicitFallbacks(t *testing.T) {
	alpha := newRuntimeBackendContractFake("alpha", 20)
	beta := newRuntimeBackendContractFake("beta", 10)
	gamma := newRuntimeBackendContractFake("gamma", 10)
	profile := runtimeBackendTestProfile("alpha", "beta", "gamma")

	selected, err := selectRuntimeBackends([]runtimeBackend{alpha, gamma, beta}, profile, runtimeBackendTestOverrides())
	if err != nil || len(selected) != 1 || selected[0].Descriptor().ID != "beta" {
		t.Fatalf("implicit selection must contain one deterministic primary, got %v %v", runtimeBackendIDs(selected), err)
	}

	overrides := runtimeBackendTestOverrides()
	overrides.PreferredBackendIDs = []string{"gamma", "beta"}
	selected, err = selectRuntimeBackends([]runtimeBackend{beta, alpha, gamma}, profile, overrides)
	if err != nil || !reflect.DeepEqual(runtimeBackendIDs(selected), []string{"gamma", "beta"}) {
		t.Fatalf("explicit fallback order was not preserved: %v %v", runtimeBackendIDs(selected), err)
	}
	if strings.Contains(strings.Join(runtimeBackendIDs(selected), ","), "alpha") {
		t.Fatal("an unnamed compatible backend became an implicit fallback")
	}

	overrides = runtimeBackendTestOverrides()
	overrides.DisabledBackendIDs = []string{"beta"}
	selected, err = selectRuntimeBackends([]runtimeBackend{alpha, beta, gamma}, profile, overrides)
	if err != nil || !reflect.DeepEqual(runtimeBackendIDs(selected), []string{"gamma"}) {
		t.Fatalf("deterministic primary after disable mismatch: %v %v", runtimeBackendIDs(selected), err)
	}
}

func runtimeBackendIDs(backends []runtimeBackend) []string {
	ids := make([]string, 0, len(backends))
	for _, backend := range backends {
		ids = append(ids, backend.Descriptor().ID)
	}
	return ids
}

func TestRuntimeBackendRegistryRejectsUnknownAndDuplicateEntries(t *testing.T) {
	first := newRuntimeBackendContractFake("fake", 10)
	duplicate := newRuntimeBackendContractFake("fake", 20)
	if _, err := newRuntimeBackendRegistry(first, duplicate); !errors.Is(err, errRuntimeBackendInvalid) {
		t.Fatalf("duplicate backend accepted: %v", err)
	}
	profile := runtimeBackendTestProfile("fake")
	overrides := runtimeBackendTestOverrides()
	overrides.PreferredBackendIDs = []string{"unknown"}
	if _, err := selectRuntimeBackends([]runtimeBackend{first}, profile, overrides); !errors.Is(err, errRuntimeBackendInvalid) {
		t.Fatalf("unknown fallback accepted: %v", err)
	}
	second := newRuntimeBackendContractFake("second", 20)
	overrides.PreferredBackendIDs = []string{"second"}
	if _, err := selectRuntimeBackends([]runtimeBackend{first, second}, profile, overrides); !errors.Is(err, errRuntimeBackendInvalid) {
		t.Fatalf("fallback absent from model profile accepted: %v", err)
	}
}

func TestRuntimeBackendLaunchPolicyIsImmutableAndStrict(t *testing.T) {
	for _, forbidden := range []string{"Executable", "Image", "Argument", "Provenance", "Source", "Origin"} {
		if _, found := reflect.TypeOf(runtimeBackendOverrides{}).FieldByName(forbidden); found {
			t.Fatalf("runtime override can replace compiled launch policy through %s", forbidden)
		}
	}
	base := runtimeBackendTestDescriptor("fake", 10)
	tests := map[string]func(*runtimeBackendDescriptor){
		"absolute executable": func(value *runtimeBackendDescriptor) {
			value.Launch.ExecutableRelativePaths["linux-amd64"] = "/tmp/runtime"
		},
		"traversing executable": func(value *runtimeBackendDescriptor) {
			value.Launch.ExecutableRelativePaths["linux-amd64"] = "../runtime"
		},
		"shell argument": func(value *runtimeBackendDescriptor) {
			value.Launch.ArgumentTemplates = [][]string{{"serve;id"}}
		},
		"unknown placeholder": func(value *runtimeBackendDescriptor) {
			value.Launch.ArgumentTemplates = [][]string{{"{remote_argument}"}}
		},
		"unpinned image": func(value *runtimeBackendDescriptor) {
			value.Launch.ContainerImages = []string{"registry.example.test/runtime:latest"}
		},
		"artifact mismatch": func(value *runtimeBackendDescriptor) {
			value.Launch.Provenance.ArtifactSHA256 = map[string]string{}
		},
		"mutable provenance URL": func(value *runtimeBackendDescriptor) {
			value.Launch.Provenance.SourceURL = "https://example.test/runtime?version=latest"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			descriptor := cloneRuntimeBackendDescriptor(base)
			mutate(&descriptor)
			if validateRuntimeBackendDescriptor(descriptor) == nil {
				t.Fatalf("unsafe descriptor accepted: %#v", descriptor.Launch)
			}
		})
	}
	containerOnly := cloneRuntimeBackendDescriptor(base)
	containerOnly.Launch.ExecutableRelativePaths = map[string]string{}
	containerOnly.Launch.ContainerImages = []string{"registry.example.test/runtime@sha256:" + strings.Repeat("d", 64)}
	containerOnly.Launch.Provenance.ArtifactSHA256 = map[string]string{}
	if err := validateRuntimeBackendDescriptor(containerOnly); err != nil {
		t.Fatalf("digest-pinned container-only backend rejected: %v", err)
	}
}

func TestOllamaRuntimeBackendRemainsShadowOnly(t *testing.T) {
	base := t.TempDir()
	manifest := []byte(`{"schemaVersion":2,"layers":[]}`)
	backend, err := newOllamaRuntimeBackend(
		&managedControllerTestRuntime{},
		writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifest)),
		writeManagedOllamaTestDependencies(t, base, strings.Repeat("a", 64)),
	)
	if err != nil {
		t.Fatal(err)
	}
	capabilities := backend.Descriptor().Capabilities
	if !capabilities.ShadowOnly || capabilities.CustomerTraffic || capabilities.Execute || capabilities.Stream || capabilities.Cancel {
		t.Fatalf("Ollama adapter crossed the shadow boundary: %#v", capabilities)
	}
	if _, err := backend.Execute(context.Background(), runtimeExecuteRequest{}); !errors.Is(err, errRuntimeBackendExecutionDisabled) {
		t.Fatalf("Ollama execution did not fail closed: %v", err)
	}
}

func TestRuntimeBackendAdversarialProfilesAndMetrics(t *testing.T) {
	backend := newRuntimeBackendContractFake("primary", 10)
	registry, err := newRuntimeBackendRegistry(backend)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("absent backend", func(t *testing.T) {
		profile := runtimeBackendTestProfile("absent")
		if _, err := registry.Select(profile, runtimeBackendTestOverrides()); !errors.Is(err, errRuntimeBackendIncompatible) {
			t.Fatalf("absent backend did not fail closed: %v", err)
		}
	})
	t.Run("incompatible hardware", func(t *testing.T) {
		profile := runtimeBackendTestProfile("primary")
		profile.Accelerator.Kind = "metal"
		if _, err := registry.Select(profile, runtimeBackendTestOverrides()); !errors.Is(err, errRuntimeBackendIncompatible) {
			t.Fatalf("incompatible hardware did not fail closed: %v", err)
		}
	})
	t.Run("invalid profile", func(t *testing.T) {
		profile := runtimeBackendTestProfile("primary")
		profile.Runtime.ContractVersion = "unknown-contract"
		if _, err := registry.Select(profile, runtimeBackendTestOverrides()); !errors.Is(err, errRuntimeBackendInvalid) {
			t.Fatalf("invalid runtime profile was accepted: %v", err)
		}
	})
	t.Run("provenance mismatch", func(t *testing.T) {
		profile := runtimeBackendTestProfile("primary")
		profile.Runtime.Provenance[0].Version = "0.9.0"
		if _, err := registry.Select(profile, runtimeBackendTestOverrides()); !errors.Is(err, errRuntimeBackendIncompatible) {
			t.Fatalf("provenance downgrade was accepted: %v", err)
		}
	})
	t.Run("missing metrics", func(t *testing.T) {
		if err := validateRuntimeBackendMetrics(backend.Descriptor(), runtimeBackendMetrics{}); !errors.Is(err, errRuntimeBackendInvalid) {
			t.Fatalf("metrics without schema were accepted: %v", err)
		}
	})
	t.Run("out of bounds metrics", func(t *testing.T) {
		metrics := runtimeBackendMetrics{SchemaVersion: runtimeBackendMetricsVersion, Running: true, InFlight: 5, MemoryBytes: 8193}
		if err := validateRuntimeBackendMetrics(backend.Descriptor(), metrics); !errors.Is(err, errRuntimeBackendInvalid) {
			t.Fatalf("metrics outside concurrency/memory bounds were accepted: %v", err)
		}
	})
}

func TestRuntimeBackendExplicitFallbackCannotDowngradeCapabilities(t *testing.T) {
	primary := newRuntimeBackendContractFake("primary", 10)
	fallback := newRuntimeBackendContractFake("fallback", 20)
	fallback.descriptor.Capabilities.Stream = false
	profile := runtimeBackendTestProfile("fallback", "primary")
	profile.Runtime.RequiredCapabilities.Stream = true
	profile.Runtime.Provenance[0] = runtimeProvenancePinFromDescriptor(fallback.Descriptor())
	profile.Runtime.Provenance[1] = runtimeProvenancePinFromDescriptor(primary.Descriptor())
	overrides := runtimeBackendTestOverrides()
	overrides.PreferredBackendIDs = []string{"primary", "fallback"}
	registry, err := newRuntimeBackendRegistry(primary, fallback)
	if err != nil {
		t.Fatal(err)
	}
	selected, explanation, err := registry.SelectExplained(profile, overrides)
	if err != nil || !reflect.DeepEqual(runtimeBackendIDs(selected), []string{"primary"}) {
		t.Fatalf("incompatible fallback was retained as a downgrade: %v %#v %v", runtimeBackendIDs(selected), explanation, err)
	}
	if !explanation.Forced || explanation.PrimaryBackendID != "primary" || len(explanation.FallbackBackendIDs) != 0 || explanation.Basis != "explicit-backend-order" {
		t.Fatalf("forced selection explanation is incomplete: %#v", explanation)
	}
}

func TestRuntimeBackendNormalizesExecutionFailuresAndCancellation(t *testing.T) {
	backend := newRuntimeBackendContractFake("fake", 10)
	profile := runtimeBackendTestProfile("fake")
	if _, err := backend.Prepare(context.Background(), runtimePrepareRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Load(context.Background(), runtimeLoadRequest{Profile: profile}); err != nil {
		t.Fatal(err)
	}
	for index, failure := range []error{errRuntimeBackendOutOfMemory, errRuntimeBackendCrashed, errRuntimeBackendTimedOut} {
		backend.nextError = failure
		request := runtimeExecuteRequest{
			ExecutionID: "failure-" + string(rune('a'+index)), ModelID: profile.Model.ModelID, Input: []byte("probe"), MaximumOutput: 16,
		}
		if _, err := backend.Execute(context.Background(), request); !errors.Is(err, failure) {
			t.Fatalf("execution failure %v was not preserved: %v", failure, err)
		}
	}
	cancelledContext, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := backend.Execute(cancelledContext, runtimeExecuteRequest{ExecutionID: "cancelled", ModelID: profile.Model.ModelID, MaximumOutput: 1}); !errors.Is(err, errRuntimeBackendCancelled) {
		t.Fatalf("context cancellation was not normalized: %v", err)
	}
	valid := runtimeExecuteRequest{ExecutionID: "unique", ModelID: profile.Model.ModelID, Input: []byte("ok"), MaximumOutput: 4}
	if _, err := backend.Execute(context.Background(), valid); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Execute(context.Background(), valid); !errors.Is(err, errRuntimeBackendInvalid) {
		t.Fatalf("duplicate execution ID was accepted: %v", err)
	}
	if err := backend.Cancel(context.Background(), "unknown"); !errors.Is(err, errRuntimeBackendExecutionUnknown) {
		t.Fatalf("unknown cancellation target was accepted: %v", err)
	}
	if err := backend.Cancel(context.Background(), "bad id"); !errors.Is(err, errRuntimeBackendInvalid) {
		t.Fatalf("invalid cancellation ID was accepted: %v", err)
	}
	if err := backend.Cancel(context.Background(), valid.ExecutionID); err != nil {
		t.Fatalf("known execution cancellation failed: %v", err)
	}
	metrics, err := backend.Metrics(context.Background(), nil)
	if err != nil || metrics.ExecutionErrors != 3 || metrics.OutOfMemoryErrors != 1 || metrics.CrashErrors != 1 || metrics.TimeoutErrors != 1 ||
		metrics.CancelledExecutions != 2 || validateRuntimeBackendMetrics(backend.Descriptor(), metrics) != nil {
		t.Fatalf("normalized failure metrics mismatch: %#v %v", metrics, err)
	}
}

func TestOllamaRuntimeBackendPublicSDKBridgeContract(t *testing.T) {
	base := t.TempDir()
	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	manifest := []byte(`{"schemaVersion":2,"layers":[]}`)
	catalogPath := writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifest))
	dependencyPath := writeManagedOllamaTestDependencies(t, base, strings.Repeat("d", 64))
	runtime := &managedControllerTestRuntime{}
	legacy, err := newOllamaRuntimeBackend(runtime, catalogPath, dependencyPath)
	if err != nil {
		t.Fatal(err)
	}
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 7, false, true)
	policies := newMemoryCapacityPolicyStore()
	policies.current = cloneCapacityPolicyState(*policy)
	capability := hostCapability{
		SchemaVersion: "multivibe-host-capability-v1", AgentVersion: "test", Supported: true,
		Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Accelerator: "cuda", AcceleratorMemoryBytes: 8192,
	}
	bridge, err := newOllamaRuntimeBackendSDKBridge(legacy, policies, capability, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	capturedDependencySHA := legacy.dependencyManifest.Ollama.Artifacts["darwin-arm64"].SHA256
	capturedCatalogDigest := legacy.catalog.Models[0].ContentDigest
	// Replace both valid source files after construction. All bridge operations
	// must continue to consume the immutable values captured above.
	writeManagedOllamaTestDependencies(t, base, strings.Repeat("f", 64))
	writeManagedOllamaTestCatalog(t, base, "sha256:"+strings.Repeat("c", 64))
	registry, err := runtimebackendapi.NewRegistry(bridge)
	if err != nil || !reflect.DeepEqual(registry.IDs(), []string{runtimeBackendOllamaID}) {
		t.Fatalf("public registry rejected Ollama bridge: %v %v", registry.IDs(), err)
	}
	descriptorJSON, err := json.Marshal(bridge.Descriptor())
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"bin/ollama", "{catalog_model}", "argument_templates", "executable_relative_paths"} {
		if strings.Contains(string(descriptorJSON), private) {
			t.Fatalf("public Ollama descriptor leaked private launch material %q: %s", private, descriptorJSON)
		}
	}
	model := runtimebackendapi.ModelRequirements{
		ID: "hf:qwen/qwen2.5-0.5b-instruct", ContentDigest: "sha256:" + managedOllamaTestSHA(manifest),
		ArtifactBytes: 16, EstimatedMemoryBytes: 4096, ContextTokens: 2048,
	}
	grant := runtimebackendapi.OperationGrant{
		ID: "ollama-contract", PolicyRevision: policy.Revision, TrafficClass: runtimebackendapi.TrafficClassShadow,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
		AllowedModelIDs: []string{model.ID},
		Limits: runtimebackendapi.Limits{
			MaximumModels: 1, MaximumConcurrency: 1, MaximumModelBytes: 16, MaximumMemoryBytes: 4096,
			MaximumContextTokens: 2048, MaximumInputBytes: 16, MaximumOutputBytes: 16,
		},
	}
	contracttest.Run(t, bridge, contracttest.Fixture{EvaluationTime: now, Grant: grant, Model: model, Input: []byte("shadow")})
	runtime.mu.Lock()
	calls := append([]string{}, runtime.calls...)
	runtime.mu.Unlock()
	for _, expected := range []string{
		"pinned-dependency:" + capturedDependencySHA,
		"pinned-pull:" + capturedCatalogDigest,
		"pinned-authorize:" + capturedCatalogDigest,
		"pinned-deactivate:" + capturedCatalogDigest,
	} {
		if !runtimeBackendTestContainsCall(calls, expected) {
			t.Fatalf("captured input was not consumed: missing %q in %v", expected, calls)
		}
	}

	stale := grant
	stale.PolicyRevision--
	if _, err := bridge.Health(context.Background(), stale); !errors.Is(err, runtimebackendapi.ErrIncompatible) {
		t.Fatalf("stale policy revision was accepted by bridge: %v", err)
	}
}

func runtimeBackendTestContainsCall(calls []string, expected string) bool {
	for _, call := range calls {
		if call == expected {
			return true
		}
	}
	return false
}

func TestOllamaRuntimeBackendSDKBridgeRejectsMismatchedDownloadManifest(t *testing.T) {
	now := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	runtime := &mismatchedManifestRuntime{managedControllerTestRuntime: &managedControllerTestRuntime{}}
	bridge, _, model, grant := newOllamaSDKBridgeTestSetup(t, runtime, now)
	if _, err := bridge.Prepare(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.Download(context.Background(), runtimebackendapi.DownloadRequest{Grant: grant, Model: model}); !errors.Is(err, runtimebackendapi.ErrBackendFailure) {
		t.Fatalf("mismatched manifest receipt was accepted or leaked a private error: %v", err)
	}
	bridge.mu.Lock()
	downloads := len(bridge.downloads)
	bridge.mu.Unlock()
	if downloads != 0 {
		t.Fatal("mismatched manifest receipt entered the bridge download set")
	}
}

func TestOllamaRuntimeBackendSDKBridgeCleanupKeepsOtherGrantRevisionAndTrafficClassReceipts(t *testing.T) {
	now := time.Date(2026, 9, 2, 15, 30, 0, 0, time.UTC)
	runtime := &managedControllerTestRuntime{}
	bridge, _, model, grant := newOllamaSDKBridgeTestSetup(t, runtime, now)
	receipt := runtimebackendapi.DownloadedModel{
		BackendID: runtimeBackendOllamaID, ModelID: model.ID, ContentDigest: model.ContentDigest, Bytes: model.ArtifactBytes,
	}
	otherGrant := grant
	otherGrant.ID = "ollama-other-grant"
	previousRevision := grant
	previousRevision.PolicyRevision--
	oppositeClass := grant
	oppositeClass.TrafficClass = runtimebackendapi.TrafficClassCustomer

	ownedKey := runtimeBackendSDKDownloadKey(grant, model)
	otherGrantKey := runtimeBackendSDKDownloadKey(otherGrant, model)
	previousRevisionKey := runtimeBackendSDKDownloadKey(previousRevision, model)
	oppositeClassKey := runtimeBackendSDKDownloadKey(oppositeClass, model)
	if ownedKey == otherGrantKey || ownedKey == previousRevisionKey || ownedKey == oppositeClassKey ||
		otherGrantKey == previousRevisionKey || otherGrantKey == oppositeClassKey || previousRevisionKey == oppositeClassKey {
		t.Fatal("download identity did not bind grant ID, policy revision and traffic class")
	}
	bridge.mu.Lock()
	bridge.downloads[ownedKey] = receipt
	bridge.downloads[otherGrantKey] = receipt
	bridge.downloads[previousRevisionKey] = receipt
	bridge.downloads[oppositeClassKey] = receipt
	bridge.mu.Unlock()
	if err := bridge.Cleanup(context.Background(), runtimebackendapi.CleanupRequest{
		Grant: grant, ModelIDs: []string{model.ID}, StopRuntime: true,
	}); !errors.Is(err, runtimebackendapi.ErrGrantMismatch) {
		t.Fatalf("cleanup stopped a runtime shared with other grant owners: %v", err)
	}
	bridge.mu.Lock()
	beforeScopedCleanup := len(bridge.downloads)
	bridge.mu.Unlock()
	if beforeScopedCleanup != 4 {
		t.Fatalf("rejected shared-runtime cleanup mutated receipts: remaining=%d", beforeScopedCleanup)
	}

	if err := bridge.Cleanup(context.Background(), runtimebackendapi.CleanupRequest{
		Grant: grant, ModelIDs: []string{model.ID},
	}); err != nil {
		t.Fatalf("grant-scoped cleanup failed: %v", err)
	}
	bridge.mu.Lock()
	_, ownedFound := bridge.downloads[ownedKey]
	_, otherGrantFound := bridge.downloads[otherGrantKey]
	_, previousRevisionFound := bridge.downloads[previousRevisionKey]
	_, oppositeClassFound := bridge.downloads[oppositeClassKey]
	remaining := len(bridge.downloads)
	bridge.mu.Unlock()
	if ownedFound || !otherGrantFound || !previousRevisionFound || !oppositeClassFound || remaining != 3 {
		t.Fatalf("cleanup crossed its grant boundary: owned=%t other_grant=%t previous_revision=%t opposite_class=%t remaining=%d",
			ownedFound, otherGrantFound, previousRevisionFound, oppositeClassFound, remaining)
	}
	if err := bridge.Cleanup(context.Background(), runtimebackendapi.CleanupRequest{
		Grant: oppositeClass, ModelIDs: []string{model.ID},
	}); !errors.Is(err, runtimebackendapi.ErrExecutionDisabled) {
		t.Fatalf("shadow-only bridge accepted cleanup under a customer-traffic grant: %v", err)
	}
	bridge.mu.Lock()
	_, oppositeClassFound = bridge.downloads[oppositeClassKey]
	remaining = len(bridge.downloads)
	bridge.mu.Unlock()
	if !oppositeClassFound || remaining != 3 {
		t.Fatalf("rejected opposite-class cleanup mutated receipts: found=%t remaining=%d", oppositeClassFound, remaining)
	}
}

func TestOllamaRuntimeBackendSDKBridgeDirectStopRejectsOtherRuntimeOwnersWithoutMutation(t *testing.T) {
	now := time.Date(2026, 9, 2, 15, 45, 0, 0, time.UTC)
	runtime := &managedControllerTestRuntime{}
	bridge, _, _, grant := newOllamaSDKBridgeTestSetup(t, runtime, now)
	ctx := context.Background()
	if _, err := bridge.Prepare(ctx, grant); err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.Start(ctx, grant); err != nil {
		t.Fatal(err)
	}

	otherID := grant
	otherID.ID += "-other"
	staleRevision := grant
	staleRevision.PolicyRevision--
	oppositeClass := grant
	oppositeClass.TrafficClass = runtimebackendapi.TrafficClassCustomer
	for name, candidate := range map[string]runtimebackendapi.OperationGrant{
		"other grant ID":         otherID,
		"stale policy revision":  staleRevision,
		"opposite traffic class": oppositeClass,
	} {
		t.Run(name, func(t *testing.T) {
			if err := bridge.Stop(ctx, candidate); !errors.Is(err, runtimebackendapi.ErrGrantMismatch) {
				t.Fatalf("direct stop crossed runtime ownership: %v", err)
			}
			health, err := bridge.Health(ctx, grant)
			if err != nil || !health.Running {
				t.Fatalf("rejected stop mutated runtime health: %#v %v", health, err)
			}
		})
	}

	if err := bridge.Cleanup(ctx, runtimebackendapi.CleanupRequest{Grant: grant, StopRuntime: true}); err != nil {
		t.Fatalf("owner cleanup regressed after refused direct stops: %v", err)
	}
	health, err := bridge.Health(ctx, grant)
	if err != nil || health.Running {
		t.Fatalf("owner cleanup did not stop runtime: %#v %v", health, err)
	}
}

func TestOllamaRuntimeBackendSDKBridgeSerializesTemporaryDownloadAndStart(t *testing.T) {
	now := time.Date(2026, 9, 2, 16, 0, 0, 0, time.UTC)
	pullStarted := make(chan struct{})
	pullRelease := make(chan struct{})
	runtime := &managedControllerTestRuntime{pullStarted: pullStarted, pullRelease: pullRelease}
	bridge, _, model, grant := newOllamaSDKBridgeTestSetup(t, runtime, now)
	if _, err := bridge.Prepare(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	startAttempted := make(chan struct{}, 1)
	bridge.lifecycleAttempt = func(operation string) {
		if operation == "start" {
			startAttempted <- struct{}{}
		}
	}
	downloadDone := make(chan error, 1)
	go func() {
		_, err := bridge.Download(context.Background(), runtimebackendapi.DownloadRequest{Grant: grant, Model: model})
		downloadDone <- err
	}()
	select {
	case <-pullStarted:
	case <-time.After(time.Second):
		t.Fatal("download did not reach the deterministic pull barrier")
	}
	startDone := make(chan error, 1)
	go func() {
		_, err := bridge.Start(context.Background(), grant)
		startDone <- err
	}()
	select {
	case <-startAttempted:
	case <-time.After(time.Second):
		t.Fatal("concurrent start did not reach the lifecycle boundary")
	}
	select {
	case err := <-startDone:
		t.Fatalf("start crossed an active temporary download lifecycle: %v", err)
	default:
	}
	close(pullRelease)
	select {
	case err := <-downloadDone:
		if err != nil {
			t.Fatalf("download failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("download did not finish")
	}
	select {
	case err := <-startDone:
		if err != nil {
			t.Fatalf("serialized start failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serialized start did not finish")
	}
	health, err := bridge.Health(context.Background(), grant)
	if err != nil || !health.Running {
		t.Fatalf("temporary download stopped the explicit start: %#v %v", health, err)
	}
	runtime.mu.Lock()
	calls := append([]string{}, runtime.calls...)
	runtime.mu.Unlock()
	if !runtimeBackendTestOrderedCalls(calls, []string{"start", "pull:" + model.ID, "stop", "start"}) {
		t.Fatalf("lifecycle ordering is unsafe: %v", calls)
	}
}

func TestRuntimeBackendSDKErrorsAreAlwaysPublicSentinels(t *testing.T) {
	tests := []struct {
		input    error
		expected error
	}{
		{context.Canceled, runtimebackendapi.ErrCancelled},
		{context.DeadlineExceeded, runtimebackendapi.ErrTimedOut},
		{errRuntimeBackendInvalid, runtimebackendapi.ErrInvalid},
		{errRuntimeBackendIncompatible, runtimebackendapi.ErrIncompatible},
		{errRuntimeBackendExecutionDisabled, runtimebackendapi.ErrExecutionDisabled},
		{errRuntimeBackendCapabilityMissing, runtimebackendapi.ErrCapabilityUnavailable},
		{errRuntimeBackendOutOfMemory, runtimebackendapi.ErrOutOfMemory},
		{errRuntimeBackendCrashed, runtimebackendapi.ErrCrashed},
		{errRuntimeBackendTimedOut, runtimebackendapi.ErrTimedOut},
		{errRuntimeBackendCancelled, runtimebackendapi.ErrCancelled},
		{errRuntimeBackendExecutionUnknown, runtimebackendapi.ErrExecutionUnknown},
		{errors.New("private failure at /tmp/provider-secret"), runtimebackendapi.ErrBackendFailure},
	}
	for _, test := range tests {
		result := runtimeBackendSDKError(test.input)
		if result != test.expected {
			t.Fatalf("private error was not reduced to its sentinel: input=%v result=%v expected=%v", test.input, result, test.expected)
		}
	}
}

func newOllamaSDKBridgeTestSetup(
	t *testing.T,
	runtime managedControllerRuntime,
	now time.Time,
) (*ollamaRuntimeBackendSDKBridge, *capacityPolicyStateDocument, runtimebackendapi.ModelRequirements, runtimebackendapi.OperationGrant) {
	t.Helper()
	base := t.TempDir()
	digest := "sha256:" + strings.Repeat("a", 64)
	legacy, err := newOllamaRuntimeBackend(
		runtime,
		writeManagedOllamaTestCatalog(t, base, digest),
		writeManagedOllamaTestDependencies(t, base, strings.Repeat("d", 64)),
	)
	if err != nil {
		t.Fatal(err)
	}
	policy := managedOllamaTestPolicy(filepath.Join(base, "models"), 9, false, true)
	policies := newMemoryCapacityPolicyStore()
	policies.current = cloneCapacityPolicyState(*policy)
	capability := hostCapability{
		SchemaVersion: "multivibe-host-capability-v1", AgentVersion: "test", Supported: true,
		Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Accelerator: "cuda", AcceleratorMemoryBytes: 8192,
	}
	bridge, err := newOllamaRuntimeBackendSDKBridge(legacy, policies, capability, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	model := runtimebackendapi.ModelRequirements{
		ID: "hf:qwen/qwen2.5-0.5b-instruct", ContentDigest: digest, ArtifactBytes: 16, EstimatedMemoryBytes: 4096, ContextTokens: 2048,
	}
	grant := runtimebackendapi.OperationGrant{
		ID: "ollama-review", PolicyRevision: policy.Revision, TrafficClass: runtimebackendapi.TrafficClassShadow,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
		AllowedModelIDs: []string{model.ID},
		Limits: runtimebackendapi.Limits{
			MaximumModels: 1, MaximumConcurrency: 1, MaximumModelBytes: 16, MaximumMemoryBytes: 4096,
			MaximumContextTokens: 2048, MaximumInputBytes: 16, MaximumOutputBytes: 16,
		},
	}
	return bridge, policy, model, grant
}

func runtimeBackendTestOrderedCalls(calls, ordered []string) bool {
	index := 0
	for _, call := range calls {
		if index < len(ordered) && call == ordered[index] {
			index++
		}
	}
	return index == len(ordered)
}
