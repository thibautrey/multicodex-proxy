package main

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	runtimebackendapi "github.com/thibautrey/multivibe/provider-agent/runtimebackend"
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

func cloneRuntimeBackendCatalog(source providerModelCatalog) providerModelCatalog {
	catalog := source
	catalog.Models = append([]providerModelCatalogEntry{}, source.Models...)
	for index := range catalog.Models {
		catalog.Models[index].VRAMEstimates = append([]providerModelCatalogVRAM{}, source.Models[index].VRAMEstimates...)
	}
	return catalog
}

func cloneRuntimeBackendDependencyManifest(source managedOllamaDependencyManifest) managedOllamaDependencyManifest {
	manifest := source
	manifest.Node = append([]byte{}, source.Node...)
	manifest.Ollama.Artifacts = make(map[string]managedOllamaDependencyArtifact, len(source.Ollama.Artifacts))
	for platform, artifact := range source.Ollama.Artifacts {
		manifest.Ollama.Artifacts[platform] = artifact
	}
	return manifest
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
	pinnedRuntime          pinnedManagedControllerRuntime
	catalogPath            string
	dependencyManifestPath string
	catalog                providerModelCatalog
	dependencyManifest     managedOllamaDependencyManifest
	descriptor             runtimeBackendDescriptor
}

// pinnedManagedControllerRuntime consumes immutable values captured by the
// adapter constructor. Paths remain only on the legacy compatibility surface;
// no lifecycle operation reopens a replaceable catalog or dependency file.
type pinnedManagedControllerRuntime interface {
	ensureRuntimePinned(context.Context, *capacityPolicyStateDocument, managedOllamaDependencyManifest) (managedOllamaStatus, error)
	pullModelResultPinned(context.Context, *capacityPolicyStateDocument, providerModelCatalog, plannedModelDownload) (managedOllamaModelRecord, bool, error)
	authorizeModelActivationPinned(*capacityPolicyStateDocument, providerModelCatalog, string) (managedOllamaModelRecord, error)
	deactivateModelPinned(context.Context, *capacityPolicyStateDocument, providerModelCatalog, string) error
}

