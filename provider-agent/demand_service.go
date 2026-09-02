package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	providerDemandPlanStateSchemaVersion     = "provider-demand-plan-state-v1"
	providerDemandEnvelopeStateSchemaVersion = "provider-demand-envelope-state-v1"
	providerDemandPersistedStateMaximumBytes = 256 * 1024
)

var (
	errProviderDemandGenerationConflict = errors.New("provider demand generation conflicts with the accepted head")
	errProviderDemandGenerationStale    = errors.New("provider demand generation is stale")
	errProviderCapacityNotAuthorized    = errors.New("provider capacity policy does not authorize Cloud planning")
)

type providerDemandPlanState struct {
	SchemaVersion  string    `json:"schema_version"`
	Generation     uint64    `json:"generation"`
	EnvelopeDigest string    `json:"envelope_digest"`
	SigningKeyID   string    `json:"signing_key_id"`
	AcceptedAt     string    `json:"accepted_at"`
	ExpiresAt      string    `json:"expires_at"`
	Plan           modelPlan `json:"plan"`
}

type persistedProviderDemandEnvelopeState struct {
	SchemaVersion        string `json:"schema_version"`
	SignedEnvelopeBase64 string `json:"signed_envelope_base64"`
}

type providerDemandPlanStore struct {
	mu                sync.Mutex
	path              string
	current           *providerDemandPlanState
	persistedEnvelope []byte
	changed           chan struct{}
}

func newMemoryProviderDemandPlanStore() *providerDemandPlanStore {
	return &providerDemandPlanStore{changed: make(chan struct{})}
}

func openProviderDemandPlanStore(path string) (*providerDemandPlanStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider demand plan state path must be a clean absolute path")
	}
	store := &providerDemandPlanStore{path: path, changed: make(chan struct{})}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || info.Size() < 1 || info.Size() > providerDemandPersistedStateMaximumBytes {
		return nil, errors.New("provider demand plan state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider demand plan state cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, providerDemandPersistedStateMaximumBytes+1))
	if err != nil || len(raw) > providerDemandPersistedStateMaximumBytes || validateUniqueJSONKeys(raw) != nil {
		return nil, errors.New("provider demand plan state is invalid")
	}
	var header struct {
		SchemaVersion string `json:"schema_version"`
	}
	if json.Unmarshal(raw, &header) != nil {
		return nil, errors.New("provider demand plan state is invalid")
	}
	switch header.SchemaVersion {
	case providerDemandEnvelopeStateSchemaVersion:
		var persisted persistedProviderDemandEnvelopeState
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&persisted) != nil || ensureJSONEOF(decoder) != nil || persisted.SignedEnvelopeBase64 == "" {
			return nil, errors.New("provider demand plan state is invalid")
		}
		envelope, decodeErr := base64.StdEncoding.DecodeString(persisted.SignedEnvelopeBase64)
		if decodeErr != nil || base64.StdEncoding.EncodeToString(envelope) != persisted.SignedEnvelopeBase64 || len(envelope) < 1 || len(envelope) > maximumProviderDemandBytes || validateUniqueJSONKeys(envelope) != nil {
			return nil, errors.New("provider demand plan state is invalid")
		}
		store.persistedEnvelope = append([]byte{}, envelope...)
	case providerDemandPlanStateSchemaVersion:
		// Legacy files contained only a derived plan. Parse them strictly for a
		// safe migration, but never restore them as an authority; the next valid
		// signed Cloud envelope replaces the file.
		var legacy providerDemandPlanState
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&legacy) != nil || ensureJSONEOF(decoder) != nil || validateProviderDemandPlanState(legacy) != nil {
			return nil, errors.New("provider demand plan state is invalid")
		}
	default:
		return nil, errors.New("provider demand plan state is invalid")
	}
	return store, nil
}

func validateProviderDemandPlanState(document providerDemandPlanState) error {
	if document.SchemaVersion != providerDemandPlanStateSchemaVersion || document.Generation < 1 ||
		!providerDigest.MatchString(document.EnvelopeDigest) || !providerDemandKeyID.MatchString(document.SigningKeyID) ||
		document.Plan.SchemaVersion != modelPlanSchemaVersion || document.Plan.DemandRevision != document.Generation ||
		document.Plan.SelectedModelIDs == nil || document.Plan.Downloads == nil || document.Plan.Constraints == nil {
		return errors.New("provider demand plan state is invalid")
	}
	acceptedAt, acceptedErr := canonicalTimestamp(document.AcceptedAt)
	expiresAt, expiresErr := canonicalTimestamp(document.ExpiresAt)
	if acceptedErr != nil || expiresErr != nil || !acceptedAt.Before(expiresAt) {
		return errors.New("provider demand plan state is invalid")
	}
	return nil
}

