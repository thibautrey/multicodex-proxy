package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	managedPlannerStateSchemaVersion = "provider-managed-planner-state-v1"
	managedPlannerStateMaximumBytes  = 4 * 1024 * 1024
)

type persistedActiveModelState struct {
	ModelID     string `json:"model_id"`
	ActivatedAt string `json:"activated_at"`
}

type persistedModelDownload struct {
	OccurredAt string `json:"occurred_at"`
	Bytes      uint64 `json:"bytes"`
}

type managedPlannerStateDocument struct {
	SchemaVersion string                      `json:"schema_version"`
	ActiveModels  []persistedActiveModelState `json:"active_models"`
	ModelChanges  []string                    `json:"model_changes"`
	Downloads     []persistedModelDownload    `json:"downloads"`
}

type managedPlannerStateStore struct {
	mu      sync.Mutex
	path    string
	current managedPlannerStateDocument
}

func emptyManagedPlannerState() managedPlannerStateDocument {
	return managedPlannerStateDocument{
		SchemaVersion: managedPlannerStateSchemaVersion,
		ActiveModels:  []persistedActiveModelState{},
		ModelChanges:  []string{},
		Downloads:     []persistedModelDownload{},
	}
}

func newMemoryManagedPlannerStateStore() *managedPlannerStateStore {
	return &managedPlannerStateStore{current: emptyManagedPlannerState()}
}

