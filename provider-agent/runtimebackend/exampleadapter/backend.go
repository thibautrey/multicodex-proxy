// Package exampleadapter is a minimal, in-memory reference implementation of
// the public runtimebackend contract. It is compiled by its own tests but is
// never registered by the provider worker.
package exampleadapter

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const blockingContractInput = "multivibe-contract-block-until-cancel-v1"

type executionRecord struct {
	grantID        string
	policyRevision uint64
	trafficClass   runtimebackend.TrafficClass
	generation     uint64
	cancel         context.CancelFunc
}

type modelOwnershipKey struct {
	grantID        string
	policyRevision uint64
	trafficClass   runtimebackend.TrafficClass
	modelID        string
	contentDigest  string
}

type runtimeOwnershipKey struct {
	grantID        string
	policyRevision uint64
	trafficClass   runtimebackend.TrafficClass
}

type Config struct {
	ID           string
	Priority     uint16
	Accelerators []runtimebackend.AcceleratorConstraint
	Limits       runtimebackend.Limits
	Provenance   runtimebackend.Provenance
}

// ReferenceConfig is fixed, public example data. A real adapter replaces every
// value with reviewed runtime metadata and an exact upstream artifact digest.
func ReferenceConfig() Config {
	return Config{
		ID:       "example-static",
		Priority: 500,
		Accelerators: []runtimebackend.AcceleratorConstraint{
			{Profile: "apple-silicon", OS: "darwin", Architecture: "arm64", Kind: "metal"},
			{Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda"},
		},
		Limits: runtimebackend.Limits{
			MaximumModels: 8, MaximumConcurrency: 8,
			MaximumModelBytes: 1 << 34, MaximumMemoryBytes: 1 << 35,
			MaximumContextTokens: 131072, MaximumInputBytes: 1 << 20, MaximumOutputBytes: 1 << 20,
		},
		Provenance: runtimebackend.Provenance{
			SourceURL: "https://github.com/thibautrey/multivibe",
			Version:   "contributor-example-v1",
			ArtifactSHA256: map[string]string{
				"reference-data": "554bcbbba785430265ef7d4155d295928250b741952f50f37bddaf93841ed4df",
			},
		},
	}
}

type Backend struct {
	mu                      sync.Mutex
	descriptor              runtimebackend.Descriptor
	prepared                bool
	running                 bool
	runtimeOwners           map[runtimeOwnershipKey]struct{}
	downloads               map[modelOwnershipKey]runtimebackend.DownloadedModel
	models                  map[modelOwnershipKey]runtimebackend.ModelRequirements
	executions              map[string]executionRecord
	nextExecutionGeneration uint64
	metrics                 runtimebackend.Metrics
}

func New(config Config) (*Backend, error) {
	descriptor := runtimebackend.Descriptor{
		ContractVersion: runtimebackend.ContractVersion,
		ID:              config.ID,
		Priority:        config.Priority,
		Capabilities: runtimebackend.Capabilities{
			Execute: true, Stream: true, Cancel: true, ShadowOnly: true, CustomerTraffic: false,
		},
		Accelerators: cloneAccelerators(config.Accelerators),
		Limits:       config.Limits,
		Provenance:   cloneProvenance(config.Provenance),
	}
	if err := runtimebackend.ValidateDescriptor(descriptor); err != nil {
		return nil, err
	}
	return &Backend{
		descriptor:    descriptor,
		runtimeOwners: make(map[runtimeOwnershipKey]struct{}),
		downloads:     make(map[modelOwnershipKey]runtimebackend.DownloadedModel),
		models:        make(map[modelOwnershipKey]runtimebackend.ModelRequirements),
		executions:    make(map[string]executionRecord),
		metrics:       runtimebackend.Metrics{SchemaVersion: runtimebackend.MetricsVersion},
	}, nil
}

func (backend *Backend) Discover(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Discovery, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Discovery{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	accelerators := make([]runtimebackend.Accelerator, 0, len(backend.descriptor.Accelerators))
	for _, constraint := range backend.descriptor.Accelerators {
		accelerators = append(accelerators, runtimebackend.Accelerator{
			Profile: constraint.Profile, OS: constraint.OS, Architecture: constraint.Architecture,
			Kind: constraint.Kind, MemoryBytes: backend.descriptor.Limits.MaximumMemoryBytes,
		})
	}
	return runtimebackend.Discovery{Accelerators: accelerators}, nil
}

func (backend *Backend) Compatible(ctx context.Context, request runtimebackend.CompatibilityRequest) (runtimebackend.Compatibility, error) {
	if ctx == nil {
		return runtimebackend.Compatibility{}, runtimebackend.ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return runtimebackend.Compatibility{}, runtimebackend.NormalizeExecutionError(err)
	}
	return runtimebackend.EvaluateCompatibility(backend.Descriptor(), request)
}

func (backend *Backend) Descriptor() runtimebackend.Descriptor {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	descriptor := backend.descriptor
	descriptor.Accelerators = cloneAccelerators(backend.descriptor.Accelerators)
	descriptor.Provenance = cloneProvenance(backend.descriptor.Provenance)
	return descriptor
}

func (backend *Backend) Prepare(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Health{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.prepared = true
	return backend.healthLocked(), nil
}

func (backend *Backend) Download(ctx context.Context, request runtimebackend.DownloadRequest) (runtimebackend.DownloadedModel, error) {
	if err := validateContextAndGrant(ctx, request.Grant); err != nil {
		return runtimebackend.DownloadedModel{}, err
	}
	if err := runtimebackend.ValidateDownloadRequest(request, time.Now()); err != nil {
		return runtimebackend.DownloadedModel{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if !backend.prepared || request.Model.ArtifactBytes > backend.descriptor.Limits.MaximumModelBytes {
		return runtimebackend.DownloadedModel{}, runtimebackend.ErrIncompatible
	}
	download := runtimebackend.DownloadedModel{
		BackendID: backend.descriptor.ID, ModelID: request.Model.ID,
		ContentDigest: request.Model.ContentDigest, Bytes: request.Model.ArtifactBytes,
	}
	backend.downloads[ownershipKey(request.Grant, request.Model.ID, request.Model.ContentDigest)] = download
	return download, nil
}

func (backend *Backend) Start(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Health{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if !backend.prepared {
		return runtimebackend.Health{}, runtimebackend.ErrIncompatible
	}
	backend.runtimeOwners[runtimeOwnerKey(grant)] = struct{}{}
	backend.running = true
	backend.metrics.Running = true
	return backend.healthLocked(), nil
}

func (backend *Backend) Load(ctx context.Context, request runtimebackend.LoadRequest) (runtimebackend.LoadedModel, error) {
	if err := validateContextAndGrant(ctx, request.Grant); err != nil {
		return runtimebackend.LoadedModel{}, err
	}
	if err := runtimebackend.ValidateLoadRequest(request, time.Now()); err != nil {
		return runtimebackend.LoadedModel{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if !backend.prepared || !backend.running {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrCapabilityUnavailable
	}
	if request.Model.ArtifactBytes > backend.descriptor.Limits.MaximumModelBytes ||
		request.Model.EstimatedMemoryBytes > backend.descriptor.Limits.MaximumMemoryBytes ||
		request.Model.ContextTokens > backend.descriptor.Limits.MaximumContextTokens {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrInvalid
	}
	key := ownershipKey(request.Grant, request.Model.ID, request.Model.ContentDigest)
	download, downloaded := backend.downloads[key]
	if !downloaded && backend.hasDownloadForAnotherOwnerLocked(key, request.Download) {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrGrantMismatch
	}
	if !downloaded || download != request.Download || download.BackendID != backend.descriptor.ID ||
		download.ContentDigest != request.Model.ContentDigest {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrInvalid
	}
	if _, exists := backend.models[key]; !exists && len(backend.models) >= int(backend.descriptor.Limits.MaximumModels) {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrOutOfMemory
	}
	backend.models[key] = request.Model
	backend.metrics.InstalledModels = uint32(len(backend.models))
	backend.metrics.LoadMillisecondsP50 = 1
	return runtimebackend.LoadedModel{
		BackendID: backend.descriptor.ID, ModelID: request.Model.ID, ContentDigest: request.Model.ContentDigest,
	}, nil
}

func (backend *Backend) Execute(ctx context.Context, request runtimebackend.ExecutionRequest) (runtimebackend.ExecutionResult, error) {
	executionContext, complete, err := backend.beginExecution(ctx, request)
	if err != nil {
		return runtimebackend.ExecutionResult{}, err
	}
	defer func() { complete(executionContext.Err()) }()
	select {
	case <-executionContext.Done():
		return runtimebackend.ExecutionResult{}, runtimebackend.NormalizeExecutionError(executionContext.Err())
	default:
	}
	if bytes.Equal(request.Input, []byte(blockingContractInput)) {
		<-executionContext.Done()
		return runtimebackend.ExecutionResult{}, runtimebackend.NormalizeExecutionError(executionContext.Err())
	}
	output := boundedExampleOutput(request.Input, request.MaximumOutputBytes)
	return runtimebackend.ExecutionResult{Output: output}, nil
}

func (backend *Backend) ExecuteStream(ctx context.Context, request runtimebackend.ExecutionRequest, emit runtimebackend.EmitFunc) (runtimebackend.ExecutionSummary, error) {
	if emit == nil {
		return runtimebackend.ExecutionSummary{}, runtimebackend.ErrInvalid
	}
	executionContext, complete, err := backend.beginExecution(ctx, request)
	if err != nil {
		return runtimebackend.ExecutionSummary{}, err
	}
	var finalError error
	defer func() { complete(finalError) }()
	output := boundedExampleOutput(request.Input, request.MaximumOutputBytes)
	if err := emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventPrefillComplete}); err != nil {
		finalError = err
		return runtimebackend.ExecutionSummary{}, err
	}
	cut := len(output) / 2
	if cut == 0 {
		cut = len(output)
	}
	chunks := [][]byte{output[:cut]}
	if cut < len(output) {
		chunks = append(chunks, output[cut:])
	}
	var outputBytes uint64
	for index, chunk := range chunks {
		select {
		case <-executionContext.Done():
			finalError = runtimebackend.NormalizeExecutionError(executionContext.Err())
			return runtimebackend.ExecutionSummary{}, finalError
		default:
		}
		copyOfChunk := append([]byte(nil), chunk...)
		if err := emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: copyOfChunk, Final: index == len(chunks)-1}); err != nil {
			finalError = err
			return runtimebackend.ExecutionSummary{}, err
		}
		outputBytes += uint64(len(copyOfChunk))
	}
	tokens := uint64(len(bytes.Fields(output)))
	if tokens == 0 {
		tokens = 1
	}
	return runtimebackend.ExecutionSummary{OutputBytes: outputBytes, OutputTokens: tokens}, nil
}

func (backend *Backend) Cancel(ctx context.Context, request runtimebackend.CancelRequest) error {
	if err := validateContextAndGrant(ctx, request.Grant); err != nil {
		return err
	}
	if err := runtimebackend.ValidateCancelRequest(request, time.Now()); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	execution, exists := backend.executions[request.ExecutionID]
	if !exists {
		return runtimebackend.ErrExecutionUnknown
	}
	if execution.grantID != request.Grant.ID || execution.policyRevision != request.Grant.PolicyRevision ||
		execution.trafficClass != request.Grant.TrafficClass {
		return runtimebackend.ErrGrantMismatch
	}
	execution.cancel()
	return nil
}

// WaitUntilExecuting synchronizes this in-memory example's contract test. Real
// adapters may instead provide a test fixture callback around runtime events.
func (backend *Backend) WaitUntilExecuting(ctx context.Context, executionID string) error {
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		backend.mu.Lock()
		_, found := backend.executions[executionID]
		backend.mu.Unlock()
		if found {
			return nil
		}
		select {
		case <-ctx.Done():
			return runtimebackend.NormalizeExecutionError(ctx.Err())
		case <-ticker.C:
		}
	}
}

func (backend *Backend) Health(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Health{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.healthLocked(), nil
}

func (backend *Backend) Ready(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Readiness, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Readiness{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.running && backend.hasModelForGrantLocked(grant) {
		return runtimebackend.Readiness{Ready: true, Reason: runtimebackend.ReasonEligible}, nil
	}
	return runtimebackend.Readiness{Ready: false, Reason: runtimebackend.ReasonNotRequired}, nil
}

func (backend *Backend) Metrics(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Metrics, error) {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return runtimebackend.Metrics{}, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.metrics, nil
}

func (backend *Backend) Cleanup(ctx context.Context, request runtimebackend.CleanupRequest) error {
	if err := validateContextAndGrant(ctx, request.Grant); err != nil {
		return err
	}
	if err := runtimebackend.ValidateCleanupRequest(request, time.Now()); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if request.StopRuntime && backend.hasResourcesForAnotherOwnerLocked(request.Grant) {
		return runtimebackend.ErrGrantMismatch
	}
	keys := make(map[modelOwnershipKey]struct{})
	for _, modelID := range request.ModelIDs {
		owned := backend.modelKeysForOwnerLocked(request.Grant, modelID)
		if len(owned) == 0 && backend.hasModelIDForAnotherOwnerLocked(request.Grant, modelID) {
			return runtimebackend.ErrGrantMismatch
		}
		for _, key := range owned {
			keys[key] = struct{}{}
		}
	}
	for key := range keys {
		delete(backend.models, key)
		delete(backend.downloads, key)
	}
	backend.metrics.InstalledModels = uint32(len(backend.models))
	if request.StopRuntime {
		backend.stopLocked()
	} else if !backend.hasActiveResourcesForOwnerLocked(request.Grant) {
		delete(backend.runtimeOwners, runtimeOwnerKey(request.Grant))
	}
	return nil
}

func (backend *Backend) Stop(ctx context.Context, grant runtimebackend.OperationGrant) error {
	if err := validateContextAndGrant(ctx, grant); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.hasResourcesForAnotherOwnerLocked(grant) {
		return runtimebackend.ErrGrantMismatch
	}
	backend.stopLocked()
	return nil
}

func (backend *Backend) beginExecution(ctx context.Context, request runtimebackend.ExecutionRequest) (context.Context, func(error), error) {
	if err := validateContextAndGrant(ctx, request.Grant); err != nil {
		return nil, nil, err
	}
	if err := runtimebackend.ValidateExecutionRequestForDescriptor(backend.Descriptor(), request, time.Now()); err != nil {
		return nil, nil, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if !backend.running {
		return nil, nil, runtimebackend.ErrExecutionDisabled
	}
	loadedModels := backend.loadedModelCountLocked(request.Grant, request.ModelID)
	if loadedModels == 0 {
		return nil, nil, runtimebackend.ErrInvalid
	}
	if loadedModels != 1 {
		return nil, nil, runtimebackend.ErrInvalid
	}
	if request.MaximumOutputBytes > backend.descriptor.Limits.MaximumOutputBytes || len(backend.executions) >= int(backend.descriptor.Limits.MaximumConcurrency) {
		return nil, nil, runtimebackend.ErrInvalid
	}
	if _, duplicate := backend.executions[request.ExecutionID]; duplicate {
		return nil, nil, runtimebackend.ErrInvalid
	}
	executionContext, cancel := context.WithCancel(ctx)
	backend.nextExecutionGeneration++
	generation := backend.nextExecutionGeneration
	backend.executions[request.ExecutionID] = executionRecord{
		grantID: request.Grant.ID, policyRevision: request.Grant.PolicyRevision, trafficClass: request.Grant.TrafficClass,
		generation: generation, cancel: cancel,
	}
	backend.metrics.InFlight = uint32(len(backend.executions))
	complete := func(executionError error) {
		backend.mu.Lock()
		defer backend.mu.Unlock()
		if current, found := backend.executions[request.ExecutionID]; found && current.generation == generation {
			delete(backend.executions, request.ExecutionID)
		}
		cancel()
		backend.metrics.InFlight = uint32(len(backend.executions))
		backend.metrics.ExecutionSamples++
		backend.metrics.PrefillMillisecondsP50 = 1
		backend.metrics.TimeToFirstTokenMillisecondsP50 = 1
		backend.metrics.TokensPerSecondMilliP50 = 1000
		if executionError != nil {
			backend.metrics.ExecutionErrors++
			switch {
			case errors.Is(executionError, runtimebackend.ErrOutOfMemory):
				backend.metrics.OutOfMemoryErrors++
			case errors.Is(executionError, runtimebackend.ErrCrashed):
				backend.metrics.CrashErrors++
			case errors.Is(executionError, runtimebackend.ErrTimedOut):
				backend.metrics.TimeoutErrors++
			case errors.Is(executionError, runtimebackend.ErrCancelled), errors.Is(executionError, context.Canceled):
				backend.metrics.CancelledExecutions++
			}
		}
	}
	return executionContext, complete, nil
}

func ownershipKey(grant runtimebackend.OperationGrant, modelID, contentDigest string) modelOwnershipKey {
	return modelOwnershipKey{
		grantID: grant.ID, policyRevision: grant.PolicyRevision, trafficClass: grant.TrafficClass,
		modelID: modelID, contentDigest: contentDigest,
	}
}

func runtimeOwnerKey(grant runtimebackend.OperationGrant) runtimeOwnershipKey {
	return runtimeOwnershipKey{
		grantID: grant.ID, policyRevision: grant.PolicyRevision, trafficClass: grant.TrafficClass,
	}
}

func sameModelOwner(key modelOwnershipKey, grant runtimebackend.OperationGrant) bool {
	return key.grantID == grant.ID && key.policyRevision == grant.PolicyRevision && key.trafficClass == grant.TrafficClass
}

func (backend *Backend) hasDownloadForAnotherOwnerLocked(key modelOwnershipKey, receipt runtimebackend.DownloadedModel) bool {
	for candidate, download := range backend.downloads {
		if candidate.modelID == key.modelID && candidate.contentDigest == key.contentDigest && candidate != key && download == receipt {
			return true
		}
	}
	return false
}

func (backend *Backend) hasModelForGrantLocked(grant runtimebackend.OperationGrant) bool {
	for key := range backend.models {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	return false
}

func (backend *Backend) modelKeysForOwnerLocked(grant runtimebackend.OperationGrant, modelID string) []modelOwnershipKey {
	keys := make(map[modelOwnershipKey]struct{})
	for key := range backend.models {
		if key.modelID == modelID && sameModelOwner(key, grant) {
			keys[key] = struct{}{}
		}
	}
	for key := range backend.downloads {
		if key.modelID == modelID && sameModelOwner(key, grant) {
			keys[key] = struct{}{}
		}
	}
	result := make([]modelOwnershipKey, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	return result
}

func (backend *Backend) hasModelIDForAnotherOwnerLocked(grant runtimebackend.OperationGrant, modelID string) bool {
	for key := range backend.models {
		if key.modelID == modelID && !sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range backend.downloads {
		if key.modelID == modelID && !sameModelOwner(key, grant) {
			return true
		}
	}
	return false
}

func (backend *Backend) loadedModelCountLocked(grant runtimebackend.OperationGrant, modelID string) int {
	count := 0
	for key := range backend.models {
		if key.modelID == modelID && sameModelOwner(key, grant) {
			count++
		}
	}
	return count
}

func (backend *Backend) hasResourcesForAnotherOwnerLocked(grant runtimebackend.OperationGrant) bool {
	owner := runtimeOwnerKey(grant)
	for candidate := range backend.runtimeOwners {
		if candidate != owner {
			return true
		}
	}
	for key := range backend.models {
		if !sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range backend.downloads {
		if !sameModelOwner(key, grant) {
			return true
		}
	}
	for _, execution := range backend.executions {
		if execution.grantID != grant.ID || execution.policyRevision != grant.PolicyRevision || execution.trafficClass != grant.TrafficClass {
			return true
		}
	}
	return false
}

func (backend *Backend) hasActiveResourcesForOwnerLocked(grant runtimebackend.OperationGrant) bool {
	for key := range backend.models {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range backend.downloads {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	for _, execution := range backend.executions {
		if execution.grantID == grant.ID && execution.policyRevision == grant.PolicyRevision && execution.trafficClass == grant.TrafficClass {
			return true
		}
	}
	return false
}

func (backend *Backend) healthLocked() runtimebackend.Health {
	state := "stopped"
	if backend.running {
		state = "running"
	} else if backend.prepared {
		state = "prepared"
	}
	return runtimebackend.Health{State: state, Installed: backend.prepared, Running: backend.running}
}

func (backend *Backend) stopLocked() {
	for executionID, execution := range backend.executions {
		execution.cancel()
		delete(backend.executions, executionID)
	}
	backend.running = false
	clear(backend.runtimeOwners)
	backend.metrics.Running = false
	backend.metrics.InFlight = 0
}

func validateContextAndGrant(ctx context.Context, grant runtimebackend.OperationGrant) error {
	if ctx == nil {
		return runtimebackend.ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return runtimebackend.NormalizeExecutionError(err)
	}
	return runtimebackend.ValidateOperationGrant(grant, time.Now())
}

func boundedExampleOutput(input []byte, maximum uint64) []byte {
	output := append([]byte(nil), input...)
	if uint64(len(output)) > maximum {
		output = output[:maximum]
	}
	return output
}

func cloneAccelerators(source []runtimebackend.AcceleratorConstraint) []runtimebackend.AcceleratorConstraint {
	return append([]runtimebackend.AcceleratorConstraint(nil), source...)
}

func cloneProvenance(source runtimebackend.Provenance) runtimebackend.Provenance {
	result := source
	result.ArtifactSHA256 = make(map[string]string, len(source.ArtifactSHA256))
	for platform, digest := range source.ArtifactSHA256 {
		result.ArtifactSHA256[platform] = digest
	}
	result.ContainerImages = append([]string{}, source.ContainerImages...)
	return result
}

var (
	_ runtimebackend.Backend        = (*Backend)(nil)
	_ runtimebackend.Executor       = (*Backend)(nil)
	_ runtimebackend.StreamExecutor = (*Backend)(nil)
	_ runtimebackend.Canceller      = (*Backend)(nil)
)
