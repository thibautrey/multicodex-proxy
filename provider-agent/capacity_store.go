package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const capacityPolicyStateSchemaVersion = "provider-capacity-policy-state-v1"

var errCapacityPolicyConflict = errors.New("provider capacity policy revision conflict")

// capacityPolicyStateDocument is the complete operator consent record. Pointer
// booleans preserve the distinction between an explicit false choice and an
// omitted field in both API input and persisted state.
type capacityPolicyStateDocument struct {
	SchemaVersion       string                 `json:"schema_version"`
	Revision            uint64                 `json:"revision"`
	Paused              *bool                  `json:"paused"`
	AutomaticDownloads  *bool                  `json:"automatic_downloads"`
	AllowCloudWorkloads *bool                  `json:"allow_cloud_workloads"`
	Policy              capacityPolicyDocument `json:"policy"`
}

type capacityPolicyStore struct {
	mu      sync.Mutex
	path    string
	current *capacityPolicyStateDocument
	changed chan struct{}
}

func newMemoryCapacityPolicyStore() *capacityPolicyStore {
	return &capacityPolicyStore{changed: make(chan struct{})}
}

func openCapacityPolicyStore(path string) (*capacityPolicyStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider capacity policy state path must be a clean absolute path")
	}
	store := &capacityPolicyStore{path: path, changed: make(chan struct{})}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > 32*1024 {
		return nil, errors.New("provider capacity policy state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider capacity policy state cannot be opened")
	}
	defer file.Close()
	var document capacityPolicyStateDocument
	decoder := json.NewDecoder(io.LimitReader(file, 32*1024+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || validateCapacityPolicyState(document) != nil {
		return nil, errors.New("provider capacity policy state is invalid")
	}
	store.current = cloneCapacityPolicyState(document)
	return store, nil
}

func validateCapacityPolicyState(document capacityPolicyStateDocument) error {
	if document.SchemaVersion != capacityPolicyStateSchemaVersion || document.Revision < 1 ||
		document.Paused == nil || document.AutomaticDownloads == nil || document.AllowCloudWorkloads == nil {
		return errInvalidCapacityPolicy
	}
	_, err := validateCapacityPolicy(document.Policy)
	return err
}

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneCapacityPolicyDocument(document capacityPolicyDocument) capacityPolicyDocument {
	document.GPUUtilizationPercent = clonePointer(document.GPUUtilizationPercent)
	document.GPUVRAMPercent = clonePointer(document.GPUVRAMPercent)
	document.MaxDiskBytes = clonePointer(document.MaxDiskBytes)
	document.MaxDownloadBytesPerDay = clonePointer(document.MaxDownloadBytesPerDay)
	document.MinimumModelResidencySeconds = clonePointer(document.MinimumModelResidencySeconds)
	document.MaxModelChangesPerDay = clonePointer(document.MaxModelChangesPerDay)
	document.ReserveFreeDiskBytes = clonePointer(document.ReserveFreeDiskBytes)
	return document
}

func cloneCapacityPolicyState(document capacityPolicyStateDocument) *capacityPolicyStateDocument {
	document.Paused = clonePointer(document.Paused)
	document.AutomaticDownloads = clonePointer(document.AutomaticDownloads)
	document.AllowCloudWorkloads = clonePointer(document.AllowCloudWorkloads)
	document.Policy = cloneCapacityPolicyDocument(document.Policy)
	return &document
}

func (store *capacityPolicyStore) snapshot() *capacityPolicyStateDocument {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current == nil {
		return nil
	}
	return cloneCapacityPolicyState(*store.current)
}

func (store *capacityPolicyStore) snapshotWithChange() (*capacityPolicyStateDocument, <-chan struct{}) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.changed == nil {
		store.changed = make(chan struct{})
	}
	if store.current == nil {
		return nil, store.changed
	}
	return cloneCapacityPolicyState(*store.current), store.changed
}

func (store *capacityPolicyStore) replace(expectedRevision uint64, input capacityPolicyStateDocument) (*capacityPolicyStateDocument, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	currentRevision := uint64(0)
	if store.current != nil {
		currentRevision = store.current.Revision
	}
	if expectedRevision != currentRevision {
		if store.current == nil {
			return nil, true, nil
		}
		return cloneCapacityPolicyState(*store.current), true, nil
	}
	input.SchemaVersion = capacityPolicyStateSchemaVersion
	input.Revision = currentRevision + 1
	if err := validateCapacityPolicyState(input); err != nil {
		return nil, false, err
	}
	if store.path != "" {
		encoded, err := json.Marshal(input)
		if err != nil || len(encoded) > 32*1024 {
			return nil, false, errors.New("provider capacity policy state cannot be encoded")
		}
		if err := atomicWrite0600(store.path, append(encoded, '\n')); err != nil {
			return nil, false, errors.New("provider capacity policy state cannot be persisted")
		}
	}
	store.current = cloneCapacityPolicyState(input)
	if store.changed == nil {
		store.changed = make(chan struct{})
	} else {
		close(store.changed)
		store.changed = make(chan struct{})
	}
	return cloneCapacityPolicyState(input), false, nil
}
