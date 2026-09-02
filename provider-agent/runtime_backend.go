package main

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	runtimeBackendContractVersion    = "provider-runtime-backend-v1"
	runtimeWorkloadProfileVersion    = "provider-runtime-workload-profile-v2"
	runtimeBackendOverridesVersion   = "provider-runtime-overrides-v1"
	runtimeBackendMetricsVersion     = "provider-runtime-metrics-v1"
	runtimeBackendOllamaID           = "ollama-managed"
	runtimeBackendMaximumConcurrency = 1024
)

var (
	errRuntimeBackendInvalid           = errors.New("provider runtime backend contract is invalid")
	errRuntimeBackendIncompatible      = errors.New("provider runtime backend is incompatible with the workload profile")
	errRuntimeBackendExecutionDisabled = errors.New("provider runtime execution is disabled in shadow-only mode")
	errRuntimeBackendCapabilityMissing = errors.New("provider runtime backend capability is unavailable")
	errRuntimeBackendOutOfMemory       = errors.New("provider runtime backend exhausted memory")
	errRuntimeBackendCrashed           = errors.New("provider runtime backend crashed")
	errRuntimeBackendTimedOut          = errors.New("provider runtime backend timed out")
	errRuntimeBackendCancelled         = errors.New("provider runtime backend execution was cancelled")
	errRuntimeBackendExecutionUnknown  = errors.New("provider runtime backend execution is unknown")
	runtimeBackendIDPattern            = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	runtimeBackendProfilePattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	runtimeBackendExecutablePattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$`)
	runtimeBackendPinnedImagePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[a-f0-9]{64}$`)
	runtimeExecutionIDPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type runtimeBackendCapabilities struct {
	Prepare         bool `json:"prepare"`
	Load            bool `json:"load"`
	Execute         bool `json:"execute"`
	Stream          bool `json:"stream"`
	Cancel          bool `json:"cancel"`
	Health          bool `json:"health"`
	Readiness       bool `json:"readiness"`
	Metrics         bool `json:"metrics"`
	Cleanup         bool `json:"cleanup"`
	Stop            bool `json:"stop"`
	ShadowOnly      bool `json:"shadow_only"`
	CustomerTraffic bool `json:"customer_traffic"`
}

type runtimeBackendResourceBounds struct {
	MaximumModels         uint32 `json:"maximum_models"`
	MaximumConcurrency    uint32 `json:"maximum_concurrency"`
	MaximumModelBytes     uint64 `json:"maximum_model_bytes"`
	MaximumMemoryBytes    uint64 `json:"maximum_memory_bytes"`
	MaximumContextTokens  uint64 `json:"maximum_context_tokens"`
	MaximumCommandOutput  uint64 `json:"maximum_command_output_bytes"`
	MaximumInstallSeconds uint64 `json:"maximum_install_seconds"`
	MaximumPrepareSeconds uint64 `json:"maximum_prepare_seconds"`
}

type runtimeBackendAcceleratorConstraint struct {
	Profile      string `json:"profile"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Kind         string `json:"kind"`
}

type runtimeBackendProvenance struct {
	SourceURL      string            `json:"source_url"`
	Version        string            `json:"version"`
	ArtifactSHA256 map[string]string `json:"artifact_sha256"`
}

type runtimeBackendLaunchAllowlist struct {
	ExecutableRelativePaths map[string]string            `json:"executable_relative_paths"`
	ContainerImages         []string                     `json:"container_images"`
	ArgumentTemplates       [][]string                   `json:"argument_templates"`
	Resources               runtimeBackendResourceBounds `json:"resources"`
	Provenance              runtimeBackendProvenance     `json:"provenance"`
}

type runtimeBackendDescriptor struct {
	ContractVersion string                                `json:"contract_version"`
	ID              string                                `json:"id"`
	Priority        uint16                                `json:"priority"`
	Capabilities    runtimeBackendCapabilities            `json:"capabilities"`
	Accelerators    []runtimeBackendAcceleratorConstraint `json:"accelerators"`
	Launch          runtimeBackendLaunchAllowlist         `json:"launch_allowlist"`
}

type runtimeModelProfile struct {
	ModelID              string   `json:"model_id"`
	CompatibleBackendIDs []string `json:"compatible_backend_ids"`
	ContentDigest        string   `json:"content_digest"`
	AssessmentDigest     string   `json:"assessment_digest"`
	RequiredContext      uint64   `json:"required_context_tokens"`
	EstimatedVRAMBytes   uint64   `json:"estimated_vram_bytes"`
	DownloadBytes        uint64   `json:"download_bytes"`
}

type runtimeAcceleratorProfile struct {
	Profile      string `json:"profile"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Kind         string `json:"kind"`
	MemoryBytes  uint64 `json:"memory_bytes"`
}

type runtimeWorkloadProfile struct {
	SchemaVersion string                    `json:"schema_version"`
	Model         runtimeModelProfile       `json:"model"`
	Accelerator   runtimeAcceleratorProfile `json:"accelerator"`
	Runtime       runtimeProfile            `json:"runtime"`
}

