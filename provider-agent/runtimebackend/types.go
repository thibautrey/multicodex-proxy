package runtimebackend

import (
	"context"
	"fmt"
	"time"
)

const (
	// ContractVersion is the first stable public Go runtime-backend contract.
	ContractVersion = "provider-runtime-backend-v1"
	// MetricsVersion identifies the normalized metrics schema.
	MetricsVersion = "provider-runtime-metrics-v1"
)

// Capabilities declares optional runtime surfaces and traffic policy. Backend
// lifecycle methods are mandatory and therefore are not capability flags.
type Capabilities struct {
	Execute         bool `json:"execute"`
	Stream          bool `json:"stream"`
	Cancel          bool `json:"cancel"`
	ShadowOnly      bool `json:"shadow_only"`
	CustomerTraffic bool `json:"customer_traffic"`
}

// AcceleratorConstraint describes public hardware compatibility. It contains
// no device identifiers or local paths.
type AcceleratorConstraint struct {
	Profile      string `json:"profile"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Kind         string `json:"kind"`
}

// Accelerator describes hardware detected by the worker for one selection.
type Accelerator struct {
	Profile      string `json:"profile"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Kind         string `json:"kind"`
	MemoryBytes  uint64 `json:"memory_bytes"`
}

// Discovery is a sanitized hardware snapshot. Backends must not include local
// device identifiers, filesystem paths or command output.
type Discovery struct {
	Accelerators []Accelerator
}

// Limits bounds every operation accepted by a backend. Limits are copied into
// grants and descriptors, never inferred from backend-specific package types.
type Limits struct {
	MaximumModels        uint32 `json:"maximum_models"`
	MaximumConcurrency   uint32 `json:"maximum_concurrency"`
	MaximumModelBytes    uint64 `json:"maximum_model_bytes"`
	MaximumMemoryBytes   uint64 `json:"maximum_memory_bytes"`
	MaximumContextTokens uint64 `json:"maximum_context_tokens"`
	MaximumInputBytes    uint64 `json:"maximum_input_bytes"`
	MaximumOutputBytes   uint64 `json:"maximum_output_bytes"`
}

// Provenance pins the public source and exact artifacts represented by a
// descriptor. ArtifactSHA256 keys are platform identifiers, never paths.
type Provenance struct {
	SourceURL       string            `json:"source_url"`
	Version         string            `json:"version"`
	ArtifactSHA256  map[string]string `json:"artifact_sha256,omitempty"`
	ContainerImages []string          `json:"container_images,omitempty"`
}

// Descriptor is safe to expose in diagnostics and selection explanations. In
// particular, it intentionally has no executable, argv, environment, socket,
// local path or device identifier field.
type Descriptor struct {
	ContractVersion string                  `json:"contract_version"`
	ID              string                  `json:"id"`
	Priority        uint16                  `json:"priority"`
	Capabilities    Capabilities            `json:"capabilities"`
	Accelerators    []AcceleratorConstraint `json:"accelerators"`
	Limits          Limits                  `json:"limits"`
	Provenance      Provenance              `json:"provenance"`
}

// OperationGrant is a short-lived, process-local authorization. ID and
// PolicyRevision jointly own every execution started under the grant, while
// TrafficClass fixes the only class of traffic it may carry. Its fields are
// deliberately excluded from JSON so a grant cannot accidentally become a
// network contract or log payload.
type OperationGrant struct {
	ID              string       `json:"-"`
	PolicyRevision  uint64       `json:"-"`
	TrafficClass    TrafficClass `json:"-"`
	IssuedAt        time.Time    `json:"-"`
	ExpiresAt       time.Time    `json:"-"`
	AllowedModelIDs []string     `json:"-"`
	Limits          Limits       `json:"-"`
}

// ModelRequirements contains runtime-neutral model constraints.
type ModelRequirements struct {
	ID                   string `json:"id"`
	ContentDigest        string `json:"content_digest"`
	ArtifactBytes        uint64 `json:"artifact_bytes"`
	EstimatedMemoryBytes uint64 `json:"estimated_memory_bytes"`
	ContextTokens        uint64 `json:"context_tokens"`
}

