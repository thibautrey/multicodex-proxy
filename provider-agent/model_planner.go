package main

import (
	"errors"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	authoritativeDemandSchemaVersion  = "provider-authoritative-demand-v1"
	signedDemandEnvelopeSchemaVersion = "provider-authoritative-demand-envelope-v1"
	modelPlanSchemaVersion            = "provider-model-plan-v1"
	maximumPlannerItems               = 10_000
	maximumPlannerHistoryItems        = 100_000
	plannerAccountingWindow           = 24 * time.Hour
)

var errInvalidModelPlannerInput = errors.New("provider model planner input is invalid")

// signedAuthoritativeDemandInput represents the untrusted wire artifact. This
// package deliberately provides no parser, verifier or conversion from this
// type to authoritativeDemandSnapshot. A separate trust boundary must verify
// the signature and freshness before constructing the planner input below.
type signedAuthoritativeDemandInput struct {
	SchemaVersion  string `json:"schema_version"`
	AuthorityKeyID string `json:"authority_key_id"`
	Payload        []byte `json:"payload"`
	Signature      []byte `json:"signature"`
}

// authoritativeDemandSnapshot is trusted input supplied after verification
// outside this package. Structural and freshness checks here are defense in
// depth; they do not authenticate AuthorityKeyID.
type authoritativeDemandSnapshot struct {
	SchemaVersion  string                     `json:"schema_version"`
	AuthorityKeyID string                     `json:"authority_key_id"`
	Revision       uint64                     `json:"revision"`
	IssuedAt       time.Time                  `json:"issued_at"`
	ExpiresAt      time.Time                  `json:"expires_at"`
	Models         []authoritativeModelDemand `json:"models"`
}

type authoritativeModelDemand struct {
	ModelID               string `json:"model_id"`
	DemandUnits           uint64 `json:"demand_units"`
	RequiredContextTokens uint64 `json:"required_context_tokens"`
}

// hostCapacitySnapshot is supplied by the caller for the one configured model
// storage path. The planner performs no filesystem or hardware discovery.
type hostCapacitySnapshot struct {
	ModelStoragePath            string
	TotalAcceleratorMemoryBytes uint64
	ManagedModelDiskBytes       uint64
	FreeDiskBytes               uint64
}

type modelCandidate struct {
	ModelID               string
	GPUUtilizationPercent uint8
	GPUVRAMBytes          uint64
	ArtifactBytes         uint64
	MaxContextTokens      uint64
}

type activeModelState struct {
	ModelID     string
	ActivatedAt time.Time
}

type modelDownloadHistoryEntry struct {
	OccurredAt time.Time
	Bytes      uint64
}

// modelPlannerState must come from the provider agent's managed state. It is
// intentionally not populated by walking modelStoragePath.
type modelPlannerState struct {
	InstalledModelIDs []string
	ActiveModels      []activeModelState
	ModelChanges      []time.Time
	Downloads         []modelDownloadHistoryEntry
}

type plannedModelDownload struct {
	ModelID string `json:"model_id"`
	Bytes   uint64 `json:"bytes"`
}

type modelPlanConstraint struct {
	ModelID string `json:"model_id,omitempty"`
	Reason  string `json:"reason"`
}

// modelPlan is declarative. Producing it does not download, delete, start or
// stop anything.
type modelPlan struct {
	SchemaVersion         string                 `json:"schema_version"`
	DemandRevision        uint64                 `json:"demand_revision"`
	ModelStoragePath      string                 `json:"model_storage_path"`
	SelectedModelIDs      []string               `json:"selected_model_ids"`
	Downloads             []plannedModelDownload `json:"downloads"`
	GPUUtilizationPercent uint8                  `json:"gpu_utilization_percent"`
	GPUVRAMBytes          uint64                 `json:"gpu_vram_bytes"`
	AdditionalDiskBytes   uint64                 `json:"additional_disk_bytes"`
	ModelChange           bool                   `json:"model_change"`
	ModelChangeDeferred   bool                   `json:"model_change_deferred"`
	Constraints           []modelPlanConstraint  `json:"constraints"`
}

type rankedModelCandidate struct {
	candidate modelCandidate
	demand    authoritativeModelDemand
	utility   uint64
	installed bool
	active    bool
}