type runtimeCapabilityRequirements struct {
	Execute bool `json:"execute"`
	Stream  bool `json:"stream"`
	Cancel  bool `json:"cancel"`
	Cleanup bool `json:"cleanup"`
}

type runtimeProvenancePin struct {
	BackendID       string            `json:"backend_id"`
	SourceURL       string            `json:"source_url"`
	Version         string            `json:"version"`
	ArtifactSHA256  map[string]string `json:"artifact_sha256"`
	ContainerImages []string          `json:"container_images"`
}

type runtimeProfile struct {
	ContractVersion      string                        `json:"contract_version"`
	RequiredCapabilities runtimeCapabilityRequirements `json:"required_capabilities"`
	Provenance           []runtimeProvenancePin        `json:"provenance"`
}

// Overrides can only narrow resources or reorder compiled backends. They do
// not contain executable paths, images, arguments, origins or provenance.
type runtimeBackendOverrides struct {
	SchemaVersion       string   `json:"schema_version"`
	PreferredBackendIDs []string `json:"preferred_backend_ids"`
	DisabledBackendIDs  []string `json:"disabled_backend_ids"`
	MaximumConcurrency  uint32   `json:"maximum_concurrency,omitempty"`
	MaximumContext      uint64   `json:"maximum_context_tokens,omitempty"`
}

type runtimePrepareRequest struct {
	Policy *capacityPolicyStateDocument
}

type runtimeLoadRequest struct {
	Policy   *capacityPolicyStateDocument
	Profile  runtimeWorkloadProfile
	Download *plannedModelDownload
}

type runtimeExecuteRequest struct {
	ExecutionID   string
	ModelID       string
	Input         []byte
	MaximumOutput uint64
}

type runtimeExecuteResult struct {
	Output []byte
}

type runtimeExecuteChunk struct {
	Output []byte
	Final  bool
}

type runtimeExecutionSummary struct {
	OutputBytes  uint64
	OutputTokens uint64
}

type runtimeCleanupRequest struct {
	Policy      *capacityPolicyStateDocument
	ModelIDs    []string
	StopRuntime bool
}

type runtimeBackendHealth struct {
	State     string
	Installed bool
	Running   bool
}

