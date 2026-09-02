package runtimebackend

import (
	"context"
	"errors"
	"sort"
	"time"
)

// SelectionMode controls whether the caller delegates choice or names an
// explicit, closed candidate chain.
type SelectionMode string

const (
	// SelectionAuto deterministically selects one primary and no fallback.
	SelectionAuto SelectionMode = "auto"
	// SelectionPrefer selects only the compatible IDs in the explicit order;
	// later compatible IDs are the complete fallback chain.
	SelectionPrefer SelectionMode = "prefer"
	// SelectionRequire requires exactly one named compatible backend.
	SelectionRequire SelectionMode = "require"
)

// CapabilityRequirements is the optional surface required by one workload.
type CapabilityRequirements struct {
	Execute         bool `json:"execute"`
	Stream          bool `json:"stream"`
	Cancel          bool `json:"cancel"`
	CustomerTraffic bool `json:"customer_traffic"`
}

// BackendConstraint is the allowlisted, provenance-pinned view supplied by a
// workload profile. AllowedBackends must be sorted by BackendID.
type BackendConstraint struct {
	BackendID  string     `json:"backend_id"`
	Provenance Provenance `json:"provenance"`
}

// SelectionRequest contains every input to deterministic backend selection.
// EvaluationTime is process-local and intentionally omitted from JSON.
type SelectionRequest struct {
	Mode                 SelectionMode          `json:"mode"`
	BackendIDs           []string               `json:"backend_ids,omitempty"`
	DisabledBackendIDs   []string               `json:"disabled_backend_ids,omitempty"`
	AllowedBackends      []BackendConstraint    `json:"allowed_backends"`
	RequiredCapabilities CapabilityRequirements `json:"required_capabilities"`
	Accelerator          Accelerator            `json:"accelerator"`
	Model                ModelRequirements      `json:"model"`
	Grant                OperationGrant         `json:"-"`
	EvaluationTime       time.Time              `json:"-"`
}

// ReasonCode is stable, bounded explanation data; backend error strings never
// enter a selection explanation.
type ReasonCode string

const (
	ReasonEligible                   ReasonCode = "eligible"
	ReasonSelectedPrimary            ReasonCode = "selected-primary"
	ReasonSelectedFallback           ReasonCode = "selected-fallback"
	ReasonNotRegistered              ReasonCode = "not-registered"
	ReasonNotAllowed                 ReasonCode = "not-allowed"
	ReasonDisabled                   ReasonCode = "disabled"
	ReasonNotPreferred               ReasonCode = "not-preferred"
	ReasonNotRequired                ReasonCode = "not-required"
	ReasonBackendRejected            ReasonCode = "backend-rejected"
	ReasonProvenanceMismatch         ReasonCode = "provenance-mismatch"
	ReasonAcceleratorMismatch        ReasonCode = "accelerator-mismatch"
	ReasonHardwareMemoryInsufficient ReasonCode = "hardware-memory-insufficient"
	ReasonExecuteUnavailable         ReasonCode = "execute-unavailable"
	ReasonStreamUnavailable          ReasonCode = "stream-unavailable"
	ReasonCancelUnavailable          ReasonCode = "cancel-unavailable"
	ReasonCustomerTrafficForbidden   ReasonCode = "customer-traffic-forbidden"
	ReasonModelLimitExceeded         ReasonCode = "model-limit-exceeded"
	ReasonMemoryLimitExceeded        ReasonCode = "memory-limit-exceeded"
	ReasonContextLimitExceeded       ReasonCode = "context-limit-exceeded"
	ReasonInputLimitExceeded         ReasonCode = "input-limit-exceeded"
	ReasonOutputLimitExceeded        ReasonCode = "output-limit-exceeded"
	ReasonConcurrencyLimitExceeded   ReasonCode = "concurrency-limit-exceeded"
)

var knownReasonCodes = map[ReasonCode]struct{}{
	ReasonEligible: {}, ReasonSelectedPrimary: {}, ReasonSelectedFallback: {}, ReasonNotRegistered: {}, ReasonNotAllowed: {},
	ReasonDisabled: {}, ReasonNotPreferred: {}, ReasonNotRequired: {}, ReasonBackendRejected: {}, ReasonProvenanceMismatch: {}, ReasonAcceleratorMismatch: {},
	ReasonHardwareMemoryInsufficient: {}, ReasonExecuteUnavailable: {}, ReasonStreamUnavailable: {}, ReasonCancelUnavailable: {},
	ReasonCustomerTrafficForbidden: {}, ReasonModelLimitExceeded: {}, ReasonMemoryLimitExceeded: {}, ReasonContextLimitExceeded: {},
	ReasonInputLimitExceeded: {}, ReasonOutputLimitExceeded: {}, ReasonConcurrencyLimitExceeded: {},
}