func planModels(policy capacityPolicy, capacity hostCapacitySnapshot, candidates []modelCandidate, demand authoritativeDemandSnapshot, state modelPlannerState, now time.Time) (modelPlan, error) {
	if err := validateCapacityPolicyValue(policy); err != nil || now.IsZero() {
		return modelPlan{}, errInvalidModelPlannerInput
	}
	if err := validateHostCapacitySnapshot(policy, capacity); err != nil {
		return modelPlan{}, err
	}
	candidateByID, err := validateModelCandidates(candidates)
	if err != nil {
		return modelPlan{}, err
	}
	if err := validateAuthoritativeDemand(demand, now); err != nil {
		return modelPlan{}, err
	}
	installed, activeByID, err := validateModelPlannerState(state, candidateByID, now)
	if err != nil {
		return modelPlan{}, err
	}

	vramBudget := percentageOf(capacity.TotalAcceleratorMemoryBytes, policy.gpuVRAMPercent)
	currentGPU, currentVRAM, currentIDs, err := currentActiveUsage(activeByID, candidateByID)
	if err != nil || currentGPU > uint64(policy.gpuUtilizationPercent) || currentVRAM > vramBudget {
		return modelPlan{}, errInvalidModelPlannerInput
	}
	for _, modelID := range currentIDs {
		if candidateByID[modelID].ArtifactBytes > policy.maxDiskBytes {
			return modelPlan{}, errInvalidModelPlannerInput
		}
	}

	remainingDisk := policy.maxDiskBytes - capacity.ManagedModelDiskBytes
	if capacity.FreeDiskBytes <= policy.reserveFreeDiskBytes {
		remainingDisk = 0
	} else if physicalRemaining := capacity.FreeDiskBytes - policy.reserveFreeDiskBytes; physicalRemaining < remainingDisk {
		remainingDisk = physicalRemaining
	}

	recentDownloadBytes, err := recentDownloadUsage(state.Downloads, now)
	if err != nil {
		return modelPlan{}, err
	}
	remainingDownload := uint64(0)
	if recentDownloadBytes < policy.maxDownloadBytesPerDay {
		remainingDownload = policy.maxDownloadBytesPerDay - recentDownloadBytes
	}

	selected := make(map[string]modelCandidate)
	constraints := make([]modelPlanConstraint, 0)
	selectedGPU := uint64(0)
	selectedVRAM := uint64(0)
	for _, modelID := range currentIDs {
		active := activeByID[modelID]
		if !now.Before(active.ActivatedAt.Add(policy.minimumModelResidency)) {
			continue
		}
		candidate := candidateByID[modelID]
		selected[modelID] = candidate
		selectedGPU += uint64(candidate.GPUUtilizationPercent)
		selectedVRAM += candidate.GPUVRAMBytes
		constraints = append(constraints, modelPlanConstraint{ModelID: modelID, Reason: "minimum-residency"})
	}

	ranked := make([]rankedModelCandidate, 0, len(demand.Models))
	for _, item := range demand.Models {
		candidate, exists := candidateByID[item.ModelID]
		if !exists {
			constraints = append(constraints, modelPlanConstraint{ModelID: item.ModelID, Reason: "candidate-unavailable"})
			continue
		}
		if candidate.MaxContextTokens < item.RequiredContextTokens {
			constraints = append(constraints, modelPlanConstraint{ModelID: item.ModelID, Reason: "context-budget"})
			continue
		}
		utility, ok := checkedMultiply(item.DemandUnits, item.RequiredContextTokens)
		if !ok {
			return modelPlan{}, errInvalidModelPlannerInput
		}
		_, isActive := activeByID[item.ModelID]
		_, isInstalled := installed[item.ModelID]
		ranked = append(ranked, rankedModelCandidate{
			candidate: candidate,
			demand:    item,
			utility:   utility,
			installed: isInstalled,
			active:    isActive,
		})
	}
	sort.Slice(ranked, func(left, right int) bool {
		a, b := ranked[left], ranked[right]
		if a.utility != b.utility {
			return a.utility > b.utility
		}
		if a.demand.RequiredContextTokens != b.demand.RequiredContextTokens {
			return a.demand.RequiredContextTokens > b.demand.RequiredContextTokens
		}
		if a.demand.DemandUnits != b.demand.DemandUnits {
			return a.demand.DemandUnits > b.demand.DemandUnits
		}
		if a.active != b.active {
			return a.active
		}
		if a.installed != b.installed {
			return a.installed
		}
		if a.candidate.ArtifactBytes != b.candidate.ArtifactBytes {
			return a.candidate.ArtifactBytes < b.candidate.ArtifactBytes
		}
		return a.candidate.ModelID < b.candidate.ModelID
	})

	downloads := make([]plannedModelDownload, 0)
	additionalDisk := uint64(0)
	for _, rankedCandidate := range ranked {
		candidate := rankedCandidate.candidate
		if _, exists := selected[candidate.ModelID]; exists {
			continue
		}
		if selectedGPU+uint64(candidate.GPUUtilizationPercent) > uint64(policy.gpuUtilizationPercent) {
			constraints = append(constraints, modelPlanConstraint{ModelID: candidate.ModelID, Reason: "gpu-utilization-budget"})
			continue
		}
		nextVRAM, ok := checkedAdd(selectedVRAM, candidate.GPUVRAMBytes)
		if !ok || nextVRAM > vramBudget {
			constraints = append(constraints, modelPlanConstraint{ModelID: candidate.ModelID, Reason: "gpu-vram-budget"})
			continue
		}
		if !rankedCandidate.installed {
			if candidate.ArtifactBytes > remainingDisk {
				constraints = append(constraints, modelPlanConstraint{ModelID: candidate.ModelID, Reason: "storage-budget"})
				continue
			}
			if candidate.ArtifactBytes > remainingDownload {
				constraints = append(constraints, modelPlanConstraint{ModelID: candidate.ModelID, Reason: "daily-download-budget"})
				continue
			}
			remainingDisk -= candidate.ArtifactBytes
			remainingDownload -= candidate.ArtifactBytes
			additionalDisk += candidate.ArtifactBytes
			downloads = append(downloads, plannedModelDownload{ModelID: candidate.ModelID, Bytes: candidate.ArtifactBytes})
		}
		selected[candidate.ModelID] = candidate
		selectedGPU += uint64(candidate.GPUUtilizationPercent)
		selectedVRAM = nextVRAM
	}

	selectedIDs := sortedSelectedModelIDs(selected)
	changeRequired := !equalStrings(selectedIDs, currentIDs)
	changeDeferred := false
	if changeRequired {
		recentChanges, historyErr := recentModelChanges(state.ModelChanges, now)
		if historyErr != nil {
			return modelPlan{}, historyErr
		}
		if recentChanges >= uint64(policy.maxModelChangesPerDay) {
			selectedIDs = currentIDs
			selectedGPU = currentGPU
			selectedVRAM = currentVRAM
			downloads = []plannedModelDownload{}
			additionalDisk = 0
			changeRequired = false
			changeDeferred = true
			constraints = append(constraints, modelPlanConstraint{Reason: "daily-model-change-limit"})
		}
	}

	sort.Slice(downloads, func(left, right int) bool { return downloads[left].ModelID < downloads[right].ModelID })
	sort.Slice(constraints, func(left, right int) bool {
		if constraints[left].ModelID != constraints[right].ModelID {
			return constraints[left].ModelID < constraints[right].ModelID
		}
		return constraints[left].Reason < constraints[right].Reason
	})

	return modelPlan{
		SchemaVersion:         modelPlanSchemaVersion,
		DemandRevision:        demand.Revision,
		ModelStoragePath:      policy.modelStoragePath,
		SelectedModelIDs:      selectedIDs,
		Downloads:             downloads,
		GPUUtilizationPercent: uint8(selectedGPU),
		GPUVRAMBytes:          selectedVRAM,
		AdditionalDiskBytes:   additionalDisk,
		ModelChange:           changeRequired,
		ModelChangeDeferred:   changeDeferred,
		Constraints:           constraints,
	}, nil
}

