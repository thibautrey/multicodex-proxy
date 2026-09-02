// Package contracttest provides a GPU-free backend and a reusable conformance
// suite for runtimebackend implementations.
package contracttest

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const BlockingInput = "multivibe-contract-block-until-cancel-v1"

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

// Fake is a deterministic, concurrent-safe in-memory backend. It implements
// every optional Go interface but returns ErrCapabilityUnavailable for optional
// surfaces not advertised by its descriptor.
type Fake struct {
	mu                      sync.Mutex
	descriptor              runtimebackend.Descriptor
	now                     func() time.Time
	installed               bool
	running                 bool
	runtimeOwners           map[runtimeOwnershipKey]struct{}
	downloads               map[modelOwnershipKey]runtimebackend.DownloadedModel
	models                  map[modelOwnershipKey]runtimebackend.ModelRequirements
	executions              map[string]executionRecord
	nextExecutionGeneration uint64
	metrics                 runtimebackend.Metrics
	nextFailure             error
}

// Option configures a Fake without changing its public descriptor after
// construction.
type Option func(*Fake) error

// WithClock installs a deterministic clock.
func WithClock(now func() time.Time) Option {
	return func(fake *Fake) error {
		if now == nil {
			return runtimebackend.ErrInvalid
		}
		fake.now = now
		return nil
	}
}