var compatibilityReasonCodes = map[ReasonCode]struct{}{
	ReasonEligible: {}, ReasonBackendRejected: {}, ReasonProvenanceMismatch: {}, ReasonAcceleratorMismatch: {},
	ReasonHardwareMemoryInsufficient: {}, ReasonExecuteUnavailable: {}, ReasonStreamUnavailable: {}, ReasonCancelUnavailable: {},
	ReasonCustomerTrafficForbidden: {}, ReasonModelLimitExceeded: {}, ReasonMemoryLimitExceeded: {}, ReasonContextLimitExceeded: {},
	ReasonInputLimitExceeded: {}, ReasonOutputLimitExceeded: {}, ReasonConcurrencyLimitExceeded: {},
}

// EvaluateCompatibility applies the shared fail-closed descriptor checks. A
// backend may return ReasonBackendRejected in addition to these checks when a
// private runtime condition prevents use.
func EvaluateCompatibility(descriptor Descriptor, request CompatibilityRequest) (Compatibility, error) {
	if ValidateDescriptor(descriptor) != nil {
		return Compatibility{}, ErrInvalid
	}
	if err := ValidateCompatibilityRequest(request); err != nil {
		return Compatibility{}, err
	}
	selectionRequest := SelectionRequest{
		RequiredCapabilities: request.RequiredCapabilities,
		Accelerator:          request.Accelerator,
		Model:                request.Model,
		Grant:                request.Grant,
	}
	reasons := candidateRejections(descriptor, BackendConstraint{BackendID: descriptor.ID, Provenance: descriptor.Provenance}, selectionRequest, map[string]struct{}{})
	if len(reasons) == 0 {
		return Compatibility{Compatible: true, Reasons: []ReasonCode{ReasonEligible}}, nil
	}
	return Compatibility{Compatible: false, Reasons: reasons}, nil
}

// CandidateExplanation records deterministic eligibility and rejection data.
type CandidateExplanation struct {
	BackendID string       `json:"backend_id"`
	Priority  uint16       `json:"priority,omitempty"`
	Eligible  bool         `json:"eligible"`
	Selected  bool         `json:"selected"`
	Reasons   []ReasonCode `json:"reasons"`
}

// Explanation is safe to expose: it contains no paths, argv, devices or raw
// backend errors.
type Explanation struct {
	Mode               SelectionMode          `json:"mode"`
	PrimaryBackendID   string                 `json:"primary_backend_id,omitempty"`
	FallbackBackendIDs []string               `json:"fallback_backend_ids"`
	Candidates         []CandidateExplanation `json:"candidates"`
}

// Selection contains one primary and only explicitly authorized fallbacks.
type Selection struct {
	Primary     Backend
	Fallbacks   []Backend
	Explanation Explanation
}