func validateHostCapacitySnapshot(policy capacityPolicy, capacity hostCapacitySnapshot) error {
	if capacity.ModelStoragePath != policy.modelStoragePath || capacity.TotalAcceleratorMemoryBytes == 0 || capacity.ManagedModelDiskBytes > policy.maxDiskBytes {
		return errInvalidModelPlannerInput
	}
	return nil
}

func validateModelCandidates(candidates []modelCandidate) (map[string]modelCandidate, error) {
	if len(candidates) > maximumPlannerItems {
		return nil, errInvalidModelPlannerInput
	}
	result := make(map[string]modelCandidate, len(candidates))
	for _, candidate := range candidates {
		if !validSelectedModelID(candidate.ModelID) || candidate.GPUUtilizationPercent < 1 || candidate.GPUUtilizationPercent > 100 ||
			candidate.GPUVRAMBytes == 0 || candidate.ArtifactBytes == 0 || candidate.MaxContextTokens == 0 {
			return nil, errInvalidModelPlannerInput
		}
		if _, exists := result[candidate.ModelID]; exists {
			return nil, errInvalidModelPlannerInput
		}
		result[candidate.ModelID] = candidate
	}
	return result, nil
}

func validateAuthoritativeDemand(demand authoritativeDemandSnapshot, now time.Time) error {
	if demand.SchemaVersion != authoritativeDemandSchemaVersion || !validAuthorityKeyID(demand.AuthorityKeyID) || demand.Revision == 0 ||
		demand.IssuedAt.IsZero() || demand.ExpiresAt.IsZero() || demand.IssuedAt.After(now) || !now.Before(demand.ExpiresAt) ||
		!demand.IssuedAt.Before(demand.ExpiresAt) || demand.Models == nil || len(demand.Models) > maximumPlannerItems {
		return errInvalidModelPlannerInput
	}
	seen := make(map[string]struct{}, len(demand.Models))
	for _, item := range demand.Models {
		if !validSelectedModelID(item.ModelID) || item.DemandUnits == 0 || item.RequiredContextTokens == 0 {
			return errInvalidModelPlannerInput
		}
		if _, exists := seen[item.ModelID]; exists {
			return errInvalidModelPlannerInput
		}
		if _, ok := checkedMultiply(item.DemandUnits, item.RequiredContextTokens); !ok {
			return errInvalidModelPlannerInput
		}
		seen[item.ModelID] = struct{}{}
	}
	return nil
}

