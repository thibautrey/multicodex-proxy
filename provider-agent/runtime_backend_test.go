package main

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

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

func runtimeProvenancePinFromDescriptor(descriptor runtimeBackendDescriptor) runtimeProvenancePin {
	pin := runtimeProvenancePin{
		BackendID: descriptor.ID, SourceURL: descriptor.Launch.Provenance.SourceURL, Version: descriptor.Launch.Provenance.Version,
		ArtifactSHA256:  make(map[string]string, len(descriptor.Launch.Provenance.ArtifactSHA256)),
		ContainerImages: append([]string{}, descriptor.Launch.ContainerImages...),
	}
	for platform, digest := range descriptor.Launch.Provenance.ArtifactSHA256 {
		pin.ArtifactSHA256[platform] = digest
	}
	return pin
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