type runtimeBackendMetrics struct {
	SchemaVersion                   string `json:"schema_version"`
	Running                         bool   `json:"running"`
	InstalledModels                 uint32 `json:"installed_models"`
	InFlight                        uint32 `json:"in_flight"`
	ExecutionSamples                uint64 `json:"execution_samples"`
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

type runtimeLoadedModel struct {
	BackendID     string
	ModelID       string
	ContentDigest string
}

// runtimeBackend is deliberately process-local. No network envelope names an
// implementation, executable, image or argument vector; selection operates on
// compiled instances that have already passed descriptor validation.
type runtimeBackend interface {
	ContractVersion() string
	Descriptor() runtimeBackendDescriptor
	Capabilities(context.Context) (runtimeBackendCapabilities, error)
	Compatible(runtimeWorkloadProfile, runtimeBackendOverrides) bool
	Prepare(context.Context, runtimePrepareRequest) (runtimeBackendHealth, error)
	Load(context.Context, runtimeLoadRequest) (runtimeLoadedModel, error)
	Execute(context.Context, runtimeExecuteRequest) (runtimeExecuteResult, error)
	ExecuteStream(context.Context, runtimeExecuteRequest, func(runtimeExecuteChunk) error) (runtimeExecutionSummary, error)
	Cancel(context.Context, string) error
	Health(context.Context, *capacityPolicyStateDocument) (runtimeBackendHealth, error)
	Ready(context.Context, *capacityPolicyStateDocument) (bool, error)
	Metrics(context.Context, *capacityPolicyStateDocument) (runtimeBackendMetrics, error)
	Cleanup(context.Context, runtimeCleanupRequest) error
	Stop(context.Context) error
}

type registeredRuntimeBackend struct {
	backend    runtimeBackend
	descriptor runtimeBackendDescriptor
}

// runtimeBackendRegistry is immutable after construction. Backends are linked
// into the provider-agent binary and registered explicitly by main; there is
// intentionally no filesystem discovery, dlopen or network registration path.
type runtimeBackendRegistry struct {
	byID map[string]registeredRuntimeBackend
}

type runtimeBackendSelectionExplanation struct {
	PrimaryBackendID   string   `json:"primary_backend_id"`
	FallbackBackendIDs []string `json:"fallback_backend_ids"`
	Forced             bool     `json:"forced"`
	Basis              string   `json:"basis"`
}

func cloneRuntimeBackendDescriptor(source runtimeBackendDescriptor) runtimeBackendDescriptor {
	descriptor := source
	descriptor.Accelerators = append([]runtimeBackendAcceleratorConstraint{}, source.Accelerators...)
	descriptor.Launch.ExecutableRelativePaths = make(map[string]string, len(source.Launch.ExecutableRelativePaths))
	for platform, path := range source.Launch.ExecutableRelativePaths {
		descriptor.Launch.ExecutableRelativePaths[platform] = path
	}
	descriptor.Launch.ContainerImages = append([]string{}, source.Launch.ContainerImages...)
	descriptor.Launch.ArgumentTemplates = make([][]string, len(source.Launch.ArgumentTemplates))
	for index, arguments := range source.Launch.ArgumentTemplates {
		descriptor.Launch.ArgumentTemplates[index] = append([]string{}, arguments...)
	}
	descriptor.Launch.Provenance.ArtifactSHA256 = make(map[string]string, len(source.Launch.Provenance.ArtifactSHA256))
	for platform, digest := range source.Launch.Provenance.ArtifactSHA256 {
		descriptor.Launch.Provenance.ArtifactSHA256[platform] = digest
	}
	return descriptor
}

func newRuntimeBackendRegistry(backends ...runtimeBackend) (*runtimeBackendRegistry, error) {
	if len(backends) == 0 || len(backends) > 32 {
		return nil, errRuntimeBackendInvalid
	}
	registry := &runtimeBackendRegistry{byID: make(map[string]registeredRuntimeBackend, len(backends))}
	for _, backend := range backends {
		if backend == nil || backend.ContractVersion() != runtimeBackendContractVersion {
			return nil, errRuntimeBackendInvalid
		}
		descriptor := cloneRuntimeBackendDescriptor(backend.Descriptor())
		if validateRuntimeBackendDescriptor(descriptor) != nil || descriptor.ContractVersion != backend.ContractVersion() {
			return nil, errRuntimeBackendInvalid
		}
		if _, duplicate := registry.byID[descriptor.ID]; duplicate {
			return nil, errRuntimeBackendInvalid
		}
		registry.byID[descriptor.ID] = registeredRuntimeBackend{backend: backend, descriptor: descriptor}
	}
	return registry, nil
}

func (registry *runtimeBackendRegistry) IDs() []string {
	if registry == nil {
		return []string{}
	}
	ids := make([]string, 0, len(registry.byID))
	for backendID := range registry.byID {
		ids = append(ids, backendID)
	}
	sort.Strings(ids)
	return ids
}

func (registry *runtimeBackendRegistry) Backend(backendID string) (runtimeBackend, bool) {
	if registry == nil {
		return nil, false
	}
	entry, found := registry.byID[backendID]
	return entry.backend, found
}

func validateRuntimeBackendDescriptor(descriptor runtimeBackendDescriptor) error {
	if descriptor.ContractVersion != runtimeBackendContractVersion || !runtimeBackendIDPattern.MatchString(descriptor.ID) || descriptor.Priority == 0 ||
		!descriptor.Capabilities.Prepare || !descriptor.Capabilities.Load || !descriptor.Capabilities.Health || !descriptor.Capabilities.Readiness ||
		!descriptor.Capabilities.Metrics || !descriptor.Capabilities.Cleanup || !descriptor.Capabilities.Stop ||
		(descriptor.Capabilities.Stream && !descriptor.Capabilities.Execute) || (descriptor.Capabilities.Cancel && !descriptor.Capabilities.Execute) ||
		!descriptor.Capabilities.ShadowOnly || descriptor.Capabilities.CustomerTraffic ||
		len(descriptor.Accelerators) == 0 || len(descriptor.Accelerators) > 8 {
		return errRuntimeBackendInvalid
	}
	seenAccelerators := map[string]struct{}{}
	for _, accelerator := range descriptor.Accelerators {
		key := accelerator.Profile + "\x00" + accelerator.OS + "\x00" + accelerator.Architecture + "\x00" + accelerator.Kind
		if !runtimeBackendProfilePattern.MatchString(accelerator.Profile) || (accelerator.OS != "darwin" && accelerator.OS != "linux") ||
			(accelerator.Architecture != "arm64" && accelerator.Architecture != "amd64") ||
			(accelerator.Kind != "metal" && accelerator.Kind != "cuda") {
			return errRuntimeBackendInvalid
		}
		if _, duplicate := seenAccelerators[key]; duplicate {
			return errRuntimeBackendInvalid
		}
		seenAccelerators[key] = struct{}{}
	}
	launch := descriptor.Launch
	if len(launch.ExecutableRelativePaths) > 8 || len(launch.ContainerImages) > 8 ||
		len(launch.ExecutableRelativePaths)+len(launch.ContainerImages) == 0 ||
		len(launch.ArgumentTemplates) == 0 || len(launch.ArgumentTemplates) > 32 {
		return errRuntimeBackendInvalid
	}
	for platform, path := range launch.ExecutableRelativePaths {
		if (platform != "darwin-arm64" && platform != "linux-amd64") || !runtimeBackendExecutablePattern.MatchString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path ||
			strings.Contains(path, "\\") || path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
			return errRuntimeBackendInvalid
		}
	}
	previousImage := ""
	for _, image := range launch.ContainerImages {
		if !runtimeBackendPinnedImagePattern.MatchString(image) || image <= previousImage {
			return errRuntimeBackendInvalid
		}
		previousImage = image
	}
	seenArguments := map[string]struct{}{}
	for _, arguments := range launch.ArgumentTemplates {
		if len(arguments) == 0 || len(arguments) > 16 {
			return errRuntimeBackendInvalid
		}
		for _, argument := range arguments {
			if argument == "" || strings.ContainsAny(argument, "\x00\r\n;&|`$<>") || (strings.ContainsAny(argument, "{}") && argument != "{catalog_model}") {
				return errRuntimeBackendInvalid
			}
		}
		key := strings.Join(arguments, "\x00")
		if _, duplicate := seenArguments[key]; duplicate {
			return errRuntimeBackendInvalid
		}
		seenArguments[key] = struct{}{}
	}
	resources := launch.Resources
	if resources.MaximumModels == 0 || resources.MaximumModels > managedOllamaMaximumModels || resources.MaximumConcurrency == 0 ||
		resources.MaximumConcurrency > runtimeBackendMaximumConcurrency || resources.MaximumModelBytes == 0 ||
		resources.MaximumModelBytes > maximumProviderArtifactBytes || resources.MaximumMemoryBytes == 0 || resources.MaximumMemoryBytes > maximumProviderVRAMBytes ||
		resources.MaximumContextTokens == 0 || resources.MaximumContextTokens > 131072 ||
		resources.MaximumCommandOutput == 0 || resources.MaximumCommandOutput > uint64(managedOllamaCommandOutputMaxBytes) ||
		resources.MaximumInstallSeconds == 0 || resources.MaximumInstallSeconds > uint64(managedOllamaDefaultInstallTimeout.Seconds()) ||
		resources.MaximumPrepareSeconds == 0 || resources.MaximumPrepareSeconds > uint64(managedOllamaDefaultPullTimeout.Seconds()) {
		return errRuntimeBackendInvalid
	}
	provenanceURL, err := url.Parse(launch.Provenance.SourceURL)
	if err != nil || provenanceURL.Scheme != "https" || provenanceURL.User != nil || provenanceURL.Hostname() == "" || provenanceURL.Port() != "" ||
		provenanceURL.RawQuery != "" || provenanceURL.Fragment != "" || launch.Provenance.Version == "" || len(launch.Provenance.Version) > 128 ||
		len(launch.Provenance.ArtifactSHA256) != len(launch.ExecutableRelativePaths) {
		return errRuntimeBackendInvalid
	}
	for platform, digest := range launch.Provenance.ArtifactSHA256 {
		if _, exists := launch.ExecutableRelativePaths[platform]; !exists || !validManagedOllamaSHA256(digest) {
			return errRuntimeBackendInvalid
		}
	}
	return nil
}