// DefaultDescriptor returns a valid execution-capable descriptor suitable for
// tests. Callers may modify the returned value before NewFake.
func DefaultDescriptor(id string) runtimebackend.Descriptor {
	return runtimebackend.Descriptor{
		ContractVersion: runtimebackend.ContractVersion,
		ID:              id,
		Priority:        100,
		Capabilities: runtimebackend.Capabilities{
			Execute: true, Stream: true, Cancel: true, ShadowOnly: true,
		},
		Accelerators: []runtimebackend.AcceleratorConstraint{
			{Profile: "apple-silicon", OS: "darwin", Architecture: "arm64", Kind: "metal"},
			{Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda"},
		},
		Limits: runtimebackend.Limits{
			MaximumModels: 8, MaximumConcurrency: 32, MaximumModelBytes: 1 << 34, MaximumMemoryBytes: 1 << 35,
			MaximumContextTokens: 131_072, MaximumInputBytes: 1 << 20, MaximumOutputBytes: 1 << 20,
		},
		Provenance: runtimebackend.Provenance{
			SourceURL: "https://example.test/multivibe-runtime", Version: "1.0.0",
			ArtifactSHA256: map[string]string{"linux-amd64": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		},
	}
}

// NewFake constructs a validated in-memory backend.
func NewFake(descriptor runtimebackend.Descriptor, options ...Option) (*Fake, error) {
	if runtimebackend.ValidateDescriptor(descriptor) != nil {
		return nil, runtimebackend.ErrInvalid
	}
	fake := &Fake{
		descriptor:    cloneDescriptor(descriptor),
		now:           time.Now,
		runtimeOwners: make(map[runtimeOwnershipKey]struct{}),
		downloads:     make(map[modelOwnershipKey]runtimebackend.DownloadedModel),
		models:        make(map[modelOwnershipKey]runtimebackend.ModelRequirements),
		executions:    make(map[string]executionRecord),
		metrics:       runtimebackend.Metrics{SchemaVersion: runtimebackend.MetricsVersion},
	}
	for _, option := range options {
		if option == nil || option(fake) != nil {
			return nil, runtimebackend.ErrInvalid
		}
	}
	return fake, nil
}

// FailNext makes the next execution return one stable execution sentinel.
func (fake *Fake) FailNext(failure error) error {
	if !errors.Is(failure, runtimebackend.ErrOutOfMemory) && !errors.Is(failure, runtimebackend.ErrCrashed) &&
		!errors.Is(failure, runtimebackend.ErrTimedOut) && !errors.Is(failure, runtimebackend.ErrCancelled) {
		return runtimebackend.ErrInvalid
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.nextFailure = failure
	return nil
}

func (fake *Fake) Descriptor() runtimebackend.Descriptor {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return cloneDescriptor(fake.descriptor)
}

func (fake *Fake) Discover(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Discovery, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Discovery{}, err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return runtimebackend.Discovery{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	accelerators := make([]runtimebackend.Accelerator, 0, len(fake.descriptor.Accelerators))
	for _, constraint := range fake.descriptor.Accelerators {
		accelerators = append(accelerators, runtimebackend.Accelerator{
			Profile: constraint.Profile, OS: constraint.OS, Architecture: constraint.Architecture, Kind: constraint.Kind,
			MemoryBytes: fake.descriptor.Limits.MaximumMemoryBytes,
		})
	}
	return runtimebackend.Discovery{Accelerators: accelerators}, nil
}

func (fake *Fake) Compatible(ctx context.Context, request runtimebackend.CompatibilityRequest) (runtimebackend.Compatibility, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Compatibility{}, err
	}
	return runtimebackend.EvaluateCompatibility(fake.Descriptor(), request)
}

func (fake *Fake) Prepare(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Health{}, err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return runtimebackend.Health{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.installed = true
	return fake.healthLocked(), nil
}

func (fake *Fake) Download(ctx context.Context, request runtimebackend.DownloadRequest) (runtimebackend.DownloadedModel, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.DownloadedModel{}, err
	}
	if err := runtimebackend.ValidateDownloadRequest(request, fake.now()); err != nil {
		return runtimebackend.DownloadedModel{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !fake.installed {
		return runtimebackend.DownloadedModel{}, runtimebackend.ErrIncompatible
	}
	download := runtimebackend.DownloadedModel{
		BackendID: fake.descriptor.ID, ModelID: request.Model.ID, ContentDigest: request.Model.ContentDigest, Bytes: request.Model.ArtifactBytes,
	}
	fake.downloads[ownershipKey(request.Grant, request.Model.ID, request.Model.ContentDigest)] = download
	return download, nil
}

func (fake *Fake) Start(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Health{}, err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return runtimebackend.Health{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !fake.installed {
		return runtimebackend.Health{}, runtimebackend.ErrIncompatible
	}
	fake.runtimeOwners[runtimeOwnerKey(grant)] = struct{}{}
	fake.running = true
	return fake.healthLocked(), nil
}

func (fake *Fake) Load(ctx context.Context, request runtimebackend.LoadRequest) (runtimebackend.LoadedModel, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.LoadedModel{}, err
	}
	if err := runtimebackend.ValidateLoadRequest(request, fake.now()); err != nil {
		return runtimebackend.LoadedModel{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	key := ownershipKey(request.Grant, request.Model.ID, request.Model.ContentDigest)
	if !fake.installed || !fake.running || (len(fake.models) >= int(fake.descriptor.Limits.MaximumModels) && fake.models[key].ID == "") {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrIncompatible
	}
	download, found := fake.downloads[key]
	if !found && fake.hasDownloadForAnotherOwnerLocked(key, request.Download) {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrGrantMismatch
	}
	if !found || download != request.Download {
		return runtimebackend.LoadedModel{}, runtimebackend.ErrInvalid
	}
	fake.models[key] = request.Model
	return runtimebackend.LoadedModel{BackendID: fake.descriptor.ID, ModelID: request.Model.ID, ContentDigest: request.Model.ContentDigest}, nil
}

func (fake *Fake) Health(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Health{}, err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return runtimebackend.Health{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.healthLocked(), nil
}

func (fake *Fake) Ready(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Readiness, error) {
	health, err := fake.Health(ctx, grant)
	if err != nil {
		return runtimebackend.Readiness{}, err
	}
	fake.mu.Lock()
	hasModel := fake.hasModelForGrantLocked(grant)
	fake.mu.Unlock()
	if health.Installed && health.Running && hasModel {
		return runtimebackend.Readiness{Ready: true, Reason: runtimebackend.ReasonEligible}, nil
	}
	return runtimebackend.Readiness{Ready: false, Reason: runtimebackend.ReasonNotRequired}, nil
}

func (fake *Fake) Metrics(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Metrics, error) {
	if err := contextError(ctx); err != nil {
		return runtimebackend.Metrics{}, err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return runtimebackend.Metrics{}, err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	metrics := fake.metrics
	metrics.Running = fake.running
	metrics.InstalledModels = uint32(len(fake.models))
	return metrics, nil
}

func (fake *Fake) Cleanup(ctx context.Context, request runtimebackend.CleanupRequest) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := runtimebackend.ValidateCleanupRequest(request, fake.now()); err != nil {
		return err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if request.StopRuntime && fake.hasResourcesForAnotherOwnerLocked(request.Grant) {
		return runtimebackend.ErrGrantMismatch
	}
	keys := make(map[modelOwnershipKey]struct{})
	for _, modelID := range request.ModelIDs {
		owned := fake.modelKeysForOwnerLocked(request.Grant, modelID)
		if len(owned) == 0 && fake.hasModelIDForAnotherOwnerLocked(request.Grant, modelID) {
			return runtimebackend.ErrGrantMismatch
		}
		for _, key := range owned {
			keys[key] = struct{}{}
		}
	}
	for key := range keys {
		delete(fake.models, key)
		delete(fake.downloads, key)
	}
	if request.StopRuntime {
		fake.cancelExecutionsLocked()
		fake.running = false
		clear(fake.runtimeOwners)
	} else if !fake.hasActiveResourcesForOwnerLocked(request.Grant) {
		delete(fake.runtimeOwners, runtimeOwnerKey(request.Grant))
	}
	return nil
}

func (fake *Fake) Stop(ctx context.Context, grant runtimebackend.OperationGrant) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := runtimebackend.ValidateOperationGrant(grant, fake.now()); err != nil {
		return err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.hasResourcesForAnotherOwnerLocked(grant) {
		return runtimebackend.ErrGrantMismatch
	}
	fake.cancelExecutionsLocked()
	fake.running = false
	clear(fake.runtimeOwners)
	return nil
}

func (fake *Fake) Execute(ctx context.Context, request runtimebackend.ExecutionRequest) (runtimebackend.ExecutionResult, error) {
	if err := contextError(ctx); err != nil {
		fake.recordExecutionFailure(err)
		return runtimebackend.ExecutionResult{}, err
	}
	descriptor := fake.Descriptor()
	if !descriptor.Capabilities.Execute {
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrCapabilityUnavailable
	}
	if err := runtimebackend.ValidateExecutionRequestForDescriptor(descriptor, request, fake.now()); err != nil {
		return runtimebackend.ExecutionResult{}, err
	}
	fake.mu.Lock()
	if !fake.running {
		fake.mu.Unlock()
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrIncompatible
	}
	loadedModels := fake.loadedModelCountLocked(request.Grant, request.ModelID)
	if loadedModels == 0 {
		fake.mu.Unlock()
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrIncompatible
	}
	if loadedModels != 1 {
		fake.mu.Unlock()
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrInvalid
	}
	if _, duplicate := fake.executions[request.ExecutionID]; duplicate {
		fake.mu.Unlock()
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrInvalid
	}
	if uint32(fake.metrics.InFlight) >= fake.descriptor.Limits.MaximumConcurrency {
		fake.mu.Unlock()
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrIncompatible
	}
	executionContext, cancel := context.WithCancel(ctx)
	fake.nextExecutionGeneration++
	generation := fake.nextExecutionGeneration
	fake.executions[request.ExecutionID] = executionRecord{
		grantID: request.Grant.ID, policyRevision: request.Grant.PolicyRevision, trafficClass: request.Grant.TrafficClass,
		generation: generation, cancel: cancel,
	}
	fake.metrics.InFlight++
	failure := fake.nextFailure
	fake.nextFailure = nil
	fake.mu.Unlock()

	if failure != nil {
		cancel()
		fake.finishExecution(request.ExecutionID, generation, failure)
		return runtimebackend.ExecutionResult{}, failure
	}
	if bytes.Equal(request.Input, []byte(BlockingInput)) {
		<-executionContext.Done()
		failure = runtimebackend.NormalizeExecutionError(executionContext.Err())
		fake.finishExecution(request.ExecutionID, generation, failure)
		return runtimebackend.ExecutionResult{}, failure
	}
	maximum := int(request.MaximumOutputBytes)
	if maximum > len(request.Input) {
		maximum = len(request.Input)
	}
	output := append([]byte{}, request.Input[:maximum]...)
	cancel()
	fake.finishExecution(request.ExecutionID, generation, nil)
	return runtimebackend.ExecutionResult{Output: output}, nil
}

func (fake *Fake) ExecuteStream(ctx context.Context, request runtimebackend.ExecutionRequest, emit runtimebackend.EmitFunc) (runtimebackend.ExecutionSummary, error) {
	if !fake.Descriptor().Capabilities.Stream {
		return runtimebackend.ExecutionSummary{}, runtimebackend.ErrCapabilityUnavailable
	}
	if emit == nil {
		return runtimebackend.ExecutionSummary{}, runtimebackend.ErrInvalid
	}
	result, err := fake.Execute(ctx, request)
	if err != nil {
		return runtimebackend.ExecutionSummary{}, err
	}
	if err := emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventPrefillComplete}); err != nil {
		return runtimebackend.ExecutionSummary{}, err
	}
	if err := emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: result.Output, Final: true}); err != nil {
		return runtimebackend.ExecutionSummary{}, err
	}
	return runtimebackend.ExecutionSummary{OutputBytes: uint64(len(result.Output)), OutputTokens: 1}, nil
}

func (fake *Fake) Cancel(ctx context.Context, request runtimebackend.CancelRequest) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if !fake.Descriptor().Capabilities.Cancel {
		return runtimebackend.ErrCapabilityUnavailable
	}
	if err := runtimebackend.ValidateCancelRequest(request, fake.now()); err != nil {
		return err
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	execution, found := fake.executions[request.ExecutionID]
	if !found {
		return runtimebackend.ErrExecutionUnknown
	}
	if execution.grantID != request.Grant.ID || execution.policyRevision != request.Grant.PolicyRevision ||
		execution.trafficClass != request.Grant.TrafficClass {
		return runtimebackend.ErrGrantMismatch
	}
	execution.cancel()
	return nil
}

// WaitUntilExecuting is test-only synchronization for the conformance suite.
func (fake *Fake) WaitUntilExecuting(ctx context.Context, executionID string) error {
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		fake.mu.Lock()
		_, found := fake.executions[executionID]
		fake.mu.Unlock()
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

func (fake *Fake) hasDownloadForAnotherOwnerLocked(key modelOwnershipKey, receipt runtimebackend.DownloadedModel) bool {
	for candidate, download := range fake.downloads {
		if candidate.modelID == key.modelID && candidate.contentDigest == key.contentDigest && candidate != key && download == receipt {
			return true
		}
	}
	return false
}

func (fake *Fake) hasModelForGrantLocked(grant runtimebackend.OperationGrant) bool {
	for key := range fake.models {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	return false
}

func (fake *Fake) modelKeysForOwnerLocked(grant runtimebackend.OperationGrant, modelID string) []modelOwnershipKey {
	keys := make(map[modelOwnershipKey]struct{})
	for key := range fake.models {
		if key.modelID == modelID && sameModelOwner(key, grant) {
			keys[key] = struct{}{}
		}
	}
	for key := range fake.downloads {
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

func (fake *Fake) hasModelIDForAnotherOwnerLocked(grant runtimebackend.OperationGrant, modelID string) bool {
	for key := range fake.models {
		if key.modelID == modelID && !sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range fake.downloads {
		if key.modelID == modelID && !sameModelOwner(key, grant) {
			return true
		}
	}
	return false
}

func (fake *Fake) loadedModelCountLocked(grant runtimebackend.OperationGrant, modelID string) int {
	count := 0
	for key := range fake.models {
		if key.modelID == modelID && sameModelOwner(key, grant) {
			count++
		}
	}
	return count
}

func (fake *Fake) hasResourcesForAnotherOwnerLocked(grant runtimebackend.OperationGrant) bool {
	owner := runtimeOwnerKey(grant)
	for candidate := range fake.runtimeOwners {
		if candidate != owner {
			return true
		}
	}
	for key := range fake.models {
		if !sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range fake.downloads {
		if !sameModelOwner(key, grant) {
			return true
		}
	}
	for _, execution := range fake.executions {
		if execution.grantID != grant.ID || execution.policyRevision != grant.PolicyRevision || execution.trafficClass != grant.TrafficClass {
			return true
		}
	}
	return false
}

func (fake *Fake) hasActiveResourcesForOwnerLocked(grant runtimebackend.OperationGrant) bool {
	for key := range fake.models {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	for key := range fake.downloads {
		if sameModelOwner(key, grant) {
			return true
		}
	}
	for _, execution := range fake.executions {
		if execution.grantID == grant.ID && execution.policyRevision == grant.PolicyRevision && execution.trafficClass == grant.TrafficClass {
			return true
		}
	}
	return false
}

func (fake *Fake) healthLocked() runtimebackend.Health {
	state := "not-installed"
	if fake.installed {
		state = "stopped"
	}
	if fake.running {
		state = "running"
	}
	return runtimebackend.Health{State: state, Installed: fake.installed, Running: fake.running}
}

func (fake *Fake) finishExecution(executionID string, generation uint64, failure error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if current, found := fake.executions[executionID]; found && current.generation == generation {
		delete(fake.executions, executionID)
		if fake.metrics.InFlight > 0 {
			fake.metrics.InFlight--
		}
	}
	fake.metrics.ExecutionSamples++
	fake.metrics.LoadMillisecondsP50 = 1
	fake.metrics.PrefillMillisecondsP50 = 1
	fake.metrics.TimeToFirstTokenMillisecondsP50 = 2
	fake.metrics.TokensPerSecondMilliP50 = 1000
	if fake.metrics.MemoryBytes == 0 {
		fake.metrics.MemoryBytes = 4096
	}
	if failure == nil {
		return
	}
	fake.metrics.ExecutionErrors++
	switch {
	case errors.Is(failure, runtimebackend.ErrOutOfMemory):
		fake.metrics.OutOfMemoryErrors++
	case errors.Is(failure, runtimebackend.ErrCrashed):
		fake.metrics.CrashErrors++
		fake.running = false
		clear(fake.runtimeOwners)
	case errors.Is(failure, runtimebackend.ErrTimedOut):
		fake.metrics.TimeoutErrors++
	case errors.Is(failure, runtimebackend.ErrCancelled):
		fake.metrics.CancelledExecutions++
	}
}

func (fake *Fake) cancelExecutionsLocked() {
	for executionID, execution := range fake.executions {
		execution.cancel()
		delete(fake.executions, executionID)
	}
	fake.metrics.InFlight = 0
}

func (fake *Fake) recordExecutionFailure(failure error) {
	if !errors.Is(failure, runtimebackend.ErrCancelled) && !errors.Is(failure, runtimebackend.ErrTimedOut) {
		return
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.metrics.ExecutionErrors++
	if errors.Is(failure, runtimebackend.ErrCancelled) {
		fake.metrics.CancelledExecutions++
	} else {
		fake.metrics.TimeoutErrors++
	}
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return runtimebackend.ErrInvalid
	}
	return runtimebackend.NormalizeExecutionError(ctx.Err())
}

func cloneDescriptor(source runtimebackend.Descriptor) runtimebackend.Descriptor {
	descriptor := source
	descriptor.Accelerators = append([]runtimebackend.AcceleratorConstraint{}, source.Accelerators...)
	descriptor.Provenance.ArtifactSHA256 = make(map[string]string, len(source.Provenance.ArtifactSHA256))
	for platform, digest := range source.Provenance.ArtifactSHA256 {
		descriptor.Provenance.ArtifactSHA256[platform] = digest
	}
	descriptor.Provenance.ContainerImages = append([]string{}, source.Provenance.ContainerImages...)
	sort.Strings(descriptor.Provenance.ContainerImages)
	return descriptor
}

var (
	_ runtimebackend.Backend        = (*Fake)(nil)
	_ runtimebackend.Executor       = (*Fake)(nil)
	_ runtimebackend.StreamExecutor = (*Fake)(nil)
	_ runtimebackend.Canceller      = (*Fake)(nil)
)