// CompatibilityRequest asks a backend to evaluate one already validated
// workload without mutating runtime state.
type CompatibilityRequest struct {
	Grant                OperationGrant
	EvaluationTime       time.Time `json:"-"`
	Accelerator          Accelerator
	Model                ModelRequirements
	RequiredCapabilities CapabilityRequirements
}

// Compatibility contains only stable reason codes. A backend-specific error or
// local command output must never be copied into Reasons.
type Compatibility struct {
	Compatible bool
	Reasons    []ReasonCode
}

// DownloadRequest authorizes acquiring or re-verifying one exact model.
type DownloadRequest struct {
	Grant OperationGrant
	Model ModelRequirements
}

// DownloadedModel is a verification receipt. It never contains a local path.
type DownloadedModel struct {
	BackendID     string
	ModelID       string
	ContentDigest string
	Bytes         uint64
}

// LoadRequest asks a backend to load one exact model under a current grant.
type LoadRequest struct {
	Grant    OperationGrant
	Model    ModelRequirements
	Download DownloadedModel
}

// LoadedModel is a backend-neutral receipt for a loaded model.
type LoadedModel struct {
	BackendID     string
	ModelID       string
	ContentDigest string
}

// TrafficClass identifies whether an execution is an isolated shadow probe or
// serves customer traffic. Callers must set it explicitly; the zero value is
// invalid so a missing policy decision fails closed.
type TrafficClass string

const (
	// TrafficClassShadow is isolated evaluation traffic that must not affect a
	// customer-visible response.
	TrafficClassShadow TrafficClass = "shadow"
	// TrafficClassCustomer is traffic whose output may be returned to a
	// customer. A backend must explicitly advertise CustomerTraffic to receive
	// it and must not be marked ShadowOnly.
	TrafficClassCustomer TrafficClass = "customer"
)

// ExecutionRequest is the shared non-streaming and streaming request shape.
// TrafficClass is mandatory and is rechecked by registry dispatch against the
// immutable descriptor snapshot.
type ExecutionRequest struct {
	Grant              OperationGrant `json:"-"`
	ExecutionID        string         `json:"execution_id"`
	ModelID            string         `json:"model_id"`
	TrafficClass       TrafficClass   `json:"traffic_class"`
	Input              []byte         `json:"-"`
	MaximumOutputBytes uint64         `json:"maximum_output_bytes"`
}

func (request ExecutionRequest) String() string {
	return fmt.Sprintf("ExecutionRequest{ExecutionID:%q ModelID:%q TrafficClass:%q Input:<redacted:%d bytes> MaximumOutputBytes:%d}",
		request.ExecutionID, request.ModelID, request.TrafficClass, len(request.Input), request.MaximumOutputBytes)
}

func (request ExecutionRequest) GoString() string { return request.String() }

// ExecutionResult contains a bounded complete output.
type ExecutionResult struct {
	Output []byte `json:"-"`
}

func (result ExecutionResult) String() string {
	return fmt.Sprintf("ExecutionResult{Output:<redacted:%d bytes>}", len(result.Output))
}

func (result ExecutionResult) GoString() string { return result.String() }

// ExecutionEvent identifies a backend-neutral stream observation.
type ExecutionEvent string

const (
	// ExecutionEventPrefillComplete is an optional zero-output observation that
	// lets a benchmark distinguish prefill from first-token latency.
	ExecutionEventPrefillComplete ExecutionEvent = "prefill-complete"
	// ExecutionEventOutput carries generated output.
	ExecutionEventOutput ExecutionEvent = "output"
)

// ExecutionChunk is emitted by StreamExecutor. Exactly one output chunk must
// be final for a successful stream. Backends unable to observe prefill may omit
// ExecutionEventPrefillComplete; benchmark reports must mark that fallback.
type ExecutionChunk struct {
	Event  ExecutionEvent
	Output []byte `json:"-"`
	Final  bool
}