func validateRuntimeWorkloadProfile(profile runtimeWorkloadProfile) error {
	model := profile.Model
	accelerator := profile.Accelerator
	if profile.SchemaVersion != runtimeWorkloadProfileVersion || !validSelectedModelID(model.ModelID) || len(model.CompatibleBackendIDs) == 0 ||
		len(model.CompatibleBackendIDs) > 16 || !providerDemandContentDigest.MatchString(model.ContentDigest) ||
		!providerDigest.MatchString(model.AssessmentDigest) || !validDemandContextBucket(model.RequiredContext) || model.EstimatedVRAMBytes == 0 ||
		model.EstimatedVRAMBytes > maximumProviderVRAMBytes || model.DownloadBytes == 0 || model.DownloadBytes > maximumProviderArtifactBytes ||
		!runtimeBackendProfilePattern.MatchString(accelerator.Profile) || accelerator.MemoryBytes == 0 || accelerator.MemoryBytes > maximumProviderVRAMBytes {
		return errRuntimeBackendInvalid
	}
	previous := ""
	for _, backendID := range model.CompatibleBackendIDs {
		if !runtimeBackendIDPattern.MatchString(backendID) || backendID <= previous {
			return errRuntimeBackendInvalid
		}
		previous = backendID
	}
	if profile.Runtime.ContractVersion != runtimeBackendContractVersion || len(profile.Runtime.Provenance) != len(model.CompatibleBackendIDs) {
		return errRuntimeBackendInvalid
	}
	for index, pin := range profile.Runtime.Provenance {
		if pin.BackendID != model.CompatibleBackendIDs[index] || validateRuntimeProvenancePin(pin) != nil {
			return errRuntimeBackendInvalid
		}
	}
	if accelerator.OS != "darwin" && accelerator.OS != "linux" {
		return errRuntimeBackendInvalid
	}
	if accelerator.Architecture != "arm64" && accelerator.Architecture != "amd64" {
		return errRuntimeBackendInvalid
	}
	if accelerator.Kind != "metal" && accelerator.Kind != "cuda" {
		return errRuntimeBackendInvalid
	}
	return nil
}

func validateRuntimeProvenancePin(pin runtimeProvenancePin) error {
	parsed, err := url.Parse(pin.SourceURL)
	if err != nil || !runtimeBackendIDPattern.MatchString(pin.BackendID) || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" ||
		parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" || pin.Version == "" || len(pin.Version) > 128 ||
		len(pin.ArtifactSHA256) > 8 || len(pin.ContainerImages) > 8 || len(pin.ArtifactSHA256)+len(pin.ContainerImages) == 0 {
		return errRuntimeBackendInvalid
	}
	for platform, digest := range pin.ArtifactSHA256 {
		if (platform != "darwin-arm64" && platform != "linux-amd64") || !validManagedOllamaSHA256(digest) {
			return errRuntimeBackendInvalid
		}
	}
	previous := ""
	for _, image := range pin.ContainerImages {
		if !runtimeBackendPinnedImagePattern.MatchString(image) || image <= previous {
			return errRuntimeBackendInvalid
		}
		previous = image
	}
	return nil
}

