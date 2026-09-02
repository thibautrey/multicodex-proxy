package runtimebackend

import (
	"context"
	"reflect"
	"sort"
	"sync"
	"time"
)

type registeredBackend struct {
	backend    Backend
	descriptor Descriptor
	launch     launchPolicy
}

// guardedLifecycleBackend exposes the descriptor snapshot captured by the
// registry and keeps the concrete backend behind an explicit validation
// boundary. The concrete wrappers below add exactly the optional interfaces
// that were advertised at registration time.
type guardedLifecycleBackend struct {
	backend    Backend
	descriptor Descriptor
	now        func() time.Time
	mu         sync.Mutex
	executions map[string]guardedExecutionOwner
}

type guardedExecutionOwner struct {
	grantID        string
	policyRevision uint64
	trafficClass   TrafficClass
	modelID        string
}

func (backend *guardedLifecycleBackend) Descriptor() Descriptor {
	return cloneDescriptor(backend.descriptor)
}

func (backend *guardedLifecycleBackend) Discover(ctx context.Context, grant OperationGrant) (Discovery, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Discovery{}, err
	}
	discovery, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Discovery, error) {
		return backend.backend.Discover(operationContext, cloneOperationGrant(grant))
	})
	if err != nil {
		return Discovery{}, err
	}
	if ValidateDiscovery(backend.descriptor, discovery) != nil {
		return Discovery{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Discovery{}, err
	}
	return cloneDiscovery(discovery), nil
}

func (backend *guardedLifecycleBackend) Compatible(ctx context.Context, request CompatibilityRequest) (Compatibility, error) {
	if err := validateContext(ctx); err != nil {
		return Compatibility{}, err
	}
	if err := ValidateCompatibilityRequest(request); err != nil {
		return Compatibility{}, err
	}
	if err := backend.validateGrant(request.Grant, backend.now()); err != nil {
		return Compatibility{}, err
	}
	if err := validateModelLimitsForDescriptor(backend.descriptor, request.Model); err != nil {
		return Compatibility{}, err
	}
	request.Grant = cloneOperationGrant(request.Grant)
	compatibility, err := safeBackendGrantCall(ctx, request.Grant, backend.now, func(operationContext context.Context) (Compatibility, error) {
		return backend.backend.Compatible(operationContext, request)
	})
	if err != nil {
		return Compatibility{}, err
	}
	if ValidateCompatibility(compatibility) != nil {
		return Compatibility{}, ErrBackendFailure
	}
	compatibility.Reasons = append([]ReasonCode{}, compatibility.Reasons...)
	if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
		return Compatibility{}, err
	}
	return compatibility, nil
}

func (backend *guardedLifecycleBackend) Prepare(ctx context.Context, grant OperationGrant) (Health, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	health, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Health, error) {
		return backend.backend.Prepare(operationContext, cloneOperationGrant(grant))
	})
	health, err = validatedHealth(health, err)
	if err != nil {
		return Health{}, err
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	return health, nil
}

func (backend *guardedLifecycleBackend) Download(ctx context.Context, request DownloadRequest) (DownloadedModel, error) {
	at := backend.now()
	if err := validateContext(ctx); err != nil {
		return DownloadedModel{}, err
	}
	if err := ValidateDownloadRequest(request, at); err != nil {
		return DownloadedModel{}, err
	}
	if err := backend.validateGrant(request.Grant, at); err != nil {
		return DownloadedModel{}, err
	}
	if err := validateModelLimitsForDescriptor(backend.descriptor, request.Model); err != nil {
		return DownloadedModel{}, err
	}
	request.Grant = cloneOperationGrant(request.Grant)
	download, err := safeBackendGrantCall(ctx, request.Grant, backend.now, func(operationContext context.Context) (DownloadedModel, error) {
		return backend.backend.Download(operationContext, request)
	})
	if err != nil {
		return DownloadedModel{}, err
	}
	if download.BackendID != backend.descriptor.ID || download.ModelID != request.Model.ID ||
		download.ContentDigest != request.Model.ContentDigest || download.Bytes != request.Model.ArtifactBytes {
		return DownloadedModel{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
		return DownloadedModel{}, err
	}
	return download, nil
}

func (backend *guardedLifecycleBackend) Start(ctx context.Context, grant OperationGrant) (Health, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	health, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Health, error) {
		return backend.backend.Start(operationContext, cloneOperationGrant(grant))
	})
	health, err = validatedHealth(health, err)
	if err != nil {
		return Health{}, err
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	return health, nil
}