func cloneProviderDemandPlanState(document providerDemandPlanState) *providerDemandPlanState {
	selectedModelIDs := make([]string, len(document.Plan.SelectedModelIDs))
	copy(selectedModelIDs, document.Plan.SelectedModelIDs)
	downloads := make([]plannedModelDownload, len(document.Plan.Downloads))
	copy(downloads, document.Plan.Downloads)
	constraints := make([]modelPlanConstraint, len(document.Plan.Constraints))
	copy(constraints, document.Plan.Constraints)
	document.Plan.SelectedModelIDs = selectedModelIDs
	document.Plan.Downloads = downloads
	document.Plan.Constraints = constraints
	return &document
}

func (store *providerDemandPlanStore) snapshot() *providerDemandPlanState {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current == nil {
		return nil
	}
	return cloneProviderDemandPlanState(*store.current)
}

func (store *providerDemandPlanStore) snapshotWithChange() (*providerDemandPlanState, <-chan struct{}) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.changed == nil {
		store.changed = make(chan struct{})
	}
	if store.current == nil {
		return nil, store.changed
	}
	return cloneProviderDemandPlanState(*store.current), store.changed
}

func (store *providerDemandPlanStore) signedEnvelopeForRestore() []byte {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]byte{}, store.persistedEnvelope...)
}