func validateRuntimeBackendMetrics(descriptor runtimeBackendDescriptor, metrics runtimeBackendMetrics) error {
	resources := descriptor.Launch.Resources
	if metrics.SchemaVersion != runtimeBackendMetricsVersion || metrics.InstalledModels > resources.MaximumModels ||
		metrics.InFlight > resources.MaximumConcurrency || metrics.MemoryBytes > resources.MaximumMemoryBytes || (!metrics.Running && metrics.InFlight != 0) ||
		metrics.OutOfMemoryErrors > metrics.ExecutionErrors || metrics.CrashErrors > metrics.ExecutionErrors || metrics.TimeoutErrors > metrics.ExecutionErrors ||
		(metrics.ExecutionSamples == 0 && (metrics.PrefillMillisecondsP50 != 0 || metrics.TimeToFirstTokenMillisecondsP50 != 0 || metrics.TokensPerSecondMilliP50 != 0)) ||
		(metrics.ExecutionSamples > 0 && (metrics.PrefillMillisecondsP50 == 0 || metrics.TimeToFirstTokenMillisecondsP50 == 0 || metrics.TokensPerSecondMilliP50 == 0)) {
		return errRuntimeBackendInvalid
	}
	return nil
}

func validateRuntimeBackendOverrides(overrides runtimeBackendOverrides, available map[string]struct{}) error {
	if overrides.SchemaVersion != runtimeBackendOverridesVersion || len(overrides.PreferredBackendIDs) > 16 || len(overrides.DisabledBackendIDs) > 16 ||
		overrides.MaximumConcurrency > runtimeBackendMaximumConcurrency || (overrides.MaximumContext != 0 && !validDemandContextBucket(overrides.MaximumContext)) {
		return errRuntimeBackendInvalid
	}
	seen := map[string]struct{}{}
	for _, backendID := range overrides.PreferredBackendIDs {
		if _, exists := available[backendID]; !exists {
			return errRuntimeBackendInvalid
		}
		if _, duplicate := seen[backendID]; duplicate {
			return errRuntimeBackendInvalid
		}
		seen[backendID] = struct{}{}
	}
	previous := ""
	for _, backendID := range overrides.DisabledBackendIDs {
		if _, exists := available[backendID]; !exists || backendID <= previous {
			return errRuntimeBackendInvalid
		}
		if _, preferred := seen[backendID]; preferred {
			return errRuntimeBackendInvalid
		}
		previous = backendID
	}
	return nil
}

func runtimeBackendSupportsProfile(descriptor runtimeBackendDescriptor, profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) bool {
	declared := false
	for _, backendID := range profile.Model.CompatibleBackendIDs {
		if backendID == descriptor.ID {
			declared = true
			break
		}
	}
	resources := descriptor.Launch.Resources
	required := profile.Runtime.RequiredCapabilities
	if !declared || profile.Model.EstimatedVRAMBytes > profile.Accelerator.MemoryBytes || profile.Model.DownloadBytes > resources.MaximumModelBytes ||
		profile.Model.EstimatedVRAMBytes > resources.MaximumMemoryBytes || profile.Model.RequiredContext > resources.MaximumContextTokens ||
		(required.Execute && !descriptor.Capabilities.Execute) || (required.Stream && !descriptor.Capabilities.Stream) ||
		(required.Cancel && !descriptor.Capabilities.Cancel) || (required.Cleanup && !descriptor.Capabilities.Cleanup) ||
		(overrides.MaximumConcurrency != 0 && overrides.MaximumConcurrency > resources.MaximumConcurrency) ||
		(overrides.MaximumContext != 0 && (overrides.MaximumContext > resources.MaximumContextTokens || profile.Model.RequiredContext > overrides.MaximumContext)) {
		return false
	}
	provenanceMatches := false
	for _, pin := range profile.Runtime.Provenance {
		if pin.BackendID != descriptor.ID {
			continue
		}
		provenanceMatches = runtimeBackendProvenanceMatches(descriptor.Launch, pin)
		break
	}
	if !provenanceMatches {
		return false
	}
	for _, accelerator := range descriptor.Accelerators {
		if accelerator.Profile == profile.Accelerator.Profile && accelerator.OS == profile.Accelerator.OS &&
			accelerator.Architecture == profile.Accelerator.Architecture && accelerator.Kind == profile.Accelerator.Kind {
			return true
		}
	}
	return false
}

func runtimeBackendProvenanceMatches(launch runtimeBackendLaunchAllowlist, pin runtimeProvenancePin) bool {
	if launch.Provenance.SourceURL != pin.SourceURL || launch.Provenance.Version != pin.Version ||
		len(launch.Provenance.ArtifactSHA256) != len(pin.ArtifactSHA256) || len(launch.ContainerImages) != len(pin.ContainerImages) {
		return false
	}
	for platform, digest := range launch.Provenance.ArtifactSHA256 {
		if pin.ArtifactSHA256[platform] != digest {
			return false
		}
	}
	for index, image := range launch.ContainerImages {
		if pin.ContainerImages[index] != image {
			return false
		}
	}
	return true
}