func (backend *guardedLifecycleBackend) Load(ctx context.Context, request LoadRequest) (LoadedModel, error) {
	at := backend.now()
	if err := validateContext(ctx); err != nil {
		return LoadedModel{}, err
	}
	if err := ValidateLoadRequest(request, at); err != nil {
		return LoadedModel{}, err
	}
	if err := backend.validateGrant(request.Grant, at); err != nil {
		return LoadedModel{}, err
	}
	if err := validateModelLimitsForDescriptor(backend.descriptor, request.Model); err != nil ||
		request.Download.BackendID != backend.descriptor.ID {
		return LoadedModel{}, ErrInvalid
	}
	request.Grant = cloneOperationGrant(request.Grant)
	loaded, err := safeBackendGrantCall(ctx, request.Grant, backend.now, func(operationContext context.Context) (LoadedModel, error) {
		return backend.backend.Load(operationContext, request)
	})
	if err != nil {
		return LoadedModel{}, err
	}
	if loaded.BackendID != backend.descriptor.ID || loaded.ModelID != request.Model.ID ||
		loaded.ContentDigest != request.Model.ContentDigest {
		return LoadedModel{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
		return LoadedModel{}, err
	}
	return loaded, nil
}

func (backend *guardedLifecycleBackend) Health(ctx context.Context, grant OperationGrant) (Health, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	health, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Health, error) {
		return backend.backend.Health(operationContext, cloneOperationGrant(grant))
	})
	health, err = validatedHealth(health, err)
	if err != nil {
		return Health{}, err
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Health{}, err
	}
	return health, nil
}

func (backend *guardedLifecycleBackend) Ready(ctx context.Context, grant OperationGrant) (Readiness, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Readiness{}, err
	}
	readiness, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Readiness, error) {
		return backend.backend.Ready(operationContext, cloneOperationGrant(grant))
	})
	if err != nil {
		return Readiness{}, err
	}
	if ValidateReadiness(readiness) != nil {
		return Readiness{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Readiness{}, err
	}
	return readiness, nil
}

func (backend *guardedLifecycleBackend) Metrics(ctx context.Context, grant OperationGrant) (Metrics, error) {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return Metrics{}, err
	}
	metrics, err := safeBackendGrantCall(ctx, grant, backend.now, func(operationContext context.Context) (Metrics, error) {
		return backend.backend.Metrics(operationContext, cloneOperationGrant(grant))
	})
	if err != nil {
		return Metrics{}, err
	}
	if ValidateMetrics(backend.descriptor, metrics) != nil {
		return Metrics{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, grant, backend.now()); err != nil {
		return Metrics{}, err
	}
	return metrics, nil
}

func (backend *guardedLifecycleBackend) Cleanup(ctx context.Context, request CleanupRequest) error {
	at := backend.now()
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := ValidateCleanupRequest(request, at); err != nil {
		return err
	}
	if err := backend.validateGrant(request.Grant, at); err != nil {
		return err
	}
	request.Grant = cloneOperationGrant(request.Grant)
	request.ModelIDs = append([]string{}, request.ModelIDs...)
	return safeBackendGrantAction(ctx, request.Grant, backend.now, func(operationContext context.Context) error {
		return backend.backend.Cleanup(operationContext, request)
	})
}

func (backend *guardedLifecycleBackend) Stop(ctx context.Context, grant OperationGrant) error {
	if err := backend.validateOperation(ctx, grant, backend.now()); err != nil {
		return err
	}
	return safeBackendGrantAction(ctx, grant, backend.now, func(operationContext context.Context) error {
		return backend.backend.Stop(operationContext, cloneOperationGrant(grant))
	})
}

