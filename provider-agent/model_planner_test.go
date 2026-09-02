package main

import (
	"reflect"
	"testing"
	"time"
)

const plannerGiB uint64 = 1 << 30

func plannerPointer[T any](value T) *T {
	return &value
}

func testCapacityPolicyDocument() capacityPolicyDocument {
	return capacityPolicyDocument{
		SchemaVersion:                capacityPolicySchemaVersion,
		GPUUtilizationPercent:        plannerPointer(uint8(80)),
		GPUVRAMPercent:               plannerPointer(uint8(75)),
		MaxDiskBytes:                 plannerPointer(uint64(30 * plannerGiB)),
		ModelStoragePath:             "/var/lib/multivibe/models",
		MaxDownloadBytesPerDay:       plannerPointer(uint64(20 * plannerGiB)),
		MinimumModelResidencySeconds: plannerPointer(uint64((6 * time.Hour) / time.Second)),
		MaxModelChangesPerDay:        plannerPointer(uint32(4)),
		ReserveFreeDiskBytes:         plannerPointer(uint64(5 * plannerGiB)),
	}
}

func testCapacityPolicy(t *testing.T) capacityPolicy {
	t.Helper()
	policy, err := validateCapacityPolicy(testCapacityPolicyDocument())
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func testCapacitySnapshot() hostCapacitySnapshot {
	return hostCapacitySnapshot{
		ModelStoragePath:            "/var/lib/multivibe/models",
		TotalAcceleratorMemoryBytes: 16 * plannerGiB,
		ManagedModelDiskBytes:       2 * plannerGiB,
		FreeDiskBytes:               50 * plannerGiB,
	}
}

func testDemand(now time.Time, models ...authoritativeModelDemand) authoritativeDemandSnapshot {
	return authoritativeDemandSnapshot{
		SchemaVersion:  authoritativeDemandSchemaVersion,
		AuthorityKeyID: "multivibe-demand-key-1",
		Revision:       42,
		IssuedAt:       now.Add(-time.Minute),
		ExpiresAt:      now.Add(5 * time.Minute),
		Models:         models,
	}
}

func hasPlanConstraint(plan modelPlan, modelID, reason string) bool {
	for _, constraint := range plan.Constraints {
		if constraint.ModelID == modelID && constraint.Reason == reason {
			return true
		}
	}
	return false
}

func TestCapacityPolicyRequiresEveryExplicitOperatorChoice(t *testing.T) {
	tests := []struct {
		name   string
		remove func(*capacityPolicyDocument)
	}{
		{name: "schema", remove: func(document *capacityPolicyDocument) { document.SchemaVersion = "" }},
		{name: "gpu utilization", remove: func(document *capacityPolicyDocument) { document.GPUUtilizationPercent = nil }},
		{name: "gpu vram", remove: func(document *capacityPolicyDocument) { document.GPUVRAMPercent = nil }},
		{name: "disk limit", remove: func(document *capacityPolicyDocument) { document.MaxDiskBytes = nil }},
		{name: "storage path", remove: func(document *capacityPolicyDocument) { document.ModelStoragePath = "" }},
		{name: "download limit", remove: func(document *capacityPolicyDocument) { document.MaxDownloadBytesPerDay = nil }},
		{name: "residency", remove: func(document *capacityPolicyDocument) { document.MinimumModelResidencySeconds = nil }},
		{name: "change limit", remove: func(document *capacityPolicyDocument) { document.MaxModelChangesPerDay = nil }},
		{name: "free disk reserve", remove: func(document *capacityPolicyDocument) { document.ReserveFreeDiskBytes = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := testCapacityPolicyDocument()
			test.remove(&document)
			if _, err := validateCapacityPolicy(document); err == nil {
				t.Fatal("omitted operator choice must fail closed")
			}
		})
	}
}

func TestCapacityPolicyRejectsUnsafeValuesAndAllowsExplicitFreeze(t *testing.T) {
	tests := []struct {
		name   string
		change func(*capacityPolicyDocument)
	}{
		{name: "zero gpu", change: func(document *capacityPolicyDocument) { document.GPUUtilizationPercent = plannerPointer(uint8(0)) }},
		{name: "excess gpu", change: func(document *capacityPolicyDocument) { document.GPUUtilizationPercent = plannerPointer(uint8(101)) }},
		{name: "zero vram", change: func(document *capacityPolicyDocument) { document.GPUVRAMPercent = plannerPointer(uint8(0)) }},
		{name: "excess vram", change: func(document *capacityPolicyDocument) { document.GPUVRAMPercent = plannerPointer(uint8(101)) }},
		{name: "zero disk", change: func(document *capacityPolicyDocument) { document.MaxDiskBytes = plannerPointer(uint64(0)) }},
		{name: "relative path", change: func(document *capacityPolicyDocument) { document.ModelStoragePath = "models" }},
		{name: "unclean path", change: func(document *capacityPolicyDocument) { document.ModelStoragePath = "/var/lib/../models" }},
		{name: "filesystem root", change: func(document *capacityPolicyDocument) { document.ModelStoragePath = "/" }},
		{name: "zero residency", change: func(document *capacityPolicyDocument) {
			document.MinimumModelResidencySeconds = plannerPointer(uint64(0))
		}},
		{name: "zero reserve", change: func(document *capacityPolicyDocument) { document.ReserveFreeDiskBytes = plannerPointer(uint64(0)) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := testCapacityPolicyDocument()
			test.change(&document)
			if _, err := validateCapacityPolicy(document); err == nil {
				t.Fatal("unsafe policy must fail closed")
			}
		})
	}

	document := testCapacityPolicyDocument()
	document.MaxDownloadBytesPerDay = plannerPointer(uint64(0))
	document.MaxModelChangesPerDay = plannerPointer(uint32(0))
	policy, err := validateCapacityPolicy(document)
	if err != nil {
		t.Fatal(err)
	}
	if policy.maxDownloadBytesPerDay != 0 || policy.maxModelChangesPerDay != 0 {
		t.Fatal("explicit zero must freeze downloads and model changes")
	}
}

func TestPlannerRanksDemandContextUtilityAndFitsAllBudgets(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	candidates := []modelCandidate{
		{ModelID: "publisher/demand", GPUUtilizationPercent: 45, GPUVRAMBytes: 6 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000},
		{ModelID: "publisher/context", GPUUtilizationPercent: 45, GPUVRAMBytes: 7 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 32_000},
		{ModelID: "publisher/fill", GPUUtilizationPercent: 30, GPUVRAMBytes: 4 * plannerGiB, ArtifactBytes: 3 * plannerGiB, MaxContextTokens: 8_000},
		{ModelID: "publisher/too-short", GPUUtilizationPercent: 5, GPUVRAMBytes: plannerGiB, ArtifactBytes: plannerGiB, MaxContextTokens: 4_000},
	}
	demand := testDemand(now,
		authoritativeModelDemand{ModelID: "publisher/demand", DemandUnits: 10, RequiredContextTokens: 8_000},
		authoritativeModelDemand{ModelID: "publisher/context", DemandUnits: 6, RequiredContextTokens: 16_000},
		authoritativeModelDemand{ModelID: "publisher/fill", DemandUnits: 7, RequiredContextTokens: 4_000},
		authoritativeModelDemand{ModelID: "publisher/too-short", DemandUnits: 100, RequiredContextTokens: 8_000},
	)

	plan, err := planModels(testCapacityPolicy(t), testCapacitySnapshot(), candidates, demand, modelPlannerState{}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.SelectedModelIDs, []string{"publisher/context", "publisher/fill"}) {
		t.Fatalf("unexpected selected models: %#v", plan.SelectedModelIDs)
	}
	if !reflect.DeepEqual(plan.Downloads, []plannedModelDownload{
		{ModelID: "publisher/context", Bytes: 4 * plannerGiB},
		{ModelID: "publisher/fill", Bytes: 3 * plannerGiB},
	}) {
		t.Fatalf("unexpected downloads: %#v", plan.Downloads)
	}
	if plan.GPUUtilizationPercent != 75 || plan.GPUVRAMBytes != 11*plannerGiB || plan.AdditionalDiskBytes != 7*plannerGiB || !plan.ModelChange {
		t.Fatalf("unexpected bounded plan: %#v", plan)
	}
	if !hasPlanConstraint(plan, "publisher/demand", "gpu-utilization-budget") || !hasPlanConstraint(plan, "publisher/too-short", "context-budget") {
		t.Fatalf("missing deterministic exclusions: %#v", plan.Constraints)
	}

	reversedCandidates := append([]modelCandidate{}, candidates...)
	for left, right := 0, len(reversedCandidates)-1; left < right; left, right = left+1, right-1 {
		reversedCandidates[left], reversedCandidates[right] = reversedCandidates[right], reversedCandidates[left]
	}
	reversedDemand := demand
	reversedDemand.Models = append([]authoritativeModelDemand{}, demand.Models...)
	for left, right := 0, len(reversedDemand.Models)-1; left < right; left, right = left+1, right-1 {
		reversedDemand.Models[left], reversedDemand.Models[right] = reversedDemand.Models[right], reversedDemand.Models[left]
	}
	secondPlan, err := planModels(testCapacityPolicy(t), testCapacitySnapshot(), reversedCandidates, reversedDemand, modelPlannerState{}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan, secondPlan) {
		t.Fatalf("planner depends on input order:\nfirst:  %#v\nsecond: %#v", plan, secondPlan)
	}
}

func TestPlannerHonorsMinimumResidencyBeforeNewDemand(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	candidates := []modelCandidate{
		{ModelID: "publisher/resident", GPUUtilizationPercent: 60, GPUVRAMBytes: 8 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000},
		{ModelID: "publisher/hot", GPUUtilizationPercent: 60, GPUVRAMBytes: 8 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000},
	}
	state := modelPlannerState{
		InstalledModelIDs: []string{"publisher/resident"},
		ActiveModels:      []activeModelState{{ModelID: "publisher/resident", ActivatedAt: now.Add(-time.Hour)}},
	}
	plan, err := planModels(testCapacityPolicy(t), testCapacitySnapshot(), candidates, testDemand(now,
		authoritativeModelDemand{ModelID: "publisher/hot", DemandUnits: 100, RequiredContextTokens: 8_000},
	), state, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.SelectedModelIDs, []string{"publisher/resident"}) || plan.ModelChange || len(plan.Downloads) != 0 {
		t.Fatalf("resident model was displaced: %#v", plan)
	}
	if !hasPlanConstraint(plan, "publisher/resident", "minimum-residency") || !hasPlanConstraint(plan, "publisher/hot", "gpu-utilization-budget") {
		t.Fatalf("missing residency evidence: %#v", plan.Constraints)
	}
}

func TestPlannerEnforcesRollingModelChangeLimit(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	policy := testCapacityPolicy(t)
	policy.minimumModelResidency = time.Hour
	policy.maxModelChangesPerDay = 2
	candidates := []modelCandidate{
		{ModelID: "publisher/current", GPUUtilizationPercent: 60, GPUVRAMBytes: 8 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000},
		{ModelID: "publisher/replacement", GPUUtilizationPercent: 60, GPUVRAMBytes: 8 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000},
	}
	state := modelPlannerState{
		InstalledModelIDs: []string{"publisher/current", "publisher/replacement"},
		ActiveModels:      []activeModelState{{ModelID: "publisher/current", ActivatedAt: now.Add(-2 * time.Hour)}},
		ModelChanges:      []time.Time{now.Add(-25 * time.Hour), now.Add(-23 * time.Hour), now.Add(-2 * time.Hour)},
	}
	plan, err := planModels(policy, testCapacitySnapshot(), candidates, testDemand(now,
		authoritativeModelDemand{ModelID: "publisher/replacement", DemandUnits: 100, RequiredContextTokens: 8_000},
	), state, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.SelectedModelIDs, []string{"publisher/current"}) || plan.ModelChange || !plan.ModelChangeDeferred || len(plan.Downloads) != 0 {
		t.Fatalf("daily change limit was not enforced: %#v", plan)
	}
	if !hasPlanConstraint(plan, "", "daily-model-change-limit") {
		t.Fatalf("missing change-limit evidence: %#v", plan.Constraints)
	}
}

func TestPlannerEnforcesRollingDownloadLimitAndDiskReserve(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	policy := testCapacityPolicy(t)
	policy.maxDownloadBytesPerDay = 10 * plannerGiB
	candidates := []modelCandidate{
		{ModelID: "publisher/download", GPUUtilizationPercent: 50, GPUVRAMBytes: 6 * plannerGiB, ArtifactBytes: 6 * plannerGiB, MaxContextTokens: 16_000},
		{ModelID: "publisher/installed", GPUUtilizationPercent: 20, GPUVRAMBytes: 2 * plannerGiB, ArtifactBytes: 2 * plannerGiB, MaxContextTokens: 16_000},
	}
	state := modelPlannerState{
		InstalledModelIDs: []string{"publisher/installed"},
		Downloads: []modelDownloadHistoryEntry{
			{OccurredAt: now.Add(-25 * time.Hour), Bytes: 100 * plannerGiB},
			{OccurredAt: now.Add(-time.Hour), Bytes: 5 * plannerGiB},
		},
	}
	demand := testDemand(now,
		authoritativeModelDemand{ModelID: "publisher/download", DemandUnits: 100, RequiredContextTokens: 8_000},
		authoritativeModelDemand{ModelID: "publisher/installed", DemandUnits: 1, RequiredContextTokens: 8_000},
	)
	plan, err := planModels(policy, testCapacitySnapshot(), candidates, demand, state, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.SelectedModelIDs, []string{"publisher/installed"}) || len(plan.Downloads) != 0 || !hasPlanConstraint(plan, "publisher/download", "daily-download-budget") {
		t.Fatalf("rolling download limit was not enforced: %#v", plan)
	}

	capacity := testCapacitySnapshot()
	capacity.ManagedModelDiskBytes = 0
	capacity.FreeDiskBytes = policy.reserveFreeDiskBytes + 5*plannerGiB
	plan, err = planModels(policy, capacity, candidates[:1], testDemand(now,
		authoritativeModelDemand{ModelID: "publisher/download", DemandUnits: 100, RequiredContextTokens: 8_000},
	), modelPlannerState{}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.SelectedModelIDs) != 0 || !hasPlanConstraint(plan, "publisher/download", "storage-budget") {
		t.Fatalf("free disk reserve was not enforced: %#v", plan)
	}
}

func TestPlannerFailsClosedOnStaleOrInconsistentInputs(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	policy := testCapacityPolicy(t)
	candidate := modelCandidate{ModelID: "publisher/model", GPUUtilizationPercent: 50, GPUVRAMBytes: 6 * plannerGiB, ArtifactBytes: 4 * plannerGiB, MaxContextTokens: 16_000}
	demand := testDemand(now, authoritativeModelDemand{ModelID: candidate.ModelID, DemandUnits: 1, RequiredContextTokens: 8_000})

	t.Run("expired demand", func(t *testing.T) {
		expired := demand
		expired.ExpiresAt = now
		if _, err := planModels(policy, testCapacitySnapshot(), []modelCandidate{candidate}, expired, modelPlannerState{}, now); err == nil {
			t.Fatal("expired authoritative demand must fail closed")
		}
	})
	t.Run("unverified shape is not silently accepted", func(t *testing.T) {
		missingModels := demand
		missingModels.Models = nil
		if _, err := planModels(policy, testCapacitySnapshot(), []modelCandidate{candidate}, missingModels, modelPlannerState{}, now); err == nil {
			t.Fatal("omitted authoritative payload must fail closed")
		}
		_ = signedAuthoritativeDemandInput{
			SchemaVersion:  signedDemandEnvelopeSchemaVersion,
			AuthorityKeyID: demand.AuthorityKeyID,
			Payload:        []byte("opaque"),
			Signature:      []byte("not-verified-here"),
		}
	})
	t.Run("storage snapshot mismatch", func(t *testing.T) {
		capacity := testCapacitySnapshot()
		capacity.ModelStoragePath = "/different/path"
		if _, err := planModels(policy, capacity, []modelCandidate{candidate}, demand, modelPlannerState{}, now); err == nil {
			t.Fatal("snapshot for a different path must fail closed")
		}
	})
	t.Run("duplicate catalog", func(t *testing.T) {
		if _, err := planModels(policy, testCapacitySnapshot(), []modelCandidate{candidate, candidate}, demand, modelPlannerState{}, now); err == nil {
			t.Fatal("ambiguous catalog must fail closed")
		}
	})
	t.Run("active model outside budget", func(t *testing.T) {
		oversized := candidate
		oversized.GPUUtilizationPercent = 90
		state := modelPlannerState{
			InstalledModelIDs: []string{candidate.ModelID},
			ActiveModels:      []activeModelState{{ModelID: candidate.ModelID, ActivatedAt: now.Add(-time.Hour)}},
		}
		if _, err := planModels(policy, testCapacitySnapshot(), []modelCandidate{oversized}, demand, state, now); err == nil {
			t.Fatal("over-budget active state must fail closed")
		}
	})
	t.Run("future history", func(t *testing.T) {
		state := modelPlannerState{ModelChanges: []time.Time{now.Add(time.Second)}}
		if _, err := planModels(policy, testCapacitySnapshot(), []modelCandidate{candidate}, demand, state, now); err == nil {
			t.Fatal("future accounting event must fail closed")
		}
	})
}