// Select returns a deterministic primary and only explicitly requested
// fallbacks. PreferredBackendIDs is the complete ordered chain when non-empty;
// without it, exactly one primary is chosen by priority then ID.
func (registry *runtimeBackendRegistry) Select(profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) ([]runtimeBackend, error) {
	if registry == nil || validateRuntimeWorkloadProfile(profile) != nil {
		return nil, errRuntimeBackendInvalid
	}
	available := make(map[string]struct{}, len(registry.byID))
	for backendID := range registry.byID {
		available[backendID] = struct{}{}
	}
	if err := validateRuntimeBackendOverrides(overrides, available); err != nil {
		return nil, err
	}
	declared := make(map[string]struct{}, len(profile.Model.CompatibleBackendIDs))
	for _, backendID := range profile.Model.CompatibleBackendIDs {
		declared[backendID] = struct{}{}
	}
	for _, backendID := range append(append([]string{}, overrides.PreferredBackendIDs...), overrides.DisabledBackendIDs...) {
		if _, allowed := declared[backendID]; !allowed {
			return nil, errRuntimeBackendInvalid
		}
	}
	disabled := make(map[string]struct{}, len(overrides.DisabledBackendIDs))
	for _, backendID := range overrides.DisabledBackendIDs {
		disabled[backendID] = struct{}{}
	}
	eligible := make([]registeredRuntimeBackend, 0, len(registry.byID))
	for backendID, entry := range registry.byID {
		if _, excluded := disabled[backendID]; excluded || !runtimeBackendSupportsProfile(entry.descriptor, profile, overrides) ||
			!entry.backend.Compatible(profile, overrides) {
			continue
		}
		eligible = append(eligible, entry)
	}
	if len(eligible) == 0 {
		return nil, errRuntimeBackendIncompatible
	}
	sort.Slice(eligible, func(left, right int) bool {
		if eligible[left].descriptor.Priority != eligible[right].descriptor.Priority {
			return eligible[left].descriptor.Priority < eligible[right].descriptor.Priority
		}
		return eligible[left].descriptor.ID < eligible[right].descriptor.ID
	})
	if len(overrides.PreferredBackendIDs) == 0 {
		return []runtimeBackend{eligible[0].backend}, nil
	}
	byID := make(map[string]runtimeBackend, len(eligible))
	for _, entry := range eligible {
		byID[entry.descriptor.ID] = entry.backend
	}
	selected := make([]runtimeBackend, 0, len(overrides.PreferredBackendIDs))
	for _, backendID := range overrides.PreferredBackendIDs {
		if backend, compatible := byID[backendID]; compatible {
			selected = append(selected, backend)
		}
	}
	if len(selected) == 0 {
		return nil, errRuntimeBackendIncompatible
	}
	return selected, nil
}

func (registry *runtimeBackendRegistry) SelectExplained(profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) ([]runtimeBackend, runtimeBackendSelectionExplanation, error) {
	selected, err := registry.Select(profile, overrides)
	if err != nil {
		return nil, runtimeBackendSelectionExplanation{}, err
	}
	explanation := runtimeBackendSelectionExplanation{
		PrimaryBackendID:   selected[0].Descriptor().ID,
		FallbackBackendIDs: []string{},
		Forced:             len(overrides.PreferredBackendIDs) > 0,
		Basis:              "compiled-priority-then-id",
	}
	if explanation.Forced {
		explanation.Basis = "explicit-backend-order"
	}
	for _, backend := range selected[1:] {
		explanation.FallbackBackendIDs = append(explanation.FallbackBackendIDs, backend.Descriptor().ID)
	}
	return selected, explanation, nil
}

// selectRuntimeBackends is the small construction-and-selection convenience
// used by callers that already hold an explicit list of compiled instances.
func selectRuntimeBackends(backends []runtimeBackend, profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) ([]runtimeBackend, error) {
	registry, err := newRuntimeBackendRegistry(backends...)
	if err != nil {
		return nil, err
	}
	return registry.Select(profile, overrides)
}

type ollamaRuntimeBackend struct {
	runtime                managedControllerRuntime
	catalogPath            string
	dependencyManifestPath string
	descriptor             runtimeBackendDescriptor
}