func (backend *guardedLifecycleBackend) execute(ctx context.Context, request ExecutionRequest) (ExecutionResult, error) {
	finish, err := backend.beginExecution(ctx, request)
	if err != nil {
		return ExecutionResult{}, err
	}
	defer finish()
	executor, ok := backend.backend.(Executor)
	if !ok {
		return ExecutionResult{}, ErrCapabilityUnavailable
	}
	request = cloneExecutionRequest(request)
	result, err := safeBackendGrantCall(ctx, request.Grant, backend.now, func(operationContext context.Context) (ExecutionResult, error) {
		return executor.Execute(operationContext, request)
	})
	if err != nil {
		return ExecutionResult{}, err
	}
	if uint64(len(result.Output)) > request.MaximumOutputBytes ||
		uint64(len(result.Output)) > backend.descriptor.Limits.MaximumOutputBytes {
		return ExecutionResult{}, ErrBackendFailure
	}
	result.Output = append([]byte(nil), result.Output...)
	if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
		return ExecutionResult{}, err
	}
	return result, nil
}

func (backend *guardedLifecycleBackend) executeStream(ctx context.Context, request ExecutionRequest, emit EmitFunc) (ExecutionSummary, error) {
	if emit == nil {
		return ExecutionSummary{}, ErrInvalid
	}
	finish, err := backend.beginExecution(ctx, request)
	if err != nil {
		return ExecutionSummary{}, err
	}
	defer finish()
	executor, ok := backend.backend.(StreamExecutor)
	if !ok {
		return ExecutionSummary{}, ErrCapabilityUnavailable
	}

	request = cloneExecutionRequest(request)
	maximumOutputBytes := request.MaximumOutputBytes
	if backend.descriptor.Limits.MaximumOutputBytes < maximumOutputBytes {
		maximumOutputBytes = backend.descriptor.Limits.MaximumOutputBytes
	}
	type streamState struct {
		sync.Mutex
		outputBytes uint64
		prefillSeen bool
		outputSeen  bool
		finalSeen   bool
		finished    bool
		failure     error
	}
	state := &streamState{}
	guardedEmit := func(chunk ExecutionChunk) error {
		state.Lock()
		defer state.Unlock()
		if state.failure != nil {
			return state.failure
		}
		if state.finished {
			state.failure = ErrBackendFailure
			return state.failure
		}
		if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
			state.failure = err
			return err
		}
		switch chunk.Event {
		case ExecutionEventPrefillComplete:
			if state.prefillSeen || state.outputSeen || chunk.Final || len(chunk.Output) != 0 {
				state.failure = ErrBackendFailure
				return state.failure
			}
			state.prefillSeen = true
		case ExecutionEventOutput:
			if state.finalSeen || len(chunk.Output) == 0 {
				state.failure = ErrBackendFailure
				return state.failure
			}
			chunkBytes := uint64(len(chunk.Output))
			if chunkBytes > maximumOutputBytes-state.outputBytes {
				state.failure = ErrBackendFailure
				return state.failure
			}
			state.outputSeen = true
			state.outputBytes += chunkBytes
			state.finalSeen = chunk.Final
		default:
			state.failure = ErrBackendFailure
			return state.failure
		}
		chunk.Output = append([]byte(nil), chunk.Output...)
		if err := NormalizeExecutionError(safeBackendAction(func() error { return emit(chunk) })); err != nil {
			state.failure = err
			return err
		}
		if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
			state.failure = err
			return err
		}
		return nil
	}

	summary, executionErr := safeBackendGrantCall(ctx, request.Grant, backend.now, func(operationContext context.Context) (ExecutionSummary, error) {
		return executor.ExecuteStream(operationContext, request, guardedEmit)
	})
	state.Lock()
	state.finished = true
	outputBytes := state.outputBytes
	finalSeen := state.finalSeen
	streamFailure := state.failure
	state.Unlock()
	if streamFailure != nil {
		return ExecutionSummary{}, streamFailure
	}
	if executionErr != nil {
		return ExecutionSummary{}, executionErr
	}
	if !finalSeen || summary.OutputBytes != outputBytes || summary.OutputTokens == 0 {
		return ExecutionSummary{}, ErrBackendFailure
	}
	if err := validateOperationCompletion(ctx, request.Grant, backend.now()); err != nil {
		return ExecutionSummary{}, err
	}
	return summary, nil
}