func validAuthorityKeyID(value string) bool {
	if value == "" || len(value) > 128 || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validateModelPlannerState(state modelPlannerState, candidates map[string]modelCandidate, now time.Time) (map[string]struct{}, map[string]activeModelState, error) {
	if len(state.InstalledModelIDs) > maximumPlannerItems || len(state.ActiveModels) > maximumPlannerItems ||
		len(state.ModelChanges) > maximumPlannerHistoryItems || len(state.Downloads) > maximumPlannerHistoryItems {
		return nil, nil, errInvalidModelPlannerInput
	}
	installed := make(map[string]struct{}, len(state.InstalledModelIDs))
	for _, modelID := range state.InstalledModelIDs {
		if !validSelectedModelID(modelID) {
			return nil, nil, errInvalidModelPlannerInput
		}
		if _, exists := installed[modelID]; exists {
			return nil, nil, errInvalidModelPlannerInput
		}
		installed[modelID] = struct{}{}
	}
	active := make(map[string]activeModelState, len(state.ActiveModels))
	for _, item := range state.ActiveModels {
		if item.ActivatedAt.IsZero() || item.ActivatedAt.After(now) {
			return nil, nil, errInvalidModelPlannerInput
		}
		if _, exists := installed[item.ModelID]; !exists {
			return nil, nil, errInvalidModelPlannerInput
		}
		if _, exists := candidates[item.ModelID]; !exists {
			return nil, nil, errInvalidModelPlannerInput
		}
		if _, exists := active[item.ModelID]; exists {
			return nil, nil, errInvalidModelPlannerInput
		}
		active[item.ModelID] = item
	}
	for _, changedAt := range state.ModelChanges {
		if changedAt.IsZero() || changedAt.After(now) {
			return nil, nil, errInvalidModelPlannerInput
		}
	}
	for _, download := range state.Downloads {
		if download.OccurredAt.IsZero() || download.OccurredAt.After(now) || download.Bytes == 0 {
			return nil, nil, errInvalidModelPlannerInput
		}
	}
	return installed, active, nil
}

func currentActiveUsage(active map[string]activeModelState, candidates map[string]modelCandidate) (uint64, uint64, []string, error) {
	ids := make([]string, 0, len(active))
	for modelID := range active {
		ids = append(ids, modelID)
	}
	sort.Strings(ids)
	gpu := uint64(0)
	vram := uint64(0)
	for _, modelID := range ids {
		candidate := candidates[modelID]
		gpu += uint64(candidate.GPUUtilizationPercent)
		nextVRAM, ok := checkedAdd(vram, candidate.GPUVRAMBytes)
		if !ok {
			return 0, 0, nil, errInvalidModelPlannerInput
		}
		vram = nextVRAM
	}
	return gpu, vram, ids, nil
}

func recentDownloadUsage(history []modelDownloadHistoryEntry, now time.Time) (uint64, error) {
	windowStart := now.Add(-plannerAccountingWindow)
	total := uint64(0)
	for _, entry := range history {
		if entry.OccurredAt.Before(windowStart) {
			continue
		}
		var ok bool
		total, ok = checkedAdd(total, entry.Bytes)
		if !ok {
			return 0, errInvalidModelPlannerInput
		}
	}
	return total, nil
}

func recentModelChanges(history []time.Time, now time.Time) (uint64, error) {
	windowStart := now.Add(-plannerAccountingWindow)
	count := uint64(0)
	for _, changedAt := range history {
		if changedAt.Before(windowStart) {
			continue
		}
		if count == math.MaxUint64 {
			return 0, errInvalidModelPlannerInput
		}
		count++
	}
	return count, nil
}

func percentageOf(total uint64, percent uint8) uint64 {
	whole := (total / 100) * uint64(percent)
	partial := ((total % 100) * uint64(percent)) / 100
	return whole + partial
}

func checkedAdd(left, right uint64) (uint64, bool) {
	if right > math.MaxUint64-left {
		return 0, false
	}
	return left + right, true
}

func checkedMultiply(left, right uint64) (uint64, bool) {
	if left != 0 && right > math.MaxUint64/left {
		return 0, false
	}
	return left * right, true
}

func sortedSelectedModelIDs(selected map[string]modelCandidate) []string {
	ids := make([]string, 0, len(selected))
	for modelID := range selected {
		ids = append(ids, modelID)
	}
	sort.Strings(ids)
	return ids
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