func (chunk ExecutionChunk) String() string {
	return fmt.Sprintf("ExecutionChunk{Event:%q Output:<redacted:%d bytes> Final:%t}", chunk.Event, len(chunk.Output), chunk.Final)
}

func (chunk ExecutionChunk) GoString() string { return chunk.String() }

// ExecutionSummary describes a completed stream without backend-specific data.
type ExecutionSummary struct {
	OutputBytes  uint64
	OutputTokens uint64
}

// EmitFunc consumes one bounded stream chunk.
type EmitFunc func(ExecutionChunk) error

// CancelRequest identifies an active execution under its owning current grant.
// Matching an ExecutionID without matching grant ID and policy revision is not
// sufficient authorization.
type CancelRequest struct {
	Grant       OperationGrant
	ExecutionID string
}

// CleanupRequest removes only explicitly named models and optionally stops the
// runtime. An empty model list never means "all models".
type CleanupRequest struct {
	Grant       OperationGrant
	ModelIDs    []string
	StopRuntime bool
}

// Health is a normalized lifecycle view.
type Health struct {
	State     string
	Installed bool
	Running   bool
}

// Readiness keeps readiness separate from health and carries only a stable
// reason code suitable for diagnostics.
type Readiness struct {
	Ready  bool
	Reason ReasonCode
}

// Metrics is the normalized, bounded backend metrics contract.
type Metrics struct {
	SchemaVersion                   string `json:"schema_version"`
	Running                         bool   `json:"running"`
	InstalledModels                 uint32 `json:"installed_models"`
	InFlight                        uint32 `json:"in_flight"`
	ExecutionSamples                uint64 `json:"execution_samples"`
	LoadMillisecondsP50             uint64 `json:"load_milliseconds_p50"`
	PrefillMillisecondsP50          uint64 `json:"prefill_milliseconds_p50"`
	TimeToFirstTokenMillisecondsP50 uint64 `json:"time_to_first_token_milliseconds_p50"`
	TokensPerSecondMilliP50         uint64 `json:"tokens_per_second_milli_p50"`
	MemoryBytes                     uint64 `json:"memory_bytes"`
	ExecutionErrors                 uint64 `json:"execution_errors"`
	OutOfMemoryErrors               uint64 `json:"out_of_memory_errors"`
	CrashErrors                     uint64 `json:"crash_errors"`
	TimeoutErrors                   uint64 `json:"timeout_errors"`
	CancelledExecutions             uint64 `json:"cancelled_executions"`
}

// Backend is the mandatory lifecycle contract. Stop is a global mutation and
// must return ErrGrantMismatch without changing state whenever the running
// runtime or any active resource belongs to another grant ID, policy revision,
// or traffic class. Optional execution surfaces are represented by Executor,
// StreamExecutor and Canceller below.
type Backend interface {
	Descriptor() Descriptor
	Discover(context.Context, OperationGrant) (Discovery, error)
	Compatible(context.Context, CompatibilityRequest) (Compatibility, error)
	Prepare(context.Context, OperationGrant) (Health, error)
	Download(context.Context, DownloadRequest) (DownloadedModel, error)
	Start(context.Context, OperationGrant) (Health, error)
	Load(context.Context, LoadRequest) (LoadedModel, error)
	Health(context.Context, OperationGrant) (Health, error)
	Ready(context.Context, OperationGrant) (Readiness, error)
	Metrics(context.Context, OperationGrant) (Metrics, error)
	Cleanup(context.Context, CleanupRequest) error
	Stop(context.Context, OperationGrant) error
}

// Executor is implemented only by backends that advertise Execute.
type Executor interface {
	Execute(context.Context, ExecutionRequest) (ExecutionResult, error)
}

// StreamExecutor is implemented only by backends that advertise Stream.
type StreamExecutor interface {
	ExecuteStream(context.Context, ExecutionRequest, EmitFunc) (ExecutionSummary, error)
}

// Canceller is implemented only by backends that advertise Cancel.
type Canceller interface {
	Cancel(context.Context, CancelRequest) error
}