func (backend *guardedLifecycleBackend) cancel(ctx context.Context, request CancelRequest) error {
	at := backend.now()
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := ValidateCancelRequest(request, at); err != nil {
		return err
	}
	if err := validateGrantLimitsForDescriptor(backend.descriptor, request.Grant); err != nil {
		return err
	}
	backend.mu.Lock()
	owner, active := backend.executions[request.ExecutionID]
	backend.mu.Unlock()
	if active && (owner.grantID != request.Grant.ID || owner.policyRevision != request.Grant.PolicyRevision ||
		owner.trafficClass != request.Grant.TrafficClass || !containsSorted(request.Grant.AllowedModelIDs, owner.modelID)) {
		return ErrGrantMismatch
	}
	if err := validateExecutionTrafficPolicy(backend.descriptor, request.Grant.TrafficClass); err != nil {
		return err
	}
	canceller, ok := backend.backend.(Canceller)
	if !ok {
		return ErrCapabilityUnavailable
	}
	request.Grant = cloneOperationGrant(request.Grant)
	return safeBackendGrantAction(ctx, request.Grant, backend.now, func(operationContext context.Context) error {
		return canceller.Cancel(operationContext, request)
	})
}

func (backend *guardedLifecycleBackend) beginExecution(ctx context.Context, request ExecutionRequest) (func(), error) {
	if err := validateContext(ctx); err != nil {
		return nil, err
	}
	at := backend.now()
	if err := ValidateExecutionRequestForDescriptor(backend.descriptor, request, at); err != nil {
		return nil, err
	}
	if err := validateGrantLimitsForDescriptor(backend.descriptor, request.Grant); err != nil {
		return nil, err
	}
	owner := guardedExecutionOwner{
		grantID: request.Grant.ID, policyRevision: request.Grant.PolicyRevision, trafficClass: request.Grant.TrafficClass,
		modelID: request.ModelID,
	}
	backend.mu.Lock()
	if _, duplicate := backend.executions[request.ExecutionID]; duplicate {
		backend.mu.Unlock()
		return nil, ErrInvalid
	}
	if uint64(len(backend.executions)) >= uint64(request.Grant.Limits.MaximumConcurrency) {
		backend.mu.Unlock()
		return nil, ErrIncompatible
	}
	backend.executions[request.ExecutionID] = owner
	backend.mu.Unlock()
	return func() {
		backend.mu.Lock()
		if current, found := backend.executions[request.ExecutionID]; found && current == owner {
			delete(backend.executions, request.ExecutionID)
		}
		backend.mu.Unlock()
	}, nil
}

func (backend *guardedLifecycleBackend) validateOperation(ctx context.Context, grant OperationGrant, at time.Time) error {
	if err := validateContext(ctx); err != nil {
		return err
	}
	return backend.validateGrant(grant, at)
}

func (backend *guardedLifecycleBackend) validateGrant(grant OperationGrant, at time.Time) error {
	if err := ValidateOperationGrant(grant, at); err != nil {
		return err
	}
	if err := validateGrantLimitsForDescriptor(backend.descriptor, grant); err != nil {
		return err
	}
	return validateExecutionTrafficPolicy(backend.descriptor, grant.TrafficClass)
}

func validateContext(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalid
	}
	return NormalizeExecutionError(ctx.Err())
}

func validateGrantLimitsForDescriptor(descriptor Descriptor, grant OperationGrant) error {
	limits := grant.Limits
	descriptorLimits := descriptor.Limits
	if len(grant.AllowedModelIDs) > int(descriptorLimits.MaximumModels) ||
		limits.MaximumModels > descriptorLimits.MaximumModels ||
		limits.MaximumConcurrency > descriptorLimits.MaximumConcurrency ||
		limits.MaximumModelBytes > descriptorLimits.MaximumModelBytes ||
		limits.MaximumMemoryBytes > descriptorLimits.MaximumMemoryBytes ||
		limits.MaximumContextTokens > descriptorLimits.MaximumContextTokens ||
		limits.MaximumInputBytes > descriptorLimits.MaximumInputBytes ||
		limits.MaximumOutputBytes > descriptorLimits.MaximumOutputBytes {
		return ErrInvalid
	}
	return nil
}

func validateModelLimitsForDescriptor(descriptor Descriptor, model ModelRequirements) error {
	if model.ArtifactBytes > descriptor.Limits.MaximumModelBytes ||
		model.EstimatedMemoryBytes > descriptor.Limits.MaximumMemoryBytes ||
		model.ContextTokens > descriptor.Limits.MaximumContextTokens {
		return ErrInvalid
	}
	return nil
}