// ValidateSelectionRequest checks canonical input and current authorization.
func ValidateSelectionRequest(request SelectionRequest) error {
	if err := ValidateOperationGrant(request.Grant, request.EvaluationTime); err != nil {
		return err
	}
	if ValidateModelRequirements(request.Model) != nil || len(request.AllowedBackends) == 0 || len(request.AllowedBackends) > maximumBackends ||
		!publicTokenPattern.MatchString(request.Accelerator.Profile) || !publicTokenPattern.MatchString(request.Accelerator.OS) ||
		!publicTokenPattern.MatchString(request.Accelerator.Architecture) || !publicTokenPattern.MatchString(request.Accelerator.Kind) ||
		request.Accelerator.MemoryBytes == 0 || request.Accelerator.MemoryBytes > maximumResourceBytes ||
		(request.RequiredCapabilities.Stream && !request.RequiredCapabilities.Execute) ||
		(request.RequiredCapabilities.Cancel && !request.RequiredCapabilities.Execute) ||
		(request.RequiredCapabilities.CustomerTraffic && !request.RequiredCapabilities.Execute) ||
		request.RequiredCapabilities.CustomerTraffic != (request.Grant.TrafficClass == TrafficClassCustomer) ||
		!containsSorted(request.Grant.AllowedModelIDs, request.Model.ID) || request.Model.ArtifactBytes > request.Grant.Limits.MaximumModelBytes ||
		request.Model.EstimatedMemoryBytes > request.Grant.Limits.MaximumMemoryBytes || request.Model.ContextTokens > request.Grant.Limits.MaximumContextTokens {
		return ErrInvalid
	}
	allowed := make(map[string]struct{}, len(request.AllowedBackends))
	previous := ""
	for _, constraint := range request.AllowedBackends {
		if !backendIDPattern.MatchString(constraint.BackendID) || constraint.BackendID <= previous || validateProvenance(constraint.Provenance) != nil {
			return ErrInvalid
		}
		allowed[constraint.BackendID] = struct{}{}
		previous = constraint.BackendID
	}
	switch request.Mode {
	case SelectionAuto:
		if len(request.BackendIDs) != 0 {
			return ErrInvalid
		}
	case SelectionPrefer:
		if len(request.BackendIDs) == 0 || len(request.BackendIDs) > maximumBackends {
			return ErrInvalid
		}
	case SelectionRequire:
		if len(request.BackendIDs) != 1 {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	seen := make(map[string]struct{}, len(request.BackendIDs))
	for _, backendID := range request.BackendIDs {
		if _, exists := allowed[backendID]; !exists {
			return ErrInvalid
		}
		if _, duplicate := seen[backendID]; duplicate {
			return ErrInvalid
		}
		seen[backendID] = struct{}{}
	}
	previous = ""
	for _, backendID := range request.DisabledBackendIDs {
		if _, exists := allowed[backendID]; !exists || backendID <= previous {
			return ErrInvalid
		}
		if _, requested := seen[backendID]; requested {
			return ErrInvalid
		}
		previous = backendID
	}
	return nil
}

// Select deterministically evaluates all registered and allowlisted candidates.
// It never creates an implicit fallback.
func (registry *Registry) Select(request SelectionRequest) (Selection, error) {
	return registry.SelectContext(context.Background(), request)
}

// SelectContext is Select with explicit cancellation for backend-owned private
// compatibility probes. Backend errors are reduced to stable reason codes and
// never copied into Explanation.
func (registry *Registry) SelectContext(ctx context.Context, request SelectionRequest) (Selection, error) {
	explanation := Explanation{Mode: request.Mode, FallbackBackendIDs: []string{}, Candidates: []CandidateExplanation{}}
	if registry == nil || ctx == nil {
		return Selection{Explanation: explanation}, ErrInvalid
	}
	if err := ValidateSelectionRequest(request); err != nil {
		return Selection{Explanation: explanation}, err
	}
	if err := NormalizeExecutionError(ctx.Err()); err != nil {
		return Selection{Explanation: explanation}, err
	}
	constraints := make(map[string]BackendConstraint, len(request.AllowedBackends))
	allIDs := make(map[string]struct{}, len(request.AllowedBackends)+len(registry.ids))
	for _, constraint := range request.AllowedBackends {
		constraints[constraint.BackendID] = constraint
		allIDs[constraint.BackendID] = struct{}{}
	}
	for _, backendID := range registry.ids {
		allIDs[backendID] = struct{}{}
	}
	disabled := make(map[string]struct{}, len(request.DisabledBackendIDs))
	for _, backendID := range request.DisabledBackendIDs {
		disabled[backendID] = struct{}{}
	}
	ids := make([]string, 0, len(allIDs))
	for backendID := range allIDs {
		ids = append(ids, backendID)
	}
	sort.Strings(ids)
	eligible := make(map[string]registeredBackend)
	indices := make(map[string]int, len(ids))
	for _, backendID := range ids {
		candidate := CandidateExplanation{BackendID: backendID, Reasons: []ReasonCode{}}
		entry, registered := registry.byID[backendID]
		constraint, allowed := constraints[backendID]
		if registered {
			candidate.Priority = entry.descriptor.Priority
		}
		switch {
		case !registered:
			candidate.Reasons = append(candidate.Reasons, ReasonNotRegistered)
		case !allowed:
			candidate.Reasons = append(candidate.Reasons, ReasonNotAllowed)
		default:
			candidate.Reasons = append(candidate.Reasons, candidateRejections(entry.descriptor, constraint, request, disabled)...)
			if len(candidate.Reasons) == 0 {
				compatibility, compatibilityErr := entry.backend.Compatible(ctx, CompatibilityRequest{
					Grant: cloneOperationGrant(request.Grant), EvaluationTime: request.EvaluationTime, Accelerator: request.Accelerator,
					Model: request.Model, RequiredCapabilities: request.RequiredCapabilities,
				})
				if compatibilityErr != nil {
					normalized := NormalizeExecutionError(compatibilityErr)
					if errors.Is(normalized, ErrCancelled) || errors.Is(normalized, ErrTimedOut) {
						explanation.Candidates = append(explanation.Candidates, candidate)
						return Selection{Explanation: explanation}, normalized
					}
					candidate.Reasons = append(candidate.Reasons, ReasonBackendRejected)
				} else if ValidateCompatibility(compatibility) != nil {
					candidate.Reasons = append(candidate.Reasons, ReasonBackendRejected)
				} else if !compatibility.Compatible {
					candidate.Reasons = appendUniqueReasons(candidate.Reasons, compatibility.Reasons...)
				}
			}
		}
		candidate.Eligible = len(candidate.Reasons) == 0
		if candidate.Eligible {
			candidate.Reasons = append(candidate.Reasons, ReasonEligible)
			eligible[backendID] = entry
		} else {
			sort.Slice(candidate.Reasons, func(left, right int) bool { return candidate.Reasons[left] < candidate.Reasons[right] })
		}
		indices[backendID] = len(explanation.Candidates)
		explanation.Candidates = append(explanation.Candidates, candidate)
	}
	selectedIDs := selectEligibleIDs(request, eligible)
	if len(selectedIDs) == 0 {
		return Selection{Explanation: explanation}, ErrIncompatible
	}
	primaryEntry := eligible[selectedIDs[0]]
	explanation.PrimaryBackendID = selectedIDs[0]
	primaryIndex := indices[selectedIDs[0]]
	explanation.Candidates[primaryIndex].Selected = true
	explanation.Candidates[primaryIndex].Reasons = append(explanation.Candidates[primaryIndex].Reasons, ReasonSelectedPrimary)
	selection := Selection{Primary: primaryEntry.backend, Fallbacks: []Backend{}, Explanation: explanation}
	for _, backendID := range selectedIDs[1:] {
		selection.Fallbacks = append(selection.Fallbacks, eligible[backendID].backend)
		selection.Explanation.FallbackBackendIDs = append(selection.Explanation.FallbackBackendIDs, backendID)
		index := indices[backendID]
		selection.Explanation.Candidates[index].Selected = true
		selection.Explanation.Candidates[index].Reasons = append(selection.Explanation.Candidates[index].Reasons, ReasonSelectedFallback)
	}
	markUnselectedModeReasons(&selection.Explanation, request, indices)
	return selection, nil
}

func appendUniqueReasons(target []ReasonCode, reasons ...ReasonCode) []ReasonCode {
	seen := make(map[ReasonCode]struct{}, len(target)+len(reasons))
	for _, reason := range target {
		seen[reason] = struct{}{}
	}
	for _, reason := range reasons {
		if reason == ReasonEligible {
			continue
		}
		if _, duplicate := seen[reason]; duplicate {
			continue
		}
		seen[reason] = struct{}{}
		target = append(target, reason)
	}
	return target
}

func cloneOperationGrant(source OperationGrant) OperationGrant {
	grant := source
	grant.AllowedModelIDs = append([]string{}, source.AllowedModelIDs...)
	return grant
}

func candidateRejections(descriptor Descriptor, constraint BackendConstraint, request SelectionRequest, disabled map[string]struct{}) []ReasonCode {
	reasons := []ReasonCode{}
	if _, found := disabled[descriptor.ID]; found {
		reasons = append(reasons, ReasonDisabled)
	}
	if !sameProvenance(descriptor.Provenance, constraint.Provenance) {
		reasons = append(reasons, ReasonProvenanceMismatch)
	}
	required := request.RequiredCapabilities
	if required.Execute && !descriptor.Capabilities.Execute {
		reasons = append(reasons, ReasonExecuteUnavailable)
	}
	if required.Stream && !descriptor.Capabilities.Stream {
		reasons = append(reasons, ReasonStreamUnavailable)
	}
	if required.Cancel && !descriptor.Capabilities.Cancel {
		reasons = append(reasons, ReasonCancelUnavailable)
	}
	if required.CustomerTraffic && (!descriptor.Capabilities.CustomerTraffic || descriptor.Capabilities.ShadowOnly) {
		reasons = append(reasons, ReasonCustomerTrafficForbidden)
	}
	if !supportsAccelerator(descriptor.Accelerators, request.Accelerator) {
		reasons = append(reasons, ReasonAcceleratorMismatch)
	}
	if request.Model.EstimatedMemoryBytes > request.Accelerator.MemoryBytes {
		reasons = append(reasons, ReasonHardwareMemoryInsufficient)
	}
	if request.Model.ArtifactBytes > descriptor.Limits.MaximumModelBytes || request.Grant.Limits.MaximumModels > descriptor.Limits.MaximumModels {
		reasons = append(reasons, ReasonModelLimitExceeded)
	}
	if request.Model.EstimatedMemoryBytes > descriptor.Limits.MaximumMemoryBytes || request.Grant.Limits.MaximumMemoryBytes > descriptor.Limits.MaximumMemoryBytes {
		reasons = append(reasons, ReasonMemoryLimitExceeded)
	}
	if request.Model.ContextTokens > descriptor.Limits.MaximumContextTokens || request.Grant.Limits.MaximumContextTokens > descriptor.Limits.MaximumContextTokens {
		reasons = append(reasons, ReasonContextLimitExceeded)
	}
	if request.Grant.Limits.MaximumInputBytes > descriptor.Limits.MaximumInputBytes {
		reasons = append(reasons, ReasonInputLimitExceeded)
	}
	if request.Grant.Limits.MaximumOutputBytes > descriptor.Limits.MaximumOutputBytes {
		reasons = append(reasons, ReasonOutputLimitExceeded)
	}
	if request.Grant.Limits.MaximumConcurrency > descriptor.Limits.MaximumConcurrency {
		reasons = append(reasons, ReasonConcurrencyLimitExceeded)
	}
	return reasons
}

func supportsAccelerator(constraints []AcceleratorConstraint, accelerator Accelerator) bool {
	for _, constraint := range constraints {
		if constraint.Profile == accelerator.Profile && constraint.OS == accelerator.OS && constraint.Architecture == accelerator.Architecture &&
			constraint.Kind == accelerator.Kind {
			return true
		}
	}
	return false
}

func selectEligibleIDs(request SelectionRequest, eligible map[string]registeredBackend) []string {
	switch request.Mode {
	case SelectionAuto:
		entries := make([]registeredBackend, 0, len(eligible))
		for _, entry := range eligible {
			entries = append(entries, entry)
		}
		sort.Slice(entries, func(left, right int) bool {
			if entries[left].descriptor.Priority != entries[right].descriptor.Priority {
				return entries[left].descriptor.Priority < entries[right].descriptor.Priority
			}
			return entries[left].descriptor.ID < entries[right].descriptor.ID
		})
		if len(entries) == 0 {
			return []string{}
		}
		return []string{entries[0].descriptor.ID}
	case SelectionPrefer:
		selected := make([]string, 0, len(request.BackendIDs))
		for _, backendID := range request.BackendIDs {
			if _, found := eligible[backendID]; found {
				selected = append(selected, backendID)
			}
		}
		return selected
	case SelectionRequire:
		if _, found := eligible[request.BackendIDs[0]]; found {
			return append([]string{}, request.BackendIDs[0])
		}
	}
	return []string{}
}

func markUnselectedModeReasons(explanation *Explanation, request SelectionRequest, indices map[string]int) {
	if request.Mode == SelectionAuto {
		return
	}
	requested := make(map[string]struct{}, len(request.BackendIDs))
	for _, backendID := range request.BackendIDs {
		requested[backendID] = struct{}{}
	}
	for backendID, index := range indices {
		candidate := &explanation.Candidates[index]
		if !candidate.Eligible || candidate.Selected {
			continue
		}
		if _, found := requested[backendID]; found {
			continue
		}
		if request.Mode == SelectionPrefer {
			candidate.Reasons = append(candidate.Reasons, ReasonNotPreferred)
		} else {
			candidate.Reasons = append(candidate.Reasons, ReasonNotRequired)
		}
	}
}

func validReasonCode(reason ReasonCode) bool {
	_, found := knownReasonCodes[reason]
	return found
}

func validCompatibilityReasonCode(reason ReasonCode) bool {
	_, found := compatibilityReasonCodes[reason]
	return found
}
