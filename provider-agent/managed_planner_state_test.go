package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManagedPlannerStatePersistsResidencyAndRollingUsage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "planner-state.json")
	store, err := openManagedPlannerStateStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	plan := modelPlan{
		SchemaVersion: modelPlanSchemaVersion, DemandRevision: 1, SelectedModelIDs: []string{"hf:qwen/model"},
		Downloads: []plannedModelDownload{{ModelID: "hf:qwen/model", Bytes: 42}}, ModelChange: true,
		Constraints: []modelPlanConstraint{},
	}
	probe := emptyManagedPlannerState()
	probe.ActiveModels = append(probe.ActiveModels, persistedActiveModelState{ModelID: "hf:qwen/model", ActivatedAt: canonicalPlannerTime(now)})
	probe.ModelChanges = append(probe.ModelChanges, canonicalPlannerTime(now))
	probe.Downloads = append(probe.Downloads, persistedModelDownload{OccurredAt: canonicalPlannerTime(now), Bytes: 42})
	if err := validateManagedPlannerState(probe); err != nil {
		t.Fatalf("valid state fixture was rejected: %#v %v", probe, err)
	}
	if err := store.recordAppliedPlan(plan, plan.Downloads, now); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("managed planner state permissions are unsafe: %#v %v", info, err)
	}
	restarted, err := openManagedPlannerStateStore(path)
	if err != nil {
		t.Fatal(err)
	}
	state, err := restarted.plannerState([]string{"hf:qwen/model"})
	if err != nil || len(state.ActiveModels) != 1 || !state.ActiveModels[0].ActivatedAt.Equal(now) || len(state.ModelChanges) != 1 || len(state.Downloads) != 1 || state.Downloads[0].Bytes != 42 {
		t.Fatalf("managed planner state did not round-trip: %#v %v", state, err)
	}

	unchanged := plan
	unchanged.ModelChange = false
	unchanged.Downloads = []plannedModelDownload{}
	if err := restarted.recordAppliedPlan(unchanged, nil, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	state, err = restarted.plannerState([]string{"hf:qwen/model"})
	if err != nil || len(state.ModelChanges) != 1 || !state.ActiveModels[0].ActivatedAt.Equal(now) {
		t.Fatalf("unchanged plan reset residency or change usage: %#v %v", state, err)
	}
}

func TestManagedPlannerStateRejectsPlanHistoryMismatch(t *testing.T) {
	store := newMemoryManagedPlannerStateStore()
	plan := modelPlan{
		SchemaVersion: modelPlanSchemaVersion, SelectedModelIDs: []string{"hf:qwen/model"}, Downloads: []plannedModelDownload{},
		ModelChange: false, Constraints: []modelPlanConstraint{},
	}
	if err := store.recordAppliedPlan(plan, nil, time.Now()); err == nil {
		t.Fatal("a changed active set with model_change=false was accepted")
	}
}