func openManagedPlannerStateStore(path string) (*managedPlannerStateStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("managed planner state path must be a clean absolute path")
	}
	store := &managedPlannerStateStore{path: path, current: emptyManagedPlannerState()}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || info.Size() < 1 || info.Size() > managedPlannerStateMaximumBytes {
		return nil, errors.New("managed planner state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("managed planner state cannot be opened")
	}
	defer file.Close()
	var document managedPlannerStateDocument
	decoder := json.NewDecoder(io.LimitReader(file, managedPlannerStateMaximumBytes+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || validateManagedPlannerState(document) != nil {
		return nil, errors.New("managed planner state is invalid")
	}
	store.current = cloneManagedPlannerState(document)
	return store, nil
}

func cloneManagedPlannerState(document managedPlannerStateDocument) managedPlannerStateDocument {
	activeModels := make([]persistedActiveModelState, len(document.ActiveModels))
	copy(activeModels, document.ActiveModels)
	modelChanges := make([]string, len(document.ModelChanges))
	copy(modelChanges, document.ModelChanges)
	downloads := make([]persistedModelDownload, len(document.Downloads))
	copy(downloads, document.Downloads)
	document.ActiveModels = activeModels
	document.ModelChanges = modelChanges
	document.Downloads = downloads
	return document
}

func validateManagedPlannerState(document managedPlannerStateDocument) error {
	if document.SchemaVersion != managedPlannerStateSchemaVersion || document.ActiveModels == nil || document.ModelChanges == nil || document.Downloads == nil ||
		len(document.ActiveModels) > maximumPlannerItems || len(document.ModelChanges) > maximumPlannerHistoryItems || len(document.Downloads) > maximumPlannerHistoryItems {
		return errors.New("managed planner state is invalid")
	}
	previousModel := ""
	for _, active := range document.ActiveModels {
		if !validSelectedModelID(active.ModelID) || active.ModelID <= previousModel {
			return errors.New("managed planner state is invalid")
		}
		if _, err := canonicalTimestamp(active.ActivatedAt); err != nil {
			return errors.New("managed planner state is invalid")
		}
		previousModel = active.ModelID
	}
	previousTime := time.Time{}
	for _, encoded := range document.ModelChanges {
		parsed, err := canonicalTimestamp(encoded)
		if err != nil || (!previousTime.IsZero() && parsed.Before(previousTime)) {
			return errors.New("managed planner state is invalid")
		}
		previousTime = parsed
	}
	previousTime = time.Time{}
	for _, download := range document.Downloads {
		parsed, err := canonicalTimestamp(download.OccurredAt)
		if err != nil || download.Bytes == 0 || (!previousTime.IsZero() && parsed.Before(previousTime)) {
			return errors.New("managed planner state is invalid")
		}
		previousTime = parsed
	}
	return nil
}

func (store *managedPlannerStateStore) plannerState(installedModelIDs []string) (modelPlannerState, error) {
	store.mu.Lock()
	document := cloneManagedPlannerState(store.current)
	store.mu.Unlock()
	if validateManagedPlannerState(document) != nil {
		return modelPlannerState{}, errors.New("managed planner state is invalid")
	}
	state := modelPlannerState{
		InstalledModelIDs: append([]string(nil), installedModelIDs...),
		ActiveModels:      make([]activeModelState, 0, len(document.ActiveModels)),
		ModelChanges:      make([]time.Time, 0, len(document.ModelChanges)),
		Downloads:         make([]modelDownloadHistoryEntry, 0, len(document.Downloads)),
	}
	for _, active := range document.ActiveModels {
		parsed, _ := canonicalTimestamp(active.ActivatedAt)
		state.ActiveModels = append(state.ActiveModels, activeModelState{ModelID: active.ModelID, ActivatedAt: parsed})
	}
	for _, encoded := range document.ModelChanges {
		parsed, _ := canonicalTimestamp(encoded)
		state.ModelChanges = append(state.ModelChanges, parsed)
	}
	for _, download := range document.Downloads {
		parsed, _ := canonicalTimestamp(download.OccurredAt)
		state.Downloads = append(state.Downloads, modelDownloadHistoryEntry{OccurredAt: parsed, Bytes: download.Bytes})
	}
	return state, nil
}

func canonicalPlannerTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func (store *managedPlannerStateStore) recordAppliedPlan(plan modelPlan, pulled []plannedModelDownload, now time.Time) error {
	return store.recordAppliedPlanInternal(plan, pulled, false, now)
}

func (store *managedPlannerStateStore) recordAppliedPlanAfterRecordedDownloads(plan modelPlan, now time.Time) error {
	return store.recordAppliedPlanInternal(plan, plan.Downloads, true, now)
}

func (store *managedPlannerStateStore) recordAppliedPlanInternal(plan modelPlan, pulled []plannedModelDownload, downloadsAlreadyRecorded bool, now time.Time) error {
	if now.IsZero() || plan.SchemaVersion != modelPlanSchemaVersion || plan.DemandRevision < 1 || plan.SelectedModelIDs == nil || plan.Downloads == nil || plan.Constraints == nil {
		return errors.New("managed planner state update is invalid")
	}
	selected := append([]string(nil), plan.SelectedModelIDs...)
	sort.Strings(selected)
	if !equalStrings(selected, plan.SelectedModelIDs) {
		return errors.New("managed planner state update is invalid")
	}
	for index, modelID := range selected {
		if !validSelectedModelID(modelID) || (index > 0 && modelID == selected[index-1]) {
			return errors.New("managed planner state update is invalid")
		}
	}
	pulledCopy := append([]plannedModelDownload(nil), pulled...)
	sort.Slice(pulledCopy, func(left, right int) bool { return pulledCopy[left].ModelID < pulledCopy[right].ModelID })
	for index, download := range pulledCopy {
		if !validSelectedModelID(download.ModelID) || download.Bytes == 0 || (index > 0 && download.ModelID == pulledCopy[index-1].ModelID) {
			return errors.New("managed planner state update is invalid")
		}
	}
	if len(pulledCopy) != len(plan.Downloads) {
		return errors.New("managed planner state update is incomplete")
	}
	for index, download := range pulledCopy {
		if download != plan.Downloads[index] {
			return errors.New("managed planner state update conflicts with planned downloads")
		}
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	current := cloneManagedPlannerState(store.current)
	if validateManagedPlannerState(current) != nil {
		return errors.New("managed planner state is invalid")
	}
	activatedAt := make(map[string]string, len(current.ActiveModels))
	currentIDs := make([]string, 0, len(current.ActiveModels))
	for _, active := range current.ActiveModels {
		activatedAt[active.ModelID] = active.ActivatedAt
		currentIDs = append(currentIDs, active.ModelID)
	}
	changed := !equalStrings(currentIDs, selected)
	if changed != plan.ModelChange {
		return errors.New("managed planner state update conflicts with the plan")
	}
	encodedNow := canonicalPlannerTime(now)
	next := emptyManagedPlannerState()
	for _, modelID := range selected {
		activated := activatedAt[modelID]
		if activated == "" {
			activated = encodedNow
		}
		next.ActiveModels = append(next.ActiveModels, persistedActiveModelState{ModelID: modelID, ActivatedAt: activated})
	}
	windowStart := now.UTC().Add(-plannerAccountingWindow)
	for _, encoded := range current.ModelChanges {
		parsed, _ := canonicalTimestamp(encoded)
		if !parsed.Before(windowStart) {
			next.ModelChanges = append(next.ModelChanges, encoded)
		}
	}
	if changed {
		next.ModelChanges = append(next.ModelChanges, encodedNow)
	}
	for _, download := range current.Downloads {
		parsed, _ := canonicalTimestamp(download.OccurredAt)
		if !parsed.Before(windowStart) {
			next.Downloads = append(next.Downloads, download)
		}
	}
	if !downloadsAlreadyRecorded {
		for _, download := range pulledCopy {
			next.Downloads = append(next.Downloads, persistedModelDownload{OccurredAt: encodedNow, Bytes: download.Bytes})
		}
	}
	if validateManagedPlannerState(next) != nil {
		return errors.New("managed planner state update is invalid")
	}
	if err := store.persistLocked(next); err != nil {
		return err
	}
	store.current = cloneManagedPlannerState(next)
	return nil
}

func (store *managedPlannerStateStore) recordDownloads(downloads []plannedModelDownload, now time.Time) error {
	if now.IsZero() || len(downloads) < 1 || len(downloads) > maximumPlannerItems {
		return errors.New("managed planner download history update is invalid")
	}
	ordered := append([]plannedModelDownload(nil), downloads...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].ModelID < ordered[right].ModelID })
	for index, download := range ordered {
		if !validSelectedModelID(download.ModelID) || download.Bytes == 0 || (index > 0 && download.ModelID == ordered[index-1].ModelID) {
			return errors.New("managed planner download history update is invalid")
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	next := cloneManagedPlannerState(store.current)
	if validateManagedPlannerState(next) != nil {
		return errors.New("managed planner state is invalid")
	}
	windowStart := now.UTC().Add(-plannerAccountingWindow)
	recent := make([]persistedModelDownload, 0, len(next.Downloads)+len(ordered))
	for _, download := range next.Downloads {
		parsed, _ := canonicalTimestamp(download.OccurredAt)
		if !parsed.Before(windowStart) {
			recent = append(recent, download)
		}
	}
	encodedNow := canonicalPlannerTime(now)
	for _, download := range ordered {
		recent = append(recent, persistedModelDownload{OccurredAt: encodedNow, Bytes: download.Bytes})
	}
	next.Downloads = recent
	if validateManagedPlannerState(next) != nil {
		return errors.New("managed planner download history update is invalid")
	}
	if err := store.persistLocked(next); err != nil {
		return err
	}
	store.current = cloneManagedPlannerState(next)
	return nil
}

// clearActiveModels is the fail-closed transition used when a signed plan
// expires. It preserves accounting history and records exactly one model-set
// change when there was an active set to withdraw.
func (store *managedPlannerStateStore) clearActiveModels(now time.Time) error {
	if now.IsZero() {
		return errors.New("managed planner active-model clear is invalid")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	next := cloneManagedPlannerState(store.current)
	if validateManagedPlannerState(next) != nil {
		return errors.New("managed planner state is invalid")
	}
	if len(next.ActiveModels) == 0 {
		return nil
	}
	next.ActiveModels = []persistedActiveModelState{}
	next.ModelChanges = append(next.ModelChanges, canonicalPlannerTime(now))
	if len(next.ModelChanges) > maximumPlannerHistoryItems {
		next.ModelChanges = append([]string{}, next.ModelChanges[len(next.ModelChanges)-maximumPlannerHistoryItems:]...)
	}
	if validateManagedPlannerState(next) != nil {
		return errors.New("managed planner active-model clear is invalid")
	}
	if err := store.persistLocked(next); err != nil {
		return err
	}
	store.current = cloneManagedPlannerState(next)
	return nil
}

func (store *managedPlannerStateStore) persistLocked(document managedPlannerStateDocument) error {
	if store.path == "" {
		return nil
	}
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > managedPlannerStateMaximumBytes {
		return errors.New("managed planner state cannot be encoded")
	}
	if err := atomicWrite0600(store.path, append(encoded, '\n')); err != nil {
		return errors.New("managed planner state cannot be persisted")
	}
	return nil
}