func newOllamaRuntimeBackend(runtime managedControllerRuntime, catalogPath, dependencyManifestPath string) (*ollamaRuntimeBackend, error) {
	if runtime == nil || !filepath.IsAbs(catalogPath) || filepath.Clean(catalogPath) != catalogPath ||
		!filepath.IsAbs(dependencyManifestPath) || filepath.Clean(dependencyManifestPath) != dependencyManifestPath {
		return nil, errRuntimeBackendInvalid
	}
	if _, err := openProviderModelCatalog(catalogPath); err != nil {
		return nil, err
	}
	manifest, err := openManagedOllamaDependencyManifest(dependencyManifestPath)
	if err != nil {
		return nil, err
	}
	artifacts := make(map[string]string, len(manifest.Ollama.Artifacts))
	for platform, artifact := range manifest.Ollama.Artifacts {
		artifacts[platform] = artifact.SHA256
	}
	descriptor := runtimeBackendDescriptor{
		ContractVersion: runtimeBackendContractVersion,
		ID:              runtimeBackendOllamaID,
		Priority:        100,
		Capabilities: runtimeBackendCapabilities{
			Prepare: true, Load: true, Execute: false, Stream: false, Cancel: false,
			Health: true, Readiness: true, Metrics: true, Cleanup: true, Stop: true,
			ShadowOnly: true, CustomerTraffic: false,
		},
		Accelerators: []runtimeBackendAcceleratorConstraint{
			{Profile: "apple-silicon", OS: "darwin", Architecture: "arm64", Kind: "metal"},
			{Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda"},
		},
		Launch: runtimeBackendLaunchAllowlist{
			ExecutableRelativePaths: map[string]string{"darwin-arm64": "ollama", "linux-amd64": filepath.Join("bin", "ollama")},
			ContainerImages:         []string{},
			ArgumentTemplates:       [][]string{{"serve"}, {"pull", "{catalog_model}"}, {"stop", "{catalog_model}"}},
			Resources: runtimeBackendResourceBounds{
				MaximumModels: managedOllamaMaximumModels, MaximumConcurrency: 1, MaximumModelBytes: maximumProviderArtifactBytes,
				MaximumMemoryBytes:   maximumProviderVRAMBytes,
				MaximumContextTokens: 131072, MaximumCommandOutput: uint64(managedOllamaCommandOutputMaxBytes),
				MaximumInstallSeconds: uint64(managedOllamaDefaultInstallTimeout.Seconds()), MaximumPrepareSeconds: uint64(managedOllamaDefaultPullTimeout.Seconds()),
			},
			Provenance: runtimeBackendProvenance{
				SourceURL: "https://github.com/ollama/ollama", Version: managedOllamaVersion, ArtifactSHA256: artifacts,
			},
		},
	}
	if err := validateRuntimeBackendDescriptor(descriptor); err != nil {
		return nil, err
	}
	return &ollamaRuntimeBackend{runtime: runtime, catalogPath: catalogPath, dependencyManifestPath: dependencyManifestPath, descriptor: descriptor}, nil
}

func (backend *ollamaRuntimeBackend) ContractVersion() string { return runtimeBackendContractVersion }

func (backend *ollamaRuntimeBackend) Descriptor() runtimeBackendDescriptor {
	return cloneRuntimeBackendDescriptor(backend.descriptor)
}

func (backend *ollamaRuntimeBackend) Capabilities(context.Context) (runtimeBackendCapabilities, error) {
	return backend.descriptor.Capabilities, nil
}

func (backend *ollamaRuntimeBackend) Compatible(profile runtimeWorkloadProfile, overrides runtimeBackendOverrides) bool {
	if validateRuntimeWorkloadProfile(profile) != nil || overrides.SchemaVersion != runtimeBackendOverridesVersion ||
		!runtimeBackendSupportsProfile(backend.descriptor, profile, overrides) {
		return false
	}
	return true
}

func (backend *ollamaRuntimeBackend) Prepare(ctx context.Context, request runtimePrepareRequest) (runtimeBackendHealth, error) {
	status, err := backend.runtime.ensureRuntime(ctx, request.Policy, backend.dependencyManifestPath)
	return runtimeBackendHealth{State: status.State, Installed: status.RuntimeInstalled, Running: status.Running}, err
}

func (backend *ollamaRuntimeBackend) Load(ctx context.Context, request runtimeLoadRequest) (runtimeLoadedModel, error) {
	if !backend.Compatible(request.Profile, runtimeBackendOverrides{SchemaVersion: runtimeBackendOverridesVersion}) {
		return runtimeLoadedModel{}, errRuntimeBackendIncompatible
	}
	if _, err := backend.runtime.start(ctx, request.Policy); err != nil {
		return runtimeLoadedModel{}, err
	}
	if request.Download != nil {
		if request.Download.ModelID != request.Profile.Model.ModelID || request.Download.Bytes != request.Profile.Model.DownloadBytes {
			return runtimeLoadedModel{}, errRuntimeBackendInvalid
		}
		if _, _, err := backend.runtime.pullModelResult(ctx, request.Policy, backend.catalogPath, *request.Download); err != nil {
			return runtimeLoadedModel{}, err
		}
	}
	record, err := backend.runtime.authorizeModelActivation(request.Policy, backend.catalogPath, request.Profile.Model.ModelID)
	if err != nil {
		return runtimeLoadedModel{}, err
	}
	return runtimeLoadedModel{BackendID: backend.descriptor.ID, ModelID: record.CanonicalModelID, ContentDigest: request.Profile.Model.ContentDigest}, nil
}

func (backend *ollamaRuntimeBackend) Execute(context.Context, runtimeExecuteRequest) (runtimeExecuteResult, error) {
	return runtimeExecuteResult{}, errRuntimeBackendExecutionDisabled
}

func (backend *ollamaRuntimeBackend) ExecuteStream(context.Context, runtimeExecuteRequest, func(runtimeExecuteChunk) error) (runtimeExecutionSummary, error) {
	return runtimeExecutionSummary{}, errRuntimeBackendExecutionDisabled
}

func (backend *ollamaRuntimeBackend) Cancel(_ context.Context, executionID string) error {
	if !runtimeExecutionIDPattern.MatchString(executionID) {
		return errRuntimeBackendInvalid
	}
	return errRuntimeBackendCapabilityMissing
}

func (backend *ollamaRuntimeBackend) Health(_ context.Context, policy *capacityPolicyStateDocument) (runtimeBackendHealth, error) {
	status := backend.runtime.status(policy)
	return runtimeBackendHealth{State: status.State, Installed: status.RuntimeInstalled, Running: status.Running}, nil
}

func (backend *ollamaRuntimeBackend) Ready(ctx context.Context, policy *capacityPolicyStateDocument) (bool, error) {
	health, err := backend.Health(ctx, policy)
	return err == nil && health.Installed && health.Running && health.State == "running", err
}

func (backend *ollamaRuntimeBackend) Metrics(_ context.Context, policy *capacityPolicyStateDocument) (runtimeBackendMetrics, error) {
	inventory, err := backend.runtime.managedInventory(policy)
	if err != nil {
		return runtimeBackendMetrics{}, err
	}
	status := backend.runtime.status(policy)
	metrics := runtimeBackendMetrics{
		SchemaVersion: runtimeBackendMetricsVersion, Running: status.Running, InstalledModels: uint32(len(inventory)), InFlight: 0,
	}
	if err := validateRuntimeBackendMetrics(backend.descriptor, metrics); err != nil {
		return runtimeBackendMetrics{}, err
	}
	return metrics, nil
}

func (backend *ollamaRuntimeBackend) Cleanup(ctx context.Context, request runtimeCleanupRequest) error {
	if len(request.ModelIDs) > managedOllamaMaximumModels {
		return errRuntimeBackendInvalid
	}
	previous := ""
	for _, modelID := range request.ModelIDs {
		if !validSelectedModelID(modelID) || modelID <= previous {
			return errRuntimeBackendInvalid
		}
		if err := backend.runtime.deactivateModel(ctx, request.Policy, backend.catalogPath, modelID); err != nil {
			return err
		}
		previous = modelID
	}
	if request.StopRuntime {
		return backend.Stop(ctx)
	}
	return nil
}

func (backend *ollamaRuntimeBackend) Stop(ctx context.Context) error {
	return backend.runtime.stop(ctx)
}

// The legacy controller surface remains as a migration shim. Every path is
// pinned to the adapter's configured catalog and dependency manifests.
func (backend *ollamaRuntimeBackend) ensureRuntime(ctx context.Context, policy *capacityPolicyStateDocument, dependencyManifestPath string) (managedOllamaStatus, error) {
	if dependencyManifestPath != backend.dependencyManifestPath {
		return managedOllamaStatus{}, errRuntimeBackendInvalid
	}
	return backend.runtime.ensureRuntime(ctx, policy, dependencyManifestPath)
}

func (backend *ollamaRuntimeBackend) start(ctx context.Context, policy *capacityPolicyStateDocument) (managedOllamaStatus, error) {
	return backend.runtime.start(ctx, policy)
}

func (backend *ollamaRuntimeBackend) stop(ctx context.Context) error { return backend.Stop(ctx) }

func (backend *ollamaRuntimeBackend) enforcePolicy(ctx context.Context, policy *capacityPolicyStateDocument) error {
	return backend.runtime.enforcePolicy(ctx, policy)
}

func (backend *ollamaRuntimeBackend) status(policy *capacityPolicyStateDocument) managedOllamaStatus {
	return backend.runtime.status(policy)
}

func (backend *ollamaRuntimeBackend) pullModelResult(ctx context.Context, policy *capacityPolicyStateDocument, catalogPath string, download plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	if catalogPath != backend.catalogPath {
		return managedOllamaModelRecord{}, false, errRuntimeBackendInvalid
	}
	return backend.runtime.pullModelResult(ctx, policy, catalogPath, download)
}

func (backend *ollamaRuntimeBackend) authorizeModelActivation(policy *capacityPolicyStateDocument, catalogPath, modelID string) (managedOllamaModelRecord, error) {
	if catalogPath != backend.catalogPath {
		return managedOllamaModelRecord{}, errRuntimeBackendInvalid
	}
	return backend.runtime.authorizeModelActivation(policy, catalogPath, modelID)
}

func (backend *ollamaRuntimeBackend) deactivateModel(ctx context.Context, policy *capacityPolicyStateDocument, catalogPath, modelID string) error {
	if catalogPath != backend.catalogPath {
		return errRuntimeBackendInvalid
	}
	return backend.runtime.deactivateModel(ctx, policy, catalogPath, modelID)
}

func (backend *ollamaRuntimeBackend) managedInventory(policy *capacityPolicyStateDocument) ([]string, error) {
	return backend.runtime.managedInventory(policy)
}