// withCurrent serializes a fenced side effect with replacement of the signed
// plan head. A caller that observes a match keeps the plan-store lock for the
// duration of visit, so an expiry action can never run after a newer head has
// committed.
func (store *providerDemandPlanStore) withCurrent(generation uint64, envelopeDigest string, visit func(*providerDemandPlanState) error) (bool, error) {
	if generation < 1 || !providerDigest.MatchString(envelopeDigest) || visit == nil {
		return false, errors.New("provider demand plan fence is invalid")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current == nil || store.current.Generation != generation || store.current.EnvelopeDigest != envelopeDigest {
		return false, nil
	}
	return true, visit(cloneProviderDemandPlanState(*store.current))
}

func (store *providerDemandPlanStore) commit(document providerDemandPlanState) error {
	return store.commitSigned(document, nil)
}

func (store *providerDemandPlanStore) commitSigned(document providerDemandPlanState, signedEnvelope []byte) error {
	if err := validateProviderDemandPlanState(document); err != nil {
		return err
	}
	if len(signedEnvelope) > 0 && (len(signedEnvelope) > maximumProviderDemandBytes || validateUniqueJSONKeys(signedEnvelope) != nil) {
		return errors.New("provider demand signed envelope is invalid")
	}
	if store.path != "" && len(signedEnvelope) == 0 {
		return errors.New("provider demand signed envelope is required for persistence")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current != nil {
		if document.Generation < store.current.Generation {
			return errProviderDemandGenerationStale
		}
		if document.Generation == store.current.Generation {
			if document.EnvelopeDigest == store.current.EnvelopeDigest {
				return nil
			}
			return errProviderDemandGenerationConflict
		}
	}
	if store.path != "" {
		persisted := persistedProviderDemandEnvelopeState{
			SchemaVersion: providerDemandEnvelopeStateSchemaVersion, SignedEnvelopeBase64: base64.StdEncoding.EncodeToString(signedEnvelope),
		}
		encoded, err := json.Marshal(persisted)
		if err != nil || len(encoded) > providerDemandPersistedStateMaximumBytes {
			return errors.New("provider demand plan state cannot be encoded")
		}
		if err := atomicWrite0600(store.path, append(encoded, '\n')); err != nil {
			return errors.New("provider demand plan state cannot be persisted")
		}
	}
	store.current = cloneProviderDemandPlanState(document)
	if len(signedEnvelope) > 0 {
		store.persistedEnvelope = append([]byte{}, signedEnvelope...)
	}
	if store.changed == nil {
		store.changed = make(chan struct{})
	} else {
		close(store.changed)
		store.changed = make(chan struct{})
	}
	return nil
}

type providerCapacitySampler func(capacityPolicy, hostCapability, modelPlannerState) (hostCapacitySnapshot, error)
type providerPlannerStateSource func() (modelPlannerState, error)

type providerDemandService struct {
	mu          sync.Mutex
	trustedKeys trustedProviderDemandKeys
	catalog     providerModelCatalog
	policy      *capacityPolicyStore
	plans       *providerDemandPlanStore
	capability  hostCapability
	state       providerPlannerStateSource
	sample      providerCapacitySampler
	now         func() time.Time
}

func newProviderDemandService(keys trustedProviderDemandKeys, catalog providerModelCatalog, policy *capacityPolicyStore, plans *providerDemandPlanStore, capability hostCapability) (*providerDemandService, error) {
	if len(keys) < 1 || validateProviderModelCatalog(&catalog) != nil || policy == nil || plans == nil || !capability.Supported {
		return nil, errors.New("provider demand service configuration is invalid")
	}
	return &providerDemandService{
		trustedKeys: keys, catalog: catalog, policy: policy, plans: plans, capability: capability,
		state: func() (modelPlannerState, error) {
			return modelPlannerState{InstalledModelIDs: []string{}, ActiveModels: []activeModelState{}, ModelChanges: []time.Time{}, Downloads: []modelDownloadHistoryEntry{}}, nil
		},
		sample: defaultProviderCapacitySnapshot, now: time.Now,
	}, nil
}

func defaultProviderCapacitySnapshot(policy capacityPolicy, capability hostCapability, state modelPlannerState) (hostCapacitySnapshot, error) {
	info, err := os.Lstat(policy.modelStoragePath)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return hostCapacitySnapshot{}, errors.New("provider model storage path is unavailable")
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(policy.modelStoragePath, &filesystem); err != nil || filesystem.Bsize <= 0 {
		return hostCapacitySnapshot{}, errors.New("provider model storage capacity is unavailable")
	}
	freeBytes, ok := checkedMultiply(uint64(filesystem.Bavail), uint64(filesystem.Bsize))
	if !ok {
		return hostCapacitySnapshot{}, errors.New("provider model storage capacity is invalid")
	}
	acceleratorMemoryBytes, err := providerAcceleratorMemoryCapacity(capability)
	if err != nil {
		return hostCapacitySnapshot{}, err
	}
	return hostCapacitySnapshot{
		ModelStoragePath: policy.modelStoragePath, TotalAcceleratorMemoryBytes: acceleratorMemoryBytes,
		ManagedModelDiskBytes: 0, FreeDiskBytes: freeBytes,
	}, nil
}

func providerAcceleratorMemoryCapacity(capability hostCapability) (uint64, error) {
	if !capability.Supported || capability.AcceleratorMemoryBytes == 0 {
		return 0, errors.New("provider accelerator capacity is unavailable")
	}
	switch capability.Accelerator {
	case "metal":
		if capability.OS != "darwin" || capability.Architecture != "arm64" || capability.Profile != "apple-silicon" ||
			len(capability.GPUs) != 0 || capability.CUDADevice != 0 ||
			capability.AcceleratorMemoryBytes < minimumDarwinUnifiedMemoryBytes/2 ||
			capability.AcceleratorMemoryBytes > maximumDarwinUnifiedMemoryBytes/2 || capability.AcceleratorMemoryBytes%2048 != 0 {
			return 0, errors.New("provider accelerator capacity is invalid")
		}
		return capability.AcceleratorMemoryBytes, nil
	case "cuda":
		if len(capability.GPUs) == 0 || uint64(capability.CUDADevice) >= uint64(len(capability.GPUs)) {
			return 0, errors.New("provider accelerator capacity is unavailable")
		}
		// Managed Ollama is pinned to one CUDA device and does not declare model
		// sharding. Capacity must therefore be that device's VRAM, never the sum
		// of all installed GPUs.
		deviceBytes, ok := checkedMultiply(capability.GPUs[capability.CUDADevice].MemoryMiB, 1024*1024)
		if !ok || deviceBytes == 0 || deviceBytes != capability.AcceleratorMemoryBytes {
			return 0, errors.New("provider accelerator capacity is invalid")
		}
		return deviceBytes, nil
	default:
		return 0, errors.New("provider accelerator capacity is unavailable")
	}
}

func managedCatalogDiskBytes(catalog providerModelCatalog, installedModelIDs []string) (uint64, error) {
	total := uint64(0)
	seen := make(map[string]struct{}, len(installedModelIDs))
	for _, modelID := range installedModelIDs {
		if _, duplicate := seen[modelID]; duplicate {
			return 0, errInvalidModelPlannerInput
		}
		seen[modelID] = struct{}{}
		entry, exists := catalog.entry(modelID)
		if !exists || entry.DownloadBytes == 0 {
			return 0, errInvalidModelPlannerInput
		}
		var ok bool
		total, ok = checkedAdd(total, entry.DownloadBytes)
		if !ok {
			return 0, errInvalidModelPlannerInput
		}
	}
	return total, nil
}

func (service *providerDemandService) accept(raw []byte) (*providerDemandPlanState, string, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	now := service.now().UTC()
	verified, err := verifySignedProviderDemand(raw, service.trustedKeys, now)
	if err != nil {
		return nil, "", err
	}
	if current := service.plans.snapshot(); current != nil {
		if verified.Payload.Generation < current.Generation {
			return nil, "", errProviderDemandGenerationStale
		}
		if verified.Payload.Generation == current.Generation {
			if verified.EnvelopeDigest != current.EnvelopeDigest {
				return nil, "", errProviderDemandGenerationConflict
			}
			return current, "duplicate", nil
		}
	}
	record, err := service.planVerified(verified, now)
	if err != nil {
		return nil, "", err
	}
	if err := service.plans.commitSigned(record, raw); err != nil {
		return nil, "", err
	}
	return cloneProviderDemandPlanState(record), "accepted", nil
}

// restorePersisted verifies the original signed envelope at the current time
// and recalculates the local plan from current policy, inventory and capacity.
// The derived JSON previously persisted by older releases is never trusted.
func (service *providerDemandService) restorePersisted() error {
	service.mu.Lock()
	defer service.mu.Unlock()
	raw := service.plans.signedEnvelopeForRestore()
	if len(raw) == 0 {
		return nil
	}
	now := service.now().UTC()
	verified, err := verifySignedProviderDemand(raw, service.trustedKeys, now)
	if err != nil {
		return err
	}
	record, err := service.planVerified(verified, now)
	if err != nil {
		return err
	}
	return service.plans.commitSigned(record, raw)
}

func (service *providerDemandService) planVerified(verified verifiedProviderDemand, now time.Time) (providerDemandPlanState, error) {
	policyDocument := service.policy.snapshot()
	if policyDocument == nil || policyDocument.Paused == nil || *policyDocument.Paused ||
		policyDocument.AllowCloudWorkloads == nil || !*policyDocument.AllowCloudWorkloads {
		return providerDemandPlanState{}, errProviderCapacityNotAuthorized
	}
	policy, err := validateCapacityPolicy(policyDocument.Policy)
	if err != nil {
		return providerDemandPlanState{}, err
	}
	demand, artifacts, err := providerDemandToPlanner(verified)
	if err != nil {
		return providerDemandPlanState{}, err
	}
	requiredContextByModelID := make(map[string]uint64, len(demand.Models))
	for _, item := range demand.Models {
		requiredContextByModelID[item.ModelID] = item.RequiredContextTokens
	}
	candidates := make([]modelCandidate, 0, len(artifacts))
	for _, artifact := range artifacts {
		entry, exists := service.catalog.entry(artifact.CanonicalModelID)
		if !exists {
			continue
		}
		requiredContext, exists := requiredContextByModelID[artifact.CanonicalModelID]
		if !exists {
			return providerDemandPlanState{}, errInvalidProviderDemand
		}
		candidate, matches := entry.candidateFor(artifact, requiredContext)
		if matches {
			candidates = append(candidates, candidate)
		}
	}
	state, err := service.state()
	if err != nil {
		return providerDemandPlanState{}, err
	}
	capacity, err := service.sample(policy, service.capability, state)
	if err != nil {
		return providerDemandPlanState{}, err
	}
	capacity.ManagedModelDiskBytes, err = managedCatalogDiskBytes(service.catalog, state.InstalledModelIDs)
	if err != nil {
		return providerDemandPlanState{}, err
	}
	plan, err := planModels(policy, capacity, candidates, demand, state, now)
	if err != nil {
		return providerDemandPlanState{}, err
	}
	record := providerDemandPlanState{
		SchemaVersion: providerDemandPlanStateSchemaVersion, Generation: demand.Revision,
		EnvelopeDigest: verified.EnvelopeDigest, SigningKeyID: verified.SigningKeyID,
		AcceptedAt: now.Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
		ExpiresAt:  demand.ExpiresAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), Plan: plan,
	}
	return record, nil
}

func decodeProviderDemandRequest(body io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maximumProviderDemandBytes+1))
	if err != nil || len(raw) < 1 || len(raw) > maximumProviderDemandBytes || len(bytes.TrimSpace(raw)) == 0 {
		return nil, errInvalidProviderDemand
	}
	return raw, nil
}
