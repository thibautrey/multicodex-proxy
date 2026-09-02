package runtimebackend

import (
	"context"
	"errors"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	maximumBackends          = 64
	maximumAccelerators      = 32
	maximumModels            = uint32(65_535)
	maximumConcurrency       = uint32(65_535)
	maximumResourceBytes     = uint64(1) << 60
	maximumContextTokens     = uint64(1) << 24
	maximumRequestBytes      = uint64(1) << 40
	maximumGrantLifetime     = 24 * time.Hour
	maximumProvenanceEntries = 32
)

var (
	backendIDPattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	publicTokenPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	executionIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	contentDigestPattern   = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	sha256Pattern          = regexp.MustCompile(`^[a-f0-9]{64}$`)
	pinnedContainerPattern = regexp.MustCompile(
		`^[a-z0-9][a-z0-9./_-]{0,255}@sha256:[a-f0-9]{64}$`,
	)
	modelURLSchemePattern = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*:/`)
	windowsPathPattern    = regexp.MustCompile(`^[A-Za-z]:[/\\]`)
)

// ValidateDescriptor validates all public metadata and rejects inconsistent
// capability declarations. Registry construction additionally verifies the
// corresponding Go optional interfaces.
func ValidateDescriptor(descriptor Descriptor) error {
	if descriptor.ContractVersion != ContractVersion || !backendIDPattern.MatchString(descriptor.ID) || descriptor.Priority == 0 {
		return ErrInvalid
	}
	capabilities := descriptor.Capabilities
	if (capabilities.Stream && !capabilities.Execute) || (capabilities.Cancel && !capabilities.Execute) ||
		(capabilities.CustomerTraffic && (!capabilities.Execute || capabilities.ShadowOnly)) {
		return ErrInvalid
	}
	if len(descriptor.Accelerators) == 0 || len(descriptor.Accelerators) > maximumAccelerators {
		return ErrInvalid
	}
	previous := ""
	for _, accelerator := range descriptor.Accelerators {
		key := accelerator.Profile + "\x00" + accelerator.OS + "\x00" + accelerator.Architecture + "\x00" + accelerator.Kind
		if !publicTokenPattern.MatchString(accelerator.Profile) || !publicTokenPattern.MatchString(accelerator.OS) ||
			!publicTokenPattern.MatchString(accelerator.Architecture) || !publicTokenPattern.MatchString(accelerator.Kind) || key <= previous {
			return ErrInvalid
		}
		previous = key
	}
	if validateLimits(descriptor.Limits) != nil || validateProvenance(descriptor.Provenance) != nil {
		return ErrInvalid
	}
	return nil
}

func validateLimits(limits Limits) error {
	if limits.MaximumModels == 0 || limits.MaximumModels > maximumModels || limits.MaximumConcurrency == 0 ||
		limits.MaximumConcurrency > maximumConcurrency || limits.MaximumModelBytes == 0 || limits.MaximumModelBytes > maximumResourceBytes ||
		limits.MaximumMemoryBytes == 0 || limits.MaximumMemoryBytes > maximumResourceBytes || limits.MaximumContextTokens == 0 ||
		limits.MaximumContextTokens > maximumContextTokens || limits.MaximumInputBytes == 0 || limits.MaximumInputBytes > maximumRequestBytes ||
		limits.MaximumOutputBytes == 0 || limits.MaximumOutputBytes > maximumRequestBytes {
		return ErrInvalid
	}
	return nil
}

func validateProvenance(provenance Provenance) error {
	parsed, err := url.Parse(provenance.SourceURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Port() != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || strings.TrimSpace(provenance.Version) != provenance.Version ||
		provenance.Version == "" || len(provenance.Version) > 128 || len(provenance.ArtifactSHA256) > maximumProvenanceEntries ||
		len(provenance.ContainerImages) > maximumProvenanceEntries || len(provenance.ArtifactSHA256)+len(provenance.ContainerImages) == 0 {
		return ErrInvalid
	}
	for platform, digest := range provenance.ArtifactSHA256 {
		if !publicTokenPattern.MatchString(platform) || !sha256Pattern.MatchString(digest) {
			return ErrInvalid
		}
	}
	previous := ""
	for _, image := range provenance.ContainerImages {
		if !pinnedContainerPattern.MatchString(image) || image <= previous {
			return ErrInvalid
		}
		previous = image
	}
	return nil
}

// ValidateOperationGrant validates a process-local grant at an explicit time.
// The explicit clock makes tests and selection deterministic.
func ValidateOperationGrant(grant OperationGrant, at time.Time) error {
	if at.IsZero() || validateOperationGrantStructure(grant) != nil || at.Before(grant.IssuedAt) {
		return ErrInvalid
	}
	if !at.Before(grant.ExpiresAt) {
		return ErrGrantExpired
	}
	return nil
}

// validateOperationGrantStructure performs the clock-independent portion used
// by registry dispatch. The backend remains responsible for evaluating grant
// currency with its authoritative clock before executing or cancelling.
func validateOperationGrantStructure(grant OperationGrant) error {
	if !executionIDPattern.MatchString(grant.ID) || grant.PolicyRevision == 0 || grant.IssuedAt.IsZero() || grant.ExpiresAt.IsZero() ||
		!grant.ExpiresAt.After(grant.IssuedAt) || grant.ExpiresAt.Sub(grant.IssuedAt) > maximumGrantLifetime ||
		!validTrafficClass(grant.TrafficClass) || len(grant.AllowedModelIDs) == 0 || len(grant.AllowedModelIDs) > int(maximumModels) ||
		validateLimits(grant.Limits) != nil || len(grant.AllowedModelIDs) > int(grant.Limits.MaximumModels) {
		return ErrInvalid
	}
	previous := ""
	for _, modelID := range grant.AllowedModelIDs {
		if !validModelID(modelID) || modelID <= previous {
			return ErrInvalid
		}
		previous = modelID
	}
	return nil
}

// ValidateModelRequirements validates bounded runtime-neutral model metadata.
func ValidateModelRequirements(model ModelRequirements) error {
	if !validModelID(model.ID) || !contentDigestPattern.MatchString(model.ContentDigest) || model.ArtifactBytes == 0 ||
		model.ArtifactBytes > maximumResourceBytes || model.EstimatedMemoryBytes == 0 || model.EstimatedMemoryBytes > maximumResourceBytes ||
		model.ContextTokens == 0 || model.ContextTokens > maximumContextTokens {
		return ErrInvalid
	}
	return nil
}

// ValidateDiscovery verifies that sanitized observations are canonical and
// covered by the descriptor's declared compatibility.
func ValidateDiscovery(descriptor Descriptor, discovery Discovery) error {
	if ValidateDescriptor(descriptor) != nil || len(discovery.Accelerators) == 0 || len(discovery.Accelerators) > maximumAccelerators {
		return ErrInvalid
	}
	previous := ""
	for _, accelerator := range discovery.Accelerators {
		key := accelerator.Profile + "\x00" + accelerator.OS + "\x00" + accelerator.Architecture + "\x00" + accelerator.Kind
		if !publicTokenPattern.MatchString(accelerator.Profile) || !publicTokenPattern.MatchString(accelerator.OS) ||
			!publicTokenPattern.MatchString(accelerator.Architecture) || !publicTokenPattern.MatchString(accelerator.Kind) ||
			accelerator.MemoryBytes == 0 || accelerator.MemoryBytes > maximumResourceBytes || key <= previous ||
			!supportsAccelerator(descriptor.Accelerators, accelerator) {
			return ErrInvalid
		}
		previous = key
	}
	return nil
}

// ValidateCompatibilityRequest validates a read-only compatibility probe.
func ValidateCompatibilityRequest(request CompatibilityRequest) error {
	if err := ValidateOperationGrant(request.Grant, request.EvaluationTime); err != nil {
		return err
	}
	if ValidateModelRequirements(request.Model) != nil || !publicTokenPattern.MatchString(request.Accelerator.Profile) ||
		!publicTokenPattern.MatchString(request.Accelerator.OS) || !publicTokenPattern.MatchString(request.Accelerator.Architecture) ||
		!publicTokenPattern.MatchString(request.Accelerator.Kind) || request.Accelerator.MemoryBytes == 0 ||
		request.Accelerator.MemoryBytes > maximumResourceBytes || (request.RequiredCapabilities.Stream && !request.RequiredCapabilities.Execute) ||
		(request.RequiredCapabilities.Cancel && !request.RequiredCapabilities.Execute) ||
		(request.RequiredCapabilities.CustomerTraffic && !request.RequiredCapabilities.Execute) ||
		request.RequiredCapabilities.CustomerTraffic != (request.Grant.TrafficClass == TrafficClassCustomer) ||
		!containsSorted(request.Grant.AllowedModelIDs, request.Model.ID) ||
		request.Model.ArtifactBytes > request.Grant.Limits.MaximumModelBytes || request.Model.EstimatedMemoryBytes > request.Grant.Limits.MaximumMemoryBytes ||
		request.Model.ContextTokens > request.Grant.Limits.MaximumContextTokens {
		return ErrInvalid
	}
	return nil
}

// ValidateCompatibility validates the stable result shape.
func ValidateCompatibility(compatibility Compatibility) error {
	if len(compatibility.Reasons) == 0 || len(compatibility.Reasons) > len(knownReasonCodes) {
		return ErrInvalid
	}
	seen := make(map[ReasonCode]struct{}, len(compatibility.Reasons))
	for _, reason := range compatibility.Reasons {
		if !validCompatibilityReasonCode(reason) {
			return ErrInvalid
		}
		if _, duplicate := seen[reason]; duplicate {
			return ErrInvalid
		}
		seen[reason] = struct{}{}
	}
	_, eligible := seen[ReasonEligible]
	if compatibility.Compatible != eligible || (compatibleOnlyEligible(compatibility.Reasons) != compatibility.Compatible) {
		return ErrInvalid
	}
	return nil
}

func compatibleOnlyEligible(reasons []ReasonCode) bool {
	return len(reasons) == 1 && reasons[0] == ReasonEligible
}

// ValidateDownloadRequest validates model acquisition against its grant.
func ValidateDownloadRequest(request DownloadRequest, at time.Time) error {
	if err := ValidateOperationGrant(request.Grant, at); err != nil {
		return err
	}
	if ValidateModelRequirements(request.Model) != nil || !containsSorted(request.Grant.AllowedModelIDs, request.Model.ID) ||
		request.Model.ArtifactBytes > request.Grant.Limits.MaximumModelBytes || request.Model.EstimatedMemoryBytes > request.Grant.Limits.MaximumMemoryBytes ||
		request.Model.ContextTokens > request.Grant.Limits.MaximumContextTokens {
		return ErrInvalid
	}
	return nil
}

// ValidateLoadRequest validates a verified model receipt against its grant.
func ValidateLoadRequest(request LoadRequest, at time.Time) error {
	if err := ValidateDownloadRequest(DownloadRequest{Grant: request.Grant, Model: request.Model}, at); err != nil {
		return err
	}
	if !backendIDPattern.MatchString(request.Download.BackendID) || request.Download.ModelID != request.Model.ID ||
		request.Download.ContentDigest != request.Model.ContentDigest || request.Download.Bytes != request.Model.ArtifactBytes {
		return ErrInvalid
	}
	return nil
}

// ValidateExecutionRequest validates identifiers, the explicit traffic class
// and byte bounds. It never interprets request input. Backend dispatch must
// additionally bind the class to a descriptor with
// ValidateExecutionRequestForDescriptor (or the Registry accessors).
func ValidateExecutionRequest(request ExecutionRequest, at time.Time) error {
	if err := ValidateOperationGrant(request.Grant, at); err != nil {
		return err
	}
	if !executionIDPattern.MatchString(request.ExecutionID) || !validModelID(request.ModelID) ||
		!containsSorted(request.Grant.AllowedModelIDs, request.ModelID) || len(request.Input) == 0 ||
		uint64(len(request.Input)) > request.Grant.Limits.MaximumInputBytes || request.MaximumOutputBytes == 0 ||
		request.MaximumOutputBytes > request.Grant.Limits.MaximumOutputBytes || !validTrafficClass(request.TrafficClass) ||
		request.TrafficClass != request.Grant.TrafficClass {
		return ErrInvalid
	}
	return nil
}

// ValidateExecutionRequestForDescriptor validates an execution request and
// enforces the immutable descriptor's traffic policy. Registry dispatch uses
// the same policy check so an adapter cannot accidentally bypass it.
func ValidateExecutionRequestForDescriptor(descriptor Descriptor, request ExecutionRequest, at time.Time) error {
	if err := ValidateExecutionRequest(request, at); err != nil {
		return err
	}
	return validateExecutionTrafficAuthorization(descriptor, request)
}

func validateExecutionTrafficAuthorization(descriptor Descriptor, request ExecutionRequest) error {
	if !validTrafficClass(request.Grant.TrafficClass) || request.TrafficClass != request.Grant.TrafficClass {
		return ErrInvalid
	}
	return validateExecutionTrafficPolicy(descriptor, request.Grant.TrafficClass)
}

func validateExecutionTrafficPolicy(descriptor Descriptor, trafficClass TrafficClass) error {
	if ValidateDescriptor(descriptor) != nil || !validTrafficClass(trafficClass) {
		return ErrInvalid
	}
	if trafficClass == TrafficClassCustomer &&
		(!descriptor.Capabilities.CustomerTraffic || descriptor.Capabilities.ShadowOnly) {
		return ErrExecutionDisabled
	}
	return nil
}

func validTrafficClass(trafficClass TrafficClass) bool {
	return trafficClass == TrafficClassShadow || trafficClass == TrafficClassCustomer
}

// ValidateCancelRequest validates an explicit cancellation target.
func ValidateCancelRequest(request CancelRequest, at time.Time) error {
	if err := ValidateOperationGrant(request.Grant, at); err != nil {
		return err
	}
	if !executionIDPattern.MatchString(request.ExecutionID) {
		return ErrInvalid
	}
	return nil
}

// ValidateCleanupRequest validates a bounded, canonical explicit model list.
func ValidateCleanupRequest(request CleanupRequest, at time.Time) error {
	if err := ValidateOperationGrant(request.Grant, at); err != nil {
		return err
	}
	if len(request.ModelIDs) > int(request.Grant.Limits.MaximumModels) {
		return ErrInvalid
	}
	previous := ""
	for _, modelID := range request.ModelIDs {
		if !validModelID(modelID) || modelID <= previous || !containsSorted(request.Grant.AllowedModelIDs, modelID) {
			return ErrInvalid
		}
		previous = modelID
	}
	return nil
}

// ValidateHealth checks normalized lifecycle invariants.
func ValidateHealth(health Health) error {
	if !publicTokenPattern.MatchString(health.State) || (health.Running && !health.Installed) {
		return ErrInvalid
	}
	return nil
}

// ValidateReadiness checks that ready responses do not carry a rejection code.
func ValidateReadiness(readiness Readiness) error {
	if readiness.Ready {
		if readiness.Reason != "" && readiness.Reason != ReasonEligible {
			return ErrInvalid
		}
		return nil
	}
	if readiness.Reason == "" || readiness.Reason == ReasonEligible || !validReasonCode(readiness.Reason) {
		return ErrInvalid
	}
	return nil
}

// ValidateMetrics checks normalized counters against a descriptor snapshot.
func ValidateMetrics(descriptor Descriptor, metrics Metrics) error {
	if ValidateDescriptor(descriptor) != nil || metrics.SchemaVersion != MetricsVersion ||
		metrics.InstalledModels > descriptor.Limits.MaximumModels || metrics.InFlight > descriptor.Limits.MaximumConcurrency ||
		metrics.MemoryBytes > descriptor.Limits.MaximumMemoryBytes || (!metrics.Running && metrics.InFlight != 0) ||
		metrics.OutOfMemoryErrors > metrics.ExecutionErrors || metrics.CrashErrors > metrics.ExecutionErrors ||
		metrics.TimeoutErrors > metrics.ExecutionErrors ||
		(metrics.ExecutionSamples == 0 && (metrics.PrefillMillisecondsP50 != 0 || metrics.TimeToFirstTokenMillisecondsP50 != 0 ||
			metrics.TokensPerSecondMilliP50 != 0)) ||
		(metrics.ExecutionSamples > 0 && (metrics.PrefillMillisecondsP50 == 0 || metrics.TimeToFirstTokenMillisecondsP50 == 0 ||
			metrics.TokensPerSecondMilliP50 == 0)) {
		return ErrInvalid
	}
	return nil
}

func validModelID(model string) bool {
	if model == "" || len(model) > 200 || strings.TrimSpace(model) != model || strings.Contains(model, "\\") ||
		modelURLSchemePattern.MatchString(model) || strings.HasPrefix(model, "/") || windowsPathPattern.MatchString(model) {
		return false
	}
	for _, value := range model {
		if unicode.IsControl(value) {
			return false
		}
	}
	for _, segment := range strings.Split(model, "/") {
		if segment == "" || segment == "." || segment == ".." || net.ParseIP(segment) != nil {
			return false
		}
	}
	return filepath.Clean(model) == model
}

func containsSorted(values []string, value string) bool {
	index := sort.SearchStrings(values, value)
	return index < len(values) && values[index] == value
}

func sameProvenance(left, right Provenance) bool {
	if left.SourceURL != right.SourceURL || left.Version != right.Version || len(left.ArtifactSHA256) != len(right.ArtifactSHA256) ||
		len(left.ContainerImages) != len(right.ContainerImages) {
		return false
	}
	for platform, digest := range left.ArtifactSHA256 {
		if right.ArtifactSHA256[platform] != digest {
			return false
		}
	}
	for index, image := range left.ContainerImages {
		if right.ContainerImages[index] != image {
			return false
		}
	}
	return true
}

// NormalizeExecutionError maps every error to one exact public sentinel. It
// intentionally discards wrappers and unknown backend text so prompt content,
// local paths and command output cannot cross the runtime boundary.
func NormalizeExecutionError(err error) (normalized error) {
	defer func() {
		if recover() != nil {
			normalized = ErrBackendFailure
		}
	}()
	if err == nil {
		return nil
	}
	stableErrors := []error{
		ErrInvalid,
		ErrIncompatible,
		ErrCapabilityUnavailable,
		ErrExecutionDisabled,
		ErrOutOfMemory,
		ErrCrashed,
		ErrTimedOut,
		ErrCancelled,
		ErrExecutionUnknown,
		ErrGrantMismatch,
		ErrGrantExpired,
		ErrBackendFailure,
	}
	for _, stable := range stableErrors {
		if errors.Is(err, stable) {
			return stable
		}
	}
	if errors.Is(err, context.Canceled) {
		return ErrCancelled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrTimedOut
	}
	return ErrBackendFailure
}