func validatedHealth(health Health, err error) (Health, error) {
	if err != nil {
		return Health{}, NormalizeExecutionError(err)
	}
	if ValidateHealth(health) != nil {
		return Health{}, ErrBackendFailure
	}
	return health, nil
}

func cloneDiscovery(source Discovery) Discovery {
	discovery := source
	discovery.Accelerators = append([]Accelerator{}, source.Accelerators...)
	return discovery
}

func cloneExecutionRequest(source ExecutionRequest) ExecutionRequest {
	request := source
	request.Grant = cloneOperationGrant(source.Grant)
	request.Input = append([]byte(nil), source.Input...)
	return request
}

func safeBackendCall[T any](call func() (T, error)) (result T, err error) {
	defer func() {
		if recover() != nil {
			var zero T
			result = zero
			err = ErrBackendFailure
		}
	}()
	return call()
}

func safeBackendAction(call func() error) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrBackendFailure
		}
	}()
	return call()
}

func safeBackendGrantCall[T any](
	ctx context.Context,
	grant OperationGrant,
	now func() time.Time,
	call func(context.Context) (T, error),
) (result T, err error) {
	if ctx == nil {
		return result, ErrInvalid
	}
	operationContext, cancel := context.WithDeadline(ctx, grant.ExpiresAt)
	defer cancel()
	result, err = safeBackendCall(func() (T, error) {
		return call(operationContext)
	})
	if completionErr := validateOperationCompletion(ctx, grant, now()); completionErr != nil {
		var zero T
		return zero, completionErr
	}
	if err != nil {
		var zero T
		return zero, NormalizeExecutionError(err)
	}
	return result, nil
}

func safeBackendGrantAction(
	ctx context.Context,
	grant OperationGrant,
	now func() time.Time,
	call func(context.Context) error,
) error {
	_, err := safeBackendGrantCall(ctx, grant, now, func(operationContext context.Context) (struct{}, error) {
		return struct{}{}, call(operationContext)
	})
	return err
}

func validateOperationCompletion(ctx context.Context, grant OperationGrant, at time.Time) error {
	if err := ValidateOperationGrant(grant, at); err != nil {
		return err
	}
	return validateContext(ctx)
}

type guardedExecutorBackend struct {
	*guardedLifecycleBackend
}

func (backend *guardedExecutorBackend) Execute(ctx context.Context, request ExecutionRequest) (ExecutionResult, error) {
	return backend.execute(ctx, request)
}

type guardedStreamingBackend struct {
	*guardedExecutorBackend
}

func (backend *guardedStreamingBackend) ExecuteStream(ctx context.Context, request ExecutionRequest, emit EmitFunc) (ExecutionSummary, error) {
	return backend.executeStream(ctx, request, emit)
}

type guardedCancellableBackend struct {
	*guardedExecutorBackend
}

func (backend *guardedCancellableBackend) Cancel(ctx context.Context, request CancelRequest) error {
	return backend.cancel(ctx, request)
}

type guardedStreamingCancellableBackend struct {
	*guardedStreamingBackend
}

func (backend *guardedStreamingCancellableBackend) Cancel(ctx context.Context, request CancelRequest) error {
	return backend.cancel(ctx, request)
}

// Registry is an immutable snapshot of explicitly compiled backends. It has no
// discovery or mutation API.
type Registry struct {
	byID map[string]registeredBackend
	ids  []string
}

// NewRegistry validates and snapshots one or more explicit backend instances.
// A capability declaration without the corresponding Go interface is rejected.
func NewRegistry(backends ...Backend) (*Registry, error) {
	if len(backends) == 0 || len(backends) > maximumBackends {
		return nil, ErrInvalid
	}
	registry := &Registry{
		byID: make(map[string]registeredBackend, len(backends)),
		ids:  make([]string, 0, len(backends)),
	}
	for _, backend := range backends {
		if nilInterface(backend) {
			return nil, ErrInvalid
		}
		descriptor, descriptorErr := safeBackendCall(func() (Descriptor, error) {
			return backend.Descriptor(), nil
		})
		if descriptorErr != nil {
			return nil, descriptorErr
		}
		descriptor = cloneDescriptor(descriptor)
		if ValidateDescriptor(descriptor) != nil || advertisedInterfaceMissing(backend, descriptor.Capabilities) {
			return nil, ErrInvalid
		}
		if _, duplicate := registry.byID[descriptor.ID]; duplicate {
			return nil, ErrInvalid
		}
		registry.byID[descriptor.ID] = registeredBackend{backend: guardBackend(backend, descriptor), descriptor: descriptor}
		registry.ids = append(registry.ids, descriptor.ID)
	}
	sort.Strings(registry.ids)
	return registry, nil
}