func newOllamaRuntimeBackend(runtime managedControllerRuntime, catalogPath, dependencyManifestPath string) (*ollamaRuntimeBackend, error) {
	if runtime == nil || !filepath.IsAbs(catalogPath) || filepath.Clean(catalogPath) != catalogPath ||
		!filepath.IsAbs(dependencyManifestPath) || filepath.Clean(dependencyManifestPath) != dependencyManifestPath {
		return nil, errRuntimeBackendInvalid
	}
	catalog, err := openProviderModelCatalog(catalogPath)
	if err != nil {
		return nil, err
	}
	manifest, err := openManagedOllamaDependencyManifest(dependencyManifestPath)
	if err != nil {
		return nil, err
	}
	pinnedRuntime, ok := runtime.(pinnedManagedControllerRuntime)
	if !ok {
		return nil, errRuntimeBackendInvalid
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
	return &ollamaRuntimeBackend{
		runtime: runtime, pinnedRuntime: pinnedRuntime, catalogPath: catalogPath, dependencyManifestPath: dependencyManifestPath,
		catalog: cloneRuntimeBackendCatalog(catalog), dependencyManifest: cloneRuntimeBackendDependencyManifest(manifest), descriptor: descriptor,
	}, nil
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
	status, err := backend.pinnedRuntime.ensureRuntimePinned(ctx, request.Policy, cloneRuntimeBackendDependencyManifest(backend.dependencyManifest))
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
		if _, _, err := backend.pinnedRuntime.pullModelResultPinned(ctx, request.Policy, cloneRuntimeBackendCatalog(backend.catalog), *request.Download); err != nil {
			return runtimeLoadedModel{}, err
		}
	}
	record, err := backend.pinnedRuntime.authorizeModelActivationPinned(request.Policy, cloneRuntimeBackendCatalog(backend.catalog), request.Profile.Model.ModelID)
	if err != nil {
		return runtimeLoadedModel{}, err
	}
	if record.CanonicalModelID != request.Profile.Model.ModelID || record.ManifestSHA256 != request.Profile.Model.ContentDigest {
		return runtimeLoadedModel{}, errRuntimeBackendIncompatible
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
		if err := backend.pinnedRuntime.deactivateModelPinned(ctx, request.Policy, cloneRuntimeBackendCatalog(backend.catalog), modelID); err != nil {
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
	return backend.pinnedRuntime.ensureRuntimePinned(ctx, policy, cloneRuntimeBackendDependencyManifest(backend.dependencyManifest))
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
	return backend.pinnedRuntime.pullModelResultPinned(ctx, policy, cloneRuntimeBackendCatalog(backend.catalog), download)
}

func (backend *ollamaRuntimeBackend) authorizeModelActivation(policy *capacityPolicyStateDocument, catalogPath, modelID string) (managedOllamaModelRecord, error) {
	if catalogPath != backend.catalogPath {
		return managedOllamaModelRecord{}, errRuntimeBackendInvalid
	}
	return backend.pinnedRuntime.authorizeModelActivationPinned(policy, cloneRuntimeBackendCatalog(backend.catalog), modelID)
}

func (backend *ollamaRuntimeBackend) deactivateModel(ctx context.Context, policy *capacityPolicyStateDocument, catalogPath, modelID string) error {
	if catalogPath != backend.catalogPath {
		return errRuntimeBackendInvalid
	}
	return backend.pinnedRuntime.deactivateModelPinned(ctx, policy, cloneRuntimeBackendCatalog(backend.catalog), modelID)
}

func (backend *ollamaRuntimeBackend) managedInventory(policy *capacityPolicyStateDocument) ([]string, error) {
	return backend.runtime.managedInventory(policy)
}

// ollamaRuntimeBackendSDKBridge keeps the public runtime-neutral contract at
// the Ollama adapter boundary. The controller continues to use the legacy
// shim while it migrates; no Ollama launch, catalog or policy detail moves into
// the orchestrator or the public descriptor.
type ollamaRuntimeBackendSDKBridge struct {
	backend    *ollamaRuntimeBackend
	policies   *capacityPolicyStore
	capability hostCapability
	now        func() time.Time
	lifecycle  chan struct{}
	// lifecycleAttempt is nil in production and provides a deterministic test
	// boundary immediately before lifecycle acquisition.
	lifecycleAttempt func(string)

	mu            sync.Mutex
	runtimeOwners map[runtimeBackendSDKOwner]struct{}
	downloads     map[runtimeBackendSDKDownloadIdentity]runtimebackendapi.DownloadedModel
}

type runtimeBackendSDKOwner struct {
	grantID        string
	policyRevision uint64
	trafficClass   runtimebackendapi.TrafficClass
}

type runtimeBackendSDKDownloadIdentity struct {
	grantID        string
	policyRevision uint64
	trafficClass   runtimebackendapi.TrafficClass
	modelID        string
	contentDigest  string
}

func newRuntimeBackendSDKRegistry(backend *ollamaRuntimeBackend, policies *capacityPolicyStore, capability hostCapability) (*runtimebackendapi.Registry, error) {
	bridge, err := newOllamaRuntimeBackendSDKBridge(backend, policies, capability, time.Now)
	if err != nil {
		return nil, err
	}
	return runtimebackendapi.NewRegistry(bridge)
}

func newOllamaRuntimeBackendSDKBridge(
	backend *ollamaRuntimeBackend,
	policies *capacityPolicyStore,
	capability hostCapability,
	now func() time.Time,
) (*ollamaRuntimeBackendSDKBridge, error) {
	if backend == nil || policies == nil || !capability.Supported || capability.Profile == "" || capability.OS == "" ||
		capability.Architecture == "" || capability.Accelerator == "" || capability.AcceleratorMemoryBytes == 0 || now == nil {
		return nil, runtimebackendapi.ErrInvalid
	}
	bridge := &ollamaRuntimeBackendSDKBridge{
		backend: backend, policies: policies, capability: capability, now: now,
		lifecycle: make(chan struct{}, 1), runtimeOwners: make(map[runtimeBackendSDKOwner]struct{}),
		downloads: make(map[runtimeBackendSDKDownloadIdentity]runtimebackendapi.DownloadedModel),
	}
	bridge.lifecycle <- struct{}{}
	descriptor := bridge.Descriptor()
	if runtimebackendapi.ValidateDescriptor(descriptor) != nil || !sdkDescriptorSupportsHost(descriptor, capability) {
		return nil, runtimebackendapi.ErrInvalid
	}
	return bridge, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Descriptor() runtimebackendapi.Descriptor {
	legacy := bridge.backend.Descriptor()
	accelerators := make([]runtimebackendapi.AcceleratorConstraint, 0, len(legacy.Accelerators))
	for _, accelerator := range legacy.Accelerators {
		accelerators = append(accelerators, runtimebackendapi.AcceleratorConstraint{
			Profile: accelerator.Profile, OS: accelerator.OS, Architecture: accelerator.Architecture, Kind: accelerator.Kind,
		})
	}
	artifactSHA256 := make(map[string]string, len(legacy.Launch.Provenance.ArtifactSHA256))
	for platform, digest := range legacy.Launch.Provenance.ArtifactSHA256 {
		artifactSHA256[platform] = digest
	}
	return runtimebackendapi.Descriptor{
		ContractVersion: runtimebackendapi.ContractVersion,
		ID:              legacy.ID,
		Priority:        legacy.Priority,
		Capabilities: runtimebackendapi.Capabilities{
			Execute: legacy.Capabilities.Execute, Stream: legacy.Capabilities.Stream, Cancel: legacy.Capabilities.Cancel,
			ShadowOnly: legacy.Capabilities.ShadowOnly, CustomerTraffic: legacy.Capabilities.CustomerTraffic,
		},
		Accelerators: accelerators,
		Limits: runtimebackendapi.Limits{
			MaximumModels: legacy.Launch.Resources.MaximumModels, MaximumConcurrency: legacy.Launch.Resources.MaximumConcurrency,
			MaximumModelBytes: legacy.Launch.Resources.MaximumModelBytes, MaximumMemoryBytes: legacy.Launch.Resources.MaximumMemoryBytes,
			MaximumContextTokens: legacy.Launch.Resources.MaximumContextTokens,
			MaximumInputBytes:    legacy.Launch.Resources.MaximumCommandOutput,
			MaximumOutputBytes:   legacy.Launch.Resources.MaximumCommandOutput,
		},
		Provenance: runtimebackendapi.Provenance{
			SourceURL: legacy.Launch.Provenance.SourceURL, Version: legacy.Launch.Provenance.Version,
			ArtifactSHA256: artifactSHA256, ContainerImages: append([]string{}, legacy.Launch.ContainerImages...),
		},
	}
}

func (bridge *ollamaRuntimeBackendSDKBridge) Discover(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Discovery, error) {
	if err := runtimeBackendSDKContextError(ctx); err != nil {
		return runtimebackendapi.Discovery{}, err
	}
	if _, err := bridge.authorizedPolicy(grant); err != nil {
		return runtimebackendapi.Discovery{}, err
	}
	discovery := runtimebackendapi.Discovery{Accelerators: []runtimebackendapi.Accelerator{{
		Profile: bridge.capability.Profile, OS: bridge.capability.OS, Architecture: bridge.capability.Architecture,
		Kind: bridge.capability.Accelerator, MemoryBytes: bridge.capability.AcceleratorMemoryBytes,
	}}}
	if runtimebackendapi.ValidateDiscovery(bridge.Descriptor(), discovery) != nil {
		return runtimebackendapi.Discovery{}, runtimebackendapi.ErrInvalid
	}
	return discovery, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Compatible(ctx context.Context, request runtimebackendapi.CompatibilityRequest) (runtimebackendapi.Compatibility, error) {
	if err := runtimeBackendSDKContextError(ctx); err != nil {
		return runtimebackendapi.Compatibility{}, err
	}
	if _, err := bridge.authorizedPolicy(request.Grant); err != nil {
		return runtimebackendapi.Compatibility{}, err
	}
	compatibility, err := runtimebackendapi.EvaluateCompatibility(bridge.Descriptor(), request)
	if err != nil || !compatibility.Compatible {
		return compatibility, err
	}
	profile, err := bridge.legacyProfile(request.Model, request.Accelerator, request.RequiredCapabilities)
	if err != nil || !bridge.backend.Compatible(profile, runtimeBackendOverrides{SchemaVersion: runtimeBackendOverridesVersion}) {
		return runtimebackendapi.Compatibility{Compatible: false, Reasons: []runtimebackendapi.ReasonCode{runtimebackendapi.ReasonBackendRejected}}, nil
	}
	return compatibility, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Prepare(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Health, error) {
	release, err := bridge.acquireLifecycle(ctx, "prepare")
	if err != nil {
		return runtimebackendapi.Health{}, err
	}
	defer release()
	policy, err := bridge.authorizedPolicy(grant)
	if err != nil {
		return runtimebackendapi.Health{}, err
	}
	health, err := bridge.backend.Prepare(ctx, runtimePrepareRequest{Policy: policy})
	return runtimeBackendSDKHealth(health), runtimeBackendSDKError(err)
}

func (bridge *ollamaRuntimeBackendSDKBridge) Download(ctx context.Context, request runtimebackendapi.DownloadRequest) (receipt runtimebackendapi.DownloadedModel, resultErr error) {
	release, err := bridge.acquireLifecycle(ctx, "download")
	if err != nil {
		return runtimebackendapi.DownloadedModel{}, err
	}
	defer release()
	if err := runtimebackendapi.ValidateDownloadRequest(request, bridge.now()); err != nil {
		return runtimebackendapi.DownloadedModel{}, err
	}
	policy, err := bridge.authorizedPolicy(request.Grant)
	if err != nil {
		return runtimebackendapi.DownloadedModel{}, err
	}
	compatibility, err := bridge.Compatible(ctx, runtimebackendapi.CompatibilityRequest{
		Grant: request.Grant, EvaluationTime: bridge.now(), Model: request.Model,
		Accelerator: runtimebackendapi.Accelerator{
			Profile: bridge.capability.Profile, OS: bridge.capability.OS, Architecture: bridge.capability.Architecture,
			Kind: bridge.capability.Accelerator, MemoryBytes: bridge.capability.AcceleratorMemoryBytes,
		},
	})
	if err != nil || !compatibility.Compatible {
		if err != nil {
			return runtimebackendapi.DownloadedModel{}, err
		}
		return runtimebackendapi.DownloadedModel{}, runtimebackendapi.ErrIncompatible
	}
	wasRunning := bridge.backend.status(policy).Running
	if _, err := bridge.backend.start(ctx, policy); err != nil {
		return runtimebackendapi.DownloadedModel{}, runtimeBackendSDKError(err)
	}
	downloadKey := runtimeBackendSDKDownloadKey(request.Grant, request.Model)
	if !wasRunning {
		defer func() {
			cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), managedOllamaDefaultShutdownTimeout+managedOllamaDefaultKillTimeout+time.Second)
			defer cancel()
			if stopErr := bridge.backend.stop(cleanupContext); stopErr != nil && resultErr == nil {
				bridge.mu.Lock()
				delete(bridge.downloads, downloadKey)
				bridge.mu.Unlock()
				receipt = runtimebackendapi.DownloadedModel{}
				resultErr = runtimeBackendSDKError(stopErr)
			}
		}()
	}
	record, _, err := bridge.backend.pullModelResult(ctx, policy, bridge.backend.catalogPath, plannedModelDownload{
		ModelID: request.Model.ID, Bytes: request.Model.ArtifactBytes,
	})
	if err != nil {
		return runtimebackendapi.DownloadedModel{}, runtimeBackendSDKError(err)
	}
	if record.CanonicalModelID != request.Model.ID || record.ManifestSHA256 != request.Model.ContentDigest {
		return runtimebackendapi.DownloadedModel{}, runtimebackendapi.ErrBackendFailure
	}
	receipt = runtimebackendapi.DownloadedModel{
		BackendID: bridge.Descriptor().ID, ModelID: request.Model.ID, ContentDigest: request.Model.ContentDigest, Bytes: request.Model.ArtifactBytes,
	}
	bridge.mu.Lock()
	bridge.downloads[downloadKey] = receipt
	bridge.mu.Unlock()
	return receipt, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Start(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Health, error) {
	release, err := bridge.acquireLifecycle(ctx, "start")
	if err != nil {
		return runtimebackendapi.Health{}, err
	}
	defer release()
	policy, err := bridge.authorizedPolicy(grant)
	if err != nil {
		return runtimebackendapi.Health{}, err
	}
	status, err := bridge.backend.start(ctx, policy)
	if err == nil && status.Running {
		bridge.mu.Lock()
		bridge.runtimeOwners[runtimeBackendSDKOwnerKey(grant)] = struct{}{}
		bridge.mu.Unlock()
	}
	return runtimebackendapi.Health{State: status.State, Installed: status.RuntimeInstalled, Running: status.Running}, runtimeBackendSDKError(err)
}

func (bridge *ollamaRuntimeBackendSDKBridge) Load(ctx context.Context, request runtimebackendapi.LoadRequest) (runtimebackendapi.LoadedModel, error) {
	release, err := bridge.acquireLifecycle(ctx, "load")
	if err != nil {
		return runtimebackendapi.LoadedModel{}, err
	}
	defer release()
	if err := runtimebackendapi.ValidateLoadRequest(request, bridge.now()); err != nil || request.Download.BackendID != bridge.Descriptor().ID {
		return runtimebackendapi.LoadedModel{}, runtimebackendapi.ErrInvalid
	}
	policy, err := bridge.authorizedPolicy(request.Grant)
	if err != nil {
		return runtimebackendapi.LoadedModel{}, err
	}
	bridge.mu.Lock()
	receipt, found := bridge.downloads[runtimeBackendSDKDownloadKey(request.Grant, request.Model)]
	bridge.mu.Unlock()
	if !found || receipt != request.Download {
		return runtimebackendapi.LoadedModel{}, runtimebackendapi.ErrInvalid
	}
	profile, err := bridge.legacyProfile(request.Model, runtimebackendapi.Accelerator{
		Profile: bridge.capability.Profile, OS: bridge.capability.OS, Architecture: bridge.capability.Architecture,
		Kind: bridge.capability.Accelerator, MemoryBytes: bridge.capability.AcceleratorMemoryBytes,
	}, runtimebackendapi.CapabilityRequirements{})
	if err != nil {
		return runtimebackendapi.LoadedModel{}, runtimebackendapi.ErrIncompatible
	}
	loaded, err := bridge.backend.Load(ctx, runtimeLoadRequest{Policy: policy, Profile: profile})
	if err != nil {
		return runtimebackendapi.LoadedModel{}, runtimeBackendSDKError(err)
	}
	bridge.mu.Lock()
	bridge.runtimeOwners[runtimeBackendSDKOwnerKey(request.Grant)] = struct{}{}
	bridge.mu.Unlock()
	return runtimebackendapi.LoadedModel{BackendID: loaded.BackendID, ModelID: loaded.ModelID, ContentDigest: loaded.ContentDigest}, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Health(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Health, error) {
	if err := runtimeBackendSDKContextError(ctx); err != nil {
		return runtimebackendapi.Health{}, err
	}
	policy, err := bridge.authorizedPolicy(grant)
	if err != nil {
		return runtimebackendapi.Health{}, err
	}
	health, err := bridge.backend.Health(ctx, policy)
	return runtimeBackendSDKHealth(health), runtimeBackendSDKError(err)
}

func (bridge *ollamaRuntimeBackendSDKBridge) Ready(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Readiness, error) {
	health, err := bridge.Health(ctx, grant)
	if err != nil {
		return runtimebackendapi.Readiness{}, err
	}
	if health.Installed && health.Running && health.State == "running" {
		return runtimebackendapi.Readiness{Ready: true, Reason: runtimebackendapi.ReasonEligible}, nil
	}
	return runtimebackendapi.Readiness{Ready: false, Reason: runtimebackendapi.ReasonBackendRejected}, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Metrics(ctx context.Context, grant runtimebackendapi.OperationGrant) (runtimebackendapi.Metrics, error) {
	if err := runtimeBackendSDKContextError(ctx); err != nil {
		return runtimebackendapi.Metrics{}, err
	}
	policy, err := bridge.authorizedPolicy(grant)
	if err != nil {
		return runtimebackendapi.Metrics{}, err
	}
	legacy, err := bridge.backend.Metrics(ctx, policy)
	if err != nil {
		return runtimebackendapi.Metrics{}, runtimeBackendSDKError(err)
	}
	metrics := runtimebackendapi.Metrics{
		SchemaVersion: legacy.SchemaVersion, Running: legacy.Running, InstalledModels: legacy.InstalledModels, InFlight: legacy.InFlight,
		ExecutionSamples: legacy.ExecutionSamples, PrefillMillisecondsP50: legacy.PrefillMillisecondsP50,
		TimeToFirstTokenMillisecondsP50: legacy.TimeToFirstTokenMillisecondsP50, TokensPerSecondMilliP50: legacy.TokensPerSecondMilliP50,
		MemoryBytes: legacy.MemoryBytes, ExecutionErrors: legacy.ExecutionErrors, OutOfMemoryErrors: legacy.OutOfMemoryErrors,
		CrashErrors: legacy.CrashErrors, TimeoutErrors: legacy.TimeoutErrors, CancelledExecutions: legacy.CancelledExecutions,
	}
	if runtimebackendapi.ValidateMetrics(bridge.Descriptor(), metrics) != nil {
		return runtimebackendapi.Metrics{}, runtimebackendapi.ErrBackendFailure
	}
	return metrics, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Cleanup(ctx context.Context, request runtimebackendapi.CleanupRequest) error {
	release, err := bridge.acquireLifecycle(ctx, "cleanup")
	if err != nil {
		return err
	}
	defer release()
	if err := runtimebackendapi.ValidateCleanupRequest(request, bridge.now()); err != nil {
		return err
	}
	policy, err := bridge.authorizedPolicy(request.Grant)
	if err != nil {
		return err
	}
	ownedModels := make(map[string]bool, len(request.ModelIDs))
	otherOwnerModels := make(map[string]bool, len(request.ModelIDs))
	otherOwnerExists := false
	bridge.mu.Lock()
	owner := runtimeBackendSDKOwnerKey(request.Grant)
	for candidate := range bridge.runtimeOwners {
		if candidate != owner {
			otherOwnerExists = true
		}
	}
	for key := range bridge.downloads {
		sameOwner := runtimeBackendSDKDownloadOwnerMatches(key, request.Grant)
		if !sameOwner {
			otherOwnerExists = true
		}
		for _, modelID := range request.ModelIDs {
			if key.modelID != modelID {
				continue
			}
			if sameOwner {
				ownedModels[modelID] = true
			} else {
				otherOwnerModels[modelID] = true
			}
		}
	}
	bridge.mu.Unlock()
	if request.StopRuntime && otherOwnerExists {
		return runtimebackendapi.ErrGrantMismatch
	}
	backendModelIDs := make([]string, 0, len(request.ModelIDs))
	for _, modelID := range request.ModelIDs {
		if !ownedModels[modelID] && otherOwnerModels[modelID] {
			return runtimebackendapi.ErrGrantMismatch
		}
		if ownedModels[modelID] && !otherOwnerModels[modelID] {
			backendModelIDs = append(backendModelIDs, modelID)
		}
	}
	if err := bridge.backend.Cleanup(ctx, runtimeCleanupRequest{Policy: policy, ModelIDs: backendModelIDs, StopRuntime: request.StopRuntime}); err != nil {
		return runtimeBackendSDKError(err)
	}
	bridge.mu.Lock()
	for key := range bridge.downloads {
		if !runtimeBackendSDKDownloadOwnerMatches(key, request.Grant) {
			continue
		}
		for _, modelID := range request.ModelIDs {
			if key.modelID == modelID {
				delete(bridge.downloads, key)
			}
		}
	}
	if request.StopRuntime {
		clear(bridge.runtimeOwners)
	} else if !bridge.hasDownloadsForOwnerLocked(request.Grant) {
		delete(bridge.runtimeOwners, owner)
	}
	bridge.mu.Unlock()
	return nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) Stop(ctx context.Context, grant runtimebackendapi.OperationGrant) error {
	release, err := bridge.acquireLifecycle(ctx, "stop")
	if err != nil {
		return err
	}
	defer release()
	if err := runtimebackendapi.ValidateOperationGrant(grant, bridge.now()); err != nil {
		return err
	}
	bridge.mu.Lock()
	otherOwnerExists := bridge.hasResourcesForAnotherOwnerLocked(grant)
	bridge.mu.Unlock()
	if otherOwnerExists {
		return runtimebackendapi.ErrGrantMismatch
	}
	if _, err := bridge.authorizedPolicy(grant); err != nil {
		return err
	}
	if err := bridge.backend.Stop(ctx); err != nil {
		return runtimeBackendSDKError(err)
	}
	bridge.mu.Lock()
	clear(bridge.runtimeOwners)
	bridge.mu.Unlock()
	return nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) acquireLifecycle(ctx context.Context, operation string) (func(), error) {
	if err := runtimeBackendSDKContextError(ctx); err != nil {
		return nil, err
	}
	if bridge.lifecycleAttempt != nil {
		bridge.lifecycleAttempt(operation)
	}
	select {
	case <-ctx.Done():
		return nil, runtimeBackendSDKContextError(ctx)
	case <-bridge.lifecycle:
		return func() { bridge.lifecycle <- struct{}{} }, nil
	}
}

func (bridge *ollamaRuntimeBackendSDKBridge) authorizedPolicy(grant runtimebackendapi.OperationGrant) (*capacityPolicyStateDocument, error) {
	if err := runtimebackendapi.ValidateOperationGrant(grant, bridge.now()); err != nil {
		return nil, err
	}
	descriptor := bridge.Descriptor()
	if grant.TrafficClass == runtimebackendapi.TrafficClassCustomer &&
		(!descriptor.Capabilities.CustomerTraffic || descriptor.Capabilities.ShadowOnly) {
		return nil, runtimebackendapi.ErrExecutionDisabled
	}
	if grant.Limits.MaximumModels > descriptor.Limits.MaximumModels || grant.Limits.MaximumConcurrency > descriptor.Limits.MaximumConcurrency ||
		grant.Limits.MaximumModelBytes > descriptor.Limits.MaximumModelBytes || grant.Limits.MaximumMemoryBytes > descriptor.Limits.MaximumMemoryBytes ||
		grant.Limits.MaximumContextTokens > descriptor.Limits.MaximumContextTokens || grant.Limits.MaximumInputBytes > descriptor.Limits.MaximumInputBytes ||
		grant.Limits.MaximumOutputBytes > descriptor.Limits.MaximumOutputBytes {
		return nil, runtimebackendapi.ErrIncompatible
	}
	policy := bridge.policies.snapshot()
	if policy == nil || validateCapacityPolicyState(*policy) != nil || policy.Revision != grant.PolicyRevision {
		return nil, runtimebackendapi.ErrIncompatible
	}
	return policy, nil
}

func (bridge *ollamaRuntimeBackendSDKBridge) legacyProfile(
	model runtimebackendapi.ModelRequirements,
	accelerator runtimebackendapi.Accelerator,
	required runtimebackendapi.CapabilityRequirements,
) (runtimeWorkloadProfile, error) {
	catalog := cloneRuntimeBackendCatalog(bridge.backend.catalog)
	var entry *providerModelCatalogEntry
	for index := range catalog.Models {
		if catalog.Models[index].CanonicalModelID == model.ID {
			entry = &catalog.Models[index]
			break
		}
	}
	if entry == nil || entry.ContentDigest != model.ContentDigest || entry.DownloadBytes != model.ArtifactBytes {
		return runtimeWorkloadProfile{}, runtimebackendapi.ErrIncompatible
	}
	profile := runtimeWorkloadProfile{
		SchemaVersion: runtimeWorkloadProfileVersion,
		Model: runtimeModelProfile{
			ModelID: model.ID, CompatibleBackendIDs: []string{bridge.backend.descriptor.ID}, ContentDigest: model.ContentDigest,
			AssessmentDigest: entry.License.AssessmentDigest, RequiredContext: model.ContextTokens,
			EstimatedVRAMBytes: model.EstimatedMemoryBytes, DownloadBytes: model.ArtifactBytes,
		},
		Accelerator: runtimeAcceleratorProfile{
			Profile: accelerator.Profile, OS: accelerator.OS, Architecture: accelerator.Architecture, Kind: accelerator.Kind,
			MemoryBytes: accelerator.MemoryBytes,
		},
		Runtime: runtimeProfile{
			ContractVersion: runtimeBackendContractVersion,
			RequiredCapabilities: runtimeCapabilityRequirements{
				Execute: required.Execute, Stream: required.Stream, Cancel: required.Cancel, Cleanup: true,
			},
			Provenance: []runtimeProvenancePin{runtimeProvenancePinFromDescriptor(bridge.backend.descriptor)},
		},
	}
	if validateRuntimeWorkloadProfile(profile) != nil {
		return runtimeWorkloadProfile{}, runtimebackendapi.ErrIncompatible
	}
	return profile, nil
}

func runtimeBackendSDKHealth(health runtimeBackendHealth) runtimebackendapi.Health {
	return runtimebackendapi.Health{State: health.State, Installed: health.Installed, Running: health.Running}
}

func runtimeBackendSDKDownloadKey(grant runtimebackendapi.OperationGrant, model runtimebackendapi.ModelRequirements) runtimeBackendSDKDownloadIdentity {
	return runtimeBackendSDKDownloadIdentity{
		grantID:        grant.ID,
		policyRevision: grant.PolicyRevision,
		trafficClass:   grant.TrafficClass,
		modelID:        model.ID,
		contentDigest:  model.ContentDigest,
	}
}

func runtimeBackendSDKOwnerKey(grant runtimebackendapi.OperationGrant) runtimeBackendSDKOwner {
	return runtimeBackendSDKOwner{
		grantID: grant.ID, policyRevision: grant.PolicyRevision, trafficClass: grant.TrafficClass,
	}
}

func runtimeBackendSDKDownloadOwnerMatches(identity runtimeBackendSDKDownloadIdentity, grant runtimebackendapi.OperationGrant) bool {
	return identity.grantID == grant.ID && identity.policyRevision == grant.PolicyRevision && identity.trafficClass == grant.TrafficClass
}

func (bridge *ollamaRuntimeBackendSDKBridge) hasResourcesForAnotherOwnerLocked(grant runtimebackendapi.OperationGrant) bool {
	owner := runtimeBackendSDKOwnerKey(grant)
	for candidate := range bridge.runtimeOwners {
		if candidate != owner {
			return true
		}
	}
	for identity := range bridge.downloads {
		if !runtimeBackendSDKDownloadOwnerMatches(identity, grant) {
			return true
		}
	}
	return false
}

func (bridge *ollamaRuntimeBackendSDKBridge) hasDownloadsForOwnerLocked(grant runtimebackendapi.OperationGrant) bool {
	for identity := range bridge.downloads {
		if runtimeBackendSDKDownloadOwnerMatches(identity, grant) {
			return true
		}
	}
	return false
}

func runtimeBackendSDKContextError(ctx context.Context) error {
	if ctx == nil {
		return runtimebackendapi.ErrInvalid
	}
	return runtimebackendapi.NormalizeExecutionError(ctx.Err())
}

func runtimeBackendSDKError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return runtimebackendapi.ErrCancelled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return runtimebackendapi.ErrTimedOut
	}
	switch {
	case errors.Is(err, errRuntimeBackendInvalid):
		return runtimebackendapi.ErrInvalid
	case errors.Is(err, errRuntimeBackendIncompatible):
		return runtimebackendapi.ErrIncompatible
	case errors.Is(err, errRuntimeBackendExecutionDisabled):
		return runtimebackendapi.ErrExecutionDisabled
	case errors.Is(err, errRuntimeBackendCapabilityMissing):
		return runtimebackendapi.ErrCapabilityUnavailable
	case errors.Is(err, errRuntimeBackendOutOfMemory):
		return runtimebackendapi.ErrOutOfMemory
	case errors.Is(err, errRuntimeBackendCrashed):
		return runtimebackendapi.ErrCrashed
	case errors.Is(err, errRuntimeBackendTimedOut):
		return runtimebackendapi.ErrTimedOut
	case errors.Is(err, errRuntimeBackendCancelled):
		return runtimebackendapi.ErrCancelled
	case errors.Is(err, errRuntimeBackendExecutionUnknown):
		return runtimebackendapi.ErrExecutionUnknown
	case errors.Is(err, errManagedControllerPlanExpired):
		return runtimebackendapi.ErrGrantExpired
	default:
		return runtimebackendapi.ErrBackendFailure
	}
}

func sdkDescriptorSupportsHost(descriptor runtimebackendapi.Descriptor, capability hostCapability) bool {
	for _, accelerator := range descriptor.Accelerators {
		if accelerator.Profile == capability.Profile && accelerator.OS == capability.OS && accelerator.Architecture == capability.Architecture &&
			accelerator.Kind == capability.Accelerator {
			return true
		}
	}
	return false
}

var _ runtimebackendapi.Backend = (*ollamaRuntimeBackendSDKBridge)(nil)