// IDs returns a sorted copy of registered IDs.
func (registry *Registry) IDs() []string {
	if registry == nil {
		return []string{}
	}
	return append([]string{}, registry.ids...)
}

// Backend returns an explicitly registered instance.
func (registry *Registry) Backend(id string) (Backend, bool) {
	if registry == nil {
		return nil, false
	}
	entry, found := registry.byID[id]
	return entry.backend, found
}

// Descriptor returns the immutable descriptor snapshot for an ID.
func (registry *Registry) Descriptor(id string) (Descriptor, bool) {
	if registry == nil {
		return Descriptor{}, false
	}
	entry, found := registry.byID[id]
	if !found {
		return Descriptor{}, false
	}
	return cloneDescriptor(entry.descriptor), true
}

// Executor returns an execution surface only when it was both declared and
// implemented at registry construction.
func (registry *Registry) Executor(id string) (Executor, bool) {
	entry, found := registry.entry(id)
	if !found || !entry.descriptor.Capabilities.Execute {
		return nil, false
	}
	executor, ok := entry.backend.(Executor)
	return executor, ok
}

// StreamExecutor returns a streaming surface only when it was declared.
func (registry *Registry) StreamExecutor(id string) (StreamExecutor, bool) {
	entry, found := registry.entry(id)
	if !found || !entry.descriptor.Capabilities.Stream {
		return nil, false
	}
	executor, ok := entry.backend.(StreamExecutor)
	return executor, ok
}

// Canceller returns an explicit cancellation surface only when it was declared.
func (registry *Registry) Canceller(id string) (Canceller, bool) {
	entry, found := registry.entry(id)
	if !found || !entry.descriptor.Capabilities.Cancel {
		return nil, false
	}
	canceller, ok := entry.backend.(Canceller)
	return canceller, ok
}

func (registry *Registry) entry(id string) (registeredBackend, bool) {
	if registry == nil {
		return registeredBackend{}, false
	}
	entry, found := registry.byID[id]
	return entry, found
}

func advertisedInterfaceMissing(backend Backend, capabilities Capabilities) bool {
	if capabilities.Execute {
		if _, ok := backend.(Executor); !ok {
			return true
		}
	}
	if capabilities.Stream {
		if _, ok := backend.(StreamExecutor); !ok {
			return true
		}
	}
	if capabilities.Cancel {
		if _, ok := backend.(Canceller); !ok {
			return true
		}
	}
	return false
}

func guardBackend(backend Backend, descriptor Descriptor) Backend {
	lifecycle := &guardedLifecycleBackend{
		backend: backend, descriptor: cloneDescriptor(descriptor), now: time.Now,
		executions: make(map[string]guardedExecutionOwner),
	}
	if !descriptor.Capabilities.Execute {
		return lifecycle
	}
	executor := &guardedExecutorBackend{guardedLifecycleBackend: lifecycle}
	if descriptor.Capabilities.Stream {
		streamer := &guardedStreamingBackend{guardedExecutorBackend: executor}
		if descriptor.Capabilities.Cancel {
			return &guardedStreamingCancellableBackend{guardedStreamingBackend: streamer}
		}
		return streamer
	}
	if descriptor.Capabilities.Cancel {
		return &guardedCancellableBackend{guardedExecutorBackend: executor}
	}
	return executor
}

func nilInterface(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

func cloneDescriptor(source Descriptor) Descriptor {
	descriptor := source
	descriptor.Accelerators = append([]AcceleratorConstraint{}, source.Accelerators...)
	descriptor.Provenance.ArtifactSHA256 = make(map[string]string, len(source.Provenance.ArtifactSHA256))
	for platform, digest := range source.Provenance.ArtifactSHA256 {
		descriptor.Provenance.ArtifactSHA256[platform] = digest
	}
	descriptor.Provenance.ContainerImages = append([]string{}, source.Provenance.ContainerImages...)
	return descriptor
}
